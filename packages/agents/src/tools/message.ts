import { createImageCollector, sessionWriteTrust, type ImageAttachment, type JsonObject, type Session, type Tool, type TrustLevel } from '@stratusagent/core';
import {
  type ScheduleDestination,
  canonicalDestination,
  parseDestinationInput,
  DESTINATION_PARAMETER,
} from '../schedules.ts';

export const MESSAGE_SEND_TOOL_NAME = 'message.send';

/**
 * Delivers one outbound message through the agent's channel. The gateway
 * implements it over the channel contract's `resolveOutbound`; rejecting is
 * the way to say a destination cannot be served.
 *
 * Resolves with the channel-native id of the message it posted when the
 * channel reports one (Slack: its `ts`), which is what lets an agent reply
 * under its own post later — the id is the thread to name.
 */
export type OutboundMessenger = (input: {
  agentId: string;
  destination: ScheduleDestination;
  text: string;
  /** Channel-native id of the message to reply under, for a threaded post. */
  thread?: string;
  /**
   * The sending session and the label its words carry, so a channel can
   * let the agent hear its own threaded post in that thread's session.
   */
  speaker?: { sessionId: string; trust: TrustLevel };
}) => Promise<{ id?: string } | void>;

/**
 * The thread a send goes under when the call names none: a scheduled
 * firing's own report thread, when it is sending to its schedule's
 * destination. The host answers, because only it can tell a live firing
 * from a session that merely carries a firing's metadata.
 */
export type DefaultThreadResolver = (session: Session, destination: ScheduleDestination) => string | undefined;

/**
 * Post to a channel or DM outside the current conversation — what makes a
 * scheduled turn observable.
 *
 * `gated`, and deliberately not `safe` the way `agent.delegate` is: the
 * delegate stays inside the fleet, under every per-agent allowlist and the
 * same approval policy, while this speaks to people who did not ask. The
 * unattended path is the schedule carve-out — `destinationFor` names where
 * this call would speak, and the policy allows it exactly when the firing's
 * schedule was approved with that destination.
 */
export const createMessageSendTool = (
  send: OutboundMessenger,
  options: { defaultThread?: DefaultThreadResolver } = {},
): Tool => ({
  name: MESSAGE_SEND_TOOL_NAME,
  description: 'Send a message to a channel or DM you are not currently talking in, at the top level or as a reply in one of its threads. '
    + 'Returns the posted message\'s id, and the thread to name to reply under it: '
    + 'pass that returned thread (never a reply\'s id) to every later send in the same thread. '
    + 'Scheduled turns may post to their schedule\'s approved destination without asking; anywhere else needs approval.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      destination: {
        ...DESTINATION_PARAMETER,
        description: 'Where to post: the channel kind plus the channel-native conversation id.',
      },
      text: { type: 'string', description: 'The message text.' },
      thread: {
        type: 'string',
        description: 'The id of a message in that conversation to reply under (for Slack, its ts, e.g. 1791332967.606559). Omit to post at the top level, or, in a scheduled run sending to its own destination, into the schedule\'s report thread.',
      },
      topLevel: {
        type: 'boolean',
        description: 'Post at the top level even in a scheduled run whose schedule reports into a thread.',
      },
    },
    required: ['destination', 'text'],
  },
  destinationFor(input: JsonObject) {
    const destination = parseDestinationInput(input.destination);
    return destination ? canonicalDestination(destination) : undefined;
  },
  async execute(input: JsonObject, session: Session) {
    const destination = parseDestinationInput(input.destination);
    if (!destination) {
      throw new Error('message.send requires "destination" as { channel, to } with non-empty strings.');
    }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) {
      throw new Error('message.send requires a non-empty "text".');
    }
    if (input.topLevel !== undefined && typeof input.topLevel !== 'boolean') {
      throw new Error('message.send "topLevel" must be true or false.');
    }
    const explicit = optionalId(input, 'thread', MESSAGE_SEND_TOOL_NAME);
    if (explicit !== undefined && input.topLevel === true) {
      throw new Error('message.send takes either "thread" or "topLevel": true, not both.');
    }
    const thread = explicit ?? (input.topLevel === true ? undefined : options.defaultThread?.(session, destination));
    const posted = await send({
      agentId: session.agent.id,
      destination,
      text,
      ...(thread !== undefined ? { thread } : {}),
      speaker: { sessionId: session.id, trust: sessionWriteTrust(session) },
    });
    const id = posted && typeof posted.id === 'string' && posted.id.length > 0 ? posted.id : undefined;
    // The thread a reply to this post names: the root it went under, or,
    // for a top-level post, the post itself. Always the root, because a
    // reply's own id is not a thread to Slack — chaining sends through
    // each reply's id would leave the thread after the second one.
    const root = thread ?? id;
    return {
      sent: true,
      destination: canonicalDestination(destination),
      ...(id !== undefined ? { id } : {}),
      ...(root !== undefined ? { thread: root } : {}),
    };
  },
});

export const MESSAGE_READ_TOOL_NAME = 'message.read';

/** The most messages one `message.read` call returns. */
export const MESSAGE_READ_MAX_LIMIT = 200;
const MESSAGE_READ_DEFAULT_LIMIT = 50;
/**
 * The most a call returns, in characters of the serialized messages: text,
 * names, file names, and ids together. A count alone does not bound a
 * read: fifty long posts can outgrow a model's context, and the result is
 * kept in the transcript and sent on every later turn. A read that reaches
 * it stops at the last whole message that fit and says `more`, so the
 * agent pages on with `before`/`after`.
 */
export const MESSAGE_READ_TEXT_BUDGET = 40_000;
/**
 * The share of `MESSAGE_READ_TEXT_BUDGET` a channel's bookmarks may take,
 * counted first. It holds Slack's limit of 100 at a typical length; what
 * it exists to stop is the people in a channel filling the agent's context
 * with bookmarks. The ones that do not fit are counted, not paged: Slack
 * lists them all in one call.
 */
export const MESSAGE_READ_BOOKMARK_BUDGET = 16_000;
const TRUNCATED_MARK = ' [... the rest of this message is not shown]';
/**
 * The most images one read shows the model. They are kept in the session
 * and replayed on later turns inside the replay window, so a read of a
 * busy channel must not fill that window with screenshots it was not
 * asked about; the agent reads a narrower window to see more.
 */
export const MESSAGE_READ_MAX_IMAGES = 5;
/** The most decoded image bytes one read shows the model, together. */
export const MESSAGE_READ_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Reads one conversation, or one thread in it, through the agent's own
 * channel app. The gateway implements it over the channel contract's
 * `readConversation`, structurally mirrored here the way `OutboundMessenger`
 * mirrors `resolveOutbound`; rejecting is how a channel says it will not.
 */
export type ConversationReader = (input: {
  agentId: string;
  /** The session reading: a direct message is readable only from its own. */
  sessionId: string;
  source: ScheduleDestination;
  thread?: string;
  after?: string;
  before?: string;
  limit: number;
  /**
   * Fetch the messages' images, up to this many and this many bytes for
   * the whole read; absent, files come back by name only.
   */
  images?: { count: number; bytes: number };
}) => Promise<{
  messages: Array<{
    id: string;
    author: string;
    authorName?: string;
    text: string;
    at?: string;
    thread?: string;
    replies?: number;
    files?: string[];
    images?: ImageAttachment[];
    imageNotes?: string[];
  }>;
  more: boolean;
  bookmarks?: Array<{ title: string; link: string }>;
  bookmarksUnavailable?: string;
  bookmarksOmitted?: number;
}>;

const optionalId = (input: JsonObject, key: string, tool = MESSAGE_READ_TOOL_NAME): string | undefined => {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${tool}: "${key}" must be a non-empty string when given.`);
  }
  return value.trim();
};

/**
 * Read a conversation's recent messages, or one thread — so an agent can
 * catch up on a channel it was not mentioned in.
 *
 * `gated`, like `message.send`: what a channel says is the people in it's,
 * and an agent talking somewhere else would carry it there. Judged by its
 * source (`destinationFor`) for the same reason as a send: a durable
 * per-tool grant would be a standing yes to every conversation the app is
 * in, which anyone who can talk to the agent could then have it quote
 * anywhere. So **Always allow** grants reading this one conversation,
 * until revoked, and a schedule approved with a destination may read that
 * one conversation unattended. The channel's own rule decides which conversations are
 * readable at all. Output is `external`: the messages are written by
 * whoever is in the conversation, not by the operator.
 */
/**
 * Why a read of this conversation can never run, asked before anyone is
 * asked to approve it. The gateway answers from the channel: a direct
 * message, which no channel reads from outside it. Undefined when it is
 * readable or the channel cannot say, and then the read asks as before.
 */
export type ConversationReadRefusal = (input: { agentId: string; sessionId: string; source: ScheduleDestination }) => Promise<string | undefined>;

/** The refusal a direct-message read gets, before any approval prompt. */
export const directMessageReadRefusal = (destination: string): string =>
  `message.read cannot read ${destination}: it is a direct message this conversation is not in, and a direct message is read only from inside it. `
  + 'This is not a permission, so approval cannot unlock it; do not ask for one or try again. '
  + 'Read a channel instead, or ask the person to paste what you need.';

/** One message as `message.read` returns it: text, and the names of the images it shows. */
type ShownMessage = Omit<Awaited<ReturnType<ConversationReader>>['messages'][number], 'images'> & { shownImages?: string[] };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Decides, message by message in the order they are listed, which of their
 * images a read shows, before any message is measured, so the text sent is
 * the text measured: the names shown and every note about the rest are in
 * it. Held to the read's own cap whatever the channel returned, since the
 * images stay in the session and replay on later turns. Once one does not
 * fit, none after it is shown either, so what the agent sees is one
 * unbroken stretch of the read. Each image is put through core's own image
 * check, the one the runner's `attachImage` applies, so an image that
 * would be refused is said here rather than after the budget is spent.
 */
const createImagePlan = () => {
  const check = createImageCollector();
  let count = 0;
  let bytes = 0;
  let full: string | undefined;
  return (images: readonly ImageAttachment[]): { shown: Array<{ image: ImageAttachment; name: string }>; notes: string[] } => {
    const shown: Array<{ image: ImageAttachment; name: string }> = [];
    const notes: string[] = [];
    images.forEach((image, index) => {
      const name = image.name ?? `image ${index + 1}`;
      const size = Buffer.byteLength(image.data, 'base64');
      if (full === undefined && count >= MESSAGE_READ_MAX_IMAGES) {
        full = `past this read's cap of ${MESSAGE_READ_MAX_IMAGES} images`;
      } else if (full === undefined && bytes + size > MESSAGE_READ_IMAGE_BYTES) {
        full = `past this read's cap of ${MESSAGE_READ_IMAGE_BYTES / (1024 * 1024)} MB of images`;
      }
      if (full !== undefined) {
        notes.push(`${name} is not shown: ${full}.`);
        return;
      }
      try {
        check.attach(image);
      } catch (error) {
        notes.push(`${name} is not shown: ${errorText(error)}`);
        return;
      }
      count += 1;
      bytes += size;
      shown.push({ image, name });
    });
    return { shown, notes };
  };
};

/**
 * The most a cut message's image notes may take: a message too big for
 * the whole budget keeps its notes only up to this, and counts the rest,
 * as it does its file list.
 */
const CUT_IMAGE_NOTES_BUDGET = 4_000;

const boundedNotes = (notes: readonly string[]): string[] => {
  const kept: string[] = [];
  let size = 2;
  for (const note of notes) {
    const length = JSON.stringify(note).length + 1;
    if (size + length > CUT_IMAGE_NOTES_BUDGET) {
      break;
    }
    kept.push(note);
    size += length;
  }
  return kept.length === notes.length ? [...notes] : [...kept, `${notes.length - kept.length} more notes about images, not listed`];
};

export const createMessageReadTool = (
  read: ConversationReader,
  options: { refusalFor?: ConversationReadRefusal } = {},
): Tool => ({
  name: MESSAGE_READ_TOOL_NAME,
  description: 'Read recent messages in a channel your app is a member of, or one thread in it. '
    + 'Direct messages and group DMs cannot be read with this, except the one this conversation is in, and approval does not change that. '
    + 'Without thread: the top level, newest first. With thread: that thread\'s root and replies, oldest first. '
    + 'For Slack, ids are channel ids and message ts values; a permalink '
    + '…/archives/C0123456789/p1791332967606559 is channel C0123456789 and message 1791332967.606559, '
    + 'and a thread_ts in the link is the thread to read. '
    + 'When more is true, page on with before (top level) or after (thread) set to the last id returned. '
    + 'A top-level read without before or after also returns the channel\'s bookmarks, when it has any; '
    + 'if bookmarksOmitted is set, say that many were left out rather than guess them. '
    + `Images on the messages read are shown to you after this result, at most ${MESSAGE_READ_MAX_IMAGES} per read, `
    + 'in the order the messages list them in shownImages; imageNotes says why any other image on a message was not shown, '
    + 'so never describe an image you were not shown. To see images past the cap, read fewer messages.',
  risk: 'gated',
  outputTrust: 'external',
  parameters: {
    type: 'object',
    properties: {
      source: {
        ...DESTINATION_PARAMETER,
        description: 'The conversation to read: the channel kind plus the channel-native conversation id.',
      },
      thread: { type: 'string', description: 'The root message id of a thread to read instead of the top level.' },
      after: { type: 'string', description: 'Only messages after this message id, exclusive.' },
      before: { type: 'string', description: 'Only messages before this message id, exclusive.' },
      limit: { type: 'integer', description: `How many messages, ${MESSAGE_READ_DEFAULT_LIMIT} by default, at most ${MESSAGE_READ_MAX_LIMIT}.` },
    },
    required: ['source'],
  },
  destinationFor(input: JsonObject) {
    const source = parseDestinationInput(input.source);
    return source ? canonicalDestination(source) : undefined;
  },
  ...(options.refusalFor !== undefined
    ? {
        async refusalFor(input: JsonObject, session: Session) {
          const source = parseDestinationInput(input.source);
          return source ? options.refusalFor?.({ agentId: session.agent.id, sessionId: session.id, source }) : undefined;
        },
      }
    : {}),
  async execute(input: JsonObject, session: Session, context) {
    const source = parseDestinationInput(input.source);
    if (!source) {
      throw new Error('message.read requires "source" as { channel, to } with non-empty strings.');
    }
    // Images are asked for only when this host can show the model one; a
    // host that cannot gets names, as every read did before images.
    const attachImage = context?.attachImage;
    const thread = optionalId(input, 'thread');
    const after = optionalId(input, 'after');
    const before = optionalId(input, 'before');
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MESSAGE_READ_MAX_LIMIT)
      : MESSAGE_READ_DEFAULT_LIMIT;
    const result = await read({
      agentId: session.agent.id,
      sessionId: session.id,
      source,
      limit,
      ...(thread !== undefined ? { thread } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(attachImage !== undefined ? { images: { count: MESSAGE_READ_MAX_IMAGES, bytes: MESSAGE_READ_IMAGE_BYTES } } : {}),
    });
    // Bookmarks first, from their own share, in the channel's order.
    const bookmarks: Array<{ title: string; link: string }> = [];
    let used = 0;
    for (const bookmark of result.bookmarks ?? []) {
      // Counted as the list is serialized: each entry with its separator,
      // plus the closing bracket.
      const size = JSON.stringify(bookmark).length + 1;
      if (used + size + 1 > MESSAGE_READ_BOOKMARK_BUDGET) {
        break;
      }
      bookmarks.push({ title: bookmark.title, link: bookmark.link });
      used += size;
    }
    if (bookmarks.length > 0) {
      used += 1;
    }
    // Added to what the adapter itself already left out, if it said.
    const upstreamOmitted = typeof result.bookmarksOmitted === 'number' && Number.isInteger(result.bookmarksOmitted) && result.bookmarksOmitted > 0
      ? result.bookmarksOmitted
      : 0;
    const bookmarksOmitted = upstreamOmitted + (result.bookmarks?.length ?? 0) - bookmarks.length;
    const messages: ShownMessage[] = [];
    // Each kept message's images, held beside it rather than in it: the
    // budget is text, and the pixels never join the result's text.
    const pending: Array<{ message: ShownMessage; shown: Array<{ image: ImageAttachment; name: string }> }> = [];
    const plan = attachImage !== undefined ? createImagePlan() : undefined;
    let more = result.more;
    for (const read of result.messages) {
      const { images, imageNotes, ...rest } = read;
      const decided = plan !== undefined && images !== undefined && images.length > 0 ? plan(images) : undefined;
      const notes = [...(imageNotes ?? []), ...(decided?.notes ?? [])];
      // Measured as it is sent: the names of the images it shows, and the
      // notes on the rest, are text; their bytes are not.
      const message: ShownMessage = {
        ...rest,
        ...(decided !== undefined && decided.shown.length > 0 ? { shownImages: decided.shown.map(({ name }) => name) } : {}),
        ...(notes.length > 0 ? { imageNotes: notes } : {}),
      };
      const size = JSON.stringify(message).length;
      if (used + size <= MESSAGE_READ_TEXT_BUDGET) {
        messages.push(message);
        if (decided !== undefined && decided.shown.length > 0) {
          pending.push({ message, shown: decided.shown });
        }
        used += size;
        continue;
      }
      // One message bigger than the whole budget is cut rather than
      // dropped, or the read could never get past it. Its file list goes
      // too, said by count, and its image notes are kept only up to their
      // own share, since either can be as long as any text. One that
      // would fit on its own, crowded out only by the bookmarks ahead of
      // it, loses about what they took rather than half.
      if (messages.length === 0) {
        const { files, imageNotes: allNotes, ...unlisted } = message;
        const kept = allNotes !== undefined ? boundedNotes(allNotes) : undefined;
        const cutTo = (keep: number): ShownMessage => ({
          ...unlisted,
          text: message.text.slice(0, Math.max(0, keep)) + TRUNCATED_MARK,
          ...(files && files.length > 0 ? { files: [`${files.length} files, not listed`] } : {}),
          ...(kept !== undefined ? { imageNotes: kept } : {}),
        });
        // The longest cut that fits, measured as serialized, since escapes
        // make the text longer and may sit anywhere in it: up to the whole
        // text for one only the bookmarks crowded out, otherwise half.
        const room = MESSAGE_READ_TEXT_BUDGET - used;
        const fits = (keep: number) => JSON.stringify(cutTo(keep)).length <= room;
        const ceiling = used > 0 && size <= MESSAGE_READ_TEXT_BUDGET ? message.text.length : MESSAGE_READ_TEXT_BUDGET / 2;
        let low = 0;
        if (fits(ceiling)) {
          low = ceiling;
        } else if (fits(0)) {
          let high = ceiling;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(middle)) {
              low = middle;
            } else {
              high = middle - 1;
            }
          }
        }
        const cut = cutTo(low);
        messages.push(cut);
        if (decided !== undefined && decided.shown.length > 0) {
          pending.push({ message: cut, shown: decided.shown });
        }
        used += JSON.stringify(cut).length;
      }
      more = true;
      break;
    }
    // Shown only now, once every message that carries one is kept. Core's
    // own check already passed each of them; a host whose attachImage has
    // rules of its own can still refuse one, and then the image leaves
    // shownImages, and why is said only where it fits what is left of the
    // budget.
    if (attachImage !== undefined) {
      for (const { message, shown } of pending) {
        const names: string[] = [];
        const refusals: string[] = [];
        for (const { image, name } of shown) {
          try {
            attachImage(image);
            names.push(name);
          } catch (error) {
            refusals.push(`${name} is not shown: ${errorText(error)}`);
          }
        }
        if (refusals.length === 0) {
          continue;
        }
        let before = JSON.stringify(message).length;
        if (names.length > 0) {
          message.shownImages = names;
        } else {
          delete message.shownImages;
        }
        used += JSON.stringify(message).length - before;
        for (const refusal of refusals) {
          before = JSON.stringify(message).length;
          message.imageNotes = [...(message.imageNotes ?? []), refusal];
          const grown = JSON.stringify(message).length - before;
          if (used + grown > MESSAGE_READ_TEXT_BUDGET) {
            message.imageNotes = message.imageNotes.slice(0, -1);
            if (message.imageNotes.length === 0) {
              delete message.imageNotes;
            }
            break;
          }
          used += grown;
        }
      }
    }
    return {
      source: canonicalDestination(source),
      ...(thread !== undefined ? { thread } : {}),
      count: messages.length,
      more,
      ...(bookmarks.length > 0 ? { bookmarks } : {}),
      ...(bookmarksOmitted > 0 ? { bookmarksOmitted } : {}),
      ...(result.bookmarksUnavailable !== undefined ? { bookmarksUnavailable: result.bookmarksUnavailable } : {}),
      messages,
    } as JsonObject;
  },
});
