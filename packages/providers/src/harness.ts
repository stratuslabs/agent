import {
  transcriptOf,
  renderToolResultContent,
  type ExecutionContext,
  type ImageAttachment,
  type Message,
  type ProviderRequest,
  type Session,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
  OVERHEARD_IMAGES_NOTE,
  messagesAfterOverheard,
  promptTextOf,
} from '@stratusagent/core';

// ---------------------------------------------------------------------------
// Hosted-loop provider helpers
//
// Shared by every provider that wraps a harness owning its own agent loop
// (`provider-claude-code`, `provider-codex`). These used to live in
// `provider-claude-code`; they moved here when a second harness provider
// needed the same rules, because a second hand-rolled copy of any of them
// drifts from the first. `provider-claude-code` re-exports them, so the
// documented import paths still work.
// ---------------------------------------------------------------------------

/** The codex CLI's own current default model. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

/**
 * Where a session records the Claude Code SDK session it is continuing.
 *
 * The pairing is the whole point of resuming: the kernel's session id is
 * ours and durable, the SDK's is its own and lives beside its transcript
 * under `~/.claude/projects`. Storing the link in session metadata means
 * it survives tool execution, approval waits, and a daemon restart, and
 * is garbage-collected with the session — the same treatment the
 * Anthropic provider gives its raw turns, for the same reasons.
 *
 * This and the two keys below live here, not in the harness packages that
 * write them, because the host has to name them (to keep them off a fresh
 * transcript) whether or not that harness is installed.
 */
export const SDK_SESSION_METADATA_KEY = 'claudeCodeSessionId';

/**
 * Which sign-in the stored SDK session was made under, as a fingerprint.
 *
 * An SDK session is resumed only under the sign-in that made it. Two
 * agents can run on two subscriptions in one daemon, and a token can be
 * replaced or removed while a conversation is open; resuming across that
 * change would carry one account's harness session into another's. A
 * mismatch starts a fresh SDK session and replays the kernel's history
 * into it, the same recovery a lost transcript gets.
 *
 * A one-way hash, truncated, with a fixed prefix, so the session store
 * never holds anything a token could be recovered from. A session stored
 * before this key existed has none. On the shared sign-in it resumes as it
 * always did, because the upgrade itself must not cost every open
 * conversation a replay. Under an agent's own sign-in it does not: nothing
 * says which account made it, and that agent's sign-in is the one case
 * where it matters.
 */
export const SDK_SESSION_AUTH_METADATA_KEY = 'claudeCodeAuth';

/**
 * Where a session records the codex thread it is continuing.
 *
 * The kernel's session id is ours and durable; the thread id is codex's
 * and lives beside its transcript under `~/.codex/sessions`. Storing the
 * link in session metadata means it survives tool execution, approval
 * waits, and a daemon restart, and is garbage-collected with the session —
 * the same treatment the Claude Code provider gives its SDK session id.
 */
export const CODEX_THREAD_METADATA_KEY = 'codexThreadId';

/**
 * The harness transports (the Agent SDK's `query`, codex's `runTurn`) as a
 * host carries them through config and environment without importing a
 * harness package that may not be installed.
 *
 * Function properties, so their params are checked contravariantly: a
 * callback is accepted only if it takes every params object a harness can
 * pass. The params are therefore a lower bound of the harness's own: the
 * fields a host can read keep their real types, and the harness-specific
 * ones a host has no business reading (SDK options, codex client and
 * thread options, an image prompt's message type) are `never`, which every
 * harness type accepts. So the harness's own transport type is assignable,
 * while a callback that needs `prompt` to be a string or `resumeThreadId`
 * to be present is rejected. The harness package is the only caller and
 * casts to its full signature.
 */
export type ClaudeCodeTransport = (params: {
  /** A string, or an image turn's single user message (opaque here). */
  prompt: string | AsyncIterable<never>;
  options?: never;
}) => AsyncIterable<unknown>;

/** Codex's `runTurn`, as a host carries it. See ClaudeCodeTransport. */
export type CodexTransport = (params: {
  input: string;
  /** Absent on a thread's first turn. */
  resumeThreadId?: string;
  clientOptions: never;
  threadOptions: never;
  signal: AbortSignal;
}) => AsyncIterable<unknown>;

/**
 * Executes one kernel tool call on behalf of a provider-hosted loop. The
 * host owns approvals, events, allowlists, and the executor —
 * AgentRunner.executeHostedToolCall is the canonical implementation.
 */
export type HostedToolExecutor = (
  session: Session,
  call: ToolCall,
  context?: ExecutionContext,
) => Promise<ToolResult>;

const HOSTED_SIDE_EFFECTS = Symbol.for('stratus.hostedToolSideEffects');

/** Marks an error as coming from a turn that had already executed kernel tools. */
export const markHostedToolSideEffects = <T>(error: T): T => {
  if (typeof error === 'object' && error !== null) {
    (error as Record<PropertyKey, unknown>)[HOSTED_SIDE_EFFECTS] = true;
  }
  return error;
};

/**
 * True when this error aborted a turn that had already executed kernel
 * tools. Retrying such a request on another provider would repeat those
 * side effects (a fact remembered twice, a command run twice), so
 * fallback wrappers must rethrow instead of failing over.
 */
export const hasHostedToolSideEffects = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as Record<PropertyKey, unknown>)[HOSTED_SIDE_EFFECTS] === true;

// MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$, so kernel names like
// "demo.echo" are flattened; the original name travels with the caller.
const sanitizeMcpToolName = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'tool';
};

/**
 * The MCP name each kernel tool is bridged under, keyed by the kernel's
 * own dotted name.
 *
 * Exported because the mapping is needed in two directions and must not be
 * derived twice: a bridge registers tools under these names, and streamed
 * deltas arrive carrying them and have to be reported back to the kernel in
 * its own naming. A second copy of the dedup rule would drift the first
 * time two tools sanitize alike.
 */
export const bridgedToolNames = (descriptors: readonly ToolDescriptor[]): Map<string, string> => {
  const used = new Set<string>();
  const byKernelName = new Map<string, string>();
  for (const descriptor of descriptors) {
    const base = sanitizeMcpToolName(descriptor.name);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) {
      name = `${base.slice(0, 60)}_${suffix}`;
    }
    used.add(name);
    byKernelName.set(descriptor.name, name);
  }
  return byKernelName;
};

/**
 * A session rendered as one prompt string for a harness that takes a single
 * prompt per run: the whole conversation, latest user message last. Used
 * when a harness session is fresh (or its stored session could not be
 * resumed) and knows nothing yet.
 */
/**
 * What a text-only runtime is told about the images on a user message. The
 * harness providers hand their SDK one prompt string, so the image itself
 * cannot travel; naming it is what lets the model say it cannot see the
 * screenshot rather than describe one it was never shown.
 */
export const describeImageAttachments = (images: readonly ImageAttachment[] | undefined): string => {
  if (images === undefined || images.length === 0) {
    return '';
  }
  const names = images.map((image) => image.name ?? `a ${image.mediaType} image`);
  return `\n[Attached: ${names.join(', ')}. This runtime cannot see images — say so rather than guessing at them.]`;
};

/**
 * A user message's text as a prompt carries it, with its images named after
 * it. `latest` marks the newest user message of the turn — the one an
 * unaddressed turn's note follows — and `afterOverheard` one said to the
 * agent after an overheard message in its run; see `PromptTextOptions`. An overheard
 * message whose images travel beside the text ends on
 * `OVERHEARD_IMAGES_NOTE`, the label those images follow (card 625).
 */
export const userMessageText = (
  message: Pick<Message, 'content' | 'overheard' | 'images'>,
  latest = false,
  imagesTravel = false,
  afterOverheard = false,
): string => {
  const text = `${promptTextOf(message, { latest, afterOverheard })}${describeImageAttachments(imagesTravel ? message.images?.filter((image) => !travels(image)) : message.images)}`;
  const labeled = imagesTravel && message.overheard === true && (message.images ?? []).some(travels);
  return labeled ? `${text}\n\n${OVERHEARD_IMAGES_NOTE}` : text;
};

/** Whether an image still has its bytes to send; one past the replay window is a name only. */
const travels = (image: ImageAttachment): boolean => image.omitted !== true && image.data.length > 0;

/**
 * For a harness that can take images beside its prompt text: whether the
 * newest user message's images are sent that way, and so are left out of
 * the text note that would otherwise say they cannot be seen.
 */
export interface PromptImageOptions {
  inlineImages?: boolean;
}

/**
 * The newest user message's images that still have their bytes: what a
 * harness able to take images sends beside the prompt text rendered with
 * `inlineImages`. Only the newest message's — a transcript replayed as text
 * names older images, as it always has.
 */
export const promptImagesOf = (request: ProviderRequest): ImageAttachment[] =>
  (latestUserMessageOf(transcriptOf(request))?.images ?? []).filter(travels);

/** The newest user message — the one the turn being run ends on. */
export const latestUserMessageOf = (messages: readonly Message[]): Message | undefined =>
  messages.findLast((message) => message.role === 'user');

export const renderTranscriptPrompt = (request: ProviderRequest, options: PromptImageOptions = {}): string => {
  const conversational = transcriptOf(request).filter(
    (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
  );

  const latest = latestUserMessageOf(conversational);
  const afterOverheard = messagesAfterOverheard(conversational);
  const inline = options.inlineImages === true;
  if (conversational.length === 1 && conversational[0]?.role === 'user') {
    return userMessageText(conversational[0], true, inline);
  }

  const lines: string[] = ['Conversation so far:'];
  for (const message of conversational) {
    if (message.role === 'tool') {
      // The result as every other path renders it, not the runner's stored
      // `content` — that is the whole record, label as a bare field, and a
      // session moved onto a harness would replay a fetched page unmarked.
      const content = message.toolResult !== undefined ? renderToolResultContent(message.toolResult) : message.content;
      // A flattened replay carries no pixels, and a result that says
      // `shown: true` must not read as if this run had seen the image.
      const images = message.images ?? [];
      const names = images.map((image) => image.name ?? `a ${image.mediaType} image`).join(', ');
      const note = images.length > 0
        ? ` [This call returned ${images.length === 1 ? 'an image' : `${images.length} images`} (${names}) that this replay cannot show you; say so rather than guessing at ${images.length === 1 ? 'it' : 'them'}.]`
        : '';
      lines.push(`[tool ${message.name ?? 'result'}] ${content}${note}`);
      continue;
    }
    // A tool call is part of the assistant's turn: without it, the next
    // run would see a result with no record of what was asked (e.g. a
    // memory id but not the remembered fact) and reason over half the
    // history. Its runner message carries empty content, so skip that.
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        lines.push(`[assistant called tool ${call.toolName}] ${JSON.stringify(call.input)}`);
      }
    }
    if (message.role === 'assistant' && message.content.length === 0) {
      // Either the tool-call message above, or the silence a turn nobody
      // asked for ends in — neither is a line the model should read.
      continue;
    }
    lines.push(`[${message.role}] ${message.role === 'user' ? userMessageText(message, message === latest, inline && message === latest, afterOverheard.has(message)) : message.content}`);
  }
  // A turn nobody asked for ends on an overheard message carrying its own
  // instruction, and "reply to the latest user message" would countermand
  // it in the next line. So does a reply-optional one (card 601).
  if (latest?.overheard !== true && latest?.replyOptional !== true) {
    lines.push('', 'Continue the conversation by replying to the latest user message.');
  }
  return lines.join('\n');
};

/**
 * What a resumed harness session has not heard yet: every message
 * overheard since the agent last spoke, then the newest user message. The
 * harness holds everything before its own last reply, and until `observe`
 * that was always exactly one message — but a message overheard between
 * turns is appended with no turn run on it, so by the next turn there can
 * be several, and sending only the newest would leave the model answering
 * with the thread's middle missing on precisely the path that cannot
 * rebuild its history.
 *
 * Selected by the mark, not by position. "Every user message since the
 * last assistant" reads the same in the common case and differs after a
 * turn the harness accepted and then failed: no reply was appended, so
 * that turn's message is still ahead of the last assistant, and scanning
 * back would send it to a harness that already has it. An overheard
 * message is one the harness has never seen, by construction; an
 * addressed one before the newest was some turn's prompt.
 *
 * One addressed message with nothing overheard before it renders bare, as
 * it always did; a reply-optional one carries its note (card 601). Falls
 * back to the full transcript when there is no user message to isolate, so
 * a caller can never end up sending nothing.
 */
export const latestUserMessagePrompt = (request: ProviderRequest, options: PromptImageOptions = {}): string => {
  const messages = transcriptOf(request);
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role !== 'assistant') {
    start -= 1;
  }
  const since = messages.slice(start).filter((message) => message.role === 'user');
  const newest = since.at(-1);
  if (!newest) {
    return renderTranscriptPrompt(request, options);
  }
  const unheard = since.filter((message) => message.overheard === true || message === newest);
  const inline = options.inlineImages === true;
  // One string, so the overheard frames and the message said to the agent
  // reach the model as one turn: that message is marked (card 1034). The
  // mark follows the whole transcript, not just what is sent: a silent
  // turn's empty reply ends what the harness is sent but not the run, as
  // on every other path.
  const afterOverheard = messagesAfterOverheard(messages);
  return unheard.map((message) => userMessageText(message, message === newest, inline && message === newest, afterOverheard.has(message))).join('\n');
};
