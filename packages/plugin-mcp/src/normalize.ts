import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue, TrustLevel } from '@stratusagent/core';
import { nameIdentifiesHandle, type TaintedWriteLedger } from '@stratusagent/plugins';

import { sanitizeToolSegment } from './descriptors.ts';
import {
  boundedResultLimit,
  charged,
  createResultBudget,
  cutToLimit,
  filesTruncatedNote,
  isObject,
  keyOverhead,
  noteReserveFor,
  resourcesTruncatedNote,
  serializedLength,
} from './result-budget.ts';

/**
 * Turning what an MCP server sends back into what a Stratus tool returns:
 * `JsonValue` out, files on disk where a content block is binary. Split
 * from the client lifecycle because this half is pure enough to test
 * without a connection.
 */

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

// Distinguishes every written file within one process. A timestamp alone
// is not enough: two calls in the same millisecond (parallel tool calls in
// one turn) would produce the same path, and the first result's `files`
// entry would silently point at the second call's bytes.
let fileSerial = 0;

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
   * Where this agent's workspace is, asked for rather than passed in — not
   * a root to join an id onto. Binary content lands under
   * `<workspace>/mcp/<server>/`, so two agents never read each other's
   * files, the same shape screenshots take.
   *
   * A function because asking is no longer free: the host's seam *creates*
   * the directory and settles its permissions, and it can fail. A
   * text-only result must not be reported as an error because a workspace
   * it never wanted could not be made — the remote call has already
   * happened, and whoever retries it does the side effect twice.
   */
  workspace?: () => string;
  agentId: string;
  /**
   * The filesystem provenance ledger for `workspace`. A binary block
   * is a server's bytes written to disk without going through `fs.write`,
   * so the write records itself here at `trust` before the bytes land —
   * a later `fs.read` of the file then carries the label the tool result
   * did. Without a ledger the file is written unrecorded, which is what
   * the loader-less host case gets.
   */
  ledger?: TaintedWriteLedger;
  /**
   * The label a file this call writes is recorded at: the operator's
   * `servers.<name>.outputTrust` (`external` unless they said otherwise),
   * lowered to the calling session's own label, so a file read back never
   * claims more than the result or the session that wrote it.
   */
  trust?: TrustLevel;
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
  // Bounded here as well as at the config boundary, so that a host
  // embedding the normalizer directly gets the same floor an operator
  // does — `NormalizeOptions.maxResultChars` is reachable without going
  // through `mcpPlugin`'s validation at all.
  const resultLimit = boundedResultLimit(options.maxResultChars);
  try {
    return await normalizeAdmittedResult(result, options, resultLimit);
  } catch (error) {
    // Every way out of this function lands in the same place. A returned
    // result is spent against the budget field by field, but a *thrown*
    // one is copied into `ToolResult.error`, persisted on the session and
    // replayed on every later turn — the same durable channel, with none
    // of the accounting. So the cap is applied once more on the way out,
    // where it covers the paths the budget never saw: a failed save
    // quoting the path it could not write (a server naming
    // `image/<430 chars>` produced a 544-character error against a
    // 512-character cap), and the synthesized message for an `isError`
    // result that carried no text at all.
    //
    // A no-op for the `isError` throw below, which already spent its
    // message against the budget at `THROWN_MESSAGE_ENVELOPE - 1` over
    // the brace the budget starts holding: that leaves it at exactly the
    // allowance this bound measures against, so it is never cut twice or
    // marked twice.
    throw error instanceof Error
      ? new Error(boundServerText(error.message, resultLimit, 'error message'), { cause: error })
      : error;
  }
};

const normalizeAdmittedResult = async (
  result: unknown,
  options: NormalizeOptions,
  resultLimit: number,
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
  const reserve = noteReserveFor(
    content,
    isObject(shaped.structuredContent),
    options.workspace !== undefined,
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
  const binaryDirectory = async (workspace: string): Promise<string> => {
    if (resolvedDirectory === undefined) {
      // Canonical, because the ledger is keyed the way `fs.read` looks a
      // path up — through `realpath` — and a workspace an operator moved
      // behind a link would otherwise leave the record under a spelling no
      // read ever asks for.
      const lexical = path.join(workspace, 'mcp', options.server);
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
    const workspace = options.workspace?.();
    if (workspace === undefined || workspace.length === 0) {
      texts.push(`[binary ${typeof mimeType === 'string' ? mimeType : 'content'} dropped: @stratusagent/plugin-mcp has no workspace for ${options.agentId} — the host supplied neither a workspaces seam nor a workspaceRoot]`);
      return;
    }
    const directory = await binaryDirectory(workspace);
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
    await options.ledger?.recordWrite(options.agentId, file, options.trust ?? 'external');
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
