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
 * The smallest `maxResultChars` that means anything, and the floor every
 * smaller one is raised to.
 *
 * A cap has to be able to hold an account of what it cut. The four
 * annotations a result can carry — a marker for the text, one for the
 * structured payload, and the two truncation notes — come to a little over
 * four hundred characters with the keys they arrive under, and shortening
 * them is not on the table: an announcement is the whole reason a cap is
 * safe to have, and a cut with nothing saying it happened is the failure
 * this bound exists to prevent.
 *
 * So below this a cap cannot be honoured, only approximated — `1` yielded
 * 73 characters for a truncated text and 104 for a dropped resource link —
 * and approximating it silently is worse than raising it. Raised rather
 * than refused, and raised to the floor rather than back to the default,
 * because an operator who asked for the smallest possible result should
 * get the smallest possible result. The markers name the cap that was
 * actually applied.
 */
export const BRIDGED_RESULT_MIN_LENGTH = 512;

/**
 * A configured `maxResultChars` as it actually applies: the default when
 * unset, never below the floor. One implementation because it has two
 * consumers — `normalizeCallResult` for a result, and the call path for a
 * `tools/call` that fails before there is a result to normalize. A second
 * copy would leave the floor applying to one and not the other, which is
 * how a cap of 1 came to name itself in a protocol error's marker.
 */
export const boundedResultLimit = (configured: number | undefined): number =>
  Math.max(BRIDGED_RESULT_MIN_LENGTH, configured ?? BRIDGED_RESULT_MAX_LENGTH);

/**
 * Stratus's own account of a cut, in the three shapes it takes. One home
 * each, because the reservation below has to know what they cost and a
 * second copy of the wording would drift from the one that ships.
 */
const truncationMarker = (what: string, cap: number, sent: number): string =>
  `\n… [${what} truncated by stratus at ${cap} characters; the server sent ${sent}]`;

const resourcesTruncatedNote = (count: number, cap: number): string =>
  `${count} more resource link${count === 1 ? ' was' : 's were'} not included: the result reached its ${cap}-character cap.`;

const filesTruncatedNote = (count: number, cap: number): string =>
  `${count} more attachment${count === 1 ? ' was' : 's were'} not saved: the result reached its ${cap}-character cap.`;

/**
 * The longest `what` a marker is built with. `spend` is reached with
 * `result`, `structured result` and — on the `isError` path — `error
 * message`, and the reservation has to hold the widest of them.
 */
const WIDEST_MARKER_SUBJECT = 'structured result';

/**
 * A worst-case count for a number one of those interpolates, so the
 * reservation is measured against the wording rather than against a guess
 * at how many digits a server can provoke.
 */
const WIDEST_COUNT = Number.MAX_SAFE_INTEGER;

/** What a value under `key` adds to the result's JSON: `"key":"",`. */
const keyOverhead = (key: string): number => key.length + 6;

/**
 * Room set aside, before a server is charged for anything, for stratus's
 * own account of what it cut — sized to the annotations *this* result can
 * actually produce.
 *
 * Derived rather than guessed, which matters in both directions. A flat
 * 512 clamped to half the allowance was the first attempt and was wrong at
 * both ends: too small where every annotation fires at once, so a
 * 500-character cap returned 600, and too large for the ordinary result
 * that has no links and no attachments and can only ever produce one
 * marker.
 *
 * A marker is normally paid for out of what the server is spending —
 * `cutToLimit` subtracts it from the allowance before cutting — so what
 * needs reserving is the case where nothing is left to subtract from and
 * the marker arrives alone. The two truncation notes are never charged at
 * all: they are written after every spending decision has been made, so
 * there is no later point at which they could be.
 *
 * They must not be chargeable in any case. They are what tells the model a
 * listing was stopped rather than ended, and charging them to the same
 * allowance the server is spending would let a server suppress its own
 * truncation notice by filling the budget.
 */
interface NoteReserve {
  /** The marker a truncated `text` would carry. */
  text: number;
  /** The marker a `structuredContent` too large to keep would carry. */
  structured: number;
  /** The note dropped resource links would carry. */
  resources: number;
  /** The note skipped attachments would carry. */
  files: number;
  total: number;
}

const markerReserve = (key: string, limit: number): number =>
  serializedLength(truncationMarker(WIDEST_MARKER_SUBJECT, limit, WIDEST_COUNT)) + keyOverhead(key);

const noteReserveFor = (
  content: readonly unknown[],
  hasStructured: boolean,
  hasWorkspaceRoot: boolean,
  limit: number,
): NoteReserve => {
  const kinds = content.filter(isObject).map((block) => block.type);
  // Only where the result can actually produce text. `resource_link` never
  // does, so a list of links was reserving room for a marker that had
  // nothing to mark — and at a small cap that reservation was enough to
  // drop the links it was withheld from.
  const producesText = kinds.some((kind) => kind === 'text' || kind === 'resource')
    // A binary block contributes text in exactly one case: there is
    // nowhere to write it, so it says so instead. With a workspace root
    // configured that cannot happen, and reserving for it costs the
    // attachment the room its own path needs.
    || (!hasWorkspaceRoot && kinds.some((kind) => kind === 'image' || kind === 'audio'));
  const text = producesText ? markerReserve('text', limit) : 0;
  const structured = hasStructured ? markerReserve('structuredText', limit) : 0;
  const resources = kinds.includes('resource_link')
    ? serializedLength(resourcesTruncatedNote(WIDEST_COUNT, limit)) + keyOverhead('resourcesTruncated')
    : 0;
  const files = kinds.some((kind) => kind === 'image' || kind === 'audio' || kind === 'resource')
    ? serializedLength(filesTruncatedNote(WIDEST_COUNT, limit)) + keyOverhead('filesTruncated')
    : 0;
  return { text, structured, resources, files, total: text + structured + resources + files };
};

/**
 * `raw`'s length in code points, walked rather than materialized:
 * `Array.from` is how the two bounds above count, because they measure a
 * description against a fixed 1024, while these measure whatever a server
 * sent. Turning ten megabytes of result into ten million one-character
 * strings, to decide it is too long, would spend more memory on the check
 * than the string it guards against.
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

/**
 * What an already-serialized string costs the result, in the code points
 * the cap is counted in. The cheap `length` first, which is never below
 * the code-point count, so only a string carrying astral characters is
 * walked. One rule, because everything that adds to the total has to agree
 * with everything that tests it — measuring one in UTF-16 units and the
 * other in code points is how a result that fitted was cut anyway.
 */
const charged = (value: string): number => Math.min(value.length, codePointLength(value));

/**
 * What one character costs the transcript, which is JSON.
 *
 * A tool result is stored and replayed as a JSON string, so the characters
 * a server writes are not the characters the transcript pays for: `"` and
 * `\` escape to two, the five shorthand controls to two, and every other
 * control character to six — `\u0000` for a NUL. Counting raw code points
 * therefore under-charged a hostile payload by up to sixfold: 100,000 NULs
 * passed a 100,000-character cap and weighed 596,546 in the session and in
 * every request that replayed it.
 *
 * Lone surrogates cost six for the same reason, and can be present in a
 * server's text even though nothing here ever produces one.
 *
 * Ordinary prose is unaffected — a log file pays for its newlines, a JSON
 * document for its quotes, both a couple of percent. The cap is still
 * counted in characters rather than bytes, as
 * {@link BRIDGED_RESULT_MAX_LENGTH} describes; these are simply the
 * characters that actually land.
 */
const serializedCostOf = (character: string): number => {
  const code = character.codePointAt(0)!;
  if (code === 0x22 || code === 0x5c) {
    return 2;
  }
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
    return 2;
  }
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
    return 6;
  }
  return 1;
};

/** `raw` measured as the transcript will carry it. */
const serializedLength = (raw: string): number => {
  let count = 0;
  for (const character of raw) {
    count += serializedCostOf(character);
  }
  return count;
};

/**
 * Whether `raw` serializes within `limit`, without counting further than it
 * has to. A character costs at most six, so anything six times whose UTF-16
 * length fits is under the limit — one multiply for every ordinary result —
 * and the walk that settles the rest stops as soon as it has overspent,
 * rather than measuring ten megabytes to decide they are too many.
 */
const withinSerialized = (raw: string, limit: number): boolean => {
  if (raw.length * 6 <= limit) {
    return true;
  }
  let count = 0;
  for (const character of raw) {
    count += serializedCostOf(character);
    if (count > limit) {
      return false;
    }
  }
  return true;
};

/**
 * `raw`, cut so that what it costs the transcript is within `limit`, with
 * the cut announced — or `raw` when it already fits.
 *
 * The marker matters as much as the cut: the model has to be able to tell
 * a directory listing that ended from one that was stopped, or it reports
 * the truncated answer as the whole answer — which is the failure mode of
 * a silent cap, and worse than the size. It names the original size for
 * the same reason `bridgedDescription`'s does: the number is what tells an
 * operator whether to raise `maxResultChars` or fix the call, and it is
 * given in what the transcript pays so that both numbers in the sentence
 * are in the same units.
 *
 * The cut never lands inside a surrogate pair — half an astral character
 * is a malformed string a provider may refuse — and the exact size is only
 * paid for on the oversized path, `withinSerialized` having already
 * settled the ordinary one without walking the whole string.
 *
 * A `limit` smaller than the marker yields just the marker, which is
 * longer than the limit. Inside a result budget that case is what
 * {@link noteReserveFor} sets room aside for, so the marker arriving alone
 * does not push the result past its cap; the alternative would be a cut
 * with nothing saying it happened.
 */
const cutToLimit = (raw: string, limit: number, what: string, cap: number = limit): string => {
  if (withinSerialized(raw, limit)) {
    return raw;
  }
  const characters = serializedLength(raw);
  // `cap`, not `limit`: the number an operator can act on is the one they
  // set, and `limit` is what was left of it after the reservation and
  // whatever the result already spent. Naming the remainder would tell
  // someone reading the transcript to raise a setting that does not exist.
  const marker = truncationMarker(what, cap, characters);
  return `${firstWithinCost(raw, Math.max(0, limit - serializedLength(marker)))}${marker}`;
};

/**
 * The first `count` CODE POINTS of `raw`.
 *
 * Not `raw.slice(0, allowance)`, which is the obvious thing and is wrong
 * twice over: `slice` indexes UTF-16 code units, so an emoji-heavy result
 * would keep about half of what it was allowed, and the allowance is spent
 * in what the transcript charges rather than in characters, so an escaped
 * one has to pay its escape. Walking the string settles both, and because
 * it only ever advances by whole code points it can never cut inside a
 * surrogate pair — nor leave a lone one behind for `JSON.stringify` to
 * spend six characters on.
 *
 * Bounded by `allowance`, not by the length of `raw`: the input is a
 * result that has already been found too long, and the point of stopping
 * early is not walking ten megabytes to keep a hundred thousand
 * characters.
 */
const firstWithinCost = (raw: string, allowance: number): string => {
  if (allowance <= 0) {
    return '';
  }
  let units = 0;
  let spent = 0;
  for (const character of raw) {
    // Compared before committing, never after: a character that would take
    // the total past the allowance is not taken. An equality test would
    // never be true against a fractional allowance and the loop would run
    // to the end of the string, returning the entire payload with a
    // truncation marker on it — larger than what came in. The callers are
    // guarded (see `asPositiveInteger`); this is the layer that must not
    // depend on them being right.
    const next = spent + serializedCostOf(character);
    if (next > allowance) {
      break;
    }
    spent = next;
    units += character.length;
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
const createResultBudget = (limit: number, initialReserve: number) => {
  // One, not zero: the result is a flat object, so its JSON is `{`, its
  // fields joined by commas, and `}`. Charging every field as
  // `"key":value,` — comma included — overcounts by exactly one comma,
  // which is what pays for the closing brace; the opening one is this.
  //
  // The point of doing it this way is that the sum stops being an
  // approximation of `JSON.stringify(result).length` and becomes equal to
  // it. Every round of review so far has found another part of the
  // envelope nobody was charged for — separators between links, the
  // `"resources":[…]` around them, the keys themselves — because a budget
  // that adds up *some* of what the transcript carries will always have
  // one more piece missing. This adds up all of it.
  let spent = 1;
  let reserve = initialReserve;
  // `limit` is what the whole result may weigh; this is what a *server*
  // may spend of it. Stratus's own truncation markers and notes come out
  // of the difference, so that announcing a cut cannot itself push the
  // result past the cut. See {@link noteReserveFor}.
  const remaining = (): number => Math.max(0, limit - reserve - spent);
  /**
   * What is left if the room held for one particular annotation is not
   * held — the allowance a value gets to prove it needs no annotation at
   * all. Releasing that room is safe precisely when the value fits in it,
   * because then the annotation it was held for will never be written.
   */
  const withoutOwn = (ownReserve: number): number =>
    Math.max(0, limit - spent - (reserve - ownReserve));
  // Two ways in, because a result carries two kinds of string. `fits` and
  // `charge` take a value that is ALREADY in the form the transcript holds
  // — a `JSON.stringify`d link or path, whose escapes are characters in it
  // already — so they count it as it stands. `spend` takes a server's raw
  // text, which becomes a JSON string *value* and is escaped on the way,
  // so it is charged for what that escaping costs. Measuring either one the
  // other way is wrong in a direction that matters: plainly, and a NUL
  // costs a sixth of what it weighs; serialized, and every quote in a link
  // is paid for twice.
  return {
    limit,
    /** Whether `value`, already serialized, fits in what is left. */
    fits: (value: string): boolean => withinLimit(value, remaining()),
    /** Charge `value`, already serialized; the caller has checked it fits. */
    charge: (value: string): void => {
      spent += charged(value);
    },
    /**
     * `value`, already serialized, taken whole if it fits once the room
     * held for the note that would report *dropping* it is released. The
     * note reports what did not fit; a collection that fits entirely never
     * produces one, so it should not be charged for one — a single
     * resource link that would have fitted in a 512-character result was
     * being dropped to hold room for the sentence saying it was dropped.
     */
    takeWhole: (value: string, ownReserve: number): boolean => {
      // `value` here already carries its own key and separator — the
      // callers build `"resources":[…],` and `"structured":…,` — so there
      // is no envelope to add.

      if (!withinLimit(value, withoutOwn(ownReserve))) {
        return false;
      }
      spent += charged(value);
      reserve = Math.max(0, reserve - ownReserve);
      return true;
    },
    /**
     * Give back room held for an annotation this result will not carry.
     * Clamped at zero, because a share given back twice is room the cap
     * never had — the budget would then let the fields below it overspend
     * by exactly the size of the note nobody is writing.
     */
    release: (ownReserve: number): void => {
      reserve = Math.max(0, reserve - ownReserve);
    },
    /**
     * Whether everything still to come fits with no room held back at all
     * — the question that decides whether anything has to be cut, and so
     * whether any of it has to be announced.
     */
    fitsUntouched: (cost: number): boolean => spent + cost <= limit,
    /** Nothing will be cut, so nothing will be announced. */
    releaseAll: (): void => {
      reserve = 0;
    },
    spend: (value: string, what: string, ownReserve: number, envelope: number): string => {
      // `envelope` is what the value costs beyond its own characters — the
      // key it arrives under, its quotes and its separator. Part of what it
      // costs, so part of what it has to fit inside.
      if (withinSerialized(value, withoutOwn(ownReserve) - envelope)) {
        spent += serializedLength(value) + envelope;
        reserve = Math.max(0, reserve - ownReserve);
        return value;
      }
      // Cut against the allowance that does *not* hold this marker's room,
      // because the cut is what writes the marker: `cutToLimit` subtracts
      // it from whatever it is given, so cutting against the reduced
      // allowance charged it twice and threw away a second marker's worth
      // of the server's text for nothing. A 511-character result came back
      // as 406 of its 512.
      const allowance = Math.max(0, withoutOwn(ownReserve) - envelope);
      const bounded = cutToLimit(value, allowance, what, limit);
      const cost = serializedLength(bounded) + envelope;
      // Released only when the marker did fit inside that allowance. When
      // it did not — the bare-marker case, at a cap too small to hold one
      // — the room stays held, and it is what covers the overspend, so the
      // result still weighs no more than the cap either way.
      if (cost <= withoutOwn(ownReserve)) {
        reserve = Math.max(0, reserve - ownReserve);
      }
      spent += cost;
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
 *
 * Bounded to the cap *minus the envelope it is replayed in*, for the same
 * reason a result's fields are: it does not travel as a bare string but as
 * a JSON string value under a key, and a message cut to exactly the cap
 * arrives a dozen characters over it. The marker still names the cap the
 * operator set rather than the number left after that deduction.
 */
export const THROWN_MESSAGE_ENVELOPE = `{"error":""}`.length;

export const boundServerText = (raw: string, limit: number, what: string): string =>
  cutToLimit(raw, Math.max(0, limit - THROWN_MESSAGE_ENVELOPE), what, limit);

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
  // Bounded here as well as at the config boundary, so that a host
  // embedding the normalizer directly gets the same floor an operator
  // does — `NormalizeOptions.maxResultChars` is reachable without going
  // through `mcpPlugin`'s validation at all.
  const resultLimit = boundedResultLimit(options.maxResultChars);
  const reserve = noteReserveFor(
    content,
    isObject(shaped.structuredContent),
    options.workspaceRoot !== undefined,
    resultLimit,
  );
  const budget = createResultBudget(resultLimit, reserve.total);
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
    // This branch discards the structured payload, the links and the
    // blocks — only the message survives, so only the marker that would
    // announce cutting *it* can ever be written. Room held for the others
    // comes out of the message instead, and a 280-character error came
    // back as 156 for a payload that weighs 292 of a 512-character cap.
    budget.release(reserve.total - reserve.text);
    throw new Error(
      // A failing call throws rather than returning a result, so what is
      // replayed is the message inside `ToolResult.error` — the same
      // envelope `boundServerText` deducts for, less the brace the budget
      // starts out holding against a result object that is never built.
      budget.spend(message, 'error message', reserve.text, THROWN_MESSAGE_ENVELOPE - 1)
      || `MCP server ${options.server} reported an error for ${options.tool} with no message.`,
    );
  }

  // Resolved once for the whole result rather than per block. The inputs
  // are fixed for the call, and a server answering with ten thousand tiny
  // images would otherwise pay two syscalls apiece to be told there is no
  // room left — which is the case the cap exists for. Scoped to this one
  // result, so it cannot hand a later call another agent's directory the
  // way a setup-time cache would.
  let resolvedDirectory: string | undefined;
  const binaryDirectory = async (root: string): Promise<string> => {
    if (resolvedDirectory === undefined) {
      // Canonical, because the ledger is keyed the way `fs.read` looks a
      // path up — through `realpath` — and a workspace root or agent
      // directory an operator moved behind a link would otherwise leave
      // the record under a spelling no read ever asks for.
      const lexical = path.join(root, options.agentId, 'mcp', options.server);
      await mkdir(lexical, { recursive: true });
      resolvedDirectory = await realpath(lexical);
    }
    return resolvedDirectory;
  };

  /**
   * A binary block's name, worked out without writing anything.
   *
   * Two phases, because a block cannot be judged on its own: the cost of
   * an attachment list is only known once every name in it is, and a block
   * refused against a half-known list was being dropped when the whole
   * result would have fitted. So every name is planned first, the list is
   * weighed as a list, and only the blocks that fit are written. Nothing
   * reaches the disk before that decision, which is the property the
   * single-phase version was built around and this keeps.
   */
  const planned: { file: string; data: string }[] = [];
  const planBlock = async (data: unknown, mimeType: unknown): Promise<void> => {
    if (typeof data !== 'string') {
      return;
    }
    if (!options.workspaceRoot) {
      texts.push(`[binary ${typeof mimeType === 'string' ? mimeType : 'content'} dropped: no workspaceRoot is configured for @stratusagent/plugin-mcp]`);
      return;
    }
    const directory = await binaryDirectory(options.workspaceRoot);
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
    planned.push({ file, data });
  };

  /**
   * What an attachment adds to the result: the first entry pays for the
   * key, the brackets and the field's own separator, each one after it for
   * the comma joining it to the last. The total is exactly what
   * `"files":[…],` weighs.
   */
  const fileEntryCost = (file: string, first: boolean): string =>
    (first ? `"files":[${JSON.stringify(file)}],` : `,${JSON.stringify(file)}`);

  const commitBlock = async (file: string, data: string): Promise<void> => {
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
        await planBlock(block.data, block.mimeType);
        break;
      case 'resource': {
        const resource = isObject(block.resource) ? block.resource : {};
        if (typeof resource.text === 'string') {
          const uri = typeof resource.uri === 'string' ? resource.uri : undefined;
          texts.push(uri ? `${uri}:\n${resource.text}` : resource.text);
        } else {
          await planBlock(resource.blob, resource.mimeType);
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

  // What the text will cost beyond its own characters. A result with
  // nothing but text is returned as the string itself rather than as an
  // object, so it pays for its two quotes and nothing else — the `- 1`
  // gives back the brace the budget starts out holding.
  const collapsesToText = planned.length === 0
    && resources.length === 0
    && !isObject(shaped.structuredContent);

  // Measured as its own serialized string rather than by walking the
  // object: what the provider is sent is the JSON, so the JSON is the cost.
  // A structured payload that does not fit arrives as *text* — it stops
  // being a parseable object, which is the honest outcome, since a
  // truncated object is not one. The key says which it is, so a caller
  // reading `structured` never finds a half-object there.
  const structuredRaw = isObject(shaped.structuredContent) ? (shaped.structuredContent as JsonObject) : undefined;
  const structuredJson = structuredRaw === undefined ? undefined : JSON.stringify(structuredRaw);

  // Nothing needs announcing if nothing needs cutting, so ask that first.
  //
  // The reservation is held per annotation and released per annotation,
  // which is right when something does have to be cut — but it still
  // charged each field for the *other* fields' unspent room, and a field
  // that would have fitted got cut to make space for a sentence about a
  // different field that was never going to be written either. Four
  // hundred characters of text beside a three-character structured payload
  // came back cut at a 512-character cap, for a result that weighed 434
  // whole.
  //
  // So the untouched result is weighed once, against the cap with no room
  // held back at all. If it fits, every reservation is released and each
  // field below finds itself whole. Weighed rather than built: these are
  // the same sums the fields are charged, so a ten-megabyte result is
  // measured, not materialized.
  const joinedText = texts.length > 0 ? texts.join('\n\n') : undefined;
  const plannedFiles = planned.map((block, index) => fileEntryCost(block.file, index === 0)).join('');
  // Counted the way `charge` counts, in code points — `.length` is UTF-16
  // units, so a structured payload or a link description carrying emoji
  // weighed twice what it is charged, and a result that fitted was judged
  // not to and had its *text* cut for the difference.
  const untouched = charged(plannedFiles)
    + (joinedText === undefined
      ? 0
      : serializedLength(joinedText) + (collapsesToText ? 2 - 1 : keyOverhead('text')))
    + (structuredJson === undefined ? 0 : charged(`"structured":${structuredJson},`))
    + (resources.length === 0 ? 0 : charged(`"resources":${JSON.stringify(resources)},`));
  const nothingCut = budget.fitsUntouched(untouched);
  if (nothingCut) {
    budget.releaseAll();
  }

  // The attachments are decided here rather than as each block arrived,
  // because what one costs depends on how many came before it, and a block
  // judged against a half-known list was refused while the whole result
  // would have fitted. Charged in order and written only once admitted, so
  // a refusal still leaves nothing on disk.
  // When something else forces a cut, the list still gets the try the
  // resource links get: weighed whole, at the allowance it has once the
  // room for `filesTruncated` is not held. A list that fits entirely never
  // produces that note, so holding room for it dropped attachments that
  // belonged in the result — an image beside a text that did have to be
  // cut was refused, for a result weighing 389 of its 512.
  const wholeListFits = !nothingCut
    && planned.length > 0
    && budget.takeWhole(plannedFiles, reserve.files);

  for (const block of planned) {
    const cost = fileEntryCost(block.file, files.length === 0);
    if (!nothingCut && !wholeListFits && !budget.fits(cost)) {
      skippedBinary += 1;
      continue;
    }
    await commitBlock(block.file, block.data);
    // Already charged as a list, so not charged again as entries.
    if (!wholeListFits) {
      budget.charge(cost);
    }
    files.push(block.file);
  }
  if (skippedBinary === 0 && !nothingCut && !wholeListFits) {
    // No `filesTruncated` to pay for, and everything below spends after
    // this point, so holding its room would come out of the text. Only
    // when it is still held: the other two paths have already given it
    // back, and giving it back twice is room the cap never had.
    budget.release(reserve.files);
  }

  const text = joinedText !== undefined
    ? budget.spend(joinedText, 'result', reserve.text, collapsesToText ? 2 - 1 : keyOverhead('text'))
    : undefined;
  // Tried whole first, at the allowance it gets once the room for its own
  // marker is not held — the same release the links get, and for the same
  // reason: a payload that survives intact never produces the marker that
  // room was held for. Weighed as the field it becomes, key and separator
  // included, rather than as the bare JSON.
  const structuredFits = structuredJson !== undefined
    && budget.takeWhole(`"structured":${structuredJson},`, reserve.structured);
  const structured = structuredFits ? structuredRaw : undefined;
  // Only ever reached when the object form did not fit, and the string
  // form is strictly larger — it escapes every quote in that JSON — so
  // this always cuts, and `structuredText` can never come back holding an
  // untruncated payload under a key that says it was truncated.
  const structuredNote = structuredJson !== undefined && !structuredFits
    ? budget.spend(structuredJson, 'structured result', reserve.structured, keyOverhead('structuredText'))
    : undefined;

  // Resource links are server-controlled strings too, and a list of them is
  // as unbounded as a paragraph is: `uri`, `name`, `title` and
  // `description` all land in the durable result and are replayed with it.
  // Kept whole while the budget lasts and then stopped, rather than each
  // one cut — half a URI is no use to anybody, while nine links and a note
  // saying there were ninety is.
  const kept: JsonObject[] = [];
  // The whole list first, at the allowance it gets when the room held for
  // `resourcesTruncated` is not held. A list that fits entirely never
  // produces that note, so being charged for it is how a result came to
  // drop the one link it could comfortably have carried.
  if (resources.length > 0 && budget.takeWhole(`"resources":${JSON.stringify(resources)},`, reserve.resources)) {
    kept.push(...resources);
  }
  for (const link of kept.length === resources.length ? [] : resources) {
    // Charged as the list costs, not as the link costs. A link measured on
    // its own leaves the comma joining it to the last one unpaid, and the
    // key and brackets the collection arrives in unpaid entirely — so
    // thousands of minimal links each pass the check while the array they
    // serialize into runs thousands of characters past the cap. The first
    // link pays for the envelope, each one after it pays for its
    // separator, and the total is exactly what `"resources":[…]` weighs
    // in the result.
    const serialized = JSON.stringify(link);
    const cost = kept.length === 0 ? `"resources":[${serialized}],` : `,${serialized}`;
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
      ? { resourcesTruncated: resourcesTruncatedNote(droppedLinks, budget.limit) }
      : {}),
    ...(skippedBinary > 0
      ? { filesTruncated: filesTruncatedNote(skippedBinary, budget.limit) }
      : {}),
  };
};
