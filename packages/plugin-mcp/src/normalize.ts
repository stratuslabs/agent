import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue } from '@stratusagent/core';
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

  // Settled before anything touches the disk: a failing result's binary
  // blocks would otherwise land as server-controlled files in the
  // workspace that nothing references, delivers, or cleans up.
  if (shaped.isError === true) {
    const message = content
      .filter(isObject)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n\n');
    throw new Error(message || `MCP server ${options.server} reported an error for ${options.tool} with no message.`);
  }

  const writeBlock = async (data: unknown, mimeType: unknown): Promise<void> => {
    if (typeof data !== 'string') {
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

  const structured = isObject(shaped.structuredContent) ? (shaped.structuredContent as JsonObject) : undefined;
  const text = texts.length > 0 ? texts.join('\n\n') : undefined;

  if (structured === undefined && files.length === 0 && resources.length === 0) {
    return text ?? '';
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(structured !== undefined ? { structured } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  };
};
