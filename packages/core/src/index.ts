import {
  type CredentialDelivery,
  type CredentialResolver,
  type CredentialScope,
} from './credentials.ts';

import {
  type ModelProvider,
  type ProviderCallGuard,
  type ProviderDelta,
  type ProviderPart,
  type UsageRecord,
} from './providers.ts';

import {
  type ApprovalVerdict,
  type ExecutionContext,
  type Executor,
  isTrustLevel,
  leastTrusted,
  PENDING_APPROVAL_METADATA_KEY,
  type PendingApprovalRecord,
  resolveToolRisk,
  type Tool,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
  type ToolRisk,
  type TrustLevel,
} from './tools.ts';

import {
  type AgentMemoryStore,
  type MemoryPassHandle,
  type MemoryPassKind,
  type MemoryPassMode,
  type MemoryPassReason,
  type MemoryPassStatus,
} from './memory.ts';

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/**
 * `pending_approval` is a turn parked on a human, and it is durable on
 * purpose: it is the index a restarting daemon uses to find the turns it
 * owes an answer. Everything else about the turn is already in the
 * session; this is what makes it findable without reading every row.
 */
export type SessionStatus = 'idle' | 'running' | 'pending_approval' | 'completed' | 'failed';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

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

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  name?: string;
  createdAt: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
  /**
   * Images sent with a user message, or returned by a tool call (moved
   * here off `ToolResult.images` as the result is recorded). Present only
   * on `user` and `tool` messages that carried one; a provider that can
   * show the model an image sends these alongside the text, and one that
   * cannot names them instead.
   */
  images?: ImageAttachment[];
  /**
   * A user message the agent was not spoken to by: something said in a
   * conversation it is in, to somebody else — appended by `observe` with
   * no turn run on it, or dispatched with `addressed: false`, which runs a
   * turn the agent may answer with nothing. Present only when true.
   *
   * Durable, because it changes how the message is rendered on every later
   * turn, not just the next one: every renderer passes user content through
   * `promptTextOf`, which frames an overheard message as third-party speech
   * so a stranger's words never read as something the agent was told to do
   * — the boundary provenance draws, here at the point text enters.
   */
  overheard?: boolean;
  /**
   * A user message said to the agent that may need no answer: a
   * teammate agent's tagged report, a person's untagged follow-up in a
   * thread the agent holds (card 601). Dispatched with
   * `RunInput.replyOptional`; never set beside `overheard`, which already
   * lets a turn end in silence. Rendered as said, followed on the newest
   * message by `REPLY_OPTIONAL_NOTE`. Present only when true; an older
   * build reads past it, and the message is then one that was answered.
   */
  replyOptional?: boolean;
  /**
   * Appended by `observe`, so it started no turn. `overheard` alone cannot
   * say so: a turn dispatched with `addressed: false` is overheard too, and
   * is a turn. Present only when true; a message observed before this was
   * recorded reads as a turn, which errs toward attributing nothing to an
   * earlier one (`isLatestTurn`).
   */
  observed?: boolean;
  /**
   * The caller's idempotency key for the dispatch that brought this user
   * message (`RunInput.idempotencyKey`). Written in the same save as the
   * message, so a key is never durable without its message or the other
   * way round; `workItemState` reads it back.
   */
  idempotencyKey?: string;
  /**
   * The keys of dispatches folded into this message's turn: messages that
   * queued behind a running turn and are answered together with this one,
   * in one user message (card 423). Every key reader matches these as it
   * matches `idempotencyKey` (`carriesKey`), so a repeat of an absorbed
   * dispatch is the merged turn, never a second one. Present only when
   * something was absorbed. A turn that took a message at a tool step
   * (`steered`) adds that dispatch's keys here too, in the save that
   * appends it.
   */
  absorbedKeys?: string[];
  /**
   * A user message that reached a turn already running, at its next tool
   * step (card 948): somebody wrote while the agent worked, and it read
   * that before its next call instead of after its whole turn. It starts
   * no turn. Its dispatches' keys are on the message the turn started on
   * (`absorbedKeys`), so every key reader finds the turn they joined, and
   * every reader of "the turn's message" passes over it
   * (`turnMessageOf`). Present only when true.
   */
  steered?: boolean;
  /**
   * Why the turn this user message started failed, written by
   * `recordTurnFailure` in the save that fails it. The session's
   * `lastError` is the latest turn's and the next turn replaces it; this
   * stays, so `turnFailureFor` can answer for any turn a key names.
   */
  turnError?: string;
  /**
   * This message's turn was continued once after the process running it
   * died (`AgentRunner.continueTurn`). A host fails a second such turn
   * instead of continuing it again: a turn that takes the process down
   * with it would otherwise do so on every start. Present only when true.
   */
  continuedAfterCrash?: boolean;
  /**
   * The turn this message started could reach a provider that runs its own
   * tool loop (a harness): what that turn did is not all in this
   * transcript, so a crash mid-turn cannot be continued from it. Recorded
   * at accept time, because the runtime a crashed turn ran on is not the
   * one a restart resolves if the configuration changed in between.
   * Present only when true; see `RunInput.hostedLoop`.
   */
  hostedLoop?: boolean;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  instructions?: string;
}

export interface AvatarTheme {
  seed: string;
  hue: number;
  palette: string[];
  style: string;
}

/**
 * A full agent identity. An agent is one "person": the same definition —
 * memory, tool access, credentials — applies no matter which channel,
 * thread, or session the agent is talking through.
 */
export interface AgentDefinition extends AgentDescriptor {
  avatar?: AvatarTheme;
  /**
   * What this agent may call: exact tool names (`fs.read`), toolset globs
   * (`fs.*`), or `*` for every registered tool. Omitted = only the tools
   * registered at risk `safe` (reads and memory), or every tool where the
   * host passes `unlistedTools: 'every'`; see `toolPermitted` in the runner. `matchesToolAllowlist` is the only reading of the entries.
   */
  tools?: string[];
  /**
   * Skills this agent may load: exact ids (`code-review`), a package's
   * qualified ids (`stratus-plugin-github:*`), or `*`. Omitted = none,
   * matching `credentials` rather than `tools` — a skill silently changing
   * how an agent behaves is worse than an agent that has to be told. See
   * `matchesSkillAllowlist`, which is the only reading of these entries.
   */
  skills?: string[];
  /** Credential names this agent may resolve. Omitted = none. */
  credentials?: string[];
  /**
   * Agent ids this agent may delegate to through `agent.delegate`, or `*`
   * for any agent on the roster. Omitted = none, matching `credentials`
   * rather than `tools`: delegation runs a turn as another agent, under
   * that agent's tools, credentials, and memory, so it is the lateral
   * move a prompt-injected agent would take — and `agent.delegate` is
   * `safe`, so nothing else asks. Checked by the delegate tool against the
   * session's agent, the way the tool allowlist is.
   */
  delegates?: string[];
  /**
   * How this agent listens in a conversation it shares with people talking
   * to each other — see `ListensMode`. Omitted = `thread`. Part of what an
   * agent is rather than how a daemon is deployed, which is why it sits
   * beside `tools` and `skills` and not in a channel's config block.
   */
  listens?: ListensMode;
}

/**
 * When an agent in a thread answers a message that did not name it.
 *
 * - `mentions`: only when named. The behavior before thread follow-through,
 *   kept because some agents should be exactly this.
 * - `thread`: every untagged reply in a thread it is in, by the rule people
 *   use — the voice that just answered you is the one you are answering.
 *   Cheap and predictable, and right for a thread with one person in it.
 * - `judge`: overhear everything, and while attentive — a bounded window
 *   after it last spoke — run a turn nobody asked for on each message and
 *   let the model decide whether it has anything to add. Outside the
 *   window a message is overheard for free. Every message the agent does
 *   not answer is heard in every mode; the modes differ only in what it
 *   answers.
 */
export type ListensMode = 'mentions' | 'thread' | 'judge';
export const LISTENS_MODES: readonly ListensMode[] = ['mentions', 'thread', 'judge'];
export const isListensMode = (value: unknown): value is ListensMode =>
  typeof value === 'string' && (LISTENS_MODES as readonly string[]).includes(value);

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();

  /**
   * `*` in a `delegates` list means any agent on the roster, so an agent
   * with that id could never be granted alone — `delegates: ['*']` would
   * open the whole roster to reach it. The soul loader refuses the id;
   * this refuses it for a definition built in code, since the wildcard's
   * meaning is decided here, where the roster lives, and not by which
   * path put the agent on it.
   */
  register(agent: AgentDefinition): AgentDefinition {
    if (agent.id === '*') {
      throw new Error(
        'Invalid agent id: "*". * is the delegates wildcard (delegates: [\'*\'] means any agent on the roster), '
        + 'so no agent may have it as an id — give this agent another id.',
      );
    }
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  /**
   * Look up an agent by display name. Names are not required to be unique
   * (ids are), so an ambiguous name throws rather than silently picking one
   * — routing work to the wrong identity would cross memory and access
   * scopes.
   */
  getByName(name: string): AgentDefinition | undefined {
    const matches = this.list().filter((agent) => agent.name === name);
    if (matches.length > 1) {
      throw new Error(
        `Agent name is ambiguous: ${name} (ids: ${matches.map((agent) => agent.id).join(', ')}). Use the id instead.`,
      );
    }
    return matches[0];
  }

  /**
   * Forget an agent, reporting whether one was registered under that id.
   *
   * A roster reload has to be able to *remove*. Re-registering the survivors
   * over a map nothing ever deletes from leaves an agent whose soul file was
   * deleted addressable — by id, and from every channel — for the rest of the
   * daemon's life.
   */
  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  require(id: string): AgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }
    return agent;
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

export interface Session {
  id: string;
  /**
   * The full definition, not just the descriptor: an agent's tool allowlist
   * travels with its session, so a runner can enforce it for an agent that
   * was never registered. Typed as a descriptor, this was read through a
   * cast — the type said the allowlist could not be here while the runner
   * depended on it being here.
   */
  agent: AgentDefinition;
  status: SessionStatus;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
  lastError?: string;
  /**
   * What this conversation has consumed, one record per provider call, in the
   * order the calls completed. Absent until something reports.
   *
   * Durable state like the messages: it round-trips through the session
   * store, so a past session's usage survives a restart and a resumed session
   * *adds* to what it already had rather than starting over. The stored form
   * is the records — a total is derived by whoever wants one
   * (`totalTokenUsage`), never written here.
   */
  usage?: UsageRecord[];
  /**
   * Set when the latest message ended early: it used its step budget (and
   * any auto-continue grants) or kept repeating one failure, and the turn
   * that answered was the wrap-up (`TURN_LIMIT_NOTE`). The session still
   * ends `completed`, because the wrap-up did answer; this is what tells
   * that run apart from one that finished its work.
   *
   * Cleared when the next message in the session starts. A reason and
   * counts only, never content: the summary is the turn's reply.
   */
  stoppedEarly?: SessionStoppedEarly;
}

/** Why a message ended in a wrap-up instead of finishing. */
export type StoppedEarlyReason = 'turn-limit' | 'repeated-failure';

/** See `Session.stoppedEarly`. */
export interface SessionStoppedEarly {
  reason: StoppedEarlyReason;
  /** Auto-continue grants the message had used when it stopped. */
  continuations: number;
  /** When the wrap-up answered. */
  at: string;
}

const STOPPED_EARLY_REASONS: readonly StoppedEarlyReason[] = ['turn-limit', 'repeated-failure'];

/**
 * Whether a value is a reason core knows. A provider is a plugin, and its
 * `ProviderResponse.stoppedEarly` reaches the runner untyped at runtime.
 */
export const isStoppedEarlyReason = (value: unknown): value is StoppedEarlyReason =>
  typeof value === 'string' && (STOPPED_EARLY_REASONS as readonly string[]).includes(value);

/** Reads the checkpoint off a session, if it is parked. */
export const readPendingApproval = (session: Session): PendingApprovalRecord | undefined => {
  const raw = session.metadata?.[PENDING_APPROVAL_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as unknown as PendingApprovalRecord;
  const isCall = (value: unknown): value is ToolCall =>
    typeof value === 'object' && value !== null
    && typeof (value as ToolCall).id === 'string'
    && typeof (value as ToolCall).toolName === 'string';

  if (!isCall(record.call)) {
    return undefined;
  }
  return {
    call: record.call,
    remaining: Array.isArray(record.remaining) ? record.remaining.filter(isCall) : [],
    // A record written before this field existed resumes at 1, which is
    // the old behaviour and never *more* permissive than a fresh turn.
    turn: typeof record.turn === 'number' && Number.isFinite(record.turn) ? record.turn : 1,
    parkedAt: typeof record.parkedAt === 'string' ? record.parkedAt : '',
  };
};

/**
 * What a human decided about one gated call.
 *
 * - `once` — run this call, ask again next time.
 * - `always` — run it, and stop asking this agent's future calls that
 *   the answer covers. What it covers is the policy's to say, in advance,
 *   through `AlwaysMeans`.
 * - `deny` — refuse it.
 */
export type ApprovalAnswer = 'once' | 'always' | 'deny';

/**
 * What answering `always` to one request would remember, said before
 * anyone is asked so every surface can word the button honestly.
 *
 * - `scope` — the command's normalized scope, durable and per agent
 *   (`Tool.commandFor`).
 * - `origin` — the site the conversation is on, durable and per agent
 *   (`Tool.originFor`).
 * - `tool` — the tool itself, durable and per agent, until an operator
 *   revokes it: the standing grant, for a gated tool that names no scope.
 * - `destination` — this tool on this one conversation (`Tool.destinationFor`),
 *   durable and per agent, until revoked. Never the tool on every
 *   conversation: that would be a standing yes to every channel the app
 *   is in.
 * - `session` — the tool, for this session and this process only. What a
 *   call judged by destination gets when its input names no destination.
 *
 * Absent when `always` remembers nothing at all — the one-shot case,
 * which `oneShot` names.
 */
export type AlwaysMeans = 'scope' | 'origin' | 'tool' | 'destination' | 'session';

/**
 * A human's answer, and who gave it when a channel can say. What a
 * transport settles a request with: the policy records the actor on a
 * standing grant, and nothing else about the decision needs a person's
 * id — which is why the plain answer is still accepted everywhere an
 * outcome is.
 */
export interface ApprovalOutcome {
  answer: ApprovalAnswer;
  /** Channel-native id (a Slack user). */
  actor?: string;
}

/**
 * Why an approval request stopped being pending. Only `decided` involved a
 * person; the rest are the request running out of patience, the turn it
 * belonged to disappearing, or nobody ever being asked at all.
 *
 * The distinction is not cosmetic. `decided` is what an audit record means
 * by "somebody refused this", and folding an undelivered request into it
 * would put a denial nobody made on the same footing as one somebody did.
 */
/**
 * The conversation a delegated call's work was asked from — see
 * `tool.approval-requested`'s `delegatedFrom`.
 */
export interface ApprovalDelegationOrigin {
  /** The agent whose session is at the root of the delegation chain. */
  agentId: string;
  sessionId: string;
  /** That session's metadata: where the person who asked is. */
  metadata?: JsonObject;
}

/** A schedule's approved destination, as an approval request carries it. */
export interface ApprovalScheduleDestination {
  /** Channel kind, e.g. 'slack': only that channel may ask there. */
  channel: string;
  /** Channel-native conversation id. */
  to: string;
  /** The thread the schedule reports under, when it was set to one. */
  thread?: string;
}

export type ApprovalResolutionReason = 'decided' | 'timeout' | 'cancelled' | 'undeliverable';

export type StratusEvent =
  | { type: 'session.created'; sessionId: string; agentId: string }
  | { type: 'session.updated'; sessionId: string; status: SessionStatus }
  /**
   * A message entered the session without a turn — `AgentRunner.observe`.
   * Its own event rather than a `session.updated`, because a renderer that
   * takes `running` as "a reply is coming" would open a placeholder for a
   * turn that never speaks. By name only, like everything the log keeps.
   */
  | { type: 'session.observed'; sessionId: string; agentId: string }
  | { type: 'provider.delta'; sessionId: string; delta: ProviderDelta }
  | { type: 'provider.response'; sessionId: string; parts: ProviderPart[] }
  | { type: 'tool.called'; sessionId: string; call: ToolCall }
  | { type: 'tool.completed'; sessionId: string; result: ToolResult }
  | { type: 'tool.denied'; sessionId: string; call: ToolCall }
  /**
   * Why a call was allowed or refused, when the approval policy reports it
   * (`ApprovalContext.decided`). By name, like the log: the call's id and
   * tool, never its input, so a surface can show the decision beside the
   * `tool.called` or `tool.denied` with the same `callId`. A call judged
   * again can have several; the last stands. The runner sends one itself,
   * layer `trust`, when it refuses a call whose label dropped twice while
   * it was being approved.
   */
  | {
      type: 'permission.decided';
      sessionId: string;
      agentId: string;
      callId: string;
      toolName: string;
      risk: ToolRisk;
      allowed: boolean;
      layer: string;
      reason: string;
      verdict?: ApprovalVerdict;
      reviewCode?: string;
      shadow?: boolean;
    }
  /**
   * A gated call is parked, waiting for a human somewhere else. Channels
   * render it (Slack buttons) and resolve it through the gateway; nothing
   * about the request is channel-specific, so the dashboard consumes the
   * same event.
   *
   * `metadata` is the session's, carried because it says where the turn is
   * happening — a channel that renders the request into the conversation it
   * came from needs that without reaching into the store.
   */
  | {
      type: 'tool.approval-requested';
      sessionId: string;
      agentId: string;
      /** Opaque id the decision is quoted back with. */
      requestId: string;
      call: ToolCall;
      risk: ToolRisk;
      /**
       * The origin this call would act on, for a tool judged by one
       * (`Tool.originFor`). Carried because the call's own arguments do not
       * say: a renderer showing `browser.act` with `{"selector":"#submit"}`
       * and an **Always allow** button would be asking somebody to widen a
       * site they were never shown.
       */
      origin?: string;
      /**
       * True when answering `always` runs this call once and remembers
       * nothing. A renderer must not offer an unconditional "always" for
       * one of these — the button would promise a standing grant the engine
       * will not create. See `Tool.originFor` and `ToolRisk`.
       */
      oneShot?: boolean;
      /**
       * What `always` would remember, when it would remember something —
       * see `AlwaysMeans`. A renderer that reports the outcome of an
       * `always` reads this rather than guessing at a lifetime: a grant
       * that survives restarts and one that dies with the session are the
       * same button, and only the request knows which it is.
       */
      always?: AlwaysMeans;
      metadata?: JsonObject;
      /**
       * Where the work was asked for, when this call is in a delegated
       * sub-session (`agent.delegate`): the agent and session at the root of
       * the chain, and that session's metadata. A sub-session has no
       * conversation of its own and its agent may have no channel at all,
       * so a renderer that asks in the conversation it came from asks here.
       * Set by the gateway from its own records, never from a caller.
       */
      delegatedFrom?: ApprovalDelegationOrigin;
      /**
       * Where the schedule this call is running for reports, when it is a
       * live scheduled firing whose schedule was approved with a
       * destination. Not set for work a firing delegates. A firing has no conversation of
       * its own, and that destination is one a person already approved as
       * where it speaks, so a renderer with no approval channel of its own
       * asks there. Set by the gateway from the scheduler's own records,
       * never from session metadata a caller could write.
       */
      scheduleDestination?: ApprovalScheduleDestination;
      /**
       * When the request gives up and denies itself, ISO-8601. Absent when
       * it never will — a deadline of "now" would be a worse lie than
       * saying nothing.
       */
      expiresAt?: string;
    }
  | {
      type: 'tool.approval-resolved';
      sessionId: string;
      requestId: string;
      answer: ApprovalAnswer;
      reason: ApprovalResolutionReason;
      /** Who decided, when a person did. Channel-native id (a Slack user). */
      actor?: string;
    }
  /**
   * An agent asked for a named credential it does not hold
   * (`credential.request`), and it has already been put to someone: a form
   * in the conversation it asked in (`via: 'form'`), or a one-time link the
   * agent was handed to pass on (`via: 'link'`). The request is delivered
   * first and announced after, so this is a record of a question that was
   * asked, never a request for someone to render one. Nothing about it is
   * a secret, and nothing that answers it ever travels on the bus. `scope` is whose the key would be: the
   * agent's own (`agent`, the default) or the fleet's (`shared`).
   *
   * `metadata` is the session's, for the same reason an approval request
   * carries it: it says which conversation to ask in.
   */
  | {
      type: 'credential.requested';
      sessionId: string;
      agentId: string;
      requestId: string;
      name: string;
      scope: CredentialScope;
      /** The agent's own words on what it needs the key for. Untrusted text. */
      reason?: string;
      /** How it was put to someone. Absent from hosts before links existed, which only had forms. */
      via?: CredentialDelivery;
      /** A new value for a key the agent already holds, swapped in place. Always a form, never a link. */
      replace?: boolean;
      /** The variable the agent's shell commands will read the key from once it is added. */
      env?: string;
      metadata?: JsonObject;
    }
  /**
   * A requested credential was stored for the agent that asked, and granted
   * to it. Names only; the value went to the credential store and nowhere
   * else.
   *
   * Emitted once the key is stored, whether or not the grant then landed:
   * a key added from a chat is a change on disk, and a shared one is
   * already usable by every agent granted that name, so it is recorded even
   * when the soul write failed. `grantError` says it did, and why.
   */
  | {
      type: 'credential.provided';
      sessionId: string;
      agentId: string;
      requestId: string;
      name: string;
      scope: CredentialScope;
      /** Who provided it. Channel-native id (a Slack user). */
      actor?: string;
      /** The value replaced one already stored, rather than being added. */
      replace?: boolean;
      /** The variable the agent's shell commands now read the key from. */
      env?: string;
      /** Set when the key was stored but could not be added to the soul. */
      grantError?: string;
    }
  | {
      type: 'session.completed';
      sessionId: string;
      /**
       * The session's usage records — every provider call it has ever made,
       * not only this run's, because that is the stored form and a resumed
       * session's earlier turns are just as real. Absent when nothing
       * reported; a consumer must not read that as zero.
       *
       * A failed run's records are not lost by being missing here: they are
       * saved onto the session before `session.failed` goes out, and
       * `GET /sessions/:id` carries them.
       */
      usage?: UsageRecord[];
    }
  | {
      type: 'session.failed';
      sessionId: string;
      error: string;
      /**
       * True when the host stopped the turn on purpose (`HostRefusalError`):
       * `error` is then a sentence meant for the person in the conversation,
       * and a renderer shows it as it is rather than as a malfunction.
       */
      refused?: true;
    }
  /**
   * Usage a provider call just reported, as it lands: the records added to
   * the session since the last announcement, in the order they were
   * recorded. A harness reporting inner calls through the sink is announced
   * as each report arrives, while its `generate` is still running, so a
   * daemon that dies mid-call has already told a ledger what was spent.
   *
   * Per call rather than once per turn because a turn can make many calls,
   * and a host enforcing a budget has to know what the call before this one
   * spent before it allows the next. `session.completed` arrives too late
   * for that and is never sent for a turn that failed. Emitted for a failed
   * attempt too, whenever it reported anything: the tokens of a call that
   * threw were still spent. `agentId` rides along so a consumer
   * attributing spend to an agent needs no store read.
   *
   * Counts and attribution only, the same records `session.completed`
   * carries, ids included.
   */
  | { type: 'session.usage'; sessionId: string; agentId: string; records: UsageRecord[] }
  /**
   * The session's trust label went down. `source` names what lowered it —
   * a tool, by name, or `memory` (an injected or recalled entry), `sender`
   * (the turn's principal), `legacy` (a transcript from before provenance
   * was tracked). Never the content: this is what the daemon log records,
   * and the log is a trace, not a transcript.
   */
  | { type: 'session.tainted'; sessionId: string; trust: TrustLevel; source: string }
  /**
   * The conversation outgrew the model's context window, so its oldest
   * messages are no longer sent. `droppedMessages` is what this trim gave
   * up; `floor` is the total now held back.
   *
   * Counts only — no content, for the same reason `session.tainted` names
   * only its source: this is what the daemon log records, and the log is a
   * trace, not a second transcript. Worth an event at all because it is
   * otherwise invisible: the answers stay plausible while the agent
   * quietly stops being able to remember the start of the conversation.
   *
   * `summarized` is true when a summary (`CONTEXT_SUMMARY_METADATA_KEY`)
   * now stands in for everything below the window, and false when this cut
   * went without one — the summary call failed, and the model is told the
   * messages are gone. Absent from an emitter older than summaries.
   */
  | { type: 'session.context-trimmed'; sessionId: string; droppedMessages: number; floor: number; summarized?: boolean }
  /**
   * A memory pass ended (spec 962). Counts and statuses, never content.
   * `sessionId` is the pass's own session (`memoryPassSessionId`), so every
   * event still names one; a refused pass names it too, though it never ran.
   */
  | {
    type: 'memory.pass-completed';
    sessionId: string;
    agentId: string;
    passId: string;
    kind: MemoryPassKind;
    mode: MemoryPassMode;
    status: MemoryPassStatus;
    reason?: MemoryPassReason;
    saved: number;
    superseded: number;
  }
  /**
   * A message used its step budget and, with auto-continue on for its
   * agent, was given another instead of wrapping up (`AgentRunnerOptions.autoContinue`).
   * `continuation` counts from 1 within the message; `turns` is the
   * allowance just granted.
   */
  | { type: 'session.continued'; sessionId: string; continuation: number; turns: number }
  /**
   * The message ended in a wrap-up instead of finishing (`Session.stoppedEarly`):
   * emitted just before its `session.completed`. Counts only, like
   * `session.continued`, because the daemon log records it; the summary is
   * the turn's reply.
   */
  | { type: 'session.stopped-early'; sessionId: string; reason: StoppedEarlyReason; continuations: number };

export type EventHandler = (event: StratusEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Called when a subscriber throws. Handler errors never interrupt the run. */
  onError?: (error: unknown, event: StratusEvent) => void;
}

export interface SubscribeOptions {
  /**
   * Run this handler before previously registered ones. Emission awaits
   * handlers in order, so a slow consumer delays everyone after it — a
   * liveness observer (an activity watchdog) must sit in front, or the
   * activity it exists to notice reaches it only after the delay it is
   * timing against.
   */
  prepend?: boolean;
}

export class EventBus {
  private handlers: EventHandler[] = [];
  private readonly onError: EventBusOptions['onError'];

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError;
  }

  subscribe(handler: EventHandler, options: SubscribeOptions = {}): () => void {
    if (options.prepend) {
      this.handlers.unshift(handler);
    } else {
      this.handlers.push(handler);
    }
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  async emit(event: StratusEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      try {
        await handler(event);
      } catch (error) {
        this.onError?.(error, event);
      }
    }
  }
}

export interface SessionStore {
  create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  /**
   * Session ids in a given state, oldest first. Optional: a store that
   * cannot enumerate simply cannot recover parked turns, and a caller that
   * needs to sweep says so by checking for the method.
   *
   * Ids rather than sessions, deliberately — a sweep over a large store
   * should not deserialize every conversation body to find the few it wants.
   */
  listIdsByStatus?(status: SessionStatus): Promise<string[]>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session> {
    const now = new Date().toISOString();
    const session = { ...input, createdAt: now, updatedAt: now };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session, updatedAt: new Date().toISOString() });
  }

  async listIdsByStatus(status: SessionStatus): Promise<string[]> {
    return [...this.sessions.values()]
      .filter((session) => session.status === status)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((session) => session.id);
  }
}

// ---- contribution kinds a plugin registers besides tools ------------------

/**
 * The providers the host builds itself. Here, in the dependency-free
 * package, because two packages that never import each other need the one
 * list: `@stratusagent/state` resolves a selection against it, and
 * `@stratusagent/plugins` refuses a manifest that declares one of these as
 * a provider of its own — `provider: anthropic` in a soul has to keep
 * meaning the first-party adapter, and a plugin that could shadow it would
 * be a plugin that could receive every key the operator stored for it.
 */
export const BUILTIN_PROVIDER_NAMES = ['demo', 'openai', 'anthropic', 'codex'] as const;
export type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number];

/**
 * The names a trusted config's `executor` and `memoryStore` keys mean the
 * built-ins by — the local child-process executor and the file store —
 * and so the names a plugin may not register: the host's selection
 * special-cases them and would never look a contribution up under them.
 * Here for the same reason the provider list is: the manifest parser and
 * the selection logic live in packages that never import each other.
 */
export const BUILTIN_EXECUTOR_NAME = 'local';
export const BUILTIN_MEMORY_STORE_NAME = 'file';

/**
 * What a soul's `provider:` and `model:` pick, handed to a contributed
 * provider so it can build the right client. `systemPrompt` is the
 * operator's preamble from the config file — the persona itself arrives on
 * every request as `session.agent`, so a provider that ignores this still
 * speaks as the agent; what it loses is the daemon-wide preamble.
 */
export interface ProviderSelection {
  model?: string;
  systemPrompt?: string;
}

/**
 * A provider contributed by a plugin.
 *
 * A factory rather than a `ModelProvider`, and the reason is the soul: a
 * provider is built for a model, and `model:` in one soul and another in
 * the next have to reach it. A registered instance would serve one model
 * for the whole fleet. The host calls `create` once per distinct selection
 * and keeps the result, so a plugin holding a client per model holds one
 * per model, never one per turn.
 */
export interface ProviderContribution {
  /** The name a soul's `provider:` selects — `ollama`, never a package name. */
  name: string;
  create(selection: ProviderSelection): ModelProvider;
  /**
   * Whether providers built here report progress through `onDelta`. A
   * host arms its stall watchdog only for a streaming provider — silence
   * from one means a stall, while a non-streaming call is silent until it
   * answers, and a watchdog armed over it would abort every long turn.
   * Default false, the safe reading for a provider that did not say.
   */
  streams?: boolean;
}

/**
 * The slice of a channel adapter the kernel holds: structurally the
 * `ChannelAdapter` in `channels.ts`, declared on its own because it
 * predates that contract moving into core (the gateway keeps a copy for
 * the same reason). `name` is the channel kind (`slack`, `discord`); the
 * gateway it is started with is the host's.
 */
export interface ChannelAdapterLike {
  name: string;
  start(gateway: unknown): Promise<void>;
  stop(): Promise<void>;
  required?: boolean;
  resolveOutbound?(address: { agentId: string; to: string; thread?: string }): Promise<{
    post(text: string): Promise<unknown>;
  }>;
  /** See `ChannelAdapter.readConversation`. */
  readConversation?(request: {
    agentId: string;
    conversation: string;
    thread?: string;
    after?: string;
    before?: string;
    limit: number;
    sessionId?: string;
    images?: { count: number; bytes: number };
  }): Promise<{
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
  /** See `ChannelAdapter.createConversation`. */
  createConversation?(request: {
    agentId: string;
    name: string;
    private?: boolean;
    topic?: string;
    purpose?: string;
    invite?: string[];
  }): Promise<{
    conversation: string;
    name: string;
    invited: string[];
    notInvited: Array<{ who: string; reason: string }>;
    notSet: Array<{ field: 'topic' | 'purpose'; reason: string }>;
  }>;
  /** See `ChannelAdapter.joinConversation`. */
  joinConversation?(request: { agentId: string; conversation: string }): Promise<{ conversation: string; alreadyMember: boolean }>;
  /** See `ChannelAdapter.inviteToConversation`. */
  inviteToConversation?(request: { agentId: string; conversation: string; invite: string[] }): Promise<{
    invited: string[];
    notInvited: Array<{ who: string; reason: string }>;
  }>;
  /** See `ChannelAdapter.archiveConversation`. */
  archiveConversation?(request: { agentId: string; conversation: string }): Promise<{ conversation: string; alreadyArchived: boolean }>;
  /** See `ChannelAdapter.accountFor`. */
  accountFor?(agentId: string): string | undefined;
  /** See `ChannelAdapter.conversationKindFor`. */
  conversationKindFor?(agentId: string, conversation: string): Promise<'channel' | 'direct' | undefined>;
  /** See `ChannelAdapter.sessionConversation`. */
  sessionConversation?(agentId: string, sessionId: string): string | undefined;
  /** See `ChannelAdapter.reload`. */
  reload?(): Promise<void>;
}

/**
 * A channel contributed by a plugin: the adapter plus the agents it
 * carries. Channels key on (agent, kind), not on the agent alone — one
 * agent reachable on Slack and on Discord is two registrations that do
 * not collide; two adapters both claiming Discord for that agent do.
 */
export interface ChannelContribution {
  /** Its `name` is the channel kind. */
  adapter: ChannelAdapterLike;
  /** Agent ids this adapter carries: the (agent, kind) pairs it claims. */
  agents: readonly string[];
}

/**
 * A memory store contributed by a plugin. Every `AgentMemoryStore` method
 * takes the agent id, and that is what makes a contributed store
 * per-agent-resolvable rather than process-global: a plugin that closed
 * over one agent at setup would hand every agent the first agent's
 * memories, the way a `tool-fs` that cached its roots would hand every
 * agent the first agent's files.
 */
/**
 * The revision of `AgentMemoryStore` a contributed store is built against.
 *
 * Bumped when the contract changes shape in a way a plugin compiled against
 * the old one cannot satisfy — which it *silently* cannot, because the
 * change that matters here is the shape of an argument rather than the
 * number of them. A v1 store's `search(agentId, query, limit)` still
 * accepts three arguments and still returns entries when the host hands it
 * an options object; it just binds `{ limit: 10 }` where a number belonged,
 * and answers with an unbounded read or none at all. No runtime check can
 * tell the two apart from the function, so the plugin declares it.
 *
 * - **1** — `append(agentId, content, metadata?, provenance?)` and
 *   `search(agentId, query, limit?)`, the shape before 29.
 * - **2** — `append(agentId, content, options?)` and
 *   `search(agentId, query, options?)`, plus the optional `pin`, `unpin`,
 *   `pinned`, `topics`, and `importEntries`.
 */
export const MEMORY_STORE_CONTRACT_VERSION = 2;

export interface MemoryStoreContribution {
  name: string;
  store: AgentMemoryStore;
  /**
   * Must be `MEMORY_STORE_CONTRACT_VERSION`. A store declaring an older
   * revision — or none, which is what a plugin built before this field
   * existed produces — is refused at registration rather than routed
   * traffic it will mishandle without saying so.
   */
  contract: typeof MEMORY_STORE_CONTRACT_VERSION;
  /**
   * The store accepts a list in `supersedes` (one record retiring several
   * facts) and reads one back as retiring each. Without it, a store gets
   * single ids only: a memory pass can still save and supersede one fact,
   * but never merges several into one. Optional, so a store built before
   * lists keeps loading under the same contract version. The built-in
   * stores accept lists.
   */
  supersedesMany?: true;
}

/** An executor contributed by a plugin, selectable by name in a trusted config. */
export interface ExecutorContribution {
  name: string;
  executor: Executor;
}

/**
 * A name-keyed registry for one contribution kind — the counterpart of
 * `ToolRegistry` for providers, memory stores, and executors. Like it, a
 * bare `Map.set`: it keeps no provenance and refuses nothing, and a plugin
 * never touches one directly. The manifest-bound view in
 * `@stratusagent/plugins` is what refuses an undeclared name or a
 * collision; this is where a whole plugin's contributions land once it has
 * loaded.
 */
export class ContributionRegistry<T> {
  private readonly entries = new Map<string, T>();

  register(name: string, value: T): void {
    this.entries.set(name, value);
  }

  get(name: string): T | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  list(): T[] {
    return [...this.entries.values()];
  }
}

/** The (agent, kind) key a channel registration claims. */
export const channelClaimKey = (kind: string, agentId: string): string => `${kind}:${agentId}`;

/**
 * The registry for contributed channels. Keyed by (agent, kind) rather than
 * by name, because that is what collides — see `ChannelContribution` — and
 * listed as adapters, because that is what a host starts. Same discipline
 * as the other registries: no refusal here, the view refuses.
 */
export class ChannelRegistry {
  private readonly contributions: ChannelContribution[] = [];

  /** Undefined marks a claim the host made for an adapter it wired itself. */
  private readonly claims = new Map<string, ChannelContribution | undefined>();

  register(contribution: ChannelContribution): void {
    this.contributions.push(contribution);
    for (const agentId of contribution.agents) {
      this.claims.set(channelClaimKey(contribution.adapter.name, agentId), contribution);
    }
  }

  /**
   * Claim (agent, kind) pairs the host carries itself, so a plugin
   * registering the same kind for the same agent collides with the host's
   * adapter exactly as it would with another plugin's — two adapters on
   * one agent's Slack would each answer every message.
   */
  claim(kind: string, agentIds: readonly string[]): void {
    for (const agentId of agentIds) {
      if (!this.claims.has(channelClaimKey(kind, agentId))) {
        this.claims.set(channelClaimKey(kind, agentId), undefined);
      }
    }
  }

  /** Whether some adapter — the host's or a plugin's — already carries this agent on this kind. */
  claimed(kind: string, agentId: string): boolean {
    return this.claims.has(channelClaimKey(kind, agentId));
  }

  list(): ChannelContribution[] {
    return [...this.contributions];
  }
}

/**
 * A memory store that resolves which store serves an agent **per call**.
 *
 * The seam a host selects a contributed store through. The runner and the
 * memory tools are built before any plugin has loaded, so the store they
 * hold has to be one that can change its mind — and an agent-by-agent
 * answer is what keeps a contributed store from being process-global.
 * Every optional method is forwarded only when the chosen store has it: a
 * store that omitted one cannot do that thing, and this must not claim
 * otherwise. The routed store declares them all, because which store
 * serves an agent is not known until the call — so the honest answer for a
 * store that lacks one is the same answer the seam's own default gives
 * (nothing pinned, no topics, no re-assertion).
 */
export const createRoutedMemoryStore = (
  storeFor: (agentId: string) => AgentMemoryStore,
): AgentMemoryStore => ({
  append: (agentId, content, options) => storeFor(agentId).append(agentId, content, options),
  list: (agentId, options) => storeFor(agentId).list(agentId, options),
  search: (agentId, query, options) => storeFor(agentId).search(agentId, query, options),
  forget: (agentId, entryId) => storeFor(agentId).forget(agentId, entryId),
  audit: (agentId) => storeFor(agentId).audit(agentId),
  async reassertTrust(agentId, entryId, trust) {
    const store = storeFor(agentId);
    if (!store.reassertTrust) {
      return false;
    }
    return store.reassertTrust(agentId, entryId, trust);
  },
  async pin(agentId, entryId) {
    const store = storeFor(agentId);
    if (!store.pin) {
      return { pinned: false, reason: 'This memory store does not support pinning.', bytes: 0 };
    }
    return store.pin(agentId, entryId);
  },
  async unpin(agentId, entryId) {
    const store = storeFor(agentId);
    return store.unpin ? store.unpin(agentId, entryId) : false;
  },
  async pinned(agentId, options) {
    const store = storeFor(agentId);
    return store.pinned ? store.pinned(agentId, options) : [];
  },
  async topics(agentId) {
    const store = storeFor(agentId);
    return store.topics ? store.topics(agentId) : [];
  },
  async importEntries(agentId, entries) {
    const store = storeFor(agentId);
    if (!store.importEntries) {
      throw new Error('This memory store cannot import entries.');
    }
    return store.importEntries(agentId, entries);
  },
});

/** The handle a plugin registers providers through. Manifest-bound; see `@stratusagent/plugins`. */
export interface ProviderRegistrationHandle {
  register(contribution: ProviderContribution): void;
}

/**
 * The transport secrets a channel plugin receives, by agent id: the values
 * under `channels.<kind>.<agentId>` in the host's credential store. Every
 * value is a string — a token, an app id — and nothing here is ever
 * resolved through an agent's own credential allowlist.
 */
export type ChannelTransportSecrets = Record<string, Record<string, string>>;

export interface ChannelRegistrationHandle {
  register(contribution: ChannelContribution): void;
  /**
   * The host-owned path for a channel's transport secrets, for a kind
   * this plugin's manifest declares. Host-owned because the invariant is
   * firm: a channel token is a gateway infrastructure secret, never
   * resolvable through the agent-scoped `credentials` resolver, since an
   * agent must not read the tokens of the transport carrying it. Without
   * this a channel plugin could not initialize at all — it has no other
   * defined way to learn which agents it carries.
   */
  transportSecrets(kind: string): Promise<ChannelTransportSecrets>;
}

/**
 * Where each agent's files go, answered by the host.
 *
 * A seam rather than a path in a config block because the layout is this
 * repository's to own: the workspace is `~/.stratus/agents/<id>/workspace`
 * today and was `~/.stratus/workspaces/<id>` before it, and every plugin
 * that joined the agent id onto a root held a copy of that shape. Five of
 * them did, and all five had to change when it moved — which is the cost
 * the `workspaceRoot` key was introduced to avoid and did not.
 *
 * Asked per call, from `session.agent.id`, for the same reason credentials
 * are: the answer is the *calling* agent's, and one captured at setup is
 * the first agent's forever.
 */
export interface AgentWorkspaces {
  /**
   * Where this agent's files go. Resolution only: nothing is created and
   * nothing can fail that would not fail for a bad id, so a caller that
   * merely needs to *name* the path — the provenance ledger looking for a
   * file that may not exist — can ask without consequence.
   */
  forAgent(agentId: string): string;
  /**
   * The same path, created and with its permissions settled, for a caller
   * about to write.
   *
   * The host does this rather than the plugin because the workspace sits
   * inside the agent's state directory, beside its sessions, memories and
   * grants — so the recursive `mkdir` a file-producing plugin would
   * otherwise reach for makes a *state* directory under the process umask.
   * A plugin has no way to know that; the host that chose the layout does.
   * Callers may still create subdirectories under what they are handed.
   *
   * Separate from {@link forAgent} because it can fail, and what fails
   * with it should be only what needed the directory. A read that wanted
   * a path, a navigation that writes nothing, a tool result that turned
   * out to be text — none of those should stop because a directory they
   * were never going to use could not be made.
   */
  prepare(agentId: string): string;
  /**
   * Every agent workspace the host can currently name, for the guards that
   * have to recognise *any* agent's file rather than the caller's — the
   * filesystem provenance ledger is the one that does.
   *
   * Paths, not a promise that each exists: a caller canonicalizes and
   * tolerates what is missing. Re-read rather than cached, so an agent
   * added under a running daemon is visible to the next call.
   */
  all(): Promise<readonly string[]>;
}

/**
 * Where one plugin keeps durable state of its own, answered by the host.
 *
 * A seam for the reason {@link AgentWorkspaces} is one: the layout is the
 * host's to own. A plugin that needs to remember something across restarts
 * — a channel's read position in a store it does not own, a cursor into a
 * vendor's event log — would otherwise join a path onto `~/.stratus` itself,
 * and every plugin doing so is one more copy of the layout to find when it
 * moves. Per plugin, never per agent: what a plugin remembers is its own,
 * and it makes whatever structure it needs beneath this.
 */
export interface PluginStateDirectory {
  /**
   * The directory, created and with its permissions settled, for a caller
   * about to write. Private to the daemon's user, because what a plugin
   * keeps is the daemon's business, and a plugin cannot be expected to know
   * the mode the rest of the state is held to.
   *
   * Asked per write rather than captured at setup: a daemon runs for weeks,
   * and the directory can be removed or replaced with a link under it.
   */
  prepare(): string;
}

/**
 * Files and directories on this machine that no plugin may hand an agent,
 * answered by the host.
 *
 * A seam for the reason {@link AgentWorkspaces} is one: which files hold
 * the daemon's own secrets is the host's layout, not a plugin's. Before it,
 * nothing kept them out of a tool whose roots happened to cover them: an
 * operator who gave an agent `roots: ["~"]` gave it `fs.read` of
 * `~/.stratus/credentials.json`, which `fs.read` answers ungated. Roots are
 * the operator's choice of where an agent may work; this is the short list
 * of places no choice of roots opens.
 *
 * Paths, not a promise that each exists: a caller canonicalizes and
 * tolerates what is missing. Re-read rather than cached, so a file the host
 * starts keeping under a running daemon is protected from the next call.
 */
export interface ProtectedPaths {
  /** What is protected. A directory protects everything beneath it. */
  all(): Promise<readonly string[]>;
  /**
   * Directories beneath a protected one that stay reachable. The daemon
   * protects its whole home and exempts the agents' workspaces, which live
   * inside it and are where agents are meant to work. Whether a given agent
   * reaches a given workspace is still its roots' decision.
   */
  exempt(): Promise<readonly string[]>;
}

export interface MemoryRegistrationHandle {
  register(contribution: MemoryStoreContribution): void;
}

export interface ExecutorRegistrationHandle {
  register(contribution: ExecutorContribution): void;
}

/**
 * One task for a sub-agent (roadmap 24): an ephemeral helper that runs as
 * the calling agent, on its provider and credentials, with only the tools
 * it is handed and nothing else of the agent's: no persona, no memory, no
 * channel, and no human to ask.
 */
export interface SubAgentRunInput {
  /**
   * The session of the turn asking: the very object a tool's `execute`
   * was handed, while that call is running. The host checks it by
   * identity, so an id, a copy, or a session from a call that has ended
   * is refused, and a plugin cannot start sub-agents of a turn that did
   * not call it. The agent, its allowlist and depth come from the host's
   * own records, never from this object.
   */
  parent: Pick<Session, 'id'>;
  /** The task, as the sub-agent's only user message. */
  instruction: string;
  /**
   * Tool names the sub-agent may call, each one the parent may call itself.
   * Exact names, not globs. `agent.spawn`, `agent.delegate`, and `memory.*`
   * are refused even when the parent holds them.
   */
  tools: string[];
  /** Not supported yet: refused rather than ignored. The parent's model runs. */
  model?: string;
  /**
   * An extra stop. The host already ties the sub-agent to the parent
   * turn's own cancel, so this is only for a plugin that wants to end it
   * sooner.
   */
  signal?: AbortSignal;
}

/**
 * How a sub-agent ended. `result` and `empty` both ran to completion; the
 * difference is whether it said anything. `error` is a run that failed —
 * a refusal at the start is thrown instead, before anything runs. `trust`
 * is the sub-agent session's label: what it returns may repeat what it
 * read, and a caller handing it to its own turn marks that call with it.
 */
export type SubAgentOutcome =
  | { status: 'result'; text: string; sessionId: string; trust: TrustLevel }
  | { status: 'empty'; sessionId: string; trust: TrustLevel }
  | { status: 'error'; error: string; sessionId: string; trust: TrustLevel };

/** The host's way to start sub-agents. See `PluginContext.subAgents`. */
export interface SubAgentHandle {
  /**
   * Run one sub-agent to the end. Rejects, naming the reason, when the
   * request is refused: a parent that is not running a turn or is itself
   * a sub-agent, the delegation depth limit, a tool outside the parent's
   * allowlist or never given to a sub-agent, a model. Rejects with the
   * abort error when `signal` fires.
   */
  run(input: SubAgentRunInput): Promise<SubAgentOutcome>;
}

/** One agent the daemon is serving, as `FleetReader.agents` reports it. */
export interface FleetAgent {
  id: string;
  name: string;
  /** The newest session activity for this agent. Absent when it has none. */
  lastActiveAt?: string;
  /** Sessions `running` or `pending_approval` right now. */
  activeSessions: number;
}

/** One session's lifecycle, never its content. */
export interface FleetSession {
  id: string;
  agentId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

/** One schedule, without its prompt. */
export interface FleetSchedule {
  id: string;
  agentId: string;
  /** As `stratus schedules` prints it: `every 2h`, `cron 5 19 * * *`, `once at <iso>`. */
  cadence: string;
  /** `channel:to` when the schedule reports somewhere. */
  destination?: string;
  createdAt: string;
  nextFireAt?: string;
  lastFiredAt?: string;
  /** The status of the most recent firing's session, while it is still stored. */
  lastSessionStatus?: SessionStatus;
}

/** One call parked on a human, without its input. */
export interface FleetPendingApproval {
  requestId: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  risk: ToolRisk;
  parkedAt: string;
  expiresAt?: string;
}

/**
 * Read-only fleet metadata for a plugin (roadmap 26), from the same reads
 * the control API's `/agents`, `/sessions`, `/health`, `/schedules` and
 * `/approvals` use, so a report and the console agree. Content never
 * crosses it: no messages, no schedule prompts, no approval inputs. There
 * is no write verb. The host logs every read with the plugin's name.
 */
export interface FleetReader {
  agents(): Promise<FleetAgent[]>;
  /** Newest first. `limit` bounds the rows; omitted, every stored session. */
  sessions(options?: { agentId?: string; limit?: number }): Promise<FleetSession[]>;
  /** Stored sessions by status, counted in the index. */
  countByStatus(): Promise<Record<string, number>>;
  /** Every schedule, oldest first. */
  schedules(): Promise<FleetSchedule[]>;
  /** Every parked call, oldest first. */
  pendingApprovals(): Promise<FleetPendingApproval[]>;
}

export interface PluginContext {
  bus: EventBus;
  tools: ToolRegistry;
  /**
   * How a plugin resolves a credential for the agent whose call it is
   * serving, so it never needs `process.env`. It declares what it needs by
   * name in its manifest and receives exactly that, per call — which is
   * what a search backend needs to reach the *calling* agent's key rather
   * than one captured at setup.
   *
   * A host that omits it leaves every plugin that wants a credential with
   * no way to get one: such a plugin must fail the call naming what is
   * missing, never fall back to ambient environment. Read
   * `docs/architecture/plugins.md` on what this does and does not buy — a
   * plugin is code, so scoping it is an interface rather than a boundary.
   */
  credentials?: CredentialResolver;
  /**
   * The registration handles for the four contribution kinds that are not
   * tools: each a manifest-bound view, never the raw registry, following
   * the shape `tools` established. Optional because a bare
   * `PluginRegistry.loadAll({ bus, tools })` host supplies none; the
   * `@stratusagent/plugins` loader supplies all four. A plugin that needs
   * one and finds it absent must fail its `setup` naming the kind, so the
   * operator learns the host cannot carry it — never register nothing and
   * report itself loaded.
   */
  providers?: ProviderRegistrationHandle;
  channels?: ChannelRegistrationHandle;
  memory?: MemoryRegistrationHandle;
  executors?: ExecutorRegistrationHandle;
  /**
   * Where this plugin may write files, per agent. See {@link AgentWorkspaces}.
   *
   * A host that omits it leaves every plugin that produces a file with
   * nowhere the host has chosen to put it. Such a plugin falls back to the
   * `workspaceRoot` config key — the documented root it joins the agent id
   * onto — and, given neither, must fail the call naming what is missing,
   * the way `browser.screenshot` does. Never a directory of its own
   * choosing: a file an agent was told it produced has to be somewhere the
   * operator can find, and a turn that cannot store its output must not
   * read as though it did.
   */
  workspaces?: AgentWorkspaces;
  /**
   * Where this plugin may keep durable state. See {@link PluginStateDirectory}.
   *
   * A host that omits it gives the plugin nowhere to remember anything
   * across a restart. Such a plugin must say what it gives up — a channel
   * that cannot store its read position cannot promise a message is handled
   * once — and must never choose a directory of its own instead.
   */
  stateDirectory?: PluginStateDirectory;
  /**
   * What no plugin may hand an agent, whatever the agent's own roots say.
   * See {@link ProtectedPaths}.
   *
   * A host that omits it protects nothing beyond what each plugin's own
   * configuration excludes: a file-reading plugin with roots above the
   * host's state reads the host's secrets there. The daemon and `stratus
   * run` both supply it.
   */
  protectedPaths?: ProtectedPaths;
  /**
   * The host's log, for what a plugin has to say after `setup` returns —
   * a server that dropped, a reconnect that failed. The daemon's is the
   * structured log `stratus logs` reads. A host that omits these leaves
   * the plugin to its own stderr, which under a service manager is a line
   * nobody sees: plugin-mcp's disconnect warnings went there for as long
   * as this seam did not exist.
   */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * Starts sub-agents for a running turn (roadmap 24). The host enforces
   * every limit (the slice, the exclusions, depth, concurrency, no human
   * asked), so a plugin owns only the fan-out and how results come back.
   * A host that omits it cannot run sub-agents; a plugin that needs it
   * must fail its `setup` naming it.
   */
  subAgents?: SubAgentHandle;
  /**
   * Runs memory passes (spec 962): short model runs, as the agent, that may
   * only recall and remember. The host owns the transcript, the provider and
   * the store, and enforces every rule; a plugin decides only when to ask. A
   * host that omits it (`stratus run`) cannot run passes; a plugin that
   * needs it must fail its `setup` naming it.
   */
  memoryPasses?: MemoryPassHandle;
  /**
   * Reads fleet metadata (roadmap 26). See {@link FleetReader}. A host that
   * omits it has no fleet to describe; a plugin that needs it must fail its
   * `setup` naming it.
   */
  fleet?: FleetReader;
  /**
   * Registers a guard the host asks before every provider call. See
   * {@link ProviderCallGuard}. A host passing it enforces what is
   * registered for every agent it runs, sub-agents included. A host that
   * omits it cannot enforce one, and a plugin that needs it (a budget) must
   * fail its `setup` naming it: a limit nothing enforces must not report
   * itself loaded.
   */
  providerCalls?: ProviderCallGuardHandle;
  /**
   * Feeds this plugin's events to the host's event triggers. See
   * {@link EventIngestHandle}. A host that omits it takes no events from
   * plugins (`stratus run` is one), and a plugin whose whole job is feeding
   * them must fail its `setup` naming it, rather than load and poll for
   * events nothing will ever act on.
   */
  events?: EventIngestHandle;
}

export interface ProviderCallGuardHandle {
  register(guard: ProviderCallGuard): void;
}

/**
 * What the host did with one event a plugin fed it. `matched`: stored, with
 * a firing waiting for each event trigger it matched. `unmatched`: stored,
 * and no trigger wanted it. `duplicate`: the source took the same id within
 * the dedup window, so nothing new was stored and nothing fires.
 */
export interface EventIngestResult {
  status: 'matched' | 'unmatched' | 'duplicate';
}

/**
 * How a plugin that is not a webhook (a poller, an MCP subscriptions bridge)
 * wakes agents' event triggers. Its events take the same path a signed
 * delivery to the events port takes: the size limit, the per-source rate,
 * dedup on the source and the event's id, the rule filter, then a firing
 * per matched trigger. What a plugin skips is the signature, because the
 * plugin is code the operator installed. Its event text is still labeled
 * `external` in the turn, the way a webhook's is: who fed an event says
 * nothing about who wrote the comment inside it.
 *
 * Bound to the source ids the plugin's manifest declares
 * (`contributes.eventSources`), the way its tools are bound to the names it
 * declares. A source a plugin feeds is never a path on the events port.
 */
export interface EventIngestHandle {
  /**
   * Store one event for a declared source. The event is a structured
   * CloudEvents 1.0 object: `specversion` "1.0" and non-empty string `id`,
   * `source` and `type`, with `subject`, `time`, scalar extension
   * attributes and JSON `data` as wanted. Resolves once it is stored, so a
   * poller can move its cursor past it. Rejects, naming the reason, for a
   * source the manifest does not declare, an event that is not a
   * CloudEvent, one over the size limit, a source over its rate, a plugin
   * that has not finished loading or did not load, and a host that has
   * stopped. A rejected event fires nothing; feeding it again later is
   * safe, because the id is what dedup keys on.
   */
  ingest(sourceId: string, event: JsonObject): Promise<EventIngestResult>;
}

export interface Plugin {
  name: string;
  setup(context: PluginContext): Promise<void> | void;
  /**
   * Release whatever `setup` acquired. Optional, and most plugins have
   * nothing to release — a plugin that registers pure functions is done
   * when the process is.
   *
   * It exists because some do: a browser plugin holds a Chromium and a
   * listening socket, and a daemon that stopped without telling it would
   * leak both. The host calls this on shutdown, after channels have
   * stopped, and a plugin that throws here is logged rather than allowed to
   * hold up the drain.
   */
  dispose?(): Promise<void> | void;
}

export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async loadAll(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup(context);
    }
  }

  /**
   * Dispose every plugin that has something to dispose, in reverse load
   * order. Settled rather than awaited in sequence-with-throw: one
   * plugin's failed cleanup must not strand the next plugin's.
   */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.plugins].reverse().map(async (plugin) => plugin.dispose?.()),
    );
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Forget a tool, reporting whether one was registered under that name.
   *
   * Exists for the one registrar whose contribution can shrink while the
   * daemon runs: a bridge whose tools are discovered from somebody else's
   * server picks up a removal on reconnect, and a registry nothing ever
   * deletes from would keep advertising a tool every call to which must
   * fail. Hosts do not reach for this directly — a plugin's removals go
   * through its manifest-bound view, which refuses names it does not own.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  describe(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
      risk: resolveToolRisk(tool),
    }));
  }
}

/**
 * The two producer channels, collected for one call: the tool's standing
 * `outputTrust` declaration and whatever the tool marks through the
 * `markTrust` sink during the call. `resolve()` is the label the executor
 * promotes into the result — the least trusted of everything that fired,
 * `agent` when nothing did.
 */
export interface TrustMarking {
  /** The context to hand the tool: the caller's, with the sink attached. */
  context: ExecutionContext;
  resolve(): TrustLevel;
}

/**
 * Exported for every executor — `DefaultExecutor` here, `DirectExecutor`
 * and `LocalCommandExecutor` in their packages — so the promotion rule is
 * written once. An executor that inferred the label from a tool's name or
 * its output shape would be the enumerated list this replaces, rebuilt one
 * layer down; this one only reads what the tool said.
 */
export const createTrustMarking = (tool: Pick<Tool, 'outputTrust'>, context?: ExecutionContext): TrustMarking => {
  let marked: TrustLevel = 'user';
  const upstream = context?.markTrust;
  return {
    context: {
      ...context,
      markTrust: (trust) => {
        marked = leastTrusted(marked, trust);
        upstream?.(trust);
      },
    },
    // A declaration that is present but not a label — `externl` — is a
    // producer that meant to say something, and reads `unknown`, never the
    // no-declaration default. `leastTrusted` ranks it so; the `??` here
    // only decides what an absent declaration means.
    resolve: () => leastTrusted(tool.outputTrust ?? 'agent', marked),
  };
};

export class DefaultExecutor implements Executor {
  async execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult> {
    const marking = createTrustMarking(tool, context);
    try {
      const output = await tool.execute(call.input, session, marking.context);
      return { callId: call.id, toolName: call.toolName, ok: true, output, trust: marking.resolve() };
    } catch (error) {
      // A failure carries the label too: a server's error text is that
      // server's text, and it reaches the model like any other output.
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trust: marking.resolve(),
      };
    }
  }
}

/**
 * Where a session's trust label lives in `session.metadata`, so it survives
 * what the session survives: the gateway's store is SQLite and a thread
 * resumes across daemon restarts, and an in-memory flag would launder
 * every fact written after a restart mid-thread.
 */
export const SESSION_TRUST_METADATA_KEY = 'sessionTrust';
/** What last lowered the label — a tool name, or `memory` / `sender` / `legacy`. Description, not control. */
export const SESSION_TAINTED_BY_METADATA_KEY = 'sessionTaintedBy';
/**
 * A turn's principal, as the dispatching surface evaluated it — carried on
 * the *turn's* metadata (`RunInput.metadata`, `ResumeInput.metadata`) and
 * never persisted: a Slack thread keys one session for every turn in it,
 * so an authorized member can open a thread and a stranger can mention the
 * agent inside it afterwards. Read off the session, the first sender's
 * trust would cover the stranger's message forever. Absent means `user`,
 * which is what every path without a channel already assumes: the
 * machine's owner is the operator.
 */
export const SENDER_TRUST_METADATA_KEY = 'senderTrust';

/**
 * A session's current label. `unknown` when none is recorded — a session
 * from before provenance was tracked — which is the reading every consumer
 * must share: absence of provenance is not evidence of trust.
 */
export const sessionTrustOf = (session: Pick<Session, 'metadata'>): TrustLevel => {
  const recorded = session.metadata?.[SESSION_TRUST_METADATA_KEY];
  return isTrustLevel(recorded) ? recorded : 'unknown';
};

/** What last lowered a session's label, when something did. */
export const sessionTaintedBy = (session: Pick<Session, 'metadata'>): string | undefined => {
  const recorded = session.metadata?.[SESSION_TAINTED_BY_METADATA_KEY];
  return typeof recorded === 'string' ? recorded : undefined;
};

/**
 * The trust a turn's sender earns, from the turn's metadata. See
 * `SENDER_TRUST_METADATA_KEY`. No key at all is the operator's own call —
 * the CLI, a control API client holding the token. A key holding anything
 * but a label is a channel that meant to say something and misspelled it,
 * and a misspelled authorization is not one: it reads `unknown`, the label
 * for provenance nobody can vouch for, never `user`.
 */
export const senderTrustOf = (metadata: JsonObject | undefined): TrustLevel => {
  if (metadata === undefined || !(SENDER_TRUST_METADATA_KEY in metadata)) {
    return 'user';
  }
  const recorded = metadata[SENDER_TRUST_METADATA_KEY];
  return isTrustLevel(recorded) ? recorded : 'unknown';
};

/**
 * Whether a label is a taint — content from outside the boundary, or
 * content nobody can vouch for. `user` and `agent` are both inside it: an
 * agent's own work in its operator's conversation is the ordinary case, not
 * a lowering worth announcing.
 */
export const isTaintedTrust = (trust: TrustLevel): boolean => trust === 'unknown' || trust === 'external';

/**
 * The label content the agent itself produces in this session carries — a
 * remembered fact, a prompt it delegates, a schedule it sets. At most
 * `agent`, whatever the session's own label: a restatement is the agent's
 * even when everything it restated was the operator's, which is what keeps
 * `user` meaning "a person said this" rather than "an agent said this to a
 * person". Below that, the session's label wins, so a session that has
 * seen `unknown` or `external` content writes that.
 */
export const sessionWriteTrust = (session: Pick<Session, 'metadata'>): TrustLevel =>
  leastTrusted('agent', sessionTrustOf(session));

/**
 * Lower a session's label to `trust` if that is lower than what it has,
 * recording `source` as the reason when the result is a taint. Monotonic: a
 * label never rises within a session, because raising it would need a
 * claim about what left the context, which nothing can make honestly.
 * Writes the key even when nothing lowers, so a session the runner has
 * evaluated is distinguishable from one it never saw. Returns whether the
 * label moved.
 */
export const lowerSessionTrust = (session: Session, trust: TrustLevel, source: string): boolean => {
  const recorded = session.metadata?.[SESSION_TRUST_METADATA_KEY];
  // No key is a session nothing has judged yet, which starts at `user`; a
  // key holding something that is not a label is a record nobody can read,
  // and `sessionTrustOf` already reads that as `unknown` — starting it at
  // `user` here would let the first clean turn overwrite it as trusted.
  const current: TrustLevel = recorded === undefined ? 'user' : isTrustLevel(recorded) ? recorded : 'unknown';
  const next = leastTrusted(current, trust);
  const lowered = next !== current;
  session.metadata = {
    ...(session.metadata ?? {}),
    [SESSION_TRUST_METADATA_KEY]: next,
    ...(lowered && isTaintedTrust(next) ? { [SESSION_TAINTED_BY_METADATA_KEY]: source } : {}),
  };
  return lowered;
};

/**
 * Mark `error` as one of core's errors that cross package boundaries, so a
 * copy of core other than the one that built it still recognizes it.
 *
 * There is more than one copy of core in a real install. npm gives every
 * global package its own dependency tree, so the CLI, `channel-slack` and
 * every provider or plugin package installed beside it each carry their
 * own `@stratusagent/core`, with classes of their own. A plain
 * `instanceof` then answers no for an error that is exactly what it
 * checks for, and the kernel takes a recoverable failure for a final one.
 * The brand is a registry symbol (`Symbol.for`), the one value every copy
 * agrees on. Copies from before the brand existed are not recognized.
 */
const brandCoreError = (error: Error, brand: symbol): void => {
  Object.defineProperty(error, brand, { value: true });
};

/**
 * `instanceof` for a branded error class: any copy's instance of it, and
 * for a subclass the ordinary prototype check, so narrowing to a subclass
 * still means that subclass.
 */
const isBrandedCoreError = (
  checked: abstract new (...args: never[]) => unknown,
  base: abstract new (...args: never[]) => unknown,
  brand: symbol,
  value: unknown,
): boolean => {
  if (checked !== base) {
    return Function.prototype[Symbol.hasInstance].call(checked, value);
  }
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;
};

const CONTEXT_OVERFLOW_BRAND: unique symbol = Symbol.for('stratus.error.ContextOverflowError');
const RUN_ABORTED_BRAND: unique symbol = Symbol.for('stratus.error.RunAbortedError');
const HOST_REFUSAL_BRAND: unique symbol = Symbol.for('stratus.error.HostRefusalError');

/**
 * Thrown by a provider when the request did not fit the model's context
 * window — the transcript, not the answer, is what was too long.
 *
 * A distinct type because it is the one provider failure the kernel can do
 * something about. Everything else a provider throws is final; this one
 * says "the same request will never work, a shorter one might", and the
 * runner answers by sending less history (see `raiseContextFloor`).
 *
 * Providers opt in. Recognising it means matching a vendor's own wording
 * for a 400, which only the adapter can do — and a harness provider that
 * manages its own context (`provider-claude-code`, `provider-codex`) has
 * nothing to report, because the transcript it sends is not ours to
 * shorten. A provider that never throws this behaves exactly as it did.
 *
 * A provider that does throw it is answered with requests that carry their
 * own transcript (`ProviderRequest.messages`), and must send that rather
 * than the session's: the shorter retry, and before it the summary of what
 * the retry cut (`CONTEXT_SUMMARY_REQUEST`), a single message and no tools.
 */
export class ContextOverflowError extends Error {
  /** Recognized across copies of core: a provider package carries its own. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedCoreError(this, ContextOverflowError, CONTEXT_OVERFLOW_BRAND, value);
  }

  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
    brandCoreError(this, CONTEXT_OVERFLOW_BRAND);
  }
}

/**
 * A turn the host stopped on purpose (a spent token budget) rather than
 * one that broke.
 *
 * A kernel type because layers that know nothing of budgets have to treat
 * it differently from every other failure. A fallback provider must not
 * answer instead: the limit applies to the agent, not to one model, and a
 * silent switch would spend what the limit exists to stop while hiding
 * that it was reached. And a channel must not frame it as something going
 * wrong: the message is a sentence written for the person reading it,
 * naming what ran out and what changes it, and `session.failed` says so
 * with `refused`.
 *
 * Thrown by a `ProviderCallGuard`, or subclassed by whoever refuses; the
 * kernel only ever asks `instanceof`.
 */
export class HostRefusalError extends Error {
  /** Recognized across copies of core: a plugin package refuses with its own. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedCoreError(this, HostRefusalError, HOST_REFUSAL_BRAND, value);
  }

  constructor(message: string) {
    super(message);
    this.name = 'HostRefusalError';
    brandCoreError(this, HOST_REFUSAL_BRAND);
  }
}

/**
 * Thrown when a run is stopped by its abort signal. The session ends up
 * `failed` with this error's message as `lastError`, so an aborted turn is
 * distinguishable from a genuine failure.
 *
 * Except a keyed turn aborted with `resumable`: see `RunAbortedError.resumable`.
 */
export class RunAbortedError extends Error {
  /** Recognized across copies of core: a channel package aborts with its own. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedCoreError(this, RunAbortedError, RUN_ABORTED_BRAND, value);
  }

  /**
   * The aborter is going away and the turn can be picked up after it: a
   * host's planned stop or restart. A turn whose message carries an
   * idempotency key is then not failed but left `running`, as a crash
   * leaves it, for the next start to continue once (`continueTurn`); the
   * abort still ends everything it was running. Not for a turn already
   * continued once (`Message.continuedAfterCrash`) or one that could have
   * reached a harness (`Message.hostedLoop`), which are failed, and never
   * for an unkeyed turn, whose caller was promised nothing and is told now.
   */
  readonly resumable: boolean;

  constructor(message = 'Run aborted', options: { resumable?: boolean } = {}) {
    super(message);
    this.name = 'RunAbortedError';
    this.resumable = options.resumable === true;
    brandCoreError(this, RUN_ABORTED_BRAND);
  }
}

/*
 * The channel contract and the executor helpers. Each was its own package
 * (`@stratusagent/channels`, `@stratusagent/executors`): pure contract
 * code released in lockstep with core, which gave plugin authors another
 * package and version to line up and no boundary in return. They live in
 * their own modules here because each is a separately shared surface. The
 * old packages shipped once more, in 0.13.7, as deprecated re-exports of
 * these names, and are gone since.
 */
export {
  createDirectExecutor,
  defineExecutor,
  DirectExecutor,
  failureResult,
  normalizeExecutorError,
  successResult,
  type DirectExecutorErrorContext,
  type DirectExecutorOptions,
  type ExecutorDefinition,
  type ExecutorResultCallRef,
} from './executors.ts';

export {
  admitsSender,
  channelSessionKey,
  isPrincipal,
  senderTrustFor,
  type AdmitPolicy,
  type ChannelAdapter,
  type ChannelCredentialRequest,
  type ChannelSayRequest,
  type ChannelSessionKeyParts,
  type ConversationArchiveRequest,
  type ConversationArchiveResult,
  type ConversationBookmark,
  type ConversationCreateRequest,
  type ConversationCreateResult,
  type ConversationInviteRequest,
  type ConversationInviteResult,
  type ConversationJoinRequest,
  type ConversationJoinResult,
  type ConversationMessage,
  type ConversationReadRequest,
  type ConversationReadResult,
  type GatewayLike,
  type InboundMessage,
  type OutboundAddress,
  type OutboundConnection,
  type OutboundMessageRef,
  type SenderPolicy,
  type SessionRouting,
} from './channels.ts';

// The memory contract, its in-memory store and the memory block's
// rendering, in their own module (see the top of memory.ts).
export {
  type AgentMemoryStore,
  applyMemoryPinBudget,
  asMemoryInjection,
  assertMemoryAboutWithinCap,
  assertMemoryContentWithinCap,
  assertSupersedableMemoryEntry,
  assertUnprotectedMemoryTargets,
  BIDI_CONTROL_CHARACTERS,
  boundMemoryList,
  boundMemoryRead,
  boundRankedMemoryRead,
  buildMemoryInjection,
  clampMemoryRecallLimit,
  collectMemoryTopics,
  compareMemoryChronology,
  compareMemoryRecallOrder,
  effectiveMemoryValidityAt,
  emptyMemoryInjection,
  escapeControlCharacters,
  importableMemoryEntry,
  InMemoryAgentMemoryStore,
  isIsoInstant,
  isMemoryEntryCurrent,
  isMemoryEntryKind,
  isMemoryPassSessionId,
  isMemoryRankingStrategy,
  MEMORY_ABOUT_MAX_BYTES,
  MEMORY_ABOUT_MAX_KEYS,
  MEMORY_ENTRY_KINDS,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_EPISODIC_DEFAULT_TTL_DAYS,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_PASS_KINDS,
  MEMORY_PASS_MAX_MODEL_CALLS,
  MEMORY_PASS_MAX_SAVES,
  MEMORY_PASS_METADATA_KEY,
  MEMORY_PASS_RULES,
  MEMORY_PASS_SESSION_ID_PREFIX,
  MEMORY_PASS_SLICE_MAX_BYTES,
  MEMORY_PINNED_MAX_BYTES,
  MEMORY_RANKING_STRATEGIES,
  MEMORY_READ_MAX_BYTES,
  MEMORY_RECALL_DEFAULT_LIMIT,
  MEMORY_RECALL_MAX_LIMIT,
  MEMORY_RECALL_TOOL_NAME,
  MEMORY_RECENCY_INJECTION_LIMIT,
  MEMORY_RECENCY_MAX_BYTES,
  MEMORY_SAVE_PASS_INSTRUCTION,
  MEMORY_SAVE_PASS_REQUEST,
  MEMORY_TIDY_CHUNK_MAX_BYTES,
  MEMORY_TIDY_GROUP_MIN,
  MEMORY_TIDY_PASS_INSTRUCTION,
  MEMORY_TIDY_PASS_REQUEST,
  type MemoryAppendOptions,
  type MemoryAuditEntry,
  memoryContentByteLength,
  type MemoryEntry,
  memoryEntryAbout,
  memoryEntryFields,
  type MemoryEntryKind,
  memoryEntryTokens,
  memoryEntryTrust,
  type MemoryImportResult,
  type MemoryInjection,
  memoryInjectionEntries,
  type MemoryListOptions,
  type MemoryOrigin,
  type MemoryPassHandle,
  type MemoryPassKind,
  type MemoryPassMode,
  type MemoryPassOutcome,
  type MemoryPassReason,
  type MemoryPassRequest,
  memoryPassSessionId,
  type MemoryPassStatus,
  type MemoryPinnedOptions,
  type MemoryPinOutcome,
  memoryProtectedRefusal,
  type MemoryProvenance,
  memoryQueryMatches,
  type MemoryRankingStrategy,
  type MemoryReadResult,
  memoryRegionHeading,
  type MemorySearchOptions,
  memorySupersededIds,
  memorySupersedesField,
  memorySupersedesWriteIds,
  type MemoryTopic,
  type MemoryUsage,
  type MemoryValidity,
  memoryValidityAt,
  pinnedCapRefusal,
  pinnedInertRefusal,
  renderMemorySection,
  selectMemoryInjection,
  supersededMemoryIdsAt,
  tokenizeMemoryText,
} from './memory.ts';


// The tool contract, in its own module (see the top of tools.ts).
export {
  type ApprovalContext,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ApprovalRefusal,
  type ApprovalVerdict,
  atLeastAsRisky,
  createImageCollector,
  DEFAULT_SUBPROCESS_PASS_ENV,
  DEFAULT_TOOL_RISK,
  describeToolAllowlistFinding,
  type ExecutionContext,
  type Executor,
  filePathsOf,
  isTrustLevel,
  leastTrusted,
  matchesSkillAllowlist,
  matchesToolAllowlist,
  missingSkillRequirements,
  originOf,
  PENDING_APPROVAL_METADATA_KEY,
  type PendingApprovalRecord,
  raiseRiskTo,
  renderToolResultContent,
  resolveCallRisk,
  resolveToolRisk,
  type SkillRequirementFinding,
  type Tool,
  toolAllowlistCovers,
  type ToolAllowlistFinding,
  type ToolAllowlistOptions,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
  type ToolRisk,
  toolScopesOverlap,
  TRUST_LEVELS,
  type TrustLevel,
  type UnlistedTools,
  unmatchedToolAllowlist,
  UNTRUSTED_TOOL_RESULT_NOTE,
} from './tools.ts';


// The provider contract, in its own module (see the top of providers.ts).
export {
  type AgentModelContext,
  type AgentRuntimeContext,
  CONVERSATION_METADATA_KEY,
  type ConversationContext,
  conversationContextFrom,
  type ConversationKind,
  type ModelProvider,
  type ProviderCallCheck,
  type ProviderCallGuard,
  type ProviderCallUsage,
  type ProviderDelta,
  type ProviderPart,
  type ProviderRequest,
  type ProviderResponse,
  type TokenUsage,
  totalTokenUsage,
  transcriptOf,
  uncachedInputTokens,
  type UsageRecord,
} from './providers.ts';


// The skill contract, in its own module (see the top of skills.ts).
export {
  createSkillReadTool,
  DuplicateSkillIdError,
  type Skill,
  SKILL_READ_TOOL_NAME,
  type SkillDescriptor,
  type SkillReadToolOptions,
  SkillRegistry,
  STRATUS_SKILL_ID,
} from './skills.ts';


// The system prompt, in its own module (see the top of system-prompt.ts).
export {
  claudeModelBase,
  DEFAULT_LANGUAGE,
  describeEffort,
  disabledThinkingEffortCeiling,
  EFFORT_LEVELS,
  type EffortLevel,
  effortLevelsFor,
  type EffortResolution,
  isEffortLevel,
  isLanguageTag,
  renderChannelSection,
  renderPersonaSection,
  renderReplySection,
  renderRuntimeSection,
  renderSkillsSection,
  renderSystemPrompt,
  renderSystemPromptParts,
  renderSystemPromptSections,
  resolveEffort,
  type SystemPromptOptions,
  type SystemPromptSection,
  type SystemPromptSectionKind,
} from './system-prompt.ts';


// The credential contract, in its own module (see the top of credentials.ts).
export {
  assertCredentialAllowed,
  type CredentialDelivery,
  type CredentialResolver,
  type CredentialScope,
  EnvCredentialResolver,
  scopeCredentials,
  type ScopedCredentials,
} from './credentials.ts';


// The context window, in its own module (see the top of context.ts).
export {
  CONTEXT_FLOOR_METADATA_KEY,
  CONTEXT_SUMMARY_INSTRUCTION,
  CONTEXT_SUMMARY_METADATA_KEY,
  CONTEXT_SUMMARY_REQUEST,
  contextFloorOf,
  type ContextSummary,
  contextSummaryOf,
  droppedTurnsNote,
  messagesWithinContextFloor,
  raiseContextFloor,
  summarizedTurnsNote,
  transcriptEntry,
  type TranscriptEntryLimits,
} from './context.ts';


// Turns, in their own module (see the top of turns.ts).
export {
  carriesKey,
  completeAnsweredTurn,
  CONTINUE_NOTE,
  isLatestTurn,
  isNoReplyAnswer,
  isReplyOptionalTurn,
  isUnaddressedTurn,
  lastResponseIsAnswer,
  latestTurnReply,
  markPromptDelivered,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  messagesAfterOverheard,
  NO_REPLY_MARKER,
  OVERHEARD_IMAGES_NOTE,
  promptTextOf,
  type PromptTextOptions,
  promptWasDelivered,
  recordTurnFailure,
  redactedError,
  redactSecrets,
  REPLY_OPTIONAL_NOTE,
  SAID_TO_YOU_MARK,
  TURN_LIMIT_NOTE,
  turnFailureFor,
  turnFilesFor,
  turnKeyOf,
  turnMessageOf,
  turnReplyFor,
  UNADDRESSED_TURN_NOTE,
  workItemState,
} from './turns.ts';


// The agent runner, in its own module (see the top of runner.ts).
export {
  abortErrorFor,
  AgentRunner,
  type AgentRunnerOptions,
  AllowAllApprovalPolicy,
  DEFAULT_MAX_TURNS,
  inputProblem,
  leftForNextStart,
  type ObserveEntry,
  type ObserveInput,
  type ResumeInput,
  type RunInput,
  type SteeredMessage,
  TRUST_BEFORE_CALL_TIMEOUT_MS,
} from './runner.ts';
