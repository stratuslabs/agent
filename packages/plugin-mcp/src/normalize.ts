import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue } from '@stratusagent/core';

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
  const texts: string[] = [];
  const files: string[] = [];
  const resources: JsonObject[] = [];

  const writeBlock = async (data: unknown, mimeType: unknown, index: number): Promise<void> => {
    if (typeof data !== 'string') {
      return;
    }
    if (!options.workspaceRoot) {
      texts.push(`[binary ${typeof mimeType === 'string' ? mimeType : 'content'} dropped: no workspaceRoot is configured for @stratusagent/plugin-mcp]`);
      return;
    }
    const directory = path.join(options.workspaceRoot, options.agentId, 'mcp', options.server);
    await mkdir(directory, { recursive: true });
    const stamp = (options.now ?? Date.now)();
    const file = path.join(
      directory,
      `${options.tool}-${stamp}-${index}.${extensionFor(typeof mimeType === 'string' ? mimeType : undefined)}`,
    );
    await writeFile(file, Buffer.from(data, 'base64'));
    files.push(file);
  };

  const content = Array.isArray(shaped.content) ? shaped.content : [];
  for (const [index, block] of content.entries()) {
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
        await writeBlock(block.data, block.mimeType, index);
        break;
      case 'resource': {
        const resource = isObject(block.resource) ? block.resource : {};
        if (typeof resource.text === 'string') {
          const uri = typeof resource.uri === 'string' ? resource.uri : undefined;
          texts.push(uri ? `${uri}:\n${resource.text}` : resource.text);
        } else {
          await writeBlock(resource.blob, resource.mimeType, index);
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

  if (shaped.isError === true) {
    throw new Error(texts.join('\n\n') || `MCP server ${options.server} reported an error for ${options.tool} with no message.`);
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
