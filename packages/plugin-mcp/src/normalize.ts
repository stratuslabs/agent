import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { BIDI_CONTROL_CHARACTERS, type JsonObject, type JsonValue } from '@stratusagent/core';
import { nameIdentifiesHandle, type TaintedWriteLedger } from '@stratusagent/plugins';

/**
 * Turning what an MCP server sends back into what a Stratus tool returns:
 * `JsonValue` out, files on disk where a content block is binary. Split
 * from the client lifecycle because this half is pure enough to test
 * without a connection.
 */

/**
 * One segment of a bridged tool's registered name — lowercased, everything
 * that is not `[a-z0-9_-]` folded to `_`, leading punctuation stripped.
 * `undefined` when nothing survives, which the caller must treat as a
 * refusal rather than inventing a name.
 *
 * Folding is what makes a collision possible (`createIssue` and
 * `create_issue` both become `create_issue`), which is why the caller
 * checks for one and refuses it rather than letting the second tool
 * silently answer calls meant for the first.
 */
export const sanitizeToolSegment = (raw: string): string | undefined => {
  const folded = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const trimmed = folded.replace(/^[^a-z0-9]+/, '');
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Server keys are operator-chosen and become a name segment; held to the segment shape outright. */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The longest tool description a server gets to put in front of the model.
 * The same bound a skill's description has (`SKILL_DESCRIPTION_MAX_LENGTH`
 * in `@stratusagent/agents`), for the same reason: a description is prose
 * the model reads on every turn, written by a party the operator did not
 * author, and a paragraph is a description while a page is instructions.
 */
export const BRIDGED_DESCRIPTION_MAX_LENGTH = 1024;

/** Control characters and the Unicode `Bidi_Control` set, spelled out. */
const DESCRIPTION_CONTROLS = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029${BIDI_CONTROL_CHARACTERS}]`, 'g');

const spelledOut = (raw: string): string => raw.replace(
  DESCRIPTION_CONTROLS,
  (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
);

/**
 * A server's tool description as it reaches the registry — and, through
 * it, every provider's tool block on every turn. The text is the server's,
 * re-read on every reconnect, and `tools/list` is the one channel a
 * server has that arrives looking like part of the harness rather than
 * like a result. Two bounds, neither a filter: control characters and the
 * Unicode bidi controls are spelled out the way memory entries are (a
 * right-to-left override in a description is a description that reads
 * differently to a person than to the model — escaped, it reads as what it
 * is; the set is Unicode's `Bidi_Control` property, marks and the Arabic
 * letter mark included, not only the overrides and isolates), and the
 * length is capped with the cut announced. Newlines and tabs stay: a
 * description is allowed to be several lines.
 */
export const bridgedDescription = (raw: string): string => {
  const escaped = spelledOut(raw);
  // Counted and cut in code points, not UTF-16 units: an emoji is one
  // character, and a cut inside a surrogate pair is a malformed string a
  // provider may reject.
  const characters = Array.from(escaped);
  if (characters.length <= BRIDGED_DESCRIPTION_MAX_LENGTH) {
    return escaped;
  }
  const marker = ` … [description truncated by stratus: ${characters.length} characters]`;
  return `${characters.slice(0, BRIDGED_DESCRIPTION_MAX_LENGTH - Array.from(marker).length).join('')}${marker}`;
};

/**
 * The longest input schema a server gets to put in front of the model, in
 * characters of its JSON. A schema is read by the provider as structure,
 * but every string in it lands in the tool block as text, and sixteen
 * thousand characters of parameter list is a page, not a parameter list.
 */
export const BRIDGED_SCHEMA_MAX_LENGTH = 16_384;

/**
 * The most of one `tools/call` result a server gets to put into the
 * transcript, in characters, counting the joined text and the JSON of
 * `structuredContent` separately.
 *
 * Every first-party tool caps what it returns — `fs.read` at 64 KB,
 * `shell.run` and `browser.read` at 100 KB, `web.fetch` at 400 KB — and
 * a bridged result was the one that did not. Binary blocks already land on
 * disk rather than in the result, so this is about text, and text is the
 * part that is *durable*: a tool result is saved into the session and
 * replayed to the provider on every later turn of that conversation, so a
 * server that answers `list_files` with twenty megabytes does not cost one
 * turn, it costs every turn until the session ends — and survives restarts,
 * because the transcript does. The stdio transport bounds a single message
 * at its reader's buffer (10 MB by default) and the HTTP transports bound
 * nothing, so "the transport will stop it" was never a cap.
 *
 * 100 KB matches `shell.run`, which is the closest comparison: somebody
 * else's program, writing as much as it likes. Counted in characters
 * rather than bytes, like the two bounds above and unlike the tool packs':
 * what is scarce here is the model's context, which is measured in tokens,
 * and a token follows a character more closely than it follows a byte.
 */
export const BRIDGED_RESULT_MAX_LENGTH = 100_000;

/**
 * What a binary block reserves from the budget before it is written, in
 * characters — a generous stand-in for the path it will return, which is
 * not known until the file is created. Generous on purpose: the check has
 * to happen before the write, because refusing to return a path for bytes
 * already on disk leaves an orphan in the workspace.
 */
const BINARY_PATH_RESERVE = 256;

/**
 * `raw`, cut to `limit` characters with the cut announced, or `raw` when it
 * fits.
 *
 * The marker matters as much as the cut: the model has to be able to tell a
 * directory listing that ended from one that was stopped, or it reports
 * the truncated answer as the whole answer — which is the failure mode of
 * a silent cap, and worse than the size. It names the original length for
 * the same reason `bridgedDescription`'s does: the number is what tells an
 * operator whether to raise `maxResultChars` or fix the call.
 *
 * Counted in code points, and cut so the cut never lands inside a
 * surrogate pair — half an astral character is a malformed string a
 * provider may refuse.
 *
 * Deliberately without `Array.from`, which is how the two bounds above
 * count: they measure a description against a fixed 1024, while this
 * measures whatever a server sent. Materializing ten megabytes of result
 * as an array of ten million one-character strings, to decide it is too
 * long, would spend more memory on the check than the string it is
 * guarding against. So the cheap test comes first — a string's UTF-16
 * length is never below its code-point count, so anything whose `length`
 * fits is under the cap and returns untouched, which is every ordinary
 * result — and the exact count is only paid for on the oversized path.
 *
 * A `limit` smaller than the marker yields just the marker, which is
 * longer than the limit. Reachable only from a `maxResultChars` of a few
 * dozen characters, where no result could be useful anyway, and the
 * alternative is a cut with nothing saying it happened.
 */
const codePointLength = (raw: string): number => {
  let count = 0;
  for (const _character of raw) {
    count += 1;
  }
  return count;
};

/**
 * Whether `raw` is within `limit` code points, without counting further
 * than it has to. The cheap test first — a string's UTF-16 length is never
 * below its code-point count, so anything whose `length` fits is under the
 * limit — which is every ordinary string and costs one property read.
 */
const withinLimit = (raw: string, limit: number): boolean =>
  raw.length <= limit || codePointLength(raw) <= limit;

const cutToLimit = (raw: string, limit: number, what: string): string => {
  if (withinLimit(raw, limit)) {
    return raw;
  }
  const codePoints = codePointLength(raw);
  const marker = `\n… [${what} truncated by stratus at ${limit} characters; the server sent ${codePoints}]`;
  // `marker` is ASCII apart from the ellipsis, so its own code-point count
  // is its length.
  return `${firstCodePoints(raw, Math.max(0, limit - marker.length))}${marker}`;
};

/**
 * The first `count` CODE POINTS of `raw`.
 *
 * Not `raw.slice(0, count)`, which is the obvious thing and is wrong here:
 * the allowance is counted in code points and `slice` indexes UTF-16 code
 * units, so an emoji-heavy result would keep about half of what it was
 * allowed — every astral character costing two of a budget that meant to
 * charge one. Walking the string instead charges each character once and,
 * because it only ever advances by whole code points, can never cut inside
 * a surrogate pair.
 *
 * Bounded by `count`, not by the length of `raw`: the input is a result
 * that has already been found too long, and the point of stopping early is
 * not walking ten megabytes to keep a hundred thousand characters.
 */
const firstCodePoints = (raw: string, count: number): string => {
  if (count <= 0) {
    return '';
  }
  let units = 0;
  let taken = 0;
  for (const character of raw) {
    // `>=`, not `===`. `taken` counts whole characters, so an equality
    // test against a fractional `count` is never true and the loop runs to
    // the end of the string — returning the entire payload with a
    // truncation marker on it, which is larger than what came in. The
    // callers are guarded (see `asPositiveInteger`), and this is the layer
    // that must not depend on them being right.
    if (taken >= count) {
      break;
    }
    units += character.length;
    taken += 1;
  }
  return raw.slice(0, units);
};

/**
 * How deep a schema may nest before the bridge stops walking it. Sixty-four
 * levels is far past any parameter list a person wrote; a schema nested
 * deeper is a stack-overflow attempt dressed as a tool, and a recursive
 * walk that blew the stack during discovery would take the whole server
 * down as unreachable, and again on every reconnect.
 */
export const BRIDGED_SCHEMA_MAX_DEPTH = 64;

/**
 * The schema keys whose values are prose the model reads, at any depth —
 * `$comment` included: the spec calls it a note for schema authors, but
 * the provider forwards the whole schema, so it is one more place a page
 * of instructions can ride into every tool block.
 */
const SCHEMA_ANNOTATION_KEYS = new Set(['description', 'title', '$comment']);

/**
 * The longest name segment a server's tool may bridge under. The segment
 * is the tail of `mcp.<server>.<segment>`, sent as the tool's name in
 * every model request, and a name is the one string a server writes that
 * no description bound touches — a tool called `a` three thousand times
 * over is a page in the tool block by another route. Sixty-four is the
 * longest name the strictest provider accepts whole.
 */
export const BRIDGED_SEGMENT_MAX_LENGTH = 64;

/**
 * The schema keys whose values are data, not schema: a member named
 * `description` inside an `enum` entry is a value the model will send
 * back, not prose, and rewriting it would make the schema offer a value
 * the server does not accept. These subtrees are copied through verbatim.
 */
const SCHEMA_LITERAL_KEYS = new Set(['enum', 'const', 'default', 'examples']);

class SchemaTooDeepError extends Error {
  constructor() {
    super(`Schema nests deeper than ${BRIDGED_SCHEMA_MAX_DEPTH} levels.`);
    this.name = 'SchemaTooDeepError';
  }
}

/**
 * The schema keywords whose value is a map from a *name* to a schema. The
 * names are the server's — a parameter called `default` or `enum` is an
 * ordinary parameter — so the keys of these maps are never read as
 * keywords, and every value under them is a schema again. Without this
 * distinction a description hidden under `properties.default` would pass
 * through as a literal, unbounded. Draft-07's `dependencies` is here too:
 * its values are schemas or lists of property names, and a list walked as
 * a schema comes back untouched.
 */
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

const boundedSchemaValue = (value: unknown, depth: number, position: 'schema' | 'map'): unknown => {
  if (depth > BRIDGED_SCHEMA_MAX_DEPTH) {
    throw new SchemaTooDeepError();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => boundedSchemaValue(entry, depth + 1, 'schema'));
  }
  if (typeof value === 'object' && value !== null) {
    if (position === 'map') {
      return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, boundedSchemaValue(entry, depth + 1, 'schema')]));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SCHEMA_LITERAL_KEYS.has(key)
        ? entry
        : SCHEMA_ANNOTATION_KEYS.has(key) && typeof entry === 'string'
          ? bridgedDescription(entry)
          : boundedSchemaValue(entry, depth + 1, SCHEMA_MAP_KEYS.has(key) ? 'map' : 'schema'),
    ]));
  }
  return value;
};

/**
 * A server's input schema as it reaches the registry — and, through it,
 * the tool block of every turn, the same way the description does. The
 * top-level description is not the only prose in `tools/list`: a
 * `description` or `title` on any property, at any depth, is text the
 * model reads too, and it was copied through unbounded. Each is bounded
 * like the tool's own description. Nothing else in the schema is touched:
 * a property name, an enum value, a const or a pattern is what the model
 * sends back in a call, and the bridge forwards arguments to the server
 * as the model wrote them — a value spelled out here would arrive at the
 * server as a different value, and the schema would be a lie in the
 * direction that breaks calls. An annotation key *inside* a literal (an
 * `enum` member with a `description` field) is data too, and is left
 * alone — while a *parameter* named `enum` or `default` is a schema like
 * any other, because the keys of `properties` and `$defs` are names, not
 * keywords. `undefined` when the bounded schema is still longer than
 * {@link BRIDGED_SCHEMA_MAX_LENGTH} characters, or nests deeper than
 * {@link BRIDGED_SCHEMA_MAX_DEPTH}: that tool is not bridged, and the
 * caller names it.
 */
export const bridgedSchema = (schema: Record<string, unknown>): Record<string, unknown> | undefined => {
  try {
    const bounded = boundedSchemaValue(schema, 0, 'schema') as Record<string, unknown>;
    // The literal subtrees were not walked, so the serialisation is the
    // one place a bottomless `default` can still blow the stack — a
    // RangeError there is the same answer as a schema too deep to walk.
    return Array.from(JSON.stringify(bounded)).length <= BRIDGED_SCHEMA_MAX_LENGTH ? bounded : undefined;
  } catch (error) {
    if (error instanceof SchemaTooDeepError || error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
};

/** The registered name a server's tool bridges to: `mcp.<server>.<segment>`. */
export const bridgedToolName = (server: string, segment: string): string => `mcp.${server}.${segment}`;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

const extensionFor = (mimeType: string | undefined): string => {
  if (!mimeType) {
    return 'bin';
  }
  const known = EXTENSION_BY_MIME[mimeType];
  if (known) {
    return known;
  }
  const subtype = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '');
  return subtype && subtype.length > 0 ? subtype.toLowerCase() : 'bin';
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Distinguishes every written file within one process. A timestamp alone
// is not enough: two calls in the same millisecond (parallel tool calls in
// one turn) would produce the same path, and the first result's `files`
// entry would silently point at the second call's bytes.
let fileSerial = 0;

/**
 * One result's character allowance, spent across everything server-written
 * that reaches the transcript.
 *
 * A budget rather than a cap per field because the transcript pays the
 * sum: text, a structured payload and a list of resource links are three
 * places a server can put bytes in one result, and three separate caps
 * would let it spend the allowance three times.
 */
const createResultBudget = (limit: number) => {
  let spent = 0;
  const remaining = (): number => Math.max(0, limit - spent);
  return {
    limit,
    /** Whether `value` fits in what is left, counted without allocating. */
    fits: (value: string): boolean => withinLimit(value, remaining()),
    /** Charge `value` against the budget; the caller has checked it fits. */
    charge: (value: string): void => {
      spent += Math.min(value.length, codePointLength(value));
    },
    /** `value` cut to what is left, with the cut announced, and charged. */
    spend: (value: string, what: string): string => {
      const bounded = cutToLimit(value, remaining(), what);
      spent += Math.min(bounded.length, codePointLength(bounded));
      return bounded;
    },
  };
};

/**
 * Server-written text, bounded for the transcript — the same treatment a
 * result's text gets, exported because a `tools/call` can fail in ways that
 * never produce a result at all: a JSON-RPC error, or a transport failure
 * carrying an HTTP body. Those reach the agent as a thrown message, which
 * `DefaultExecutor` copies into `ToolResult.error` and the session persists
 * and replays exactly like output.
 */
export const boundServerText = (raw: string, limit: number, what: string): string =>
  cutToLimit(raw, limit, what);

export interface NormalizeOptions {
  /** The bridged server's config key — part of where a binary block lands. */
  server: string;
  /** The server-side tool name — part of the written file's name. */
  tool: string;
  /**
   * The workspace root the host supplied. Binary content lands under
   * `<workspaceRoot>/<agentId>/mcp/<server>/` — per agent, same as
   * screenshots, so two agents never read each other's files.
   */
  workspaceRoot?: string;
  agentId: string;
  /**
   * The filesystem provenance ledger for `workspaceRoot`. A binary block
   * is a server's bytes written to disk without going through `fs.write`,
   * so the write records itself here at `external` before the bytes land —
   * a later `fs.read` of the file then carries the label the tool result
   * did. Without a ledger the file is written unrecorded, which is what
   * the loader-less host case gets.
   */
  ledger?: TaintedWriteLedger;
  /**
   * The operator's cap on this result, in characters. Defaults to
   * {@link BRIDGED_RESULT_MAX_LENGTH}; a server cannot raise it, because
   * the cap exists to bound what the server sends.
   */
  maxResultChars?: number;
  /** Clock seam for deterministic file names in tests. */
  now?: () => number;
}

/**
 * Normalize one MCP `tools/call` result into a `JsonValue`.
 *
 * - Text blocks join into one `text` string.
 * - Image and audio blocks (and embedded blob resources) are decoded into
 *   the agent's workspace and returned under `files` — the key a channel
 *   treats as "deliver this as an attachment", which is how an image from a
 *   bridged tool reaches Slack.
 * - Embedded text resources join the text, labeled by uri; resource links
 *   pass through under `resources` — a link is an offer, not content.
 * - `structuredContent` passes through as `structured`.
 * - A result the server marked `isError` becomes a thrown error, so it
 *   lands in `ToolResult.error` like any other failing tool.
 *
 * A result that is only text returns the string itself — the shape the
 * model reads best — and anything richer returns an object.
 */
export const normalizeCallResult = async (
  result: unknown,
  options: NormalizeOptions,
): Promise<JsonValue> => {
  const shaped = isObject(result) ? result : {};
  const content = Array.isArray(shaped.content) ? shaped.content : [];
  const texts: string[] = [];
  const files: string[] = [];
  const resources: JsonObject[] = [];
  // ONE budget for the whole result, spent in order — not a separate cap
  // per carrier. A result can hold text, a structured payload, a list of
  // resource links, and a path per binary block; capped separately, a
  // server spends the allowance once per kind, while what reaches the
  // transcript is their sum.
  //
  // Created before the content loop because the loop spends it: a binary
  // block's *bytes* go to disk, but the path it returns is a string in the
  // durable result like any other, and a thousand tiny images is a
  // thousand paths replayed on every later turn.
  const budget = createResultBudget(options.maxResultChars ?? BRIDGED_RESULT_MAX_LENGTH);
  let skippedBinary = 0;

  // Settled before anything touches the disk: a failing result's binary
  // blocks would otherwise land as server-controlled files in the
  // workspace that nothing references, delivers, or cleans up.
  if (shaped.isError === true) {
    const message = content
      .filter(isObject)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n\n');
    // Bounded like a successful result, because it ends up in the same
    // place: the executor copies a thrown message into `ToolResult.error`,
    // which is persisted on the session and replayed to the provider on
    // every later turn exactly as output is. A server that cannot answer
    // must not get an unbounded channel into the transcript by failing
    // instead of succeeding.
    throw new Error(
      budget.spend(message, 'error message')
      || `MCP server ${options.server} reported an error for ${options.tool} with no message.`,
    );
  }

  const writeBlock = async (data: unknown, mimeType: unknown): Promise<void> => {
    if (typeof data !== 'string') {
      return;
    }
    // Checked before the write, not after: refusing to *return* a path for
    // bytes already on disk would leave a file in the workspace that
    // nothing references, delivers, or cleans up — the same orphan the
    // `isError` guard above exists to avoid. A generous reservation, since
    // the path is not known until it is built.
    if (!budget.fits('x'.repeat(BINARY_PATH_RESERVE))) {
      skippedBinary += 1;
      return;
    }
    if (!options.workspaceRoot) {
      texts.push(`[binary ${typeof mimeType === 'string' ? mimeType : 'content'} dropped: no workspaceRoot is configured for @stratusagent/plugin-mcp]`);
      return;
    }
    // Canonical, because the ledger is keyed the way `fs.read` looks a
    // path up — through `realpath` — and a workspace root or agent
    // directory an operator moved behind a link would otherwise leave the
    // record under a spelling no read ever asks for.
    const lexical = path.join(options.workspaceRoot, options.agentId, 'mcp', options.server);
    await mkdir(lexical, { recursive: true });
    const directory = await realpath(lexical);
    const stamp = (options.now ?? Date.now)();
    fileSerial += 1;
    // The tool name is the server's own string, so it is folded to the
    // name-segment shape before it becomes part of a path: interpolated
    // raw, a tool named `../../…` would be an arbitrary-directory write
    // steered by whoever runs the server.
    const file = path.join(
      directory,
      `${sanitizeToolSegment(options.tool) ?? 'tool'}-${stamp}-${fileSerial}.${extensionFor(typeof mimeType === 'string' ? mimeType : undefined)}`,
    );
    // Recorded before the bytes land, like a tainted `fs.write`: a crash
    // between the two leaves a labelled path with no file, never a file
    // with no label.
    await options.ledger?.recordWrite(options.agentId, file, 'external');
    // Created exclusively, never through a link: the record above names
    // the exact path, and a link planted there between the record and the
    // write would carry a server's bytes to a target the ledger never saw
    // — the ledger itself included. A name that is already taken, by a
    // link or anything else, fails the block rather than following it.
    let handle;
    try {
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`${file} appeared between its provenance record and its write; the ${options.tool} result's binary block was not saved. Retry the call.`);
      }
      throw error;
    }
    try {
      // O_NOFOLLOW guards the final component only: a directory on the way
      // swapped for a link between the `realpath` above and this open would
      // have the create land wherever the link points, under a path the
      // record above never named. Checked now that the file exists, and
      // bound to the descriptor rather than the name — a decoy put back at
      // the expected spelling would satisfy a pathname comparison while the
      // handle still points where the link sent the create. Refused before
      // a byte is written; the empty file is left rather than unlinked
      // through a name that just proved it can move.
      if (!(await nameIdentifiesHandle(file, handle))) {
        throw new Error(`${file} moved between its provenance record and its write; the ${options.tool} result's binary block was not saved. Retry the call.`);
      }
      await handle.writeFile(Buffer.from(data, 'base64'));
    } finally {
      await handle.close();
    }
    budget.charge(file);
    files.push(file);
  };

  for (const block of content) {
    if (!isObject(block)) {
      continue;
    }
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') {
          texts.push(block.text);
        }
        break;
      case 'image':
      case 'audio':
        await writeBlock(block.data, block.mimeType);
        break;
      case 'resource': {
        const resource = isObject(block.resource) ? block.resource : {};
        if (typeof resource.text === 'string') {
          const uri = typeof resource.uri === 'string' ? resource.uri : undefined;
          texts.push(uri ? `${uri}:\n${resource.text}` : resource.text);
        } else {
          await writeBlock(resource.blob, resource.mimeType);
        }
        break;
      }
      case 'resource_link': {
        const link: JsonObject = {};
        for (const key of ['uri', 'name', 'title', 'description', 'mimeType'] as const) {
          if (typeof block[key] === 'string') {
            link[key] = block[key];
          }
        }
        resources.push(link);
        break;
      }
      default:
        break;
    }
  }

  const text = texts.length > 0 ? budget.spend(texts.join('\n\n'), 'result') : undefined;

  // Measured as its own serialized string rather than by walking the
  // object: what the provider is sent is the JSON, so the JSON is the cost.
  // A structured payload that does not fit arrives as *text* — it stops
  // being a parseable object, which is the honest outcome, since a
  // truncated object is not one. The key says which it is, so a caller
  // reading `structured` never finds a half-object there.
  const structuredRaw = isObject(shaped.structuredContent) ? (shaped.structuredContent as JsonObject) : undefined;
  const structuredJson = structuredRaw === undefined ? undefined : JSON.stringify(structuredRaw);
  const structuredFits = structuredJson !== undefined && budget.fits(structuredJson);
  const structured = structuredFits ? structuredRaw : undefined;
  if (structuredFits) {
    budget.charge(structuredJson!);
  }
  const structuredNote = structuredJson !== undefined && !structuredFits
    ? budget.spend(structuredJson, 'structured result')
    : undefined;

  // Resource links are server-controlled strings too, and a list of them is
  // as unbounded as a paragraph is: `uri`, `name`, `title` and
  // `description` all land in the durable result and are replayed with it.
  // Kept whole while the budget lasts and then stopped, rather than each
  // one cut — half a URI is no use to anybody, while nine links and a note
  // saying there were ninety is.
  const kept: JsonObject[] = [];
  for (const link of resources) {
    // Charged as the list costs, not as the link costs. A link measured on
    // its own leaves the comma joining it to the last one unpaid, and the
    // key and brackets the collection arrives in unpaid entirely — so
    // thousands of minimal links each pass the check while the array they
    // serialize into runs thousands of characters past the cap. The first
    // link pays for the envelope, each one after it pays for its
    // separator, and the total is exactly what `"resources":[…]` weighs
    // in the result.
    const serialized = JSON.stringify(link);
    const cost = kept.length === 0 ? `"resources":[${serialized}]` : `,${serialized}`;
    if (!budget.fits(cost)) {
      break;
    }
    budget.charge(cost);
    kept.push(link);
  }
  const droppedLinks = resources.length - kept.length;

  if (
    structured === undefined
    && structuredNote === undefined
    && files.length === 0
    && resources.length === 0
    && skippedBinary === 0
  ) {
    return text ?? '';
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(structured !== undefined ? { structured } : {}),
    ...(structuredNote !== undefined ? { structuredText: structuredNote } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(kept.length > 0 ? { resources: kept } : {}),
    ...(droppedLinks > 0
      ? { resourcesTruncated: `${droppedLinks} more resource link${droppedLinks === 1 ? '' : 's'} were not included: the result reached its ${budget.limit}-character cap.` }
      : {}),
    ...(skippedBinary > 0
      ? { filesTruncated: `${skippedBinary} more attachment${skippedBinary === 1 ? '' : 's'} were not saved: the result reached its ${budget.limit}-character cap.` }
      : {}),
  };
};
