/*
 * `fs.read`: one UTF-8 text file inside the agent's roots, a page at a time
 * from a byte offset, cut on a whole character. A file whose own first bytes
 * say PNG, JPEG, GIF or WebP is shown to the model as an image instead.
 */
import { constants } from 'node:fs';
import path from 'node:path';

import {
  type ExecutionContext,
  IMAGE_ATTACHMENT_MAX_BYTES,
  type ImageAttachmentMediaType,
  type JsonObject,
  type Tool,
} from '@stratusagent/core';
import type { LedgerGuard, ProtectedPathGuard, TaintedWriteLedger } from '@stratusagent/plugins';

import { openContained, type ResolvedPath, resolveWithinRoots } from './paths.ts';
import {
  type KeyedSerializer,
  looksBinary,
  narrowed,
  refuseProtected,
  relativeTo,
  requireString,
  settingsFor,
} from './shared.ts';
import { ledgerContentTrustAmong, lowest, recordedTrustAmong } from './trust.ts';

/**
 * The image format a file's own first bytes declare, for the four the
 * model APIs take — never its extension, which anyone can choose.
 */
const imageMediaTypeOf = (bytes: Uint8Array): ImageAttachmentMediaType | undefined => {
  const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  return undefined;
};

/** Whether a byte continues a UTF-8 sequence rather than starting one. */
const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

/**
 * How many of `bytes` end on a whole character: a page cut inside a
 * multi-byte sequence would show half of it as U+FFFD, and the next page
 * would open with the other half as another. Dropping the partial tail
 * here is what lets the pages join back into the file exactly.
 */
const wholeCharacterLength = (bytes: Buffer): number => {
  let start = bytes.length - 1;
  while (start >= 0 && isContinuation(bytes[start])) {
    start -= 1;
  }
  if (start < 0) {
    return bytes.length;
  }
  // A lead byte with all its continuations present ends whole; one cut
  // short is dropped, even when that leaves nothing. The caller widens an
  // empty page to one whole character rather than returning half of one.
  return start + utf8Width(bytes[start]) <= bytes.length ? bytes.length : start;
};

/** The bytes in the UTF-8 sequence this lead byte opens. */
const utf8Width = (lead: number | undefined): number => {
  const byte = lead ?? 0;
  return byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
};

const readContained = async (
  resolved: ResolvedPath,
  maxBytes: number,
  offset = 0,
): Promise<{ content: string; truncated: boolean; bytes: number; size: number; offset: number; nextOffset?: number; binary: boolean; image?: { mediaType: ImageAttachmentMediaType; data: Buffer } }> => {
  if (resolved.kind === 'directory') {
    throw new Error(`${resolved.path} is a directory; use fs.list.`);
  }
  if (resolved.kind === 'other') {
    // A FIFO, a socket, a device. Opening one does not fail — it *blocks*,
    // and a tool call that never returns is worse than one that refuses.
    throw new Error(`${resolved.path} is not a regular file.`);
  }
  // `O_NONBLOCK` alongside the check above, and not instead of it: the check
  // gives a refusal an agent can read, and this makes the failure mode of
  // *missing* one a returned error rather than a turn that never ends. It
  // has no effect on a regular file.
  const handle = await openContained(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (info.isDirectory()) {
      throw new Error(`${resolved.path} is a directory; use fs.list.`);
    }
    // An image is recognized from its own header, read apart from the text
    // cap (a cap shorter than a PNG signature would hide it), and read
    // whole up to the per-image cap: a third of a PNG is no picture at
    // all. Over that cap it stays a binary file, and the result says so.
    const header = Buffer.alloc(Math.min(info.size, 16));
    const { bytesRead: headerRead } = await handle.read(header, 0, header.length, 0);
    const mediaType = imageMediaTypeOf(header.subarray(0, headerRead));
    if (mediaType !== undefined) {
      if (info.size <= IMAGE_ATTACHMENT_MAX_BYTES) {
        const whole = Buffer.alloc(info.size);
        const { bytesRead: wholeRead } = await handle.read(whole, 0, info.size, 0);
        return { content: '', truncated: false, bytes: wholeRead, size: info.size, offset: 0, binary: true, image: { mediaType, data: whole.subarray(0, wholeRead) } };
      }
      return { content: '', truncated: false, bytes: 0, size: info.size, offset: 0, binary: true, image: { mediaType, data: Buffer.alloc(0) } };
    }
    // An offset that lands inside a character (one a model computed rather
    // than took from `nextOffset`) moves forward to the next whole one,
    // three bytes at most, rather than opening the page with mojibake.
    let start = Math.min(offset, info.size);
    if (start > 0 && start < info.size) {
      const peek = Buffer.alloc(3);
      const { bytesRead: peeked } = await handle.read(peek, 0, Math.min(3, info.size - start), start);
      let skip = 0;
      while (skip < peeked && isContinuation(peek[skip])) {
        skip += 1;
      }
      start += skip;
    }
    let length = Math.max(0, Math.min(info.size - start, maxBytes));
    let buffer = Buffer.alloc(length);
    let { bytesRead } = await handle.read(buffer, 0, length, start);
    // A cap narrower than the character at `start` would otherwise return
    // half of it and point `nextOffset` into its middle, where the next
    // read skips the rest: the character lost. The page grows to that one
    // character instead, four bytes at most.
    if (bytesRead > 0 && start + bytesRead < info.size && wholeCharacterLength(buffer.subarray(0, bytesRead)) === 0) {
      length = Math.min(info.size - start, utf8Width(buffer[0]));
      buffer = Buffer.alloc(length);
      ({ bytesRead } = await handle.read(buffer, 0, length, start));
    }
    const read = buffer.subarray(0, bytesRead);
    if (looksBinary(read)) {
      return { content: '', truncated: false, bytes: bytesRead, size: info.size, offset: start, binary: true };
    }
    const end = start + bytesRead;
    // Only a page that stops short of the end is trimmed to a character
    // boundary; the file's own last byte is where it ends, whole or not.
    const kept = end < info.size ? wholeCharacterLength(read) : bytesRead;
    const nextOffset = start + kept < info.size ? start + kept : undefined;
    return {
      content: read.subarray(0, kept).toString('utf8'),
      truncated: nextOffset !== undefined,
      bytes: kept,
      size: info.size,
      offset: start,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      binary: false,
    };
  } finally {
    await handle.close();
  }
};

export const createReadTool = (
  config: JsonObject,
  ledger: TaintedWriteLedger,
  isLedger: () => Promise<LedgerGuard>,
  serialized: KeyedSerializer,
  isProtected: () => Promise<ProtectedPathGuard>,
): Tool => ({
  name: 'fs.read',
  description: 'Read a UTF-8 text file inside one of this agent’s roots. A PNG, JPEG, GIF, or WebP image (a screenshot, say) is shown to you as an image, up to 5 MB.',
  risk: 'safe',
  // Changes nothing, so a response's reads run together (`Tool.readOnly`).
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute, or relative to the agent’s first root.' },
      maxBytes: { type: 'number', description: 'Stop after this many bytes.' },
      offset: { type: 'number', description: 'Start this many bytes in. A clipped read returns nextOffset; pass it here to read on.' },
    },
    required: ['path'],
  },
  async execute(input, session, context) {
    const settings = settingsFor(config, session);
    const requested = requireString(input, 'path');
    const resolved = await resolveWithinRoots(settings.roots, requested, { home: settings.home });
    await refuseProtected(isProtected, resolved, requested);
    const maxBytes = narrowed(input.maxBytes, settings.maxBytes);
    const offset = typeof input.offset === 'number' && Number.isFinite(input.offset) && input.offset > 0
      ? Math.floor(input.offset)
      : 0;
    // Per call, not per tool: most files an agent reads are its operator's,
    // and only the ones a tainted session wrote carry a label — see the
    // ledger. Bytes and label are read as one step under the path's own
    // lock, so a write from this process landing between them cannot pair
    // old bytes with a new record; a write from another process is not
    // under this lock, so the ledger is read on both sides of the bytes
    // (`recordedTrustAmong` takes the second snapshot) and the lower label
    // stands — a peer records before its bytes land, so a record missing
    // from the first read is in the second. Marked after the read
    // succeeded, since a refused read put nothing in front of the model.
    const { result, recorded } = await serialized(resolved.path, async () => {
      const snapshot = await ledger.snapshot(session.agent.id);
      const contents = await readContained(resolved, maxBytes, offset);
      return {
        result: contents,
        // The result names the file's path, directories included — see
        // `withAncestors`.
        recorded: lowest(
          await recordedTrustAmong(ledger, session.agent.id, [resolved.path], resolved.root, snapshot),
          await ledgerContentTrustAmong(isLedger, [[resolved.path, {
            identity: resolved.identity,
            // A page from past the start is as partial as a clipped one: the
            // records before it are not in front of the label either.
            ...(contents.binary ? {} : { raw: contents.content, truncated: contents.truncated || contents.offset > 0 }),
          }]]),
        ),
      };
    });
    if (recorded !== undefined) {
      context?.markTrust?.(recorded);
    }
    return {
      path: relativeTo(resolved.root, resolved.path),
      absolutePath: resolved.path,
      ...(result.binary
        ? { binary: true, bytes: result.size, ...showImage(result.image, path.basename(resolved.path), context) }
        : {
            content: result.content,
            bytes: result.bytes,
            size: result.size,
            // Said outright rather than left for the model to notice: a
            // silently clipped file reads as a complete one, and a summary
            // written from half a document is confidently wrong.
            truncated: result.truncated,
            // Named only when they say something: an ordinary whole-file
            // read looks exactly as it did before paging existed.
            ...(result.offset > 0 ? { offset: result.offset } : {}),
            ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
          }),
    };
  },
});

/**
 * Hands an image file to the model through the call's `attachImage`
 * sink, and says in the result whether it did — and why not, so an agent
 * told a file is a PNG never answers as if it had looked at it.
 */
const showImage = (
  image: { mediaType: ImageAttachmentMediaType; data: Buffer } | undefined,
  name: string,
  context: ExecutionContext | undefined,
): JsonObject => {
  if (image === undefined) {
    return {};
  }
  if (image.data.length === 0) {
    return { image: { mediaType: image.mediaType, shown: false, reason: `The image is over the ${IMAGE_ATTACHMENT_MAX_BYTES}-byte limit for one image.` } };
  }
  if (!context?.attachImage) {
    return { image: { mediaType: image.mediaType, shown: false, reason: 'This runtime cannot show images to the model.' } };
  }
  try {
    context.attachImage({ mediaType: image.mediaType, data: image.data.toString('base64'), name });
    return { image: { mediaType: image.mediaType, shown: true } };
  } catch (error) {
    return { image: { mediaType: image.mediaType, shown: false, reason: error instanceof Error ? error.message : String(error) } };
  }
};
