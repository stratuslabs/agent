import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  SENDER_TRUST_METADATA_KEY,
  sessionWriteTrust,
  escapeControlCharacters,
  type JsonObject,
  leastTrusted,
  type AgentWorkspaces,
  type ListensMode,
  type Session,
  type StratusEvent,
  type TrustLevel,
  admitsSender,
  channelSessionKey,
  senderTrustFor,
  type AdmitPolicy,
  type ChannelAdapter,
  type GatewayLike,
  type OutboundAddress,
  type OutboundConnection,
  type OutboundMessageRef,
  postOf,
  type ToolPost,
} from '@stratusagent/core';

import {
  collectFilePaths,
  messageChunks,
  messageText,
  NOTHING_REPORTED,
  postPart,
  type ReplyOutcome,
  ReplyRenderer,
} from './reply.ts';
import {
  attachmentNote,
  type UnreadReasons,
} from './attachments.ts';
import type { AgentConnection } from './connection.ts';
import type { Handover } from './handover.ts';
import type { PendingApprovalPost, PendingCredentialPost } from './pending-posts.ts';
import type { PendingIntake } from './pending-intake.ts';
import { slackErrorCode } from './slack-errors.ts';
import {
  defaultFetchFile,
  onlySlackFileHost,
  type SlackFileFetcher,
  type SlackInboundFile,
} from './files.ts';
import { createUnrenderedOutcomes } from './unrendered.ts';
import { createApprovalPrompts } from './approvals.ts';
import { createConversations } from './conversations.ts';
import { createInteractions } from './interactions.ts';
import { createThreadTracking } from './threads.ts';
import { createAdmitter } from './admission.ts';
import { createInbound } from './inbound.ts';

/**
 * The longest display name the model is shown. Slack caps profile names
 * well under this; the bound is for a profile that is not a name.
 */
const MAX_DISPLAY_NAME_LENGTH = 80;

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
 * How far above a team agent's mention its own files are looked for (card
 * 1061). It bounds the read, one page of a thread's last hour, not which
 * files count: that is the agent's run of messages just above the tag.
 */
const TAGGED_FILES_WINDOW_SECONDS = 3600;
/** The most files a mention takes from its tagger's messages above it. */
const TAGGED_FILES_LIMIT = 10;

/**
 * At the top of a channel, how many of its most recent messages a mention
 * opens with, and how many are read to find them.
 */
const EARLIER_CHANNEL_LIMIT = 20;
const EARLIER_CHANNEL_READ = 100;
/** The most pages read to find them: 1,000 messages. */
const EARLIER_CHANNEL_PAGES = 10;

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
  files?: SlackUploadedFile[];
}

/**
 * One file in an upload's answer, or in `files.info`'s. The SDK's
 * `uploadV2` nests the files Slack completed under each part it uploaded,
 * so a file may carry `files` of its own.
 */
export interface SlackUploadedFile {
  id?: string;
  files?: SlackUploadedFile[];
  shares?: {
    public?: Record<string, Array<{ ts?: string; thread_ts?: string }>>;
    private?: Record<string, Array<{ ts?: string; thread_ts?: string }>>;
  };
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
    /**
     * `message` is the post as Slack placed it. A reply naming a thread
     * Slack has no message for is still `ok`, posted at the top level, and
     * its `message` then has no `thread_ts`.
     */
    postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: SlackBlock[]; unfurl_links?: boolean; unfurl_media?: boolean }): Promise<{ ts?: string; channel?: string; message?: { ts?: string; thread_ts?: string } }>;
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
    uploadV2(args: { channel_id: string; file: Buffer; filename?: string; title?: string; thread_ts?: string; initial_comment?: string }): Promise<SlackUploadResult>;
    /**
     * Where an upload landed, once Slack has shared it: the upload's own
     * answer does not say (card 1033). Optional: an older fake without it
     * leaves a part posted as an upload with no ts, never unposted.
     */
    info?(args: { file: string }): Promise<{ file?: SlackUploadedFile }>;
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
    info(args: { user: string }): Promise<{ user?: { name?: string; is_bot?: boolean; profile?: { display_name?: string; real_name?: string } } }>;
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
   * Puts an emoji reaction on a message: what a reply-optional turn that
   * stays silent leaves instead of a reply, when it names one (card 1078).
   * Needs `reactions:write`, which the manifest asks for; an app without
   * it stays silent and is told once. Optional so an older SDK or fake
   * still runs, without reactions.
   */
  reactions?: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
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
   * @deprecated Ignored. Slack no longer gets a progress message (card
   * 1009); Slack's own status line shows a turn is working. Accepted so a
   * caller that set it still compiles.
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

const isPersonSpeaking = (event: SlackInboundEvent): boolean =>
  event.subtype === undefined || HUMAN_MESSAGE_SUBTYPES.has(event.subtype);

/**
 * Whether `text` addresses a bot user by name. Slack writes a mention as
 * `<@U123>` markup whoever typed it, so this is the same question for an
 * `app_mention` event and for a plain channel message the app now also
 * sees.
 */
const mentions = (text: string, botUserId: string): boolean =>
  botUserId.length > 0 && text.includes(`<@${botUserId}>`);

/**
 * The users a message's `<@U123>` and `<@U123|name>` mentions name, in
 * order. The classes leave out `<` so that reading crafted text such as
 * `<@<@<@…` stays linear (card 1090). Slack escapes `<` in message text,
 * so a real mention never has one inside it.
 */
const mentionedUsers = (text: string): string[] =>
  [...text.matchAll(/<@([^|<>]+)(?:\|[^<>]*)?>/g)].map((match) => match[1] as string);

/**
 * Whether a message asks this agent to stop (card 337): the word "stop"
 * and nothing else but mentions and closing punctuation, in any case. A
 * message that mentions someone and not this agent is for them. Exported
 * for tests.
 */
export const isStopRequest = (text: string, botUserId: string): boolean => {
  const mentioned = mentionedUsers(text);
  if (mentioned.length > 0 && !mentioned.includes(botUserId)) {
    return false;
  }
  // Anchored at the start, so the engine tries one position rather than
  // rescanning a long run of `.` from every one of them (card 1090).
  return /^stop\s*[.!]*$/i.test(text.replace(/<@[^|<>]+(?:\|[^<>]*)?>/g, ' ').trim());
};

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
/** The shape of a Slack user id: `U…`, or `W…` on Enterprise Grid. A conversation id never starts with either. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

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
  const unrenderedFiles = new Map<string, Array<string | ToolPost>>();
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
  /** Whether a user is a bot, as users.info said, keyed `team:user` like `displayNames`. */
  const botUsers = new Map<string, boolean>();
  // Socket Mode redelivers on missed acks; a slow turn must not run twice.
  const seenEvents = new Set<string>();
  const seenOrder: string[] = [];

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
      if (typeof info.user?.is_bot === 'boolean') {
        botUsers.set(cacheKey, info.user.is_bot);
      }
      return name;
    } catch {
      return userId;
    }
  };

  /**
   * Whether `text` tags another agent (card 1014), which `texts` mode then
   * posts as one message: the tagged agent admits only a message that
   * names it, so a reply split a paragraph to a message reached it as the
   * tagged part alone. Another agent is one on this daemon, one on this
   * agent's `agentMentions` team, or any user Slack says is a bot, asked
   * once a user. A user Slack could not answer for counts as an agent: a
   * person tagged in one message loses nothing, and an agent handed a
   * split reply loses everything after the tag.
   */
  const tagsAnAgent = async (connection: AgentConnection, text: string): Promise<boolean> => {
    const tagged = new Set(mentionedUsers(text));
    tagged.delete(connection.botUserId);
    const team = Object.values(connection.config.agentMentions?.team ?? {});
    for (const user of tagged) {
      if (isFleetBot(connection.teamId, user) || team.includes(user)) {
        return true;
      }
    }
    for (const user of tagged) {
      const cacheKey = `${connection.teamId}:${user}`;
      let isBot = botUsers.get(cacheKey);
      if (isBot === undefined) {
        try {
          const info = await connection.web.users.info({ user });
          isBot = info.user?.is_bot === true;
          botUsers.set(cacheKey, isBot);
        } catch (error) {
          warn(`slack: could not tell whether ${user} is a bot, so a texts reply tagging them is posted as one message: ${error instanceof Error ? error.message : String(error)}`);
          return true;
        }
      }
      if (isBot) {
        return true;
      }
    }
    return false;
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
   * The files a team agent posted just above the message where it tags
   * this one (card 1061). A turn that makes a screenshot and then asks a
   * colleague about it posts the file as a message of its own, above the
   * tag, so the mention arrived with nothing attached: the colleague was
   * asked to inspect something it was never handed, and in a session it
   * already held it did not even hear the upload, since an agent's
   * untagged message reaches nobody.
   *
   * The agent's own messages directly above the tag, with nobody else
   * speaking between, are that turn's posts, or as near to them as a
   * reader on another daemon can tell. They come in the thread's order,
   * the tag's own last and not repeated: images are kept from the last back
   * (`readImageAttachments`), so the tag's own are kept first, and the
   * caller hands the text reader, which spends from the front, the tag's
   * own first. One read, of the hour before the mention. A thread
   * with more than a page of replies in that hour gives nothing, rather
   * than a run read from the middle of it, and a read that fails warns:
   * either way the mention runs with what it carried, as before this.
   */
  const withFilesJustAbove = async (
    connection: AgentConnection,
    event: SlackInboundEvent & { thread_ts: string },
    speaker: string,
    name: string,
  ): Promise<SlackInboundFile[]> => {
    const own = event.files ?? [];
    const replies = connection.web.conversations.replies;
    if (!replies) {
      return own;
    }
    // Whole seconds, so the arithmetic never touches the six digits after
    // the point that make a Slack ts unique.
    const [seconds = '0', fraction = '000000'] = event.ts.split('.');
    const oldest = `${Math.max(0, Number(seconds) - TAGGED_FILES_WINDOW_SECONDS)}.${fraction}`;
    let page: SlackHistoryPage;
    try {
      page = await replies.call(connection.web.conversations, {
        channel: event.channel,
        ts: event.thread_ts,
        latest: event.ts,
        oldest,
        inclusive: false,
        limit: 200,
      });
    } catch (error) {
      warn(
        `slack: ${connection.config.agentId} could not read above ${name}'s mention in ${event.channel}, so it gets only the files on the mention itself: `
        + `${error instanceof Error ? error.message : String(error)} (the history scopes are channels:history, groups:history, and mpim:history)`,
      );
      return own;
    }
    if (page.response_metadata?.next_cursor) {
      return own;
    }
    const above = (page.messages ?? [])
      .filter((message) => message.ts !== undefined && Number(message.ts) < Number(event.ts))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    const posted: SlackInboundFile[] = [];
    for (let index = above.length - 1; index >= 0 && above[index]!.user === speaker; index -= 1) {
      posted.unshift(...(above[index]!.files ?? []));
    }
    const seen = new Set(own.map((file) => file.id).filter((id) => id !== undefined));
    const added = posted.filter((file) => file.id === undefined || !seen.has(file.id)).slice(-TAGGED_FILES_LIMIT);
    return [...added, ...own];
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
      // A person's id (U…, or W… on Enterprise Grid) is not a conversation,
      // so Slack answers channel_not_found for it too (card 1201). Said
      // plainly, because the fix is not another id or scope: the adapter
      // never opens a DM itself.
      if (slackErrorCode(error) === 'channel_not_found' && SLACK_USER_ID.test(to)) {
        throw new Error(
          `slack: ${to} is a person's Slack user id, not a conversation. ${address.agentId}'s app writes to a person only in a direct message `
          + 'they already have with it, named by its conversation id (D…), and never opens one itself. '
          + 'Use that D… id, or post in a channel the app is in.',
        );
      }
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
    /**
     * Slack posts a reply to a thread it has no message for at the top
     * level and answers `ok` (card 1019: a made-up thread id put an agent's
     * mid-task line at the top of a channel). The first chunk shows it: that
     * one is taken back, the rest is never sent, and the refusal says what
     * is left in Slack. A reply whose answer leaves `message` out says
     * nothing about where it went, so it is trusted, as before.
     */
    const refuseMisplaced = async (postedChannel: string, ts: string | undefined): Promise<never> => {
      const missing = `slack: ${channelId} has no thread ${thread}`;
      const fix = 'Name a thread by the id of its first message, or post at the top level instead.';
      if (!ts) {
        throw new Error(`${missing}, and Slack posted the message at the top level instead without saying its id. ${fix}`);
      }
      try {
        await web.chat.delete({ channel: postedChannel, ts });
      } catch (error) {
        throw new Error(
          `${missing}. Slack posted the message at the top level (${ts}) instead, and taking it back failed `
          + `(${error instanceof Error ? error.message : String(error)}). ${fix}`,
        );
      }
      throw new Error(`${missing}, so nothing was posted. ${fix}`);
    };
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
            // A part that tags another agent carries the whole text (card 1033).
            const whole = chunks.length > 1 && await tagsAnAgent(connection, chunk) ? text : undefined;
            const posted = await postPart(web, { channel: channelId, thread, text: chunk, whole }, warn);
            if (thread && sent === 0 && posted.message !== undefined && !posted.message.thread_ts) {
              await refuseMisplaced(posted.channel ?? channelId, posted.ts ?? posted.message.ts);
            }
            sent += 1;
            if (!first) {
              first = { channel: posted.channel ?? channelId, ts: posted.ts ?? '' };
            }
          }
        } finally {
          accepted(sent === chunks.length ? text : sent > 0 ? chunks.slice(0, sent).join('\n') : undefined);
          if (thread && sent > 0) {
            // The post took down the status of any turn of this app's
            // working in that thread; the turn at each session's head puts
            // its own back.
            for (const queue of renderers.values()) {
              queue[0]?.appPosted(web, channelId, thread);
            }
          }
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

  // `carried` is read late: a reload replaces it.
  const {
    conversationKindFor,
    sessionConversation,
    readConversation,
    createConversation,
    joinConversation,
    inviteToConversation,
    archiveConversation,
  } = createConversations({
    log,
    warn,
    fetchFile,
    fileDownloadTimeoutMs,
    getCarried: () => carried,
    configuredAgents,
    displayNames,
    botIdentities,
    displayNameFor,
    boundedDisplayName,
    nameableMentions,
    plainSlackText,
    connectionFor,
  });

  // `gatewayRef` is read late: `start` sets it after the adapter is built.
  const { renderApprovalRequest, retireOrphanedPrompt, retractApprovalRequest } = createApprovalPrompts({
    warn,
    configuredAgents,
    approvalPosts,
    rendering,
    resolvedWhileRendering,
    getGateway: () => gatewayRef,
    connectionFor,
  });

  // `gatewayRef` is read late: `start` sets it and `stop` clears it.
  const { takeUnrenderedFiles, reportUnrenderedFailure, reportUnrenderedReply } = createUnrenderedOutcomes({
    log,
    warn,
    unrenderedFiles,
    getGateway: () => gatewayRef,
    tagsAnAgent,
    connectionFor,
    overhearReply,
    slackStopper,
  });

  // `gatewayRef` is read late: `start` sets it after the adapter is built.
  const { requestCredential, settleCredentialPost, handleInteractive } = createInteractions({
    warn,
    configuredAgents,
    renderers,
    approvalPosts,
    credentialsPosting,
    credentialPosts,
    rendering,
    getGateway: () => gatewayRef,
    track,
    connectionFor,
    retireOrphanedPrompt,
  });

  // `liveFrom` and `gatewayRef` are read late: `start` sets them after the
  // adapter is built. `answersAgentMention` and `teamAgentFor` are defined
  // below, so they are passed as arrows that call them.
  const {
    threadKeyFor,
    rememberAddressee,
    stopHolderAt,
    holderAt,
    ownerAt,
    threadOwner,
    noteThreadStart,
    isFleetBot,
    noteForeignSpeaker,
    agentNamedIn,
    followUpWinner,
  } = createThreadTracking({
    warn,
    connections,
    configuredAgents,
    threadAddressee,
    threadTrimmedUntil,
    threadReadUntil,
    getLiveFrom: () => liveFrom,
    threadOrigins,
    coldVerdicts,
    botIdentities,
    getGateway: () => gatewayRef,
    agentConfigFor,
    homeOwners,
    listensOf,
    teamAgentFor: (config, agentTeam, team, botUser) => teamAgentFor(config, agentTeam, team, botUser),
    answersAgentMention: (agentId, team, botUser) => answersAgentMention(agentId, team, botUser),
    THREAD_ADDRESSEE_CAPACITY,
    compareSlackTs,
    HUMAN_MESSAGE_SUBTYPES,
    mentions,
    EARLIER_THREAD_PAGES,
  });

  // `gatewayRef` is read late: `start` sets it after the adapter is built.
  const { stopTurns, teamAgentFor, answersAgentMention, admit } = createAdmitter({
    log,
    renderers,
    intakeInFlight,
    stopsBySession,
    rememberSenderAddressee,
    senderAddresseeAt,
    replyTargetAt,
    botIdentities,
    getGateway: () => gatewayRef,
    track,
    alreadySeen,
    agentConfigFor,
    homeOwners,
    listensOf,
    SLACK_STOP_REASON,
    mentions,
    AGENT_MENTION_HOP_LIMIT,
    THREAD_ADDRESSEE_CAPACITY,
    isPersonSpeaking,
    compareSlackTs,
    isStopRequest,
    threadKeyFor,
    rememberAddressee,
    stopHolderAt,
    holderAt,
    noteThreadStart,
    noteForeignSpeaker,
    agentNamedIn,
    followUpWinner,
  });

  // `gatewayRef` is read late: `start` sets it after the adapter is built.
  const { handleInbound } = createInbound({
    options,
    log,
    warn,
    editIntervalMs,
    fetchFile,
    fileDownloadTimeoutMs,
    now,
    renderers,
    replyOrder,
    intakeInFlight,
    stopsBySession,
    getGateway: () => gatewayRef,
    track,
    pendingKey,
    replaying,
    noteReplayOutcome,
    noteReplayAnsweredAhead,
    keepForNextStart,
    tagsAnAgent,
    authorFor,
    earlierContext,
    withFilesJustAbove,
    roomFor,
    humanizeMentions,
    onIntakeChain,
    overhearReply,
    isStopRequest,
    SLACK_STOP_REASON,
    RESTARTING_REPLY_TEXT,
    STOPPING_REPLY_TEXT,
    rememberAddressee,
    threadOwner,
    followUpWinner,
    stopTurns,
    admit,
  });

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
        reactionWarned: { value: false },
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
    // A `message.say` line goes to the turn running for that session, in
    // its thread, through the same agent's app, or nowhere (card 1009).
    // Running means the gateway's active turn, matched by id as for a
    // credential form: the head of the queue can be a newer message's turn
    // still waiting behind a recovery, which did not come from it.
    say: async ({ sessionId, agentId, text }: { sessionId: string; agentId: string; text: string }): Promise<void> => {
      const connection = connectionFor(agentId);
      const active = gatewayRef?.activeTurnId?.(sessionId);
      const renderer = active === undefined
        ? undefined
        : (renderers.get(sessionId) ?? []).find((candidate) => candidate.turnId === active);
      if (!connection || !renderer || !renderer.postsAs(connection.web)) {
        throw new Error('This conversation has no turn of yours running in Slack right now, so there is nothing to send into. Say it in your reply.');
      }
      await renderer.say(text);
    },
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
          // A tool's post (AGT-324) waits with them, in the order the turn made them.
          const post = postOf(event.result);
          const produced: Array<string | ToolPost> = [...collectFilePaths(event.result), ...(post !== undefined ? [post] : [])];
          if (produced.length > 0) {
            const held = [...(unrenderedFiles.get(event.sessionId) ?? []), ...produced];
            // Said out loud when it bites: these are files somebody asked
            // for, and attachments that never arrive with nothing in the
            // log is the hardest kind of loss to work out afterwards.
            if (held.length > MAX_UNRENDERED_FILES) {
              warn(`slack: a turn with no renderer has produced ${held.length} files and posts; only the last ${MAX_UNRENDERED_FILES} will be posted to its thread`);
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

// Inbound file fetching, in its own module (see the top of files.ts).
export {
  createSlackFileFetcher,
  type SlackFileDownload,
  type SlackFileFetcher,
  type SlackInboundFile,
} from './files.ts';
