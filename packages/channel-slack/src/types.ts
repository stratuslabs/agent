/*
 * The adapter's public contract: how an agent's Slack app is configured
 * (`SlackAgentConfig`), what `createSlackChannelAdapter` takes
 * (`SlackAdapterOptions`), and the thin surfaces of the Slack SDKs it
 * touches (`SlackSocketLike`, `SlackWebLike` and the shapes they use). Types
 * only, moved out of `index.ts` as is; `index.ts` re-exports them, so the
 * package's surface is unchanged.
 */
import type { AdmitPolicy, AgentWorkspaces, TrustLevel } from '@stratusagent/core';

import type { SlackFileFetcher, SlackInboundFile } from './files.ts';

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
   * approval, and it answers at most `AGENT_MENTION_HOP_LIMIT` agent
   * mentions per thread in any 30 minutes, unless a person it admits
   * speaks there in between.
   */
  agentMentions?: { team?: Record<string, string>; only?: string[] };
}

// The thin surfaces of the Slack SDKs the adapter touches — injectable so
// tests run against fakes with no network. The real factories in index.ts wrap
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
   * claim in a thread is seen live, and that times how long an answered
   * agent mention counts toward the hop limit. Defaults to `Date.now`.
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
