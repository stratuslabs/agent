/*
 * What a message's files become for the model: images read and previewed
 * within their caps, text attachments read inline or saved to the agent's
 * workspace, and the notes that name anything left unread and why. A
 * module of its own because it is a self-contained step of intake. Nothing
 * here is public: `index.ts` imports what the adapter needs, and the
 * package's one public entry is unchanged.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  type ConversationMessage,
  type ConversationReadRequest,
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES,
  type ImageAttachment,
  type ImageAttachmentMediaType,
  imageDimensions,
  isImageAttachmentMediaType,
  type TrustLevel,
} from '@stratusagent/core';

import type {
  SlackAdapterOptions,
  SlackFileDownload,
  SlackFileFetcher,
  SlackInboundFile,
} from './index.ts';

/** At most this many attachment names are listed; the rest are counted. */
const MAX_LISTED_ATTACHMENTS = 5;

/**
 * Why an attachment reached the turn as a name only. The note says which,
 * per file, because "cannot be read here" for every one of them read the
 * same for a PDF nothing here opens, a log over the size cap, and a
 * download Slack refused, and an agent asked why guessed at the cause.
 */
type UnreadReason = 'unsupported' | 'too-large' | 'failed' | 'timed-out' | 'unreadable' | 'not-opened';
export type UnreadReasons = Map<SlackInboundFile, UnreadReason>;

const UNREAD_REASON_TEXT: Record<UnreadReason, string> = {
  unsupported: 'not a kind of file that can be read here',
  'too-large': 'too large to read here',
  failed: 'could not be downloaded',
  'timed-out': 'not downloaded in time',
  unreadable: 'not readable as text or as an image',
  'not-opened': 'not opened, since this message was not addressed to you',
};

/**
 * What a message's attachments are called, and why each was not read, for
 * a turn that cannot open them. Without this the agent is handed "here's
 * the log" and no log, and answers as though it had read something; the
 * note is what lets it say the true thing instead. Images the model was
 * actually shown are not listed here: they travel on the dispatch, name
 * included. A file with no recorded reason is one no reader was handed,
 * which is `unsupported`.
 */
export const attachmentNote = (files: readonly SlackInboundFile[], reasons: UnreadReasons): string => {
  if (files.length === 0) {
    return '';
  }
  const listed = files.slice(0, MAX_LISTED_ATTACHMENTS);
  const groups = new Map<UnreadReason, string[]>();
  for (const file of listed) {
    const reason = reasons.get(file) ?? 'unsupported';
    groups.set(reason, [...(groups.get(reason) ?? []), file.name ?? file.title ?? 'an unnamed file']);
  }
  const parts = [...groups].map(([reason, names]) => `${names.join(', ')} (${UNREAD_REASON_TEXT[reason]})`);
  const rest = files.length - listed.length;
  const all = rest > 0 ? `${parts.join('; ')}; and ${rest} more` : parts.join('; ');
  return `\n[Attached, name only: ${all}. You have only the names, so say so rather than guessing at what is in them.]`;
};

/** What Slack calls a file, in a warning about it. */
const fileLabel = (file: SlackInboundFile): string => file.name ?? file.title ?? file.id ?? 'an unnamed file';

/**
 * Slack's scaled copies of an image, largest first. Slack makes these for
 * every image it hosts — a 14 MB, 2600×1800 PNG came back with thumbnails
 * from 64 to 1024 pixels a side, each a PNG under 3 MB — so an image too
 * big for the model still has a copy it can take, with no image library
 * here to make one. Smaller than 360 is too small to read anything in.
 */
const SLACK_PREVIEW_KEYS = ['thumb_1024', 'thumb_960', 'thumb_800', 'thumb_720', 'thumb_480', 'thumb_360'] as const;

/** The largest preview Slack lists for a file, if it lists one. */
const slackPreviewUrl = (file: SlackInboundFile): string | undefined =>
  SLACK_PREVIEW_KEYS.map((key) => file[key]).find((url) => typeof url === 'string' && url.length > 0);

/**
 * What an image's own bytes say it is. A preview's type is not in Slack's
 * metadata — only the original's is — so it is read from the file itself,
 * and anything that is none of the four the API takes is not an image here.
 */
const imageMediaTypeOf = (bytes: Buffer): ImageAttachmentMediaType | undefined => {
  const ascii = (at: number, length: number): string => bytes.subarray(at, at + length).toString('latin1');
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (ascii(0, 4) === 'GIF8') {
    return 'image/gif';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
};

/** An image the model is shown as Slack's preview of it, and why. */
export interface ImagePreview {
  name: string;
  width: number;
  height: number;
  /** Ends "because the original …": what made the original too big. */
  original: string;
}

const MIB = 1024 * 1024;

/**
 * Says which images the model sees scaled down. Without it the agent reads
 * a 1024-pixel preview of a 14 MB screenshot as the screenshot, and states
 * what the small text says when it could only guess at it.
 */
export const previewNote = (previews: readonly ImagePreview[]): string =>
  previews.map((preview) => `\n[${previewSentence(preview)}]`).join('');

/** One preview, said the same way to a turn and to a read of history. */
const previewSentence = ({ name, width, height, original }: ImagePreview): string =>
  `${name} is shown as Slack's ${width}×${height} preview, because the original ${original}. Small text in it may not be legible: ask for a crop rather than guessing at it.`;

/** An image downloaded, checked, and measured. */
interface DownloadedImage {
  body: Buffer;
  mediaType: ImageAttachmentMediaType;
  width: number;
  height: number;
}

/**
 * An image left out, why, and the warning that says so. `oversized` is set
 * only for the per-image limits — the refusal a smaller copy of the same
 * image can get past — with the clause a warning about the preview reuses
 * and what the turn is told made the original too big.
 */
interface RefusedImage {
  reason: UnreadReason;
  warning: string;
  oversized?: { why: string; original: string };
}

/**
 * A message's attachments, sorted into the images the model will be shown
 * and everything else. An image is fetched only when Slack's own metadata
 * says it is one the API accepts and small enough to send; that keeps a
 * 40 MB PNG from being downloaded just to be dropped, and a PDF from being
 * fetched at all. An image over the per-image limits — 5 MB, or 8000
 * pixels a side — is sent as Slack's own largest preview of it instead,
 * when Slack made one, and the turn is told it is a preview. What comes
 * back is checked as well: without `files:read`
 * Slack serves a sign-in page with a 200, and sending that to the model as
 * an image would fail the turn with an error naming nothing the person can
 * fix — the warning here names the scope instead, and the file falls back
 * to the by-name note like any other attachment the turn cannot open.
 */
export const readImageAttachments = async (
  files: readonly SlackInboundFile[],
  botToken: string,
  fetchFile: SlackFileFetcher,
  timeoutMs: number,
  warn: (line: string) => void,
  reasons: UnreadReasons,
  deadline: AbortSignal = AbortSignal.timeout(timeoutMs),
): Promise<{ images: ImageAttachment[]; unread: SlackInboundFile[]; previews: ImagePreview[] }> => {
  // Decided from the last file back, the way the replay window is spent:
  // when a message's images do not all fit, the ones kept are the ones it
  // listed last, so intake and replay agree about which survive. Delivered
  // in the message's own order, because that is how the person sees them.
  const kept = new Map<number, ImageAttachment>();
  const previewed = new Map<number, ImagePreview>();
  const dropped = new Set<number>();
  // Recorded beside the drop, so the note says why and never guesses. A
  // non-image goes on to the text reader with no reason: it decides.
  const drop = (position: number, reason: UnreadReason): void => {
    dropped.add(position);
    reasons.set(files[position]!, reason);
  };
  // Decoded bytes accepted so far. Checked against Slack's reported size
  // before a download and the real length after it, because the message
  // as a whole has a budget the per-image cap alone cannot keep.
  let total = 0;
  // Once an image that fits on its own does not fit what is left of the
  // message's budget, nothing listed before it is taken either: the window
  // is contiguous, as the replay window is, and a smaller older image must
  // not slip in past a larger newer one that was left out.
  let windowClosed = false;
  // Why an image is being left out, or nothing when it fits. One place for
  // both limits so the warning and the fallback cannot disagree. Over the
  // per-image cap, the image can still be sent as Slack's preview; over
  // what is left of the message's budget, it is not sent at all.
  const overLimit = (label: string, bytes: number): RefusedImage | undefined => {
    if (bytes > IMAGE_ATTACHMENT_MAX_BYTES) {
      const why = `${label} is ${bytes} bytes, over the ${IMAGE_ATTACHMENT_MAX_BYTES}-byte limit an image can be sent to the model at`;
      return {
        reason: 'too-large',
        warning: `slack: ${why}; the turn is told it cannot be read.`,
        oversized: { why, original: `is ${(bytes / MIB).toFixed(1)} MB, over the ${IMAGE_ATTACHMENT_MAX_BYTES / MIB} MB a model can be sent` },
      };
    }
    if (total + bytes > IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES) {
      windowClosed = true;
      return { reason: 'too-large', warning: `slack: ${label} would take this message's images past the ${IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES} bytes one request can carry; the turn is told it cannot be read. Send it in a message of its own.` };
    }
    return undefined;
  };
  // One download, checked the same way for an original and for a preview:
  // the image and its size, or why not. `oversized` marks a refusal for the
  // per-image limits alone — the only kind a smaller copy can get past.
  // `mediaType` is Slack's word for an original; a preview's is read from
  // its own bytes, since Slack's metadata describes only the original.
  const download = async (url: string, label: string, mediaType: ImageAttachmentMediaType | undefined): Promise<DownloadedImage | RefusedImage> => {
    // What this image may weigh: the per-image cap, or what is left of the
    // message's budget if that is less. Handed to the fetcher so an
    // oversized response is abandoned mid-body rather than buffered whole.
    const maxBytes = Math.min(IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES - total);
    if (deadline.aborted) {
      return { reason: 'timed-out', warning: `slack: ${label} was not downloaded: this message's downloads had already taken longer than ${timeoutMs}ms. The turn is told it cannot be read.` };
    }
    let fetched: SlackFileDownload;
    try {
      fetched = await fetchFile(url, botToken, deadline, maxBytes);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const cause = timedOut
        ? `this message's downloads took longer than ${timeoutMs}ms`
        : (error instanceof Error ? error.message : String(error));
      return { reason: timedOut ? 'timed-out' : 'failed', warning: `slack: could not download ${label}: ${cause}. The turn is told it cannot be read.` };
    }
    // Refused on what Slack sends when it will not serve the file — a
    // non-200, or a 200 whose body is a page — rather than on the label of
    // what it does serve: a download URL may be typed as the image or as
    // a plain octet stream, and either is the bytes Slack said it was.
    const contentType = fetched.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (fetched.status !== 200 || contentType.startsWith('text/')) {
      return { reason: 'failed', warning: `slack: ${label} came back as ${contentType || 'no content type'} (HTTP ${fetched.status}) rather than an image. This is what a bot token without the files:read scope gets — add the scope under OAuth & Permissions and reinstall the app.` };
    }
    if (fetched.truncated === true) {
      const why = `${label} is larger than the ${maxBytes} bytes this message could still take for an image; the download was abandoned`;
      // Cut off at what was left of the message's budget, rather than at
      // the per-image cap: the same overflow the size check closes the
      // window on, learned from the bytes instead of the metadata.
      if (maxBytes < IMAGE_ATTACHMENT_MAX_BYTES) {
        windowClosed = true;
        return { reason: 'too-large', warning: `slack: ${why} and the turn is told it cannot be read.` };
      }
      return {
        reason: 'too-large',
        warning: `slack: ${why} and the turn is told it cannot be read.`,
        oversized: { why, original: `is over the ${IMAGE_ATTACHMENT_MAX_BYTES / MIB} MB a model can be sent` },
      };
    }
    const tooBig = overLimit(label, fetched.body.length);
    if (tooBig !== undefined) {
      return tooBig;
    }
    // Read from the bytes, not from Slack's metadata: an image the model
    // API refuses fails the turn it arrives on and, once stored, every turn
    // after — so what is stored has to be what the API takes.
    const type = mediaType ?? imageMediaTypeOf(fetched.body);
    const dimensions = type === undefined ? undefined : imageDimensions(fetched.body, type);
    if (type === undefined || dimensions === undefined) {
      return { reason: 'unreadable', warning: `slack: ${label} is not a complete ${type ?? 'image'} — its header or trailer is missing; the turn is told it cannot be read.` };
    }
    if (dimensions.width > IMAGE_ATTACHMENT_MAX_DIMENSION || dimensions.height > IMAGE_ATTACHMENT_MAX_DIMENSION) {
      const why = `${label} is ${dimensions.width}×${dimensions.height}, over the ${IMAGE_ATTACHMENT_MAX_DIMENSION}-pixel side the model can take`;
      return {
        reason: 'too-large',
        warning: `slack: ${why}; the turn is told it cannot be read.`,
        oversized: { why, original: `is ${dimensions.width}×${dimensions.height}, over the ${IMAGE_ATTACHMENT_MAX_DIMENSION} pixels a side a model can be sent` },
      };
    }
    return { body: fetched.body, mediaType: type, ...dimensions };
  };
  for (let position = files.length - 1; position >= 0; position -= 1) {
    const file = files[position]!;
    const url = file.url_private_download ?? file.url_private;
    if (!isImageAttachmentMediaType(file.mimetype)) {
      dropped.add(position);
      continue;
    }
    if (url === undefined) {
      drop(position, 'failed');
      continue;
    }
    if (windowClosed) {
      warn(`slack: ${fileLabel(file)} was not taken: an image listed after it already filled what this message's images can carry; the turn is told it cannot be read.`);
      drop(position, 'too-large');
      continue;
    }
    // Slack's own size is trusted before any bytes move: an original it
    // says is too big is never fetched — only, when that is the per-image
    // cap, its preview.
    let result = (file.size === undefined ? undefined : overLimit(fileLabel(file), file.size))
      ?? await download(url, fileLabel(file), file.mimetype);
    const previewUrl = 'reason' in result && result.oversized !== undefined ? slackPreviewUrl(file) : undefined;
    if ('reason' in result && result.oversized !== undefined && previewUrl !== undefined) {
      const { why, original } = result.oversized;
      const preview = await download(previewUrl, `Slack's preview of ${fileLabel(file)}`, undefined);
      if ('reason' in preview) {
        warn(`slack: ${why}. Slack's smaller preview of it could not be used either: ${preview.warning.replace(/^slack: /, '')}`);
        drop(position, result.reason);
        continue;
      }
      warn(`slack: ${why}; sent Slack's ${preview.width}×${preview.height} preview of it instead, and the turn is told it is a preview.`);
      previewed.set(position, { name: fileLabel(file), width: preview.width, height: preview.height, original });
      result = preview;
    }
    if ('reason' in result) {
      warn(result.warning);
      drop(position, result.reason);
      continue;
    }
    total += result.body.length;
    const name = file.name ?? file.title;
    kept.set(position, {
      mediaType: result.mediaType,
      data: result.body.toString('base64'),
      ...(name !== undefined ? { name } : {}),
    });
  }
  const images: ImageAttachment[] = [];
  const unread: SlackInboundFile[] = [];
  const previews: ImagePreview[] = [];
  files.forEach((file, position) => {
    const image = kept.get(position);
    if (image !== undefined) {
      images.push(image);
      const preview = previewed.get(position);
      if (preview !== undefined) {
        previews.push(preview);
      }
    } else if (dropped.has(position)) {
      unread.push(file);
    }
  });
  return { images, unread, previews };
};

/** A read's byte cap, said in the unit it was most likely set in. */
const readCapLabel = (bytes: number): string => (bytes % MIB === 0 ? `${bytes / MIB} MB` : `${bytes} bytes`);

/**
 * The image cap a read asked for, held to what one request can carry, or
 * undefined when it asked for none: then files come back by name only.
 */
export const historyImageCap = (images: ConversationReadRequest['images']): { count: number; bytes: number } | undefined => {
  if (images === undefined || !Number.isInteger(images.count) || images.count <= 0 || !Number.isFinite(images.bytes) || images.bytes < 1) {
    return undefined;
  }
  return {
    count: Math.min(images.count, IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT),
    bytes: Math.min(Math.floor(images.bytes), IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES),
  };
};

/** What a read is told about an image it tried to fetch and could not show. */
const unshownImageNote = (label: string, reason: UnreadReason | undefined): string => {
  switch (reason) {
    case 'too-large':
      return `${label} is not shown: it is over the ${IMAGE_ATTACHMENT_MAX_BYTES / MIB} MB or ${IMAGE_ATTACHMENT_MAX_DIMENSION} pixels a side a model can be sent, and Slack had no smaller preview of it that could be.`;
    case 'timed-out':
      return `${label} is not shown: it was not downloaded in time.`;
    case 'unreadable':
      return `${label} is not shown: its bytes are not a complete image.`;
    default:
      return `${label} is not shown: it could not be downloaded.`;
  }
};

/**
 * The images on the messages a read returns, fetched for a read that asks
 * (`ConversationReadRequest.images`) and set on each message with a note
 * for every image file it does not show. Each image goes through the same
 * reader a turn's attachments do — Slack's metadata first, the bytes
 * checked, Slack's preview for one over the per-image limits, and only
 * from Slack's own file host — one file at a time, in the order the
 * messages are returned. The read's cap is spent in that order, and once
 * an image does not fit, none after it is taken, so what is shown is one
 * unbroken stretch of the read rather than whichever small ones squeezed
 * in. One deadline covers every download in the read.
 */
export const readHistoryImages = async (
  sources: ReadonlyArray<{ message: ConversationMessage; files: readonly SlackInboundFile[] }>,
  cap: { count: number; bytes: number },
  botToken: string,
  fetchFile: SlackFileFetcher,
  timeoutMs: number,
  warn: (line: string) => void,
): Promise<void> => {
  const deadline = AbortSignal.timeout(timeoutMs);
  const pastBytes = `past this read's cap of ${readCapLabel(cap.bytes)} of images`;
  let count = 0;
  let remaining = cap.bytes;
  let full: string | undefined;
  for (const { message, files } of sources) {
    const images: ImageAttachment[] = [];
    const notes: string[] = [];
    for (const file of files) {
      const label = fileLabel(file);
      if (!isImageAttachmentMediaType(file.mimetype)) {
        if (file.mimetype?.startsWith('image/') === true) {
          notes.push(`${label} is not shown: it is ${file.mimetype}, a kind of image a model cannot be shown.`);
        }
        continue;
      }
      if (full === undefined && count >= cap.count) {
        full = `past this read's cap of ${cap.count} images`;
      }
      // Slack's own size, trusted before any bytes move. An original over
      // the per-image limit may still go as its preview, whose size only
      // its bytes can say.
      if (full === undefined && file.size !== undefined && file.size <= IMAGE_ATTACHMENT_MAX_BYTES && file.size > remaining) {
        full = pastBytes;
      }
      if (full !== undefined) {
        notes.push(`${label} is not shown: ${full}.`);
        continue;
      }
      const reasons: UnreadReasons = new Map();
      const read = await readImageAttachments([file], botToken, fetchFile, timeoutMs, warn, reasons, deadline);
      const image = read.images[0];
      if (image === undefined) {
        notes.push(unshownImageNote(label, reasons.get(file)));
        continue;
      }
      const size = Buffer.byteLength(image.data, 'base64');
      if (size > remaining) {
        full = pastBytes;
        notes.push(`${label} is not shown: ${full}.`);
        continue;
      }
      remaining -= size;
      count += 1;
      images.push(image);
      notes.push(...read.previews.map(previewSentence));
    }
    if (images.length > 0) {
      message.images = images;
    }
    if (notes.length > 0) {
      message.imageNotes = notes;
    }
  }
};

/** The most one text attachment may weigh to be read into the message. */
const TEXT_ATTACHMENT_MAX_BYTES = 100 * 1024;
/**
 * The most one message's text attachments may weigh together. Read text
 * joins the transcript and is sent again on every later turn, so the cap
 * is a cost decision as much as a context one.
 */
const TEXT_ATTACHMENTS_MAX_TOTAL_BYTES = 200 * 1024;
/**
 * The most a text attachment may weigh to be saved to the agent's
 * workspace when it is too large to read into the message. A 251 KB
 * Markdown spec reached an agent as a filename and it had no way to open
 * it; saved, the agent reads it with its file tools, in parts.
 */
const TEXT_ATTACHMENT_SAVE_MAX_BYTES = 10 * 1024 * 1024;
/** The default bound on one agent's saved attachments, all together. */
const SAVED_ATTACHMENTS_MAX_BYTES = 256 * 1024 * 1024;
/**
 * The most saved attachments one agent keeps, whatever they weigh. A file
 * crowded out of a full message is saved however small it is, and each save
 * is a ledger record, so the count is bounded as well as the bytes.
 */
const SAVED_ATTACHMENTS_MAX_FILES = 1_000;
/** Under the agent's workspace, where saved attachments go. */
const SAVED_ATTACHMENTS_DIR = path.join('attachments', 'slack');

/** Saves a downloaded attachment's bytes and answers the path it is at. */
type AttachmentSaver = (file: SlackInboundFile, body: Buffer) => Promise<string>;

/**
 * A file name safe to join under a directory: Slack's name is whatever the
 * uploader's client sent, so separators, `..`, and control characters are
 * replaced rather than trusted. Stamped, so the same file shared twice is
 * two saves rather than a name already taken.
 */
const savedAttachmentName = (file: SlackInboundFile, now: number): string => {
  const base = ((file.name ?? file.title ?? '').split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120);
  const id = (file.id ?? '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 32);
  return [now.toString(36), ...(id.length > 0 ? [id] : []), base.length > 0 ? base : 'attachment'].join('-');
};

/**
 * Refuses a save that would take the directory's regular files past
 * `maxBytes` together, or its entries past `SAVED_ATTACHMENTS_MAX_FILES`. Refused rather than making room: deleting on a
 * Slack member's say is a worse failure than a full directory, and with
 * nothing removed every ledger record still names a file that exists.
 */
const ensureRoom = async (dir: string, incoming: number, maxBytes: number): Promise<void> => {
  let total = 0;
  const names = await readdir(dir);
  for (const name of names) {
    const info = await lstat(path.join(dir, name)).catch(() => undefined);
    total += info?.isFile() ? info.size : 0;
  }
  if (names.length >= SAVED_ATTACHMENTS_MAX_FILES) {
    throw new Error(`${dir} already holds ${SAVED_ATTACHMENTS_MAX_FILES} saved attachments; remove files there to save more`);
  }
  if (total + incoming > maxBytes) {
    throw new Error(`saved attachments in ${dir} would pass their ${maxBytes}-byte bound; remove files there to save more`);
  }
};

/**
 * One save at a time per directory, across messages and sessions: two
 * concurrent saves would each measure the same free space and both write.
 */
const saveChains = new Map<string, Promise<unknown>>();
const serialized = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const previous = saveChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  const settled = next.catch(() => undefined);
  saveChains.set(key, settled);
  void settled.then(() => {
    if (saveChains.get(key) === settled) {
      saveChains.delete(key);
    }
  });
  return next;
};

/**
 * The saver for one agent and one sender. The directory is canonical
 * because the ledger is keyed the way `fs.read` looks a path up, through
 * `realpath`. The path is recorded before the bytes land, so a crash
 * between the two leaves a labelled path with no file, never a file with
 * no label; and the file is created exclusively, so a link planted at the
 * name fails the save rather than carrying the bytes somewhere the ledger
 * never saw.
 */
export const createAttachmentSaver = (
  store: NonNullable<SlackAdapterOptions['attachmentStore']>,
  agentId: string,
  trust: TrustLevel,
  now: () => number,
): AttachmentSaver => async (file, body) => {
  const workspace = store.workspaces.prepare(agentId);
  const lexical = path.join(workspace, SAVED_ATTACHMENTS_DIR);
  // One component at a time, never through a link: a recursive mkdir would
  // follow a link planted at `attachments` and create `slack` wherever it
  // points before the check below could refuse it.
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  let at = workspace;
  for (const part of SAVED_ATTACHMENTS_DIR.split(path.sep)) {
    at = path.join(at, part);
    await mkdir(at, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    const info = await lstat(at);
    if (!info.isDirectory()) {
      throw new Error(`${at} is not a directory of the workspace's own`);
    }
  }
  // The directory must be exactly where the workspace says, through no link
  // of its own: one already planted at `attachments` or `attachments/slack`
  // would put the file outside the workspace, where the agent's file tools
  // cannot read it and nothing should be written on a Slack member's say.
  const dir = await realpath(lexical);
  if (dir !== path.join(await realpath(workspace), SAVED_ATTACHMENTS_DIR)) {
    throw new Error(`${lexical} is a link, not the workspace's own directory`);
  }
  return serialized(dir, async () => {
    await ensureRoom(dir, body.length, store.maxBytes ?? SAVED_ATTACHMENTS_MAX_BYTES);
    const target = path.join(dir, savedAttachmentName(file, now()));
    await store.ledger.recordWrite(agentId, target, trust);
    // O_EXCL and O_NOFOLLOW guard only the last component. A directory on the
    // way swapped for a link after the record would send the create somewhere
    // else, so the open file is checked against the recorded name before a
    // byte is written (the same check as the plugins package's
    // `nameIdentifiesHandle`). A refused save leaves the empty file rather
    // than unlinking through a name that just proved it can move.
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const [canonical, atName, held] = await Promise.all([
        realpath(target).catch(() => undefined),
        lstat(target).catch(() => undefined),
        handle.stat(),
      ]);
      if (canonical !== target || atName === undefined || atName.dev !== held.dev || atName.ino !== held.ino) {
        throw new Error(`${target} moved between its provenance record and its write`);
      }
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    return target;
  });
};

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/x-sh',
  'application/sql',
]);
const TEXT_EXTENSIONS = /\.(md|markdown|txt|text|csv|tsv|json|ya?ml|toml|xml|log|ini|conf)$/i;

/**
 * Whether a file is text the model can be handed as it is. Slack's
 * mimetype comes from the uploader's client and a Markdown file can arrive
 * as `text/markdown`, `text/plain`, or an octet stream, so an unhelpful
 * type falls back to the name. HTML is left out: a sign-in page is HTML
 * too, and a file of it could not be told apart from Slack refusing one.
 */
const isTextAttachment = (file: SlackInboundFile): boolean => {
  const mimetype = file.mimetype?.toLowerCase();
  if (mimetype === 'text/html') {
    return false;
  }
  if (mimetype !== undefined && (mimetype.startsWith('text/') || TEXT_APPLICATION_TYPES.has(mimetype))) {
    return true;
  }
  const name = file.name ?? file.title;
  return (mimetype === undefined || mimetype === 'application/octet-stream') && name !== undefined && TEXT_EXTENSIONS.test(name);
};

/**
 * The text files among a message's attachments, read so the turn gets
 * their contents rather than their names. A Markdown plan attached in a
 * DM reached the agent as a filename, and it told the person it had no
 * way to read Slack at all. Anything that is not UTF-8 text, is over the
 * caps, or comes back as a page stays in `unread` and is named in the
 * note, exactly as before; the warning says why.
 */
export const readTextAttachments = async (
  files: readonly SlackInboundFile[],
  botToken: string,
  fetchFile: SlackFileFetcher,
  timeoutMs: number,
  deadline: AbortSignal,
  warn: (line: string) => void,
  reasons: UnreadReasons,
  save?: AttachmentSaver,
): Promise<{ texts: Array<{ name: string; text: string }>; saved: SavedAttachment[]; unread: SlackInboundFile[] }> => {
  const texts: Array<{ name: string; text: string }> = [];
  const saved: SavedAttachment[] = [];
  const unread: SlackInboundFile[] = [];
  const skip = (file: SlackInboundFile, reason: UnreadReason): void => {
    unread.push(file);
    reasons.set(file, reason);
  };
  let total = 0;
  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!isTextAttachment(file)) {
      // An image the image reader already refused keeps its own reason.
      unread.push(file);
      if (!reasons.has(file)) {
        reasons.set(file, 'unsupported');
      }
      continue;
    }
    if (url === undefined) {
      skip(file, 'failed');
      continue;
    }
    const maxBytes = Math.min(TEXT_ATTACHMENT_MAX_BYTES, TEXT_ATTACHMENTS_MAX_TOTAL_BYTES - total);
    // Over the inline cap, a file is still downloaded when it can be saved
    // to the workspace instead; only over that cap too is it a name.
    const limit = save === undefined ? maxBytes : Math.max(maxBytes, TEXT_ATTACHMENT_SAVE_MAX_BYTES);
    if (file.size !== undefined && file.size > limit) {
      warn(save === undefined
        ? `slack: ${fileLabel(file)} is ${file.size} bytes, over the ${maxBytes} bytes of text this message could still take; the turn is told it cannot be read. Paste the part that matters, or split the file.`
        : `slack: ${fileLabel(file)} is ${file.size} bytes, over the ${limit} bytes a text attachment may be saved at; the turn is told it cannot be read. Paste the part that matters, or split the file.`);
      skip(file, 'too-large');
      continue;
    }
    if (deadline.aborted) {
      warn(`slack: ${fileLabel(file)} was not downloaded: this message's downloads had already taken longer than ${timeoutMs}ms. The turn is told it cannot be read.`);
      skip(file, 'timed-out');
      continue;
    }
    let download: SlackFileDownload;
    try {
      download = await fetchFile(url, botToken, deadline, limit);
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError'
        ? `this message's downloads took longer than ${timeoutMs}ms`
        : (error instanceof Error ? error.message : String(error));
      warn(`slack: could not download ${fileLabel(file)}: ${reason}. The turn is told it cannot be read.`);
      skip(file, error instanceof Error && error.name === 'TimeoutError' ? 'timed-out' : 'failed');
      continue;
    }
    // HTML is never a file read here (see isTextAttachment), so an HTML
    // body is Slack's sign-in page: what a token without files:read gets.
    const contentType = download.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    const head = download.body.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
    if (download.status !== 200 || contentType === 'text/html' || head.startsWith('<!doctype html') || head.startsWith('<html')) {
      warn(`slack: ${fileLabel(file)} came back as ${contentType || 'no content type'} (HTTP ${download.status}) rather than the file. This is what a bot token without the files:read scope gets — add the scope under OAuth & Permissions and reinstall the app.`);
      skip(file, 'failed');
      continue;
    }
    if (download.truncated === true || download.body.length > limit) {
      warn(`slack: ${fileLabel(file)} is larger than the ${limit} bytes ${save === undefined ? 'of text this message could still take' : 'a text attachment may be saved at'}; the download was abandoned and the turn is told it cannot be read.`);
      skip(file, 'too-large');
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(download.body);
    } catch {
      warn(`slack: ${fileLabel(file)} is not UTF-8 text; the turn is told it cannot be read.`);
      skip(file, 'unreadable');
      continue;
    }
    if (download.body.length > maxBytes) {
      // Only reachable with a saver: `limit` is `maxBytes` without one.
      try {
        saved.push({ name: fileLabel(file), path: await save!(file, download.body), bytes: download.body.length });
      } catch (error) {
        warn(`slack: could not save ${fileLabel(file)} to the agent's workspace: ${error instanceof Error ? error.message : String(error)}. The turn is told it cannot be read.`);
        skip(file, 'too-large');
      }
      continue;
    }
    total += download.body.length;
    texts.push({ name: fileLabel(file), text });
  }
  return { texts, saved, unread };
};

/** A text attachment too large for the message, saved for the agent's file tools. */
export interface SavedAttachment {
  name: string;
  path: string;
  bytes: number;
}

/** Saved attachments, named with where each is, after what was said. */
export const savedAttachmentBlocks = (saved: readonly SavedAttachment[]): string =>
  saved.map(({ name, path: at, bytes }) => `\n[Attached: ${name}, ${Math.ceil(bytes / 1024)} KB, too large to include here. It is saved in full at ${at}. Read it with your file tools, in parts if it is long.]`).join('');

/** Read text attachments, set into the message after what was said. */
export const textAttachmentBlocks = (texts: ReadonlyArray<{ name: string; text: string }>): string =>
  texts.map(({ name, text }) => `\n[Attached: ${name}. Its contents follow.]\n${text.replace(/\s+$/, '')}\n[End of ${name}]`).join('');
