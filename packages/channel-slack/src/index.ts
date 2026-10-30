import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  filePathsOf,
  isLatestTurn,
  latestTurnReply,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  turnFailureFor,
  turnFilesFor,
  turnReplyFor,
  CONVERSATION_METADATA_KEY,
  SENDER_TRUST_METADATA_KEY,
  sessionWriteTrust,
  imageDimensions,
  isImageAttachmentMediaType,
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES,
  escapeControlCharacters,
  HostRefusalError,
  RunAbortedError,
  type AlwaysMeans,
  type CredentialScope,
  type ApprovalAnswer,
  type ImageAttachment,
  type ImageAttachmentMediaType,
  type JsonObject,
  leastTrusted,
  sessionTrustOf,
  SESSION_TRUST_METADATA_KEY,
  type AgentWorkspaces,
  type ListensMode,
  type ProviderPart,
  type Session,
  type StratusEvent,
  type ToolResult,
  type TrustLevel,
  admitsSender,
  channelSessionKey,
  senderTrustFor,
  type AdmitPolicy,
  type ChannelAdapter,
  type ChannelCredentialRequest,
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
  type OutboundAddress,
  type OutboundConnection,
  type OutboundMessageRef,
  type SessionRouting,
} from '@stratusagent/core';

import { codeRunsOf, toSlackMrkdwn } from './mrkdwn.ts';
import { textingParts } from './texts.ts';

/**
 * The longest display name the model is shown. Slack caps profile names
 * well under this; the bound is for a profile that is not a name.
 */
const MAX_DISPLAY_NAME_LENGTH = 80;

const SLACK_MAX_MESSAGE_CHARS = 4000;
const DEFAULT_EDIT_INTERVAL_MS = 1000;
const DEDUPE_CAPACITY = 2000;
/**
 * How many threads' addressees are remembered in receipt order. Past this
 * the least recently addressed is dropped, which costs its next follow-up
 * one session lookup — the durable answer, which is what a restart falls
 * back to anyway.
 */
const THREAD_ADDRESSEE_CAPACITY = 2000;
/**
 * How many cold verdicts are remembered. Far smaller than the addressee
 * map: one is wanted only while the agents sharing a thread resolve the
 * same message, and the addressee record answers for every message after.
 */
const COLD_VERDICT_CAPACITY = 256;
/**
 * How many of one person's mentions one thread remembers (card 541). Only
 * has to span the lag between two sockets, like `THREAD_HANDOVER_DEPTH`.
 */
const SENDER_ADDRESSEE_DEPTH = 8;
/**
 * How many people one thread remembers an addressee for. Past this the
 * least recently heard is forgotten, and their next untagged reply goes to
 * the thread's owner, as after a restart.
 */
const THREAD_SENDER_CAPACITY = 64;
/**
 * How many claims on one thread it remembers.
 *
 * A message older than all of them asks the sessions instead, which answer
 * for the thread as it stands rather than as it stood — so a reply that old
 * can be resolved to the agent holding the thread now. That is the cost of
 * bounding this, and something has to bound it: the alternative is a list
 * that grows with a conversation for the life of the daemon.
 *
 * A claim is a change of hands or a reply that landed (see
 * `rememberAddressee`), so a busy thread writes one or two per message.
 * Thirty-two sits far past the case the record covers: it only has to
 * span the lag between two sockets, which is messages inside one delivery
 * window, and crossing it needs that many replies in one thread while a
 * socket stays behind for all of them.
 */
const THREAD_HANDOVER_DEPTH = 32;

/**
 * How far past this host's clock at `start()` claims count as seen live
 * (card 562). Slack stamps messages by its own clock, so a host clock
 * behind Slack's would date a message sent just before the restart as
 * after it, and a read stopping there would look complete. Reads for
 * messages in this first stretch are treated as stopping short, which
 * costs a thread read or two, never a wrong placement.
 */
const LIVE_FROM_MARGIN_MS = 60_000;

/** `liveFrom` while `start()` runs: later than any message. */
const NOT_LIVE_YET = '9999999999.999999';
/**
 * How many agent mentions one thread admits in a row before a person has
 * to speak there again (card 513): enough for a question, an answer and a
 * follow-up each way, and a stop to two agents tagging each other forever.
 * Counted per daemon, in memory; a restart starts it again.
 */
export const AGENT_MENTION_HOP_LIMIT = 4;
/**
 * How many files an unrendered turn may queue for its outcome. Nothing
 * drains that queue until the outcome arrives, so a session whose outcome
 * this process never sees would otherwise grow it for the life of the
 * daemon. Twenty is well past what one turn produces in practice, and
 * passing it is reported rather than swallowed.
 */
const MAX_UNRENDERED_FILES = 20;

const PLACEHOLDER_TEXT = '…';

/** What the loading status says while a turn works, and while it runs a tool. */
const THINKING_STATUS = 'is thinking…';
const toolStatus = (toolName: string): string => `is running ${toolName}…`;
/**
 * The same step as a line of its own, for Slack's `loading_messages`
 * ("is running shell.run…" -> "Running shell.run…"). Slack's agent sessions
 * show their own generic text ("Finding answers…") in place of `status`,
 * and rotate these instead. None for the clear: Slack wants one to ten,
 * and the empty status alone takes the indicator down.
 */
const loadingMessage = (status: string): string | undefined => {
  const step = status.replace(/^is /, '');
  return step === '' ? undefined : step.charAt(0).toUpperCase() + step.slice(1);
};

/**
 * How often a loading status is set again while its turn runs. Slack drops
 * one after two minutes with no message, and a long turn — a tool, an
 * approval wait — is exactly the one whose status must not vanish.
 */
const STATUS_REFRESH_MS = 60_000;

/**
 * A 5 MB image over a slow link is seconds, not minutes. Past this the
 * downloads are abandoned and the turn runs with the attachments named as
 * unreadable, rather than the thread waiting on them. One deadline for
 * the whole message, not one per file: a message may carry ten, and ten
 * stalls in a row would hold the thread — and `stop()` — ten times as
 * long.
 */
const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * How long `stop()` waits on a socket that is still starting (card 935).
 * Well inside the gateway's shutdown window, so a socket stuck connecting
 * is reported by name rather than as the whole window running out.
 */
const DEFAULT_STOP_WAIT_MS = 10_000;
/**
 * How long an approval prompt waits for the words its turn wrote before the
 * call to land first (card 950). Long enough for an ordinary post, short
 * enough that a slow or refusing Slack never keeps the question from an
 * approver: the turn is parked on that answer.
 */
const DEFAULT_APPROVAL_PROMPT_WAIT_MS = 5_000;

/**
 * How long a task works before its progress message opens (card 949): long
 * enough that a quick answer, a lookup or two, is just its reply; short
 * enough that a task taking minutes shows what it is doing while it does.
 */
const DEFAULT_PROGRESS_AFTER_MS = 10_000;

/** Room kept for a progress message's first line and its `…` when its notes are trimmed. */
const PROGRESS_HEADER_ROOM = 200;

/**
 * The most a progress message holds under its first line. Words longer than
 * this are content, not a step — an analysis written before a tool call —
 * and are posted whole as messages of their own, as before card 949, rather
 * than cut to fit and lost.
 */
const PROGRESS_NOTE_ROOM = SLACK_MAX_MESSAGE_CHARS - PROGRESS_HEADER_ROOM;

/** How a turn with a progress message ended, for that message's last edit. */
type ProgressEnd = 'done' | 'stopped' | 'failed';

/** What a progress message's first line is made of: the turn's own tool events, never its words. */
interface ProgressState {
  steps: number;
  /** Calls started and not yet settled, by call id: more than one when tools run side by side. */
  running: Map<string, string>;
  waitingOn: string | undefined;
  end: ProgressEnd | undefined;
}

const stepCount = (steps: number): string => `${steps} ${steps === 1 ? 'step' : 'steps'}`;

/** A tool's name as code, which no backtick of its own can close early. */
const toolCode = (toolName: string): string => `\`${escapeSlackText(toolName.replace(/`/g, ''))}\``;

/**
 * The first line of a progress message: what the turn is doing, from the
 * tool calls it made and is making. Words the model wrote are under it, as
 * notes; this line is the part that cannot claim more than happened.
 */
const progressHeader = (state: ProgressState): string => {
  switch (state.end) {
    case 'done':
      return `✓ Done · ${stepCount(state.steps)}`;
    case 'stopped':
      return `■ Stopped after ${stepCount(state.steps)}`;
    case 'failed':
      return `✗ Failed after ${stepCount(state.steps)}`;
    default:
      break;
  }
  if (state.waitingOn !== undefined) {
    return `⏸ Waiting for approval to run ${toolCode(state.waitingOn)}`;
  }
  const latest = [...state.running.values()].at(-1);
  if (latest !== undefined) {
    return `⚙ Working · step ${state.steps}: ${toolCode(latest)}`;
  }
  return `⚙ Working · ${stepCount(state.steps)} done`;
};

/** Resolves when `work` settles or after `ms`, whichever is first; never rejects. */
const settledWithin = (work: Promise<unknown>, ms: number): Promise<void> => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  const done = (): void => {
    clearTimeout(timer);
    resolve();
  };
  work.then(done, done);
});
/** What a turn that produced no text puts in its message, wherever it is posted from. */
const NO_REPLY_TEXT = '(no reply)';

/** How an agent's replies appear in Slack; see `SlackAgentConfig.replies`. */
export type SlackReplyMode = 'final' | 'stream' | 'texts';

/** One agent's Slack identity: its own app (avatar, presence) and tokens. */
export interface SlackAgentConfig {
  agentId: string;
  appToken: string;
  botToken: string;
  /**
   * Slack user ids allowed to answer this agent's approval requests.
   * Authorization is by ACTOR, never by delivery: a request posted into a
   * shared thread is visible to everyone there, and one of them clicking
   * **Always allow** would otherwise widen what the agent may do unattended
   * for the rest of the session. Empty (or absent) means nobody can
   * approve, so requests are declined on arrival rather than left hanging.
   */
  approvers?: string[];
  /**
   * Where to ask when the turn is not itself happening in Slack — a
   * schedule-driven turn, a delegate, an HTTP dispatch. Defaults to the
   * conversation the turn came from, which is where the person waiting on
   * the answer already is.
   */
  approvalChannel?: string;
  /**
   * Slack user ids whose messages are the operator's: a turn from one of
   * them arrives as `user`, a turn from anyone else as `unknown`. The
   * adapter's own admission checks — has a user, is not a bot, is a DM or
   * a mention — establish nothing about who is typing, since any member of
   * the workspace can open a DM or type an `@mention`; this list is what
   * makes `user` mean something. Evaluated on every message, because a
   * thread keys one session for everyone in it. Empty or absent means
   * nobody is, and every sender is `unknown`.
   */
  principals?: string[];
  /**
   * Whether an unlisted sender gets a turn at all. `principals` refuses
   * them before a turn starts and does not let the agent overhear them
   * either; `anyone` admits them as `unknown`. Absent here means `anyone`,
   * for embedders that predate the option. The daemon always passes it:
   * its config resolves an absent `principals.admit` to `principals` — the text
   * would be in the transcript, which is what this mode exists to keep
   * out. The label above is provenance; this is authorization.
   */
  admit?: AdmitPolicy;
  /**
   * How replies appear. `final` (the default) shows Slack's loading status
   * while the turn runs and posts the reply once, finished; `stream` posts
   * a `…` placeholder at once and edits it as the reply is written;
   * `texts` is `final` with each paragraph posted as a message of its own,
   * like texting (card 951, see `textingParts`).
   */
  replies?: SlackReplyMode;
  /**
   * `false` posts this agent's messages without link and media previews
   * (Slack's `unfurl_links`/`unfurl_media`). Absent or `true` leaves
   * Slack's default, which previews them.
   */
  linkPreviews?: boolean;
  /**
   * Channel ids where a new top-level message from an admitted sender is
   * this agent's to answer without a mention: the channel people come to
   * when they want this agent. A message there that names another agent
   * is that agent's. Threads follow the soul's `listens` as anywhere else.
   * One channel has one home agent: when two in the same workspace list
   * it, neither owns it, both answer there only when mentioned, and the
   * adapter warns at startup.
   */
  homeChannels?: string[];
  /**
   * Whether this agent answers a mention from another agent's Slack bot
   * (card 513). Absent, the default, it ignores every bot, as it always
   * has. Present, it answers a team agent that names it: one of this
   * daemon's own agents, or one listed in `team` (name -> bot user id,
   * for agents served by other daemons). `only`, when set, narrows that
   * to the named team agents. Never any other bot. What a team agent says
   * is labelled `unknown`, below a principal, since nothing here can see
   * what its words were built from; it can't stop a turn or answer an
   * approval, and a thread stops taking agent mentions at
   * `AGENT_MENTION_HOP_LIMIT` until a person speaks there.
   */
  agentMentions?: { team?: Record<string, string>; only?: string[] };
}

// The thin surfaces of the Slack SDKs the adapter touches — injectable so
// tests run against fakes with no network. The real factories below wrap
// @slack/socket-mode and @slack/web-api.
export interface SlackSocketEventArgs {
  ack: (response?: unknown) => Promise<void>;
  envelope_id?: string;
  body?: {
    team_id?: string;
    event_id?: string;
    /** Events API: the conversation is shared with another organization (Slack Connect). Current on every event. */
    is_ext_shared_channel?: boolean;
    /** `block_actions` or `view_submission`, for the interactions this adapter handles. */
    type?: string;
    /** block_actions only: what `views.open` needs to put a form in front of the clicker. */
    trigger_id?: string;
    /** view_submission only: the form, what it was opened for, and what was entered. */
    view?: {
      callback_id?: string;
      private_metadata?: string;
      state?: { values?: Record<string, Record<string, { value?: string | null }>> };
    };
    /** block_actions only: who clicked. The one field authorization reads. */
    user?: { id?: string };
    actions?: SlackBlockAction[];
    channel?: { id?: string };
    /**
     * block_actions only: the message the click came from, as Slack holds
     * it at the moment it processes the interaction — so `blocks` is the
     * message's real current state, not what the clicking client had
     * rendered.
     */
    message?: { ts?: string; thread_ts?: string; blocks?: SlackBlock[] };
  };
  event?: SlackInboundEvent;
  retry_num?: number;
}

export interface SlackBlockAction {
  action_id?: string;
  /** The request id the button carries. */
  value?: string;
}

/** Block Kit is structural, not typed here beyond what the adapter emits. */
export type SlackBlock = Record<string, unknown>;

export interface SlackInboundEvent {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  /**
   * Who wrote the message that opened this thread, on a reply in one.
   * Slack sets it on threaded `message` events; an app's own post carries
   * its bot user id here.
   */
  parent_user_id?: string;
  channel: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  /**
   * Attachments on a `file_share` message. Slack puts the file metadata in
   * the event and the bytes behind an authenticated URL that needs
   * `files:read`. An image the model can take is downloaded and sent with
   * the message (see `readImageAttachments`); anything else — a log, a
   * PDF, an image too large or in a format the API refuses — reaches the
   * turn by name only, told that it cannot be opened.
   */
  files?: SlackInboundFile[];
}

/** A message a backfill reads: the shape `message.read` reads too. */
export type SlackThreadMessage = SlackHistoryMessage;

/**
 * How much of a thread a late arrival is handed: the parent, which is
 * usually the question, and the newest messages before the mention. A
 * longer thread is cut in the middle and says so, rather than flooding the
 * opening turn or dropping the message that started it.
 */
const EARLIER_MESSAGE_LIMIT = 40;
/** The most pages of 200 read from a thread for that: 4,000 replies. */
const EARLIER_THREAD_PAGES = 20;

/**
 * The holder-record name for a bot this adapter does not serve: an agent on
 * another gateway, or any other app. The colon keeps it from ever equaling
 * an agent id, so the holder rule reads it as "somebody else's".
 */
const FOREIGN_SPEAKER_PREFIX = 'slack-bot:';

/**
 * A thread read for the cold routing question: where each agent first
 * (`held`) and last (`last`) held the thread, where another app first and
 * last spoke, and each agent's own messages with whether it had been asked.
 */
type ThreadPositions = {
  held: Map<string, number>;
  last: Map<string, number>;
  foreign: number;
  lastForeign: number;
  /** `ts` is the message's own, kept as Slack wrote it for the live record. */
  posts: Array<{ agentId: string; at: number; ts: string; asked: boolean }>;
};
/**
 * At the top of a channel, how many of its most recent messages a mention
 * opens with, and how many are read to find them.
 */
const EARLIER_CHANNEL_LIMIT = 20;
const EARLIER_CHANNEL_READ = 100;
/** The most pages read to find them: 1,000 messages. */
const EARLIER_CHANNEL_PAGES = 10;

/** The slice of Slack's file object the adapter reads. */
export interface SlackInboundFile {
  id?: string;
  name?: string;
  title?: string;
  /** Slack's own `image/png`-style type, decided by the uploader's client. */
  mimetype?: string;
  /** Bytes, as Slack reports them; checked before anything is downloaded. */
  size?: number;
  url_private?: string;
  url_private_download?: string;
  /**
   * Slack's scaled copies of an image, each behind its own private URL
   * that the same `files:read` token opens, named for the longest side
   * they fit. One of these is what an image too big for the model is sent
   * as (see `readImageAttachments`).
   */
  thumb_360?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_800?: string;
  thumb_960?: string;
  thumb_1024?: string;
}

/**
 * What came back from fetching a file's private URL. Slack answers a
 * request the app is not allowed to make — a token without `files:read` —
 * with a **200 and a sign-in page**, never an error status, which is why
 * the content type travels: it is the only thing that tells an image from
 * an HTML apology for one.
 */
export interface SlackFileDownload {
  status: number;
  contentType?: string;
  body: Buffer;
  /**
   * Set when the body was cut off at `maxBytes`: what is in `body` is not
   * the file, only proof that the file was bigger than the caller would
   * take.
   */
  truncated?: boolean;
}

/**
 * Fetches a file's private URL with the bot token. `signal` is the
 * download's deadline, and a fetcher MUST stop on it — headers and body
 * both: the download runs inside the session's intake chain, so one that
 * stalls holds every later message in the thread, and `stop()` waits on
 * the handler too. `maxBytes` is the most body a fetcher may buffer; one
 * that reads past it MUST stop there and report `truncated`, because
 * Slack's reported size is advisory and a response is not.
 */
export type SlackFileFetcher = (url: string, botToken: string, signal: AbortSignal, maxBytes: number) => Promise<SlackFileDownload>;

export interface SlackSocketLike {
  on(eventName: string, listener: (args: SlackSocketEventArgs) => unknown): void;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

/**
 * What `files.uploadV2` answers with, as much of it as is read here: the
 * file's shares, each carrying the ts of the message the file became in a
 * channel — where it sits in the thread. Whether a just-completed upload's
 * shares are filled in yet is Slack's business, so every part is optional
 * and a reader without one falls back (see `ReplyRenderer.queueUpload`).
 */
export interface SlackUploadResult {
  files?: Array<{
    shares?: {
      public?: Record<string, Array<{ ts?: string }>>;
      private?: Record<string, Array<{ ts?: string }>>;
    };
  }>;
}

export interface SlackHistoryArgs {
  channel: string;
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
  limit?: number;
  cursor?: string;
}

/** The fields of a Slack message a read returns; everything else is dropped. */
export interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  user_profile?: { display_name?: string; real_name?: string };
  text?: string;
  /** Set on joins, topic changes and the like; a backfill skips them. */
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  /** The same file objects an event carries, so a read can fetch an image. */
  files?: SlackInboundFile[];
}

export interface SlackHistoryPage {
  messages?: SlackHistoryMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackWebLike {
  auth: { test(): Promise<{ user_id?: string; team_id?: string; response_metadata?: { scopes?: string[] } }> };
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: SlackBlock[]; unfurl_links?: boolean; unfurl_media?: boolean }): Promise<{ ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<unknown>;
    /**
     * Take a message back. The one caller is a turn nobody asked for that
     * opened its placeholder for an attempt the provider then abandoned and
     * decided on silence after all — see `ReplyRenderer.retract`.
     */
    delete(args: { channel: string; ts: string }): Promise<unknown>;
    /**
     * Visible only to `user`. Refusing a click needs to reach the person
     * who clicked without announcing to the channel that they tried.
     */
    postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string }): Promise<unknown>;
  };
  /**
   * Slack's loading status for a thread — "is thinking…" under the agent's
   * name until it replies. Optional: an older SDK, or a fake, without it
   * leaves a `final` reply with no status, never without the reply.
   * `chat:write` is enough for it in channels since March 2026.
   */
  assistant?: {
    threads: {
      setStatus(args: { channel_id: string; thread_ts: string; status: string; loading_messages?: string[] }): Promise<unknown>;
    };
  };
  files: {
    // The real SDK takes file DATA (a buffer or stream), never a path
    // string — typing it that way here keeps fakes honest too.
    uploadV2(args: { channel_id: string; file: Buffer; filename?: string; title?: string; thread_ts?: string }): Promise<SlackUploadResult>;
  };
  conversations: {
    /**
     * What backs destination validation: whether a conversation exists as
     * this app sees it, and whether the app is in it. Needs the
     * conversations read scopes (`channels:read`, `groups:read`,
     * `im:read`, `mpim:read`) — see the README's app manifest.
     */
    info(args: { channel: string; include_num_members?: boolean }): Promise<{
      channel?: {
        id?: string;
        name?: string;
        is_member?: boolean;
        is_im?: boolean;
        is_private?: boolean;
        is_mpim?: boolean;
        /** A channel, public or private, as Slack states it. */
        is_channel?: boolean;
        /** A private channel in Slack's older model (group DMs set `is_mpim` too). */
        is_group?: boolean;
        num_members?: number;
        /** Shared with another organization through Slack Connect. */
        is_ext_shared?: boolean;
        /** Shared across workspaces of an Enterprise Grid organization. */
        is_org_shared?: boolean;
        /** Shared with another workspace in any way. */
        is_shared?: boolean;
        /** A Slack Connect invitation is out and not yet accepted. */
        is_pending_ext_shared?: boolean;
        is_archived?: boolean;
        /** The user who created it; for a channel an app made, the app's bot user. Never changes. */
        creator?: string;
      };
    }>;
    /**
     * Who is in a conversation, a page at a time. Asked before a credential
     * form goes into a private one, so it never lands where no approver can
     * see it. Same read scopes as `info`.
     */
    members(args: { channel: string; cursor?: string; limit?: number }): Promise<{
      members?: string[];
      response_metadata?: { next_cursor?: string };
    }>;
    /**
     * A conversation's top level, newest first, a page at a time — what
     * `message.read` without a thread reads. Needs the history scopes the
     * manifest already asks for. Optional so an older fake still runs; an
     * adapter without it says the conversation cannot be read.
     */
    history?(args: SlackHistoryArgs): Promise<SlackHistoryPage>;
    /** One thread, root first, a page at a time. Same scopes as `history`. */
    replies?(args: SlackHistoryArgs & { ts: string }): Promise<SlackHistoryPage>;
    /**
     * Makes a channel, with the calling app as its first member — what
     * `channel.create` runs on. Needs `channels:manage` for a public one and
     * `groups:write` for a private one, which the default manifest leaves
     * out; the same two cover `setTopic`, `setPurpose` and `invite`.
     * Optional, like everything below it: an older SDK or fake without them
     * says it cannot create channels.
     */
    create?(args: { name: string; is_private: boolean }): Promise<{ channel?: { id?: string; name?: string } }>;
    setTopic?(args: { channel: string; topic: string }): Promise<unknown>;
    setPurpose?(args: { channel: string; purpose: string }): Promise<unknown>;
    /**
     * Invites up to 1,000 users at once. With `force`, the valid ones are
     * invited even when another id fails; each failure is listed in
     * `errors`, on the answer or on the error the SDK throws.
     */
    invite?(args: { channel: string; users: string; force?: boolean }): Promise<{
      errors?: Array<{ user?: string; error?: string }>;
    }>;
    /**
     * Joins a public channel as the calling app — what `channel.join` runs
     * on. Needs `channels:join`, which the default manifest leaves out.
     * Joining twice succeeds with an `already_in_channel` warning.
     */
    join?(args: { channel: string }): Promise<{
      channel?: { id?: string };
      warning?: string;
      response_metadata?: { warnings?: string[] };
    }>;
    /**
     * Archives a channel — what `channel.archive` runs on. Same scopes as
     * `create` (`channels:manage` public, `groups:write` private). There
     * is no way back for an app: bot tokens can't unarchive.
     */
    archive?(args: { channel: string }): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<{ user?: { name?: string; profile?: { display_name?: string; real_name?: string } } }>;
  };
  /**
   * A channel's bookmarks, all of them in one call (Slack has no paging
   * here and allows 100 per channel), listed on the first page of a
   * top-level `message.read`. Needs `bookmarks:read`, which the manifest
   * asks for; an app without it reads messages as before and is told the
   * scope is missing. Optional so an older SDK or fake still reads.
   */
  bookmarks?: {
    list(args: { channel_id: string }): Promise<{ bookmarks?: Array<{ title?: string; link?: string }> }>;
  };
  /**
   * Opens a modal, which is how a credential is entered: its answer comes
   * back as a `view_submission` to this app and never becomes a message in
   * the conversation. Optional so a fake without it still runs; an adapter
   * without it tells the clicker it cannot open the form.
   */
  views?: {
    open(args: { trigger_id: string; view: SlackBlock }): Promise<unknown>;
  };
}

export interface SlackAdapterOptions {
  agents: SlackAgentConfig[];
  /**
   * The agents to carry now, read again on every `reload()`: what the
   * daemon passes so a Slack app stored while it runs connects without a
   * restart. Without it, the adapter has no `reload` and carries `agents`
   * until it stops.
   */
  loadAgents?: () => Promise<SlackAgentConfig[]>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Minimum gap between streaming edits per message (chat.update rate limits). */
  editIntervalMs?: number;
  /** Test injection: build a Socket Mode client for an app token. */
  createSocketClient?: (appToken: string) => SlackSocketLike;
  /** Test injection: build a Web API client for a bot token. */
  createWebClient?: (botToken: string) => SlackWebLike;
  /**
   * Test injection: fetch a file's private URL with the bot token. The
   * Web API client has no call for this — file bytes are served from a
   * plain authenticated URL — so it is its own seam. Only ever handed
   * URLs on `https://files.slack.com`: the adapter refuses any other
   * before calling it (see `onlySlackFileHost`).
   */
  fetchFile?: SlackFileFetcher;
  /**
   * How long one message's attachment downloads may take, all of them
   * together, before the turn goes on without whatever has not arrived.
   * Defaults to `DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS`.
   */
  fileDownloadTimeoutMs?: number;
  /**
   * How long `stop()` waits on a socket a reload or start is still
   * starting before it rejects, naming that agent. Defaults to
   * `DEFAULT_STOP_WAIT_MS`.
   */
  stopWaitMs?: number;
  /**
   * How long an approval prompt waits for the words its turn wrote before
   * the call to be posted first. Defaults to
   * `DEFAULT_APPROVAL_PROMPT_WAIT_MS`.
   */
  approvalPromptWaitMs?: number;
  /**
   * How long a task works before its progress message opens (card 949).
   * Words the model writes after its first line open it at once. Defaults
   * to `DEFAULT_PROGRESS_AFTER_MS`.
   */
  progressAfterMs?: number;
  /**
   * Where a text attachment too large to read into the message is saved
   * instead, so the turn can be told a path rather than only a name.
   *
   * Both halves or neither: the file holds what a Slack member sent, and
   * read back through `fs.read` without a ledger record it would arrive as
   * the agent's own notes — the laundering the ledger exists to stop. So the
   * path is recorded at the sender's label before the bytes land, as
   * `plugin-mcp` does for a server's files. Without this option such a file
   * reaches the turn as a name only, as before.
   */
  attachmentStore?: {
    workspaces: AgentWorkspaces;
    /** The host's tainted-write ledger, the one `tool-fs` reads. */
    ledger: { recordWrite(agentId: string, absolutePath: string, trust: TrustLevel): Promise<void> };
    /**
     * The most one agent's saved attachments may weigh together, so anyone
     * admitted to talk to the agent cannot fill the host's disk. A save that
     * would pass it is refused (the file is a name-only note and the log
     * says where to make room); nothing is deleted. Defaults to 256 MB.
     */
    maxBytes?: number;
  };
  /**
   * Test injection: the clock, in milliseconds, that an upload's place in
   * the thread is read from (`ReplyOutcome.spokeAt`) when the upload's
   * answer carries no share ts, and that dates `start()`, after which every
   * claim in a thread is seen live. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Where to keep the messages addressed to an agent while the daemon was
   * restarting or stopping, so the next start answers them. The gateway
   * keeps channels connected through its drain and refuses new turns then
   * (`GatewayStoppingError`); a message refused that way is told the agent
   * is restarting and is written here — conversation, ts, thread, sender and
   * channel type, never its text — then read back from Slack and handled
   * as if it had just arrived once the adapter starts again. Without it, the
   * refusal is said and nothing is kept.
   */
  pendingIntakePath?: string;
}

/** What a person who wrote during a restart is told, when it was kept. */
export const RESTARTING_REPLY_TEXT = "I'm restarting right now. I'll answer this as soon as I'm back.";
/** The same, for a daemon that is stopping rather than restarting. */
export const STOPPING_REPLY_TEXT = "I'm shutting down right now. I'll answer this when I'm started again.";
/**
 * How old a kept message may be and still be answered at start: a daemon
 * stopped for a week does not wake up to answer last week's questions.
 */
const PENDING_INTAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long the start-up replay waits on Slack to read one kept message
 * back. Past it, that message (and any kept after it in its conversation)
 * is left for the next start rather than answered late; see `replayHolds`.
 */
const REPLAY_READ_MAX_MS = 10_000;
/** The most messages kept at once; past it, a new one is refused, not kept. */
const PENDING_INTAKE_MAX = 200;

/** A message kept across a restart (see `pendingIntakePath`). No text. */
interface PendingIntake {
  agentId: string;
  team: string;
  channel: string;
  ts: string;
  threadTs?: string;
  user: string;
  channelType?: string;
  /** When it was kept, in epoch milliseconds. */
  keptAt: number;
}

const isPendingIntake = (value: unknown): value is PendingIntake => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const optionalString = (field: unknown): boolean => field === undefined || typeof field === 'string';
  return typeof entry.agentId === 'string' && typeof entry.team === 'string' && typeof entry.channel === 'string'
    && typeof entry.ts === 'string' && typeof entry.user === 'string' && typeof entry.keptAt === 'number'
    && optionalString(entry.threadTs) && optionalString(entry.channelType);
};

// Lazy (and CJS-interoperable) so tests with injected fakes never load the
// real SDK stack.
const requireModule = createRequire(import.meta.url);

const defaultSocketClient = (appToken: string): SlackSocketLike => {
  const { SocketModeClient } = requireModule('@slack/socket-mode') as typeof import('@slack/socket-mode');
  return new SocketModeClient({ appToken }) as unknown as SlackSocketLike;
};

/**
 * Scopes the manifest asks for. An app created before they shipped has
 * fewer, and some features silently break — threads are answered without
 * their context, images arrive as names. Checked once at connect, so the
 * operator finds out at start, not at the first broken thread.
 *
 * Events (`message.channels`, `message.groups`, …) cannot be read from a
 * bot token, so the warning says they are needed too.
 */
const REQUIRED_SCOPES: readonly string[] = [
  'app_mentions:read',
  'channels:history', 'channels:read',
  'chat:write',
  'files:read', 'files:write',
  'groups:history', 'groups:read',
  'im:history', 'im:read', 'im:write',
  'mpim:history', 'mpim:read',
  'users:read',
];

const checkBotScopes = (
  agentId: string,
  granted: readonly string[],
  warn: (message: string) => void,
): void => {
  const have = new Set(granted);
  const missing = REQUIRED_SCOPES.filter((scope) => !have.has(scope));
  if (missing.length === 0) {
    return;
  }
  warn(
    `slack: ${agentId}'s app is missing bot scopes: ${missing.join(', ')}. `
    + 'Add them under OAuth & Permissions, add the matching message.* events '
    + 'under Event Subscriptions, and reinstall the app to the workspace. '
    + 'Without them, some features (thread follow-through, image viewing, '
    + 'channel history) will silently fail.',
  );
};

/**
 * A client whose every post goes out without link or media previews, for
 * an agent configured with `linkPreviews: false`. Applied once around the
 * client, so no post site can forget it. `chat.update` takes no unfurl
 * flags; an edited placeholder keeps the post's own setting.
 */
export const withoutLinkPreviews = (web: SlackWebLike): SlackWebLike => {
  // Delegating objects, not copies: everything else on the client (and a
  // method replaced on it later) is still reached through the original.
  const chat = Object.create(web.chat) as SlackWebLike['chat'];
  chat.postMessage = (args) => web.chat.postMessage({ ...args, unfurl_links: false, unfurl_media: false });
  const wrapped = Object.create(web) as SlackWebLike;
  wrapped.chat = chat;
  return wrapped;
};

const defaultWebClient = (botToken: string): SlackWebLike => {
  const { WebClient } = requireModule('@slack/web-api') as typeof import('@slack/web-api');
  return new WebClient(botToken) as unknown as SlackWebLike;
};

/**
 * The default fetcher over a `fetch`. Exported as a factory so the bounded
 * read can be tested against a fake `fetch` with a body that never ends;
 * the adapter uses it over the global one.
 *
 * The body is read a chunk at a time and abandoned the moment it passes
 * `maxBytes`: `arrayBuffer()` would buffer the whole response first, and
 * the size the adapter checked before asking came from Slack's metadata,
 * which an oversized response is under no obligation to match. A
 * `content-length` that already says too much is refused before a byte is
 * read.
 */
export const createSlackFileFetcher = (fetchImpl: typeof fetch): SlackFileFetcher => async (url, botToken, signal, maxBytes) => {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` }, signal });
  const contentType = response.headers.get('content-type');
  const typed = contentType !== null ? { contentType } : {};
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return { status: response.status, ...typed, body: Buffer.alloc(0), truncated: true };
  }
  if (response.body === null) {
    return { status: response.status, ...typed, body: Buffer.alloc(0) };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { status: response.status, ...typed, body: Buffer.alloc(0), truncated: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, ...typed, body: Buffer.concat(chunks) };
};

const defaultFetchFile: SlackFileFetcher = (url, botToken, signal, maxBytes) =>
  createSlackFileFetcher(fetch)(url, botToken, signal, maxBytes);

/**
 * The one origin a file URL may name for the bot token to go with it.
 * `url_private` does not by itself mean Slack hosts the file: for a remote
 * file (an app's pointer to a file it hosts), Slack returns the app's own
 * URL there, on whatever host the app chose, so any app with
 * `remote_files:write` could collect the token of every agent that opened
 * its file. Slack's rule is never to send Slack credentials to such a URL,
 * and to compare the parsed host exactly rather than a prefix
 * (docs.slack.dev, Working with files: Downloading files). Previews and
 * downloads both live here. A redirect elsewhere is not a leak either:
 * fetch drops `authorization` on a cross-origin redirect.
 */
const SLACK_FILE_ORIGIN = 'https://files.slack.com';

/**
 * A fetcher that is only ever handed URLs on Slack's file host. Anything
 * else is refused before a request is made, with a reason that names the
 * origin, and the callers' own handling turns that into a name-only file
 * and an operator warning, as for any download that failed.
 */
const onlySlackFileHost = (fetchFile: SlackFileFetcher): SlackFileFetcher => (url, botToken, signal, maxBytes) => {
  let origin: string | undefined;
  try {
    const parsed = new URL(url);
    // Credentials in the URL would be sent with the token: not Slack's.
    origin = parsed.username === '' && parsed.password === '' ? parsed.origin : `${parsed.protocol}//(credentials)@${parsed.host}`;
  } catch {
    origin = undefined;
  }
  if (origin !== SLACK_FILE_ORIGIN) {
    return Promise.reject(new Error(`${origin ?? 'its link'} is not Slack's file host (${SLACK_FILE_ORIGIN}), so the bot token is not sent there`));
  }
  return fetchFile(url, botToken, signal, maxBytes);
};

/**
 * A hold on a queued renderer's placeholder, taken the moment an earlier
 * turn's outcome arrives and before anything about that outcome is looked
 * up. Reading the routing of a turn nobody rendered is a store round trip,
 * and the turn queued behind it can finish inside that window: without a
 * hold it would finalize its own placeholder away, and the earlier turn's
 * reply and attachments would land below the newer turn's answer — exactly
 * the order the handover exists to prevent. `finalize` waits on the hold,
 * so the placeholder is still there when the lookup comes back.
 *
 * Both methods are idempotent, and one of them must be called: a hold that
 * is neither taken nor released stalls the queued turn's reply.
 */
interface HandoverClaim {
  /**
   * Spend the hold: hand the placeholder to `chunks`, run `between` while
   * this renderer still has no placeholder of its own, and reopen one
   * below. `untaken` when there is nothing to hand over — no placeholder,
   * or the renderer finished before the hold was taken — and the caller
   * posts the chunks itself; `partial` when the placeholder took the first
   * chunk and Slack refused one of the rest.
   */
  take(chunks: readonly string[], between?: () => Promise<void>): Promise<'complete' | 'partial' | 'untaken'>;
  /** Give the hold back unspent, letting the queued turn finish. */
  release(): void;
}

/**
 * What became of a turn's reply. `published`: whether ALL of its text was
 * — the edit taken and every overflow message posted. `spoke`: whether
 * ANYTHING of the turn's landed, a chunk or a file. `spokeAt`: where in
 * the thread what landed sits — the ts of the lowest message of the
 * turn's that Slack took — present exactly when `spoke` is. `refused`:
 * there was text to say and Slack refused some of it, unlike a turn that
 * decided to say nothing, which is unpublished but not refused.
 */
interface ReplyOutcome {
  published: boolean;
  spoke: boolean;
  spokeAt?: string;
  refused?: true;
}

/**
 * The dispatch's idempotency key for a message's dedupe key: the key itself
 * when it fits the gateway's bound, and a digest of it when it does not —
 * an agent id is not length-bounded (overlong ids that predate validation
 * are kept), and a key over the bound would refuse every message for that
 * agent. Deterministic, so a redelivery after a restart maps to the same.
 */
const dispatchKeyFor = (eventKey: string): string =>
  eventKey.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? eventKey : `slack-sha256:${createHash('sha256').update(eventKey).digest('hex')}`;

/**
 * What the report of a turn nobody was rendering got into the thread, part
 * by part: whether its text was said in full (or there was none to say),
 * and which of its files landed. A redelivery waiting behind the report
 * posts only what is missing from it.
 */
interface ReportedOutcome {
  said: boolean;
  landed: readonly string[];
}

const NOTHING_REPORTED: ReportedOutcome = { said: false, landed: [] };

/**
 * How far a file's change time may run past the record of the tool result
 * naming it: the rest of the millisecond the record was stamped in, since
 * the record is whole milliseconds and the file time is finer. No more,
 * because any window is one an overwrite fits inside — two seconds was, in
 * review. A filesystem that rounds file times up, coarser than that, fails
 * closed: the file is warned about and not uploaded, which a repeat can
 * afford and a wrong attachment cannot.
 */
const PRODUCED_AT_SLACK_MS = 1;

/**
 * A file a finished turn produced, read for a repeat of it — refused unless
 * it is provably the file the turn left there. The transcript keeps a path,
 * not the bytes, and a repeat can come after a later turn or another
 * process has written the same path; uploading what is there now would
 * answer the old message with a different file, or a sensitive one.
 *
 * The change time, not the modification time, is what is compared: it
 * moves on every write, on a rename into the path, and on `utimes` itself,
 * so neither an older file renamed in nor a backdated one passes. Then the
 * path has to name the same file before and after it is opened — the open
 * handle's file, when it is not a link — and the handle has to be unchanged
 * after the read, so a swap or a write landing between the checks and the
 * read is caught rather than uploaded.
 */
const readUnchangedSince = async (filePath: string, producedAt: number): Promise<Buffer> => {
  // Exclusive: a change time at or past it was a change after the record.
  const writtenBefore = producedAt + PRODUCED_AT_SLACK_MS;
  const changed = (): Error =>
    new Error('it was changed after the turn that produced it, so it may hold another file now; it was not uploaded.');
  const named = await lstat(filePath);
  if (named.ctimeMs >= writtenBefore) {
    throw changed();
  }
  const handle = await open(filePath, 'r');
  try {
    const opened = await handle.stat();
    const stillNamed = await lstat(filePath);
    const samePath = stillNamed.ino === named.ino && stillNamed.dev === named.dev && stillNamed.ctimeMs === named.ctimeMs;
    const sameFile = named.isSymbolicLink() || (opened.ino === named.ino && opened.dev === named.dev);
    if (!samePath || !sameFile || opened.ctimeMs >= writtenBefore) {
      throw changed();
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (after.ctimeMs !== opened.ctimeMs || after.size !== data.length) {
      throw changed();
    }
    return data;
  } finally {
    await handle.close();
  }
};

/**
 * A clock reading as a Slack timestamp, for a file whose upload answered
 * with no share ts. Slack timestamps are epoch seconds with six decimals,
 * so the clock's reading compares with them as long as the two agree to
 * within the gap between one message and the next.
 */
const slackTs = (ms: number): string => (ms / 1000).toFixed(6);

/**
 * Where an upload sits in the thread: the ts of the message it became in
 * `channel`, from the shares the upload answers with. Undefined when the
 * answer carries none.
 */
const uploadPlace = (result: SlackUploadResult, channel: string): string | undefined => {
  for (const file of result.files ?? []) {
    for (const scope of [file.shares?.public, file.shares?.private]) {
      for (const share of scope?.[channel] ?? []) {
        if (share.ts !== undefined) {
          return share.ts;
        }
      }
    }
  }
  return undefined;
};

/**
 * Renders one turn's reply into Slack, one of two ways. Streaming (the
 * `stream` reply mode): post `…` immediately, fold streaming deltas and
 * tool status lines into throttled edits, and finalize with the
 * authoritative reply. Otherwise (`final`, the default): no placeholder —
 * Slack's loading status says the agent is working, and the finished reply
 * is posted once, so the notification carries the answer rather than a
 * `…`. Either way a reply that outgrows one message is split.
 */
class ReplyRenderer {
  /**
   * Whether the gateway has begun the turn this renderer was opened for.
   * A renderer is queued at intake, before the gateway starts its turn,
   * so until the session reports `running` again the turn at the head of
   * the session's chain may be somebody else's — a recovery still parked
   * on a human — and its completion is not this renderer's to swallow.
   */
  turnStarted = false;
  /**
   * The id this renderer's turn is dispatched under. A gateway that reports
   * its active turn (`activeTurnId`) lets the adapter match an outcome to
   * this renderer exactly, rather than to whichever turn reported `running`
   * next — which, for a session another surface can also dispatch to, may
   * not be this one.
   */
  readonly turnId: string = randomUUID();
  /**
   * What a Slack stop aborts (card 337): the signal this renderer's dispatch
   * runs under, so a stop cancels this turn whether it is running or still
   * queued behind another.
   */
  readonly controller = new AbortController();
  /** The Slack user who stopped this turn, once someone has. */
  stoppedBy: string | undefined;
  private buffer = '';
  /**
   * In `final` mode, what the model has said since its last tool call. A
   * turn that writes "On it, checking the PRs" and then works for an hour
   * should not leave the thread showing only a loading status: text the
   * model wrote before calling a tool is posted when the call starts, as a
   * message of its own, and the finished reply follows it.
   */
  private interim = '';
  /** The last interim message posted, so a reply that repeats it is not posted twice. */
  private lastInterim: string | undefined;
  /** Whether any interim message landed — something said, whatever the reply's fate. */
  private interimPosted = false;
  /** Every interim message that landed whole, in order: what a hosted-loop reply is stripped of. */
  private readonly interimSaid: string[] = [];
  /**
   * Told of each interim message as it is queued — before the reply, and
   * before anything typed while its tool runs — with what of it landed,
   * once that is known, so the thread's other agents hear it in its place.
   */
  private readonly onInterim: ((heard: () => string, landed: Promise<boolean>) => void) | undefined;
  /**
   * Card 949, `final` mode: a task says what it is about to do in a
   * message of its own (its first words before a tool), then keeps ONE
   * progress message up to date — a first line built from its tool events,
   * and under it whatever else it wrote between tools — and posts its reply
   * as a message of its own. Narration that used to be a post per step is
   * an edit, so a long task is three messages, not twenty.
   *
   * Whether this turn's first words have gone out, so later words are notes.
   */
  private firstWordsSaid = false;
  /** Whether the progress message has been asked for; it may not have landed yet. */
  private progressOpen = false;
  /** The progress message, once Slack took it. */
  private progressRef: OutboundMessageRef | undefined;
  /** What the first line says, from this turn's own tool events only. */
  private readonly progress: ProgressState = { steps: 0, running: new Map(), waitingOn: undefined, end: undefined };
  /**
   * The notes under that line, as sent: converted, oldest dropped past one
   * message's room. `shown` once a write that held the note has landed: a
   * note trimmed while its write was still queued never reached anyone.
   */
  private progressNotes: Array<{ text: string; shown?: boolean }> = [];
  /** Whether older notes were dropped for room, so the message says so. */
  private progressNotesCut = false;
  /** Whether the last thing this turn said is a note rather than a message of its own. */
  private lastSaidWasNote = false;
  private progressTimer: NodeJS.Timeout | undefined;
  private progressOpenTimer: NodeJS.Timeout | undefined;
  private lastProgressAt = 0;
  private turnStartedAt = 0;
  /** How the turn ended, for the progress message: a stop or a failure says so before it finalizes. */
  private ending: ProgressEnd = 'done';
  private readonly progressAfterMs: number;
  /** The lowest trust this turn's session was lowered to while it ran (`session.tainted`). */
  taintedTo: TrustLevel | undefined;
  private turnBreakPending = false;
  private toolLine: string | undefined;
  private ref: OutboundMessageRef | undefined;
  private lastEditAt = 0;
  private pendingEdit: NodeJS.Timeout | undefined;
  private editChain: Promise<void> = Promise.resolve();
  private uploadChain: Promise<void> = Promise.resolve();
  /**
   * A handover in progress (`yieldTo`): edits and the finalize wait for it,
   * so a turn that finishes while its placeholder is being given away
   * writes into the fresh one rather than over the reply it was given to.
   */
  private handover: Promise<void> = Promise.resolve();
  /**
   * The report of a turn nobody was rendering, made ahead of this renderer
   * while it waited — through its placeholder or as messages of their own
   * — resolving to what of that outcome reached the thread. Set when the
   * report is claimed, before the turn it reports lets this renderer's
   * dispatch go, so a repeat resolving after it can tell its own turn was
   * that one, and post only what the report did not.
   */
  outcomeReportedAhead: Promise<ReportedOutcome> | undefined;
  /**
   * Bumped by a handover. An edit scheduled before it carries the text of
   * the turn that was handed over — the recovery's stream, routed to this
   * renderer while it was at the head of the queue — and must not land in
   * the placeholder opened for this turn.
   */
  private generation = 0;
  private finalized = false;
  /** Whether any upload of this turn's landed — a file is something said, placeholder or not. */
  private uploaded = false;
  /** Whether any edit of this turn's landed — a streamed line Slack took is something said, whatever the final edit's fate. */
  private edited = false;
  /**
   * Where in the thread this turn's words stand: the ts of the lowest
   * message Slack took them in — the placeholder an edit landed in, or an
   * overflow chunk posted — and, separately, where a file of its landed
   * (the share ts the upload answers with, or the clock — see `queueUpload`).
   * What the thread rule orders by: an untagged reply is for whoever's
   * reply sits lowest in the thread, the one a reader sees last, which is
   * not the turn that finished last — a placeholder posted at intake and
   * filled in slowly sits above a reply posted while it was being written.
   */
  private textAt: string | undefined;
  private uploadedAt: string | undefined;
  /**
   * A turn nobody asked for: the placeholder is not posted at intake but
   * on the first TEXT the turn streams, and a turn that ends having said
   * nothing leaves the thread untouched — no placeholder, no `(no reply)`,
   * no edit. Text and not a tool line, though the spec sketched either: a
   * placeholder posted for a tool the turn ran on the way to deciding it
   * had nothing to add is a message the decision cannot take back.
   */
  readonly lazy: boolean;
  /**
   * Whether this turn streams into a placeholder. When it does not, there
   * is never a placeholder: `finalize` finds none and posts the reply as
   * messages of its own, and a handover has nothing to hand over and says
   * so (`untaken`), so the recovery's reply is posted ahead of this one
   * the ordinary way — both already the paths for a placeholder that
   * could not be opened.
   */
  readonly streaming: boolean;
  /**
   * Whether the reply, and what the turn says before a tool, are posted a
   * paragraph to a message (`texts` mode). Never with `streaming`: there
   * is one placeholder to stream into.
   */
  private readonly texts: boolean;
  /**
   * The thread the loading status belongs to: the reply's thread, or the
   * message itself in a DM, whose reply has no thread to key one on.
   */
  readonly statusThread: string | undefined;
  /** Shared by a connection's renderers, so a status Slack refuses is said once, not per message. */
  private readonly statusWarned: { value: boolean };
  private loading = false;
  /**
   * Status calls, in order, so the last one Slack applies is the last one
   * sent — and so `finalize` can wait for them: a status that reached
   * Slack after the reply would stand over a finished turn until Slack's
   * own timeout, since the post that clears it came first.
   */
  private statusChain: Promise<void> = Promise.resolve();
  /**
   * The turn this one was queued behind has posted everything it will
   * (see `posted`). A streaming turn holds its place with the placeholder
   * it opened at intake; a `final` one has no placeholder, so it waits for
   * this before putting text or files in the thread — or a quick answer
   * would land above the slow one ahead of it.
   */
  private readonly after: Promise<unknown>;
  private settle!: () => void;
  /** Resolves once this turn has put in the thread everything it will. */
  readonly posted: Promise<void> = new Promise<void>((resolve) => {
    this.settle = resolve;
  });
  private statusText: string | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  /** The tool the turn is running, for the status line; the streamed `toolLine` is the other mode's. */
  private runningTool: string | undefined;
  private readonly web: SlackWebLike;
  /**
   * The one person in the conversation when this turn is a DM: whoever sent
   * the message. Undefined in a channel, where who can see a thread is
   * Slack's membership to answer, not this turn's.
   */
  readonly dmWith: string | undefined;
  /** The conversation, and the thread in it, this turn replies into. */
  readonly channel: string;
  readonly threadTs: string | undefined;
  private readonly editIntervalMs: number;
  private readonly warn: (line: string) => void;
  private readonly now: () => number;

  constructor(
    web: SlackWebLike,
    channel: string,
    threadTs: string | undefined,
    editIntervalMs: number,
    warn: (line: string) => void,
    options: {
      lazy?: boolean;
      now?: () => number;
      streaming?: boolean;
      texts?: boolean;
      statusThread?: string;
      statusWarned?: { value: boolean };
      after?: Promise<unknown>;
      dmWith?: string;
      onInterim?: (heard: () => string, landed: Promise<boolean>) => void;
      progressAfterMs?: number;
    } = {},
  ) {
    this.web = web;
    this.channel = channel;
    this.threadTs = threadTs;
    this.editIntervalMs = editIntervalMs;
    this.warn = warn;
    this.lazy = options.lazy ?? false;
    this.now = options.now ?? Date.now;
    this.streaming = options.streaming ?? true;
    this.texts = !this.streaming && options.texts === true;
    this.statusThread = options.statusThread ?? threadTs;
    this.statusWarned = options.statusWarned ?? { value: false };
    this.after = options.after ?? Promise.resolve();
    this.dmWith = options.dmWith;
    this.onInterim = options.onInterim;
    this.progressAfterMs = options.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS;
  }

  /**
   * Show Slack's loading status for this turn, and keep it up until the
   * turn is finalized. Not for a streaming turn, which has its placeholder,
   * nor for one nobody asked for: "is thinking…" over a turn that may
   * decide to say nothing is the interruption silence exists to avoid.
   */
  showLoading(head: boolean): void {
    if (this.streaming || this.lazy || this.loading || this.finalized) {
      return;
    }
    this.loading = true;
    // A thread has one status per app, so a turn queued behind another in
    // the same thread must not publish its own: it would overwrite what the
    // running turn says it is doing. It publishes when it reaches the head
    // (`beginTurn`, or `refreshLoading` once the turn ahead has posted).
    // The caller passes `head` for a queued turn whose status lives on a
    // key of its own — every DM message is — since it overwrites nothing.
    if (head) {
      this.publishLoading();
    }
  }

  private publishLoading(): void {
    if (this.statusTimer || this.finalized) {
      return;
    }
    this.setStatus(this.statusText ?? THINKING_STATUS);
    this.statusTimer = setInterval(() => this.refreshLoading(), STATUS_REFRESH_MS);
    this.statusTimer.unref?.();
  }

  /**
   * Set the status again. Slack clears a thread's status whenever the app
   * posts in it, so a reply or file from the turn ahead of this one — or
   * this turn's own upload — takes it down while this turn is still
   * working; the adapter calls this once that post has landed.
   */
  refreshLoading(): void {
    if (!this.loading || this.finalized) {
      return;
    }
    if (!this.statusTimer) {
      // Queued until now: this is the renderer at the head at last.
      this.publishLoading();
      return;
    }
    this.setStatus(this.statusText ?? THINKING_STATUS);
  }

  private stopLoading(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.loading = false;
  }

  private setStatus(text: string): void {
    const setStatus = this.web.assistant?.threads.setStatus;
    if (!setStatus || this.statusThread === undefined) {
      return;
    }
    this.statusText = text;
    const thread = this.statusThread;
    const loading = loadingMessage(text);
    // Not awaited by the caller: the turn never waits on a status. Only
    // `finalize` does, for the ordering reason on `statusChain`. A refusal
    // — a workspace or plan without it, a token Slack will not honour for
    // it — is said once and then left alone; the reply still arrives,
    // just without the status ahead of it.
    this.statusChain = this.statusChain
      .then(() => setStatus.call(this.web.assistant?.threads, {
        channel_id: this.channel,
        thread_ts: thread,
        status: text,
        ...(loading ? { loading_messages: [loading] } : {}),
      }))
      .then(() => undefined, (error: unknown) => {
        if (!this.statusWarned.value) {
          this.statusWarned.value = true;
          this.warn(
            `slack: could not show a loading status (${error instanceof Error ? error.message : String(error)}); `
            + 'replies still post when they are ready, without one',
          );
        }
      });
  }

  /**
   * The gateway has begun this renderer's turn. Whatever was streamed here
   * before now belonged to the turn ahead of it on the session chain — a
   * recovery's stream, routed to this renderer because it was at the head
   * of the queue — and is dropped, edits already scheduled for it
   * included, so this turn's placeholder starts empty.
   */
  beginTurn(): void {
    if (!this.turnStarted) {
      this.turnStartedAt = Date.now();
    }
    this.turnStarted = true;
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = undefined;
    }
    this.buffer = '';
    this.interim = '';
    this.toolLine = undefined;
    this.runningTool = undefined;
    this.turnBreakPending = false;
    this.generation += 1;
    // Queued until now, this turn publishes its status as it starts; one
    // already showing may be showing a tool the turn ahead of it ran.
    if (this.loading && !this.statusTimer) {
      this.publishLoading();
    } else if (this.loading && this.statusText !== THINKING_STATUS) {
      this.setStatus(THINKING_STATUS);
    }
  }

  async open(): Promise<void> {
    const posted = await this.web.chat.postMessage({
      channel: this.channel,
      text: PLACEHOLDER_TEXT,
      ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
    });
    if (posted.ts) {
      this.ref = { channel: posted.channel ?? this.channel, ts: posted.ts };
    }
  }

  onEvent(event: StratusEvent, ofThisTurn = true): void {
    if (this.finalized) {
      return;
    }
    if (event.type === 'session.tainted') {
      if (ofThisTurn && this.turnStarted) {
        this.taintedTo = this.taintedTo === undefined ? event.trust : leastTrusted(this.taintedTo, event.trust);
      }
      return;
    }
    if (event.type === 'provider.delta' && event.delta.type === 'text') {
      // Text from a new provider turn (after tools ran) must not fuse
      // with the previous turn's — "I'll check.The result is…" reads as
      // one garbled sentence for the whole duration of the final stream.
      if (this.turnBreakPending && this.buffer.trim().length > 0) {
        this.buffer += '\n\n';
      }
      this.turnBreakPending = false;
      this.buffer += event.delta.text;
      this.interim += event.delta.text;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'provider.delta' && event.delta.type === 'reset') {
      // The provider abandoned its partial attempt (e.g. fallback after a
      // mid-stream failure): discard everything streamed so far so two
      // attempts never fuse into one message.
      this.buffer = '';
      this.interim = '';
      this.turnBreakPending = false;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'provider.response') {
      this.turnBreakPending = true;
      // A provider that answers in one piece streams no deltas: the
      // response is the only place its words before a tool call appear.
      // One that streamed them has them already, and is not given them twice.
      if (this.interim.trim().length === 0) {
        this.interim = event.parts
          .filter((part): part is Extract<ProviderPart, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join('');
      }
      return;
    }
    if (event.type === 'tool.called') {
      // Also a turn boundary. On the kernel path `provider.response` has
      // already marked one, and marking it twice costs nothing; on a
      // provider that hosts its own loop there is no provider.response at
      // all, so this is the only thing between the text before a tool and
      // the text after it — without it they fuse in the live message.
      this.turnBreakPending = true;
      this.toolLine = `⚙ ${event.call.toolName}…`;
      this.runningTool = event.call.toolName;
      this.flushInterim(ofThisTurn);
      if (ofThisTurn && this.mayShowProgress()) {
        this.progress.steps += 1;
        this.progress.running.set(event.call.id, event.call.toolName);
        this.progress.waitingOn = undefined;
        this.openProgressInTime();
        this.scheduleProgress();
      }
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.denied') {
      // Denial settles a call that never reached tool.called, so nothing
      // else clears the status line or marks the boundary for it — the
      // message would keep claiming a refused tool is running, and the
      // model's follow-up would fuse with the text before the attempt.
      this.toolLine = undefined;
      this.runningTool = undefined;
      this.turnBreakPending = true;
      // Words written before a call that was refused were still said
      // before a tool, and must not run into the next response's.
      this.flushInterim(ofThisTurn);
      if (ofThisTurn) {
        this.settleProgressStep(event.call.id);
      }
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.completed') {
      this.toolLine = undefined;
      this.runningTool = undefined;
      // Settled here too for a call rejected before it ran, which never
      // reached `tool.called`; after one that did, this is empty.
      this.flushInterim(ofThisTurn);
      if (ofThisTurn) {
        this.settleProgressStep(event.result.callId);
      }
      // Also a boundary, and not only for symmetry: a call rejected before
      // execution settles as tool.completed without ever having emitted
      // tool.called, so this is the only mark that attempt leaves.
      this.turnBreakPending = true;
      // Clear the visible status promptly: the next provider turn may be
      // non-streaming or slow to its first delta, and the message must not
      // claim a finished tool is still running that whole time.
      this.scheduleEdit();
      // Only this turn's files: a result the caller knows belongs to the
      // turn ahead of this one on the session chain — a recovery's
      // screenshot — would otherwise be uploaded in this turn's place in
      // the thread. The adapter holds it for the turn that produced it.
      if (event.result.ok && ofThisTurn) {
        for (const filePath of collectFilePaths(event.result)) {
          this.queueUpload(filePath);
        }
      }
    }
  }

  /**
   * Upload files a turn produced that no event delivered: a repeat of a
   * finished turn has only the session to read them from (`turnFilesFor`),
   * and a path written since then is refused (see `readUnchangedSince`).
   */
  queueFiles(files: ReadonlyArray<{ path: string; producedAt: string }>): void {
    for (const file of files) {
      this.queueUpload(file.path, Date.parse(file.producedAt));
    }
  }

  // Tool results that reference local output files (a screenshot, a
  // generated report) become real attachments in the conversation — the
  // channel contract's upload operation. Uploads chain so they land in
  // order and finalize() waits for them.
  private queueUpload(filePath: string, producedAt?: number): void {
    // Behind a handover in progress, for the same reason edits and the
    // finalize are: the turn being handed the placeholder has its own
    // attachments to put in the thread first, and an upload is a message
    // of its own — one sent now would sit above them and read as this
    // turn's answer arriving first. Captured at queue time, not read when
    // the chain runs: a handover that begins after this upload waits for
    // it, and an upload that then waited for that handover would be a
    // cycle nothing breaks (see `queueEdit`).
    const handover = this.handover;
    const after = this.streaming ? undefined : this.after;
    this.uploadChain = this.uploadChain
      .then(() => handover)
      .then(() => after)
      // Read as file DATA inside the chain: the Web API takes contents,
      // not a path, and a missing file surfaces as this upload's own
      // failure instead of an unhandled stream error.
      .then(async () => {
        const data = producedAt === undefined ? await readFile(filePath) : await readUnchangedSince(filePath, producedAt);
        // Where the file will sit is Slack's to say — the ts of the
        // message it becomes, in the shares the upload answers with. When
        // the answer carries none, the clock stands in, read BEFORE the
        // call: the file is posted somewhere inside it, and a colleague's
        // placeholder posted while the answer was on its way back sits
        // below the file. Read after, the file would be placed below that
        // placeholder and take a thread the colleague holds; read before,
        // the error runs the other way, toward the colleague — the fault
        // an @ fixes.
        const before = slackTs(this.now());
        const result = await this.web.files.uploadV2({
          channel_id: this.channel,
          file: data,
          filename: path.basename(filePath),
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
        this.uploaded = true;
        // The upload is a post of the app's in this thread, which takes
        // the status down with it while the turn is still working.
        this.refreshLoading();
        const placed = uploadPlace(result, this.channel) ?? before;
        if (this.uploadedAt === undefined || placed > this.uploadedAt) {
          this.uploadedAt = placed;
        }
      })
      .catch((error) => this.warn(`files.uploadV2 failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * Post what the model said before the tool it is now calling, in `final`
   * mode only: a streaming turn already shows it in its placeholder, and a
   * turn nobody asked for must not speak before it decides to. Behind the
   * turn ahead and any handover, on the upload chain, so interim text,
   * files, and the reply land in the order they happened.
   */
  private flushInterim(ofThisTurn: boolean): Promise<boolean> | undefined {
    const text = this.interim.trim();
    this.interim = '';
    if (this.streaming || this.lazy || !this.turnStarted || !ofThisTurn || text.length === 0) {
      return undefined;
    }
    // Only words before the turn's first tool are a message of their own:
    // after one, a step has run, and what follows is progress whether or
    // not the turn opened with a line.
    if (this.firstWordsSaid || this.progressOpen || this.progress.steps > 0) {
      const note = toSlackMrkdwn(text);
      if (note.length <= PROGRESS_NOTE_ROOM) {
        return this.noteProgress(text, note);
      }
    }
    this.firstWordsSaid = true;
    const handover = this.handover;
    const after = this.after;
    let heard = '';
    let settleLanded!: (landed: boolean) => void;
    const landedNow = new Promise<boolean>((resolve) => {
      settleLanded = resolve;
    });
    this.onInterim?.(() => heard, landedNow);
    this.uploadChain = this.uploadChain
      .then(() => handover)
      .then(() => after)
      .then(async () => {
        const landed: string[] = [];
        try {
          for (const chunk of this.chunksOf(text)) {
            const posted = await this.web.chat.postMessage({
              channel: this.channel,
              text: chunk,
              ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
            });
            this.placeText(posted.ts);
            landed.push(chunk);
          }
        } finally {
          // Whatever landed was said, whole or not: it counts as speaking,
          // and the others hear it. Only a message that landed whole is
          // stripped from a hosted-loop reply; part of one is left in the
          // reply, where repeating a few lines beats losing the rest.
          if (landed.length > 0) {
            this.interimPosted = true;
            heard = landed.length === this.chunksOf(text).length ? text : landed.join('\n\n');
          }
          settleLanded(landed.length > 0);
        }
        this.lastInterim = text;
        this.interimSaid.push(text);
        this.lastSaidWasNote = false;
        // A post of the app's in this thread takes the status down while
        // the turn is still working; put it back.
        this.refreshLoading();
      })
      .catch((error) => this.warn(`chat.postMessage failed for an interim message: ${error instanceof Error ? error.message : String(error)}`))
      // Settled whatever happened above, or the other agents' intake would
      // wait on it for good. A second settle is a no-op.
      .finally(() => settleLanded(false));
    return landedNow;
  }

  /**
   * Whether this turn keeps a progress message (card 949): `final` mode,
   * a turn somebody asked for, and its own — the same turns that post
   * their words before a tool. A streaming turn's placeholder already
   * shows its tool lines, and a turn nobody asked for must not speak
   * before it decides to.
   */
  private mayShowProgress(): boolean {
    return !this.streaming && !this.lazy && this.turnStarted && !this.finalized;
  }

  /**
   * Words the turn wrote between tools after its first line: a note in the
   * progress message, opening it if need be, rather than a post of their
   * own. Heard by the thread's other agents and stripped from a reply that
   * repeats them, as a message of their own would be. A note Slack refused
   * is taken out again, so a later edit never shows words nobody heard.
   */
  private noteProgress(text: string, converted: string): Promise<boolean> {
    this.progressOpen = true;
    this.clearProgressOpenTimer();
    const note: { text: string; shown?: boolean } = { text: converted };
    this.progressNotes.push(note);
    this.trimProgressNotes();
    let heard = '';
    let settleLanded!: (landed: boolean) => void;
    const landedNow = new Promise<boolean>((resolve) => {
      settleLanded = resolve;
    });
    this.onInterim?.(() => heard, landedNow);
    this.queueProgressWrite(() => {
      // Its own write landed, but a slow Slack can let later notes trim it
      // out before any write held it. Unseen, it is not said: the others do
      // not hear it, and a reply that repeats it keeps it.
      if (!note.shown) {
        settleLanded(false);
        return;
      }
      this.interimPosted = true;
      heard = text;
      this.lastInterim = text;
      this.interimSaid.push(text);
      this.lastSaidWasNote = true;
      settleLanded(true);
    }, () => {
      this.progressNotes = this.progressNotes.filter((kept) => kept !== note);
      settleLanded(false);
    });
    return landedNow;
  }

  /**
   * Keep the notes to what one message holds with its first line: the
   * newest, since the oldest are what a reader has already seen. Past
   * that the message opens with `…`, and memory stays bounded however
   * long the task runs.
   */
  private trimProgressNotes(): void {
    let size = this.progressNotes.reduce((total, note) => total + note.text.length + 2, 0);
    while (size > PROGRESS_NOTE_ROOM && this.progressNotes.length > 1) {
      size -= (this.progressNotes.shift()?.text.length ?? 0) + 2;
      this.progressNotesCut = true;
    }
  }

  private progressText(omitLast = false): string {
    const notes = omitLast ? this.progressNotes.slice(0, -1) : this.progressNotes;
    const parts = [progressHeader(this.progress), ...(this.progressNotesCut ? ['…'] : []), ...notes.map((note) => note.text)];
    return truncateForSlack(parts.join('\n\n'));
  }

  /**
   * Put the progress message as it stands now into the thread: posted the
   * first time, edited after. On the upload chain, behind the turn ahead
   * and any handover, so it lands below this turn's first line and above
   * its files and reply, and reads its state when it runs, not when asked.
   */
  private queueProgressWrite(landed?: () => void, refused?: () => void): void {
    const handover = this.handover;
    const after = this.after;
    this.uploadChain = this.uploadChain
      .then(() => handover)
      .then(() => after)
      .then(async () => {
        this.lastProgressAt = Date.now();
        const held = [...this.progressNotes];
        await this.writeProgress(this.progressText());
        for (const note of held) {
          note.shown = true;
        }
        landed?.();
      })
      .catch((error) => {
        refused?.();
        this.warn(`could not update the progress message: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async writeProgress(text: string): Promise<void> {
    const ref = this.progressRef;
    if (ref) {
      await this.web.chat.update({ channel: ref.channel, ts: ref.ts, text });
      return;
    }
    const posted = await this.web.chat.postMessage({
      channel: this.channel,
      text,
      ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
    });
    if (posted.ts) {
      this.progressRef = { channel: posted.channel ?? this.channel, ts: posted.ts };
    }
    this.placeText(posted.ts);
    // A post of the app's in this thread takes the status down while the
    // turn is still working; put it back.
    this.refreshLoading();
  }

  /** Edit the progress message for a step that started or settled, at most once per edit interval. */
  private scheduleProgress(): void {
    if (!this.progressOpen || this.finalized || this.progressTimer) {
      return;
    }
    const delay = Math.max(0, this.editIntervalMs - (Date.now() - this.lastProgressAt));
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.finalized) {
        this.queueProgressWrite();
      }
    }, delay);
    this.progressTimer.unref?.();
  }

  /**
   * Open the progress message once the turn has worked `progressAfterMs`:
   * now, if it has, or when it will have. Asked on a tool call, so there
   * is always a step to show; a quick answer ends first and opens none.
   */
  private openProgressInTime(): void {
    if (this.progressOpen || this.progressOpenTimer) {
      return;
    }
    const open = () => {
      this.progressOpen = true;
      this.queueProgressWrite();
    };
    const wait = this.progressAfterMs - (Date.now() - this.turnStartedAt);
    if (wait <= 0) {
      open();
      return;
    }
    this.progressOpenTimer = setTimeout(() => {
      this.progressOpenTimer = undefined;
      if (!this.finalized && !this.progressOpen) {
        open();
      }
    }, wait);
    this.progressOpenTimer.unref?.();
  }

  /** A step of this turn's finished or was refused. */
  private settleProgressStep(callId: string): void {
    if (!this.mayShowProgress()) {
      return;
    }
    this.progress.running.delete(callId);
    this.progress.waitingOn = undefined;
    this.scheduleProgress();
  }

  /**
   * A call of this turn's is waiting on a person: the progress message says
   * so until the call runs or is refused. The prompt itself is a message
   * of its own, below it.
   */
  awaitingApproval(toolName: string, ofThisTurn: boolean): void {
    if (!ofThisTurn || !this.mayShowProgress()) {
      return;
    }
    this.progress.waitingOn = toolName;
    this.scheduleProgress();
  }

  private clearProgressOpenTimer(): void {
    if (this.progressOpenTimer) {
      clearTimeout(this.progressOpenTimer);
      this.progressOpenTimer = undefined;
    }
  }

  private clearProgressTimers(): void {
    this.clearProgressOpenTimer();
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
  }

  /**
   * The progress message's last edit: how the task ended, and every note
   * but one that became the reply. Resolves once Slack has answered; a
   * refusal leaves the last state that landed, and is logged.
   */
  private async closeProgress(omitLast: boolean): Promise<void> {
    this.clearProgressTimers();
    const ref = this.progressRef;
    if (!ref) {
      return;
    }
    this.progress.end = this.ending;
    try {
      await this.web.chat.update({ channel: ref.channel, ts: ref.ts, text: this.progressText(omitLast) });
    } catch (error) {
      this.warn(`could not finish the progress message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Post what the model said before a call that is about to ask for
   * approval, and resolve once it has landed (or could not), or at once
   * when there is nothing to post (card 950).
   *
   * The prompt is posted before the call starts, so waiting for
   * `tool.called` put the question above the line saying what the agent
   * set out to do, and the approver answered without it. The same flush
   * `tool.called` would have done, only earlier: what it posts is stripped
   * from the reply as before, and the flush at `tool.called` finds nothing.
   */
  sayBeforeAsking(ofThisTurn: boolean): Promise<boolean> | undefined {
    if (this.finalized) {
      return undefined;
    }
    return this.flushInterim(ofThisTurn);
  }

  /**
   * Everything this turn said in the thread, for its other agents to hear:
   * the interim messages that landed, then the reply unless it only
   * repeats the last of them. Read once the turn's posts have landed.
   */
  spokenText(reply: string): string {
    return this.unsaid(reply);
  }

  /**
   * The part of a reply not already posted as interim messages. A provider
   * that hosts its own loop (codex) returns every message of the turn
   * joined into one reply, so the interim messages are stripped from its
   * front in order; one whose last words came before its final tool call
   * returns just those words, which were posted already.
   */
  private unsaid(reply: string): string {
    let rest = reply.trim();
    // Whole messages only, at the separator the codex provider joins them
    // with: a reply of its own that merely begins with the same words
    // ("Sure" then "Sure, the build passes.") is not cut.
    for (const said of this.interimSaid) {
      if (rest === said) {
        rest = '';
      } else if (rest.startsWith(`${said}\n\n`)) {
        rest = rest.slice(said.length + 2).trimStart();
      } else {
        break;
      }
    }
    return rest === this.lastInterim ? '' : rest;
  }

  private currentText(): string {
    const parts = [this.buffer.trim(), this.toolLine].filter((part): part is string => Boolean(part && part.length > 0));
    return parts.length > 0 ? parts.join('\n\n') : PLACEHOLDER_TEXT;
  }

  private scheduleEdit(): void {
    if (!this.streaming) {
      // Nothing to edit: what the turn is doing goes into the status line,
      // and only once the turn is this renderer's own (see `beginTurn`).
      const status = this.runningTool !== undefined ? toolStatus(this.runningTool) : THINKING_STATUS;
      if (this.loading && this.statusTimer && this.turnStarted && !this.finalized && status !== this.statusText) {
        this.setStatus(status);
      }
      return;
    }
    // Not gated on having a placeholder: during a handover there is none
    // for a moment, and the edit reads the fresh one when its turn comes.
    if (this.pendingEdit) {
      return;
    }
    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, this.editIntervalMs - elapsed);
    this.pendingEdit = setTimeout(() => {
      this.pendingEdit = undefined;
      if (this.finalized) {
        return;
      }
      // Nothing said yet: a lazy turn has no placeholder to edit, and a
      // tool line alone does not earn one (see `lazy`). Nor does text
      // streamed here before this turn began — a recovery's, routed to
      // the head of the queue — which `beginTurn` drops.
      if (this.lazy && !this.ref && (!this.turnStarted || this.buffer.trim().length === 0)) {
        return;
      }
      this.lastEditAt = Date.now();
      void this.queueEdit(messageText(this.currentText()));
    }, delay);
    this.pendingEdit.unref?.();
  }

  /**
   * Queue one edit of the placeholder. Resolves to whether Slack took it —
   * false when there was no placeholder to edit, the text belonged to a
   * turn handed over meanwhile, or the update was refused — which is what
   * lets `finalize` say whether the reply was ever published.
   */
  private queueEdit(text: string): Promise<boolean> {
    const generation = this.generation;
    // The handover as it stands when the edit is queued, not when it runs:
    // a handover that begins after this edit waits for this edit, and an
    // edit that then waited for that handover would be a cycle nothing
    // could break.
    const handover = this.handover;
    const edit = this.editChain
      .then(() => handover)
      .then(async () => {
        if (this.lazy && !this.ref && this.turnStarted && generation === this.generation) {
          // The first text of a turn nobody asked for: this is where its
          // placeholder is posted, and the edit below fills it. A post
          // that fails leaves the turn without one, and its reply is a
          // message of its own when it comes (see `finalize`).
          try {
            await this.open();
          } catch (error) {
            this.warn(`could not open a placeholder: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // Read after the handover, not before: the placeholder may have
        // changed hands while this edit waited its turn — and the text
        // may belong to the turn that was handed over.
        const ref = this.ref;
        if (!ref || generation !== this.generation) {
          return false;
        }
        await this.web.chat.update({ channel: ref.channel, ts: ref.ts, text });
        this.edited = true;
        this.placeText(ref.ts);
        return true;
      })
      .catch((error) => {
        this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
    this.editChain = edit.then(() => undefined);
    return edit;
  }

  /**
   * Replace the placeholder with the final reply, splitting if oversized.
   * Resolves to a `ReplyOutcome`. A reply Slack refused any part of was
   * not said in the thread as written, and nothing downstream may treat it
   * as if it had been: a colleague hearing the whole of a reply the thread
   * saw half of is reasoning from text nobody read. But a file beside a
   * refused sentence is still the last thing said, for the thread rule.
   */
  async finalize(reply: string): Promise<ReplyOutcome> {
    try {
      return await this.finalizeInOrder(reply);
    } finally {
      this.settle();
    }
  }

  private async finalizeInOrder(reply: string): Promise<ReplyOutcome> {
    await this.handover;
    // Shown, not merely wanted: a turn still queued behind another never
    // published one, and a clear from it would take down the running
    // turn's status instead.
    const hadStatus = this.statusTimer !== undefined;
    this.stopLoading();
    this.finalized = true;
    this.clearProgressTimers();
    if (!this.streaming) {
      await this.after;
      await this.statusChain;
    }
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = undefined;
    }
    // Let the edits already queued land before deciding anything from
    // `ref`: a lazy turn's first text may be opening its placeholder in
    // that chain right now, and reading `ref` ahead of it would post the
    // reply as a message of its own beside a placeholder that then fills
    // with stale partial text.
    await this.editChain;
    if (this.lazy && reply.trim().length === 0 && (!this.ref || await this.retract())) {
      // Silence, decided: nothing was posted and nothing is — or what was
      // posted has been taken back. The uploads still land: a file the
      // turn produced is not nothing to say, and a turn that posted one
      // has spoken, for the thread rule.
      await this.editChain;
      await this.uploadChain;
      return this.outcome(false, this.uploaded);
    }
    // Interim messages land before the reply is judged: one that already
    // said what the reply says (the model's last words came before a
    // tool call) is not posted again, and a turn that said things along
    // the way is not followed by `(no reply)`.
    await this.uploadChain;
    // Words the turn ended on, written before its last tool call, are its
    // answer (card 949): a reply that only repeats them, or an empty one,
    // posts them as the reply, and the progress message lets them go. Left
    // as its last note, the answer would sit in the message that says how
    // the work went, above where anyone looks for it.
    let promoted = false;
    if (this.interimPosted && !this.ref) {
      const rest = this.unsaid(reply);
      promoted = rest.length === 0 && this.lastSaidWasNote && this.lastInterim !== undefined;
      reply = promoted && this.lastInterim !== undefined ? this.lastInterim : rest;
    }
    // Alongside the reply rather than ahead of it: an edit keeps its place,
    // and the answer should not wait on a round trip for a status line.
    const closed = this.closeProgress(promoted);
    if (!this.ref && this.interimPosted && reply.trim().length === 0) {
      await closed;
      // Nothing posts after this to take the status down, so it is cleared.
      if (hadStatus) {
        this.setStatus('');
        await this.statusChain;
      }
      return this.outcome(true, true);
    }
    const text = reply.trim().length > 0 ? reply : NO_REPLY_TEXT;
    const chunks = this.chunksOf(text);
    // No placeholder — a handover could not open a fresh one — and the
    // reply is a message of its own rather than nothing at all.
    const rest = this.ref ? chunks.slice(1) : chunks;
    const edited = this.ref ? this.queueEdit(chunks[0] ?? NO_REPLY_TEXT) : Promise.resolve(false);
    let landed = await edited;
    let published = this.ref ? landed : true;
    await this.editChain;
    await this.uploadChain;
    for (const chunk of rest) {
      try {
        const posted = await this.web.chat.postMessage({
          channel: this.channel,
          text: chunk,
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
        landed = true;
        this.placeText(posted.ts);
      } catch (error) {
        published = false;
        this.warn(`chat.postMessage failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A placeholder that opened for a turn nobody asked for and never
    // took a word of it — every edit refused — is a `…` standing alone
    // under the agent's name, the interruption a judged turn exists to
    // avoid, so it is taken back like an abandoned attempt's. One Slack
    // will not let go stands, and a message the thread can see is the
    // last thing said whatever it says.
    await closed;
    let stranded = false;
    if (this.lazy && this.ref !== undefined && !landed && !this.edited) {
      stranded = !(await this.retract());
      if (stranded) {
        this.placeText(this.ref?.ts);
      }
    }
    // A reply posted into the status's thread clears the status itself;
    // one Slack refused would leave "is thinking…" standing over a turn
    // that has ended. So would one posted anywhere else: a top-level DM
    // reply keys its status to the message it answers (`statusThread`),
    // but posts beside it rather than under it, and Slack never clears it.
    if (hadStatus && (!landed || this.threadTs !== this.statusThread)) {
      this.setStatus('');
      // Awaited: the turn queued behind this one re-shows its own status
      // once this renderer is done, and a clear that reached Slack after
      // that would take the next turn's status down with it.
      await this.statusChain;
    }
    return this.outcome(published, landed || this.edited || this.uploaded || stranded, !published);
  }

  /** This turn's text as the messages it is posted as, in this agent's reply mode. */
  private chunksOf(text: string): string[] {
    return messageChunks(text, this.texts ? 'texts' : undefined);
  }

  private placeText(ts: string | undefined): void {
    if (ts !== undefined && (this.textAt === undefined || ts > this.textAt)) {
      this.textAt = ts;
    }
  }

  private outcome(published: boolean, spoke: boolean, refused = false): ReplyOutcome {
    const spokeAt = [this.textAt, this.uploadedAt]
      .filter((ts): ts is string => ts !== undefined)
      .sort()
      .at(-1);
    return { published, spoke, ...(spoke && spokeAt !== undefined ? { spokeAt } : {}), ...(refused ? { refused: true as const } : {}) };
  }

  /**
   * Take back the placeholder a turn nobody asked for opened and then had
   * nothing to put in: the line that opened it was an attempt the provider
   * abandoned (`reset` — a fallback after a mid-stream failure), and the
   * attempt that stood answered with nothing. Editing that placeholder to
   * `(no reply)` would leave exactly the interruption a silent turn exists
   * to avoid, and would count as speaking. Resolves to whether Slack let
   * the message go: a delete refused leaves the abandoned line standing,
   * and the turn finishes the ordinary way, since a message the thread
   * can still see is the last thing said whatever it says.
   */
  private async retract(): Promise<boolean> {
    const ref = this.ref;
    if (!ref) {
      return true;
    }
    try {
      await this.web.chat.delete({ channel: ref.channel, ts: ref.ts });
    } catch (error) {
      this.warn(`chat.delete failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    this.ref = undefined;
    // The line the placeholder took is gone with it: nothing of this
    // turn's stands in the thread unless a file does.
    this.edited = false;
    this.textAt = undefined;
    return true;
  }

  /**
   * Stand down without saying anything: the message this renderer was
   * opened for repeated one whose turn another delivery in this process
   * is still waiting on, and that delivery posts the answer. Whatever this
   * renderer put up — a placeholder, a loading status — comes down, so a
   * redelivery leaves no trace.
   */
  async withdraw(): Promise<void> {
    try {
      await this.handover;
      const hadStatus = this.statusTimer !== undefined;
      this.stopLoading();
      this.finalized = true;
      this.clearProgressTimers();
      // The barrier `finalizeInOrder` takes, for the same reason: the turn
      // queued behind this one waits on `posted`, and settling it before
      // the reply ahead has posted would let that turn's reply overtake it.
      if (!this.streaming) {
        await this.after;
        await this.statusChain;
      }
      if (this.pendingEdit) {
        clearTimeout(this.pendingEdit);
        this.pendingEdit = undefined;
      }
      await this.editChain;
      // A repeat can queue files the report ahead of it could not post
      // and then stand down: they land before it settles.
      await this.uploadChain;
      await this.retract();
      if (hadStatus) {
        this.setStatus('');
        await this.statusChain;
      }
    } finally {
      this.settle();
    }
  }

  /**
   * Ends a turn an approver stopped from Slack: says who stopped it where
   * the reply would have gone. A turn nobody asked for that had said
   * nothing stays silent, as its failure would.
   */
  async stopped(by: string): Promise<ReplyOutcome> {
    await this.editChain;
    if (this.lazy && !this.ref && this.buffer.trim().length === 0) {
      return this.finalize('');
    }
    this.ending = 'stopped';
    return this.finalize(`Stopped by <@${by}>.`);
  }

  /**
   * `refused` is a turn the host stopped on purpose (`HostRefusalError`), a
   * spent budget, whose message is already a sentence for the person
   * reading it. Framed as something having gone wrong, it would read as a
   * fault to report when it is a limit working.
   */
  async fail(message: string, refused = false): Promise<ReplyOutcome> {
    // The same wait `finalize` takes, for the same reason: a lazy turn's
    // first text may be opening its placeholder right now, and a failure
    // read as "before saying anything" would leave that placeholder saying
    // `(no reply)` where the failure belongs.
    await this.editChain;
    // "Before saying anything" is no placeholder AND nothing buffered: a
    // first text whose zero-delay edit has not fired yet has still been
    // said, and its failure is reported — as a message of its own, since
    // there is no placeholder to edit — rather than swallowed with it.
    if (this.lazy && !this.ref && this.buffer.trim().length === 0) {
      // A turn nobody asked for that failed before saying anything: the
      // failure is in the daemon log, and an error note would be the
      // interruption the turn existed to avoid.
      this.warn(`a turn nobody asked for failed before saying anything: ${message}`);
      return this.finalize('');
    }
    // A spent budget is a limit working, not a fault: the task stopped.
    this.ending = refused ? 'stopped' : 'failed';
    return this.finalize(refused ? message : `Something went wrong: ${message}`);
  }

  /**
   * Claim the placeholder for a turn that finished ahead of this one — the
   * recovery this renderer was queued behind — without yet knowing what
   * that turn has to say. Slack keeps a message's place when it is edited,
   * so the earlier turn's reply lands above this turn's, in the order the
   * conversation happened; posted as a new message instead, it would sit
   * below a placeholder that was posted first.
   *
   * The claim is made synchronously, so it is in place before the caller
   * awaits anything (see `HandoverClaim`).
   */
  reserveHandover(): HandoverClaim {
    // One handover at a time: two turns ahead of this one finishing close
    // together would otherwise both take the placeholder as they found it,
    // and the second would write over the first's reply. Each waits for
    // the one before it and takes the placeholder that reopen left.
    // The edits to let through first are the ones queued before this
    // handover existed; those queued after it wait for it (see `queueEdit`),
    // so waiting on the live chain here would wait on them in return.
    const drained = this.editChain;
    const previous = this.handover;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.handover = previous.then(() => held);
    let spent = false;
    const settle = (): void => {
      if (!spent) {
        spent = true;
        release();
      }
    };
    return {
      take: async (chunks, between) => {
        if (spent) {
          return 'untaken';
        }
        try {
          await previous;
          return await this.handoverTo(chunks, drained, between);
        } finally {
          settle();
        }
      },
      release: settle,
    };
  }

  /**
   * The body of a handover, running with the placeholder already claimed:
   * edit it to the earlier turn's first chunk, post the rest, run whatever
   * else that turn has to put in the thread, and reopen a placeholder for
   * this turn below it all.
   */
  private async handoverTo(
    chunks: readonly string[],
    drained: Promise<void>,
    between: (() => Promise<void>) | undefined,
  ): Promise<'complete' | 'partial' | 'untaken'> {
    const [first, ...rest] = chunks;
    const given = this.ref;
    if (first === undefined || this.finalized || !given) {
      return 'untaken';
    }
    await drained;
    try {
      await this.web.chat.update({ channel: given.channel, ts: given.ts, text: first });
    } catch (error) {
      // Not handed over: the placeholder is still this turn's, and the
      // caller posts the reply as messages of its own.
      this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`);
      return 'untaken';
    }
    let complete = true;
    // The placeholder is the earlier turn's now, and the reference goes
    // before the reopen, so a reopen that fails cannot leave this turn
    // writing over the reply just handed over. (What was streamed into
    // it is dealt with by `beginTurn`, at the boundary that actually
    // separates the two turns' output.)
    this.ref = undefined;
    for (const chunk of rest) {
      try {
        await this.web.chat.postMessage({
          channel: this.channel,
          text: chunk,
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
      } catch (error) {
        complete = false;
        this.warn(`chat.postMessage failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Anything else the earlier turn has to put in the thread goes here,
    // while this renderer still has no placeholder of its own: a message
    // posted after the reopen would sit below this turn's answer, which
    // is the order the handover exists to keep.
    if (between) {
      await between();
    }
    try {
      await this.open();
    } catch (error) {
      // No placeholder for this turn, then: its reply is posted as a
      // message of its own when it comes (see `finalize`).
      this.warn(`could not reopen a placeholder: ${error instanceof Error ? error.message : String(error)}`);
    }
    return complete ? 'complete' : 'partial';
  }
}

// The file-bearing result convention is the kernel's (`filePathsOf`), so
// the gateway counts a turn that produced a file as having spoken by the
// same rule this adapter uploads it by.
const collectFilePaths = (result: ToolResult): string[] => filePathsOf(result);

// A hard cut must never land between the halves of a UTF-16 surrogate
// pair — an emoji on the boundary would reach Slack as two replacement
// characters. Backs the index off the pair's high half when it would.
const safeCutIndex = (text: string, index: number): number => {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
};

/** `index` moved forward, never back, off the middle of a surrogate pair. */
const pastCodePoint = (text: string, index: number): number => {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
};

/**
 * `cut` moved in front of any Slack markup it would land inside — a link
 * `<https://…>` or `<https://…|label>`, a mention `<@U…>` — when that still
 * leaves half a message. Cut through, the first message ends on an
 * unterminated `<https://…` and the next starts with the rest of the
 * address and a stray `>`, and neither half is a link. Markup is one line,
 * so only the cut's own line is looked at.
 */
const outsideSlackMarkup = (text: string, cut: number): number => {
  const open = text.lastIndexOf('<', cut - 1);
  if (open <= SLACK_MAX_MESSAGE_CHARS / 2) {
    return cut;
  }
  const closedBefore = text.lastIndexOf('>', cut - 1);
  const lineBreak = text.lastIndexOf('\n', cut - 1);
  if (closedBefore > open || lineBreak > open) {
    return cut;
  }
  const close = text.indexOf('>', cut);
  const nextLine = text.indexOf('\n', cut);
  if (close === -1 || (nextLine !== -1 && nextLine < close)) {
    return cut;
  }
  return open;
};

const truncateForSlack = (text: string): string =>
  text.length <= SLACK_MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, safeCutIndex(text, SLACK_MAX_MESSAGE_CHARS - 1))}…`;

/**
 * Text as however many messages Slack's limit makes it, never leaving a
 * code block broken across the cut. A cut blind to fences ended one
 * message on an unterminated block and started the next mid-block, where
 * Slack read the rest of somebody's log as prose — every `*` and `_` in it
 * formatting. So a cut that would land inside a code run moves in front of
 * it when that still leaves a message worth sending, and otherwise closes
 * the run at the cut and reopens it in the next.
 */
const splitForSlack = (text: string): string[] => {
  if (text.length <= SLACK_MAX_MESSAGE_CHARS) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SLACK_MAX_MESSAGE_CHARS) {
    // Prefer a newline break inside the window; fall back to a hard cut.
    const window = rest.slice(0, SLACK_MAX_MESSAGE_CHARS);
    const newline = window.lastIndexOf('\n');
    const cut = newline > SLACK_MAX_MESSAGE_CHARS / 2 ? newline : safeCutIndex(rest, SLACK_MAX_MESSAGE_CHARS);
    // Scanned two messages deep, not to the end: rescanning the whole rest
    // for every chunk made a megabyte reply quadratic on the event loop. A
    // fence that closes past the window still reads as open to its end,
    // which is what it is here; an inline span that does is longer than a
    // message, and is cut as text either way.
    const run = codeRunsOf(rest.slice(0, SLACK_MAX_MESSAGE_CHARS * 2))
      .find((candidate) => candidate.start < cut && cut < candidate.end);
    if (run !== undefined && run.start > SLACK_MAX_MESSAGE_CHARS / 4) {
      chunks.push(rest.slice(0, run.start).replace(/\n+$/, ''));
      rest = rest.slice(run.start);
      continue;
    }
    // The run is most of the message, so it is cut itself — at its last
    // newline that leaves room for the closer, and past its opener so the
    // continuation always makes progress. A continuation reopens with the
    // info string only while it is short: a two-thousand-character info
    // line repeated on every part would crowd out the code it labels.
    const budget = SLACK_MAX_MESSAGE_CHARS - (run?.closer.length ?? 0);
    const floor = run === undefined ? 0 : run.start + run.opener.length;
    const reopen = run === undefined || run.opener.length <= SLACK_MAX_MESSAGE_CHARS / 8
      ? run?.opener
      : run.opener.endsWith('\n') ? `${run.closer.slice(1)}\n` : run.opener;
    // A delimiter too long to close and reopen inside one message — a fence
    // of a thousand backticks, an opening line that fills the window — is
    // cut raw, as before this existed. Reopening it would send a message
    // over the limit, and consume a character a message after that.
    // Only a fence is reopened. Its closer and opener sit on lines of their
    // own, so they can never run into a backtick of the code; an inline
    // span's would, and `x` + `` would read as a different delimiter.
    // `floor + 2`: the first cut past the opener has to fit a whole code
    // point, or the step that guarantees progress lands inside an emoji.
    const fence = run !== undefined && run.closer.startsWith('\n');
    if (run === undefined || !fence || reopen === undefined || reopen.length + run.closer.length > SLACK_MAX_MESSAGE_CHARS / 4 || floor + 2 > budget) {
      const at = run === undefined ? outsideSlackMarkup(rest, cut) : cut;
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n+/, '');
      continue;
    }
    const inner = rest.lastIndexOf('\n', budget - 1);
    const within = inner > Math.max(floor, SLACK_MAX_MESSAGE_CHARS / 2) ? inner : Math.max(safeCutIndex(rest, budget), pastCodePoint(rest, floor + 1));
    chunks.push(`${rest.slice(0, within)}${run.closer}`);
    rest = `${reopen}${rest.slice(within).replace(/^\n/, '')}`;
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
};

/**
 * Agent text as one Slack message: converted, then sized.
 *
 * These two are the only ways anything an agent wrote reaches Slack, so
 * mrkdwn is a property of the send path rather than something each call
 * site has to remember — the reason the streamed placeholder and the final
 * reply cannot end up in different markup.
 */
const messageText = (text: string): string => truncateForSlack(toSlackMrkdwn(text));

/**
 * Agent text as however many Slack messages it takes. Converted before it
 * is split, so a chunk is measured at the length it will be sent at, and so
 * no rewrite is ever asked to span a boundary.
 *
 * In `texts` mode a reply is first cut into the few messages it is texted
 * as, each then converted and sized on its own: the cuts never fall inside
 * code, and nothing else in the conversion crosses a line.
 */
const messageChunks = (text: string, replies?: SlackReplyMode): string[] =>
  (replies === 'texts' ? textingParts(text) : [text]).flatMap((part) => splitForSlack(toSlackMrkdwn(part)));

const APPROVAL_ACTIONS: Record<string, ApprovalAnswer> = {
  stratus_approve_once: 'once',
  stratus_approve_always: 'always',
  stratus_deny: 'deny',
};

/**
 * How an approval request reads once it is settled. `always` says out loud
 * how long it lasts: the button is the shortest path to widening what an
 * agent does unattended, and an approver should see the scope they granted
 * in the record of granting it.
 *
 * What it lasts rode in on the request as `always` (see `AlwaysMeans`),
 * so the line names the grant that was made rather than hedging between
 * lifetimes — which this message once had to, when nothing on the bus said
 * whether an "always" was the session's or the file's. One thing the
 * request still cannot promise is the disk write: the daemon does not
 * write over a whitelist it could not read, and by then this message has
 * been sent. The daemon's log has that line; `stratus grants <agent>` has
 * the list.
 */
const OUTCOME_TEXT: Record<string, string> = {
  'decided:once': 'Allowed once',
  'decided:deny': 'Denied',
  'timeout:deny': 'Expired without an answer — denied',
  // Covers both endings that reach here: the turn was aborted, and the
  // daemon shut down with the request still outstanding.
  'cancelled:deny': 'Cancelled before anyone answered — denied',
  'undeliverable:deny': 'Could not be put to an approver — denied',
};

/**
 * What **Always allow** did, by the grant the request said it would make.
 * A tool grant names the agent because that is its scope — not this
 * thread, not the session — and says how to take it back, since a grant
 * an approver cannot find later is a ratchet.
 */
const alwaysOutcome = (always: AlwaysMeans | undefined, agentName: string, agentId: string): string => {
  switch (always) {
    case 'scope':
      return 'Allowed, and this command\'s scope now runs without asking — until revoked';
    case 'origin':
      return 'Allowed, and this site is now acted on without asking — until revoked';
    case 'tool':
      return `Allowed, and granted to ${escapeSlackText(agentName)} until revoked (stratus grants ${escapeSlackText(agentId)})`;
    case 'destination':
      return `Allowed, and granted to ${escapeSlackText(agentName)} for this conversation until revoked (stratus grants ${escapeSlackText(agentId)})`;
    case 'session':
      return 'Allowed for the rest of this session';
    default:
      // An `always` submitted through `POST /approvals` against a request
      // this daemon did not label — an older daemon's event, say. The
      // request did not say, so neither does this.
      return 'Allowed and remembered — for this session at least';
  }
};

/**
 * What **Always allow** would do, said beside the button. The lifetime is
 * the half of the question the button widens, and it differs by tool: a
 * standing grant to the agent is a larger thing to hand out than a session,
 * and an approver should know which they are clicking.
 */
const alwaysOffer = (always: AlwaysMeans | undefined, agentName: string): string | undefined => {
  switch (always) {
    case 'tool':
      return `*Always allow* grants this tool to ${escapeSlackText(agentName)} until an operator revokes it.`;
    case 'destination':
      return `*Always allow* lets ${escapeSlackText(agentName)} use this tool on this conversation without asking, until revoked.`;
    case 'session':
      return '*Always allow* stops this tool asking again for the rest of this session.';
    case 'scope':
      return '*Always allow* remembers this command\'s scope for this agent, until revoked.';
    case 'origin':
      return '*Always allow* remembers this site for this agent, until revoked.';
    default:
      return undefined;
  }
};

/** Comfortably inside Slack's 3000-character section limit. */
const APPROVAL_INPUT_LIMIT = 1400;
/** One line in a notification; the blocks carry the readable version. */
const APPROVAL_SUMMARY_LIMIT = 160;

/**
 * Subtypes that are still a person saying something, rather than Slack
 * narrating the channel. Everything else a `subtype` marks — an edit, a
 * deletion, a join, a pinned file — is bookkeeping, and an agent following
 * a thread must not answer bookkeeping.
 *
 * These three are here because each is an ordinary thing a person does:
 * `file_share` is a message that happens to carry an attachment (asking a
 * question with the log attached is the normal way to ask it),
 * `thread_broadcast` is a thread reply the author also sent to the channel,
 * and `me_message` is what `/me` produces — typed by a person, in their own
 * words, and marked only by how it is rendered.
 */
const HUMAN_MESSAGE_SUBTYPES = new Set(['file_share', 'me_message', 'thread_broadcast']);

/**
 * Message subtypes that are another agent's bot speaking (card 513): a plain
 * bot post, an upload with a comment, or a thread reply also sent to the
 * channel. Edits, deletions and joins are never a mention to answer.
 */
const AGENT_SPEECH_SUBTYPES = new Set(['bot_message', 'file_share', 'thread_broadcast']);

const isPersonSpeaking = (event: SlackInboundEvent): boolean =>
  event.subtype === undefined || HUMAN_MESSAGE_SUBTYPES.has(event.subtype);

/** At most this many attachment names are listed; the rest are counted. */
const MAX_LISTED_ATTACHMENTS = 5;

/**
 * Why an attachment reached the turn as a name only. The note says which,
 * per file, because "cannot be read here" for every one of them read the
 * same for a PDF nothing here opens, a log over the size cap, and a
 * download Slack refused, and an agent asked why guessed at the cause.
 */
type UnreadReason = 'unsupported' | 'too-large' | 'failed' | 'timed-out' | 'unreadable' | 'not-opened';
type UnreadReasons = Map<SlackInboundFile, UnreadReason>;

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
const attachmentNote = (files: readonly SlackInboundFile[], reasons: UnreadReasons): string => {
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
interface ImagePreview {
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
const previewNote = (previews: readonly ImagePreview[]): string =>
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
const readImageAttachments = async (
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
const historyImageCap = (images: ConversationReadRequest['images']): { count: number; bytes: number } | undefined => {
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
const readHistoryImages = async (
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
const createAttachmentSaver = (
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
const readTextAttachments = async (
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
interface SavedAttachment {
  name: string;
  path: string;
  bytes: number;
}

/** Saved attachments, named with where each is, after what was said. */
const savedAttachmentBlocks = (saved: readonly SavedAttachment[]): string =>
  saved.map(({ name, path: at, bytes }) => `\n[Attached: ${name}, ${Math.ceil(bytes / 1024)} KB, too large to include here. It is saved in full at ${at}. Read it with your file tools, in parts if it is long.]`).join('');

/** Read text attachments, set into the message after what was said. */
const textAttachmentBlocks = (texts: ReadonlyArray<{ name: string; text: string }>): string =>
  texts.map(({ name, text }) => `\n[Attached: ${name}. Its contents follow.]\n${text.replace(/\s+$/, '')}\n[End of ${name}]`).join('');

/**
 * Whether `text` addresses a bot user by name. Slack writes a mention as
 * `<@U123>` markup whoever typed it, so this is the same question for an
 * `app_mention` event and for a plain channel message the app now also
 * sees.
 */
const mentions = (text: string, botUserId: string): boolean =>
  botUserId.length > 0 && text.includes(`<@${botUserId}>`);

/**
 * Whether a message asks this agent to stop (card 337): the word "stop"
 * and nothing else but mentions and closing punctuation, in any case. A
 * message that mentions someone and not this agent is for them. Exported
 * for tests.
 */
export const isStopRequest = (text: string, botUserId: string): boolean => {
  const mentioned = [...text.matchAll(/<@([^>|]+)(?:\|[^>]*)?>/g)].map((match) => match[1]);
  if (mentioned.length > 0 && !mentioned.includes(botUserId)) {
    return false;
  }
  const words = text.replace(/<@[^>|]+(?:\|[^>]*)?>/g, ' ').trim().replace(/[.!]+$/, '').trim();
  return words.toLowerCase() === 'stop';
};

/**
 * Slack's three markup characters. Tool input is written by a model, so it
 * reaches this message as untrusted text: unescaped, `<@U123>` becomes a
 * real mention and `<!channel>` a real broadcast, letting an agent ping a
 * workspace through the very prompt asking whether to trust it. Escaping is
 * applied even inside a code block, where clients disagree about whether
 * that markup still resolves.
 */
const escapeSlackText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * What the approver is actually being asked to allow.
 *
 * Without this the prompt names only the tool, and for anything whose
 * danger lives in its arguments — the shell tool this engine exists for —
 * `ls` and a destructive command produce an identical message. Approving
 * something you cannot see is not approval.
 *
 * Truncation is announced rather than silent for the same reason: a
 * decision made on a partial view should at least know it is partial.
 */
const renderInvocation = (input: JsonObject): { detail?: string; summary: string; truncated: boolean } => {
  if (Object.keys(input).length === 0) {
    return { summary: '', truncated: false };
  }
  const rendered = JSON.stringify(input, null, 2);
  const truncated = rendered.length > APPROVAL_INPUT_LIMIT;
  const oneLine = JSON.stringify(input);
  return {
    detail: truncated ? rendered.slice(0, APPROVAL_INPUT_LIMIT) : rendered,
    summary: oneLine.length > APPROVAL_SUMMARY_LIMIT
      ? `${oneLine.slice(0, APPROVAL_SUMMARY_LIMIT)}…`
      : oneLine,
    truncated,
  };
};

const approvalBlocks = (
  agentName: string,
  toolName: string,
  risk: string,
  requestId: string,
  input: JsonObject,
  origin: string | undefined,
  oneShot: boolean,
  always: AlwaysMeans | undefined,
): SlackBlock[] => {
  const invocation = renderInvocation(input);
  const offer = oneShot ? undefined : alwaysOffer(always, agentName);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // The site, when the call is judged by one. It is not in the
        // arguments and cannot be: a `browser.act` request shows a CSS
        // selector, which says nothing about where the click lands — and
        // **Always allow** widens exactly that site, so an approver who was
        // not shown it is being asked to grant something they cannot see.
        text: `*${escapeSlackText(agentName)}* wants to run \`${escapeSlackText(toolName)}\` (${risk})`
          + `${origin ? ` on \`${escapeSlackText(origin)}\`` : ''}.`,
      },
    },
    ...(invocation.detail
      ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `\`\`\`\n${escapeSlackText(invocation.detail)}\n\`\`\`` },
        }]
      : []),
    ...(invocation.truncated
      ? [{
          type: 'context',
          elements: [{ type: 'mrkdwn', text: ':warning: Arguments shown are truncated — the full call is longer than this.' }],
        }]
      : []),
    // Why there is no second button, when there is no second button — and
    // what the second button does, when there is one.
    ...(oneShot
      ? [{
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: ':lock: An approval covers this call only — nothing about it is remembered.',
          }],
        }]
      : offer !== undefined
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: offer }] }]
        : []),
    {
      type: 'actions',
      // The request id rides on every button rather than in the message
      // reference: Slack gives the value back verbatim, so the gateway is
      // asked about the request that was actually rendered, never one
      // re-derived from a channel and timestamp.
      //
      // **Always allow** is absent when the engine would not remember the
      // answer — a `dangerous` tool, or a browser action with no page to
      // grant. Offering it there is worse than useless: it does exactly
      // what **Allow once** does, under a label promising a standing grant
      // nobody gets.
      elements: [
        { type: 'button', action_id: 'stratus_approve_once', text: { type: 'plain_text', text: 'Allow once' }, value: requestId, ...(oneShot ? { style: 'primary' } : {}) },
        ...(oneShot
          ? []
          : [{ type: 'button', action_id: 'stratus_approve_always', text: { type: 'plain_text', text: 'Always allow' }, value: requestId, style: 'primary' }]),
        { type: 'button', action_id: 'stratus_deny', text: { type: 'plain_text', text: 'Deny' }, value: requestId, style: 'danger' },
      ],
    },
  ];
};

const CREDENTIAL_ADD_ACTION = 'stratus_credential_add';
const CREDENTIAL_VIEW = 'stratus_credential';
const CREDENTIAL_BLOCK = 'credential_value';
const CREDENTIAL_INPUT = 'value';
// Under Slack's three-second acknowledgement window, with room for the ack
// itself to travel.
const CREDENTIAL_ACK_MS = 2500;
// A reason is the agent's own text, shown to a person deciding whether to
// hand over a key; long enough to explain, short enough to read.
const CREDENTIAL_REASON_LIMIT = 300;

const credentialWhose = (agentName: string, scope: CredentialScope): string =>
  scope === 'agent'
    ? `for ${agentName} only`
    : `stored for the whole fleet, granted to ${agentName} (other agents need it in their own soul)`;

/**
 * What answering means when the agent asked for the key in a variable,
 * said before anything is typed: the approval covers the binding too.
 * `agentName` arrives escaped; the variable passed the gateway's rule, so
 * it is letters, digits and underscores.
 */
const credentialShellLine = (agentName: string, env: string): string =>
  `${agentName}'s shell commands will be able to read this as \`${env}\`, so ${agentName} can see the value.`;

/**
 * The request as it appears in the conversation. What it says about the
 * value is the promise the form keeps: straight to the credential store,
 * never into the thread, and never over a key already there.
 */
const credentialRequestBlocks = (
  agentName: string,
  name: string,
  scope: CredentialScope,
  reason: string | undefined,
  requestId: string,
  replace = false,
  env?: string,
): SlackBlock[] => {
  const shortReason = reason !== undefined && reason.length > CREDENTIAL_REASON_LIMIT
    ? `${reason.slice(0, CREDENTIAL_REASON_LIMIT)}…`
    : reason;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: replace
          ? `*${escapeSlackText(agentName)}* is asking for a new value for a credential it holds: \`${escapeSlackText(name)}\`, ${credentialWhose(escapeSlackText(agentName), scope)}.`
          : `*${escapeSlackText(agentName)}* is asking for a credential: \`${escapeSlackText(name)}\`, ${credentialWhose(escapeSlackText(agentName), scope)}.`,
      },
    },
    ...(shortReason !== undefined
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `_${escapeSlackText(agentName)} says:_ ${escapeSlackText(shortReason)}` } }]
      : []),
    ...(env !== undefined
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `*${credentialShellLine(escapeSlackText(agentName), escapeSlackText(env))}*` } }]
      : []),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: replace
          ? 'Only an approver can replace it. The new value goes straight to the credential store, never into this conversation, and the stored one is kept until it saves.'
          : 'Only an approver can add it. The value goes straight to the credential store, never into this conversation, and a key already stored is never replaced by an add.',
      }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: CREDENTIAL_ADD_ACTION,
        style: 'primary',
        value: requestId,
        text: { type: 'plain_text', text: replace ? 'Replace credential' : 'Add credential' },
      }],
    },
  ];
};

/**
 * The form. `private_metadata` carries only the request id: where the key
 * goes, and for whom, is the gateway's record of the request, never
 * something a submission can say about itself.
 */
const credentialModal = (post: PendingCredentialPost, requestId: string): SlackBlock => ({
  type: 'modal',
  callback_id: CREDENTIAL_VIEW,
  private_metadata: requestId,
  title: { type: 'plain_text', text: post.replace === true ? 'Replace a credential' : 'Add a credential' },
  submit: { type: 'plain_text', text: post.replace === true ? 'Replace' : 'Add' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: (post.replace === true
          ? `\`${escapeSlackText(post.name)}\`, ${credentialWhose(escapeSlackText(post.agentName), post.scope)}. `
            + 'The new value replaces the stored one once it saves; it never appears in the conversation.'
          : `\`${escapeSlackText(post.name)}\`, ${credentialWhose(escapeSlackText(post.agentName), post.scope)}. `
            + `It is stored add-only and granted to ${escapeSlackText(post.agentName)}; it never appears in the conversation.`)
          + (post.env !== undefined ? ` ${credentialShellLine(escapeSlackText(post.agentName), escapeSlackText(post.env))}` : ''),
      },
    },
    {
      type: 'input',
      block_id: CREDENTIAL_BLOCK,
      label: { type: 'plain_text', text: `Value for ${post.name}` },
      element: { type: 'plain_text_input', action_id: CREDENTIAL_INPUT },
    },
  ],
});

interface PendingCredentialPost {
  connection: AgentConnection;
  channel: string;
  /** The thread the request was posted in, for a late answer's notice. */
  thread?: string;
  ts: string;
  agentId: string;
  agentName: string;
  name: string;
  scope: CredentialScope;
  /** A new value for a key the agent holds, rather than an add. */
  replace?: boolean;
  /** The variable the agent's shell will read it from, which the form says. */
  env?: string;
  /** Bound at render time, as an approval request's are. */
  approvers: Set<string>;
}

interface PendingApprovalPost {
  connection: AgentConnection;
  channel: string;
  ts: string;
  thread?: string;
  agentName: string;
  toolName: string;
  risk: string;
  /**
   * Whether `always` on this request would have remembered anything —
   * carried from the request rather than re-derived, because the outcome
   * has to describe the answer that was actually possible. `POST
   * /approvals` still accepts all three answers, so another client can
   * submit `always` for a request this channel never offered it on.
   */
  oneShot: boolean;
  /** What `always` would grant, from the request, for the same reason. */
  always?: AlwaysMeans;
  agentId: string;
  /** Bound at render time, so a later config change cannot widen a live request. */
  approvers: Set<string>;
}

/**
 * A message `admit` has decided is this agent's, and everything it worked
 * out on the way — so the async half neither re-derives nor re-reads any of
 * it. `settled: false` is the one open question left: whether the sessions
 * say this untagged reply is ours.
 */
interface Admission {
  event: SlackInboundEvent;
  isDm: boolean;
  team: string;
  userId: string;
  sessionId: string;
  thread?: string;
  /** Absent for a DM, which has one agent by construction. */
  threadKey?: string;
  /**
   * The key the message is known by whichever delivery carried it — the
   * dedupe key, and the dispatch's idempotency key, so a redelivery the
   * in-memory dedupe has forgotten (a restart, an eviction) still starts
   * no second turn.
   */
  eventKey: string;
  settled: boolean;
  /**
   * In the thread, if at all, as a listener: the message is somebody
   * else's to answer, and this agent hears it into its session rather than
   * replying. Decided here for the two cases the process can settle
   * synchronously — a message naming another agent, and one an earlier
   * handover gave to another agent — and by the sessions for the cold one.
   */
  overhear: boolean;
  /**
   * An untagged message reaching an agent that judges (`listens: judge`)
   * that is this agent's to judge (card 541): the person last addressed it
   * by name, or else it owns the thread. It runs a turn nobody asked for,
   * which may stay quiet. With `settled: false` only the sessions can say
   * whose the thread is, and the intake decides.
   */
  judge: boolean;
  /** Why a judging agent took or left an untagged reply, for the log line. No message text. */
  judgeReason?: string;
  /**
   * An approver's untagged stop in a thread this agent holds, reaching an
   * agent that listens to mentions or judges (card 337). Still heard if
   * nothing is running to stop, but if something is, it stops it: the
   * holder rule is what makes an untagged stop this agent's, whatever
   * `listens` says about ordinary replies.
   */
  holderStop?: boolean;
  /**
   * The team agent this message came from, when another agent's bot named
   * this one (card 513). Its words are labelled `unknown`, and it is never
   * a stop or an approver's reply.
   */
  fromAgent?: string;
}

interface AgentConnection {
  config: SlackAgentConfig;
  web: SlackWebLike;
  socket: SlackSocketLike;
  botUserId: string;
  teamId: string;
  /** Whether a refused loading status has been said for this app yet; see `ReplyRenderer.setStatus`. */
  statusWarned: { value: boolean };
}

/**
 * The Slack channel adapter. One Slack app per agent — Slack has no way to
 * give a single bot several identities with real avatars, presence, and
 * DMs — so the adapter runs one Socket Mode connection per configured
 * agent and maps each app to its agent id.
 *
 * Session keys are `slack:<agent>:<team>:<channel>:<thread_ts ?? ts>`
 * (DMs: the DM channel id alone), so threads are resumable conversations
 * and two agents sharing a thread keep fully separate sessions. Replies
 * post once, finished, behind Slack's loading status — or, in the `stream`
 * reply mode, stream via placeholder-then-edit, throttled for chat.update
 * limits.
 *
 * A mention starts a thread conversation; inside one, the agent keeps
 * listening without being tagged again — see `couldBeFollowUp` and
 * `answersFollowUp` for exactly whose reply an untagged message is. That
 * needs the app to be subscribed to `message.channels` / `message.groups`
 * / `message.mpim` (the shipped manifest is); an app installed before
 * those were in it receives only `app_mention` and behaves as it always
 * did, which makes the workspace's own grant the switch.
 */
/** Uncached author names one `message.read` looks up; the rest keep their id. */
const READ_NAME_LOOKUPS = 10;

/** Slack's longest channel name. */
const CHANNEL_NAME_LIMIT = 80;
/** Slack's longest channel topic, and its longest purpose. */
const CHANNEL_TEXT_LIMIT = 250;
/** The most users one `conversations.invite` call takes. */
const CHANNEL_INVITE_LIMIT = 1000;

/** A bookmark title longer than this is cut, with an ellipsis. */
const BOOKMARK_TITLE_LIMIT = 200;
/** A bookmark link longer than this is replaced by `BOOKMARK_LINK_TOO_LONG`. */
const BOOKMARK_LINK_LIMIT = 2000;
const BOOKMARK_LINK_TOO_LONG = '(this link is longer than 2,000 characters, so it is not shown)';

/**
 * The error code of a failed Web API call (`missing_scope`, `ratelimited`),
 * which `@slack/web-api` puts on the error's `data.error`. Undefined for a
 * failure that never reached Slack.
 */
const slackErrorCode = (error: unknown): string | undefined => {
  const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};

/** Slack's code for a failed call, or the SDK's message when Slack never answered. */
const describeSlackError = (error: unknown): string => slackErrorCode(error) ?? (error instanceof Error ? error.message : String(error));

/** Codes Slack answers when the token itself is refused. */
const SLACK_AUTH_ERRORS = new Set(['not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired']);

/**
 * Codes with which Slack refuses a whole `conversations.invite` without
 * inviting anyone, so `inviteToConversation` can reject and the members
 * are known unchanged. Everything else, per-person codes and failures that
 * may have partly worked included, is settled per entry instead.
 */
const SLACK_INVITE_REFUSALS = new Set([
  'not_in_channel',
  'missing_scope',
  'is_archived',
  'channel_not_found',
  'method_not_supported_for_channel_type',
  'no_user',
  'ratelimited',
  ...SLACK_AUTH_ERRORS,
]);

/**
 * What `channel_not_found` means to an app: Slack says the same for a
 * wrong id and for a private channel it can't see, and so does
 * `conversations.info`, so the sentence names both.
 */
const channelNotFoundSentence = (agentId: string, conversation: string): string =>
  `Slack found no channel ${conversation} that ${agentId}'s app can see. Check the id (copy it from the channel's link; a name won't work). `
  + 'If the id is right, the channel is private, and a member has to invite the app.';

/**
 * Orders two Slack message timestamps ("seconds.micros"). Compared as
 * integers, not floats: a current ts has more digits than a double holds.
 */
const compareSlackTs = (left: string, right: string): number => {
  const [leftSeconds = '0', leftMicros = ''] = left.split('.');
  const [rightSeconds = '0', rightMicros = ''] = right.split('.');
  const seconds = Number(leftSeconds) - Number(rightSeconds);
  if (seconds !== 0) {
    return Math.sign(seconds);
  }
  return Math.sign(Number(leftMicros.padEnd(6, '0').slice(0, 6)) - Number(rightMicros.padEnd(6, '0').slice(0, 6)));
};

/** What a Slack stop aborts a turn with, followed by the stopper's user id. */
const SLACK_STOP_REASON = 'Stopped from Slack by ';

/**
 * Who stopped a turn, read back from the error it failed with: the gateway
 * fails an aborted turn with the abort's reason verbatim.
 */
const slackStopper = (error: string | undefined): string | undefined =>
  error?.startsWith(SLACK_STOP_REASON) ? error.slice(SLACK_STOP_REASON.length) || undefined : undefined;

export const createSlackChannelAdapter = (options: SlackAdapterOptions): ChannelAdapter => {
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  const editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
  const createSocket = options.createSocketClient ?? defaultSocketClient;
  const createWeb = options.createWebClient ?? defaultWebClient;
  const fetchFile = onlySlackFileHost(options.fetchFile ?? defaultFetchFile);
  const fileDownloadTimeoutMs = options.fileDownloadTimeoutMs ?? DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS;
  const stopWaitMs = options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
  const approvalPromptWaitMs = options.approvalPromptWaitMs ?? DEFAULT_APPROVAL_PROMPT_WAIT_MS;
  const progressAfterMs = options.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS;
  const now = options.now ?? Date.now;

  const connections: AgentConnection[] = [];
  // The agents this adapter carries: `options.agents` until a reload reads
  // another list (`options.loadAgents`).
  let carried: SlackAgentConfig[] = options.agents;
  // Every agent this adapter was asked to carry, connected or not — the
  // difference between "mine and broken" and "not mine".
  const configuredAgents = new Set(carried.map((agent) => agent.agentId));
  // Renderers queue per session: two messages in one thread share a
  // session id, and the gateway serializes their turns — so events route
  // to the FIRST registered renderer (the running turn), never a later
  // message's placeholder. Each handler removes exactly its own renderer.
  const renderers = new Map<string, ReplyRenderer[]>();
  /**
   * Per session, what the newest `final` reply has left to post. A `final`
   * turn holds no place in the thread until it posts, so each waits for
   * the one queued ahead of it — see `ReplyRenderer.after`.
   */
  const replyOrder = new Map<string, Promise<void>>();
  /**
   * Files a turn nobody here rendered produced — a recovery's screenshot,
   * say — keyed by session, waiting for the turn's outcome to be posted so
   * they can follow it into the thread. A rendered turn's files go through
   * its renderer as they are produced; these have no renderer to go through.
   */
  const unrenderedFiles = new Map<string, string[]>();
  // In-flight turns, so stop() can drain: a reply mid-render should reach
  // Slack before the sockets go away.
  const inflight = new Set<Promise<void>>();
  // Per-session intake chains: the pre-dispatch pipeline (lookups,
  // placeholder, dispatch call) runs in Slack receipt order.
  const intakeChains = new Map<string, Promise<void>>();
  /**
   * Stop (card 337), for messages still in intake: how many each session
   * has between claiming a place on its chain and reaching `renderers`, and
   * the latest stop to land there. A message compares the stop it claimed
   * its place under with the one in force when it is about to dispatch, so a
   * stop also cancels a message whose lookups were still running.
   */
  const intakeInFlight = new Map<string, number>();
  const stopsBySession = new Map<string, { count: number; by: string }>();
  const displayNames = new Map<string, string>();
  // Socket Mode redelivers on missed acks; a slow turn must not run twice.
  const seenEvents = new Set<string>();
  const seenOrder: string[] = [];
  // `cold`: rebuilt from a thread read rather than seen live. Those are
  // posts only (a mention nobody has answered yet is not one), so the
  // owner rule may use them but `holderAt` (who was asked last) may not.
  type Handover = { agentId: string; ts: string; takes?: boolean; cold?: boolean };

  /**
   * Who each thread was last handed to, in SLACK RECEIPT ORDER — written
   * the moment a message is accepted for an agent, before any of the work
   * that message causes.
   *
   * The durable answer (`answersFollowUp`) is the agents' own sessions,
   * and it lags: a session row is written when its turn starts, which is a
   * display-name lookup and a placeholder post after the message that
   * asked for it. Inside that window the persisted order still names the
   * agent that spoke *before* the handover, so a mention of Bea followed
   * straight away by an untagged addendum would send the addendum to Ava —
   * and a follow-up typed on the heels of the mention that opened the
   * thread would find no session at all and be dropped for good.
   *
   * Keyed by thread rather than by (agent, thread): one agent has it at a
   * time, so there is nothing to reconcile. The value is that thread's
   * HANDOVERS in order, not just its latest one, because the question an
   * untagged message asks is not "who holds this thread now" but "who held
   * it when I was sent". Those differ whenever a socket runs behind
   * another: Bea's connection can reject a pre-handover reply, then take
   * the mention that moves the thread to her, and Ava's connection reach
   * that same earlier reply afterwards — which the latest holder alone
   * would reject for a second time, dropping a message that was plainly
   * Ava's when it was written.
   *
   * Keeping the handovers also makes out-of-order writes ordinary rather
   * than dangerous. A connection several messages behind, or a redelivered
   * envelope carrying an old mention, inserts into the past where it
   * belongs instead of overwriting the present.
   *
   * Bounded and lossy on purpose — evicting an entry costs one lookup,
   * since the sessions still hold the answer for every thread this map has
   * forgotten, and for every thread a restart forgot.
   *
   * One thing they cannot reconstruct: a handover made in the seconds
   * before the daemon went down. The mention that moved the thread is
   * recorded only here, and the newly named agent has not replied yet, so
   * after a restart the sessions still name the previous speaker and the
   * next untagged reply goes to them. Surviving that needs durable
   * adapter-owned state, which the channel contract deliberately does not
   * have — an adapter reads routing and translates events, and inventing a
   * private store here is the wrong place to answer it. The next mention
   * corrects it.
   */
  const threadAddressee = new Map<string, Handover[]>();
  /**
   * Per thread whose record has been cut in the middle (`trimHandovers`),
   * the first claim kept after the cut. Who held the thread between its
   * first claim and that one is no longer known here (card 559): a message
   * from then is left to the sessions and a thread read, rather than
   * placed by the first claim, or the latest take, that outlived the cut.
   * Goes with the thread's record.
   */
  const threadTrimmedUntil = new Map<string, string>();
  /**
   * Per thread the record was warmed from a thread read (#369), the last
   * message a read covered. A read stops at the message it places, so one
   * for a message from before this process started (delivered late, or a
   * replay after a restart) leaves out every take between that message and
   * the start (card 562). `liveFrom` is when every socket was up, plus a
   * margin for clock skew: claims since were seen live. Goes with the
   * thread's record.
   */
  const threadReadUntil = new Map<string, string>();
  let liveFrom: string | undefined;
  /**
   * Threads whose owner this process can name (card 508): `true` for one
   * whose first message it saw, so the first claim in `threadAddressee` is
   * the owner, or the owner itself when the thread read named it after a
   * restart. Absent for a thread that started before this process did:
   * its first claim here is only the first one SEEN, and an untagged reply
   * in it asks the sessions and the thread (see `ownerAt`). Bounded like
   * the addressee map; a lost entry costs a lookup.
   */
  const threadOrigins = new Map<string, true | string>();
  /**
   * Per thread, the agent each person last addressed by name, and when
   * (card 541). An untagged reply from that person is that agent's —
   * `@Bea your turn`, then `and?`, is Bea's — ahead of the thread's owner,
   * who keeps every reply from someone who has not addressed anyone else.
   * Recorded by every socket from the message itself, before any refusal,
   * as a handover is, so the sockets agree. Bounded like the addressee map;
   * a lost entry, or a restart, falls back to the owner.
   */
  const senderAddressees = new Map<string, Map<string, Array<{ agentId: string; ts: string }>>>();
  const rememberSenderAddressee = (key: string, sender: string, agentId: string, ts: string): void => {
    const senders = senderAddressees.get(key) ?? new Map<string, Array<{ agentId: string; ts: string }>>();
    // Kept in timestamp order, so a socket that is behind can still find the
    // mention that preceded the reply it is only now reaching. A late
    // delivery of an older mention slots in where it belongs.
    const history = (senders.get(sender) ?? []).filter((entry) => entry.ts !== ts);
    let at = history.length;
    while (at > 0 && history[at - 1]!.ts > ts) {
      at -= 1;
    }
    history.splice(at, 0, { agentId, ts });
    if (history.length > SENDER_ADDRESSEE_DEPTH) {
      history.splice(0, history.length - SENDER_ADDRESSEE_DEPTH);
    }
    // Most recently heard sender last, so the first key is the one to drop.
    senders.delete(sender);
    senders.set(sender, history);
    if (senders.size > THREAD_SENDER_CAPACITY) {
      const oldest = senders.keys().next();
      if (!oldest.done) {
        senders.delete(oldest.value);
      }
    }
    senderAddressees.delete(key);
    senderAddressees.set(key, senders);
    if (senderAddressees.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = senderAddressees.keys().next();
      if (!oldest.done) {
        senderAddressees.delete(oldest.value);
      }
    }
  };
  /**
   * The agent `sender` last addressed in thread `key` before `ts`, if this
   * process saw it. A reply older than every mention still remembered for
   * that sender has nothing to go on, and falls back to the owner.
   */
  const senderAddresseeAt = (key: string, sender: string, ts: string): string | undefined => {
    const history = senderAddressees.get(key)?.get(sender);
    if (!history) {
      return undefined;
    }
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]!.ts < ts) {
        return history[i]!.agentId;
      }
    }
    return undefined;
  };
  /** Whose an untagged reply from `sender` at `ts` is: who they last addressed, else the owner. */
  const replyTargetAt = (key: string, sender: string, ts: string): string | undefined =>
    senderAddresseeAt(key, sender, ts) ?? ownerAt(key, ts);
  /**
   * One cold verdict per message — see `followUpWinner`. Bounded, because
   * an entry outlives its own resolution on purpose; an entry that has not
   * yet resolved is never the one evicted, since the agent still waiting on
   * it would otherwise start a second one.
   */
  const coldVerdicts = new Map<string, { verdict: Promise<string | undefined>; settled: boolean }>();
  /**
   * `agentId` → bot user id, for every app whose token this adapter has
   * authenticated — whether or not its socket then came up, and kept for as
   * long as the adapter runs.
   *
   * Separate from `connections` because recognizing that somebody was named
   * and being able to answer are different questions. An agent whose app is
   * down cannot answer anything; a message that names it is still not the
   * other agent's to take, and treating it as untagged would have the wrong
   * agent answer a question a person deliberately handed elsewhere. Silence
   * is the correct outcome there, and it is also the visible one — the same
   * thing a mention has always done when an app is down.
   *
   * Insertion order is the carried agents' order (`options.agents`, or the
   * list a reload read), which is what makes `agentNamedIn` deterministic
   * across every connection.
   */
  const botIdentities = new Map<string, { botUserId: string; teamId: string }>();
  // Rendered approval requests, keyed by the gateway's request id — the
  // same id the buttons carry back.
  //
  // In memory only, and that is an open gap: a prompt posted by a process
  // that died is never retracted unless someone clicks it (a click on a
  // prompt this process never posted rewrites it from the click's own
  // coordinates). Retracting the ones nobody clicks needs a durable index
  // of these posts that survives the process that made them.
  const approvalPosts = new Map<string, PendingApprovalPost>();
  // Credential requests whose post is in flight: Slack can show the message,
  // and take a click on it, before postMessage resolves here. The same
  // window `rendering` covers for approvals, and bounded the same way.
  const credentialsPosting = new Set<string>();
  // Credential requests with a live button, keyed by the gateway's request id.
  const credentialPosts = new Map<string, PendingCredentialPost>();
  // Requests whose message is mid-post. A request can settle — expire, or
  // its turn be cancelled — while the postMessage that announces it is
  // still in flight, and the retraction would then find nothing to retract
  // and leave live-looking buttons behind forever. Resolutions arriving in
  // that window are held here and applied once the post lands. Bounded by
  // construction: an id is only ever in this set while one HTTP call is
  // outstanding.
  const rendering = new Set<string>();
  const resolvedWhileRendering = new Map<string, Extract<StratusEvent, { type: 'tool.approval-resolved' }>>();
  // Requests whose prompt is waiting for its turn's line to land first
  // (card 950), and those of them settled in that wait: a request answered
  // or cancelled before anyone was asked has no prompt to post. Bounded the
  // same way: an id is here only for one bounded wait.
  const askingAfterLine = new Set<string>();
  const settledBeforeAsked = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let gatewayRef: GatewayLike | undefined;
  // Set as `stop()` begins, so a reload still connecting an app leaves
  // nothing up behind the stop.
  let stopRequested = false;
  // Sockets between `start()` and `connections`, by the agent they serve
  // (card 935). A stop can't see them to close them: `connect` closes each
  // once its start returns, and the stop waits for that, bounded.
  const socketsStarting = new Map<Promise<boolean>, string>();
  // Agents whose socket `connect` could not close for a stop: up still,
  // which the stop has to report.
  const leftUpAtStop = new Set<string>();

  // Everything the adapter owes Slack goes through here, so stop() drains
  // it: an approval question or its retraction must reach the workspace
  // before the sockets close, or a message keeps offering buttons that
  // nothing is listening for.
  const track = (work: Promise<void>): void => {
    // Also the rejection boundary, because this is where the work stops
    // being anyone's to await: the caller hands it over and returns to the
    // event loop, so a rejection past this point is attached to nothing
    // and takes the daemon down under Node's default. One call site below
    // remembers to catch before handing over, which is exactly the kind of
    // rule that holds until the next call site forgets it -- so it lives
    // here instead, where there is one of it.
    const settled = work.catch((error) => {
      warn(`slack: background work failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    inflight.add(settled);
    void settled.finally(() => inflight.delete(settled));
  };

  /**
   * The kept messages (see `pendingIntakePath`), read and written one change
   * at a time so two refusals landing together cannot drop each other.
   */
  const pendingIntakePath = options.pendingIntakePath;
  let pendingChain: Promise<unknown> = Promise.resolve();
  const readPending = async (file: string): Promise<PendingIntake[]> => {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(isPendingIntake);
      }
    } catch {
      // Named below, and replaced by the next write.
    }
    warn(`slack: ${file} is not a list of kept messages; ignoring it`);
    return [];
  };
  const changePending = <T>(change: (entries: PendingIntake[]) => { entries: PendingIntake[]; result: T }): Promise<T> => {
    const file = pendingIntakePath;
    if (file === undefined) {
      return Promise.reject(new Error('no pendingIntakePath'));
    }
    const run = pendingChain.then(async () => {
      const before = await readPending(file);
      const { entries, result } = change(before);
      if (entries.length === 0) {
        await rm(file, { force: true });
      } else {
        // Whole or not at all: a crash mid-write must not leave half a list
        // that the next start reads as no list.
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, file);
      }
      return result;
    });
    pendingChain = run.catch(() => undefined);
    return run;
  };
  const pendingKey = (entry: Pick<PendingIntake, 'agentId' | 'team' | 'channel' | 'ts'>): string => `${entry.agentId}:${entry.team}:${entry.channel}:${entry.ts}`;
  /**
   * Kept messages being replayed, by `pendingKey`. A replayed message comes
   * off the list only once its answer is confirmed (`answered`): an answer
   * or failure Slack took, a turn that chose to say nothing, or the
   * start-up recovery's own report of it reaching the thread. Every other
   * way a handler can end leaves it kept, so a path that forgets to say
   * how it went keeps the message rather than losing it. A message kept
   * again by a restart during the replay (`rekept`) stays kept too. The
   * next start hands it over again, and the gateway repeats the finished
   * turn, so the answer is posted from the session rather than run again.
   * `dispatched` and `refused` only choose the warning.
   */
  const replaying = new Map<string, { dispatched: boolean; rekept: boolean; refused: boolean; answered: boolean }>();
  /** Notes a reply outcome against the kept message it answers, if that one is being replayed. */
  const noteReplayOutcome = (connection: AgentConnection, channel: string, ts: string, outcome: ReplyOutcome): ReplyOutcome => {
    const replay = replaying.get(pendingKey({ agentId: connection.config.agentId, team: connection.teamId, channel, ts }));
    if (replay !== undefined) {
      if (outcome.refused === true) {
        replay.refused = true;
      } else {
        replay.answered = true;
      }
    }
    return outcome;
  };
  /** Confirms that a replayed message was answered by a report posted ahead of its own renderer. */
  const noteReplayAnsweredAhead = (connection: AgentConnection, channel: string, ts: string): void => {
    const replay = replaying.get(pendingKey({ agentId: connection.config.agentId, team: connection.teamId, channel, ts }));
    if (replay !== undefined) {
      replay.answered = true;
    }
  };
  /**
   * Live intake for a conversation (agent and channel) that has kept
   * messages waits here until each of them has taken its place on its
   * session's chain or been left for the next start, so a kept message is
   * never answered after one sent later in the same conversation. Other
   * conversations are not held. There is no timeout on the hold itself:
   * the bound is on each read (`REPLAY_READ_MAX_MS`), and a read that
   * outlasts it gives up its message for this run, which releases the hold.
   */
  const replayHolds = new Map<string, { held: Promise<void>; release: () => void }>();
  const holdKey = (agentId: string, channel: string): string => `${agentId}:${channel}`;
  /**
   * Whether `connection` is the one to replay `entry` through: the same
   * agent in the workspace it was kept from. Channel and user ids belong to
   * a workspace, so an agent whose credentials moved to another one leaves
   * the entry kept (and its day-old expiry) rather than reading or answering
   * whatever has that id there.
   */
  const keptFor = (connection: AgentConnection, entry: PendingIntake): boolean =>
    connection.config.agentId === entry.agentId && connection.teamId === entry.team;
  const holdConversation = (key: string): void => {
    if (replayHolds.has(key)) {
      return;
    }
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = () => {
        replayHolds.delete(key);
        resolve();
      };
    });
    replayHolds.set(key, { held, release });
  };
  const releaseConversation = (key: string): void => replayHolds.get(key)?.release();
  /** Aborted by `stop()`, which ends a replay still reading kept messages back. */
  let replayStopping: AbortController | undefined;
  const releaseAllConversations = (): void => {
    for (const { release } of [...replayHolds.values()]) {
      release();
    }
  };
  /** Keeps a refused message for the next start; resolves with whether it was kept. */
  const keepForNextStart = async (entry: PendingIntake): Promise<boolean> => {
    if (pendingIntakePath === undefined) {
      return false;
    }
    try {
      // Every kept message was told it will be answered, so a full list
      // never evicts one of them: it makes room only from messages too old
      // to be answered at start anyway, and otherwise refuses this one, which
      // then gets the plain refusal and no promise.
      const { full, expired } = await changePending((entries) => {
        const key = pendingKey(entry);
        let others = entries.filter((existing) => pendingKey(existing) !== key);
        let expired: PendingIntake[] = [];
        if (others.length >= PENDING_INTAKE_MAX) {
          const cutoff = now() - PENDING_INTAKE_MAX_AGE_MS;
          expired = others.filter((existing) => existing.keptAt < cutoff);
          others = others.filter((existing) => existing.keptAt >= cutoff);
        }
        if (others.length >= PENDING_INTAKE_MAX) {
          return { entries, result: { full: true, expired: [] as PendingIntake[] } };
        }
        return { entries: [...others, entry], result: { full: false, expired } };
      });
      for (const dropped of expired) {
        log(`slack: ${dropped.agentId} dropped ${dropped.ts} in ${dropped.channel} kept from a restart: older than a day`);
      }
      if (full) {
        warn(`slack: could not keep ${entry.ts} in ${entry.channel} for after the restart: ${PENDING_INTAKE_MAX} messages are already kept`);
        return false;
      }
      const replay = replaying.get(pendingKey(entry));
      if (replay !== undefined) {
        replay.rekept = true;
      }
      return true;
    } catch (error) {
      warn(`slack: could not keep ${entry.ts} in ${entry.channel} for after the restart: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  /** The kept message itself, as Slack has it now; `undefined` when it is gone. */
  const fetchKept = async (connection: AgentConnection, entry: PendingIntake): Promise<SlackHistoryMessage | undefined> => {
    const { history, replies } = connection.web.conversations;
    const inThread = entry.threadTs !== undefined && entry.threadTs !== entry.ts;
    const range = { channel: entry.channel, oldest: entry.ts, latest: entry.ts, inclusive: true };
    const page = inThread
      ? await replies?.call(connection.web.conversations, { ...range, ts: entry.threadTs as string, limit: 2 })
      : await history?.call(connection.web.conversations, { ...range, limit: 1 });
    if (page === undefined) {
      throw new Error('this Slack client cannot read conversations');
    }
    return page.messages?.find((message) => message.ts === entry.ts);
  };
  /** One kept message read back with a bound; `timedOut` when Slack took longer than that. */
  const fetchKeptWithin = async (connection: AgentConnection, entry: PendingIntake): Promise<{ message?: SlackHistoryMessage; timedOut?: true }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), REPLAY_READ_MAX_MS);
    });
    try {
      return await Promise.race([
        fetchKept(connection, entry).then((message) => (message !== undefined ? { message } : {})),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * What the last daemon kept, handled as if it had just arrived: through
   * admission, the thread rules, and a dispatch keyed as the original
   * delivery would have been, so a message the gateway already ran is a
   * repeat there and not a second turn. That makes handing one over twice
   * safe and losing one not, so each comes off the list only once its
   * handler has reached the gateway and settled: a crash, or a failure
   * before the dispatch (the reply could not be started), leaves it for the
   * next start, and one kept again by a restart during the replay stays
   * kept. A message deleted since is dropped.
   *
   * Each conversation is replayed in ts order while its live intake is held
   * (`replayHolds`), and released once its kept messages are handed over.
   * A read that fails or outlasts `REPLAY_READ_MAX_MS` leaves that message,
   * and the ones kept after it in the conversation, for the next start:
   * handing a later one over first, or the slow one over after live
   * messages were let in, would answer them out of order.
   */
  const replayKept = async (kept: PendingIntake[], onEvent: Map<string, (args: SlackSocketEventArgs) => Promise<void>>, stopping: AbortSignal): Promise<void> => {
    if (pendingIntakePath === undefined || kept.length === 0) {
      return;
    }
    const cutoff = now() - PENDING_INTAKE_MAX_AGE_MS;
    const expired = kept.filter((entry) => entry.keptAt < cutoff);
    for (const entry of expired) {
      log(`slack: ${entry.agentId} dropped ${entry.ts} in ${entry.channel} kept from a restart: older than a day`);
    }
    // Not waited on before the reads: the list's writes are serialized, so
    // this one lands ahead of any the replay makes, and the reads start
    // inside start() (a stop right after it still sees each conversation's
    // first one through).
    const old = new Set(expired.map(pendingKey));
    const droppingExpired = expired.length > 0
      ? changePending((entries) => ({ entries: entries.filter((entry) => !old.has(pendingKey(entry))), result: undefined }))
        .catch((error) => warn(`slack: could not drop the day-old messages kept from a restart; the next start drops them: ${error instanceof Error ? error.message : String(error)}`))
      : Promise.resolve();
    const conversations = new Map<string, PendingIntake[]>();
    for (const entry of kept.filter((candidate) => candidate.keptAt >= cutoff)) {
      const elsewhere = connections.find((connection) => connection.config.agentId === entry.agentId && !keptFor(connection, entry));
      if (elsewhere !== undefined) {
        warn(`slack: ${entry.agentId} kept ${entry.ts} in ${entry.channel} from workspace ${entry.team}, but is now connected to ${elsewhere.teamId}; keeping it for a start in that workspace`);
        continue;
      }
      const key = holdKey(entry.agentId, entry.channel);
      conversations.set(key, [...(conversations.get(key) ?? []), entry]);
    }
    const handovers: Array<Promise<void>> = [];
    const replayConversation = async (key: string, entries: PendingIntake[]): Promise<void> => {
      try {
        entries.sort((a, b) => compareSlackTs(a.ts, b.ts));
        const agentId = entries[0]!.agentId;
        const connection = connections.find((candidate) => keptFor(candidate, entries[0]!));
        const handle = onEvent.get(agentId);
        if (connection === undefined || handle === undefined) {
          return;
        }
        for (const [index, entry] of entries.entries()) {
          // A stop ends the replay at the next message: what it has not read
          // yet stays kept for the next start, so the stop waits on at most
          // the one bounded read in progress per conversation, not a chain
          // of them.
          if (stopping.aborted) {
            log(`slack: ${agentId} stopping; leaving ${entries.length - index} kept message(s) in ${entry.channel} for the next start`);
            return;
          }
          let read: { message?: SlackHistoryMessage; timedOut?: true };
          try {
            read = await fetchKeptWithin(connection, entry);
          } catch (error) {
            warn(`slack: could not read ${entry.ts} in ${entry.channel} kept from the last restart; keeping it and ${entries.length - index - 1} after it for the next start: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          if (read.timedOut === true) {
            warn(`slack: reading ${entry.ts} in ${entry.channel} kept from the last restart took over ${REPLAY_READ_MAX_MS / 1000}s; keeping it and ${entries.length - index - 1} after it for the next start`);
            return;
          }
          const message = read.message;
          if (message === undefined) {
            const gone = pendingKey(entry);
            await changePending((current) => ({ entries: current.filter((kept) => pendingKey(kept) !== gone), result: undefined }));
            log(`slack: ${entry.agentId} dropped ${entry.ts} in ${entry.channel} kept from a restart: no longer in Slack`);
            continue;
          }
          log(`slack: ${entry.agentId} replaying ${entry.ts} in ${entry.channel}, sent during the last restart`);
          const event = {
            ...(message as unknown as SlackInboundEvent),
            type: 'message',
            channel: entry.channel,
            ts: entry.ts,
            ...(entry.threadTs !== undefined ? { thread_ts: entry.threadTs } : {}),
            ...(entry.channelType !== undefined ? { channel_type: entry.channelType } : {}),
          };
          const replayKey = pendingKey(entry);
          const replay = { dispatched: false, rekept: false, refused: false, answered: false };
          replaying.set(replayKey, replay);
          // Not waited on: the handler claims its place on its session's
          // chain synchronously, as a live delivery does, so the next kept
          // message (and, after the last, the held live ones) queue behind it.
          const handled = handle({ ack: async () => {}, body: { team_id: entry.team }, event });
          handovers.push(handled.catch(() => undefined).then(async () => {
            replaying.delete(replayKey);
            if (replay.rekept) {
              return;
            }
            if (!replay.dispatched) {
              warn(`slack: ${entry.agentId} could not hand ${entry.ts} in ${entry.channel} kept from a restart to the gateway; keeping it for the next start`);
              return;
            }
            if (replay.refused) {
              warn(`slack: ${entry.agentId} could not post the answer to ${entry.ts} in ${entry.channel} kept from a restart; keeping it for the next start`);
              return;
            }
            if (!replay.answered) {
              warn(`slack: ${entry.agentId} has no confirmed answer to ${entry.ts} in ${entry.channel} kept from a restart; keeping it for the next start`);
              return;
            }
            await changePending((current) => ({ entries: current.filter((kept) => pendingKey(kept) !== replayKey), result: undefined }));
          }));
        }
      } finally {
        releaseConversation(key);
      }
    };
    await Promise.all([...conversations].map(([key, entries]) => replayConversation(key, entries)));
    await Promise.all(handovers);
    await droppingExpired;
  };

  const alreadySeen = (key: string): boolean => {
    if (seenEvents.has(key)) {
      return true;
    }
    seenEvents.add(key);
    seenOrder.push(key);
    if (seenOrder.length > DEDUPE_CAPACITY) {
      const evicted = seenOrder.shift();
      if (evicted) {
        seenEvents.delete(evicted);
      }
    }
    return false;
  };

  // User ids are only unique within a workspace; two agents' apps can live
  // in different workspaces, so the cache key carries the team.
  const displayNameFor = async (connection: AgentConnection, userId: string): Promise<string> => {
    const cacheKey = `${connection.teamId}:${userId}`;
    const cached = displayNames.get(cacheKey);
    if (cached) {
      return cached;
    }
    try {
      const info = await connection.web.users.info({ user: userId });
      const name = info.user?.profile?.display_name || info.user?.profile?.real_name || info.user?.name || userId;
      displayNames.set(cacheKey, name);
      return name;
    } catch {
      return userId;
    }
  };

  /**
   * A display name as the model may read it: one line, bounded. It is text
   * its owner typed into their profile, and it lands in the speaker
   * position of a user turn (`Name: text`) or as `@Name` inside one — where
   * a newline, or a name long enough to be a paragraph, would let its owner
   * speak in a place nobody vouched for. Escaped rather than dropped, the
   * way memory entries are, so a strange name still reads as strange.
   */
  const boundedDisplayName = (name: string): string => {
    // Code points, not UTF-16 units: an emoji is one character of a name,
    // and a cut inside a surrogate pair is a malformed speaker.
    const characters = Array.from(escapeControlCharacters(name).trim());
    return characters.length > MAX_DISPLAY_NAME_LENGTH
      ? `${characters.slice(0, MAX_DISPLAY_NAME_LENGTH - 1).join('')}…`
      : characters.join('');
  };

  /**
   * Who is speaking, as the model reads it. A principal's profile is
   * trusted the way their messages are, so it is their display name. With
   * a principals list in force everyone else is their stable id, as a
   * mention of them already is: named, not quoted. With no list at all
   * there is nobody to prefer, so every author keeps their name — the turn
   * is labelled `unknown` either way. "No list" is the key being absent:
   * an explicit empty list is how an agent is excluded from a shared one,
   * and it means nobody is preferred, not that nobody has been named.
   */
  const authorFor = async (connection: AgentConnection, userId: string): Promise<string> => {
    const principals = connection.config.principals;
    if (principals !== undefined && !principals.includes(userId)) {
      return userId;
    }
    return boundedDisplayName(await displayNameFor(connection, userId));
  };

  /**
   * What was said before an agent was mentioned, for the dispatch that
   * creates its session (`earlier` on the gateway's dispatch). Without it
   * an agent named partway through a conversation holds one message —
   * "can you do this?" — and nothing it refers to. In a thread that is the
   * thread so far: its parent and the newest messages before the mention.
   * At the top of a channel it is the channel's most recent messages,
   * which is where a channel-per-client or channel-per-project keeps the
   * context a mention leans on.
   *
   * Each message keeps its own speaker and its own trust, so the session
   * starts at the least trusted of everyone in it: a principal's mention
   * cannot carry a stranger's earlier words in under the principal's
   * label. Under `admit: 'principals'` a sender the operator did not list
   * gets no place here, as they get none anywhere else. A bot's message —
   * another agent, an integration — is `unknown`: nothing here can say
   * what its words were built from. Messages that will not be shown are
   * dropped before the cap is applied, so they never crowd out ones that
   * would.
   *
   * A read that fails warns and returns nothing: the turn still runs, on
   * the one message, as it did before this.
   */
  const earlierContext = async (
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    before: string,
    senderTrust: TrustLevel,
  ): Promise<Array<{ message: string; metadata: JsonObject }>> => {
    const usable = (message: SlackThreadMessage): boolean => {
      if (message.ts === undefined || !(Number(message.ts) < Number(before))) {
        return false;
      }
      // The agent's own mention is stripped when the message is shown, so
      // a bare ping is as empty as no text, and takes no slot.
      const text = (message.text ?? '').replaceAll(`<@${connection.botUserId}>`, '').trim();
      if (text.length === 0 && (message.files ?? []).length === 0) {
        return false;
      }
      if (message.bot_id !== undefined || message.subtype === 'bot_message') {
        // Under `admit: 'principals'` an unlisted integration is as kept out
        // as an unlisted person. This fleet's own agents are not: they are
        // the conversation the mention joins — an authenticated peer whose
        // socket failed to start included, since what it said is still its.
        // Nor is a remote team agent this one answers (card 513): its
        // mention is admitted, so what it said before the mention is too.
        return admitsSender(connection.config, message.user ?? '')
          || (message.user !== undefined && [...botIdentities.values()].some(
            (peer) => peer.teamId === connection.teamId && peer.botUserId === message.user,
          ))
          || (message.user !== undefined && connection.teamId !== undefined
            && answersAgentMention(connection.config.agentId, connection.teamId, message.user));
      }
      return message.user !== undefined
        && isPersonSpeaking({ type: 'message', ts: message.ts, channel, ...(message.subtype ? { subtype: message.subtype } : {}) })
        && admitsSender(connection.config, message.user);
    };
    let kept: SlackThreadMessage[] = [];
    let omitted = 0;
    let more = false;
    // The channel read stopped at its page bound short of enough messages.
    let historyCut = false;
    let firstOfTail = 0;
    try {
      if (thread !== undefined) {
        const replies = connection.web.conversations.replies;
        if (!replies) {
          return [];
        }
        // Slack pages a thread oldest first, so the whole thread is walked
        // and only a bounded tail is held: the newest messages are the
        // last ones read.
        let parent: SlackThreadMessage | undefined;
        const tail: SlackThreadMessage[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page: { messages?: SlackThreadMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } } = await replies.call(connection.web.conversations, {
            channel,
            ts: thread,
            latest: before,
            inclusive: false,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          pages += 1;
          for (const message of page.messages ?? []) {
            if (!usable(message)) {
              continue;
            }
            if (message.ts === thread) {
              parent = message;
              continue;
            }
            tail.push(message);
            if (tail.length > EARLIER_MESSAGE_LIMIT) {
              tail.shift();
              omitted += 1;
            }
          }
          // Slack's cursor is the signal, not `has_more`: a short page can
          // still have more behind it.
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor && pages < EARLIER_THREAD_PAGES);
        more = cursor !== undefined;
        if (more) {
          // Past the read bound the newest replies were never reached, and a
          // slice from the middle must not pass for them: the parent alone,
          // and the note says the rest was not read.
          omitted += tail.length;
          tail.length = 0;
        }
        // The parent takes a slot only when it is shown.
        while (tail.length > (parent !== undefined ? EARLIER_MESSAGE_LIMIT - 1 : EARLIER_MESSAGE_LIMIT)) {
          tail.shift();
          omitted += 1;
        }
        kept = parent !== undefined ? [parent, ...tail] : tail;
        firstOfTail = parent !== undefined ? 1 : 0;
      } else {
        const history = connection.web.conversations.history;
        if (!history) {
          return [];
        }
        // Newest first, paged until enough usable messages are found (joins
        // and bots' chatter do not count against the limit), then put back
        // in the order they were said.
        const recent: SlackThreadMessage[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page: { messages?: SlackThreadMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } } = await history.call(connection.web.conversations, {
            channel,
            latest: before,
            inclusive: false,
            limit: EARLIER_CHANNEL_READ,
            ...(cursor ? { cursor } : {}),
          });
          pages += 1;
          recent.push(...(page.messages ?? []).filter(usable));
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor && recent.length < EARLIER_CHANNEL_LIMIT && pages < EARLIER_CHANNEL_PAGES);
        historyCut = cursor !== undefined && recent.length < EARLIER_CHANNEL_LIMIT;
        kept = recent.slice(0, EARLIER_CHANNEL_LIMIT).reverse();
      }
    } catch (error) {
      warn(
        `slack: ${connection.config.agentId} could not read the earlier messages in ${channel}, so it sees only the message that named it: `
        + `${error instanceof Error ? error.message : String(error)} (the history scopes are channels:history, groups:history, and mpim:history)`,
      );
      return [];
    }
    const entries: Array<{ message: string; metadata: JsonObject }> = [];
    for (const [index, message] of kept.entries()) {
      const bot = message.bot_id !== undefined || message.subtype === 'bot_message';
      const text = await humanizeMentions(connection, message.text ?? '');
      const files = message.files ?? [];
      const author = bot
        ? message.user === connection.botUserId
          ? 'you'
          : boundedDisplayName(message.bot_profile?.name ?? message.username ?? 'a bot')
        : await authorFor(connection, message.user as string);
      const reasons: UnreadReasons = new Map(files.map((file) => [file, 'not-opened' as const]));
      let note = '';
      if (thread === undefined && index === 0) {
        note = historyCut
          ? `[The ${kept.length} messages found in this channel's recent history before you were mentioned, oldest first. Older history was not read; ask for what you need.]\n`
          : `[The ${kept.length} most recent messages in this channel before you were mentioned, oldest first:]\n`;
      } else if (thread !== undefined && index === firstOfTail && omitted > 0 && !more) {
        note = `[${omitted} earlier messages in this thread are not shown.]\n`;
      }
      entries.push({
        message: `${note}${author}: ${text}${attachmentNote(files, reasons)}`,
        metadata: {
          channel: 'slack',
          slackChannel: channel,
          ...(thread !== undefined ? { slackThread: thread } : {}),
          ...(message.user !== undefined ? { slackUser: message.user } : {}),
          [SENDER_TRUST_METADATA_KEY]: bot ? 'unknown' : senderTrustFor(connection.config, message.user as string),
        },
      });
    }
    if (historyCut && entries.length === 0) {
      entries.push({
        message: '[None of this channel\'s recent history before you were mentioned could be shown, and older history was not read. Ask for what you need.]',
        // The adapter's own words, nobody else's: they carry the trust of
        // the message they arrive with, and lower nothing.
        metadata: { channel: 'slack', slackChannel: channel, [SENDER_TRUST_METADATA_KEY]: senderTrust },
      });
    }
    if (more) {
      // With no first message to show (unusable, or from someone the room
      // does not admit), the notice stands alone: an empty backfill would
      // read as a thread with nothing before the mention. It is the
      // adapter's own words, so it carries the trust of the message it
      // arrives with and lowers nothing.
      const notice = '[This thread is too long to read here: the replies after its first message are not shown. Ask for what you need.]';
      if (entries.length > 0) {
        entries[entries.length - 1]!.message += `\n${notice}`;
      } else {
        entries.push({
          message: notice,
          metadata: { channel: 'slack', slackChannel: channel, ...(thread !== undefined ? { slackThread: thread } : {}), [SENDER_TRUST_METADATA_KEY]: senderTrust },
        });
      }
    }
    return entries;
  };

  /**
   * What kind of room a conversation is and how many are in it, for the
   * turn's `conversation` metadata: an agent that did not know told
   * someone in a DM they were "talking on the terminal", and answers the same
   * way whether one person or a thousand will read it. Never the channel's
   * name, which whoever made the channel chose (`ConversationContext`).
   *
   * Looked up on every turn outside a DM, and never cached: who can read a
   * channel is the point, and a cached answer described a channel made
   * public, or shared with another workspace, as it was before. Lookups
   * for one conversation that overlap share one call. A lookup that fails
   * (an app missing the read scopes) leaves the kind the event gave, or
   * nothing: the prompt then says only that the conversation is in Slack,
   * as it always did.
   */
  const roomLookups = new Map<string, Promise<JsonObject | undefined>>();
  const KIND_BY_CHANNEL_TYPE: Record<string, string> = { im: 'direct', mpim: 'group', group: 'private', channel: 'public' };
  const roomFor = async (
    connection: AgentConnection,
    channel: string,
    channelType: string | undefined,
  ): Promise<JsonObject | undefined> => {
    const fromEvent = channelType !== undefined ? KIND_BY_CHANNEL_TYPE[channelType] : undefined;
    // A DM is two people, the app and the sender: nothing to look up.
    if (fromEvent === 'direct') {
      return { kind: 'direct' };
    }
    const key = `${connection.config.agentId}:${channel}`;
    let lookup = roomLookups.get(key);
    if (!lookup) {
      lookup = lookupRoom(connection, channel).finally(() => roomLookups.delete(key));
      roomLookups.set(key, lookup);
    }
    return (await lookup) ?? (fromEvent !== undefined ? { kind: fromEvent } : undefined);
  };

  const lookupRoom = async (connection: AgentConnection, channel: string): Promise<JsonObject | undefined> => {
    try {
      const info = (await connection.web.conversations.info({ channel, include_num_members: true })).channel;
      if (info === undefined) {
        return undefined;
      }
      const kind = info.is_im === true
        ? 'direct'
        : info.is_mpim === true
          ? 'group'
          : info.is_private === true ? 'private' : 'public';
      return {
        kind,
        ...(kind !== 'direct' && typeof info.num_members === 'number' ? { members: info.num_members } : {}),
        ...(kind !== 'direct' && (info.is_ext_shared === true || info.is_org_shared === true) ? { shared: true } : {}),
        ...(kind !== 'direct' && typeof info.id === 'string' ? { id: info.id } : {}),
      };
    } catch {
      return undefined;
    }
  };

  // Mentions arrive as <@U123> markup; the model should read names.
  /**
   * `<@U…>` mentions become `@name` — for principals only. A display name
   * is text its owner typed into their profile, and a mention of a member
   * nobody vouched for would otherwise carry that member's words into a
   * turn labelled by its sender alone: an operator's `user` message with a
   * stranger's chosen text inside it. A principal's profile is trusted the
   * way their messages are; everyone else stays a stable id, which names
   * them without quoting them.
   */
  const humanizeMentions = async (connection: AgentConnection, text: string): Promise<string> => {
    const withoutBot = text.replaceAll(`<@${connection.botUserId}>`, '').trim();
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const ids = [...withoutBot.matchAll(mentionPattern)].map((match) => match[1]).filter((id): id is string => Boolean(id));
    const principals = new Set(connection.config.principals ?? []);
    let result = withoutBot;
    for (const id of new Set(ids)) {
      if (principals.has(id)) {
        result = result.replaceAll(`<@${id}>`, `@${boundedDisplayName(await displayNameFor(connection, id))}`);
      }
    }
    return result.trim();
  };

  /**
   * Slack's stored `mrkdwn` as the plain text a read promises
   * (`ConversationMessage.text`): `<@U…>` mentions, `<#C…|name>` channels,
   * `<!here>`-style broadcasts, `<!date^…|fallback>` dates, and
   * `<url|label>` links, then the `&lt; &gt; &amp;` escapes, decoded last
   * so text someone typed is never read as markup. A mention is named only
   * for a principal or the agent's own app, for the reason
   * `humanizeMentions` gives; anyone else stays their stable id.
   */
  const nameableMentions = (connection: AgentConnection, text: string): string[] => {
    const principals = new Set(connection.config.principals ?? []);
    const ids = new Set<string>();
    for (const match of text.matchAll(/<@([^|<>]+)(?:\|[^<>]*)?>/g)) {
      const id = match[1]!;
      if (principals.has(id) || id === connection.botUserId) {
        ids.add(id);
      }
    }
    return [...ids];
  };

  /**
   * `resolved` is the only source of names: the caller has already looked
   * them up under its own bound (`readConversation`), and a mention it did
   * not resolve stays an id rather than costing a lookup here.
   */
  const plainSlackText = (
    connection: AgentConnection,
    text: string,
    resolved: ReadonlyMap<string, string>,
  ): string => {
    const names = new Map<string, string>();
    for (const id of nameableMentions(connection, text)) {
      const name = resolved.get(id);
      if (name !== undefined) {
        names.set(id, boundedDisplayName(name));
      }
    }
    return text
      .replace(/<([^<>]*)>/g, (_whole, inner: string) => {
        const bar = inner.indexOf('|');
        const target = bar === -1 ? inner : inner.slice(0, bar);
        const label = bar === -1 ? undefined : inner.slice(bar + 1);
        if (target.startsWith('@')) {
          const id = target.slice(1);
          return `@${names.get(id) ?? id}`;
        }
        if (target.startsWith('#')) {
          return `#${label || target.slice(1)}`;
        }
        if (target.startsWith('!')) {
          const command = target.slice(1);
          if (command.startsWith('subteam^')) {
            return label || `@${command.slice('subteam^'.length)}`;
          }
          if (command.startsWith('date^')) {
            return label ?? command;
          }
          return `@${command}`;
        }
        if (label && label !== target) {
          return `${label} (${target})`;
        }
        return target;
      })
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  };

  const connectionFor = (agentId: string): AgentConnection | undefined =>
    connections.find((candidate) => candidate.config.agentId === agentId);

  /** An agent's configuration, whether or not its socket came up. */
  const agentConfigFor = (agentId: string): SlackAgentConfig | undefined =>
    carried.find((candidate) => candidate.agentId === agentId);

  /**
   * Which agent each home channel belongs to, keyed `team:channel` because
   * a channel id is unique only within its workspace. Settled at start,
   * once every app has authenticated and its team is known. A channel two
   * agents in one workspace both call home belongs to neither: two agents
   * answering every message there is the double reply the thread rules
   * exist to prevent, and picking one would hang on an order the config
   * file does not reliably carry (JSON objects enumerate integer-like keys
   * numerically). Both still answer there when mentioned, and a startup
   * warning says so.
   */
  const homeOwners = new Map<string, string>();
  const settleHomeOwners = (): void => {
    homeOwners.clear();
    const claims = new Map<string, string[]>();
    for (const agent of carried) {
      const teamId = botIdentities.get(agent.agentId)?.teamId;
      if (teamId === undefined) {
        continue;
      }
      for (const channelId of agent.homeChannels ?? []) {
        const key = `${teamId}:${channelId}`;
        claims.set(key, [...(claims.get(key) ?? []), agent.agentId]);
      }
    }
    for (const [key, claimants] of claims) {
      const agentIds = [...new Set(claimants)];
      if (agentIds.length === 1) {
        homeOwners.set(key, agentIds[0]!);
        continue;
      }
      const channelId = key.slice(key.indexOf(':') + 1);
      warn(
        `slack: ${channelId} is a home channel for ${agentIds.join(' and ')}; a channel can be home to one agent, so none of them answers there unless mentioned.`,
      );
    }
  };

  /**
   * How an agent listens, from its soul — read per message, so a roster
   * reload takes effect on the next one. `thread` when the soul says
   * nothing, which is every soul written before there was a choice.
   */
  const listensOf = (agentId: string): ListensMode =>
    gatewayRef?.agents().find((agent) => agent.id === agentId)?.listens ?? 'thread';

  /**
   * Run `work` after everything already queued for this session's intake,
   * and hold the next link until it settles. The link is claimed
   * synchronously, so a message's place is fixed by when the adapter
   * learned of it and not by how long its lookups take — see
   * `handleInbound`, whose ordering this is.
   */
  const onIntakeChain = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = intakeChains.get(sessionId) ?? Promise.resolve();
    const link = previous.then(work);
    const settled = link.then(
      () => undefined,
      () => undefined,
    );
    intakeChains.set(sessionId, settled);
    void settled.then(() => {
      if (intakeChains.get(sessionId) === settled) {
        intakeChains.delete(sessionId);
      }
    });
    return link;
  };

  /**
   * What one agent REPLIED in a thread, heard by the thread's other agents.
   *
   * The other half of overhearing. What people say reaches an agent through
   * its socket (`admit`), but a colleague's reply is a bot message the
   * socket ignores on purpose, and its final text reaches Slack as a stream
   * of edits rather than one event — so it is not an inbound path at all.
   * The adapter that rendered the reply is the one thing that knows its
   * final text, and it observes that into the session every other agent
   * holds for the same thread, with no Slack event involved. Without this
   * an agent that followed a thread knew the questions its colleague was
   * asked and not the answers.
   *
   * Each hearer takes it on its own intake chain, claimed the moment the
   * reply is final: a message typed while the reply was still streaming
   * is already in that chain and is heard first, and one typed after the
   * final edit cannot overtake it. The observe itself is placed there and
   * not awaited inside the link — returned in a wrapper, since a promise
   * returned from the link is one the chain adopts — for the reason
   * `handleInbound` gives: a hearer with a long turn running must not hold
   * its next message's place hostage to that turn.
   *
   * Only once it is SAID, in full. The reservation is taken when the reply
   * is final, but the observe waits, inside the link, on `published` —
   * whether Slack took every edit and post of it — and a reply Slack
   * refused any part of is heard by nobody, since the thread did not see
   * it as written and the hearer has no way to know which part. That holds
   * the hearer's chain for the length of the final edit, which is the
   * same network round trip a person's message holds it for.
   *
   * Two boundaries decide who hears it, and neither is "same workspace".
   * Whether the hearer is in the THREAD is the gateway's answer on the
   * session's chain, as for every overhear: an agent never invited here
   * has no session under the key. Whether it is still in the CHANNEL is
   * Slack's, asked per reply: a message a person types reaches an agent
   * only through its own socket, so an app removed from a private channel
   * simply stops hearing — but a reply is forwarded by this process, and
   * would keep reaching an agent the operator took out of the room. That
   * is the one path where membership has to be checked rather than
   * assumed, and a lookup that fails leaves the agent not hearing, the
   * direction a boundary should fail in.
   *
   * Sent under the speaker's own label rather than `user`: an agent's
   * reply is at most its own word, and carries whatever its session has
   * been exposed to — a restatement of a stranger's text is still the
   * stranger's, which is exactly what `sessionWriteTrust` says.
   *
   * Only replies: a turn that said nothing posts `(no reply)`, which is
   * nothing to hear, and a failed turn's error note is the failure's, not
   * the agent's.
   */
  const overhearReply = async (
    speaker: AgentConnection,
    channel: string,
    thread: string,
    reply: string | (() => string),
    spoken: Pick<Session, 'metadata'> | (() => Promise<Pick<Session, 'metadata'>>),
    published: Promise<boolean>,
  ): Promise<void> => {
    const gateway = gatewayRef;
    if (!gateway?.observe || (typeof reply === 'string' && reply.trim().length === 0)) {
      return;
    }
    const team = speaker.teamId;
    const metadata = {
      channel: 'slack',
      team,
      slackChannel: channel,
      slackUser: speaker.botUserId,
      slackThread: thread,
    };
    // In the reply's own workspace only, because a session key carries a
    // team — the same reason `resolveFollowUpWinner` stays in-workspace.
    const hearers = connections.filter(
      (candidate) => candidate.teamId === team && candidate.config.agentId !== speaker.config.agentId,
    );
    await Promise.all(hearers.map(async (hearer) => {
      const sessionId = channelSessionKey({
        channel: 'slack',
        agentId: hearer.config.agentId,
        team,
        conversation: channel,
        thread,
      });
      try {
        const { observed } = await onIntakeChain(sessionId, async () => {
          if (!(await published)) {
            return { observed: undefined };
          }
          // Read now that the posts have landed: what the turn said along
          // the way is known only once they have.
          const text = typeof reply === 'string' ? reply : reply();
          if (text.trim().length === 0) {
            return { observed: undefined };
          }
          const trust = sessionWriteTrust(typeof spoken === 'function' ? await spoken() : spoken);
          let member: boolean | undefined;
          try {
            member = (await hearer.web.conversations.info({ channel })).channel?.is_member;
          } catch (error) {
            warn(`slack: could not tell whether ${hearer.config.agentId} is still in ${channel}, so it does not hear ${speaker.config.agentId}'s reply there: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (member !== true) {
            return { observed: undefined };
          }
          // Named the way a person's message names its speaker: whoever
          // spoke, by display name. A bot user's is the app's own, set by
          // whoever installed it.
          const author = await displayNameFor(hearer, speaker.botUserId);
          const observed = gateway.observe?.({ sessionId, agentId: hearer.config.agentId, message: `${author}: ${text}`, metadata: { ...metadata, [SENDER_TRUST_METADATA_KEY]: trust } });
          return { observed };
        });
        await observed;
      } catch (error) {
        warn(`slack: ${hearer.config.agentId} could not overhear ${speaker.config.agentId}'s reply in ${channel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  };

  /**
   * An agent's own post into a thread, heard in its own session for that
   * thread (card 364). A scheduled report or a `message.send` reply is a
   * bot message, which `admit` drops on purpose, and backfill reads a
   * thread only when a session for it is first made, so without this an
   * agent already in the thread never knew it had posted there: a reply
   * under its report reached a session with the question and not the
   * report. Through `observe`, so it starts no turn and lands only in a
   * session that already exists; a thread the agent was never in is read
   * by backfill when somebody first replies there.
   *
   * Labelled as the agent's own post, at the label the SENDING session's
   * words carry (`speaker.trust`, `sessionWriteTrust` of that session):
   * a report written by a firing that read a web page carries what that
   * page said, so it is heard at `external`, and one written from `user`
   * and `agent` context is heard at `agent`. Never higher, so hearing its
   * own report cannot launder anything into the thread. A post nobody
   * vouches for (no speaker) is not heard at all, rather than guessed at.
   *
   * Not when the sender IS that thread's session: that turn already holds
   * the call and what it said. Claimed on the intake chain BEFORE the
   * first chunk goes to Slack, so a reply typed under the report, even
   * while a long one is still being sent, is heard after it. `posted`
   * settles with what Slack accepted: all of it, the chunks before one it
   * refused (they are in the thread, so they are heard), or nothing. Not
   * awaited by `post`, only by the shutdown drain, so a long turn running
   * in the thread never holds up the sender, and two threads posting into
   * each other cannot wait on each other.
   */
  const hearOwnPost = (
    connection: AgentConnection,
    channel: string,
    thread: string,
    posted: Promise<string | undefined>,
    speaker: { sessionId: string; trust: TrustLevel },
  ): void => {
    const gateway = gatewayRef;
    if (!gateway?.observe) {
      return;
    }
    const agentId = connection.config.agentId;
    const team = connection.teamId;
    const sessionId = channelSessionKey({ channel: 'slack', agentId, team, conversation: channel, thread });
    if (sessionId === speaker.sessionId) {
      return;
    }
    const metadata = {
      channel: 'slack',
      team,
      slackChannel: channel,
      slackUser: connection.botUserId,
      slackThread: thread,
      [SENDER_TRUST_METADATA_KEY]: leastTrusted('agent', speaker.trust),
    };
    const heard = onIntakeChain(sessionId, async () => {
      const text = await posted;
      if (text === undefined) {
        return { observed: undefined };
      }
      const author = await displayNameFor(connection, connection.botUserId);
      const observed = gateway.observe?.({ sessionId, agentId, message: `${author} (your own post, sent from another session): ${text}`, metadata });
      return { observed };
    });
    // Tracked, so stop() drains it: a restart right after a report must not
    // close the stores while the thread's session is still to hear it.
    track(
      heard
        .then(async ({ observed }) => {
          await observed;
        })
        .catch((error: unknown) => {
          warn(`slack: ${agentId} could not hear its own post in ${channel} thread ${thread}: ${error instanceof Error ? error.message : String(error)}`);
        }),
    );
  };

  /**
   * The addressable outbound seam — the channel contract's first real
   * `OutboundConnection` implementation. Validate-then-hand-over: every
   * refusal here happens at schedule creation or at the moment of a send,
   * with a message written for the person who named the destination,
   * because the alternative is a connection whose first post fails at 6am.
   *
   * Membership is the boundary on purpose (see the spec's cold-DM
   * decision): the app posts only into conversations it has been invited
   * to, and a DM conversation id (`D…`) is its own proof — the DM exists
   * only because someone opened it with the app.
   */
  const resolveOutbound = async (address: OutboundAddress): Promise<OutboundConnection> => {
    const to = address.to.trim();
    if (!to) {
      throw new Error('slack: a destination needs a conversation id (C…/G…/D…).');
    }
    const connection = connectionFor(address.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(address.agentId)
        ? `slack: ${address.agentId}'s Slack app is not connected right now, so ${to} cannot be reached.`
        : `slack: agent ${address.agentId} has no Slack app, so it cannot post to Slack at all.`);
    }
    let conversation: { id?: string; is_member?: boolean; is_im?: boolean } | undefined;
    try {
      conversation = (await connection.web.conversations.info({ channel: to })).channel;
    } catch (error) {
      // channel_not_found covers both "no such id" and "not visible to
      // this app" — Slack deliberately does not distinguish, and neither
      // should the message pretend to.
      throw new Error(
        `slack: ${address.agentId}'s app cannot see ${to} (${error instanceof Error ? error.message : String(error)}). `
        + 'Use the conversation id, not a name, and check the app is in that workspace with the conversations read scopes.',
      );
    }
    if (!conversation?.id) {
      throw new Error(`slack: ${address.agentId}'s app cannot see a conversation ${to}.`);
    }
    if (!conversation.is_im && conversation.is_member !== true) {
      throw new Error(
        `slack: ${address.agentId}'s app is not a member of ${to} — invite it there before it can post.`,
      );
    }
    const channelId = conversation.id;
    const web = connection.web;
    // A reply under a message rather than a post beside it. Every chunk of
    // a long one goes to the same thread, so a split reply stays together.
    const thread = address.thread?.trim() || undefined;
    const speaker = address.speaker;
    return {
      async post(text: string): Promise<OutboundMessageRef> {
        const chunks = messageChunks(text.trim().length > 0 ? text : '(empty message)');
        // Heard in the thread's session (card 364): its place is claimed
        // now, before Slack shows anything, and filled once we know what
        // Slack accepted.
        let accepted: (heard: string | undefined) => void = () => {};
        if (thread && speaker && text.trim().length > 0) {
          hearOwnPost(connection, channelId, thread, new Promise((resolve) => { accepted = resolve; }), speaker);
        }
        let first: OutboundMessageRef | undefined;
        let sent = 0;
        try {
          for (const chunk of chunks) {
            const posted = await web.chat.postMessage({ channel: channelId, text: chunk, ...(thread ? { thread_ts: thread } : {}) });
            sent += 1;
            if (!first) {
              first = { channel: posted.channel ?? channelId, ts: posted.ts ?? '' };
            }
          }
        } finally {
          accepted(sent === chunks.length ? text : sent > 0 ? chunks.slice(0, sent).join('\n') : undefined);
        }
        return first ?? { channel: channelId, ts: '' };
      },
      async edit(ref: OutboundMessageRef, text: string): Promise<void> {
        await web.chat.update({ channel: ref.channel, ts: ref.ts, text: messageText(text) });
      },
      async upload(filePath: string, title?: string): Promise<void> {
        // File DATA, read here, for the same reason the renderer does it:
        // a missing file is this upload's own failure.
        const data = await readFile(filePath);
        await web.files.uploadV2({
          channel_id: channelId,
          file: data,
          filename: path.basename(filePath),
          ...(title ? { title } : {}),
        });
      },
    };
  };

  /**
   * Channel or DM, as this agent's app sees a conversation, for the
   * operator's standing channel authorization (`approvals.channels`), which
   * covers channels only. Asked of Slack (`conversations.info`), never read
   * off the id: a `G…` id is a private channel or a group DM depending on
   * its age. A definite answer is kept, since a conversation never turns
   * from one into the other; a failed lookup is not, and reads as unknown,
   * so the call asks.
   */
  const conversationKinds = new Map<string, 'channel' | 'direct'>();
  const CONVERSATION_KIND_CACHE_LIMIT = 1000;
  const conversationKindFor = async (agentId: string, conversation: string): Promise<'channel' | 'direct' | undefined> => {
    const id = conversation.trim();
    const connection = connectionFor(agentId);
    if (!id || !connection) {
      return undefined;
    }
    const key = `${agentId}:${botIdentities.get(agentId)?.teamId ?? ''}:${id}`;
    const known = conversationKinds.get(key);
    if (known !== undefined) {
      return known;
    }
    let info: { id?: string; is_im?: boolean; is_mpim?: boolean; is_channel?: boolean; is_group?: boolean } | undefined;
    try {
      info = (await connection.web.conversations.info({ channel: id })).channel;
    } catch {
      return undefined;
    }
    if (!info?.id) {
      return undefined;
    }
    // A DM flag wins. Otherwise a channel only when Slack says so, by a
    // channel flag or by stating it is not a DM: a reply with none of
    // them is no proof of a channel.
    const kind = info.is_im === true || info.is_mpim === true
      ? 'direct'
      : info.is_channel === true || info.is_group === true || (info.is_im === false && info.is_mpim === false) ? 'channel' : undefined;
    if (kind !== undefined) {
      if (conversationKinds.size >= CONVERSATION_KIND_CACHE_LIMIT) {
        const oldest = conversationKinds.keys().next().value;
        if (oldest !== undefined) {
          conversationKinds.delete(oldest);
        }
      }
      conversationKinds.set(key, kind);
    }
    return kind;
  };

  /**
   * The bookmarks a first-page read returns beside the messages. Never
   * throws: a failure is a sentence for the agent, and the messages come
   * back either way.
   */
  const listBookmarks = async (
    web: SlackWebLike,
    channel: string,
  ): Promise<Pick<ConversationReadResult, 'bookmarks' | 'bookmarksUnavailable'>> => {
    if (!web.bookmarks) {
      return {};
    }
    let listed: Awaited<ReturnType<NonNullable<SlackWebLike['bookmarks']>['list']>>;
    try {
      listed = await web.bookmarks.list({ channel_id: channel });
    } catch (error) {
      const code = slackErrorCode(error);
      return {
        bookmarksUnavailable: code === 'missing_scope'
          ? 'This Slack app can\'t read bookmarks because it lacks the bookmarks:read scope. Add it to the app\'s manifest and reinstall the app.'
          : `The channel's bookmarks could not be listed (${code ?? (error instanceof Error ? error.message : String(error))}).`,
      };
    }
    const bookmarks: ConversationBookmark[] = [];
    for (const entry of Array.isArray(listed?.bookmarks) ? listed.bookmarks : []) {
      const link = typeof entry?.link === 'string' ? entry.link.trim() : '';
      if (!link) {
        continue;
      }
      const title = (typeof entry.title === 'string' && entry.title.trim()) || link;
      bookmarks.push({
        title: title.length > BOOKMARK_TITLE_LIMIT ? `${title.slice(0, BOOKMARK_TITLE_LIMIT - 1)}…` : title,
        // A cut link is a broken one, so an over-long link is not shown.
        link: link.length > BOOKMARK_LINK_LIMIT ? BOOKMARK_LINK_TOO_LONG : link,
      });
    }
    return bookmarks.length > 0 ? { bookmarks } : {};
  };

  /**
   * The conversation a session lives in, read off its id, for this
   * agent's connected app only: exactly `slack:<agent>:<this app's
   * team>:<conversation>`, or that plus one thread `ts`, the keys this
   * adapter opens sessions under. Anything longer (a delegation's
   * `:delegate:…`, an archive's `:rolledover:…`) or of another shape (a
   * schedule's) is no session of a conversation here. No lookup: the id
   * is the identity check, and only the gateway names it.
   */
  const SLACK_TS = /^\d+\.\d+$/;
  const sessionConversation = (agentId: string, sessionId: string): string | undefined => {
    const connection = connectionFor(agentId);
    if (!connection?.teamId) {
      return undefined;
    }
    const prefix = channelSessionKey({ channel: 'slack', agentId, team: connection.teamId, conversation: '' });
    if (!sessionId.startsWith(prefix)) {
      return undefined;
    }
    const [conversation, thread, ...rest] = sessionId.slice(prefix.length).split(':');
    if (!conversation || rest.length > 0 || (thread !== undefined && !SLACK_TS.test(thread))) {
      return undefined;
    }
    return conversation;
  };

  /**
   * The read side of the same boundary `resolveOutbound` draws: a channel
   * the agent's own app is a member of, public or private. DMs and group
   * DMs are refused, member or not, except the one the reading session
   * lives in (`sessionConversation`). Their only members are the people
   * in them, and a read from a conversation elsewhere — a public thread
   * above all — would carry what they said to people who were never in
   * the room; from inside, it is what they already said to this agent. A
   * thread in a channel is fine for the same reason the channel is.
   */
  const readConversation = async (request: ConversationReadRequest): Promise<ConversationReadResult> => {
    const channel = request.conversation.trim();
    if (!channel) {
      throw new Error('slack: a read needs a channel id (C…/G…).');
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so ${channel} cannot be read.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot read Slack at all.`);
    }
    let info: { id?: string; is_member?: boolean; is_im?: boolean; is_mpim?: boolean } | undefined;
    try {
      info = (await connection.web.conversations.info({ channel })).channel;
    } catch (error) {
      throw new Error(
        `slack: ${request.agentId}'s app cannot see ${channel} (${error instanceof Error ? error.message : String(error)}). `
        + 'Use the channel id, not a name.',
      );
    }
    if (!info?.id) {
      throw new Error(`slack: ${request.agentId}'s app cannot see a conversation ${channel}.`);
    }
    const direct = info.is_im === true || info.is_mpim === true;
    if (direct && (request.sessionId === undefined || sessionConversation(request.agentId, request.sessionId) !== info.id)) {
      throw new Error(`slack: ${channel} is a direct message this conversation is not in, and a direct message is read only from inside it. Approval cannot unlock this; read a channel instead.`);
    }
    // A one-to-one IM states no membership; the session living in it is
    // the proof. A group DM does say, and an app that left one cannot read
    // it however its stale session is named.
    if (info.is_im !== true && info.is_member !== true) {
      throw new Error(`slack: ${request.agentId}'s app is not a member of ${channel} — invite it there before it can read.`);
    }
    const { history, replies } = connection.web.conversations;
    const fetchPage = request.thread !== undefined
      ? (replies ? (args: SlackHistoryArgs) => replies({ ...args, ts: request.thread as string }) : undefined)
      : history;
    if (!fetchPage) {
      throw new Error(`slack: this Slack client cannot read ${request.thread !== undefined ? 'threads' : 'channel history'}.`);
    }
    // On the first page of the top level only, so paging costs no extra
    // calls, and only once the checks above have said the read may happen.
    // Asked beside the history, and settled without throwing.
    const listing = request.thread === undefined && request.after === undefined && request.before === undefined
      ? listBookmarks(connection.web, info.id)
      : undefined;
    const base: SlackHistoryArgs = {
      channel: info.id,
      inclusive: false,
      ...(request.after !== undefined ? { oldest: request.after } : {}),
      ...(request.before !== undefined ? { latest: request.before } : {}),
    };
    const raw: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    let more = false;
    do {
      const page = await fetchPage({ ...base, limit: Math.min(200, request.limit - raw.length), ...(cursor ? { cursor } : {}) });
      raw.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
      more = cursor !== undefined || page.has_more === true;
    } while (cursor && raw.length < request.limit);
    if (raw.length > request.limit) {
      raw.length = request.limit;
      more = true;
    }
    // History rarely embeds profiles, so names mostly come from users.info.
    // Cached names are free; at most READ_NAME_LOOKUPS uncached people —
    // authors and the mentions in their text together — are looked up per
    // read, at once, and the rest keep their id, so a read of many strangers
    // never waits through a rate limit one call at a time.
    const lookups = new Map<string, Promise<string>>();
    let fresh = 0;
    const want = (user: string): void => {
      if (lookups.has(user)) {
        return;
      }
      const cached = displayNames.get(`${connection.teamId}:${user}`);
      if (cached) {
        lookups.set(user, Promise.resolve(cached));
      } else if (fresh < READ_NAME_LOOKUPS) {
        fresh += 1;
        lookups.set(user, displayNameFor(connection, user));
      }
    };
    for (const message of raw) {
      const user = message.user;
      if (user && !message.user_profile?.display_name && !message.user_profile?.real_name) {
        want(user);
      }
    }
    for (const message of raw) {
      for (const id of nameableMentions(connection, message.text ?? '')) {
        want(id);
      }
    }
    const names = new Map<string, string>();
    for (const [user, name] of lookups) {
      names.set(user, await name);
    }
    const messages: ConversationMessage[] = [];
    const sources: Array<{ message: ConversationMessage; files: SlackInboundFile[] }> = [];
    for (const message of raw) {
      if (!message.ts) {
        continue;
      }
      const author = message.user ?? message.bot_id ?? 'unknown';
      const name = message.user_profile?.display_name
        || message.user_profile?.real_name
        || message.bot_profile?.name
        || message.username
        || (message.user ? names.get(message.user) : undefined);
      const at = Number.parseFloat(message.ts);
      const files = (message.files ?? []).map((file) => file.name ?? file.title ?? file.id ?? 'file');
      const read: ConversationMessage = {
        id: message.ts,
        author,
        text: plainSlackText(connection, message.text ?? '', names),
        ...(name && name !== author ? { authorName: boundedDisplayName(name) } : {}),
        ...(Number.isFinite(at) ? { at: new Date(at * 1000).toISOString() } : {}),
        ...(message.thread_ts && message.thread_ts !== message.ts ? { thread: message.thread_ts } : {}),
        ...(message.reply_count ? { replies: message.reply_count } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
      messages.push(read);
      if (message.files !== undefined && message.files.length > 0) {
        sources.push({ message: read, files: message.files });
      }
    }
    const imageCap = historyImageCap(request.images);
    if (imageCap !== undefined) {
      await readHistoryImages(sources, imageCap, connection.config.botToken, fetchFile, fileDownloadTimeoutMs, warn);
    }
    return { messages, more, ...(listing ? await listing : {}) };
  };

  /**
   * Creates a channel with the asking agent's own app — `channel.create`.
   * Everything Slack would refuse once the channel exists is refused here
   * first, so a bad request leaves no channel behind. After the create
   * nothing throws: a topic, purpose or invitation that fails is reported,
   * and the channel stays. Slack names are unique, so an agent that
   * retries a create gets `name_taken`, never a second channel.
   */
  const createConversation = async (request: ConversationCreateRequest): Promise<ConversationCreateResult> => {
    const name = request.name.trim().replace(/^#/, '');
    if (!name) {
      throw new Error('slack: a channel needs a name.');
    }
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new Error(`slack: "${name}" can't be a channel name: Slack names use only lowercase letters, numbers, hyphens and underscores. Nothing was created.`);
    }
    if (name.length > CHANNEL_NAME_LIMIT) {
      throw new Error(`slack: a channel name is at most ${CHANNEL_NAME_LIMIT} characters; this one is ${name.length}. Nothing was created.`);
    }
    for (const field of ['topic', 'purpose'] as const) {
      const length = [...(request[field] ?? '')].length;
      if (length > CHANNEL_TEXT_LIMIT) {
        throw new Error(`slack: the ${field} is ${length} characters; Slack allows ${CHANNEL_TEXT_LIMIT}. Nothing was created.`);
      }
    }
    const invite = request.invite ?? [];
    if (invite.length > CHANNEL_INVITE_LIMIT) {
      throw new Error(`slack: that invites ${invite.length.toLocaleString('en-US')} people; Slack invites at most ${CHANNEL_INVITE_LIMIT.toLocaleString('en-US')} at once. Nothing was created.`);
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot create a channel.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot create a Slack channel.`);
    }
    const { create, setTopic, setPurpose, invite: inviteUsers } = connection.web.conversations;
    if (!create || !setTopic || !setPurpose || !inviteUsers) {
      throw new Error('slack: this Slack client cannot create channels.');
    }
    // Who each entry is, before anything exists. The creating app is a
    // member already, so naming it counts as invited.
    const { own, notInvited, toInvite } = resolveInvitees(connection, request.agentId, invite);
    const invited = [...own];

    const kind = request.private === true ? 'private' : 'public';
    let created: Awaited<ReturnType<typeof create>>;
    try {
      created = await create({ name, is_private: request.private === true });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'missing_scope') {
        throw new Error(`slack: ${request.agentId}'s Slack app can't create ${kind} channels because it lacks the ${request.private === true ? 'groups:write' : 'channels:manage'} scope. Add it to the app's manifest and reinstall the app.`);
      }
      if (code === 'name_taken') {
        throw new Error(`slack: there is already a channel named #${name} in this workspace, perhaps archived. Pick another name, or use that channel.`);
      }
      throw new Error(`slack: Slack could not create #${name} (${code ?? (error instanceof Error ? error.message : String(error))}).`);
    }
    const conversation = created.channel?.id;
    if (!conversation) {
      throw new Error(`slack: Slack answered the create of #${name} without a channel id, so whether it exists is unknown. Read the channel list before trying again.`);
    }

    const notSet: Array<{ field: 'topic' | 'purpose'; reason: string }> = [];
    if (request.topic) {
      await setTopic({ channel: conversation, topic: request.topic })
        .catch((error: unknown) => notSet.push({ field: 'topic', reason: `Slack did not set the topic (${describeSlackError(error)}).` }));
    }
    if (request.purpose) {
      await setPurpose({ channel: conversation, purpose: request.purpose })
        .catch((error: unknown) => notSet.push({ field: 'purpose', reason: `Slack did not set the purpose (${describeSlackError(error)}).` }));
    }

    // The channel exists now, so every code is settled per entry and none
    // turns into a rejection the agent would retry into a second channel.
    const settled = await inviteAtSlack(connection, inviteUsers, conversation, toInvite);
    invited.push(...settled.invited);
    notInvited.push(...settled.notInvited);
    sortByRequest(invite, invited, notInvited);
    return { conversation, name: created.channel?.name ?? name, invited, notInvited, notSet };
  };

  /**
   * Who each invite entry is, before Slack is asked: agents on this host
   * become the user their app posts as, in the same workspace only. `own`
   * holds the entries that are the asking app itself (the agent, or one
   * sharing its bot user), which no invitation can add.
   */
  const resolveInvitees = (connection: AgentConnection, agentId: string, invite: string[]): {
    own: string[];
    notInvited: Array<{ who: string; reason: string }>;
    toInvite: Map<string, string>;
  } => {
    const own: string[] = [];
    const notInvited: Array<{ who: string; reason: string }> = [];
    const toInvite = new Map<string, string>();
    for (const who of invite) {
      const identity = botIdentities.get(who);
      if (who === agentId || identity?.botUserId === connection.botUserId) {
        own.push(who);
      } else if (configuredAgents.has(who) && !identity?.botUserId) {
        notInvited.push({ who, reason: `Agent ${who}'s Slack app is not connected, so its Slack user is unknown.` });
      } else if (identity) {
        if (identity.teamId !== connection.teamId) {
          notInvited.push({ who, reason: `Agent ${who}'s Slack app is in another Slack workspace.` });
        } else {
          toInvite.set(who, identity.botUserId);
        }
      } else if (/^[UW][A-Z0-9]+$/.test(who)) {
        toInvite.set(who, who);
      } else {
        notInvited.push({ who, reason: 'Not a Slack user id (U… or W…) or an agent with a Slack app on this host.' });
      }
    }
    return { own, notInvited, toInvite };
  };

  /**
   * Sends one `conversations.invite`, force on so a bad id cannot stop the
   * good ones, and settles each entry of `toInvite` (entry -> Slack user).
   * Slack's per-id failures name who was refused, and `already_in_channel`
   * counts as invited. A failed call that does not name everyone leaves
   * the rest to the channel's members, and who cannot be checked is never
   * claimed. A call Slack refused with a code `refusesWhole` accepts stops
   * there, before any members check, with nobody settled and the code in
   * `refusedWith` for the caller to reject on. Without `refusesWhole`
   * every code is settled per entry.
   */
  const inviteAtSlack = async (
    connection: AgentConnection,
    inviteUsers: NonNullable<SlackWebLike['conversations']['invite']>,
    conversation: string,
    toInvite: Map<string, string>,
    refusesWhole: (code: string) => boolean = () => false,
  ): Promise<{ invited: string[]; notInvited: Array<{ who: string; reason: string }>; refusedWith?: string }> => {
    const invited: string[] = [];
    const notInvited: Array<{ who: string; reason: string }> = [];
    if (toInvite.size === 0) {
      return { invited, notInvited };
    }
    // Slack's per-id failures, by user id: on the answer, or on the error
    // the SDK throws for an ok: false answer.
    const refusedOf = (errors: unknown): Map<string, string> => new Map(
      (Array.isArray(errors) ? errors : []).flatMap((entry: { user?: unknown; error?: unknown }) =>
        typeof entry?.user === 'string' && typeof entry.error === 'string' ? [[entry.user, entry.error] as const] : []),
    );
    let refused: Map<string, string>;
    let failure: string | undefined;
    try {
      refused = refusedOf((await inviteUsers({ channel: conversation, users: [...new Set(toInvite.values())].join(','), force: true })).errors);
    } catch (error) {
      const code = slackErrorCode(error);
      if (code !== undefined && refusesWhole(code)) {
        return { invited, notInvited, refusedWith: code };
      }
      refused = refusedOf((error as { data?: { errors?: unknown } } | undefined)?.data?.errors);
      failure = describeSlackError(error);
    }
    // A failed call that does not name everyone leaves the rest unknown,
    // so the channel's members decide; who cannot be checked is not claimed.
    let members: Set<string> | undefined;
    let membersFailure: string | undefined;
    if (failure !== undefined && [...toInvite.values()].some((user) => !refused.has(user))) {
      try {
        members = new Set();
        let cursor: string | undefined;
        do {
          const page = await connection.web.conversations.members({ channel: conversation, limit: 1000, ...(cursor ? { cursor } : {}) });
          for (const member of page.members ?? []) {
            members.add(member);
          }
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (error) {
        members = undefined;
        membersFailure = describeSlackError(error);
      }
    }
    for (const [who, user] of toInvite) {
      const code = refused.get(user);
      if (code === 'already_in_channel' || (code === undefined && (failure === undefined || members?.has(user)))) {
        invited.push(who);
      } else if (code !== undefined || members !== undefined) {
        notInvited.push({ who, reason: `Slack did not invite them (${code ?? failure}).` });
      } else {
        notInvited.push({
          who,
          reason: `The invitation failed (${failure}) and the channel's members could not be checked (${membersFailure}), so they may or may not have been added.`,
        });
      }
    }
    return { invited, notInvited };
  };

  /** Puts both lists back in the order the caller named the entries. */
  const sortByRequest = (invite: string[], invited: string[], notInvited: Array<{ who: string; reason: string }>): void => {
    const order = new Map(invite.map((who, index) => [who, index]));
    const byRequest = (left: string, right: string): number => (order.get(left) ?? 0) - (order.get(right) ?? 0);
    invited.sort(byRequest);
    notInvited.sort((left, right) => byRequest(left.who, right.who));
  };

  /**
   * Joins an existing public channel with the asking agent's own app —
   * `channel.join`. Anything it did not join rejects with a sentence; an
   * answer that leaves it unknown says so, and that a retry is safe,
   * since Slack treats a second join as a no-op.
   */
  const joinConversation = async (request: ConversationJoinRequest): Promise<ConversationJoinResult> => {
    const conversation = request.conversation.trim();
    if (!conversation) {
      throw new Error('slack: joining needs a channel id (C…).');
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot join ${conversation}.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot join a Slack channel.`);
    }
    const { join } = connection.web.conversations;
    if (!join) {
      throw new Error('slack: this Slack client cannot join channels.');
    }
    const agent = request.agentId;
    let joined: Awaited<ReturnType<typeof join>>;
    try {
      joined = await join({ channel: conversation });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === undefined || code === 'internal_error' || code === 'fatal_error') {
        throw new Error(`slack: Slack's answer left it unknown whether ${agent}'s app joined ${conversation} (${describeSlackError(error)}). Trying again is safe: joining a channel twice changes nothing.`);
      }
      if (code === 'missing_scope') {
        throw new Error(`slack: ${agent}'s Slack app can't join channels on its own because it lacks the channels:join scope. Add it to the app's manifest and reinstall the app.`);
      }
      if (code === 'method_not_supported_for_channel_type') {
        throw new Error(`slack: ${conversation} isn't a public channel. Slack never lets an app join a private channel on its own: a member has to invite the app.`);
      }
      if (code === 'channel_not_found') {
        throw new Error(`slack: ${channelNotFoundSentence(agent, conversation)}`);
      }
      if (code === 'is_archived') {
        throw new Error(`slack: ${conversation} is archived, so it can't be joined.`);
      }
      if (code === 'too_many_members') {
        throw new Error(`slack: ${conversation} is at Slack's member limit, so ${agent}'s app can't join it.`);
      }
      if (code === 'ratelimited') {
        throw new Error(`slack: Slack is rate-limiting ${agent}'s app; try joining ${conversation} again later.`);
      }
      if (SLACK_AUTH_ERRORS.has(code)) {
        throw new Error(`slack: Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token.`);
      }
      throw new Error(`slack: Slack did not let ${agent}'s app join ${conversation} (${code}).`);
    }
    const warnings = [joined.warning, ...(joined.response_metadata?.warnings ?? [])];
    return { conversation: joined.channel?.id ?? conversation, alreadyMember: warnings.includes('already_in_channel') };
  };

  /**
   * Invites people and agents to an existing channel with the asking
   * agent's own app — `channel.invite`. It rejects only when nobody was
   * invited: a request refused before Slack is asked, or a whole call Slack
   * refused without acting. Everything else is settled per entry by the
   * same code `createConversation` uses.
   */
  const inviteToConversation = async (request: ConversationInviteRequest): Promise<ConversationInviteResult> => {
    const conversation = request.conversation.trim();
    if (!conversation) {
      throw new Error('slack: an invitation needs a channel id (C…).');
    }
    const invite = request.invite;
    if (invite.length === 0) {
      throw new Error('slack: an invitation needs at least one person or agent to invite.');
    }
    if (invite.length > CHANNEL_INVITE_LIMIT) {
      throw new Error(`slack: that invites ${invite.length.toLocaleString('en-US')} people; Slack invites at most ${CHANNEL_INVITE_LIMIT.toLocaleString('en-US')} at once. Nobody was invited.`);
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot invite anyone to ${conversation}.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot invite anyone to a Slack channel.`);
    }
    const inviteUsers = connection.web.conversations.invite;
    if (!inviteUsers) {
      throw new Error('slack: this Slack client cannot invite people to channels.');
    }
    const agent = request.agentId;
    const { own, notInvited, toInvite } = resolveInvitees(connection, agent, invite);
    for (const who of own) {
      notInvited.push({ who, reason: 'That is your own app, which can\'t invite itself. To join a public channel, use channel.join.' });
    }
    const settled = await inviteAtSlack(connection, inviteUsers, conversation, toInvite, (code) => SLACK_INVITE_REFUSALS.has(code));
    if (settled.refusedWith !== undefined) {
      const code = settled.refusedWith;
      const why = code === 'not_in_channel'
        ? `${agent}'s app isn't in ${conversation}, so it can't invite anyone there. For a public channel, join it first with channel.join; for a private one, a member has to invite the app.`
        : code === 'channel_not_found'
          ? channelNotFoundSentence(agent, conversation)
          : code === 'missing_scope'
            ? `${agent}'s Slack app lacks the scope to invite people: channels:write.invites for a public channel or groups:write.invites for a private one (channels:manage or groups:write also work). Add it to the app's manifest and reinstall the app.`
            : code === 'is_archived'
              ? `${conversation} is archived, so nobody can be invited to it.`
              : code === 'method_not_supported_for_channel_type'
                ? `${conversation} is a direct message or another conversation Slack doesn't allow invitations to.`
                : code === 'ratelimited'
                  ? `Slack is rate-limiting ${agent}'s app; try the invitation again later.`
                  : SLACK_AUTH_ERRORS.has(code)
                    ? `Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token.`
                    : `Slack did not invite anyone to ${conversation} (${code}).`;
      throw new Error(`slack: ${why} Nobody was invited.`);
    }
    const invited = settled.invited;
    notInvited.push(...settled.notInvited);
    sortByRequest(invite, invited, notInvited);
    return { invited, notInvited };
  };

  /**
   * Other agents on this host whose Slack app is this agent's: the same
   * bot token configured (connected or not), or the same bot user in the
   * same workspace. Slack's `creator` names the app's bot user, so it
   * can't tell those agents' channels apart. This sees only this process;
   * one app per agent is the supported setup (see the README).
   */
  const agentsSharingAppWith = (connection: AgentConnection): string[] => {
    const agentId = connection.config.agentId;
    const sharing = new Set<string>();
    for (const other of carried) {
      if (other.agentId !== agentId && other.botToken === connection.config.botToken) {
        sharing.add(other.agentId);
      }
    }
    for (const [other, identity] of botIdentities) {
      if (other !== agentId && identity.botUserId !== '' && identity.botUserId === connection.botUserId && identity.teamId === connection.teamId) {
        sharing.add(other);
      }
    }
    return [...sharing];
  };

  /**
   * Archives a channel the asking agent's own app created — what
   * `channel.archive` runs on. Everything it refuses is refused before
   * Slack is asked to archive: an id Slack can't show this app, a direct
   * message, a channel another user or app created, an app other agents
   * here share, a channel shared outside the workspace. Slack keeps who
   * created a channel and whether it is archived, so nothing is stored
   * here and the rule holds across restarts and hosts. Refusals name the
   * channel by id only: its name is whatever its members typed.
   */
  const archiveConversation = async (request: ConversationArchiveRequest): Promise<ConversationArchiveResult> => {
    const conversation = request.conversation.trim();
    if (!conversation) {
      throw new Error('slack: archiving needs a channel id (C…).');
    }
    const connection = connectionFor(request.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `slack: ${request.agentId}'s Slack app is not connected right now, so it cannot archive ${conversation}.`
        : `slack: agent ${request.agentId} has no Slack app, so it cannot archive a Slack channel.`);
    }
    const { archive } = connection.web.conversations;
    if (!archive) {
      throw new Error('slack: this Slack client cannot archive channels.');
    }
    const agent = request.agentId;
    const nothing = 'Nothing was archived.';
    const sharing = agentsSharingAppWith(connection);
    if (sharing.length > 0) {
      throw new Error(`slack: ${agent}'s Slack app is also ${sharing.map((other) => `${other}'s`).join(' and ')} here, so Stratus can't tell which agent created ${conversation}. `
        + `Give each agent its own Slack app. A person can archive it in Slack. ${nothing}`);
    }
    let info: Awaited<ReturnType<typeof connection.web.conversations.info>>['channel'];
    try {
      info = (await connection.web.conversations.info({ channel: conversation })).channel;
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'channel_not_found') {
        throw new Error(`slack: ${channelNotFoundSentence(agent, conversation)} Either way, ${agent} can only archive channels its own app created. ${nothing}`);
      }
      if (code === 'ratelimited') {
        throw new Error(`slack: Slack is rate-limiting ${agent}'s app; try archiving ${conversation} again later. ${nothing}`);
      }
      if (code !== undefined && SLACK_AUTH_ERRORS.has(code)) {
        throw new Error(`slack: Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token. ${nothing}`);
      }
      throw new Error(`slack: Slack could not tell ${agent}'s app who created ${conversation} (${describeSlackError(error)}). ${nothing}`);
    }
    if (info?.is_im === true || info?.is_mpim === true) {
      throw new Error(`slack: ${conversation} is a direct message, and only channels can be archived. ${nothing}`);
    }
    const creator = info?.creator ?? '';
    if (creator === '' || connection.botUserId === '' || creator !== connection.botUserId) {
      throw new Error(`slack: ${agent}'s app didn't create ${conversation}: another user or app did, so ${agent} can't archive it. A person can archive it in Slack. ${nothing}`);
    }
    if (info?.is_shared === true || info?.is_ext_shared === true || info?.is_org_shared === true || info?.is_pending_ext_shared === true) {
      throw new Error(`slack: ${conversation} is shared with another workspace or organization, so archiving it would reach people outside this one. A person can archive it in Slack. ${nothing}`);
    }
    if (info?.is_archived === true) {
      return { conversation, alreadyArchived: true };
    }
    try {
      await archive({ channel: conversation });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'already_archived') {
        return { conversation, alreadyArchived: true };
      }
      warn(`slack: ${agent} could not archive ${conversation} (${describeSlackError(error)})`);
      if (code === undefined || code === 'internal_error' || code === 'fatal_error') {
        throw new Error(`slack: Slack's answer left it unknown whether ${agent}'s app archived ${conversation} (${describeSlackError(error)}). It may be archived. Trying again is safe: archiving a channel twice changes nothing.`);
      }
      const isPrivate = info?.is_private === true || info?.is_group === true;
      const why = code === 'missing_scope'
        ? `${agent}'s Slack app can't archive ${isPrivate ? 'private' : 'public'} channels because it lacks the ${isPrivate ? 'groups:write' : 'channels:manage'} scope. Add it to the app's manifest and reinstall the app.`
        : code === 'not_in_channel'
          ? `${agent}'s app is no longer a member of ${conversation}, so it can't archive it. A member has to add the app back first.`
          : code === 'restricted_action'
            ? `This workspace limits who can archive channels, so ${agent}'s app can't archive ${conversation}. A person has to do it in Slack.`
            : code === 'ratelimited'
              ? `Slack is rate-limiting ${agent}'s app; try archiving ${conversation} again later.`
              : code === 'channel_not_found'
                ? channelNotFoundSentence(agent, conversation)
                : SLACK_AUTH_ERRORS.has(code)
                  ? `Slack refused ${agent}'s app token (${code}). Reinstall the app or replace its bot token.`
                  : `Slack did not let ${agent}'s app archive ${conversation} (${code}).`;
      throw new Error(`slack: ${why} ${nothing}`);
    }
    log(`slack: ${agent} archived ${conversation}`);
    return { conversation, alreadyArchived: false };
  };

  /**
   * Renders one parked call as buttons and remembers where it went.
   *
   * A request this adapter cannot route is DENIED here rather than left to
   * expire: with no approver configured, or no conversation to ask in,
   * waiting out the timeout tells the agent nothing it will not be told
   * immediately, and holds the turn (and the thread it is answering) open
   * for the whole window to get there.
   */
  const renderApprovalRequest = async (
    event: Extract<StratusEvent, { type: 'tool.approval-requested' }>,
  ): Promise<void> => {
    const gateway = gatewayRef;
    if (!gateway) {
      return;
    }

    // A delegated call is asked where the work was asked for: the
    // delegating conversation, through the app and approvers of the agent
    // at the root of the chain. The agent doing the work may have no
    // connection here at all, and its sub-session has no conversation of
    // its own — asked the old way, nobody saw it and the turn sat out the
    // whole timeout. The gateway makes such a call one-shot, so routing it
    // through another agent's approvers never grants anything standing.
    const origin = event.delegatedFrom;
    const viaOrigin = origin ? connectionFor(origin.agentId) : undefined;
    const connection = viaOrigin ?? connectionFor(event.agentId);
    // A call whose conversation is another channel's (a Discord thread), or
    // whose schedule reports through another channel, is that channel's to
    // ask: it renders the request where the work was asked for. Asked or
    // denied here, it would be refused before the person who can answer it
    // ever saw it. An approval channel is the operator naming where to ask
    // whatever the conversation, so it still applies, which needs a live
    // connection; with none, this adapter has nothing to say about it.
    const home = (origin ? origin.metadata : event.metadata) ?? {};
    const homeChannel = typeof home.channel === 'string' ? home.channel.trim().toLowerCase() : undefined;
    const reportsElsewhere = event.scheduleDestination !== undefined
      && event.scheduleDestination.channel.trim().toLowerCase() !== 'slack';
    const anotherChannels = (homeChannel !== undefined && homeChannel !== 'slack') || (homeChannel === undefined && reportsElsewhere);
    if (anotherChannels && !connection?.config.approvalChannel) {
      return;
    }
    if (!connection) {
      // Two different situations, and only one of them is this adapter's
      // to answer.
      //
      // An agent it was configured for but could not connect (a failed
      // auth, a dead app token) is its own: it was supposed to carry that
      // agent's approvals and cannot, so it says so rather than letting
      // every gated call wait out the timeout.
      //
      // An agent it was never configured for is NOT. Approval requests are
      // a broadcast, and another channel may be the one that serves that
      // agent — denying here would let Slack refuse a question somebody
      // else was going to ask. `stratus serve` reports agents that no
      // channel can ask for, at startup, where the whole roster is visible.
      if (configuredAgents.has(event.agentId) || (origin && configuredAgents.has(origin.agentId))) {
        warn(`slack: ${origin?.agentId ?? event.agentId} has no live connection; denying ${event.call.toolName}`);
        gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
      }
      return;
    }

    const approvers = new Set((connection.config.approvers ?? []).filter((id) => id.length > 0));
    const metadata = (viaOrigin ? origin?.metadata : event.metadata) ?? {};
    const sameChannel = metadata.channel === 'slack' && typeof metadata.slackChannel === 'string'
      ? metadata.slackChannel
      : undefined;
    // A scheduled firing has no conversation of its own. With no approval
    // channel configured it used to be denied at its first gated call, seen
    // only in the daemon log (card 218). Its schedule's destination is a
    // conversation a person approved as where it speaks, and only approvers
    // can answer there, so that is where it is asked. A configured approval
    // channel still wins: the operator chose it for exactly this. Another
    // channel's destination is not a Slack conversation id.
    const scheduled = event.scheduleDestination?.channel.trim().toLowerCase() === 'slack'
      ? event.scheduleDestination
      : undefined;
    const viaSchedule = !sameChannel && !connection.config.approvalChannel ? scheduled : undefined;
    const channel = sameChannel ?? connection.config.approvalChannel ?? viaSchedule?.to;
    const thread = sameChannel
      ? (typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined)
      : viaSchedule?.thread;

    // Undeliverable, not decided: nobody was asked, so filing this next to
    // the denials somebody actually made would make the audit record lie
    // about which is which.
    const decline = (reason: string): void => {
      warn(`slack: ${reason}; denying ${event.call.toolName} for ${event.agentId}`);
      gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
    };

    if (approvers.size === 0) {
      decline(`no approvers configured for ${connection.config.agentId}`);
      return;
    }
    if (!channel) {
      decline(`no conversation to ask in for ${connection.config.agentId}`);
      return;
    }

    const nameOf = (agentId: string): string => gateway.agents().find((agent) => agent.id === agentId)?.name ?? agentId;
    // "Quinn (for Nova)": the approver is being asked about Quinn's call,
    // by Nova's app, in Nova's conversation, and should be told both.
    const agentName = viaOrigin && origin && origin.agentId !== event.agentId
      ? `${nameOf(event.agentId)} (for ${nameOf(origin.agentId)})`
      : nameOf(event.agentId);
    // The notification preview is all some approvers see before deciding
    // whether to open the thread, so it carries the arguments too — just
    // the short form.
    const invocationSummary = renderInvocation(event.call.input).summary;

    // The post is the only awaited step, and the only window in which the
    // request can settle behind this function's back — so it is the only
    // step `rendering` covers, and nothing decides anything until it is
    // over and the two possible outcomes can be told apart.
    rendering.add(event.requestId);
    let post: PendingApprovalPost | undefined;
    let failure: string | undefined;
    try {
      const posted = await connection.web.chat.postMessage({
        channel,
        // Fallback text for notifications and clients that do not render
        // blocks — an approval nobody can read is an approval nobody gives.
        text: escapeSlackText(
          `${agentName} wants to run ${event.call.toolName} (${event.risk})`
          + `${event.origin ? ` on ${event.origin}` : ''}`
          + `${invocationSummary ? `: ${invocationSummary}` : ''}.`,
        ),
        ...(thread ? { thread_ts: thread } : {}),
        blocks: approvalBlocks(
          agentName,
          event.call.toolName,
          event.risk,
          event.requestId,
          event.call.input,
          event.origin,
          event.oneShot === true,
          event.always,
        ),
      });
      post = posted.ts
        ? {
            connection,
            channel: posted.channel ?? channel,
            ts: posted.ts,
            ...(thread ? { thread } : {}),
            agentName,
            toolName: event.call.toolName,
            risk: event.risk,
            oneShot: event.oneShot === true,
            ...(event.always !== undefined ? { always: event.always } : {}),
            agentId: event.agentId,
            approvers,
          }
        : undefined;
      failure = post ? undefined : `Slack accepted the approval request for ${event.agentId} without a timestamp`;
    } catch (error) {
      failure = `could not post an approval request to ${channel} (${error instanceof Error ? error.message : String(error)})`;
    }
    rendering.delete(event.requestId);

    if (post) {
      approvalPosts.set(event.requestId, post);
    }

    const settledMeanwhile = resolvedWhileRendering.get(event.requestId);
    if (settledMeanwhile) {
      resolvedWhileRendering.delete(event.requestId);
      // Already decided — never decline it a second time; just take the
      // buttons off the message that just appeared.
      if (post) {
        await retractApprovalRequest(settledMeanwhile);
      }
      return;
    }

    if (failure) {
      decline(failure);
    }
  };

  /**
   * Retracts the buttons once a request is settled, however it settled.
   * Every ending goes through here — a click, the timeout, a cancelled turn
   * — so a message can never keep offering a decision that no longer has
   * anywhere to land.
   */
  /**
   * Rewrites a prompt left behind by a daemon that is gone, using the
   * click's own coordinates.
   *
   * The index of posted requests is in-memory and keyed by request id, so
   * a new process starts empty and has no way to find the messages its
   * predecessor posted. An interaction payload carries the channel and
   * timestamp of the message it came from, which is the one handle on such
   * a message that survives — so the click that discovers the prompt is
   * dead is also what retires it. Unclicked orphans stay as they are;
   * clearing those needs the posts to be durable, which is a larger change
   * than this and belongs to both billing paths equally.
   */
  const offersDecision = (blocks: SlackBlock[] | undefined): boolean =>
    (blocks ?? []).some((block) => block.type === 'actions');

  const retireOrphanedPrompt = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
  ): Promise<void> => {
    const channel = args.body?.channel?.id;
    const ts = args.body?.message?.ts;
    if (!channel || !ts) {
      return;
    }
    // The message decides, not a memory of it. Every ending rewrites this
    // message into a plain section, so buttons still on it mean nothing
    // has been written there yet — and no buttons means something has, and
    // overwriting it would replace a real outcome and the person who made
    // it. Reading the click's own copy answers that with no bookkeeping to
    // disagree with, and no second API call to ask.
    if (!offersDecision(args.body?.message?.blocks)) {
      return;
    }
    const text = 'This request is no longer pending — the daemon that asked it is no longer running.';
    try {
      await connection.web.chat.update({
        channel,
        ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      warn(`slack: could not retire an orphaned request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const retractApprovalRequest = async (
    event: Extract<StratusEvent, { type: 'tool.approval-resolved' }>,
  ): Promise<void> => {
    const post = approvalPosts.get(event.requestId);
    if (!post) {
      // Still being posted: hold the outcome so the message it is about to
      // create does not keep offering a decision that is already made.
      if (rendering.has(event.requestId)) {
        resolvedWhileRendering.set(event.requestId, event);
      }
      return;
    }
    approvalPosts.delete(event.requestId);

    // The one lifetime this adapter *can* tell, because it rode in on the
    // request: a one-shot call remembers nothing whatever is answered. Both
    // shapes reach here — a `dangerous` tool, and a call judged by an
    // origin with no page to grant — and this channel offers no **Always
    // allow** for either, but `POST /approvals` still takes all three
    // answers, so another client can submit one. The general line below has
    // to hedge between two lifetimes it cannot distinguish; this one must
    // not, or the record of the decision claims a grant that does not exist.
    // Three shapes are one-shot and only one of them is knowable from here:
    // `risk` rode in on the request, so a `dangerous` tool can say why. The
    // other two — a browser action with no page to grant, and a command the
    // parser cannot reduce to a scope — are not distinguishable without
    // carrying a reason this adapter would only ever print, so they share a
    // line that is true of both. Naming one of them by guess is how this
    // read "there was no page to remember" for a shell pipeline.
    const outcome = post.oneShot && event.reason === 'decided' && event.answer === 'always'
      ? post.risk === 'dangerous'
        ? 'Allowed once — a dangerous tool is never remembered'
        : 'Allowed once — nothing about this call could be remembered'
      : event.reason === 'decided' && event.answer === 'always'
        ? alwaysOutcome(post.always, post.agentName, post.agentId)
        : OUTCOME_TEXT[`${event.reason}:${event.answer}`] ?? 'Resolved';
    // A mention only for an actor this post knows as a Slack user — its
    // approvers, which is the only set a click can come from. An approval
    // decided through the control API arrives as `api:…` or `dashboard`,
    // and `<@api:ops-bot>` is not a mention, it is a broken one; escaped
    // plain text says who it was.
    const by = event.actor
      ? ` by ${post.approvers.has(event.actor) ? `<@${event.actor}>` : escapeSlackText(event.actor)}`
      : '';
    const text = `*${escapeSlackText(post.agentName)}* — \`${escapeSlackText(post.toolName)}\` (${post.risk}): ${outcome}${by}.`;
    try {
      await post.connection.web.chat.update({
        channel: post.channel,
        ts: post.ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      warn(`slack: could not update a resolved approval request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Says so in the thread when a turn fails with nobody rendering it.
   *
   * The intake path reports a failure through the renderer it opened, so a
   * turn this process started is always answered. A turn it did NOT start
   * has no renderer: one the startup sweep failed because the last daemon
   * died mid-turn, or one whose recovery could not be finished. Those are
   * exactly the cases where the person is still looking at the thread,
   * and silence there reads as an agent that simply never replied.
   *
   * The routing has to come from the durable session, because the only
   * in-memory copy died with the process that had it.
   */
  /**
   * Post a turn's outcome into its thread ahead of a renderer queued behind
   * it, when there is one — through that renderer's placeholder, so the
   * thread reads in order — and as fresh messages otherwise. Each chunk on
   * its own, the way `finalize` posts overflow: one refused chunk must not
   * cost the rest of the answer.
   */
  const postAheadOf = async (
    behind: HandoverClaim | undefined,
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    chunks: readonly string[],
    between?: () => Promise<void>,
  ): Promise<boolean> => {
    const taken = behind ? await behind.take(chunks, between) : 'untaken';
    if (taken !== 'untaken') {
      return taken === 'complete';
    }
    // Whether ALL of it landed, as `finalize` answers: a reply the thread
    // saw part of is not one anybody else may be told the whole of.
    let published = true;
    for (const chunk of chunks) {
      try {
        await connection.web.chat.postMessage({
          channel,
          text: chunk,
          ...(thread ? { thread_ts: thread } : {}),
        });
      } catch (error) {
        published = false;
        warn(`slack: could not post part of a turn's outcome: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (between) {
      await between();
    }
    return published;
  };

  /**
   * The files an unrendered turn produced, taken off the session the moment
   * its outcome arrives — before anything is awaited, so a next turn's files
   * arriving while this outcome waits on Slack are never mistaken for its.
   */
  const takeUnrenderedFiles = (sessionId: string): string[] => {
    const paths = unrenderedFiles.get(sessionId) ?? [];
    unrenderedFiles.delete(sessionId);
    return paths;
  };

  /** Post the files an unrendered turn produced into its thread, in order. */
  const uploadUnrenderedFiles = async (
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    paths: readonly string[],
  ): Promise<string[]> => {
    // Which files landed: a redelivery waiting behind this report posts
    // the rest (`outcomeReportedAhead`), since a file that did not land is
    // one only it can still post — and only the rest, or it would post
    // twice the ones that did.
    const landed: string[] = [];
    for (const filePath of paths) {
      try {
        const data = await readFile(filePath);
        await connection.web.files.uploadV2({
          channel_id: channel,
          file: data,
          filename: path.basename(filePath),
          ...(thread ? { thread_ts: thread } : {}),
        });
        landed.push(filePath);
      } catch (error) {
        warn(`files.uploadV2 failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return landed;
  };

  const reportUnrenderedFailure = async (
    event: Extract<StratusEvent, { type: 'session.failed' }>,
    behind: HandoverClaim | undefined,
    files: readonly string[],
  ): Promise<ReportedOutcome> => {
    // A turn no renderer here was showing (card 501) that a Slack stop
    // aborted fails with the stop's own reason, so who stopped it is read
    // from the failure itself rather than from a note an outcome may never
    // come to clear.
    const stoppedBy = slackStopper(event.error);
    const gateway = gatewayRef;
    if (!gateway?.sessionRouting) {
      return NOTHING_REPORTED;
    }
    let routing;
    try {
      routing = await gateway.sessionRouting(event.sessionId);
    } catch (error) {
      // A store that cannot answer is not a reason to lose the daemon, and
      // the turn is already failed — there is nothing here to salvage
      // beyond saying why the thread stayed quiet.
      warn(`slack: could not read the routing for a failed turn: ${error instanceof Error ? error.message : String(error)}`);
      return NOTHING_REPORTED;
    }
    const metadata = routing?.metadata;
    // Another surface's session, or one with no conversation to speak
    // into. Not this adapter's to answer either way.
    if (!routing || metadata?.channel !== 'slack' || typeof metadata.slackChannel !== 'string') {
      return NOTHING_REPORTED;
    }
    const connection = connectionFor(routing.agentId);
    if (!connection) {
      return NOTHING_REPORTED;
    }
    const channel = metadata.slackChannel;
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    if (stoppedBy === undefined && routing.unaddressed === true && routing.reply === undefined) {
      // A stop is someone asking, so a stopped turn always says who
      // stopped it, judged or not.
      //
      // A turn nobody asked for that said nothing before it broke — the
      // daemon died inside it, and the next start failed it with no
      // renderer here to keep quiet for it. The same rule as the lazy
      // renderer's: the failure is in the log, and the files it produced
      // still land, since a file is not nothing to say.
      //
      // "Said nothing" as the session can tell it: no reply saved for the
      // turn. A line the old process had streamed into a placeholder and
      // never saved is invisible here — the session records what was
      // said, not what Slack took (the open delivery-record item at the
      // gateway's lastSpokeAt) — so such a
      // turn is failed without a note under that line. Taken over the
      // alternative on purpose: a note for every judged turn a restart
      // caught turns a silent turn, the common case, into the
      // interruption it existed to avoid; a line left standing happens
      // only to a turn that had already chosen to speak.
      warn(`slack: a turn nobody asked for failed before saying anything: ${event.error}`);
      return { said: true, landed: await uploadUnrenderedFiles(connection, channel, thread, files) };
    }
    let landed: string[] = [];
    const said = await postAheadOf(
      behind,
      connection,
      channel,
      thread,
      messageChunks(
        stoppedBy !== undefined
          ? `Stopped by <@${stoppedBy}>.`
          : event.refused ? event.error : `Something went wrong: ${event.error}`,
      ),
      async () => {
        landed = await uploadUnrenderedFiles(connection, channel, thread, files);
      },
    );
    return { said, landed };
  };

  /**
   * The other half of `reportUnrenderedFailure`: a turn nobody here was
   * rendering that *finished*. A turn parked on a human when the daemon
   * died is re-asked after the restart, approved, and completed by a
   * process that never opened a placeholder for it — so the approval
   * survived the restart and the reply went nowhere. Posted as a fresh
   * message in the thread, since the placeholder it would have edited
   * belonged to the old process.
   */
  const reportUnrenderedReply = async (
    event: Extract<StratusEvent, { type: 'session.completed' }>,
    behind: HandoverClaim | undefined,
    files: readonly string[],
  ): Promise<ReportedOutcome> => {
    const gateway = gatewayRef;
    if (!gateway?.sessionRouting) {
      return NOTHING_REPORTED;
    }
    let routing;
    try {
      routing = await gateway.sessionRouting(event.sessionId);
    } catch (error) {
      warn(`slack: could not read the routing for a finished turn: ${error instanceof Error ? error.message : String(error)}`);
      return NOTHING_REPORTED;
    }
    const metadata = routing?.metadata;
    if (!routing || metadata?.channel !== 'slack' || typeof metadata.slackChannel !== 'string') {
      return NOTHING_REPORTED;
    }
    const connection = connectionFor(routing.agentId);
    if (!connection) {
      return NOTHING_REPORTED;
    }
    const channel = metadata.slackChannel;
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    // A turn that produced files and no text still has the files to post —
    // and still has to take the placeholder when one is queued behind it.
    // An upload is a new message, so an attachment posted while the newer
    // turn's placeholder sits above it reads as the older turn answering
    // last. `NO_REPLY_TEXT` is what a rendered turn with nothing to say
    // puts in its own message too. With nothing queued behind, there is no
    // order to keep and nothing to say, so the files go on their own.
    const chunks = routing.reply ? messageChunks(routing.reply, connection.config.replies) : [];
    const posting = chunks.length > 0 ? chunks : (behind && files.length > 0 ? [NO_REPLY_TEXT] : []);
    let landed: string[] = [];
    const uploads = async (): Promise<void> => {
      landed = await uploadUnrenderedFiles(connection, channel, thread, files);
    };
    if (posting.length === 0) {
      await uploads();
      // Nothing was said. A turn nobody asked for chose that; an addressed
      // one is owed `(no reply)`, which a rendered turn would have posted,
      // so a redelivery waiting behind this report is left to post it.
      return { said: routing.unaddressed === true, landed };
    }
    // A reply the thread's other agents hear like any other, taking their
    // place for it before the post, as `handleInbound` does. A DM thread
    // has nobody else in it to hear, as on the live path.
    const published = postAheadOf(behind, connection, channel, thread, posting, uploads);
    const conversation = metadata[CONVERSATION_METADATA_KEY];
    const isDm = typeof conversation === 'object' && conversation !== null && !Array.isArray(conversation)
      && (conversation as JsonObject).kind === 'direct';
    const heard = routing.reply !== undefined && thread !== undefined && !isDm
      ? overhearReply(connection, channel, thread, routing.reply, routing, published)
      : undefined;
    const delivered = await published;
    await heard;
    log(`slack: posted the reply of a turn finished after a restart to ${channel}`);
    return { said: delivered, landed };
  };

  /**
   * Whether an approver can see a conversation: any public channel, or a
   * private one with an approver among its members. Rejects, with the
   * reason, when Slack will not say, so the caller refuses rather than
   * guesses.
   */
  const approverCanSee = async (connection: AgentConnection, channel: string, approvers: Set<string>): Promise<boolean> => {
    try {
      const info = (await connection.web.conversations.info({ channel })).channel;
      if (info?.is_private !== true && info?.is_mpim !== true) {
        return true;
      }
      let cursor: string | undefined;
      do {
        const page = await connection.web.conversations.members({ channel, limit: 200, ...(cursor ? { cursor } : {}) });
        if ((page.members ?? []).some((member) => approvers.has(member))) {
          return true;
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor !== undefined);
      return false;
    } catch (error) {
      throw new Error(
        `Slack would not say who can see this conversation (${error instanceof Error ? error.message : String(error)}), so the form was not posted. `
        + 'The app needs the conversations read scopes (channels:read, groups:read, mpim:read); see the app manifest.',
      );
    }
  };

  /**
   * The channel contract's `requestCredential`: posts the form and resolves
   * only once it is up with a button an approver can press. Every refusal
   * rejects with a sentence for the agent, which the gateway hands it in
   * place of "your operator was asked": a request nobody can answer would
   * otherwise sit pending while the agent says it is waiting on someone.
   */
  const requestCredential = async (request: ChannelCredentialRequest): Promise<void> => {
    const gateway = gatewayRef;
    const connection = connectionFor(request.agentId);
    if (!gateway || !connection) {
      throw new Error(configuredAgents.has(request.agentId)
        ? `${request.agentId}'s Slack app is not connected right now.`
        : `${request.agentId} has no Slack app.`);
    }
    // Only in the conversation the agent asked in, and only for a turn this
    // adapter dispatched from a Slack message: where to post comes from
    // that turn's renderer, never from the session's metadata, which an
    // HTTP caller can write (`channel: slack`, any `slackChannel`) to put a
    // request nobody made in that conversation in front of its approvers.
    // Unlike an approval there is no fallback channel: the person who can
    // answer is the one the agent is talking to.
    const active = gateway.activeTurnId?.(request.sessionId);
    const turn = active === undefined
      ? undefined
      : (renderers.get(request.sessionId) ?? []).find((renderer) => renderer.turnId === active);
    if (!turn) {
      throw new Error('This turn did not come from a Slack message, so there is nobody in Slack to show the form to.');
    }
    const channel = turn.channel;
    const thread = turn.threadTs;
    const unseen = `Nobody who can add it can see this conversation`;
    const approvers = new Set((connection.config.approvers ?? []).filter((id) => id.length > 0));
    const agentName = gateway.agents().find((agent) => agent.id === request.agentId)?.name ?? request.agentId;
    if (approvers.size === 0 || gateway.provideCredential === undefined) {
      throw new Error(
        `Nobody can add it from Slack, because no approver is configured for ${agentName} (approvals.slackApprovers).`,
      );
    }
    // A DM has one person in it besides the app. Posted there for someone
    // who is not an approver, the form is a button only they can see and
    // only approvers can press, which is a request nobody can answer.
    const elsewhere = 'Ask in a channel an approver is in, or ask one of them directly.';
    if (turn.dmWith !== undefined && !approvers.has(turn.dmWith)) {
      throw new Error(`${unseen}: it is a direct message with someone who is not an approver for ${agentName}. ${elsewhere}`);
    }
    // A private channel or group DM shows the button only to its members,
    // so one with no approver in it is the DM case again with more people.
    // A public channel is open to anyone in the workspace, approvers
    // included, and is not checked. Unknown is refused, not assumed fine:
    // a form posted where nobody can answer it waits forever.
    if (turn.dmWith === undefined && !(await approverCanSee(connection, channel, approvers))) {
      throw new Error(`${unseen}: none of ${agentName}'s approvers is a member of this private conversation. ${elsewhere}`);
    }
    let posted: { ts?: string; channel?: string };
    credentialsPosting.add(request.requestId);
    try {
      posted = await connection.web.chat.postMessage({
        channel,
        text: escapeSlackText(`${agentName} is asking ${request.replace === true ? 'to replace' : 'for'} a credential: ${request.name}, ${credentialWhose(agentName, request.scope)}.`),
        ...(thread ? { thread_ts: thread } : {}),
        blocks: credentialRequestBlocks(agentName, request.name, request.scope, request.reason, request.requestId, request.replace === true, request.env),
      });
    } catch (error) {
      credentialsPosting.delete(request.requestId);
      warn(`slack: could not post a credential request for ${request.agentId} to ${channel} (${error instanceof Error ? error.message : String(error)})`);
      throw new Error(`Slack refused the post (${error instanceof Error ? error.message : String(error)}).`);
    }
    credentialsPosting.delete(request.requestId);
    if (!posted.ts) {
      throw new Error('Slack accepted the post but returned no message to attach the form to.');
    }
    credentialPosts.set(request.requestId, {
      connection,
      channel: posted.channel ?? channel,
      ...(thread !== undefined ? { thread } : {}),
      ts: posted.ts,
      agentId: request.agentId,
      agentName,
      name: request.name,
      scope: request.scope,
      ...(request.replace === true ? { replace: true } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      approvers,
    });
  };

  const settleCredentialPost = async (event: Extract<StratusEvent, { type: 'credential.provided' }>): Promise<void> => {
    const post = credentialPosts.get(event.requestId);
    if (!post) {
      return;
    }
    credentialPosts.delete(event.requestId);
    const whose = event.scope === 'agent'
      ? `for ${escapeSlackText(post.agentName)} only`
      : `as a shared credential, granted to ${escapeSlackText(post.agentName)}`;
    const by = event.actor !== undefined && post.approvers.has(event.actor) ? `, by <@${event.actor}>` : '';
    const shell = post.env !== undefined && event.grantError === undefined
      ? ` Its shell commands read it as \`${escapeSlackText(post.env)}\`.`
      : '';
    const text = (event.replace === true
      ? `Replaced \`${escapeSlackText(post.name)}\` ${event.scope === 'agent' ? `for ${escapeSlackText(post.agentName)}` : 'as a shared credential'}${by}. `
        + `${escapeSlackText(post.agentName)} uses the new value from its next reply; it is in the credential store, not here.`
      : event.grantError === undefined
      ? `Added \`${escapeSlackText(post.name)}\` ${whose}${by}. ${escapeSlackText(post.agentName)} can use it from its next reply; the value is in the credential store, not here.`
      : `Stored \`${escapeSlackText(post.name)}\` ${event.scope === 'agent' ? `for ${escapeSlackText(post.agentName)}` : 'as a shared credential'}${by}, `
        + `but it could not be added to ${escapeSlackText(post.agentName)}'s soul (${escapeSlackText(event.grantError)}), so ${escapeSlackText(post.agentName)} cannot use it yet. `
        + 'Add the name to the credentials list in its soul on the machine.') + shell;
    try {
      await post.connection.web.chat.update({ channel: post.channel, ts: post.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    } catch (error) {
      warn(`slack: could not update the credential request for ${post.agentId} (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  /**
   * Takes down a request no answer can land on any more, so its button stops
   * inviting submissions that can only be refused the same way. A request
   * `credential.provided` already settled is left to what that wrote, which
   * says more (a key stored but not granted).
   */
  const retireCredentialPost = async (requestId: string, post: PendingCredentialPost, reason: string): Promise<void> => {
    if (credentialPosts.get(requestId) !== post) {
      return;
    }
    credentialPosts.delete(requestId);
    const text = `\`${escapeSlackText(post.name)}\` was not added: ${escapeSlackText(reason)}`;
    try {
      await post.connection.web.chat.update({ channel: post.channel, ts: post.ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    } catch (error) {
      warn(`slack: could not retire the credential request for ${post.agentId} (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  const handleCredentialClick = async (connection: AgentConnection, args: SlackSocketEventArgs, requestId: string): Promise<void> => {
    await args.ack();
    const post = credentialPosts.get(requestId);
    if (!post && credentialsPosting.has(requestId)) {
      // Live, with the index not caught up yet: retiring it here would
      // strip the button from a request about to be registered as pending.
      await tellClicker(connection, args, 'That credential request is still being posted. Try the button again in a moment.');
      return;
    }
    if (!post || post.connection !== connection) {
      await tellClicker(connection, args, 'That credential request is no longer pending. Ask the agent to request it again.');
      // A daemon restart forgets every request, and the buttons it posted
      // stay live for everyone else in the thread: take this one down the
      // way an orphaned approval is, from the click's own copy.
      if (!post) {
        await retireOrphanedPrompt(connection, args);
      }
      return;
    }
    // By actor, as approvals are: the request sits in a thread anyone in
    // it can read, and a key is a bigger thing to hand over than a click.
    const clicker = args.body?.user?.id;
    if (!clicker || !post.approvers.has(clicker)) {
      await tellClicker(connection, args, `You are not an approver for ${post.agentName}, so you cannot add its credentials.`);
      return;
    }
    const triggerId = args.body?.trigger_id;
    if (!connection.web.views || !triggerId) {
      await tellClicker(connection, args, 'Slack did not hand over a way to open the form. Try the button again.');
      return;
    }
    try {
      await connection.web.views.open({ trigger_id: triggerId, view: credentialModal(post, requestId) });
    } catch (error) {
      warn(`slack: could not open the credential form for ${post.agentId} (${error instanceof Error ? error.message : String(error)})`);
      await tellClicker(connection, args, 'The form could not be opened. Try the button again.');
    }
  };

  /**
   * The form's answer. Acked last rather than first, because the ack is how
   * a refusal reaches the form: `errors` keeps it open with the reason
   * beside the field, so a person told "already stored" or "no longer
   * pending" learns it where they typed. The value is read here, handed to
   * the gateway, and touched nowhere else: not logged, not posted.
   */
  const handleCredentialSubmission = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    const refuse = (message: string): Promise<void> =>
      args.ack({ response_action: 'errors', errors: { [CREDENTIAL_BLOCK]: message } });
    const view = args.body?.view;
    const requestId = view?.private_metadata ?? '';
    const post = credentialPosts.get(requestId);
    const gateway = gatewayRef;
    if (!post || post.connection !== connection || !gateway?.provideCredential) {
      await refuse('That credential request is no longer pending. Ask the agent to request it again.');
      return;
    }
    // Checked again on the answer, not only on the click: the form is a
    // separate interaction, and the click is not what stores anything.
    const submitter = args.body?.user?.id;
    if (!submitter || !post.approvers.has(submitter)) {
      await refuse(`You are not an approver for ${post.agentName}, so you cannot add its credentials.`);
      return;
    }
    const value = view?.state?.values?.[CREDENTIAL_BLOCK]?.[CREDENTIAL_INPUT]?.value ?? '';
    const answer = gateway.provideCredential({ requestId, value, actor: submitter }).catch(
      (error: unknown): { ok: false; message: string; retired?: boolean } => ({
        ok: false,
        message: `It could not be stored: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    // Slack wants the submission acked within three seconds, and storing
    // is two locked file writes and every bus subscriber: usually far
    // inside that, not always. An answer in time keeps the form open with
    // a refusal beside the field; a late one closes the form first and
    // tells the submitter privately, rather than letting Slack time out
    // and retry a submission the first attempt may already have stored.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), CREDENTIAL_ACK_MS);
    });
    const first = await Promise.race([answer, deadline]);
    clearTimeout(timer);
    if (first !== 'late') {
      // A plain ack closes the form. The message is rewritten from
      // `credential.provided`, the one path every way of answering goes
      // through.
      await (first.ok ? args.ack() : refuse(first.message));
      if (!first.ok && first.retired === true) {
        track(retireCredentialPost(requestId, post, first.message));
      }
      return;
    }
    await args.ack();
    track(answer.then(async (result) => {
      if (result.ok) {
        return;
      }
      if (result.retired === true) {
        await retireCredentialPost(requestId, post, result.message);
      }
      try {
        await connection.web.chat.postEphemeral({
          channel: post.channel,
          user: submitter,
          text: `${post.name} was not added: ${result.message}`,
          ...(post.thread !== undefined ? { thread_ts: post.thread } : {}),
        });
      } catch (error) {
        warn(`slack: could not tell ${submitter} a credential was not added (${error instanceof Error ? error.message : String(error)})`);
      }
    }));
  };

  const handleInteractive = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    if (args.body?.type === 'view_submission') {
      if (args.body.view?.callback_id === CREDENTIAL_VIEW) {
        await handleCredentialSubmission(connection, args);
      } else {
        await args.ack();
      }
      return;
    }
    const first = args.body?.actions?.[0];
    if (first?.action_id === CREDENTIAL_ADD_ACTION && first.value) {
      await handleCredentialClick(connection, args, first.value);
      return;
    }
    // Ack first and unconditionally: Slack retries an unacked interaction,
    // and a redelivered click on a request that is no longer pending would
    // read as a second, rejected decision.
    await args.ack();

    const gateway = gatewayRef;
    const action = args.body?.actions?.[0];
    const answer = action?.action_id ? APPROVAL_ACTIONS[action.action_id] : undefined;
    const requestId = action?.value;
    if (!gateway || !answer || !requestId) {
      return;
    }

    const post = approvalPosts.get(requestId);
    const clicker = args.body?.user?.id;
    // An unknown request predates this daemon or was already settled; the
    // click is answered where it was made, not silently dropped.
    if (!post) {
      await tellClicker(connection, args, 'That approval request is no longer pending.');
      // And the message itself is corrected, so the next person to read it
      // is not offered a decision nothing is waiting for — unless it is
      // one still being posted, which is live with the index simply not
      // caught up yet. Slack can show a message before postMessage
      // resolves here, so a fast click lands inside that window, and
      // stripping its buttons would strand the turn until the approval
      // times out: the record written when the post lands does not put
      // them back. Whether anything has already been written on the
      // message is `retireOrphanedPrompt`'s own question, answered from
      // the message rather than from a memory of it.
      if (!rendering.has(requestId)) {
        await retireOrphanedPrompt(connection, args);
      }
      return;
    }
    // A different agent's app relaying a click would bypass the approver
    // set bound to the request, since each app carries its own.
    if (post.connection !== connection) {
      return;
    }
    if (!clicker || !post.approvers.has(clicker)) {
      // The request stays pending: someone who may not decide clicking is
      // not a decision, and consuming the request would let any channel
      // member deny an agent's work.
      await tellClicker(
        connection,
        args,
        `You are not an approver for ${post.agentName}, so that decision was not recorded.`,
      );
      return;
    }

    // The retraction rides on tool.approval-resolved, which the gateway
    // emits from resolveApproval — so a decision and the message showing it
    // cannot disagree, and the timeout path retracts through the same code.
    if (!gateway.resolveApproval({ requestId, answer, actor: clicker })) {
      await tellClicker(connection, args, 'That approval request is no longer pending.');
    }
  };

  const tellClicker = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
    text: string,
  ): Promise<void> => {
    const user = args.body?.user?.id;
    const channel = args.body?.channel?.id;
    if (!user || !channel) {
      return;
    }
    const thread = args.body?.message?.thread_ts;
    try {
      await connection.web.chat.postEphemeral({
        channel,
        user,
        text,
        ...(thread ? { thread_ts: thread } : {}),
      });
    } catch (error) {
      warn(`slack: could not send an ephemeral notice: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** One thread, whichever agent is talking in it. */
  const threadKeyFor = (parts: { team: string; conversation: string; thread: string }): string =>
    `${parts.team}:${parts.conversation}:${parts.thread}`;

  /**
   * A thread's claims cut to `THREAD_HANDOVER_DEPTH`, oldest first out, but
   * never the two `ownerAt` reads past the rest, so at most one over: the
   * first claim, which is who the thread belongs to, and the latest claim
   * that took the thread.
   * Dropping that one would hand the thread back to its owner after enough
   * mentions of a third agent, while the judge that took it still answers.
   */
  const trimHandovers = (key: string, handovers: Handover[]): Handover[] => {
    if (handovers.length <= THREAD_HANDOVER_DEPTH) {
      return handovers;
    }
    const first = handovers[0] as Handover;
    let latestTake = -1;
    for (let index = handovers.length - 1; index > 0; index -= 1) {
      if (handovers[index]?.takes === true) {
        latestTake = index;
        break;
      }
    }
    const tailFrom = handovers.length - (THREAD_HANDOVER_DEPTH - 1);
    // The kept take sits on top of the full recent tail, one past the depth,
    // so `holderAt` still sees every recent claim it saw before.
    const tail = handovers.slice(tailFrom);
    // The cut only ever moves later: a claim inserted into the gap since
    // is dropped again, and the gap it fell in stays unknown.
    const until = (tail[0] as Handover).ts;
    const before = threadTrimmedUntil.get(key);
    if (before === undefined || before < until) {
      threadTrimmedUntil.set(key, until);
    }
    return latestTake > 0 && latestTake < tailFrom
      ? [first, handovers[latestTake] as Handover, ...tail]
      : [first, ...tail];
  };

  /**
   * Records that `agentId` holds the thread from the message at `ts`
   * onwards, wherever in the thread's history that message falls.
   *
   * Every claim is kept, not only changes of hands. A claim by the agent
   * already holding the thread looks redundant until another agent's reply
   * is placed between it and the one before — a judge's reply posted below
   * the holder's older message and above its newer one — at which point it
   * is what keeps the newer message the holder's; dropped, the judge's
   * later insertion would take the thread from a reply that sits below it.
   * Only the same claim twice — the same message reaching a second
   * connection — is dropped.
   * The oldest claims are dropped past `THREAD_HANDOVER_DEPTH` (but not
   * the first or the latest that took the thread: `trimHandovers`), and the
   * least recently written thread past `THREAD_ADDRESSEE_CAPACITY`; both
   * losses cost a lookup, never an answer, since the sessions still hold
   * the durable version.
   *
   * `ts` is a message's place in the thread: the message that handed the
   * thread over at intake, or — once a reply has landed — the reply's own
   * (`ReplyOutcome.spokeAt`), which is what puts a judge's reply posted
   * below a colleague's placeholder after it, and one streamed above it
   * before, whichever turn finished first.
   *
   * Slack timestamps compare as strings: `seconds.microseconds`, both
   * parts fixed width, so lexicographic order is chronological order.
   */
  const rememberAddressee = (key: string, agentId: string, ts: string, takes = false, cold = false): void => {
    const handovers = threadAddressee.get(key) ?? [];
    let at = handovers.length;
    while (at > 0 && (handovers[at - 1] as { ts: string }).ts > ts) {
      at -= 1;
    }
    const before = handovers[at - 1];
    if (before && before.agentId === agentId && before.ts === ts) {
      if (takes) {
        before.takes = true;
      }
      // Seen live as well: no longer only a reconstruction.
      if (!cold) {
        delete before.cold;
      }
      return;
    }
    handovers.splice(at, 0, { agentId, ts, ...(takes ? { takes } : {}), ...(cold ? { cold } : {}) });
    // Re-inserted rather than mutated in place: a Map iterates in insertion
    // order, which is what makes the first key the one to evict.
    threadAddressee.delete(key);
    threadAddressee.set(key, trimHandovers(key, handovers));
    if (threadAddressee.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadAddressee.keys().next();
      if (!oldest.done) {
        threadAddressee.delete(oldest.value);
        threadTrimmedUntil.delete(oldest.value);
        threadReadUntil.delete(oldest.value);
        // The owner goes with the record of who took the thread since: an
        // owner kept alone would stand in for a judge's takeover it no
        // longer knows of, where the thread read would see it.
        threadOrigins.delete(oldest.value);
      }
    }
  };

  /**
   * Who held the thread when the message at `ts` was sent — the last
   * handover at or before it. Undefined when this process has no handover
   * that old, which sends the question to the sessions.
   */
  /**
   * Whose a stop at `ts` is, from the live record: who was asked last as
   * of `ts` (`holderAt`). Undefined when the record cannot say, either
   * because this process has seen nobody asked here by `ts`, or because the
   * newest entry by then was rebuilt from a thread read (card 508): a
   * mention since would not be among them. The stop is then left to a
   * fresh read of the thread, never sent to the owner on a guess.
   */
  const stopHolderAt = (key: string, ts: string): string | undefined => holderAt(key, ts);

  /** Whether the record of thread `key` lost who held it at `ts` to a cut. */
  const inTrimmedGap = (key: string, handovers: Handover[], ts: string): boolean => {
    const until = threadTrimmedUntil.get(key);
    const first = handovers[0];
    return until !== undefined && first !== undefined && first.ts < ts && ts < until;
  };

  /**
   * Records that a thread read of `key` covered every message before `ts`.
   * Bounded on its own, since a read that found nobody's post leaves an
   * owner and no record (Codex 4321103567). A thread whose mark is evicted
   * loses its record and owner with it, so it is read afresh instead of
   * placed from claims the read may have stopped short of.
   */
  const noteReadUntil = (key: string, ts: string): void => {
    const until = threadReadUntil.get(key);
    threadReadUntil.delete(key);
    threadReadUntil.set(key, until !== undefined && compareSlackTs(ts, until) < 0 ? until : ts);
    if (threadReadUntil.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadReadUntil.keys().next();
      if (!oldest.done) {
        threadReadUntil.delete(oldest.value);
        threadAddressee.delete(oldest.value);
        threadTrimmedUntil.delete(oldest.value);
        threadOrigins.delete(oldest.value);
      }
    }
  };

  /**
   * Where the record of thread `key` stops knowing every take, for a
   * message at `ts` after what a thread read covered (card 562): a claim
   * older than the returned point may have been taken from since, unseen.
   * Undefined when the record is complete as far as `ts`.
   */
  const unreadBefore = (key: string, ts: string): string | undefined => {
    const until = threadReadUntil.get(key);
    return until !== undefined && liveFrom !== undefined && compareSlackTs(until, liveFrom) < 0 && compareSlackTs(ts, until) > 0
      ? liveFrom
      : undefined;
  };

  const holderAt = (key: string, ts: string): string | undefined => {
    const handovers = threadAddressee.get(key);
    if (!handovers || inTrimmedGap(key, handovers, ts)) {
      return undefined;
    }
    // The newest entry at or before `ts` answers, and only if this process
    // saw it live. A claim rebuilt from a thread read is a post; who was
    // asked since may be a mention it cannot see, so it leaves the question
    // to a fresh read. And it is newer than every live entry before it, so
    // skipping it for one of those would answer with a claim it superseded.
    const unread = unreadBefore(key, ts);
    for (let index = handovers.length - 1; index >= 0; index -= 1) {
      const handover = handovers[index];
      if (handover && handover.ts <= ts) {
        return handover.cold === true || (unread !== undefined && compareSlackTs(handover.ts, unread) < 0) ? undefined : handover.agentId;
      }
    }
    return undefined;
  };

  /**
   * Who an untagged reply at `ts` belongs to (card 508): the agent the
   * thread belongs to, not whoever spoke last. That is the first to hold
   * it — the agent its first message named, a home channel's owner, or the
   * bot (this daemon's or another's) that posted it — unless a judging
   * agent has since chosen to speak, which takes it (`takes`). A mention
   * of another agent gets that agent's answer to that message and nothing
   * more: the thread stays where it was, and so does every reply after.
   * In a thread that began before this process did, and that the thread
   * read has not placed yet, the first claim this process SAW stands in
   * for the owner: the best it has, and no worse than the last-speaker
   * rule it replaces. Undefined when this process has seen no claim at
   * all, which sends the question to the sessions and the thread.
   */
  const ownerAt = (key: string, ts: string): string | undefined => {
    const origin = threadOrigins.get(key);
    const handovers = threadAddressee.get(key) ?? [];
    if (inTrimmedGap(key, handovers, ts)) {
      return undefined;
    }
    // A take from before the stretch the read left out may have been
    // superseded there: the question goes to a fresh read (card 562).
    const unread = unreadBefore(key, ts);
    for (let index = handovers.length - 1; index >= 0; index -= 1) {
      const handover = handovers[index];
      if (handover && handover.ts <= ts && (handover.takes === true || (index === 0 && typeof origin !== 'string'))) {
        return unread !== undefined && compareSlackTs(handover.ts, unread) < 0 ? undefined : handover.agentId;
      }
    }
    return typeof origin === 'string' && unread === undefined ? origin : undefined;
  };

  /**
   * The agent the thread `key` belongs to, whoever holds it now: the owner
   * the thread read settled, or else the first claim this process saw.
   * Answering in its own thread takes the thread back from a judge that
   * spoke since (card 508), so the owner is asked for here, not the holder.
   */
  const threadOwner = (key: string): string | undefined => {
    const origin = threadOrigins.get(key);
    return typeof origin === 'string' ? origin : threadAddressee.get(key)?.[0]?.agentId;
  };

  /** Records that this process saw the thread `key` begin, or who owns it. */
  const noteOrigin = (key: string, owner: true | string = true): void => {
    if (owner === true && threadOrigins.has(key)) {
      return;
    }
    threadOrigins.delete(key);
    threadOrigins.set(key, owner);
    if (threadOrigins.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadOrigins.keys().next();
      if (!oldest.done) {
        threadOrigins.delete(oldest.value);
      }
    }
  };

  /**
   * A message that starts a thread, seen by any connection: from here on
   * this process sees the thread's first claim, so it knows the owner. One
   * this daemon's own agent posted (a schedule's delivery, a message.send)
   * is that agent's thread.
   */
  const noteThreadStart = (connection: AgentConnection, args: SlackSocketEventArgs): void => {
    const event = args.event;
    if (!event || (event.type !== 'message' && event.type !== 'app_mention') || event.channel_type === 'im') {
      return;
    }
    if (event.thread_ts !== undefined && event.thread_ts !== event.ts) {
      return;
    }
    if (event.subtype !== undefined && event.subtype !== 'bot_message' && !HUMAN_MESSAGE_SUBTYPES.has(event.subtype)) {
      return;
    }
    const team = args.body?.team_id ?? connection.teamId;
    const key = threadKeyFor({ team, conversation: event.channel, thread: event.ts });
    if (threadOrigins.has(key)) {
      return;
    }
    noteOrigin(key);
    if (event.user !== undefined) {
      for (const [agentId, identity] of botIdentities) {
        if (identity.teamId === team && identity.botUserId === event.user) {
          rememberAddressee(key, agentId, event.ts);
        }
      }
    }
    // A team agent on another gateway that starts a thread owns it, even
    // when its first message asks an agent here something: that agent
    // answers the question, and the thread stays the asker's. Recorded
    // here, ahead of the answer, since `noteForeignSpeaker` leaves out a
    // bot's question to an agent here.
    const bot = event.bot_id !== undefined || event.subtype === 'bot_message';
    if (bot && event.user !== undefined && !isFleetBot(team, event.user) && !startsThreadAsIntegration(team, event.user, event.thread_ts, event.ts)) {
      rememberAddressee(key, `${FOREIGN_SPEAKER_PREFIX}${event.user}`, event.ts);
    }
  };

  /**
   * Whether `user` is one of this adapter's own agents in `team`. Their
   * replies reach the holder record through `ReplyOutcome.spokeAt`, and
   * their sessions answer for them after a restart.
   */
  const isFleetBot = (team: string, user: string | undefined): boolean =>
    user !== undefined && [...botIdentities.values()].some(
      (identity) => identity.teamId === team && identity.botUserId === user,
    );

  /**
   * Whether a bot message is a team agent asking one of this daemon's
   * agents something (card 513): a question, not another voice taking the
   * thread. The agent asked answers it, and the thread stays with whoever
   * held it. Used live and when a thread is read back after a restart.
   */
  const asksAgentHere = (team: string, asker: string | undefined, text: string | undefined): boolean =>
    asker !== undefined && [...botIdentities].some(([agentId, identity]) =>
      identity.teamId === team && mentions(text ?? '', identity.botUserId) && answersAgentMention(agentId, team, asker));

  /**
   * Whether a bot message is another app starting a thread — an alert, a
   * deploy note — rather than an agent (card 508). That starts the thread
   * without owning it, so an agent named under it keeps the conversation it
   * was given. A team agent (`agentMentions.team`) starting one owns it the
   * way an agent here does, and any app replying inside a thread counts as
   * a speaker there, since an agent on a gateway nobody listed looks like
   * any other app.
   */
  const startsThreadAsIntegration = (team: string, user: string | undefined, threadTs: string | undefined, ts: string): boolean => {
    if (threadTs !== undefined && threadTs !== ts) {
      return false;
    }
    return user === undefined || ![...botIdentities].some(([agentId, identity]) => {
      const config = agentConfigFor(agentId);
      return config !== undefined && teamAgentFor(config, identity.teamId, team, user) !== undefined;
    });
  };

  /**
   * Records a bot this adapter does not serve as the thread's holder from
   * the message it posted. An agent on another gateway answers in the same
   * threads, and nothing in this process's sessions knows it spoke: without
   * this, an agent here that spoke earlier keeps taking every untagged reply,
   * and the reply meant for the other agent is answered twice. Only who
   * spoke and when is kept, never what was said; the bot's message itself is
   * still dropped by `admit`. Any app counts, an integration included: an
   * untagged reply right after another app posted is not plainly this
   * agent's, and naming the agent hands the thread back.
   */
  const noteForeignSpeaker = (connection: AgentConnection, args: SlackSocketEventArgs): void => {
    const event = args.event;
    if (!event || event.type !== 'message' || event.channel_type === 'im') {
      return;
    }
    if (event.bot_id === undefined && event.subtype !== 'bot_message') {
      return;
    }
    if (event.subtype !== undefined && event.subtype !== 'bot_message' && !HUMAN_MESSAGE_SUBTYPES.has(event.subtype)) {
      // An edit, a deletion, a join: not somebody speaking.
      return;
    }
    const team = args.body?.team_id ?? connection.teamId;
    const speaker = event.user ?? event.bot_id;
    if (speaker === undefined || isFleetBot(team, event.user)) {
      return;
    }
    if (asksAgentHere(team, event.user, event.text)) {
      return;
    }
    if (startsThreadAsIntegration(team, event.user, event.thread_ts, event.ts)) {
      return;
    }
    const thread = event.thread_ts ?? event.ts;
    rememberAddressee(threadKeyFor({ team, conversation: event.channel, thread }), `${FOREIGN_SPEAKER_PREFIX}${speaker}`, event.ts);
  };

  /**
   * The durable half of `noteForeignSpeaker`, for a thread this process has
   * no record of: where each of `candidates` last held the thread, and where
   * a bot this adapter does not serve last spoke, read from the thread
   * itself. Held means an agent's own message there or a person's message
   * naming it that it would admit, by position in the thread (its session's
   * `lastSpokeAt` only when its bot user id is unknown). Undefined whenever
   * it cannot tell: no thread read, a failed read, or a thread too long to
   * reach its newest replies. Then the reply is routed as it was before
   * this check.
   */
  const threadPositions = async (
    candidates: Array<{ agentId: string; lastSpokeAt?: string }>,
    parts: { team: string; conversation: string; thread: string },
    ts: string,
  ): Promise<ThreadPositions | undefined> => {
    const connection = connections.find((candidate) => candidate.config.agentId === candidates[0]?.agentId)
      ?? connections.find((candidate) => candidate.teamId === parts.team);
    const replies = connection?.web.conversations.replies;
    if (!connection || !replies) {
      return undefined;
    }
    // Positions in the thread, as the live record keeps them: a reply that
    // filled a placeholder sits where the placeholder was posted, above
    // anything posted while it was being written, though the transcript
    // dates it later. `lastSpokeAt` stands in only when an agent's own
    // messages can't be told apart in the read.
    const held = new Map<string, number>();
    const byBotUser = new Map<string, string>();
    for (const candidate of candidates) {
      const botUserId = botIdentities.get(candidate.agentId)?.botUserId;
      if (botUserId !== undefined) {
        byBotUser.set(botUserId, candidate.agentId);
        held.set(candidate.agentId, Number.POSITIVE_INFINITY);
        continue;
      }
      const spoke = candidate.lastSpokeAt === undefined ? Number.NaN : Date.parse(candidate.lastSpokeAt) / 1000;
      held.set(candidate.agentId, Number.isFinite(spoke) ? spoke : Number.POSITIVE_INFINITY);
    }
    // Where each last held it, for a stop, which is for whoever was asked
    // last (card 337), not for the thread's owner.
    const last = new Map<string, number>();
    for (const [agentId, at] of held) {
      last.set(agentId, Number.isFinite(at) ? at : 0);
    }
    const place = (agentId: string, at: number): void => {
      held.set(agentId, Math.min(held.get(agentId) ?? Number.POSITIVE_INFINITY, at));
      last.set(agentId, Math.max(last.get(agentId) ?? 0, at));
    };
    let foreign = Number.POSITIVE_INFINITY;
    let lastForeign = 0;
    // Each of these agents' own messages, and whether the message before it
    // had asked it anything: one nobody asked for is a judge taking the
    // thread, or its owner answering in it (card 508).
    const posts: Array<{ agentId: string; at: number; ts: string; asked: boolean }> = [];
    let asked = new Set<string>();
    const askedIn = (text: string | undefined): Set<string> => new Set(
      [...byBotUser].filter(([botUserId]) => mentions(text ?? '', botUserId)).map(([, agentId]) => agentId),
    );
    try {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: { messages?: SlackThreadMessage[]; response_metadata?: { next_cursor?: string } } = await replies.call(connection.web.conversations, {
          channel: parts.conversation,
          ts: parts.thread,
          latest: ts,
          inclusive: false,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        pages += 1;
        for (const message of page.messages ?? []) {
          const at = Number(message.ts);
          if (!Number.isFinite(at) || !(at < Number(ts))) {
            continue;
          }
          const own = message.user === undefined ? undefined : byBotUser.get(message.user);
          if (own !== undefined) {
            place(own, at);
            posts.push({ agentId: own, at, ts: message.ts as string, asked: asked.has(own) });
            // An agent here naming a colleague that answers its mentions
            // asks it, as `admitAgentMention` has it live, so the answer is
            // not a judge speaking unasked.
            const sender = message.user;
            const named = sender === undefined
              ? []
              : [...askedIn(message.text)].filter((agentId) => agentId !== own && answersAgentMention(agentId, parts.team, sender));
            if (named.length > 0) {
              asked = new Set(named);
            }
            continue;
          }
          const bot = message.bot_id !== undefined || message.subtype === 'bot_message';
          if (bot) {
            // A bot's mention hands nothing over live (admit ignores bots),
            // so here it is only another app speaking, or a peer's words.
            // A team agent's question to an agent here is not it taking the
            // thread, unless it started the thread with it: then the thread
            // is its own, as it is live.
            const asks = asksAgentHere(parts.team, message.user, message.text);
            if (asks) {
              asked = askedIn(message.text);
            }
            if (
              !isFleetBot(parts.team, message.user) &&
              (!asks || message.ts === parts.thread) &&
              !startsThreadAsIntegration(parts.team, message.user, parts.thread, message.ts ?? '')
            ) {
              foreign = Math.min(foreign, at);
              lastForeign = Math.max(lastForeign, at);
            }
            continue;
          }
          // A person naming an agent takes the thread for it only if that
          // agent would admit them, as the live handover does.
          const sender = message.user;
          if (sender === undefined) {
            continue;
          }
          asked = askedIn(message.text);
          const named = agentNamedIn(message.text ?? '', parts.team, (agentId) => admitsSender(agentConfigFor(agentId), sender));
          if (named !== undefined && held.has(named) && botIdentities.get(named)?.botUserId !== undefined) {
            place(named, at);
          }
          // A root that names nobody in a home channel is its owner's, as
          // the live home-channel rule has it.
          const home = message.ts === parts.thread && named === undefined
            ? homeOwners.get(`${parts.team}:${parts.conversation}`)
            : undefined;
          if (home !== undefined && held.has(home) && admitsSender(agentConfigFor(home), sender)) {
            place(home, at);
          }
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor && pages < EARLIER_THREAD_PAGES);
      if (cursor) {
        return undefined;
      }
    } catch (error) {
      warn(`slack: could not read thread ${parts.thread} in ${parts.conversation} to see who spoke last, so it is routed as before: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    return { held, last, foreign, lastForeign, posts };
  };

  /**
   * Which of this process's agents a message names, or undefined if it
   * names none of them.
   *
   * When it names several, the first that is actually serving — and any
   * of them otherwise. That determinism is the point: every connection sees every message and runs
   * this over the same text and the same array, so all of them agree on who
   * a message handed the thread to — including the connections that will go
   * on to ignore it. Which is what makes the handover record converge
   * without the sockets having to agree on anything, since each agent is
   * its own Socket Mode connection and one can run minutes behind another.
   *
   * Scoped to the message's own workspace, because a bot user id is only
   * unique within one — the same reason the display-name cache is keyed by
   * team. Two agents in two workspaces can hold the same id, and resolving
   * a mention to the wrong one would hand the thread to an agent that
   * cannot see it, leaving the agent that was actually named refusing every
   * reply after.
   *
   * Only agents this adapter has authenticated can be recognized at all.
   * One served by another daemon is invisible here, and both would answer;
   * so is one whose `auth.test` itself failed, since its bot id was never
   * learned.
   */
  const agentNamedIn = (
    text: string,
    team: string,
    /**
     * Whether a named agent would take this message at all. A message
     * naming two agents hands the thread to one that admits the sender,
     * not to the first one named: the agent that refuses will not answer,
     * and a handover to it is a thread nobody holds.
     */
    admits: (agentId: string) => boolean = () => true,
  ): string | undefined => {
    let offline: string | undefined;
    for (const [agentId, identity] of botIdentities) {
      if (identity.teamId !== team || !mentions(text, identity.botUserId) || !admits(agentId)) {
        continue;
      }
      if (connections.some((live) => live.config.agentId === agentId)) {
        return agentId;
      }
      // Named, recognized, and not serving. Remembered only as the answer
      // of last resort: a message that names an agent whose app is down and
      // nobody else still gets silence, which is the deliberate behavior —
      // but a message that also names one that IS serving must leave the
      // thread with the agent that can actually answer it, or the reply it
      // just posted would be the last anyone gets.
      offline ??= agentId;
    }
    return offline;
  };

  /**
   * Who an untagged reply belongs to, asked of the SESSIONS — the durable
   * answer, for a thread this process has no record of: one it has not seen
   * a message in since it started, or one evicted from `threadAddressee`.
   * Everything else is settled synchronously in `admit`, before this is
   * ever reached.
   *
   * Being in the thread is the first half: a session under a thread's key
   * exists only because someone mentioned that agent here, so an agent
   * follows up only in conversations it was invited into, and stops when
   * the thread is gone. `sessionRouting` is the durable record of that — a
   * restart forgets nothing.
   *
   * Whose turn it is, is the second. In a thread with several agents an
   * unaddressed reply belongs to the agent the thread belongs to (card
   * 508): the first to hold it, read off the thread itself. Only when the
   * thread can't be read do the sessions decide, and then by `lastSpokeAt`
   * — when each agent last *replied*, not when its session last changed,
   * because a turn saves on tool results and approval checkpoints without
   * having said anything — since that is the only order they keep.
   *
   * Nobody is the answer only when the agents cannot be *ordered* — nothing
   * in the thread has spoken, or two tie — because guessing there would put
   * two answers under one message. The agent alone in its thread, which is
   * nearly every thread, is answered without the question arising.
   */
  const resolveFollowUpWinner = async (
    parts: { team: string; conversation: string; thread: string; parentUser?: string },
    ts: string,
    mode: 'reply' | 'stop' = 'reply',
  ): Promise<string | undefined> => {
    const gateway = gatewayRef;
    if (!gateway?.sessionRouting || !parts.thread) {
      return undefined;
    }
    // A message an agent already accepted is that agent's, whoever has spoken
    // since. Nothing in memory says so after a restart, and the order below
    // would hand a redelivery to the newer speaker — whose session holds no
    // key for it, so it would run the message as new. Asked of every
    // configured agent, whatever it listens to now and whether or not it is
    // connected, unlike the order below: what counts is that it took the
    // message as addressed to it (a judging agent's turn nobody asked for
    // does not), an operator may have changed how it listens since, and an
    // owner whose app failed to come back after the restart still started
    // that turn — the live agents stand down for it rather than run it again.
    // Its workspace is the one it last authenticated in, when known.
    if (gateway.holdsMessage) {
      for (const agentId of configuredAgents) {
        const teamId = botIdentities.get(agentId)?.teamId;
        if (teamId !== undefined && teamId !== parts.team) {
          continue;
        }
        const sessionId = channelSessionKey({
          channel: 'slack',
          agentId,
          team: parts.team,
          conversation: parts.conversation,
          thread: parts.thread,
        });
        if (await gateway.holdsMessage(sessionId, dispatchKeyFor(`${agentId}:${parts.conversation}:${ts}`))) {
          return agentId;
        }
      }
    }
    const engaged: Array<{ agentId: string; lastSpokeAt?: string }> = [];
    // Live connections in this message's OWN workspace. Live, because an
    // agent whose app failed to connect cannot answer anything, and leaving
    // a thread silent because its last speaker is offline is the bug this
    // whole change exists to remove. In-workspace, because a session key
    // carries a team: an agent whose app has moved workspaces still has its
    // old sessions there, and letting those contend for a thread it can no
    // longer receive a message in would leave nobody to answer.
    for (const candidate of connections) {
      if (candidate.teamId !== parts.team) {
        continue;
      }
      const routing = await gateway.sessionRouting(channelSessionKey({
        channel: 'slack',
        agentId: candidate.config.agentId,
        team: parts.team,
        conversation: parts.conversation,
        thread: parts.thread,
      }));
      if (!routing) {
        continue;
      }
      engaged.push({
        agentId: candidate.config.agentId,
        ...(routing.lastSpokeAt !== undefined ? { lastSpokeAt: routing.lastSpokeAt } : {}),
      });
    }
    const first = engaged[0];
    if (!first) {
      // No agent has a session in this thread, but one may have STARTED
      // it: a post made through message.send or a schedule's delivery
      // lands at the top level from some other session, so nothing ties
      // the thread under it to the agent that wrote it. A reply there is
      // a reply to that agent. Read off the event, so every connection
      // reaches the same answer, and after a restart too. Looked up among
      // authenticated identities, not live sockets: they are all learned
      // before any socket starts, so an agent whose socket is still coming
      // up is not judged absent and the memoized verdict cannot drop the
      // reply when its own socket delivers it.
      if (parts.parentUser === undefined) {
        return undefined;
      }
      for (const [agentId, identity] of botIdentities) {
        if (identity.teamId === parts.team && identity.botUserId === parts.parentUser) {
          noteOrigin(threadKeyFor(parts), agentId);
          return agentId;
        }
      }
      return undefined;
    }
    // The thread says who it belongs to: whichever of these agents held it
    // first — its first message named it, or it posted there first — or
    // another app that spoke before any of them did (card 508). When it
    // can't be read, the sessions decide: the only agent in it, or, as a
    // last resort, the one that spoke last, which is all they record.
    // The agent that posted the root takes part even with no session here:
    // a post made through message.send or a schedule leaves none, and a
    // colleague named under it since must not look like the owner.
    const candidates = [...engaged];
    if (parts.parentUser !== undefined) {
      for (const [agentId, identity] of botIdentities) {
        if (identity.teamId === parts.team && identity.botUserId === parts.parentUser && !candidates.some((entry) => entry.agentId === agentId)) {
          candidates.push({ agentId });
        }
      }
    }
    const read = await threadPositions(candidates, parts, ts);
    if (!read) {
      return engaged.length === 1 ? first.agentId : lastSpeaker(engaged);
    }
    if (mode === 'stop') {
      // A stop is for whoever was asked last (card 337), as `holderAt` has
      // it live: the turn it means is that agent's, not the owner's.
      let holder: { agentId: string; at: number } | undefined;
      let tiedLast = false;
      for (const entry of candidates) {
        const at = read.last.get(entry.agentId) ?? 0;
        if (at <= 0) {
          continue;
        }
        if (!holder || at > holder.at) {
          holder = { agentId: entry.agentId, at };
          tiedLast = false;
        } else if (at === holder.at) {
          tiedLast = true;
        }
      }
      if (!holder) {
        return read.lastForeign > 0 ? undefined : (engaged.length === 1 ? first.agentId : lastSpeaker(engaged));
      }
      return tiedLast || read.lastForeign > holder.at ? undefined : holder.agentId;
    }
    let owner: { agentId: string; at: number } | undefined;
    let tiedAt = false;
    for (const entry of candidates) {
      const at = read.held.get(entry.agentId) ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(at) || at <= 0) {
        continue;
      }
      if (!owner || at < owner.at) {
        owner = { agentId: entry.agentId, at };
        tiedAt = false;
      } else if (at === owner.at) {
        tiedAt = true;
      }
    }
    // A judging agent that spoke unasked took the thread, and the owner
    // answering in it took it back, as live (card 508): the latest of those
    // holds it. The live record of who took it is lost on a restart; the
    // thread keeps it. Only a judge takes by speaking unasked, as only its
    // turns are judged live; another agent's post there (a message.send)
    // takes nothing.
    const ownerId = owner && !tiedAt && !(read.foreign < owner.at) ? owner.agentId : undefined;
    let taken: { agentId: string; at: number; ts: string } | undefined;
    const takeovers: Array<{ agentId: string; at: number; ts: string }> = [];
    for (const post of read.posts) {
      const takes = post.agentId === ownerId || (!post.asked && listensOf(post.agentId) === 'judge');
      if (takes) {
        takeovers.push(post);
        if (!taken || post.at > taken.at) {
          taken = post;
        }
      }
    }
    // Once the owner is known, the live record learns what the thread read
    // found, as it would have live: who owns the thread, and every post
    // that moved it, where it sits. With only the verdict, a judge's reply
    // to this message became the first claim this process saw and read as
    // the owner, so the real owner answering a mention could not take the
    // thread back (Codex 4290051968). Every take rather than the latest, so
    // a message delivered late is placed where it was typed, and the judge's
    // take at its own post, so a reply typed before its answer lands still
    // goes to the judge, as this verdict says.
    const warm = (): void => {
      if (ownerId === undefined) {
        return;
      }
      const key = threadKeyFor(parts);
      noteOrigin(key, ownerId);
      for (const post of takeovers) {
        rememberAddressee(key, post.agentId, post.ts, true, true);
      }
      noteReadUntil(key, ts);
    };
    if (taken && taken.agentId !== ownerId && (ownerId !== undefined || taken.at > read.foreign)) {
      warm();
      return taken.agentId;
    }
    if (!owner) {
      return Number.isFinite(read.foreign) ? undefined : (engaged.length === 1 ? first.agentId : lastSpeaker(engaged));
    }
    if (ownerId === undefined) {
      return undefined;
    }
    warm();
    return ownerId;
  };

  /**
   * Of several agents in a thread, the one whose session says it spoke
   * last — the sessions' only ordering, used when the thread itself can't
   * be read. Undefined when nobody has spoken or the newest two tie, since
   * guessing there would put two answers under one message.
   */
  const lastSpeaker = (engaged: Array<{ agentId: string; lastSpokeAt?: string }>): string | undefined => {
    let latest: { agentId: string; lastSpokeAt: string } | undefined;
    let tied = false;
    for (const entry of engaged) {
      if (entry.lastSpokeAt === undefined) {
        continue;
      }
      if (!latest || entry.lastSpokeAt > latest.lastSpokeAt) {
        latest = { agentId: entry.agentId, lastSpokeAt: entry.lastSpokeAt };
        tied = false;
      } else if (entry.lastSpokeAt === latest.lastSpokeAt) {
        tied = true;
      }
    }
    return tied ? undefined : latest?.agentId;
  };

  /**
   * `resolveFollowUpWinner`, resolved ONCE PER MESSAGE and shared by every
   * agent asking about that message.
   *
   * The sharing is the point. Each agent's own copy of the question is
   * several independent session reads, and turns finishing in between can
   * make two agents' reads disagree: both concluding they are the most
   * recent speaker, so one message is answered twice, or both concluding
   * they are not, so it is answered by nobody. One resolution cannot
   * disagree with itself, which is a stronger guarantee than arbitrating
   * between two that already have.
   *
   * Keyed on the message, so a later reply in the same thread asks again.
   * Bounded, and deliberately not deleted when it settles: an entry has to
   * outlive its own resolution, because an agent it beats may only reach
   * this after the winner has finished, and recomputing for that agent is
   * precisely the disagreement the memo exists to prevent.
   */
  const followUpWinner = (
    parts: { team: string; conversation: string; thread: string },
    ts: string,
    mode: 'reply' | 'stop' = 'reply',
  ): Promise<string | undefined> => {
    // A stop asks a different question (whoever was asked last), so it
    // gets its own verdict, the same for every agent that asks it.
    const key = `${threadKeyFor(parts)}:${ts}${mode === 'stop' ? ':stop' : ''}`;
    const existing = coldVerdicts.get(key);
    if (existing) {
      return existing.verdict;
    }
    const entry = { verdict: resolveFollowUpWinner(parts, ts, mode), settled: false };
    coldVerdicts.set(key, entry);
    void entry.verdict.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    if (coldVerdicts.size > COLD_VERDICT_CAPACITY) {
      // The oldest SETTLED entry, never simply the oldest. Evicting one
      // still resolving is the one eviction that costs an answer rather
      // than a lookup: the agent it has not reached yet would start its own
      // resolution, which is the disagreement this memo exists to prevent.
      // With none settled there is nothing safe to drop, and the map runs
      // over its cap by however many resolutions are genuinely in flight.
      for (const [candidate, held] of coldVerdicts) {
        if (held.settled) {
          coldVerdicts.delete(candidate);
          break;
        }
      }
    }
    return entry.verdict;
  };

  /**
   * Everything about who a message is for that can be decided WITHOUT
   * AWAITING, run straight off the socket's own event emission — so for the
   * whole of it, this process is exactly as far through the conversation as
   * Slack is.
   *
   * That is the point of it being one synchronous block. The Socket Mode
   * client emits envelopes in order, but `ack()` resolves from a WebSocket
   * send callback, so two handlers that ack before deciding anything can
   * come back in either order: a follow-up could then overtake the mention
   * that opened its thread, find neither a record nor a session, and be
   * dropped for good. Nothing here awaits, so nothing can be overtaken —
   * the dedupe and the handover record included, which are the two pieces a
   * later message reads.
   *
   * `undefined` means the message is nothing to this agent — a DM to
   * someone else, the room rather than a thread, its own words.
   * `overhear: true` means it is somebody else's to answer and this
   * agent's to hear, if it is in the thread at all, which only the sessions
   * can say. `settled: false` means only the sessions can decide even that
   * much, which is the one case that has to wait — and it is the cold
   * case, where by definition no message of this thread has been seen in
   * this process.
   */
  /**
   * Stop (card 337): cancels every turn this agent is running or has queued
   * in this conversation, including messages still in intake, and says
   * nothing was stopped when there was nothing to stop. Synchronous, and
   * called off the intake chain before any dispatch, so a stop is never
   * queued behind the turn it stops nor merged into the next one. The
   * caller has checked that the sender is an approver: a stop throws away
   * work someone else asked for.
   *
   * `fromIntake` is a stop that could only be placed on the intake chain,
   * once the sessions named this agent (the cold case). Everything ahead of
   * it on the chain has already been dispatched, and everything still in
   * intake arrived after it, so it cancels the dispatched turns only.
   */
  const stopTurns = (connection: AgentConnection, sessionId: string, userId: string, channel: string, fromIntake = false): boolean => {
    const running = renderers.get(sessionId) ?? [];
    const inIntake = fromIntake ? 0 : intakeInFlight.get(sessionId) ?? 0;
    const reason = `${SLACK_STOP_REASON}${userId}`;
    for (const renderer of running) {
      if (renderer.stoppedBy === undefined) {
        renderer.stoppedBy = userId;
        renderer.controller.abort(new RunAbortedError(reason));
      }
    }
    // Also a turn no renderer of this process started (card 501): one the
    // gateway recovered after a restart, or another caller's on this
    // session. The gateway counts every turn still on the session, one
    // already stopping included, so a repeated stop while a stopped turn
    // winds down is still a stop, and once it has ended, however it ended,
    // a stop with nothing running is an ordinary message. The renderers'
    // started turns are among those counted.
    const onSession = gatewayRef?.abortTurns?.(sessionId, reason) ?? 0;
    if (running.length === 0 && inIntake === 0 && onSession === 0) {
      return false;
    }
    if (inIntake > 0) {
      stopsBySession.set(sessionId, { count: (stopsBySession.get(sessionId)?.count ?? 0) + 1, by: userId });
    }
    // A renderer's started turn is also one the gateway counts, so this is
    // the larger of the two, not their sum.
    log(`slack: ${userId} stopped ${Math.max(running.length, onSession) + inIntake} turn(s) of ${connection.config.agentId} in ${channel}`);
    return true;
  };

  /**
   * Agent mentions admitted per thread since a person last spoke there, by
   * message ts (card 513). A copy of one message reaching a second socket,
   * or redelivered, is the same hop. Bounded like the addressee map.
   */
  const agentHops = new Map<string, string[]>();

  /**
   * Which team agent a bot user in `team` is, for the agent configured by
   * `config` in workspace `agentTeam`, if any. A configured id counts only
   * in that agent's own workspace: user ids are unique per workspace, so the
   * same id elsewhere is some other bot.
   */
  const teamAgentFor = (config: SlackAgentConfig, agentTeam: string | undefined, team: string, botUser: string): string | undefined => {
    for (const [agentId, identity] of botIdentities) {
      if (identity.teamId === team && identity.botUserId === botUser) {
        return agentId;
      }
    }
    if (agentTeam === undefined || agentTeam !== team) {
      return undefined;
    }
    for (const [name, id] of Object.entries(config.agentMentions?.team ?? {})) {
      if (id === botUser) {
        return name;
      }
    }
    return undefined;
  };

  /**
   * Whether `agentId` answers a mention from `botUser` in `team`: it has
   * agent mentions on, the bot is a team agent to it, and on its list if it
   * keeps one. The hop limit is not asked here.
   */
  const answersAgentMention = (agentId: string, team: string, botUser: string): boolean => {
    const config = agentConfigFor(agentId);
    const settings = config?.agentMentions;
    if (!config || !settings) {
      return false;
    }
    const name = teamAgentFor(config, botIdentities.get(agentId)?.teamId, team, botUser);
    return name !== undefined && (settings.only === undefined || settings.only.includes(name));
  };

  /**
   * A message another agent's bot posted, for an agent that answers team
   * agents (`agentMentions`, card 513). Admitted only when it names this
   * agent, comes from a team agent this one listens to, and the thread is
   * under its hop limit; anything else from a bot is dropped, as every
   * bot message was before. Never part of the holder rule: a bot naming an
   * agent asks it one thing, and hands it nothing.
   */
  const admitAgentMention = (connection: AgentConnection, args: SlackSocketEventArgs): Admission | undefined => {
    const event = args.event;
    const settings = connection.config.agentMentions;
    if (!settings || !event || event.user === undefined || event.user === connection.botUserId) {
      return undefined;
    }
    if ((event.type !== 'app_mention' && event.type !== 'message') || event.channel_type === 'im') {
      return undefined;
    }
    if (event.subtype !== undefined && !AGENT_SPEECH_SUBTYPES.has(event.subtype)) {
      return undefined;
    }
    const text = event.text ?? '';
    if (!mentions(text, connection.botUserId)) {
      return undefined;
    }
    const team = args.body?.team_id ?? connection.teamId;
    const name = teamAgentFor(connection.config, connection.teamId, team, event.user);
    if (name === undefined) {
      return undefined;
    }
    const eventKey = `${connection.config.agentId}:${event.channel}:${event.ts}`;
    if (settings.only !== undefined && !settings.only.includes(name)) {
      if (!alreadySeen(eventKey)) {
        log(`slack: ${connection.config.agentId} ignored a mention from agent ${name}: not on its agent mention list`);
      }
      return undefined;
    }
    const thread = event.thread_ts ?? event.ts;
    const threadKey = threadKeyFor({ team, conversation: event.channel, thread });
    const hops = agentHops.get(threadKey) ?? [];
    if (!hops.includes(event.ts)) {
      if (hops.length >= AGENT_MENTION_HOP_LIMIT) {
        if (!alreadySeen(eventKey)) {
          log(`slack: ${connection.config.agentId} ignored a mention from agent ${name}: the thread reached its hop limit of ${AGENT_MENTION_HOP_LIMIT} agent mentions; a person has to speak there first`);
        }
        return undefined;
      }
      agentHops.delete(threadKey);
      agentHops.set(threadKey, [...hops, event.ts]);
      if (agentHops.size > THREAD_ADDRESSEE_CAPACITY) {
        const oldest = agentHops.keys().next();
        if (!oldest.done) {
          agentHops.delete(oldest.value);
        }
      }
    }
    if (alreadySeen(eventKey)) {
      return undefined;
    }
    return {
      event,
      isDm: false,
      team,
      eventKey,
      userId: event.user,
      sessionId: channelSessionKey({ channel: 'slack', agentId: connection.config.agentId, team, conversation: event.channel, thread }),
      thread,
      threadKey,
      settled: true,
      overhear: false,
      judge: false,
      fromAgent: name,
    };
  };

  const admit = (connection: AgentConnection, args: SlackSocketEventArgs): Admission | undefined => {
    const event = args.event;
    if (gatewayRef) {
      noteThreadStart(connection, args);
      noteForeignSpeaker(connection, args);
    }
    if (gatewayRef && event && (event.bot_id !== undefined || event.subtype === 'bot_message')) {
      return admitAgentMention(connection, args);
    }
    if (event && event.user !== undefined && event.channel_type !== 'im' && isPersonSpeaking(event) && admitsSender(connection.config, event.user)) {
      // A person this agent admits, speaking in a thread, ends a run of
      // agent mentions there. Someone it refuses can't restart one. Only
      // hops before the person's message reset: another agent's socket can
      // deliver an older human message late, after newer hops.
      const hopKey = threadKeyFor({ team: args.body?.team_id ?? connection.teamId, conversation: event.channel, thread: event.thread_ts ?? event.ts });
      const hops = agentHops.get(hopKey);
      if (hops) {
        const newer = hops.filter((hop) => compareSlackTs(hop, event.ts) > 0);
        if (newer.length > 0) {
          agentHops.set(hopKey, newer);
        } else {
          agentHops.delete(hopKey);
        }
      }
    }
    if (!gatewayRef || !event || !event.user || event.bot_id || !isPersonSpeaking(event)) {
      return undefined;
    }
    if (event.type !== 'app_mention' && event.type !== 'message') {
      return undefined;
    }
    if (event.user === connection.botUserId) {
      return undefined;
    }
    // Bound once the guard above has run: the closures below cannot see
    // that narrowing.
    const sender = event.user;

    const isDm = event.channel_type === 'im';
    const team = args.body?.team_id ?? connection.teamId;
    // A top-level mention has no thread_ts; its own ts roots the reply
    // thread that becomes the conversation. A DM's top level is one
    // conversation per peer, unkeyed by thread; a thread inside the DM is a
    // conversation of its own, answered in that thread.
    const thread = isDm ? event.thread_ts : event.thread_ts ?? event.ts;
    // Threads only: a DM has one agent by construction.
    const threadKey = thread !== undefined && !isDm
      ? threadKeyFor({ team, conversation: event.channel, thread })
      : undefined;

    const text = event.text ?? '';
    const mentioned = isDm || mentions(text, connection.botUserId);

    // Who this message hands the thread to — worked out by EVERY connection
    // that sees it, not only by the one being named, and recorded before any
    // of the rejections below. Each agent is its own Socket Mode connection,
    // so the message naming Bea reaches Ava's socket and Bea's socket
    // independently and in no fixed order; if only Bea recorded the
    // handover, Ava could take the next untagged reply while Bea's socket
    // was still behind, and answer a question that had just been handed
    // away. The message Ava must record is exactly the one Ava ignores.
    // Who the message is for, judged on the named agents' own terms rather
    // than this one's: agents may list different principals, and a sender
    // Ava admits but Bea refuses must not be able to hand Bea the thread
    // from Ava's socket — Bea's own socket refuses the same message, and
    // the map is shared. A message naming Bea and Cy is Cy's, who will
    // answer it and hold the thread. One naming only agents that refuse
    // the sender is still theirs and not this agent's to answer — so the
    // refusing agent stays `named`, and only the handover is withheld.
    // Judged on configuration, not on a live connection: an agent whose
    // socket failed to start is still recognizable in a mention, and its
    // door is still its own. One this adapter was never configured for has
    // no policy, and nobody's to refuse here, so it admits.
    const handoverTo = agentNamedIn(text, team, (agentId) => admitsSender(agentConfigFor(agentId), sender));
    const named = handoverTo ?? agentNamedIn(text, team);
    // A new top-level message in this agent's home channel is addressed to
    // it as surely as a mention would be — unless it names somebody else,
    // which hands it to them exactly as it would anywhere. Top-level only:
    // inside a thread the soul's `listens` already says what an untagged
    // reply is, and the home channel does not overrule it.
    const homeOwner = !isDm && event.thread_ts === undefined && named === undefined
      ? homeOwners.get(`${team}:${event.channel}`)
      : undefined;
    const addressed = mentioned || homeOwner === connection.config.agentId;
    // The key one Slack MESSAGE is known by, whichever delivery carried
    // it; see the dedupe below for why it is not the event id.
    const eventKey = `${connection.config.agentId}:${event.channel}:${event.ts}`;

    // Recorded ahead of this agent's own refusal below, and on the named
    // agent's admission rather than this one's: a sender Ava refuses and
    // Bea admits has handed Bea the thread, and Ava's socket may be the
    // one that hears it first. If Ava withheld the record, a fast untagged
    // follow-up from someone Ava does admit would go to the old holder on
    // Ava's socket and to Bea once Bea's socket caught up — two answers to
    // one message. The refused message itself still takes no place in
    // Ava's transcript; only the map learns who holds the thread.
    if (threadKey && handoverTo) {
      rememberAddressee(threadKey, handoverTo, event.ts);
      rememberSenderAddressee(threadKey, sender, handoverTo, event.ts);
    }
    // A home-channel message hands its new thread to the channel's owner
    // the way a mention would, and is recorded by every socket for the same
    // reason: a reply in that thread can reach another agent's socket before
    // the owner's first turn has written any session routing, and without
    // this record every agent would stand down and the reply would be lost.
    // On the owner's admission, as a handover is.
    if (threadKey && homeOwner !== undefined && admitsSender(agentConfigFor(homeOwner), sender)) {
      rememberAddressee(threadKey, homeOwner, event.ts);
    }

    // Who may speak at all, judged before anything below remembers this
    // message. The adapter's own checks establish nothing about who is
    // typing; under `admit: 'principals'` the operator's list is the door,
    // not a label, and a sender not on it gets neither a turn nor a place
    // in a transcript the agent reads — nor a say in who holds the thread
    // beyond what the named agent's own admission above allowed.
    // Logged rather than answered — a reply is a conversation with someone
    // the operator chose not to have one with — and logged only for a
    // message this agent would have taken up: a mention, or an untagged
    // reply inside a thread this agent is known to hold. A channel
    // subscribed for thread follow-through delivers every post and every
    // reply in every thread, including the threads this agent was never
    // part of, and a line per stranger per reply is a log with nothing
    // left to read. Known from what this process has seen, as the
    // admitted path below judges it; a thread nothing here remembers is
    // one the sessions would have to be asked about, and a refused message
    // does not get a place in that queue. Once per MESSAGE, on the same key
    // the admitted path dedupes on: a mention arrives twice under both
    // subscriptions, and a delivery Slack did not see acknowledged arrives
    // again, and each copy would otherwise write its own line during
    // exactly the traffic an operator reads the log to understand.
    // Consuming the key here is safe because a refused message records
    // nothing a later copy could be needed for.
    if (!admitsSender(connection.config, sender)) {
      // An approver the operator did not list as a principal can still stop
      // the agent (card 337): approving is its own grant. Only when the
      // message names this agent (or is a DM to it), and nothing else they
      // say gets through.
      if (
        addressed &&
        (connection.config.approvers ?? []).includes(sender) &&
        isStopRequest(text, connection.botUserId) &&
        !alreadySeen(eventKey)
      ) {
        const stopSession = channelSessionKey({
          channel: 'slack',
          agentId: connection.config.agentId,
          team,
          conversation: event.channel,
          ...(thread ? { thread } : {}),
        });
        if (stopTurns(connection, stopSession, sender, event.channel)) {
          return undefined;
        }
        log(`slack: ${connection.config.agentId} refused a message from ${sender}: not a listed principal, and admit is "principals"`);
        return undefined;
      }
      const refusal = `slack: ${connection.config.agentId} refused a message from ${sender}: not a listed principal, and admit is "principals"`;
      // Whose message this is, as for an admitted one: the thread's owner's
      // (card 508), or for a stop, whoever was asked last (card 337).
      const refusedStop = (connection.config.approvers ?? []).includes(sender) && isStopRequest(text, connection.botUserId);
      const held = threadKey === undefined
        ? undefined
        : refusedStop ? stopHolderAt(threadKey, event.ts) : replyTargetAt(threadKey, sender, event.ts);
      if (addressed || held === connection.config.agentId) {
        if (!alreadySeen(eventKey)) {
          log(refusal);
        }
      } else if (held === undefined && event.thread_ts !== undefined && !alreadySeen(eventKey)) {
        // Nothing in memory says whose thread this is — after a restart, or
        // once the record was evicted — but the sessions may: the durable
        // half of the question the admitted path asks, and the same
        // verdict. Off the intake chain, because a refused message gets no
        // place in that queue, and the line is an audit, not a turn; `track`
        // holds it so `stop()` drains it like any other background work.
        const thread = event.thread_ts;
        track(followUpWinner({
          team,
          conversation: event.channel,
          thread,
          ...(event.parent_user_id !== undefined ? { parentUser: event.parent_user_id } : {}),
        }, event.ts, refusedStop ? 'stop' : 'reply').then((winner) => {
          if (winner === connection.config.agentId) {
            log(refusal);
          }
        }));
      }
      return undefined;
    }

    if (!addressed) {
      if (event.thread_ts === undefined) {
        // The room is not a conversation: a message that starts a thread,
        // or stands alone, is a follow-up to nothing.
        return undefined;
      }
    }

    // One Slack MESSAGE, not one delivery. An app subscribed to both
    // `app_mention` and `message.channels` is told about a mention twice —
    // two envelopes carrying two event ids — so keying this on the event
    // id would run the turn twice the moment thread follow-through was
    // switched on. `(channel, ts)` names the message itself, and a
    // redelivery (what the event id was here for) repeats both.
    //
    // After the handover record and not before it: a redelivery re-records
    // the same agent, which costs nothing, while deduping first would drop
    // the record whenever the other copy of a doubly-delivered mention is
    // the one a connection sees second. And before every stand-down below,
    // because standing down is no longer nothing: an agent that hears a
    // message it is not answering must hear it once.
    if (alreadySeen(eventKey)) {
      return undefined;
    }

    const admission: Admission = {
      event,
      isDm,
      team,
      eventKey,
      userId: event.user,
      sessionId: channelSessionKey({
        channel: 'slack',
        agentId: connection.config.agentId,
        team,
        conversation: event.channel,
        ...(thread ? { thread } : {}),
      }),
      ...(thread ? { thread } : {}),
      ...(threadKey ? { threadKey } : {}),
      settled: true,
      overhear: false,
      judge: false,
    };

    if (addressed) {
      // A message that named this agent and others is recorded above under
      // whichever of them comes first in connection order — every agent
      // named answers it, and the thread it leaves behind has one holder
      // that all the sockets agree on, which is the only self-consistent
      // reading of a message that asked several.
      return admission;
    }

    if (named) {
      // Somebody else was asked. Tagging an agent hands it the question,
      // and the agent that had it is no longer being asked — two answers
      // to one message is what a thread with a roster in it must never
      // produce. But the agent that had it is still in the room, and a
      // person in that position hears the question asked of their
      // colleague: it goes into this agent's session, unanswered, so the
      // next thing it is asked is asked of someone who followed along.
      return { ...admission, overhear: true };
    }

    // An untagged reply. How this agent listens decides what it is: an
    // agent that answers only mentions hears it and nothing more. One that
    // judges takes a turn nobody asked for on it — one it may stay quiet
    // on — when the reply is its own by the rule every agent shares (card
    // 541): the agent this person last addressed, else the thread's owner.
    // No window: an owner an hour past its last answer still hears an
    // instruction as its own, and exactly one agent takes each reply.
    const listens = listensOf(connection.config.agentId);
    if (listens === 'mentions' || listens === 'judge') {
      // Except a stop (card 337): the holder rule decides whose it is, as
      // for any agent, and it only acts if there is something to stop. A
      // thread the record has forgotten is left to the sessions, as below,
      // so a stop for a turn that outlived its record still reaches it.
      const approverStop = threadKey !== undefined &&
        (connection.config.approvers ?? []).includes(sender) &&
        isStopRequest(text, connection.botUserId);
      const stopHolder = approverStop ? holderAt(threadKey, event.ts) : undefined;
      if (listens === 'judge' && !approverStop && threadKey !== undefined) {
        const target = replyTargetAt(threadKey, sender, event.ts);
        if (target === undefined) {
          // Nothing seen here says whose thread this is: the sessions and
          // the thread read decide, as for any agent.
          return { ...admission, overhear: true, judge: true, settled: false, judgeReason: 'owner, from the thread read' };
        }
        if (target !== connection.config.agentId) {
          return { ...admission, overhear: true, judgeReason: `${target}'s reply` };
        }
        const reason = senderAddresseeAt(threadKey, sender, event.ts) === target ? 'addressed it last' : 'owner';
        return { ...admission, overhear: true, judge: true, judgeReason: reason };
      }
      // An approver's stop is never judged (card 541): it stops the turn of
      // whoever holds the thread, and with nothing to stop it is only heard.
      return {
        ...admission,
        overhear: true,
        ...(stopHolder === connection.config.agentId ? { holderStop: true } : {}),
        ...(approverStop && stopHolder === undefined ? { settled: false } : {}),
      };
    }

    // The record is what this process has actually seen, in the order it
    // saw it — right even inside the window before a handover reaches the
    // store. Whose an untagged reply is, is the thread's owner's (card
    // 508), not the last speaker's — except a stop, which is for whoever
    // was asked last, since that is the turn it means (card 337).
    const stopRequest = threadKey !== undefined &&
      (connection.config.approvers ?? []).includes(sender) &&
      isStopRequest(text, connection.botUserId);
    const holder = threadKey === undefined
      ? undefined
      : stopRequest ? stopHolderAt(threadKey, event.ts) : replyTargetAt(threadKey, sender, event.ts);
    if (holder !== undefined && threadKey !== undefined) {
      if (holder !== connection.config.agentId) {
        // Standing down for the holder, whether or not the holder can still
        // hear it. An app removed from this channel stops receiving the
        // thread, and its untagged replies then reach nobody until somebody
        // names an agent — which is the same answer this adapter gives
        // whenever the agent being addressed cannot answer, and one mention
        // reopens the conversation. Doing better means per-channel
        // membership the adapter does not track, and would have to be
        // tracked in the durable path too, since a removed app is still a
        // live connection with the newest session there.
        //
        // Standing down is not leaving: the reply is the holder's, and this
        // agent hears it.
        return { ...admission, overhear: true };
      }
      rememberAddressee(threadKey, connection.config.agentId, event.ts);
      return admission;
    }
    // Nothing seen for this thread since startup: only the sessions can
    // answer, and that answer has to be awaited.
    return { ...admission, settled: false };
  };

  const handleInbound = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    // Decided before the ack, never after it — see `admit`. That block is
    // map and string work measured in microseconds, against an ack window
    // Slack measures in seconds, and the envelope is acked below whatever
    // the decision was.
    const admitted = admit(connection, args);
    // Acked without awaiting it. The ack still leaves as promptly as it ever
    // did — Slack redelivers unacked envelopes, and a turn outlives the ack
    // window many times over — but nothing here needs its send callback, and
    // awaiting one was the single await between receiving a message and
    // taking its place in the queue below. Two handlers waiting on their
    // acks can come back in either order; two handlers that never wait
    // cannot. A failed ack costs a redelivery, which the dedupe absorbs.
    void Promise.resolve(args.ack()).catch((error) => {
      warn(`slack: could not ack an envelope: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!admitted) {
      return;
    }
    // Re-read rather than carried through the admission: `stop()` can clear
    // it while the ack above is in flight, and a dispatch into a gateway
    // this adapter has let go of is not one to start.
    const gateway = gatewayRef;
    if (!gateway) {
      return;
    }
    const { event, isDm, team, userId, thread, sessionId, threadKey, eventKey } = admitted;

    // Stop (card 337), see `stopTurns`. Only a message addressed to this
    // agent: an untagged reply this agent merely overhears is the holder's
    // (unless this agent is the holder and only `listens` made it an
    // overhear, see `holderStop`), and one only the sessions can place is
    // not this agent's to act on yet.
    if (
      (!admitted.overhear || admitted.holderStop === true) &&
      admitted.settled &&
      admitted.fromAgent === undefined &&
      (connection.config.approvers ?? []).includes(userId) &&
      isStopRequest(event.text ?? '', connection.botUserId) &&
      stopTurns(connection, sessionId, userId, event.channel)
    ) {
      return;
    }

    // What the gateway knows this message by (see `dispatchKeyFor`).
    const dispatchKey = dispatchKeyFor(eventKey);

    // Everything up to (and including) the dispatch call is serialized per
    // session in Slack receipt order: the user lookups and placeholder
    // post below await network I/O, and without this chain a later message
    // could reach gateway.dispatch first — processing the conversation in
    // reverse order in durable history. The chain is claimed here,
    // synchronously, so a message's place in it is fixed by when Slack
    // delivered it and not by how long anything it does takes.
    const stopsAtClaim = stopsBySession.get(sessionId)?.count ?? 0;
    // Only intake that can still become a turn is something a stop can
    // cancel. A settled overhear that is not judged only ever reaches
    // `gateway.observe`, so counting it would let a stop with nothing to
    // stop be consumed instead of passing on as an ordinary message.
    const mayRun = !admitted.overhear || admitted.judge || !admitted.settled;
    if (mayRun) {
      intakeInFlight.set(sessionId, (intakeInFlight.get(sessionId) ?? 0) + 1);
    }
    let leftIntake = !mayRun;
    const leaveIntake = (): void => {
      if (leftIntake) {
        return;
      }
      leftIntake = true;
      const left = (intakeInFlight.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        intakeInFlight.set(sessionId, left);
      } else {
        intakeInFlight.delete(sessionId);
        stopsBySession.delete(sessionId);
      }
    };
    const intake = onIntakeChain(sessionId, async () => {
      // The durable half of addressing runs INSIDE the chain, for the same
      // reason: it awaits, and a message that had to ask the sessions must
      // not lose its place to one that did not. A message that turns out
      // not to be this agent's leaves an empty link behind, which is all it
      // should cost.
      let overhear = admitted.overhear;
      // Judged, not ruled (card 541): the intake already placed this reply
      // with this agent, so it runs a turn nobody asked for, which may stay
      // quiet. A reply only the sessions can place waits for them below.
      let judged = false;
      if (admitted.judge && admitted.settled) {
        judged = true;
        overhear = false;
      }
      if (!admitted.settled) {
        // One verdict for this message, shared with whichever other agents
        // are asking about it — see `followUpWinner`.
        const stop = (connection.config.approvers ?? []).includes(userId) &&
          isStopRequest(event.text ?? '', connection.botUserId);
        const winner = await followUpWinner(
          {
            team,
            conversation: event.channel,
            thread: event.thread_ts ?? '',
            ...(event.parent_user_id !== undefined ? { parentUser: event.parent_user_id } : {}),
          },
          event.ts,
          stop ? 'stop' : 'reply',
        );
        if (winner !== connection.config.agentId) {
          // Not this agent's to answer — and, if it is in the thread,
          // this agent's to hear, same as the two warm stand-downs. Only a
          // stop sends a judging agent here, and a stop the sessions place
          // with another agent is heard, never judged, as it is warm.
          judged = false;
          overhear = true;
        } else {
          if (admitted.judge) {
            judged = true;
            overhear = false;
          }
          if (threadKey) {
            // Answered from the store rather than from memory: hold it, so
            // the rest of the thread is ordered by receipt like any other.
            rememberAddressee(threadKey, connection.config.agentId, event.ts);
          }
          // Stop (card 337) for a message only the sessions could place:
          // now that they say it is this agent's, it is a stop like the
          // warm one above, not a message to queue behind the turn it stops.
          if (
            (connection.config.approvers ?? []).includes(userId) &&
            isStopRequest(event.text ?? '', connection.botUserId) &&
            stopTurns(connection, sessionId, userId, event.channel, true)
          ) {
            return undefined;
          }
        }
      }
      // One line per decision a judging agent makes on an untagged reply
      // (card 541): whether it took the turn, and why. Never the text.
      if (admitted.judgeReason !== undefined) {
        const reason = admitted.settled || judged ? admitted.judgeReason : 'another agent\'s, from the thread read';
        log(`slack: judge: ${connection.config.agentId} ${judged ? 'took' : 'heard'} ${event.ts} in ${event.channel} (${reason})`);
      }
      const cleaned = await humanizeMentions(connection, event.text ?? '');
      // Fetched inside the chain, like the lookups below: it is network
      // I/O, and a message whose screenshot is slow to arrive must not lose
      // its place to the one typed after it. Only for a message this agent
      // will answer: an overheard one is appended as text with no turn run
      // on it, and its attachments reach the transcript by name, as every
      // attachment did before images.
      // A judged message is one this agent will run a turn on, so its
      // files are read too (card 625): the kernel stores them on the
      // overheard message, and every provider shows the images after the
      // frame that marks it as somebody else's. Text files land inside the
      // message, so the frame quotes them with the rest of it.
      // Images and text files share the message's one download deadline.
      const deadline = AbortSignal.timeout(fileDownloadTimeoutMs);
      const reasons: UnreadReasons = new Map();
      if (overhear) {
        for (const file of event.files ?? []) {
          reasons.set(file, 'not-opened');
        }
      }
      const { images, unread: notImages, previews } = overhear
        ? { images: [] as ImageAttachment[], unread: event.files ?? [], previews: [] as ImagePreview[] }
        : await readImageAttachments(
          event.files ?? [],
          connection.config.botToken,
          fetchFile,
          fileDownloadTimeoutMs,
          warn,
          reasons,
          deadline,
        );
      const { texts, saved, unread } = overhear
        ? { texts: [], saved: [] as SavedAttachment[], unread: notImages }
        : await readTextAttachments(
          notImages,
          connection.config.botToken,
          fetchFile,
          fileDownloadTimeoutMs,
          deadline,
          warn,
          reasons,
          options.attachmentStore
            ? createAttachmentSaver(options.attachmentStore, connection.config.agentId, admitted.fromAgent !== undefined ? 'unknown' : senderTrustFor(connection.config, userId), options.now ?? Date.now)
            : undefined,
        );
      // An image or a document with nothing said is still a question
      // ("what's this?"); a file the turn could not open with nothing said
      // is not one, and gets no reply.
      if (cleaned.length === 0 && images.length === 0 && texts.length === 0 && saved.length === 0) {
        return undefined;
      }
      // A team agent goes by the name the operator gave it, not a profile
      // its own app chose.
      // A team agent's daemon hears only what tags its bot (card 513), so
      // the model gets that tag and decides whether its answer needs it
      // (Dylan, 2026-10-15: the model tags back, the adapter never does).
      const author = admitted.fromAgent !== undefined
        ? `${admitted.fromAgent} (an agent; it sees your answer only if you tag <@${userId}>)`
        : await authorFor(connection, userId);
      // In shared channels the model should know who is speaking; a DM is
      // unambiguous. A bare image in a channel still says who sent it.
      const spoken = isDm ? cleaned : (cleaned.length > 0 ? `${author}: ${cleaned}` : `${author}:`);
      const userMessage = `${spoken}${textAttachmentBlocks(texts)}${savedAttachmentBlocks(saved)}${previewNote(previews)}${attachmentNote(unread, reasons)}`;
      // Who sent this, judged against the operator's list — per message,
      // never remembered from the first one in the thread. A DM proves
      // nothing about who is typing, so a DM from an unlisted member is
      // `unknown` exactly as a channel mention would be. The same label
      // whether the agent answers or only hears: the text is in its
      // transcript either way.
      // A team agent is below a principal whatever the list says: its
      // words carry whatever its own session was exposed to, which nothing
      // here can see (card 513).
      const senderTrust: TrustLevel = admitted.fromAgent !== undefined ? 'unknown' : senderTrustFor(connection.config, userId);
      // Who can read this, so the agent writes for them, and a thread says
      // it is one. A DM names the other person only when they are one of
      // the operator's principals: this lands in the system prompt, and
      // anyone else's display name is text they chose, which a pattern
      // cannot tell from an instruction phrased as a name.
      const room = await roomFor(connection, event.channel, isDm ? 'im' : event.channel_type);
      const conversation = room === undefined
        ? undefined
        : {
          ...room,
          ...(room.kind === 'direct' && senderTrust === 'user' ? { with: author } : {}),
          // A DM thread is a thread too, with its own session; core takes
          // no root for a direct room, since nothing posts to one by id.
          ...(thread !== undefined ? { thread: true, ...(room.kind !== 'direct' ? { threadRoot: thread } : {}) } : {}),
          // People outside this workspace read a Slack Connect channel, and
          // the event says so itself, even when the lookup failed.
          ...(room.kind !== 'direct' && args.body?.is_ext_shared_channel === true ? { shared: true } : {}),
        };
      const metadata = {
        channel: 'slack',
        team,
        slackChannel: event.channel,
        slackUser: userId,
        // Carried so a mid-turn approval question is asked in the thread
        // the turn belongs to rather than at the top of a busy channel.
        ...(thread ? { slackThread: thread } : {}),
        ...(conversation !== undefined ? { [CONVERSATION_METADATA_KEY]: conversation } : {}),
        [SENDER_TRUST_METADATA_KEY]: senderTrust,
      };

      if (overhear) {
        // Heard, not answered: no placeholder, no turn. Only into a
        // conversation this agent is already in — a session under this
        // thread's key exists exactly when it was invited here — and the
        // gateway is the one to say whether it is, on the session's chain:
        // a first mention whose dispatch is queued ahead of this message
        // has created the session by the time the observe runs, where a
        // membership read from here would find nothing and drop a
        // message said moments after the invitation. A host that cannot
        // take it leaves the agent hearing what it answers, as every
        // agent did before.
        if (!gateway.observe) {
          return undefined;
        }
        // Placed on the gateway's chain here, in receipt order, and not
        // awaited here: a dispatch is placed the same way, and awaiting
        // an overhear queued behind a long turn would hold the next
        // message's place in this chain hostage to that turn.
        return {
          observed: gateway.observe({ sessionId, agentId: connection.config.agentId, message: userMessage, metadata }),
        };
      }

      // A turn nobody asked for opens its placeholder on its first text,
      // if it ever has any — see `ReplyRenderer.lazy`. One the agent's
      // reply mode does not stream opens none at all, and shows the
      // loading status instead — see `ReplyRenderer.streaming`.
      // Mentioned into a thread partway: hand the new session what was
      // said before this. Inside the chain, before the placeholder, so the
      // read cannot reorder this message against the next one.
      let earlier: Array<{ message: string; metadata: JsonObject }> = [];
      if (thread !== undefined) {
        // A top-level mention roots its own session, so it is new but for
        // a redelivery, which the gateway answers without reading this.
        let exists = false;
        if (thread !== event.ts && gateway.sessionRouting) {
          try {
            exists = (await gateway.sessionRouting(sessionId)) !== undefined;
          } catch {
            // Unknown is read as new: a session that does exist ignores
            // the list, so the cost of guessing wrong is one API read.
          }
        }
        if (!exists) {
          // A mention that starts its own thread follows the channel; one
          // inside a thread follows that thread.
          earlier = await earlierContext(connection, event.channel, thread === event.ts ? undefined : thread, event.ts, senderTrust);
        }
      }

      const streaming = connection.config.replies === 'stream';
      const ahead = streaming ? undefined : replyOrder.get(sessionId);
      const renderer = new ReplyRenderer(connection.web, event.channel, thread, editIntervalMs, warn, {
        lazy: judged,
        now,
        streaming,
        progressAfterMs,
        texts: connection.config.replies === 'texts',
        statusThread: thread ?? event.ts,
        statusWarned: connection.statusWarned,
        ...(ahead ? { after: ahead } : {}),
        ...(isDm ? { dmWith: userId } : {}),
        // Each interim message, as it lands, takes its place in the
        // thread's other agents' sessions — ahead of a follow-up typed
        // while the tool it preceded is still running. Under the session's
        // label as stored, lowered by anything that tainted it during this
        // turn, and the least trusted label where it cannot be read.
        // A DM thread has nobody else in it to hear.
        ...(thread !== undefined && !isDm
          ? {
            onInterim: (heard: () => string, landed: Promise<boolean>) => {
              // Tracked, so a shutdown drains it like any other reaction:
              // the text is already in the thread, whatever the turn does.
              track(overhearReply(connection, event.channel, thread, heard, async () => {
                const routed = await gateway.sessionRouting?.(sessionId).catch(() => undefined);
                const stored = routed ? sessionTrustOf(routed) : 'external';
                const live = renderer.taintedTo === undefined ? stored : leastTrusted(stored, renderer.taintedTo);
                return { metadata: { [SESSION_TRUST_METADATA_KEY]: live } };
              }, landed));
            },
          }
          : {}),
      });
      if (!streaming) {
        replyOrder.set(sessionId, renderer.posted);
        void renderer.posted.then(() => {
          if (replyOrder.get(sessionId) === renderer.posted) {
            replyOrder.delete(sessionId);
          }
        });
      }
      if (!judged && streaming) {
        try {
          await renderer.open();
        } catch (error) {
          warn(`could not post to ${event.channel}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      }

      // The push and the dispatch happen in the same microtask, so queue
      // order matches the gateway's single-flight turn order for this
      // session: index 0 is always the turn currently running.
      const queue = renderers.get(sessionId) ?? [];
      queue.push(renderer);
      renderers.set(sessionId, queue);
      // Stopped while its lookups ran: dispatched under an aborted signal,
      // so it ends the way a queued turn a stop reached does.
      const stopped = stopsBySession.get(sessionId);
      leaveIntake();
      if (stopped !== undefined && stopped.count !== stopsAtClaim && renderer.stoppedBy === undefined) {
        renderer.stoppedBy = stopped.by;
        renderer.controller.abort(new RunAbortedError(`${SLACK_STOP_REASON}${stopped.by}`));
      }
      // In a DM each message is its own status key, and Slack stops showing
      // the running turn's once a newer message sits below it — so a
      // message queued there that stayed dark read as the agent having
      // stopped until the reply ahead of it posted. In a channel thread the
      // key is shared, and the running turn's status stays up instead.
      renderer.showLoading(queue.length === 1 || queue[0]?.statusThread !== renderer.statusThread);
      let repeat: 'live' | 'finished' | undefined;
      let absorbed = false;
      const replay = replaying.get(pendingKey({ agentId: connection.config.agentId, team: connection.teamId, channel: event.channel, ts: event.ts }));
      if (replay !== undefined) {
        replay.dispatched = true;
      }
      const turn = gateway.dispatch({
        sessionId,
        agentId: connection.config.agentId,
        userMessage,
        ...(images.length > 0 ? { images } : {}),
        ...(judged ? { addressed: false } : {}),
        ...(earlier.length > 0 ? { earlier } : {}),
        turnId: renderer.turnId,
        metadata,
        signal: renderer.controller.signal,
        // A redelivery this process no longer remembers (it restarted, or
        // the dedupe evicted it) is still the message it was: the gateway
        // runs no second turn for it, and says so through `onRepeat`.
        idempotencyKey: dispatchKey,
        onRepeat: (kind) => {
          repeat = kind;
        },
        // Sent while a turn is running, this message is answered by the
        // next turn together with everything else that queued (card 423);
        // the first of them renders that answer. Not a replayed message:
        // it leaves the kept list only on its own confirmed answer, and an
        // answer another message's renderer posts is not one it can see.
        ...(replay === undefined
          ? {
            onAbsorbed: () => {
              absorbed = true;
            },
          }
          : {}),
      });
      return { renderer, turn, repeat: () => repeat, absorbed: () => absorbed };
    });

    // Whatever way the intake ended, it is no longer in flight.
    void intake.then(leaveIntake, leaveIntake);
    const started = await intake;
    if (!started) {
      return;
    }
    if ('observed' in started) {
      // Nothing to render; the one outcome worth a line is the host
      // refusing it — a turn parked across a restart, most likely — since
      // a message dropped on the floor is the thing this exists to end.
      try {
        await started.observed;
      } catch (error) {
        warn(`slack: ${connection.config.agentId} could not overhear a message in ${event.channel}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const { renderer, turn, repeat, absorbed } = started;

    const removeFromQueue = (): void => {
      const current = renderers.get(sessionId);
      if (current) {
        const index = current.indexOf(renderer);
        if (index >= 0) {
          current.splice(index, 1);
        }
        if (current.length === 0) {
          renderers.delete(sessionId);
        }
      }
    };

    let session: Session | undefined;
    let failure: unknown;
    try {
      session = await turn;
    } catch (error) {
      failure = error;
    }
    // The next queued turn starts the moment this dispatch settles — its
    // events must reach ITS renderer, so this one leaves the queue BEFORE
    // the potentially slow final edit, uploads, and overflow posts.
    removeFromQueue();

    // The turn is a live earlier delivery's, and that delivery's renderer
    // posts its answer, or its failure: this one takes down whatever it put
    // up and says nothing.
    // Likewise a message absorbed into a merged turn: the turn's leading
    // message's renderer answers for all of them.
    if (repeat() === 'live' || absorbed()) {
      // A replayed message whose turn the start-up recovery owns is
      // answered by that recovery's report, and only if it reached the
      // thread; anything else leaves it kept.
      const ahead = repeat() === 'live' && renderer.outcomeReportedAhead !== undefined
        ? await renderer.outcomeReportedAhead
        : undefined;
      if (ahead?.said === true) {
        noteReplayAnsweredAhead(connection, event.channel, event.ts);
      }
      await renderer.withdraw();
      renderers.get(sessionId)?.[0]?.refreshLoading();
      return;
    }
    // A finished one's outcome is posted here, because nothing says the
    // delivery that ran it lived to post it, and no event will carry its
    // files: they are read from the session, like its reply below.
    //
    // Less what the start-up sweep already said, when it finished this
    // message's turn while the redelivery waited behind it: that outcome
    // was reported ahead of this renderer as a turn nobody was rendering,
    // and posting it again would say it twice. It was this message's turn
    // if it is the session's latest — anything finished after it would be
    // the latest instead — and the report says, part by part, what reached
    // the thread: the files it landed are not posted again, and the text
    // only if it was not said in full.
    const finished = repeat() === 'finished';
    const reportedAhead = session && finished && renderer.outcomeReportedAhead !== undefined && isLatestTurn(session, dispatchKey)
      ? await renderer.outcomeReportedAhead
      : undefined;
    if (session && finished) {
      // Counted, not a set: a turn can produce one path twice, and each
      // result is an upload of its own, so one landing does not cover both.
      const landed = new Map<string, number>();
      for (const filePath of reportedAhead?.landed ?? []) {
        landed.set(filePath, (landed.get(filePath) ?? 0) + 1);
      }
      renderer.queueFiles(turnFilesFor(session, dispatchKey).filter((file) => {
        const left = landed.get(file.path) ?? 0;
        if (left > 0) {
          landed.set(file.path, left - 1);
          return false;
        }
        return true;
      }));
    }
    if (reportedAhead?.said === true) {
      noteReplayAnsweredAhead(connection, event.channel, event.ts);
      await renderer.withdraw();
      renderers.get(sessionId)?.[0]?.refreshLoading();
      return;
    }

    // A dispatch whose turn fails rejects, but one that repeats a turn that
    // already failed — or continues a crashed one the gateway could only
    // fail — resolves with the failed session. Its failure is posted as the
    // original delivery's would have been, not as a reply that says nothing.
    const failedWith = session ? turnFailureFor(session, dispatchKey) : undefined;
    if (failedWith !== undefined) {
      failure = new Error(failedWith);
      session = undefined;
    }

    if (session) {
      // The reply is final here, so this is when the thread's other agents
      // take their place for it — before the final edit and the overflow
      // posts, which are network I/O a later message must not overtake.
      // A DM has no thread, and nobody else in it.
      // A finished repeat's session may have moved on since; its own turn
      // is found by the key.
      const reply = finished ? turnReplyFor(session, dispatchKey) : latestTurnReply(session);
      // A turn nobody asked for that said nothing posts nothing; every
      // other turn says `(no reply)` where its answer would have gone — one
      // rule with the gateway's `sessionRouting`, which posts the same
      // message for a turn this adapter did not start.
      const finalized = renderer.finalize(renderer.lazy ? reply ?? '' : reply ?? NO_REPLY_TEXT);
      // What the turn said along the way as well as its reply: interim
      // messages are in the thread, so they are in what the others hear.
      // Heard once the posts have settled, and the reply only if it landed:
      // interim messages already in the thread are heard either way.
      let replyLanded = false;
      const settled = finalized.then((outcome) => {
        noteReplayOutcome(connection, event.channel, event.ts, outcome);
        replyLanded = outcome.published;
        return true;
      }, () => true);
      const heard = thread !== undefined && !isDm
        ? overhearReply(connection, event.channel, thread, () => renderer.spokenText(replyLanded ? reply ?? '' : ''), session, settled)
        : undefined;
      const { spoke, spokeAt } = await finalized;
      if (spoke && threadKey !== undefined) {
        // The voice that just answered, recorded where its reply sits in
        // the thread. For a judging agent this is the only record there
        // is — it took no part in the holder rule at intake — and without
        // it a thread-rule colleague that held the thread before would
        // keep answering beside it. For any other turn the intake wrote
        // one at the message answered, and this one says where the answer
        // landed, which is what settles two turns running at once: a
        // placeholder posted at intake sits above a reply a judge posted
        // while it was being filled, whichever turn finished first, and
        // the reader's next untagged message is for the lower of the two.
        // Late, either way, for a message typed while the turn was still
        // running, which the other may therefore still take.
        // Under the owner rule (card 508) only two replies move the thread:
        // a judging agent that chose to speak, and the owner answering in
        // its own thread, which takes it back from a judge that spoke above.
        // An answer to a mention is that message's answer and no more.
        const takes = renderer.lazy || threadOwner(threadKey) === connection.config.agentId;
        rememberAddressee(threadKey, connection.config.agentId, spokeAt ?? event.ts, takes);
      }
      // The reply just posted took the thread's status down with it, and a
      // turn queued behind this one is still working.
      renderers.get(sessionId)?.[0]?.refreshLoading();
      await heard;
    } else {
      // A paused daemon's refusal is its answer, said as it is: the
      // operator wrote that sentence for the person reading it, and it is
      // not a failure of the agent. Matched by name, as this package does
      // not import the gateway. A turn nobody asked for stays silent.
      const pausedReply = failure instanceof Error && failure.name === 'IntakePausedError';
      // A daemon on its way down that still heard this (the gateway keeps
      // channels connected through its drain): the message is kept for the
      // next start, which handles it as if it had just arrived. Said only
      // to a message that asked: a judged reply in the agent's thread (a
      // turn nobody asked for) is kept so the next daemon can still judge
      // it, but nobody asked, so a notice under it would be noise. An
      // overheard message never gets here; it was never going to be a turn.
      // Matched by name, like the pause.
      const stoppingRefusal = failure instanceof Error && failure.name === 'GatewayStoppingError' && renderer.stoppedBy === undefined;
      let deferredText: string | undefined;
      if (stoppingRefusal) {
        const restarting = (failure as Error & { restarting?: unknown }).restarting !== false;
        const kept = await keepForNextStart({
          agentId: connection.config.agentId,
          team,
          channel: event.channel,
          ts: event.ts,
          ...(event.thread_ts !== undefined ? { threadTs: event.thread_ts } : {}),
          user: userId,
          ...(event.channel_type !== undefined ? { channelType: event.channel_type } : {}),
          keptAt: now(),
        });
        if (kept) {
          log(`slack: ${connection.config.agentId} kept ${event.ts} in ${event.channel} to answer after the ${restarting ? 'restart' : 'stop'}`);
          deferredText = restarting ? RESTARTING_REPLY_TEXT : STOPPING_REPLY_TEXT;
        } else {
          deferredText = (failure as Error).message;
        }
      }
      // A refusal (paused, or a daemon on its way down) ran no turn, so its
      // notice is never what answers a replayed message: that one stays
      // kept, whether or not keeping it again just worked.
      const refused = pausedReply || stoppingRefusal;
      const outcome = renderer.stoppedBy !== undefined
        ? await renderer.stopped(renderer.stoppedBy)
        : refused
        ? await renderer.finalize(renderer.lazy ? '' : deferredText ?? (failure as Error).message)
        : await renderer.fail(failure instanceof Error ? failure.message : String(failure), failure instanceof HostRefusalError);
      const { spoke, spokeAt } = refused && renderer.stoppedBy === undefined
        ? outcome
        : noteReplayOutcome(connection, event.channel, event.ts, outcome);
      if (spoke && threadKey !== undefined) {
        // A file it posted before breaking has still spoken, by the same
        // rule as a reply that landed.
        const takes = renderer.lazy || threadOwner(threadKey) === connection.config.agentId;
        rememberAddressee(threadKey, connection.config.agentId, spokeAt ?? event.ts, takes);
      }
      renderers.get(sessionId)?.[0]?.refreshLoading();
    }
  };

  /**
   * One agent's app, authenticated, with who its bot is recorded, and its
   * socket built but not started: undefined, with a warning, when it would
   * not authenticate. Recorded before the socket is even built: an app
   * that never comes up must still be recognizable when somebody names it.
   */
  const authenticate = async (config: SlackAgentConfig): Promise<AgentConnection | undefined> => {
    try {
      const created = createWeb(config.botToken);
      const web = config.linkPreviews === false ? withoutLinkPreviews(created) : created;
      const auth = await web.auth.test();
      const botUserId = auth.user_id ?? '';
      const teamId = auth.team_id ?? '';
      checkBotScopes(config.agentId, auth.response_metadata?.scopes ?? [], warn);
      botIdentities.set(config.agentId, { botUserId, teamId });
      return {
        config,
        web,
        socket: createSocket(config.appToken),
        botUserId,
        teamId,
        statusWarned: { value: false },
      };
    } catch (error) {
      // One broken app must not take the rest of the fleet down.
      warn(`slack: could not connect ${config.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /**
   * Starts an authenticated app's socket and serves it. Resolves with the
   * listener a replay of kept messages delivers through, or undefined when
   * the socket would not start: authenticated but not serving, it answers
   * nothing, and stays recognizable so nobody answers in its place.
   */
  const connect = async (connection: AgentConnection): Promise<((args: SlackSocketEventArgs) => Promise<void>) | undefined> => {
    const { config, socket } = connection;
    try {
      // Returns the work it started: the SDK ignores it, and a test's fake
      // socket waits on it rather than guessing how long it takes.
      const handle = (inbound: Promise<void>): Promise<void> => {
        const handled = inbound.catch((error) => {
          warn(`slack event handling failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        inflight.add(handled);
        void handled.finally(() => inflight.delete(handled));
        return handled;
      };
      // The replay's own deliveries never wait on the hold they release.
      const onReplay = (args: SlackSocketEventArgs): Promise<void> => handle(handleInbound(connection, args));
      const onEvent = (args: SlackSocketEventArgs): Promise<void> => {
        const channel = (args.event as { channel?: unknown } | undefined)?.channel;
        const hold = typeof channel === 'string' ? replayHolds.get(holdKey(config.agentId, channel))?.held : undefined;
        if (hold === undefined) {
          return onReplay(args);
        }
        // Acked now, as any delivery is, so Slack does not redeliver a
        // message that is only waiting its turn; admitted after the hold.
        void Promise.resolve(args.ack()).catch((error) => {
          warn(`slack: could not ack an envelope: ${error instanceof Error ? error.message : String(error)}`);
        });
        return handle(hold.then(() => handleInbound(connection, { ...args, ack: async () => {} })));
      };
      socket.on('app_mention', onEvent);
      socket.on('message', onEvent);
      socket.on('interactive', (args: SlackSocketEventArgs): Promise<void> => {
        const handled = handleInteractive(connection, args).catch((error) => {
          warn(`slack interaction handling failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        track(handled);
        return handled;
      });
      const up = (async (): Promise<boolean> => {
        await socket.start();
        // A stop that began while this socket was starting has already
        // disconnected what it could see; one left up here would answer
        // beside the next daemon. Checked in the same step that adds it
        // to `connections`, so a stop either sees it there or finds it
        // here.
        if (stopRequested) {
          if (!await disconnect(connection, 'the adapter is stopping')) {
            leftUpAtStop.add(config.agentId);
          }
          return false;
        }
        connections.push(connection);
        return true;
      })();
      socketsStarting.set(up, config.agentId);
      try {
        if (!await up) {
          return undefined;
        }
      } finally {
        socketsStarting.delete(up);
      }
      log(`slack: ${config.agentId} connected (bot ${connection.botUserId} in team ${connection.teamId})`);
      return onReplay;
    } catch (error) {
      warn(`slack: could not connect ${config.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** Closes an app's socket; false, with a warning, when the close was refused. */
  const disconnect = async (connection: AgentConnection, reason: string): Promise<boolean> => {
    try {
      await connection.socket.disconnect();
      return true;
    } catch (error) {
      warn(`slack: could not disconnect ${connection.config.agentId} (${reason}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const sameApp = (a: SlackAgentConfig, b: SlackAgentConfig): boolean =>
    a.appToken === b.appToken && a.botToken === b.botToken;

  /**
   * Brings the connected apps in line with the agents to carry now (card
   * 894): connects an agent whose app is new, or that the roster has only
   * now, or that did not come up before; reconnects one whose tokens
   * changed; disconnects one whose tokens were removed or whose soul is
   * gone. Every other socket is left alone, so a conversation on it never
   * notices. Settings come with the list `options.loadAgents` reads, which
   * for the daemon is the config it started with.
   */
  const reconcile = async (): Promise<void> => {
    const gateway = gatewayRef;
    if (gateway === undefined || stopRequested || options.loadAgents === undefined) {
      return;
    }
    const next = await options.loadAgents();
    if (gatewayRef !== gateway || stopRequested) {
      return;
    }
    const known = new Set(gateway.agents().map((agent) => agent.id));
    const wanted = new Map(next.filter((config) => known.has(config.agentId)).map((config) => [config.agentId, config]));
    const connected = new Map(connections.map((connection) => [connection.config.agentId, connection]));
    const leaving = [...connected.values()].filter((connection) => {
      const config = wanted.get(connection.config.agentId);
      return config === undefined || !sameApp(config, connection.config);
    });

    // Closed first, and only a closed one is let go of. A socket whose close
    // was refused may still deliver, so it stays this agent's connection,
    // on the tokens it has, and nothing is started beside it: a second
    // socket for the agent would answer every message twice, and a removed
    // app would keep answering while reported gone. A restart clears it.
    for (const connection of leaving) {
      const agentId = connection.config.agentId;
      const reason = !known.has(agentId)
        ? 'its soul is gone'
        : wanted.has(agentId) ? 'its tokens changed' : 'its tokens were removed';
      if (!await disconnect(connection, reason)) {
        warn(`slack: ${agentId} stays connected with the app it had until a restart, since its socket would not close`);
        continue;
      }
      const index = connections.indexOf(connection);
      if (index >= 0) {
        connections.splice(index, 1);
      }
      log(`slack: ${agentId} disconnected (${reason})`);
    }
    // What is still connected now, stuck sockets included, serves on.
    const serving = (agentId: string): AgentConnection | undefined =>
      connections.find((connection) => connection.config.agentId === agentId);
    const arriving = [...wanted.values()].filter((config) => serving(config.agentId) === undefined);

    // A connected app keeps the configuration it is serving with.
    carried = [
      ...next.map((config) => serving(config.agentId)?.config ?? config),
      ...connections.filter((connection) => !next.some((config) => config.agentId === connection.config.agentId)).map((connection) => connection.config),
    ];
    configuredAgents.clear();
    for (const config of carried) {
      configuredAgents.add(config.agentId);
    }
    // Who each remaining bot is, in the carried order: an app no longer
    // carried is nobody's to recognize, and a new one is learned below.
    const kept = new Map(botIdentities);
    botIdentities.clear();
    for (const config of carried) {
      const identity = kept.get(config.agentId);
      if (identity !== undefined && serving(config.agentId) !== undefined) {
        botIdentities.set(config.agentId, identity);
      }
    }
    for (const config of next) {
      if (!known.has(config.agentId) && serving(config.agentId) === undefined) {
        warn(`slack: no roster agent with id ${config.agentId}; skipping its Slack app`);
      }
    }

    // Every new identity first, then the sockets, as `start` does: a
    // mention of an agent not yet known would read as an untagged reply.
    const authenticated: AgentConnection[] = [];
    for (const config of arriving) {
      if (stopRequested) {
        return;
      }
      const connection = await authenticate(config);
      if (connection) {
        authenticated.push(connection);
      }
    }
    if (authenticated.length > 0) {
      const learned = new Map(botIdentities);
      botIdentities.clear();
      for (const config of carried) {
        const identity = learned.get(config.agentId);
        if (identity !== undefined) {
          botIdentities.set(config.agentId, identity);
        }
      }
    }
    settleHomeOwners();
    for (const connection of authenticated) {
      if (stopRequested) {
        return;
      }
      await connect(connection);
    }
  };

  // One reload at a time: the gateway can call again before an earlier one
  // settled, since it stops waiting after a bound.
  let reloading: Promise<void> = Promise.resolve();
  const reload = (): Promise<void> => {
    const run = reloading.then(reconcile, reconcile);
    reloading = run.catch(() => undefined);
    return run;
  };

  return {
    name: 'slack',
    ...(options.loadAgents !== undefined ? { reload } : {}),
    resolveOutbound,
    readConversation,
    sessionConversation,
    createConversation,
    joinConversation,
    inviteToConversation,
    archiveConversation,
    // A channel id is unique only within its workspace, so a standing
    // grant on one is bound to the team the agent's app authenticated in.
    accountFor: (agentId: string) => botIdentities.get(agentId)?.teamId || undefined,
    conversationKindFor,
    requestCredential,
    credentialReplaceForms: true,
    credentialEnvForms: true,

    async start(gateway) {
      gatewayRef = gateway;
      stopRequested = false;
      leftUpAtStop.clear();
      // Nothing counts as seen live until every socket is up (Codex
      // 4321128637): a message sent while the sockets are still coming up
      // reaches none of them, so a read stopping before it stops short.
      liveFrom = NOT_LIVE_YET;
      unsubscribe = gateway.bus.subscribe((event) => {
        if (event.type === 'credential.provided') {
          track(settleCredentialPost(event));
          return;
        }
        if (event.type === 'tool.approval-resolved') {
          if (askingAfterLine.has(event.requestId)) {
            settledBeforeAsked.add(event.requestId);
          }
          // The question was posted into the turn's thread, which took the
          // loading status down with it; the turn works on once answered.
          track(retractApprovalRequest(event).finally(() => renderers.get(event.sessionId)?.[0]?.refreshLoading()));
          return;
        }
        // A turn ends here in one of two hands. One this adapter started
        // is finished by the renderer it opened at intake, from the
        // session `dispatch` returns. One it did not start — a recovery
        // of a turn parked on a human when the daemon died, or a turn the
        // startup sweep closed out — has no renderer, and is reported
        // from the session's stored routing instead.
        //
        // A renderer in the queue is not proof the outcome is that turn's.
        // The renderer is queued at intake, before the gateway starts the
        // turn, so a message arriving while a recovery is still ahead of
        // it on the session chain has a renderer at the head while the
        // recovery finishes — and the recovery's reply would be swallowed
        // as rendered when nothing rendered it.
        //
        // Which turn is running is exact when the gateway says so: every
        // turn this adapter dispatches carries its renderer's `turnId`, and
        // `activeTurnId` names the one on the session now (`StratusEvent`
        // itself carries no turn identifier), so a turn another surface
        // dispatched to the same session is never taken for this adapter's,
        // whatever order the two started in. A gateway without that answer
        // leaves the order of events: the session reports `running` as
        // each turn begins, and the next `running` is taken to be the
        // head renderer's — right for a recovery, which is always ahead of
        // the message queued behind it, and wrong only for a foreign turn
        // that starts after the message was queued.
        const head = renderers.get(event.sessionId)?.[0];
        const exact = gateway.activeTurnId !== undefined;
        const active = gateway.activeTurnId?.(event.sessionId);
        if (event.type === 'session.updated' && event.status === 'running' && head && (!exact || active === head.turnId)) {
          head.beginTurn();
        }
        // A renderer at the head that has not seen its turn start is
        // queued behind the turn ending now, and its placeholder is
        // already in the thread: the outcome goes through it, so the
        // thread reads in the order the conversation happened.
        const rendered = exact
          ? active !== undefined && (renderers.get(event.sessionId) ?? []).some((renderer) => renderer.turnId === active)
          : head?.turnStarted === true;
        // A file belongs to the turn that produced it. A renderer queued
        // behind a recovery is not its renderer, and uploading through it
        // would put the recovery's attachment below the newer turn's
        // answer — so where the gateway names the running turn, a result
        // from another one is held for that turn's own outcome instead.
        // Without that answer the order of events cannot tell a foreign
        // turn from a renderer still waiting to start, and the renderer
        // keeps what it is handed, as it always has.
        const foreign = exact && !rendered;
        // Approval traffic is not part of a reply: it gets its own message
        // with its own lifetime, and routing it through the running turn's
        // renderer would fold a question into the answer being streamed.
        // What the turn wrote before the call goes out first, though, so
        // the approver reads the line saying what the agent is doing above
        // the question it leads to (card 950). The wait is bounded: a line
        // Slack is slow to take must not keep the question from anyone.
        if (event.type === 'tool.approval-requested') {
          head?.awaitingApproval(event.call.toolName, !foreign);
          const said = head?.sayBeforeAsking(!foreign);
          if (!said) {
            track(renderApprovalRequest(event));
            return;
          }
          askingAfterLine.add(event.requestId);
          track(settledWithin(said, approvalPromptWaitMs).then(async () => {
            askingAfterLine.delete(event.requestId);
            if (settledBeforeAsked.delete(event.requestId)) {
              return;
            }
            await renderApprovalRequest(event);
          }));
          return;
        }
        if (event.type === 'tool.completed' && event.result.ok && (foreign || !head)) {
          const produced = collectFilePaths(event.result);
          if (produced.length > 0) {
            const held = [...(unrenderedFiles.get(event.sessionId) ?? []), ...produced];
            // Said out loud when it bites: these are files somebody asked
            // for, and attachments that never arrive with nothing in the
            // log is the hardest kind of loss to work out afterwards.
            if (held.length > MAX_UNRENDERED_FILES) {
              warn(`slack: a turn with no renderer has produced ${held.length} files; only the last ${MAX_UNRENDERED_FILES} will be posted to its thread`);
            }
            unrenderedFiles.set(event.sessionId, held.slice(-MAX_UNRENDERED_FILES));
          }
        }
        // Claimed here, synchronously, rather than inside the report: the
        // report reads the turn's routing from the store first, and the
        // queued turn can finish inside that round trip (see
        // `HandoverClaim`). The claim is released either way, so a report
        // that finds nothing to post — another surface's session, no
        // connection — never leaves the queued reply stalled behind it.
        if (event.type === 'session.failed' && !rendered) {
          const claim = head?.reserveHandover();
          const report = reportUnrenderedFailure(event, claim, takeUnrenderedFiles(event.sessionId));
          if (head) {
            head.outcomeReportedAhead = report.catch(() => NOTHING_REPORTED);
          }
          track(report.then(() => {}).finally(() => {
            claim?.release();
            head?.refreshLoading();
          }));
          return;
        }
        if (event.type === 'session.completed' && !rendered) {
          const claim = head?.reserveHandover();
          const report = reportUnrenderedReply(event, claim, takeUnrenderedFiles(event.sessionId));
          if (head) {
            head.outcomeReportedAhead = report.catch(() => NOTHING_REPORTED);
          }
          track(report.then(() => {}).finally(() => {
            claim?.release();
            head?.refreshLoading();
          }));
          return;
        }
        if ('sessionId' in event) {
          renderers.get(event.sessionId)?.[0]?.onEvent(event, !foreign);
        }
      });

      const known = new Set(gateway.agents().map((agent) => agent.id));
      // Two passes, because who a message names has to be answerable from
      // the first event onwards. Identities are learned for every app
      // FIRST; only then does any socket start delivering. One pass would
      // leave the agents at the front of the roster taking messages while
      // the ones behind them were still authenticating, and a mention of an
      // agent not yet known reads as an untagged reply — which the agent
      // holding that thread would then answer.
      const authenticated: AgentConnection[] = [];
      for (const config of carried) {
        if (!known.has(config.agentId)) {
          warn(`slack: no roster agent with id ${config.agentId}; skipping its Slack app`);
          continue;
        }
        const connection = await authenticate(config);
        if (connection) {
          authenticated.push(connection);
        }
      }

      settleHomeOwners();

      const listeners = new Map<string, (args: SlackSocketEventArgs) => Promise<void>>();
      // Read before any socket delivers, so each conversation with kept
      // messages is held from the first live event on.
      let kept: PendingIntake[] = [];
      if (pendingIntakePath !== undefined) {
        try {
          kept = await readPending(pendingIntakePath);
        } catch (error) {
          warn(`slack: could not read the messages kept from the last restart: ${error instanceof Error ? error.message : String(error)}`);
        }
        const cutoff = now() - PENDING_INTAKE_MAX_AGE_MS;
        for (const entry of kept) {
          if (entry.keptAt >= cutoff && authenticated.some((connection) => keptFor(connection, entry))) {
            holdConversation(holdKey(entry.agentId, entry.channel));
          }
        }
      }
      for (const connection of authenticated) {
        const onReplay = await connect(connection);
        if (onReplay) {
          listeners.set(connection.config.agentId, onReplay);
        }
      }
      const liveMs = now() + LIVE_FROM_MARGIN_MS;
      liveFrom = `${Math.floor(liveMs / 1000)}.${String((liveMs % 1000) * 1000).padStart(6, '0')}`;
      // Once every app is connected, so a kept message is handled with the
      // whole roster's identities known, as a live one would be. Only for the
      // apps that did connect: the rest stay kept for a start where they do.
      // A kept message is from before the restart, so its thread read stops
      // short of the start, as `liveFrom` already says (card 562).
      replayStopping = new AbortController();
      track(replayKept(kept, new Map([...listeners].filter(([agentId]) => connections.some((connection) => connection.config.agentId === agentId))), replayStopping.signal).finally(releaseAllConversations));
    },

    async stop() {
      stopRequested = true;
      replayStopping?.abort();
      releaseAllConversations();
      // Stop intake first, so no new INBOUND event can slip into
      // `inflight` while the drain below runs. A close that is refused
      // leaves a socket that may still deliver (card 935), and so does one
      // still starting that does not come down in time: the stop rejects
      // naming them, after the drain, and the gateway counts that as not
      // drained, so a restart exits for the service manager rather than
      // start a second daemon answering beside them.
      const closing = Promise.all(connections.map(async (connection) =>
        await disconnect(connection, 'the adapter is stopping') ? undefined : connection.config.agentId));
      // Whatever is still in here once the wait ends never came up or down.
      const starting = new Map(socketsStarting);
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...starting.keys()].map((up) => up.finally(() => starting.delete(up)))),
        new Promise<void>((resolve) => { waited = setTimeout(resolve, stopWaitMs); }),
      ]);
      clearTimeout(waited);
      const refused = [...new Set([...(await closing).filter((agentId) => agentId !== undefined), ...leftUpAtStop])];
      const stillStarting = [...new Set(starting.values())];
      leftUpAtStop.clear();
      // Until it stays empty, not once. The bus subscription is still live
      // here — it comes down after the drain, because a turn finishing
      // inside the drain still has an outcome to render — so a turn the
      // gateway is finishing can hand `track` work after any one snapshot
      // was taken. A single snapshot dropped exactly what this drain
      // exists to deliver: a shutdown denies every parked call, and the
      // retraction that takes the live buttons off the message is tracked
      // by a subscriber reacting to that denial, which is to say during
      // the drain rather than before it.
      //
      // This waits for reactions, never for turns: work enters `inflight`
      // only when an event arrives, so a turn that has not finished
      // emitting anything is not something the loop can be waiting on. It
      // ends when the set does, which is when a snapshot drain would have
      // ended, plus the tail it used to leave behind.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
      unsubscribe?.();
      unsubscribe = undefined;
      gatewayRef = undefined;
      connections.length = 0;
      approvalPosts.clear();
      threadAddressee.clear();
      threadTrimmedUntil.clear();
      threadReadUntil.clear();
      senderAddressees.clear();
      coldVerdicts.clear();
      botIdentities.clear();
      homeOwners.clear();
      rendering.clear();
      resolvedWhileRendering.clear();
      credentialsPosting.clear();
      const left = [
        ...(refused.length > 0 ? [`the socket for ${refused.join(', ')} would not close`] : []),
        ...(stillStarting.length > 0 ? [`the socket for ${stillStarting.join(', ')} was still starting after ${stopWaitMs}ms`] : []),
      ];
      if (left.length > 0) {
        throw new Error(`${left.join('; ')}, so it may still deliver messages`);
      }
    },
  };
};
