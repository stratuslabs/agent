/*
 * Image attachments: the formats and limits a model request accepts, the
 * header check a channel runs before it keeps a download, and the replay
 * budget that decides which of a session's stored images still go out on a
 * request. A module of its own because channels, providers and the runner
 * all build against it. `index.ts` re-exports every name, so the package's
 * one public entry is unchanged.
 */
import type { Message } from './index.ts';

/**
 * The image formats a model request may carry. The list is the Messages
 * API's, and it is exported so a channel deciding which of a message's
 * attachments to fetch asks this rather than keeping its own copy — a
 * format the API rejects is one the channel should never have downloaded.
 */
export const IMAGE_ATTACHMENT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageAttachmentMediaType = (typeof IMAGE_ATTACHMENT_MEDIA_TYPES)[number];

export const isImageAttachmentMediaType = (value: unknown): value is ImageAttachmentMediaType =>
  typeof value === 'string' && (IMAGE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);

/**
 * The largest image a message may carry, in decoded bytes. The Messages
 * API refuses anything over 5 MB per image, and a session is one JSON row
 * that every later turn re-reads — an image is stored with the message it
 * arrived on, so the cap is also what keeps a transcript readable.
 */
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The most image bytes one message may carry in total, decoded. The
 * Messages API caps a request body at 32 MiB, and base64 costs a third
 * again — so five images each just under the per-image cap pass one by one
 * and still fail the turn together. 20 MiB decoded is 26.7 MiB encoded,
 * leaving room for the text around it.
 */
export const IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * The most images one request may carry, whatever they weigh. The Messages
 * API accepts 100 per request, but past 20 it also shrinks what each may
 * measure to 2000 pixels a side — and an image was accepted at up to
 * `IMAGE_ATTACHMENT_MAX_DIMENSION` when it arrived. Twenty is the count at
 * which every image already stored is still one the API takes.
 */
export const IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT = 20;

/**
 * The most an image may measure on either side, in pixels. The Messages
 * API refuses anything larger, and a large flat PNG compresses far below
 * the byte cap — so bytes alone would let an image in that fails the turn
 * it arrives on and, once stored, every turn after.
 */
export const IMAGE_ATTACHMENT_MAX_DIMENSION = 8000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * An image's pixel size, read from its header without decoding it, or
 * nothing when the bytes do not carry the header and trailer their media
 * type promises — which a caller should treat as "not an image it can
 * send". The trailer is what catches a download cut short: a PNG ends in
 * IEND, a JPEG in an end-of-image marker, a GIF in a trailer byte, and a
 * RIFF container declares its own length. It is not a decode — bytes that
 * open and close correctly can still be refused by a model API, and a
 * provider handles that when it happens (see `omitImage`) — but it is
 * everything that can be checked without an image library, which core
 * does not carry. One reader for the four accepted formats, so a channel
 * deciding whether to keep a download asks this rather than trusting the
 * uploader's metadata.
 */
export const imageDimensions = (bytes: Uint8Array, mediaType: ImageAttachmentMediaType): ImageDimensions | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  const last = bytes.length;
  switch (mediaType) {
    case 'image/png': {
      if (bytes.length < 36 || ascii(1, 3) !== 'PNG' || ascii(12, 4) !== 'IHDR' || ascii(last - 8, 4) !== 'IEND') {
        return undefined;
      }
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    case 'image/gif': {
      if (bytes.length < 11 || ascii(0, 4) !== 'GIF8' || bytes[last - 1] !== 0x3b) {
        return undefined;
      }
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    case 'image/webp': {
      if (bytes.length < 30 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP' || view.getUint32(4, true) !== last - 8) {
        return undefined;
      }
      // Three container layouts, each keeping its size somewhere different.
      const chunk = ascii(12, 4);
      if (chunk === 'VP8 ') {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
      if (chunk === 'VP8X') {
        return {
          width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
          height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
        };
      }
      return undefined;
    }
    case 'image/jpeg': {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[last - 2] !== 0xff || bytes[last - 1] !== 0xd9) {
        return undefined;
      }
      // Walk the segments to the first start-of-frame, which carries the size.
      let at = 2;
      while (at + 9 <= bytes.length) {
        if (bytes[at] !== 0xff) {
          return undefined;
        }
        const marker = bytes[at + 1]!;
        if (marker === 0xff) {
          at += 1;
          continue;
        }
        const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (startOfFrame) {
          return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
        }
        const standalone = marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
        at += standalone ? 2 : 2 + view.getUint16(at + 2);
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

/** What `imagesWithinReplayBudget` holds a request to; each defaults to the constant above it. */
export interface ImageReplayBudget {
  bytes?: number;
  count?: number;
}

/**
 * An image a person sent with a user message, as the model receives it.
 * Bytes are base64 so the attachment survives in the session's JSON body
 * and replays on every later turn the way the text does.
 */
export interface ImageAttachment {
  mediaType: ImageAttachmentMediaType;
  /** Base64-encoded image bytes. */
  data: string;
  /**
   * What the sender called it, for a runtime that renders the transcript
   * as text and can only say that an image was there.
   */
  name?: string;
  /**
   * Set once the bytes have been let go of: the image fell outside the
   * replay window when a later turn was stored (see
   * `omitImagesOutsideReplayBudget`), and `data` is empty. The record that
   * an image was here, and what it was called, outlives the pixels.
   */
  omitted?: true;
}

/** Decoded size of a base64 string, without decoding it. */
const base64DecodedBytes = (data: string): number =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/**
 * Which of a transcript's images still travel on a request. Every image a
 * session ever received is stored with its message and replayed on every
 * later turn, so a per-message budget alone is not one: two messages that
 * each fit would together exceed the request limit on the turn after. The
 * budget — bytes and a count, both API limits — is spent newest first,
 * within a message as well as across them: the latest message always
 * arrives whole, because a channel already holds one message to this same
 * budget, and once an image does not fit, nothing older does either, so
 * what the model sees is a contiguous recent window rather than a
 * scatter. A provider
 * that sends image bytes asks this and sends a note in place of the rest;
 * the transcript itself is never trimmed.
 *
 * Membership is by identity: the set holds the very objects on the
 * messages, so a provider walking them asks `has(image)`.
 */
export const imagesWithinReplayBudget = (
  messages: readonly Message[],
  budget: ImageReplayBudget = {},
): ReadonlySet<ImageAttachment> => {
  const kept = new Set<ImageAttachment>();
  let remaining = budget.bytes ?? IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES;
  const count = budget.count ?? IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const images = messages[index]?.images;
    if (images === undefined) {
      continue;
    }
    for (let position = images.length - 1; position >= 0; position -= 1) {
      const image = images[position]!;
      // Nothing left to send, and nothing to charge: an omitted image is
      // always older than every kept one, so skipping it keeps the window
      // contiguous.
      if (image.omitted === true) {
        continue;
      }
      const bytes = base64DecodedBytes(image.data);
      if (bytes > remaining || kept.size >= count) {
        return kept;
      }
      remaining -= bytes;
      kept.add(image);
    }
  }
  return kept;
};

/**
 * Lets go of the bytes of every image outside the replay window, in
 * place, keeping its name and the fact that it was there. The runner calls
 * this as it stores a turn: the replay budget bounds what a provider
 * sends, but a session is one JSON row that every turn re-reads and
 * re-writes whole, and without this every image a thread ever received
 * would stay in it — so anyone who can post to a channel could grow a row
 * by the whole budget per message, forever. What the model can be shown is
 * exactly what is kept, so nothing the trim removes could have been sent.
 * Returns how many images it emptied.
 */
export const omitImagesOutsideReplayBudget = (messages: Message[], budget: ImageReplayBudget = {}): number => {
  const kept = imagesWithinReplayBudget(messages, budget);
  let omitted = 0;
  for (const message of messages) {
    for (const image of message.images ?? []) {
      if (image.omitted === true || kept.has(image)) {
        continue;
      }
      omitImage(image);
      omitted += 1;
    }
  }
  return omitted;
};

/**
 * Lets go of one image's bytes in place, keeping the record that it was
 * there. Besides the replay window, this is what a provider does to an
 * image the model API refused: the header checks a channel runs are not a
 * decode, so a file that opens and closes correctly can still be rejected
 * — and because an image is stored before the provider is called, a
 * rejection left alone would replay on every later turn of the session.
 * Emptied in place on the session's own object, so the runner's next save
 * carries it and the turn goes on with a note in the image's place.
 */
export const omitImage = (image: ImageAttachment): void => {
  image.data = '';
  image.omitted = true;
};

/**
 * What stands in for an image `imagesWithinReplayBudget` left out — one
 * wording, so every provider tells the model the same thing about the
 * same gap.
 */
export const droppedImageNote = (image: ImageAttachment): string =>
  `[An image attached here${image.name !== undefined ? ` (${image.name})` : ''} is no longer sent: this conversation's images have passed what one request can carry, and only the most recent are kept.]`;
