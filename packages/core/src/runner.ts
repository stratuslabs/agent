/*
 * The agent runner: what a run is given, the errors it ends with, how it is
 * stopped, and `AgentRunner` itself, which drives a session through its
 * provider turns, tool calls, approvals and trust, plus the helpers only it
 * uses. A module of its own because it is the loop every surface runs
 * through. `index.ts` re-exports every public name, so the package's one
 * public entry is unchanged.
 */
import {
  clippedTo,
  CONTEXT_SUMMARY_MAX_CHARS,
  contextSummaryRequest,
  nextContextFloor,
  nextTurnBoundary,
} from './context.ts';
import {
  definedTokenCounts,
} from './providers.ts';
import {
  startsTurn,
} from './turns.ts';
import {
  type AgentDefinition,
  type AgentMemoryStore,
  AgentRegistry,
  type AgentRuntimeContext,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ApprovalRefusal,
  type ApprovalVerdict,
  buildMemoryInjection,
  carriesKey,
  completeAnsweredTurn,
  CONTEXT_FLOOR_METADATA_KEY,
  CONTEXT_SUMMARY_METADATA_KEY,
  contextFloorOf,
  ContextOverflowError,
  type ContextSummary,
  contextSummaryOf,
  createImageCollector,
  createSkillReadTool,
  DefaultExecutor,
  emptyMemoryInjection,
  EventBus,
  type ExecutionContext,
  type Executor,
  HostRefusalError,
  type ImageAttachment,
  type ImageReplayBudget,
  InMemorySessionStore,
  isReplyOptionalTurn,
  isStoppedEarlyReason,
  isTaintedTrust,
  isTrustLevel,
  isUnaddressedTurn,
  type JsonObject,
  type JsonValue,
  lastResponseIsAnswer,
  leastTrusted,
  lowerSessionTrust,
  matchesSkillAllowlist,
  matchesToolAllowlist,
  memoryEntryTrust,
  memoryInjectionEntries,
  type Message,
  messagesWithinContextFloor,
  type ModelProvider,
  noReplyAnswerOf,
  omitImagesOutsideReplayBudget,
  originOf,
  PENDING_APPROVAL_METADATA_KEY,
  type PendingApprovalRecord,
  PluginRegistry,
  promptWasDelivered,
  type ProviderCallGuard,
  type ProviderCallUsage,
  type ProviderDelta,
  type ProviderResponse,
  readPendingApproval,
  recordTurnFailure,
  resolveCallRisk,
  resolveToolRisk,
  RunAbortedError,
  SENDER_TRUST_METADATA_KEY,
  senderTrustOf,
  type Session,
  SESSION_TAINTED_BY_METADATA_KEY,
  SESSION_TRUST_METADATA_KEY,
  type SessionStore,
  sessionTrustOf,
  sessionWriteTrust,
  SKILL_READ_TOOL_NAME,
  type SkillDescriptor,
  type SkillRegistry,
  type StratusEvent,
  type Tool,
  type ToolCall,
  ToolRegistry,
  type ToolResult,
  type ToolRisk,
  type TrustLevel,
  TURN_LIMIT_NOTE,
  turnKeyOf,
  turnMessageOf,
  type UnlistedTools,
  type UsageRecord,
} from './index.ts';

/**
 * Where a tool's call would act for this session, in `originOf` form, or
 * nothing when the tool does not answer that. Normalized rather than taken
 * as written, so every comparison of an origin in this codebase is of the
 * same thing.
 */
const originForSession = (
  tool: Pick<Tool, 'originFor'>,
  session: Session,
  input: JsonObject,
): string | undefined => {
  const reported = tool.originFor?.(session, input);
  return reported === undefined ? undefined : originOf(reported);
};

const APPROVAL_VERDICTS: readonly ApprovalVerdict[] = ['allow', 'ask', 'block'];

/**
 * The `permission.decided` event for one reported decision, built field by
 * field from `ApprovalDecision` and the call's id and name. Never spread
 * from what the policy handed over: a policy that passed its whole
 * decision record along (a command, a grant, the call itself) would put
 * the call's input on the bus.
 */
const permissionDecidedEvent = (
  session: Session,
  call: ToolCall,
  risk: ToolRisk,
  decision: ApprovalDecision,
): StratusEvent => ({
  type: 'permission.decided',
  sessionId: session.id,
  agentId: session.agent.id,
  callId: call.id,
  toolName: call.toolName,
  risk,
  allowed: decision.allowed === true,
  layer: typeof decision.layer === 'string' ? decision.layer : '',
  reason: typeof decision.reason === 'string' ? decision.reason : '',
  ...(APPROVAL_VERDICTS.includes(decision.verdict as ApprovalVerdict) ? { verdict: decision.verdict } : {}),
  ...(typeof decision.reviewCode === 'string' ? { reviewCode: decision.reviewCode } : {}),
  ...(decision.shadow === true ? { shadow: true } : {}),
});

/**
 * The reason a policy gave for refusing, or nothing when it gave none: a
 * plain `false`, a blank reason, or an answer of some other shape, which
 * keep the generic refusal.
 */
const refusalReasonOf = (answer: unknown): string | undefined => {
  if (typeof answer !== 'object' || answer === null) {
    return undefined;
  }
  const reason = (answer as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : undefined;
};

/** The longest a tool's `trustBeforeCall` may take before the call is judged as reading `external`. */
export const TRUST_BEFORE_CALL_TIMEOUT_MS = 2_000;

/**
 * A tool's `trustBeforeCall` answer, bounded. A throw, a rejection, a label
 * nobody recognises or no answer in time reads `external`: the call is then
 * about to read something nobody can vouch for, and judging it as such is
 * the safe direction. Nothing, for a tool that answers nothing.
 */
const trustBeforeCallOf = async (tool: Pick<Tool, 'trustBeforeCall'>, session: Session): Promise<TrustLevel | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const label = await Promise.race([
      Promise.resolve().then(() => tool.trustBeforeCall?.(session)),
      new Promise<never>((_, reject) => {
        // Not unref'd: cleared below either way, and an unref'd bound lets a
        // process with nothing else running exit mid-turn.
        timer = setTimeout(() => reject(new Error('trustBeforeCall timed out')), TRUST_BEFORE_CALL_TIMEOUT_MS);
      }),
    ]);
    if (label === undefined) {
      return undefined;
    }
    return isTrustLevel(label) ? label : 'external';
  } catch {
    return 'external';
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The transcript message for a tool result: its images moved off the
 * result onto the message, where the replay budget and the trim already
 * look, so the stored content and the result stay text.
 */
const toolResultMessage = (session: Session, result: ToolResult): Message => {
  const { images, ...stored } = result;
  return {
    id: `${session.id}:tool:${result.callId}`,
    role: 'tool',
    name: result.toolName,
    content: JSON.stringify(stored),
    createdAt: new Date().toISOString(),
    toolResult: stored,
    ...(images !== undefined && images.length > 0 ? { images } : {}),
  };
};

/** A result as the bus carries it: never the image bytes. */
const withoutImages = (result: ToolResult): ToolResult => {
  if (result.images === undefined) {
    return result;
  }
  const { images: _images, ...rest } = result;
  return rest;
};

/** The wrap-up note as a message, for the request's window only. */
const turnLimitNoteFor = (session: Session): Message => ({
  id: `${session.id}:turn-limit`,
  role: 'user',
  content: TURN_LIMIT_NOTE,
  createdAt: new Date().toISOString(),
});

/**
 * What a turn that could not wrap up fails with. Names the setting because
 * the person reading it is the one who can raise it, and "exceeded the
 * maximum" alone left them to find it in the docs.
 */
const turnLimitMessage = (maxTurns: number): string =>
  `Session exceeded the maximum of ${maxTurns} provider turns. `
  + 'Raise maxTurns in ~/.stratus/config.json for agents that do long multi-step work, or reply to carry on from here.';

/**
 * How many turns in a row may fail the same way before the runner stops
 * the message. Three: once is an error, twice is a retry that might have
 * been worth trying, and a third identical failure is a loop.
 */
const REPEATED_FAILURE_LIMIT = 3;

/** A value as JSON with its object keys sorted, so equal inputs compare equal. */
const sortedJson = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => (
  inner !== null && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : inner
));

/**
 * What a turn's tool calls had in common when every one of them failed, or
 * `undefined` when any succeeded (or there were none).
 *
 * Tool, input, and error together: the same call failing differently is
 * the agent learning something, and a different call failing the same way
 * is it trying something else. A refused approval counts — a gated call
 * refused in headless mode and then made again is the commonest loop of
 * all, and asking again after a person said no is no better.
 */
const failureSignature = (calls: ToolCall[], results: ToolResult[]): string | undefined => {
  if (results.length === 0 || results.some((result) => result.ok)) {
    return undefined;
  }
  return sortedJson(results.map((result) => {
    const call = calls.find((candidate) => candidate.id === result.callId);
    return [result.toolName, call?.input ?? null, result.error ?? null];
  }));
};

/**
 * The provider responses of the current message, oldest first, through the
 * one a recorded tool call belongs to: each as every call in it and every
 * result recorded for them.
 *
 * A response is saved as one contiguous run of assistant messages before
 * any of its calls runs, so the run around the call's own message is the
 * response. Found from the end and by the whole call, not its id alone:
 * ids repeat across turns when a provider omits them.
 *
 * The ones before it are what a restart forgets. A message that failed the
 * same way twice before the process died and once more on the recovered
 * turn has failed three times, and counting from the recovery alone let it
 * fail twice more. Walked back through runs of tool results and the
 * responses they answer, past any message steered in between them
 * (`Message.steered`), which shares the run's budget, and no further than
 * the first message that is none of those: the person's own message,
 * which is where this run began.
 */
const responsesThroughCall = (
  session: Session,
  call: ToolCall,
): Array<{ calls: ToolCall[]; results: ToolResult[] }> => {
  const messages = session.messages;
  const same = (candidate: ToolCall | undefined): boolean =>
    candidate !== undefined
    && candidate.id === call.id
    && candidate.toolName === call.toolName
    && sortedJson(candidate.input) === sortedJson(call.input);
  let at = messages.length - 1;
  while (at >= 0 && !(messages[at]!.role === 'assistant' && (messages[at]!.toolCalls ?? []).some(same))) {
    at -= 1;
  }
  if (at < 0) {
    return [{ calls: [call], results: [] }];
  }
  const runStart = (index: number): number => {
    let start = index;
    while (start > 0 && messages[start - 1]!.role === 'assistant') {
      start -= 1;
    }
    return start;
  };
  // [start, end] of the run, and the index past the results that answer it.
  const responseAt = (start: number, end: number, resultsEnd: number) => {
    const calls = messages.slice(start, end + 1).flatMap((message) => message.toolCalls ?? []);
    const answering = messages.slice(end + 1, resultsEnd);
    const results: ToolResult[] = [];
    for (const recorded of calls) {
      const result = answering.find((message) => message.toolResult?.callId === recorded.id)?.toolResult;
      if (result) {
        results.push(result);
      }
    }
    return { calls, results };
  };
  let start = runStart(at);
  let end = at;
  while (end + 1 < messages.length && messages[end + 1]!.role === 'assistant') {
    end += 1;
  }
  const responses = [responseAt(start, end, messages.length)];
  for (;;) {
    // A message steered in between two responses joined this run rather
    // than starting one, so the walk goes on past it.
    let resultsEnd = start;
    while (resultsEnd > 0 && messages[resultsEnd - 1]!.role === 'user' && messages[resultsEnd - 1]!.steered === true) {
      resultsEnd -= 1;
    }
    let resultsStart = resultsEnd;
    while (resultsStart > 0 && messages[resultsStart - 1]!.role === 'tool') {
      resultsStart -= 1;
    }
    if (resultsStart === resultsEnd || resultsStart === 0 || messages[resultsStart - 1]!.role !== 'assistant') {
      break;
    }
    end = resultsStart - 1;
    start = runStart(end);
    responses.unshift(responseAt(start, end, resultsEnd));
  }
  return responses;
};

/**
 * What the last turn of a message is told when it was stopped for making
 * the same failing call over and over (#208), in place of `TURN_LIMIT_NOTE`.
 *
 * The turn limit was the only thing that ended such a loop, and at 40 turns
 * that is 40 paid requests repeating one error — a shell `cwd` that does
 * not exist, a gated tool refused in headless mode. The wrap-up is the
 * same one the limit uses, so the person hears what is stuck rather than
 * an error, and the session keeps everything that happened.
 */
const repeatedFailureNoteFor = (session: Session, toolName: string, times: number): Message => ({
  id: `${session.id}:repeated-failure`,
  role: 'user',
  content: `You have called ${toolName} ${times} times in a row with the same input, and it failed the same way each time. `
    + 'Do not call it again on this message. Reply now, in words: say what you were trying to do, what keeps failing, '
    + 'and what you would need to get past it.',
  createdAt: new Date().toISOString(),
});

/** What a turn stopped for repeating itself fails with, when it calls a tool even then. */
const repeatedFailureMessage = (toolName: string, times: number): string =>
  `The agent called ${toolName} ${times} times in a row with the same input and the same error, so this message was stopped. `
  + 'Reply to carry on from here once whatever it needed is in place.';

/**
 * Runs every call without asking. Never a default: an app that wants every
 * gated and dangerous call to run unasked passes this as `approvals`, so
 * the choice is written down where the runner is built.
 */
export class AllowAllApprovalPolicy implements ApprovalPolicy {
  async approve(): Promise<boolean> {
    return true;
  }
}

/**
 * What a runner built without `approvals` decides: a `safe` call runs and
 * anything above it is refused. This used to be `AllowAllApprovalPolicy`,
 * so an app embedding the runner that never thought about approvals ran
 * every shell command and file write its model asked for (card 966).
 */
const SAFE_ONLY_APPROVALS: ApprovalPolicy = {
  approve: async ({ risk }) => risk === 'safe',
};

/**
 * The `images` field of a user message, or nothing: a message that carried
 * none has no field, so a transcript written before images existed and one
 * written after read the same.
 */
const userImages = (images: ImageAttachment[] | undefined): Pick<Message, 'images'> =>
  images !== undefined && images.length > 0 ? { images } : {};

export interface RunInput {
  sessionId: string;
  /** See Session.agent: the allowlist travels with the run. */
  agent: AgentDefinition;
  userMessage: string;
  /** Images sent with the message; see `Message.images`. */
  images?: ImageAttachment[];
  /**
   * Whether the message was said TO the agent. Omitted or true, the turn
   * is one somebody asked for, as every turn was before overhearing.
   * `false` runs a turn on something said to somebody else: the message
   * is stored `overheard`, rendered as third-party speech, and the model
   * is told (`UNADDRESSED_TURN_NOTE`) that it may answer with nothing — an
   * empty reply is then a decision, not a failure, and the turn completes
   * with an empty assistant message: no text for a surface to post, and a
   * boundary so the message is never judged twice. Such a turn may carry
   * images: they are stored on the overheard message, and every provider
   * renders them after its framed text, behind `OVERHEARD_IMAGES_NOTE`,
   * never ahead of the frame that marks them as somebody else's.
   */
  addressed?: boolean;
  /**
   * Said to the agent, but possibly needing no answer (card 601): the
   * message is stored `replyOptional`, followed by `REPLY_OPTIONAL_NOTE`,
   * and the turn may end with nothing — an empty answer, or exactly
   * `NO_REPLY_MARKER` — which completes it with an empty assistant
   * message, as an unaddressed turn's silence does. Ignored with
   * `addressed: false`, whose frame already says so. Who sets it is the
   * channel's call: a direct mention or a DM should never.
   */
  replyOptional?: boolean;
  /**
   * The caller's name for this dispatch, stored on the user message
   * (`Message.idempotencyKey`) in the same write as the message itself.
   * The runner only records it; refusing a repeat is the host's job — see
   * `workItemState` and the gateway's `DispatchInput.idempotencyKey`.
   */
  idempotencyKey?: string;
  /** Keys of dispatches folded into this turn; see `Message.absorbedKeys`. */
  absorbedKeys?: string[];
  /**
   * Whether this turn may run on a provider that hosts its own tool loop,
   * stored on the user message (`Message.hostedLoop`). The host knows what
   * it resolved for the turn; the runner only records it.
   */
  hostedLoop?: boolean;
  /**
   * What was said in the conversation before this message, oldest first,
   * that the agent never heard — a thread it is mentioned into partway.
   * Stored ahead of the opening message exactly as `observe` stores an
   * overheard one (`overheard`, `observed`, no turn run on it), and each
   * entry's metadata is read for its speaker's trust: the session starts
   * at the least trusted of everyone it holds, so a principal's mention
   * cannot carry a stranger's earlier words in under the principal's
   * label. Only `run` reads it — a session that already exists heard
   * what it heard, and `resume` has no use for it.
   */
  earlier?: ObserveEntry[];
  metadata?: JsonObject;
  /**
   * What the host can say about how this agent is run, rendered as the
   * `runtime` section; see {@link AgentRuntimeContext}. Omitted, the
   * section is not rendered.
   *
   * Per run rather than a runner option, because the answer belongs to the
   * snapshot the host dispatched with: a daemon that re-reads the roster
   * between two awaits would otherwise tell an agent running on one soul
   * file that another file is its soul.
   */
  runtime?: AgentRuntimeContext;
  /**
   * Asked for what somebody has said since the turn started, at each of
   * its tool steps: after the step's every call has its result and before
   * the next provider call (card 948). What it hands over goes into the
   * transcript right there, as a user message marked `steered`, so the
   * agent reads a correction at its next step instead of after its whole
   * turn. The message shares the steps the turn has left: it renews
   * neither the step budget, the auto-continue count nor the failure
   * streak, so however often somebody writes, the turn stops where it
   * would have (card 996). Its sender lowers the session's trust like any
   * sender; its keys join the turn's message.
   *
   * Never asked before the first provider call, after an answer, once the
   * turn is out of steps (the wrap-up can't act on it, so it waits and
   * runs as its own turn), or on a turn nobody asked for (`addressed:
   * false`, whose answer may be silence). A provider that hosts its own
   * tool loop, whose steps the runner never sees, asks through
   * `ProviderRequest.steer` after each hosted call instead, if it can
   * deliver a message mid-loop. A host that omits it gets turns that hear
   * nothing until they end, as before; what is handed over is the host's
   * to answer for, since the runner only records it.
   */
  steer?: () => Promise<SteeredMessage | undefined>;
  /** Aborting fails the turn cleanly; see RunAbortedError. */
  signal?: AbortSignal;
}

/** What a running turn takes in at a tool step; see `RunInput.steer`. */
export interface SteeredMessage {
  /** What was said, as a user message carries it (speaker included, if the channel writes one). */
  userMessage: string;
  /** Images sent with it; see `Message.images`. */
  images?: ImageAttachment[];
  /** Read for the sender's trust (`SENDER_TRUST_METADATA_KEY`) and merged into nothing, as `ResumeInput.metadata` is. */
  metadata?: JsonObject;
  /** Idempotency keys of the dispatches it carries, added to the turn's message (`Message.absorbedKeys`). */
  keys?: string[];
}

export interface ResumeInput {
  sessionId: string;
  userMessage: string;
  /** Images sent with the message; see `Message.images`. */
  images?: ImageAttachment[];
  /** See `RunInput.addressed`. */
  addressed?: boolean;
  /** See `RunInput.replyOptional`. */
  replyOptional?: boolean;
  /** See `RunInput.idempotencyKey`. */
  idempotencyKey?: string;
  /** See `RunInput.absorbedKeys`. */
  absorbedKeys?: string[];
  /** See `RunInput.hostedLoop`. */
  hostedLoop?: boolean;
  /**
   * This turn's metadata — read for the sender's trust
   * (`SENDER_TRUST_METADATA_KEY`) and not merged into the session's. The
   * principal is a property of the turn, and a resumed turn that could not
   * say who sent it would hand a stranger's message the first sender's
   * trust.
   */
  metadata?: JsonObject;
  /** See `RunInput.runtime`. */
  runtime?: AgentRuntimeContext;
  /** See `RunInput.steer`. */
  steer?: () => Promise<SteeredMessage | undefined>;
  /** Aborting fails the turn cleanly; see RunAbortedError. */
  signal?: AbortSignal;
}

/** One message heard without a turn run on it — see `RunInput.earlier`. */
export interface ObserveEntry {
  /** What was said, speaker included — see `ObserveInput.message`. */
  message: string;
  /** Read for the speaker's trust (`SENDER_TRUST_METADATA_KEY`); never merged. */
  metadata?: JsonObject;
}

export interface ObserveInput {
  sessionId: string;
  /** What was said, as the transcript will carry it — speaker included, the way a channel already writes a user turn. */
  message: string;
  /**
   * This message's metadata, read for the speaker's trust exactly as
   * `ResumeInput.metadata` is and merged into nothing: an overheard
   * stranger lowers the session's label the same way one who addressed the
   * agent would, because their text is in the transcript either way.
   */
  metadata?: JsonObject;
}

/**
 * Whether an abort leaves this session's turn for the next start rather
 * than failing it; see `RunAbortedError.resumable`. Exported for the host,
 * which tells the turn's caller the same thing the runner decided.
 */
export const leftForNextStart = (session: Pick<Session, 'messages'>, error: unknown): boolean => {
  if (!(error instanceof RunAbortedError) || !error.resumable) {
    return false;
  }
  const message = turnMessageOf(session);
  return turnKeyOf(message) !== undefined && message?.continuedAfterCrash !== true && message?.hostedLoop !== true;
};

/**
 * The abort that stopped a run, as the runner records it.
 *
 * A signal carries whatever its controller aborted with. When that reason
 * is a `RunAbortedError`, the aborter said why — the gateway's watchdog
 * names the silence it timed out on — and that is the error the turn fails
 * with, so `lastError` and `session.failed` read "no activity for 120000ms"
 * rather than the bare "Run aborted" that a person cancelling also
 * produces. The distinction used to exist only on the dispatch's rejection,
 * which is the one place nothing durable or observable reads it from.
 * Anything else on the signal — undefined, a DOMException, a string — is a
 * caller that did not say, and the default stands.
 *
 * Exported for hosts that check a signal before the runner ever sees it —
 * the gateway refuses a dispatch whose signal fired while it was queued —
 * so those refusals carry the same reason the runner would have recorded.
 */
export const abortErrorFor = (signal: AbortSignal | undefined): RunAbortedError =>
  signal?.reason instanceof RunAbortedError ? signal.reason : new RunAbortedError();

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw abortErrorFor(signal);
  }
};

/**
 * How long a tool call gets, once its turn is stopped, to answer for
 * itself. Long enough for a well-behaved tool to come back with what really
 * happened (a killed command's partial output, a cancelled request's
 * error); short against the drain window a stop or restart gives the turn
 * after aborting it (30 s by default), so a tool that ignores its signal is
 * left behind well inside it.
 */
const STOPPED_TOOL_GRACE_MS = 2_000;

/**
 * The most read-only calls one response runs at a time (`Tool.readOnly`).
 * A response can ask for any number, and each may be a file walk or a
 * plugin's request to someone else's service; a longer run goes out in
 * groups this size, one group after another, so a big batch is never that
 * many reads in the same moment.
 */
const READ_ONLY_CALLS_AT_ONCE = 8;

/**
 * Waits for a tool call's result, but not past `STOPPED_TOOL_GRACE_MS`
 * after the turn's signal fires.
 *
 * Card 826: a plugin tool that never settles and ignores its signal held
 * its session `running` until the daemon restarted. Slack's `stop` could
 * not end it, a stop or restart shut down around it, and the message
 * queued behind it in the same session was lost with the process. Every
 * executor (`DefaultExecutor`, `DirectExecutor`, `LocalCommandExecutor`,
 * any plugin's) awaits the tool, so this is the one place that bounds it.
 *
 * Left behind means not waited for, not stopped: the kernel has no way to
 * stop code that will not look at its signal. The result says so, because
 * the call may yet have its effect. Whatever the work does later is
 * dropped, a rejection included, so it can neither crash the process nor
 * reach a session that has moved on.
 */
const untilStoppedFor = (
  work: Promise<ToolResult>,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolResult> => {
  if (signal === undefined) {
    return work;
  }
  return new Promise<ToolResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const leaveBehind = (): void => {
      timer = setTimeout(() => {
        resolve({
          callId: call.id,
          toolName: call.toolName,
          ok: false,
          output: null,
          error: `${call.toolName} did not return after the turn was stopped, so it was left behind. `
            + 'It may still be running, and may still do what it was asked; check before calling it again.',
          trust: 'agent',
        });
      }, STOPPED_TOOL_GRACE_MS);
    };
    const settled = (): void => {
      signal.removeEventListener('abort', leaveBehind);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    if (signal.aborted) {
      leaveBehind();
    } else {
      signal.addEventListener('abort', leaveBehind, { once: true });
    }
    // `Promise.resolve`: a plugin executor typed loosely may hand back a
    // plain result, which has no `then` of its own.
    Promise.resolve(work).then(
      (result) => { settled(); resolve(result); },
      (error: unknown) => { settled(); reject(error); },
    );
  });
};

export interface AgentRunnerOptions {
  provider: ModelProvider;
  tools?: ToolRegistry;
  executor?: Executor;
  /**
   * Decides every tool call before it runs. Omitted, only `safe` tools run:
   * a `gated` or `dangerous` call (and a tool that declares no risk, which
   * reads as `gated`) is refused with an error naming this option. Pass
   * `AllowAllApprovalPolicy` to run every call without asking.
   */
  approvals?: ApprovalPolicy;
  store?: SessionStore;
  bus?: EventBus;
  plugins?: PluginRegistry;
  /** Known agent definitions; enables per-agent tool allowlists. */
  agents?: AgentRegistry;
  /**
   * Tools every agent may call whatever its `tools:` says — `tools: []`
   * included. For a tool whose every call only puts a question to a person
   * who decides the outcome (`credential.request`), so a soul is not asked
   * to list it to be able to ask.
   *
   * The host names them, not the tool: a flag on `Tool` would let any
   * plugin declare itself past every allowlist, and this list is a
   * decision about what is harmless to grant, which is the host's to make.
   */
  grantedToEveryAgent?: readonly string[];
  /**
   * What an agent with no `tools:` list may call. `safe`, the default, is
   * the tools registered at risk `safe`. `every` is every registered tool,
   * which is what an omitted list meant before, and what a host passes for
   * a home set up by an older build so an upgrade takes nothing away. An
   * agent with a list is held to its list either way.
   */
  unlistedTools?: UnlistedTools;
  /**
   * The skill catalog. Passing one makes `skill.read` available — the
   * runner registers it if the host has not — to exactly the agents whose
   * soul enables any skill; see the two gates in `executeTurns` and
   * `executeToolCall`.
   */
  skills?: SkillRegistry;
  /** Agent-scoped long-term memory, injected into every provider request. */
  memory?: AgentMemoryStore;
  /**
   * How much of a session's images stay stored — bytes and a count, see
   * `omitImagesOutsideReplayBudget`. Defaults to core's constants for the
   * model API's limits; a host that omits it gets those, which is right
   * for every real provider and only wrong for a test that cannot afford
   * 20 MiB fixtures.
   */
  imageReplayBudget?: ImageReplayBudget;
  /** Maximum provider turns per run before the session fails. */
  maxTurns?: number;
  /**
   * Keep working past `maxTurns` instead of wrapping up: when a message
   * spends its budget, it gets another, `maxTurns` more, in the same turn.
   * `true` means as many times as it takes; a number caps the extra
   * allowances per message. Off when absent. A message still wraps up
   * when it is stuck repeating a failure, when the cap is reached, and
   * when `waitingInput` says somebody has written to the session since —
   * they get the summary, and their message runs next.
   */
  autoContinue?: true | number;
  /** Whether a dispatch is queued behind the session's running turn. See `autoContinue`. */
  waitingInput?: (sessionId: string) => boolean;
  /**
   * When true, the runner hands providers a delta sink and re-emits their
   * fragments as provider.delta events. Off by default: streaming is
   * additive, and consumers that render only final responses (one-shot CLI
   * runs, tests) keep the simpler non-streaming provider path.
   */
  streaming?: boolean;
  /**
   * Asked, in order, before every provider call; see `ProviderCallGuard`.
   * Read on each call, so a host may add to the list after constructing
   * the runner. A host that omits it puts no limit on model calls beyond
   * `maxTurns`.
   */
  providerCallGuards?: readonly ProviderCallGuard[];
}

/**
 * Tool turns one message may take before it wraps up. The harness providers
 * spend the same number as their own inner budget, so they import it rather
 * than keep a copy.
 *
 * 8 until the wrap-up turn existed, and 8 was the whole budget for one Slack
 * message: an agent with a shell spent it on a handful of commands and
 * failed with nothing said. With a wrap-up turn the ceiling is where a long
 * task checks in rather than where it dies, and 40 is enough for real
 * multi-step work while still bounding what a runaway loop can spend.
 */
/**
 * What is wrong with a call's input against the shape its tool declared,
 * or undefined when nothing the check reads is wrong.
 *
 * Deliberately shallow: required keys, the declared JSON types, `enum`,
 * and `additionalProperties: false`, applied to nested objects too. It
 * exists so a call the tool would reject anyway is answered with the reason
 * before anyone is asked to approve it, not to replace a tool's own checks,
 * which still run. A schema keyword it doesn't read is not a failure.
 */
/** JSON equality, member order aside, the way JSON Schema compares `enum` values. */
const sameJson = (left: JsonValue | undefined, right: JsonValue | undefined, depth = 0): boolean => {
  if (left === right) {
    return true;
  }
  // Past any depth a real enum has, too deep to compare safely: unknown is
  // not wrong, so it counts as a match and the tool's own checks decide.
  if (depth > 64) {
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index], depth + 1));
  }
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => sameJson(left[key], right[key], depth + 1));
};

export const inputProblem = (schema: JsonObject | undefined, input: JsonValue, where = 'input', depth = 0): string | undefined => {
  if (schema === undefined || depth > 4) {
    return undefined;
  }
  const declared = schema.type;
  const types = Array.isArray(declared) ? declared.filter((type): type is string => typeof type === 'string') : typeof declared === 'string' ? [declared] : [];
  if (types.length > 0) {
    const actual = input === null ? 'null'
      : Array.isArray(input) ? 'array'
        : typeof input === 'number' ? (Number.isInteger(input) ? 'integer' : 'number')
          : typeof input;
    const fits = types.some((type) => type === actual || (type === 'number' && actual === 'integer'));
    if (!fits) {
      return `${where} should be ${types.join(' or ')}, not ${actual}`;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, input))) {
    return `${where} should be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const properties = schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, JsonValue>
    : {};
  // Every missing key at once, so a model fixes the call in one try.
  const missing = (Array.isArray(schema.required) ? schema.required : [])
    .filter((key): key is string => typeof key === 'string' && input[key] === undefined);
  if (missing.length > 0) {
    return `${where} is missing ${missing.map((key) => `"${key}"`).join(', ')}`;
  }
  // With `patternProperties` a key may be declared by a pattern, and running
  // a pattern a schema supplied is a regex engine on untrusted input. Not
  // this check's job: extra keys are only judged when no pattern exists.
  const patterned = schema.patternProperties !== undefined && schema.patternProperties !== null;
  if (schema.additionalProperties === false && !patterned) {
    const unknown = Object.keys(input).find((key) => !(key in properties));
    if (unknown !== undefined) {
      return `${where} has "${unknown}", which this tool does not take (it takes ${Object.keys(properties).map((key) => `"${key}"`).join(', ') || 'nothing'})`;
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (value !== undefined && property !== null && typeof property === 'object' && !Array.isArray(property)) {
      const problem = inputProblem(property as JsonObject, value, `${where}.${key}`, depth + 1);
      if (problem) {
        return problem;
      }
    }
  }
  return undefined;
};

export const DEFAULT_MAX_TURNS = 40;

export class AgentRunner {
  readonly bus: EventBus;
  readonly store: SessionStore;
  readonly tools: ToolRegistry;
  readonly executor: Executor;
  readonly approvals: ApprovalPolicy;
  readonly plugins: PluginRegistry;
  readonly agents: AgentRegistry;
  readonly skills: SkillRegistry | undefined;
  readonly memory: AgentMemoryStore | undefined;
  readonly maxTurns: number;
  readonly streaming: boolean;
  private readonly options: AgentRunnerOptions;
  private readonly imageReplayBudget: ImageReplayBudget | undefined;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new InMemorySessionStore();
    this.imageReplayBudget = options.imageReplayBudget;
    this.tools = options.tools ?? new ToolRegistry();
    this.executor = options.executor ?? new DefaultExecutor();
    this.approvals = options.approvals ?? SAFE_ONLY_APPROVALS;
    this.plugins = options.plugins ?? new PluginRegistry();
    this.agents = options.agents ?? new AgentRegistry();
    this.skills = options.skills;
    this.memory = options.memory;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.streaming = options.streaming ?? false;
    // The reader is part of the skills mechanism, so a runner given a
    // catalog makes sure it exists — with this runner's own allowlist
    // resolution, so the tool refuses exactly what the gates refuse. A host
    // that registered its own (the gateway, so its tool listing is complete
    // before the first dispatch) is left alone.
    if (this.skills && !this.tools.get(SKILL_READ_TOOL_NAME)) {
      this.tools.register(
        createSkillReadTool(this.skills, { allowlistFor: (session) => this.skillAllowlistFor(session) }),
      );
    }
  }

  async initialize(): Promise<void> {
    await this.plugins.loadAll({ bus: this.bus, tools: this.tools });
  }

  async run(input: RunInput): Promise<Session> {
    // The sender's trust is the turn's, not the session's: it is read here
    // and kept out of the persisted metadata, where a later reader would
    // take the first sender's label for every turn that follows.
    const { [SENDER_TRUST_METADATA_KEY]: _sender, ...persisted } = input.metadata ?? {};
    const earlier = input.earlier ?? [];
    // Everyone whose words open the transcript, not only the one who
    // asked: see `RunInput.earlier`.
    const senderTrust = earlier.reduce<TrustLevel>(
      (lowest, entry) => leastTrusted(lowest, senderTrustOf(entry.metadata)),
      senderTrustOf(input.metadata),
    );
    const createdAt = new Date().toISOString();
    const heard: Message[] = earlier.map((entry, index) => ({
      id: `${input.sessionId}:user:${index + 1}`,
      role: 'user',
      content: entry.message,
      createdAt,
      overheard: true,
      observed: true,
    }));
    // The first stored turn is held to the window like every later one:
    // a one-shot session is a row too.
    const opening: Message = {
      id: `${input.sessionId}:user:${heard.length + 1}`,
      role: 'user',
      content: input.userMessage,
      createdAt: new Date().toISOString(),
      ...userImages(input.images),
      ...(input.addressed === false ? { overheard: true } : {}),
      ...(input.addressed !== false && input.replyOptional === true ? { replyOptional: true } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.absorbedKeys !== undefined && input.absorbedKeys.length > 0 ? { absorbedKeys: [...input.absorbedKeys] } : {}),
      ...(input.hostedLoop === true ? { hostedLoop: true } : {}),
    };
    omitImagesOutsideReplayBudget([opening], this.imageReplayBudget);
    const sessionInput: Omit<Session, 'createdAt' | 'updatedAt'> = {
      id: input.sessionId,
      agent: input.agent,
      status: 'running',
      messages: [...heard, opening],
      // Labelled from the first write, whatever the dispatching surface
      // put in `metadata` under this key: the label is the runner's to
      // write, and a fresh session starts at the top of the lattice lowered
      // only by who is speaking.
      metadata: {
        ...persisted,
        [SESSION_TRUST_METADATA_KEY]: senderTrust,
        ...(isTaintedTrust(senderTrust) ? { [SESSION_TAINTED_BY_METADATA_KEY]: 'sender' } : {}),
      },
    };

    const session = await this.store.create(sessionInput);

    await this.bus.emit({ type: 'session.created', sessionId: session.id, agentId: session.agent.id });
    await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });
    // A delegating agent is an `agent` sender — its teammate's session
    // starts there, which is ordinary, not a taint to announce.
    if (isTaintedTrust(senderTrust)) {
      await this.bus.emit({ type: 'session.tainted', sessionId: session.id, trust: senderTrust, source: 'sender' });
    }

    return this.executeTurns(session, input.signal, undefined, input.runtime, input.steer);
  }

  /**
   * Lower the session's label and say so on the bus when it moved. The one
   * place the label is written during a turn, so every reason for a drop
   * — a tool's result, an injected entry, a sender, a legacy transcript —
   * is announced the same way and by name only.
   */
  private async taint(session: Session, trust: TrustLevel, source: string): Promise<void> {
    // Announced only for a taint. `user` to `agent` is the first tool call
    // of every ordinary conversation, and a log line for it would say
    // nothing anyone needs to hear.
    if (lowerSessionTrust(session, trust, source) && isTaintedTrust(sessionTrustOf(session))) {
      await this.bus.emit({ type: 'session.tainted', sessionId: session.id, trust: sessionTrustOf(session), source });
    }
  }

  /**
   * A session with no label was written before provenance was tracked. It
   * reads `unknown` from here on, and the transcript it carries — which may
   * already hold hostile page content — is the reason: treating that
   * absence as untainted keeps the laundering path open for every
   * pre-upgrade conversation, the one corpus guaranteed to exist on the day
   * this shipped. Marking it `external` would be the other overcorrection.
   */
  private async labelLegacySession(session: Session): Promise<void> {
    // A label nobody recognises is no label: a hand-edited or corrupted
    // value is the legacy case too, and reads `unknown` from here on.
    if (!isTrustLevel(session.metadata?.[SESSION_TRUST_METADATA_KEY])) {
      await this.taint(session, 'unknown', 'legacy');
    }
  }

  async resume(input: ResumeInput): Promise<Session> {
    const session = await this.store.get(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    // Mid-turn saves make tool calls durable before their results; a
    // daemon killed in between leaves a call with no result, and provider
    // wire formats reject a tool call that is never answered. Close each
    // dangling call with an explicit interrupted result so the durable
    // conversation stays resumable.
    this.reconcileInterruptedToolCalls(session);

    // Every dangling call is now closed, the parked one included, so a
    // checkpoint here describes a call the transcript has just answered.
    // It has to go: `recoverPendingApproval` trusts the record over the
    // transcript, and a daemon's parked sweep starts after its channels
    // come up — so a message that resumes the session first would leave a
    // record for the restart to re-enter, executing the call on a session
    // that has since completed.
    if (session.metadata?.[PENDING_APPROVAL_METADATA_KEY] !== undefined) {
      const metadata = { ...session.metadata };
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
      session.metadata = metadata;
    }

    session.status = 'running';
    delete session.lastError;
    // The marker describes the message before this one.
    delete session.stoppedEarly;
    session.messages.push({
      id: `${session.id}:user:${session.messages.length + 1}`,
      role: 'user',
      content: input.userMessage,
      createdAt: new Date().toISOString(),
      ...userImages(input.images),
      // Marked like a message `observe` appended, because it is one: the
      // difference is only that a turn runs on it, and every renderer
      // frames it from the same mark.
      ...(input.addressed === false ? { overheard: true } : {}),
      ...(input.addressed !== false && input.replyOptional === true ? { replyOptional: true } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.absorbedKeys !== undefined && input.absorbedKeys.length > 0 ? { absorbedKeys: [...input.absorbedKeys] } : {}),
      ...(input.hostedLoop === true ? { hostedLoop: true } : {}),
    });
    // Before the save below: the row that carries this turn is the row
    // that stops carrying the pixels nothing can send any more.
    omitImagesOutsideReplayBudget(session.messages, this.imageReplayBudget);

    // The sender is evaluated on EVERY turn, from this turn's metadata: a
    // thread keys one session for everyone in it, and an unauthorized
    // member's message lowers the session to `unknown` and leaves it there
    // — that content is in the transcript from now on.
    await this.labelLegacySession(session);
    await this.taint(session, senderTrustOf(input.metadata), 'sender');

    // The accepted input is durable BEFORE any provider work: a crash
    // mid-turn must not silently lose a message the caller believes was
    // received — restarting with the same session id recovers it.
    await this.store.save(session);
    const stored = await this.store.get(session.id);
    const working = stored ?? session;

    await this.bus.emit({ type: 'session.updated', sessionId: working.id, status: working.status });

    return this.executeTurns(working, input.signal, undefined, input.runtime, input.steer);
  }

  /**
   * Picks up a turn whose process died while it was `running`: its user
   * message is durable and its reply is not. Nothing is appended — the turn
   * already has its message — so this is `resume` without the input.
   * Dangling tool calls are closed as interrupted, telling the model they
   * may not have run rather than running them again, and the loop goes back
   * to the provider with the transcript as it stands.
   *
   * A transcript that already ends in the reply (the response was saved,
   * and the process died before the save that marks the turn completed) is
   * completed as it stands, with no provider call: asking again would send
   * a second answer to one message.
   *
   * Marks the turn's message `continuedAfterCrash` in its first save, so a
   * host can refuse to do this twice. Resolves `undefined` when the session
   * is missing or no longer `running`. Never for a turn parked on a human:
   * `recoverPendingApproval` re-enters the parked call, which reconciling
   * here would close.
   */
  async continueTurn(
    sessionId: string,
    options: {
      /** See `RunInput.runtime`. */
      runtime?: AgentRuntimeContext;
      signal?: AbortSignal;
    } = {},
  ): Promise<Session | undefined> {
    const session = await this.store.get(sessionId);
    if (!session || session.status !== 'running') {
      return undefined;
    }
    // Before reconciliation splices results into the response it judges.
    const answered = lastResponseIsAnswer(session);
    this.reconcileInterruptedToolCalls(session);
    const message = turnMessageOf(session);
    if (message !== undefined) {
      message.continuedAfterCrash = true;
    }
    await this.labelLegacySession(session);
    await this.store.save(session);
    const stored = await this.store.get(session.id);
    const working = stored ?? session;

    await this.bus.emit({ type: 'session.updated', sessionId: working.id, status: working.status });

    if (answered) {
      return this.completeTurn(working);
    }
    // Resumed, not restarted, for the reason `recoverPendingApproval` is: a
    // turn that already took provider turns spends the budget it was on, and
    // its failure streak counts the responses before the crash. Handed over
    // as an answered call with nothing left to run, so the loop counts this
    // message's responses (`responsesThroughCall`) and goes straight to the
    // next provider turn — the wrap-up, if the ceiling has been reached.
    // From the message the turn started on, past any steered in: one that
    // reached the turn mid-way shares its budget (`RunInput.steer`), so a
    // crash right after one must not hand the turn a fresh allowance.
    const userIndex = working.messages.findLastIndex(startsTurn);
    const callIndex = working.messages.findLastIndex((candidate) => candidate.role === 'assistant' && (candidate.toolCalls?.length ?? 0) > 0);
    const lastCall = callIndex > userIndex ? working.messages[callIndex]?.toolCalls?.at(-1) : undefined;
    const lastResult = lastCall === undefined
      ? undefined
      : working.messages.slice(callIndex + 1).findLast((candidate) => candidate.toolResult?.callId === lastCall.id)?.toolResult;
    const resumeFrom = lastCall !== undefined && lastResult !== undefined
      ? {
        pending: undefined,
        remaining: [],
        turn: responsesThroughCall(working, lastCall).length,
        answered: { call: lastCall, result: lastResult },
      }
      : undefined;
    return this.executeTurns(working, options.signal, resumeFrom, options.runtime);
  }

  /**
   * A message reaching the session with no turn run on it: something said
   * in a conversation the agent is in, to somebody else. Appended and
   * saved, so the next turn the agent does take has it in hand; no
   * provider call, no reply, no status change, and its own event rather
   * than `session.updated`, since nothing is running.
   *
   * Refused while a turn is in flight. A parked turn's transcript ends in
   * a tool call awaiting its result, and a user message spliced in ahead
   * of that result is a wire-format violation on the API path — the one
   * shape `reconcileInterruptedToolCalls` exists to repair, and repairing
   * it here would close a call a human is still deciding on. A host that
   * serializes writes per session (the gateway's chain) only ever sees
   * this for a turn parked across a restart, and says so rather than
   * dropping the message silently.
   */
  async observe(input: ObserveInput): Promise<Session> {
    const session = await this.store.get(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }
    if (session.status === 'running' || session.status === 'pending_approval') {
      throw new Error(
        `Session ${input.sessionId} has a turn in flight (${session.status}); a message cannot be overheard into it until the turn has finished.`,
      );
    }

    session.messages.push({
      id: `${session.id}:user:${session.messages.length + 1}`,
      role: 'user',
      content: input.message,
      createdAt: new Date().toISOString(),
      overheard: true,
      observed: true,
    });

    // The speaker is judged like any sender: their words are in the
    // transcript from here on, whether or not they were talking to the
    // agent — which is exactly the case the label exists for.
    await this.labelLegacySession(session);
    await this.taint(session, senderTrustOf(input.metadata), 'sender');

    await this.store.save(session);
    const stored = await this.store.get(session.id);
    const working = stored ?? session;

    await this.bus.emit({ type: 'session.observed', sessionId: working.id, agentId: working.agent.id });
    return working;
  }

  /**
   * Adds a synthetic failed result for every tool call that has none — the
   * durable trace of a turn interrupted between the call's save and its
   * result's. The model sees an honest record ("interrupted, never ran to
   * completion") instead of a wire-format violation, and a resume can
   * decide to retry rather than assume the side effect landed.
   *
   * Placed where an uninterrupted turn would have written it: after the
   * whole response the call came in — every assistant message that one
   * save wrote — and after any results already recorded for it. Directly
   * after the call would split a response whose text followed its call, and
   * a provider replaying the response's raw turn (which already holds that
   * text) would then send the text a second time.
   */
  private reconcileInterruptedToolCalls(session: Session): void {
    // Matched by OCCURRENCE, not by id alone: providers can reuse ids
    // (the OpenAI-compatible adapter synthesizes tool-call-1 whenever an
    // endpoint omits them), and an earlier answered occurrence must not
    // make a later dangling one look answered. The nth call with an id
    // needs the nth result with that id, in transcript order.
    const resultsAvailable = new Map<string, number>();
    for (const message of session.messages) {
      if (message.role === 'tool' && message.toolResult) {
        const id = message.toolResult.callId;
        resultsAvailable.set(id, (resultsAvailable.get(id) ?? 0) + 1);
      }
    }

    const messages = session.messages;
    // By the index of the message they go after.
    const inserts = new Map<number, Message[]>();
    const callsSeen = new Map<string, number>();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role !== 'assistant' || !message.toolCalls) {
        continue;
      }
      for (const call of message.toolCalls) {
        const occurrence = (callsSeen.get(call.id) ?? 0) + 1;
        callsSeen.set(call.id, occurrence);
        if (occurrence <= (resultsAvailable.get(call.id) ?? 0)) {
          continue;
        }
        resultsAvailable.set(call.id, occurrence);
        const result: ToolResult = {
          callId: call.id,
          toolName: call.toolName,
          ok: false,
          output: null,
          error: 'Tool execution was interrupted before a result was recorded; it may not have run to completion.',
          // The kernel's own sentence, not the tool's output.
          trust: 'agent',
        };
        let end = index;
        while (messages[end + 1]?.role === 'assistant') {
          end += 1;
        }
        while (messages[end + 1]?.role === 'tool') {
          end += 1;
        }
        inserts.set(end, [...(inserts.get(end) ?? []), {
          id: `${session.id}:tool:${call.id}`,
          role: 'tool',
          name: call.toolName,
          content: JSON.stringify(result),
          createdAt: new Date().toISOString(),
          toolResult: result,
        }]);
      }
    }
    if (inserts.size > 0) {
      messages.splice(0, messages.length, ...messages.flatMap((message, index) => [message, ...(inserts.get(index) ?? [])]));
    }
  }

  /**
   * The id for the next Stratus turn that spends tokens.
   *
   * Ordinals count the turns that *recorded* usage rather than loop
   * iterations, which is what makes deriving them safe: a turn that reported
   * nothing leaves no record behind, so its ordinal was never taken and the
   * next turn cannot collide with it. Derived from the stored records rather
   * than held in a counter so a session resumed in another process continues
   * the numbering instead of restarting it and merging two turns under one
   * id.
   */
  private nextTurnId(session: Session): string {
    const turns = new Set((session.usage ?? []).map((record) => record.turnId));
    return `${session.id}:turn:${turns.size + 1}`;
  }

  /**
   * Record one provider call against the session, attributed.
   *
   * Accumulation lives here rather than in each adapter for the usual
   * reason: four copies of a summing rule is four places for a fallback or a
   * retried call to be counted once, twice, or not at all.
   */
  private recordUsage(session: Session, turnId: string, usage: ProviderCallUsage): void {
    const record: UsageRecord = {
      // Web Crypto: present in every runtime core supports, and core
      // imports nothing.
      id: globalThis.crypto.randomUUID(),
      at: new Date().toISOString(),
      turnId,
      // The adapter's own name wins. `provider.name` is the fallback
      // wrapper's under a configured fallback, and that name is the
      // primary's for the life of the session — so trusting it would file
      // the fallback model's tokens under the provider that failed.
      provider: usage.provider ?? this.options.provider.name,
      ...(usage.model !== undefined ? { model: usage.model } : {}),
      ...definedTokenCounts(usage),
    };
    (session.usage ??= []).push(record);
  }

  /**
   * Emit `session.usage` for the records added to the session since
   * `recordedBefore`.
   *
   * The loop drains these before the next provider call, which is the
   * point: a host that meters spend from this event has seen every earlier
   * call's tokens before a guard is asked to allow another one. Copies, so
   * a subscriber cannot edit the session's accounting through the event.
   */
  private async announceUsage(session: Session, recordedBefore: number): Promise<void> {
    const records = (session.usage ?? []).slice(recordedBefore);
    if (records.length === 0) {
      return;
    }
    await this.bus.emit({
      type: 'session.usage',
      sessionId: session.id,
      agentId: session.agent.id,
      records: records.map((record) => ({ ...record })),
    });
  }

  /**
   * Before a floor rise to `start`, ask the model for a summary of what the
   * rise cuts, so the window carries that instead of only a note that
   * messages are gone. Returns the summary that covers everything below
   * `start`, for the caller to store beside the floor
   * (`CONTEXT_SUMMARY_METADATA_KEY`), or undefined when there is none.
   *
   * Writes nothing to the session. The floor and its summary land together
   * once this settles: a provider may save the session it is handed during
   * the call (the fallback wrapper does, before asking its fallback), and a
   * floor saved there with no summary beside it would hide the cut behind
   * the plain note for good, since nothing asks again until the next
   * overflow. A refusal or abort here therefore leaves the floor where it
   * was, and the next turn's overflow asks again.
   *
   * One more call to the same provider the turn is on, asked and billed
   * like any other: the host's guards judge it first and a refusal ends
   * the turn, because the retry it precedes would be refused too; its usage
   * is recorded under the turn's id. Its words are not a reply, so they
   * never stream: a streaming run sees only that the provider is busy.
   *
   * Any other failure — an overloaded API, a part that does not fit even
   * clipped, an empty answer — leaves the cut as it was before summaries
   * existed: the plain note, and the stored summary (if any) kept for the
   * part it does cover. Losing a summary costs detail; failing the turn
   * over one would cost the conversation, which is what the floor exists
   * to keep. An abort is not a failure to absorb and ends the turn.
   */
  private async summarizeCut(
    session: Session,
    shownFrom: number,
    start: number,
    turnId: string,
    signal: AbortSignal | undefined,
    onDelta: ((delta: ProviderDelta) => Promise<void>) | undefined,
  ): Promise<ContextSummary | undefined> {
    const held = contextSummaryOf(session);
    // A stored summary that reaches past where the window began is not
    // this transcript's, and is replaced rather than built on.
    const prior = held !== undefined && held.through <= shownFrom ? held : undefined;
    const part = session.messages.slice(prior?.through ?? shownFrom, start);
    if (part.length === 0) {
      return prior !== undefined && prior.through === start ? prior : undefined;
    }

    await this.guardProviderCall(session);
    let sinkReported = false;
    let announcedThrough = session.usage?.length ?? 0;
    const announce = async (): Promise<void> => {
      const from = announcedThrough;
      announcedThrough = session.usage?.length ?? 0;
      await this.announceUsage(session, from);
    };
    let response: ProviderResponse;
    try {
      response = await this.options.provider.generate({
        // The real session, as for every request: providers persist it.
        session,
        messages: [contextSummaryRequest(session.id, prior, part)],
        onUsage: (usage) => {
          sinkReported = true;
          this.recordUsage(session, turnId, usage);
        },
        guardCall: async (provider) => {
          await announce();
          await this.guardProviderCall(session, provider);
        },
        // A reset still says what it says (a fallback took over); every
        // other fragment is only a sign of life for an activity watchdog.
        ...(onDelta !== undefined
          ? { onDelta: (delta: ProviderDelta) => onDelta(delta.type === 'reset' ? delta : { type: 'progress' }) }
          : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      await announce();
      throwIfAborted(signal);
      if (error instanceof HostRefusalError) {
        throw error;
      }
      return undefined;
    }
    if (!sinkReported && response.usage) {
      this.recordUsage(session, turnId, response.usage);
    }
    await announce();
    throwIfAborted(signal);
    const text = response.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
      .trim();
    // No tools were offered, so a call is a model that did not do what it
    // was asked; nothing it said alongside one is the summary.
    if (text.length === 0 || response.parts.some((part) => part.type === 'tool-call')) {
      return undefined;
    }
    return {
      from: prior?.from ?? shownFrom,
      through: start,
      text: clippedTo(text, CONTEXT_SUMMARY_MAX_CHARS),
      trust: leastTrusted(sessionWriteTrust(session), prior?.trust ?? 'agent'),
    };
  }

  /** Ask every guard about the call about to be made; the first refusal throws. */
  private async guardProviderCall(
    session: Session,
    provider = this.options.provider.nameFor?.(session) ?? this.options.provider.name,
  ): Promise<void> {
    for (const guard of this.options.providerCallGuards ?? []) {
      await guard({ agentId: session.agent.id, sessionId: session.id, provider });
    }
  }

  /**
   * The allowlist entries this session's agent is held to, or undefined for
   * no limit. Entries, not a name set: `fs.*` is an entry, and matching is
   * `matchesToolAllowlist`'s job rather than each caller's.
   */
  private allowedToolsFor(session: Session): readonly string[] | undefined {
    // The definition handed to run()/resume() travels with the session, so an
    // agent's own allowlist applies even when it was never registered.
    return session.agent.tools ?? this.agents.get(session.agent.id)?.tools;
  }

  /**
   * Whether this session's agent may call `name` under its `tools:` list,
   * or because the host grants it to every agent. Not for `skill.read`,
   * which has its own gate keyed on `skills:`.
   *
   * An omitted list is the tools registered at risk `safe`, and nothing
   * else. It used to be every registered tool, which failed open: a soul
   * that never wrote the key held `shell.run` the moment that plugin was
   * enabled. The risk is the one the registry holds, so an operator's
   * per-tool risk override counts, and `tools: ["*"]` is how a soul says
   * "everything". A host passes `unlistedTools: 'every'` for a home an
   * older build set up, where an omitted list keeps its old meaning. A name
   * nothing registered is let through here so the call is refused as not
   * found, the same as for any other agent.
   */
  private toolPermitted(name: string, allowedTools: readonly string[] | undefined): boolean {
    if ((this.options.grantedToEveryAgent ?? []).includes(name)) {
      return true;
    }
    if (allowedTools === undefined) {
      if (this.options.unlistedTools === 'every') {
        return true;
      }
      const registered = this.tools.get(name);
      return registered === undefined || resolveToolRisk(registered) === 'safe';
    }
    return matchesToolAllowlist(name, allowedTools);
  }

  /** The `skills:` entries this session's agent is held to — same sourcing as `allowedToolsFor`. */
  private skillAllowlistFor(session: Session): readonly string[] | undefined {
    return session.agent.skills ?? this.agents.get(session.agent.id)?.skills;
  }

  /**
   * The skills this session's agent has enabled, as the one-line
   * descriptors the prompt carries. Each skill appears once, under the id
   * the allowlist actually granted (canonical before alias) — the id the
   * model is told is the id `skill.read` will accept.
   *
   * A built-in skill is in it for every agent; otherwise it is empty for
   * an agent whose soul has no `skills:` key, which is what keys both
   * `skill.read` gates: no skills, no reader.
   */
  private enabledSkillsFor(session: Session): SkillDescriptor[] {
    if (!this.skills) {
      return [];
    }
    const allowlist = this.skillAllowlistFor(session) ?? [];
    const enabled: SkillDescriptor[] = [];
    for (const skill of this.skills.list()) {
      const grantedId = skill.builtin === true
        ? skill.id
        : this.skills
          .idsFor(skill.id)
          .find((candidate) => matchesSkillAllowlist(candidate, allowlist));
      if (grantedId !== undefined) {
        enabled.push({ id: grantedId, name: skill.name, description: skill.description });
      }
    }
    return enabled;
  }

  private async executeTurns(
    initialSession: Session,
    signal?: AbortSignal,
    /**
     * Re-enter an interrupted turn at its parked call instead of starting
     * with the provider. The response these calls came from is already in
     * the session — replaying it would duplicate the assistant messages and
     * re-ask the model — so recovery picks up exactly where the wait was.
     */
    resumeFrom?: {
      pending: ToolCall | undefined;
      remaining: ToolCall[];
      parkedAt?: string;
      turn?: number;
      /**
       * The parked call when recovery already answered it — a deadline that
       * passed while the process was down — so the recovered turn is
       * counted whole toward the repeated-failure stop.
       */
      answered?: { call: ToolCall; result: ToolResult };
    },
    /** See `RunInput.runtime`. */
    runtime?: AgentRuntimeContext,
    /** See `RunInput.steer`. Not passed for a recovered turn. */
    steer?: () => Promise<SteeredMessage | undefined>,
  ): Promise<Session> {
    let session = initialSession;
    let pendingEntry = resumeFrom;

    try {
      const allowedTools = this.allowedToolsFor(session);
      // Gate 1 of two for skill.read (gate 2 is executeToolCall): the
      // reader rides on the agent having any skill enabled, not on the
      // `tools:` allowlist — it is an implementation detail of the
      // `skills:` key, and souls are not asked to list it. The exemption
      // cuts both ways: an agent with no skills never sees the reader,
      // however permissive its tools list.
      const enabledSkills = this.enabledSkillsFor(session);
      const tools = this.tools
        .describe()
        .filter((tool) => (tool.name === SKILL_READ_TOOL_NAME
          ? enabledSkills.length > 0
          : this.toolPermitted(tool.name, allowedTools)));

      // Resumed, not restarted: a recovered turn spends the budget it was
      // already on. Starting at 1 would let a call parked on the last
      // permitted turn buy the whole allowance again.
      // Consecutive turns whose every call failed the same way, and how.
      // Local to this run: a person replying is new information, and the
      // call that failed before may work now. A message steered into the
      // run doesn't reset it: a call that changes after it isn't the same
      // failure anyway, and one that doesn't is still stuck.
      let lastFailure: string | undefined;
      let failureRun = 0;
      let stuck: { toolName: string; times: number } | undefined;
      // Every turn's calls go through here, a recovered turn's included: it
      // is a turn the provider already took, so its failures are as much
      // the loop's as any other.
      const countFailures = (calls: ToolCall[], results: ToolResult[]): void => {
        const signature = failureSignature(calls, results);
        failureRun = signature !== undefined && signature === lastFailure ? failureRun + 1 : signature === undefined ? 0 : 1;
        lastFailure = signature;
        // Recomputed, not latched: a recovery replays the whole message, and
        // a streak an older build let run past the limit is over once a
        // later response breaks it.
        stuck = failureRun >= REPEATED_FAILURE_LIMIT
          ? { toolName: results[0]!.toolName, times: failureRun }
          : undefined;
      };
      // Where this message wraps up: `maxTurns`, raised by another
      // `maxTurns` each time auto-continue grants one.
      let ceiling = this.maxTurns;
      let continued = 0;
      for (let turn = resumeFrom?.turn ?? 1; ; turn += 1) {
        throwIfAborted(signal);
        // Out of budget and still working — the last response called a
        // tool — so with auto-continue on it gets another allowance rather
        // than a wrap-up. A loop, because a recovered turn can start
        // several allowances in. Never for a turn stuck on a failure, past
        // the cap, or with somebody's message waiting behind it.
        while (turn > ceiling && stuck === undefined && this.mayContinue(session.id, continued)) {
          ceiling += this.maxTurns;
          continued += 1;
          await this.bus.emit({ type: 'session.continued', sessionId: session.id, continuation: continued, turns: this.maxTurns });
        }
        // One turn past the ceiling, and only one: the wrap-up, which may
        // not call a tool, so a turn that reaches `ceiling + 2` is a
        // provider that ignored `toolChoice` and was already failed below.
        // A turn stopped for repeating itself wraps up the same way, early.
        const wrappingUp = turn > ceiling || stuck !== undefined;
        // A recovered call is a tool turn too, so one parked past the
        // ceiling — `maxTurns` lowered while it waited — is refused as it
        // was before wrap-up existed, not run on the one call reserved for
        // saying what happened.
        if (turn > ceiling + 1 || (wrappingUp && pendingEntry)) {
          throw new Error(turnLimitMessage(this.maxTurns));
        }
        // Between a tool step and the next call, and only there: every call
        // of the last response has its result, so a user message here
        // splits no call from its answer. Only while the turn may still
        // call a tool: the wrap-up can't act on a message, so one that
        // arrives then waits and runs as its own turn, on a budget of its
        // own. What joins the turn shares the steps it has left. It renews
        // neither the budget, the auto-continue count nor the failure
        // streak, so a conversation that writes at every step can't keep
        // one turn going past its ceiling (card 996). Never into a turn
        // that may stay quiet: a question folded into one could be lost
        // to its silence, so it waits and runs as its own (card 601).
        if (
          steer !== undefined
          && !wrappingUp
          && pendingEntry === undefined
          && session.messages.at(-1)?.role === 'tool'
          && !isReplyOptionalTurn(session)
        ) {
          const steered = await steer();
          throwIfAborted(signal);
          if (steered !== undefined) {
            await this.takeSteered(session, steered);
          }
        }

        if (pendingEntry) {
          // The whole recovered queue — the parked call first, then the
          // ones behind it — so the response's every `tool_use` ends up
          // with a `tool_result` before the loop goes back to the provider.
          const recovered = [
            ...(pendingEntry.pending ? [pendingEntry.pending] : []),
            ...pendingEntry.remaining,
          ];
          // The original park time rides along, so a wait is measured from
          // when it began rather than restarted by the recovery. Only
          // meaningful when the parked call itself is being re-asked;
          // a denied one is already answered.
          const carriedParkedAt = pendingEntry.pending ? pendingEntry.parkedAt : undefined;
          const first = pendingEntry.answered?.call ?? recovered[0];
          pendingEntry = undefined;
          await this.runToolCalls(session, recovered, signal, carriedParkedAt, turn);
          // Counted as the whole response, read back from the session: the
          // checkpoint holds only the parked call and what queued behind it,
          // and a call earlier in the same response that ran (and perhaps
          // succeeded) before the park is as much a part of the turn.
          // The responses before it in this message too, which the counter
          // lost with the process that counted them.
          if (first !== undefined) {
            for (const response of responsesThroughCall(session, first)) {
              countFailures(response.calls, response.results);
            }
          }
          continue;
        }

        // Three bounded blocks, not the whole store and not a recency slice
        // either: the pinned core the agent keeps whatever the conversation
        // is, a topic index telling it what it knows about, and a short
        // tail. Everything else reaches the model through `memory.recall`,
        // which the index exists to aim.
        const memory = this.memory
          ? await buildMemoryInjection(this.memory, session.agent.id)
          : emptyMemoryInjection();
        // What enters the context taints the session, not only what a tool
        // returned: an `external` entry arriving here is a stranger's text
        // in the prompt, and without this the store launders its own
        // contents on the next restart — a fresh session reads the fact,
        // restates it, remembers it, and the copy is `agent`. The topic
        // index counts too — an entity name an `external` entry supplied is
        // still a stranger's words reaching the prompt.
        const injected = memoryInjectionEntries(memory);
        const injectedTrust = leastTrusted(
          ...injected.map(memoryEntryTrust),
          ...memory.topics.map((topic) => topic.trust),
        );
        if (injected.length > 0 || memory.topics.length > 0) {
          await this.taint(session, injectedTrust, 'memory');
        }

        // Deltas re-emit on the bus through a serial chain that is drained
        // before the final provider.response goes out — a delta arriving
        // after the response would let a late edit overwrite final output.
        let deltaChain: Promise<void> = Promise.resolve();
        const onDelta = (delta: ProviderDelta): Promise<void> => {
          const emission = deltaChain.then(() =>
            this.bus.emit({ type: 'provider.delta', sessionId: session.id, delta }),
          );
          deltaChain = emission;
          return emission;
        };

        // One Stratus turn: one id, however many provider calls the adapter
        // makes underneath it. Allocated before the call because the sink
        // fires during it.
        const turnId = this.nextTurnId(session);
        // Sending less history until it fits, rather than failing for good.
        //
        // A transcript that has outgrown the context window is the one
        // provider rejection that repeats: the session is durable, so the
        // next message replays the same too-long request and is refused
        // the same way, and the conversation is dead under an id its
        // channel still routes to. A Slack DM is one session for the life
        // of the install, so "start a new one" is not available to the
        // person typing into it.
        //
        // The floor is raised on the session and saved, so the next turn
        // begins where this one ended up instead of paying a rejected
        // request to rediscover it. `sessionWithinContextFloor` is what
        // actually shortens the request; the provider only says that it
        // did not fit.
        let response: ProviderResponse | undefined;
        for (;;) {
          const floored = messagesWithinContextFloor(session);
          // The note rides in the window only, so the session never holds
          // it; see `TURN_LIMIT_NOTE`.
          const window = stuck
            ? [...floored, repeatedFailureNoteFor(session, stuck.toolName, stuck.times)]
            : wrappingUp ? [...floored, turnLimitNoteFor(session)] : floored;
          // Sink-reported usage is exclusive for the call: an adapter that
          // reports its internal attempts through the sink has already
          // counted the last one, and reading the response's field as well
          // would bill that attempt twice.
          //
          // Per ATTEMPT, not per turn, because the sink's exclusivity is
          // scoped to one `generate` (see `ProviderRequest.onUsage`) and a
          // retry below is another one. Shared across them, an overflowing
          // attempt that reported its billed tokens through the sink would
          // suppress the response field of the shorter attempt that then
          // succeeded — recording the call that failed and not the one that
          // answered. The turn id is deliberately not per attempt: one
          // Stratus turn, however many provider calls it took to fit.
          let sinkReported = false;
          // Announced as reported, not when the call settles. A harness
          // reports each inner call and keeps working, sometimes for
          // minutes, and a daemon that dies in that time must not take the
          // spent tokens with it: `session.usage` is what a ledger writes
          // down. The sink is synchronous by contract, so the announcement
          // is queued on a serial chain rather than awaited in it, and a
          // report of several records at once (one per model) goes out as
          // one event. The chain is drained before this attempt is over,
          // so a guard asked about the next call has seen all of it.
          let usageChain: Promise<void> = Promise.resolve();
          let announcedThrough = session.usage?.length ?? 0;
          const announcePending = (): Promise<void> => {
            usageChain = usageChain.then(() => {
              const from = announcedThrough;
              announcedThrough = session.usage?.length ?? 0;
              return this.announceUsage(session, from);
            });
            return usageChain;
          };
          const onUsage = (usage: ProviderCallUsage): void => {
            sinkReported = true;
            this.recordUsage(session, turnId, usage);
            void announcePending();
          };
          // The same question as below, for a call the provider makes
          // inside this attempt: what it has spent so far is announced
          // first, so the guard reads it.
          const guardCall = async (provider: string): Promise<void> => {
            await announcePending();
            await this.guardProviderCall(session, provider);
          };
          // The step the loop above steers at, for a provider whose loop is
          // its own: right after one of its hosted calls has a result, so a
          // user message there splits no call from its answer. The same
          // turns go without: the wrap-up, and one that may stay quiet.
          const steered = session;
          const hostedSteer = steer !== undefined && !wrappingUp && !isReplyOptionalTurn(steered)
            ? async (): Promise<SteeredMessage | undefined> => {
              if (steered.messages.at(-1)?.role !== 'tool') {
                return undefined;
              }
              throwIfAborted(signal);
              const message = await steer();
              throwIfAborted(signal);
              if (message !== undefined) {
                await this.takeSteered(steered, message);
              }
              return message;
            }
            : undefined;
          // Inside the attempt loop, so a retry after an overflow is asked
          // about like any other call. Outside the try: a refusal is not an
          // overflow to trim and retry, and the call it refused spent nothing.
          await this.guardProviderCall(session);
          announcedThrough = session.usage?.length ?? 0;
          try {
            response = await this.options.provider.generate({
              // The real session, always: providers persist it. The window
              // rides beside it.
              session,
              ...(window === floored && floored.length === session.messages.length ? {} : { messages: window }),
              ...(tools.length > 0 ? { tools } : {}),
              ...(wrappingUp && tools.length > 0 ? { toolChoice: 'none' as const } : {}),
              ...(injected.length > 0 || memory.topics.length > 0 ? { memory } : {}),
              ...(enabledSkills.length > 0 ? { skills: enabledSkills } : {}),
              ...(runtime !== undefined ? { runtime } : {}),
              ...(this.streaming ? { onDelta } : {}),
              ...(this.options.autoContinue !== undefined
                ? {
                  // The same grant the loop below makes, for a provider
                  // whose loop is its own.
                  mayContinue: () => {
                    if (!this.mayContinue(session.id, continued)) {
                      return false;
                    }
                    continued += 1;
                    void this.bus.emit({ type: 'session.continued', sessionId: session.id, continuation: continued, turns: this.maxTurns });
                    return true;
                  },
                }
                : {}),
              ...(hostedSteer !== undefined ? { steer: hostedSteer } : {}),
              onUsage,
              guardCall,
              ...(signal ? { signal } : {}),
            });
            // Recorded before the abort check below, deliberately: a turn
            // cancelled between the response arriving and this loop
            // noticing still spent those tokens, and the catch that ends
            // the turn saves the session.
            if (!sinkReported && response.usage) {
              this.recordUsage(session, turnId, response.usage);
            }
            await announcePending();
            break;
          } catch (error) {
            // Before anything else the failure does: an attempt that threw
            // after reporting through the sink spent those tokens, and a
            // guard judging the next call has to have seen them.
            await announcePending();
            // Not an overflow, or nothing left to drop: the turn fails, and
            // the message says which — a single turn too big for the model
            // is a different problem from a conversation that got long, and
            // the remedies do not overlap.
            if (!(error instanceof ContextOverflowError)) {
              throw error;
            }
            throwIfAborted(signal);
            const before = contextFloorOf(session);
            // Where the window began before this rise: the summary covers
            // from there, or from where the stored one ends.
            const shownFrom = before === 0 ? 0 : nextTurnBoundary(session.messages, before) ?? before;
            const floor = nextContextFloor(session);
            if (floor === undefined) {
              throw new Error(
                `${error.message} The newest turn on its own is already larger than this model can read, `
                + 'so dropping earlier messages cannot help: shorten the message, cut the tool output it '
                + 'carries, or move to a model with a bigger context window.',
              );
            }
            // Whatever the abandoned attempt streamed has to be discarded,
            // or a renderer fuses the two answers — the same contract the
            // fallback wrapper's reset delta honours. Before the summary,
            // which can take a while and has nothing of its own to show.
            if (this.streaming) {
              await onDelta({ type: 'reset', reason: 'retry' });
            }
            const summary = await this.summarizeCut(session, shownFrom, floor, turnId, signal, this.streaming ? onDelta : undefined);
            // The floor and its summary land together, after the summary
            // settles and never ahead of it (see `summarizeCut`): a daemon
            // that dies during the summary, or a turn stopped or refused
            // there, pays that rejected call again and gets a summary for
            // it, rather than coming back to a cut nothing covers.
            session.metadata = {
              ...(session.metadata ?? {}),
              [CONTEXT_FLOOR_METADATA_KEY]: floor,
              ...(summary !== undefined ? { [CONTEXT_SUMMARY_METADATA_KEY]: { ...summary } } : {}),
            };
            // Durable before the retry, not after it. A daemon that dies
            // mid-recovery must not come back and replay the request that
            // was just refused; the floor is the one thing learned here and
            // it costs a rejected call to learn again.
            await this.store.save(session);
            await this.bus.emit({
              type: 'session.context-trimmed',
              sessionId: session.id,
              droppedMessages: floor - before,
              floor,
              summarized: summary !== undefined,
            });
          }
        }
        throwIfAborted(signal);
        await deltaChain;
        // A turn that may stay quiet said so with the marker: from here on
        // it is the silence an empty answer is, before anything records,
        // announces or posts it (card 601).
        // A reaction named with it is kept for the silence recorded below,
        // on a turn whose message was said to the agent and only there: an
        // overheard one was never offered one (card 1078).
        const silent = isReplyOptionalTurn(session) ? noReplyAnswerOf(response) : undefined;
        const reaction = silent !== undefined && !isUnaddressedTurn(session) ? silent.reaction : undefined;
        if (silent !== undefined) {
          response = { ...response, parts: [] };
        }
        // Checked before anything of the response is saved: a call made on
        // the turn that may not make one is never run, and recording it
        // would leave a call in the transcript with no result to answer it.
        if (wrappingUp && response.parts.some((part) => part.type === 'tool-call')) {
          throw new Error(stuck ? repeatedFailureMessage(stuck.toolName, stuck.times) : turnLimitMessage(this.maxTurns));
        }

        // Record and SAVE the entire response — text and every tool call —
        // before anything else happens with it. Two consumers depend on
        // that order: provider replay state (the Anthropic raw-turn cache)
        // carries the complete response, so a partially persisted call set
        // would replay tool_use blocks that resume-time reconciliation
        // cannot answer; and provider.response subscribers may publish the
        // answer externally (a channel edit) the moment the event fires —
        // an answer a user has seen must already be durable, or a crash
        // resumes with history that contradicts what was delivered.
        const calls: ToolCall[] = [];
        for (const part of response.parts) {
          if (part.type === 'text') {
            session.messages.push({
              id: `${session.id}:assistant:${session.messages.length + 1}`,
              role: 'assistant',
              content: part.text,
              createdAt: new Date().toISOString(),
            });
            continue;
          }
          calls.push(part.call);
          session.messages.push({
            id: `${session.id}:assistant:${session.messages.length + 1}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            toolCalls: [part.call],
          });
        }
        if (response.parts.length === 0) {
          // Silence, recorded. Only a turn that may stay quiet ends this
          // way (`isReplyOptionalTurn`: one nobody asked for, or one whose
          // message may need nothing back) — every provider refuses an
          // empty answer on any other, and the marker became this above —
          // and the decision has to leave a mark: a harness holding its own
          // history is sent every user message since the agent last spoke
          // (`latestUserMessagePrompt`), and without an assistant message
          // here the message this turn already judged would go again on
          // the next one, and again on the one after that. Empty text is
          // no reply (`latestTurnReply`) and no speaking (`lastSpokeAt`);
          // it is the boundary of a turn that happened.
          session.messages.push({
            id: `${session.id}:assistant:${session.messages.length + 1}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            ...(reaction !== undefined ? { reaction } : {}),
          });
        }
        // Saved with the answer it describes, so a restart that finishes
        // this turn (`continueTurn`) still announces it. A wrap-up never
        // holds a call: that was refused above.
        const stoppedEarly = stuck !== undefined
          ? 'repeated-failure'
          : wrappingUp
            ? 'turn-limit'
            // Only on an answer: a response still calling tools has not
            // wrapped anything up, whatever it claims.
            : calls.length === 0 && isStoppedEarlyReason(response.stoppedEarly) ? response.stoppedEarly : undefined;
        if (stoppedEarly !== undefined) {
          session.stoppedEarly = { reason: stoppedEarly, continuations: continued, at: new Date().toISOString() };
        }
        const sawToolCall = calls.length > 0;
        await this.store.save(session);
        await this.bus.emit({ type: 'provider.response', sessionId: session.id, parts: response.parts });

        const results = await this.runToolCalls(session, calls, signal, undefined, turn);

        if (!sawToolCall) {
          break;
        }

        countFailures(calls, results);
      }

      return await this.completeTurn(session);
    } catch (caught) {
      // An abort can surface first from any layer (the provider's cancelled
      // request, an executor, this loop's own checks) — normalize so an
      // aborted turn is always distinguishable from a genuine failure, and
      // so the aborter's own reason wins over whichever layer noticed first.
      const error = signal?.aborted
        ? (signal.reason instanceof RunAbortedError || !(caught instanceof RunAbortedError)
            ? abortErrorFor(signal)
            : caught)
        : caught;
      if (leftForNextStart(session, error)) {
        // A planned stop of a keyed turn: saved as it stands and still
        // `running`, which is how the next start finds a turn to continue.
        // No failure is recorded or announced; its caller hears the throw.
        await this.store.save(session);
        throw error;
      }
      const lastError = error instanceof Error ? error.message : String(error);
      // Read off what the provider threw, not the normalized error: an
      // abort replaces it with a fresh `RunAbortedError`, and a harness
      // cancelled mid-turn — the watchdog's doing, most often — has the
      // prompt just the same.
      if (promptWasDelivered(caught) && isUnaddressedTurn(session)) {
        // A turn nobody asked for whose prompt the harness took before it
        // failed: the boundary goes in as if it had ended in silence, or
        // `latestUserMessagePrompt` would send the harness this message
        // again next time — the same double send the empty-answer
        // boundary above closes, on the failure path. Only for such a
        // turn: an addressed one that failed is retried by its sender
        // with a new message, which is then the newest and the only one
        // sent, as it always was.
        //
        // Known open case: overheard messages batched ahead of an
        // addressed message, in a turn the harness took and then failed.
        // No boundary goes in for it, so on the sender's retry
        // `latestUserMessagePrompt` still sees those overheard messages as
        // unheard and sends them again. The delivery mark is there for a
        // fix; what the boundary should be for an addressed turn is not
        // decided.
        session.messages.push({
          id: `${session.id}:assistant:${session.messages.length + 1}`,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
        });
      }
      recordTurnFailure(session, lastError);
      await this.store.save(session);
      const stored = await this.store.get(session.id);
      session = stored ?? session;
      await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });
      await this.bus.emit({
        type: 'session.failed',
        sessionId: session.id,
        error: lastError,
        ...(error instanceof HostRefusalError ? { refused: true as const } : {}),
      });
      throw error;
    }
  }

  /**
   * Records a message that reached a running turn (`RunInput.steer`): its
   * keys on the turn's message, its text as a `steered` user message, its
   * sender's trust on the session — in one save, before the provider sees
   * it, so a key is never durable without the message it brought.
   */
  private async takeSteered(session: Session, steered: SteeredMessage): Promise<void> {
    const opening = turnMessageOf(session);
    const keys = (steered.keys ?? []).filter((key) => opening !== undefined && !carriesKey(opening, key));
    if (opening !== undefined && keys.length > 0) {
      opening.absorbedKeys = [...(opening.absorbedKeys ?? []), ...keys];
    }
    session.messages.push({
      id: `${session.id}:user:${session.messages.length + 1}`,
      role: 'user',
      content: steered.userMessage,
      createdAt: new Date().toISOString(),
      ...userImages(steered.images),
      steered: true,
    });
    omitImagesOutsideReplayBudget(session.messages, this.imageReplayBudget);
    await this.taint(session, senderTrustOf(steered.metadata), 'sender');
    await this.store.save(session);
  }

  /** Whether a message out of budget gets another; see `AgentRunnerOptions.autoContinue`. */
  private mayContinue(sessionId: string, continued: number): boolean {
    const autoContinue = this.options.autoContinue;
    // A budget of nothing renews to nothing, forever: never renewed.
    if (autoContinue === undefined || this.maxTurns < 1 || (autoContinue !== true && continued >= autoContinue)) {
      return false;
    }
    return this.options.waitingInput?.(sessionId) !== true;
  }

  /** See `completeAnsweredTurn`; the loop's end and `continueTurn`'s. */
  private async completeTurn(finished: Session): Promise<Session> {
    return completeAnsweredTurn(finished, this.store, this.bus);
  }

  /**
   * Finishes a turn that was parked on a human when the process died.
   *
   * This is the one path allowed to re-enter a tool call rather than close
   * it as interrupted, and the checkpoint is what earns that: approval
   * happens strictly before execution, so a call carrying the record
   * provably never started. `resume()`'s reconciliation must not run first
   * — it would answer the parked call with "may not have run to
   * completion" and strand the queue behind it.
   *
   * Returns undefined when the session is not parked, so a caller sweeping
   * the store does not have to pre-filter.
   */
  async recoverPendingApproval(
    sessionId: string,
    options: {
      /**
       * Refuse the parked call without asking — its deadline passed while
       * the process was down. The calls queued behind it were never asked
       * about at all, so they still face the policy normally.
       */
      denyPending?: boolean;
      /** See `RunInput.runtime`. */
      runtime?: AgentRuntimeContext;
      signal?: AbortSignal;
    } = {},
  ): Promise<Session | undefined> {
    const session = await this.store.get(sessionId);
    if (!session) {
      return undefined;
    }
    const record = readPendingApproval(session);
    if (!record) {
      return undefined;
    }
    // A turn parked before provenance was tracked is still a pre-upgrade
    // transcript; the save that records its result carries the label.
    await this.labelLegacySession(session);

    const pending = record.call;
    const remaining = record.remaining;

    // The checkpoint deliberately stays put here. Clearing it before the
    // recovered wait is durably re-established leaves a window in which the
    // session reads as `running` with the approval still unanswered — a
    // daemon that dies inside it is skipped by the next sweep, and the call
    // is later closed as interrupted rather than recovered. Re-parking
    // overwrites it; answering retires it, in the same save as the result.
    if (options.denyPending) {
      // Written exactly as executeToolCall would have written a refusal,
      // so a turn denied by an expired deadline is indistinguishable
      // downstream from one denied by a person — and the queue behind it
      // still drains, leaving no `tool_use` without a `tool_result`.
      const result: ToolResult = {
        callId: pending.id,
        toolName: pending.toolName,
        ok: false,
        output: null,
        error: `Tool call denied by approval policy: ${pending.toolName}`,
        trust: 'agent',
      };
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call: pending });
      // Result and retirement in one write: a crash between them would
      // either re-deny an answered call or lose the denial.
      await this.recordToolResult(session, result);
        return this.executeTurns(session, options.signal, {
          pending: undefined,
          remaining,
          turn: record.turn,
          answered: { call: pending, result },
        }, options.runtime);
    }

    return this.executeTurns(session, options.signal, {
      pending,
      remaining,
      parkedAt: record.parkedAt,
      turn: record.turn,
    }, options.runtime);
  }

  /**
   * Records one tool result — and, in the *same* save, retires the
   * checkpoint if it was for this call.
   *
   * Two writes would leave a window where the result is durable and the
   * record is not (a later sweep re-executes an answered call) or the other
   * way round. Since a call with a recorded result is by definition no
   * longer re-enterable, the two facts belong in one write.
   */
  private async recordToolResult(session: Session, result: ToolResult): Promise<void> {
    session.messages.push(toolResultMessage(session, result));
    omitImagesOutsideReplayBudget(session.messages, this.imageReplayBudget);

    if (readPendingApproval(session)?.call.id === result.callId) {
      const metadata = { ...(session.metadata ?? {}) };
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
      session.metadata = metadata;
      session.status = 'running';
    }

    await this.store.save(session);
  }

  /**
   * Runs a response's tool calls in order, recording each result as it
   * lands — except that consecutive read-only calls run together
   * (`Tool.readOnly`, `runTogether`). Shared by the normal path and by
   * recovery, so a resumed turn writes exactly what an uninterrupted one
   * would.
   */
  private async runToolCalls(
    session: Session,
    calls: ToolCall[],
    signal?: AbortSignal,
    /**
     * The original park time, when these calls come from a recovered turn.
     * Applies to the first call only — it is the one that was already
     * waiting; anything behind it has not been asked about yet.
     */
    parkedAt?: string,
    turn = 1,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    let index = 0;
    while (index < calls.length) {
      throwIfAborted(signal);
      let end = index;
      while (end < calls.length && end - index < READ_ONLY_CALLS_AT_ONCE && this.runsAlongside(calls[end]!)) {
        end += 1;
      }
      if (end - index > 1) {
        results.push(...await this.runTogether(session, calls.slice(index, end), signal, turn));
        index = end;
        continue;
      }
      const call = calls[index]!;
      const result = await this.executeToolCall(session, call, {
        ...(signal ? { signal } : {}),
        remaining: calls.slice(index + 1),
        turn,
        ...(index === 0 && parkedAt ? { parkedAt } : {}),
      });

      // The result lands immediately after execution, so side effects
      // are never durable without their record.
      await this.recordToolResult(session, result);
      results.push(result);
      index += 1;
    }
    return results;
  }

  /** See `Tool.readOnly`: what may run alongside its neighbours. */
  private runsAlongside(call: ToolCall): boolean {
    const tool = this.tools.get(call.toolName);
    return tool !== undefined
      && tool.readOnly === true
      && resolveToolRisk(tool) === 'safe'
      && tool.trustBeforeCall === undefined
      && tool.riskAfterExternalContent === undefined;
  }

  /**
   * Runs consecutive read-only calls at once and records their results in
   * the order they were asked for, each as soon as it and every call ahead
   * of it have landed. So the saved transcript only ever holds a prefix of
   * the batch, the same shape one-at-a-time running leaves: a crash closes
   * the rest as interrupted, in order (`reconcileInterruptedToolCalls`),
   * and nothing reruns — read-only, so nothing was half done.
   *
   * Every call settles before this returns or throws, a stopped one
   * included (`untilStoppedFor` bounds it), so no tool of a finished turn
   * is still running. A call that throws rather than answering (an
   * approval policy that failed), or a result the store cannot save,
   * fails the turn, as it would have alone; the results ahead of it stay
   * recorded, and those behind it are dropped and closed as interrupted,
   * which keeps the prefix.
   */
  private async runTogether(
    session: Session,
    calls: ToolCall[],
    signal: AbortSignal | undefined,
    turn: number,
  ): Promise<ToolResult[]> {
    // Settled into values up front: a call that throws while an earlier
    // one is still being awaited must not be an unhandled rejection.
    const running = calls.map((call) => this.executeToolCall(session, call, {
      ...(signal ? { signal } : {}),
      turn,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ));
    const results: ToolResult[] = [];
    let failure: { error: unknown } | undefined;
    for (const pending of running) {
      const settled = await pending;
      if (failure !== undefined) {
        continue;
      }
      if ('error' in settled) {
        failure = settled;
        continue;
      }
      // A save that fails ends the turn the same way, after the drain: the
      // calls behind it are already running.
      try {
        await this.recordToolResult(session, settled.result);
      } catch (error) {
        failure = { error };
        continue;
      }
      results.push(settled.result);
    }
    if (failure !== undefined) {
      throw failure.error;
    }
    return results;
  }

  /**
   * Executes one tool call with this runner's allowlist, approval policy,
   * events, and executor — for providers that drive their own inner loop
   * (e.g. the Claude Code runtime) but must run Stratus tools exactly as
   * if the kernel loop had called them.
   */
  async executeHostedToolCall(session: Session, call: ToolCall, context?: ExecutionContext): Promise<ToolResult> {
    // Persistence is part of this seam's contract, not a courtesy: a
    // provider-driven loop consumes tool results internally and returns
    // only final text, so without recording here the durable session would
    // omit every hosted tool action — including its side effects. The
    // paired messages match what the kernel loop writes, in the same
    // order: the call is saved before it runs and the result immediately
    // after, so a daemon killed mid-tool never holds a session whose side
    // effects happened without a recorded attempt.
    session.messages.push({
      id: `${session.id}:assistant:${session.messages.length + 1}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [call],
    });
    await this.store.save(session);

    // Not recoverable: this result is consumed by the hosting provider's
    // own loop, which a restart cannot rebuild. See the option's docs.
    const result = await this.executeToolCall(session, call, {
      ...(context?.signal ? { signal: context.signal } : {}),
      recoverable: false,
    });

    session.messages.push(toolResultMessage(session, result));
    omitImagesOutsideReplayBudget(session.messages, this.imageReplayBudget);
    await this.store.save(session);

    return result;
  }

  /**
   * Marks the turn parked, durably, for the window in which nothing has
   * happened yet — and unmarks it the instant a decision arrives, before
   * the tool runs. A crash inside that window is recoverable exactly; a
   * crash outside it is not, and must stay indistinguishable from any other
   * interrupted call.
   */
  private async checkpointPendingApproval(
    session: Session,
    record: PendingApprovalRecord | undefined,
  ): Promise<void> {
    const metadata = { ...(session.metadata ?? {}) };
    if (record) {
      metadata[PENDING_APPROVAL_METADATA_KEY] = record as unknown as JsonObject;
    } else {
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
    }
    session.metadata = metadata;
    session.status = record ? 'pending_approval' : 'running';
    // Saved, not announced. The durable status exists so a restarting
    // daemon can find this turn; live consumers already get
    // tool.approval-requested and tool.approval-resolved, which say the
    // same thing with the call and the risk attached. Emitting here would
    // add two session.updated events to every gated call and tell nobody
    // anything they were not told better.
    await this.store.save(session);
  }

  private async executeToolCall(
    session: Session,
    call: ToolCall,
    options: {
      signal?: AbortSignal;
      /**
       * The calls queued behind this one in the same response. Recorded on
       * the checkpoint so a recovering daemon can finish the response
       * rather than leaving its later `tool_use` blocks unanswered.
       */
      remaining?: ToolCall[];
      /**
       * Whether a parked wait here is a checkpoint a restart may re-enter.
       *
       * False for a provider that drives its own inner loop. Recovery
       * re-enters the *kernel* loop, which can only continue a turn whose
       * next step is a kernel provider call — it cannot reconstruct an SDK
       * inner loop or the handler that was waiting to consume this result.
       * Checkpointing such a call would have a restart execute it and then
       * continue from a state the hosting provider never produced. 04 makes
       * that explicit: the SDK path is excluded from the resume-the-exact-
       * call guarantee and must fail cleanly instead, with the pending call
       * never executed. No checkpoint is exactly that failure — the call is
       * closed as interrupted like any other dangling one.
       */
      recoverable?: boolean;
      /**
       * When this wait began, if it began before a restart. Preserved so a
       * window is measured from the original park rather than restarted on
       * every recovery.
       */
      parkedAt?: string;
      /** The provider turn these calls came from, for the checkpoint. */
      turn?: number;
    } = {},
  ): Promise<ToolResult> {
    const { signal, remaining = [] } = options;
    // Every tool call settles with exactly one event — tool.completed
    // (executed or rejected, the result says which) or tool.denied. Event
    // consumers tracking a response's outstanding calls (the gateway's
    // phase-aware watchdog) count on rejected calls settling too.
    const rejected = async (error: string): Promise<ToolResult> => {
      const result: ToolResult = {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error,
        // Refusals are the kernel's own text. Every result the runner writes
        // itself is `agent`; only what an executor returns can be anything
        // else, and a result with no label at all reads `unknown`.
        trust: 'agent',
      };
      await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
      return result;
    };

    // Gate 2 of two for skill.read, independent of gate 1 on purpose: this
    // path also serves providers hosting their own loop, and a model can
    // call the reader by name without it having been advertised. The
    // exemption keys on the same fact — the agent has a skill enabled — so
    // the reader is never a tool the agent can see, is told to use, and is
    // refused when it uses. Which skill may then be read is the `skills:`
    // allowlist, enforced inside the tool itself.
    const allowedTools = this.allowedToolsFor(session);
    if (call.toolName === SKILL_READ_TOOL_NAME) {
      if (this.enabledSkillsFor(session).length === 0) {
        return rejected(`Tool not permitted for agent ${session.agent.id}: ${call.toolName} (no skills enabled)`);
      }
    } else if (!this.toolPermitted(call.toolName, allowedTools)) {
      return rejected(allowedTools === undefined
        ? `Tool not permitted for agent ${session.agent.id}: ${call.toolName} (the soul has no tools: list, so it gets only safe tools; add the tool to a tools: list in the soul to grant it)`
        : `Tool not permitted for agent ${session.agent.id}: ${call.toolName}`);
    }

    // Resolved before the policy is asked, not after: a policy classifies
    // an invocation by the tool's declared risk, and a call name is not
    // enough to look that up on the policy's side. It also stops an unknown
    // tool from reaching a human — a call naming nothing registered is a
    // model mistake, and prompting someone to approve it is noise.
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return rejected(`Tool not found: ${call.toolName}`);
    }

    // A malformed call is answered before anyone is asked about it, for the
    // reason an unknown tool is: approving a call the tool will reject is a
    // question with no useful answer, and the model needs the reason, not a
    // human's click, to fix it. Only for calls that would be asked about; a
    // `safe` tool's own checks answer it as they always have.
    // Resolved once, before the policy is asked: the session's label is
    // what the calls before this one left it at, which is what a tool's
    // `riskAfterExternalContent` is judged against.
    const risk = resolveCallRisk(tool, session);
    if (risk !== 'safe') {
      const problem = inputProblem(tool.parameters, call.input);
      if (problem) {
        return rejected(`Invalid input for ${call.toolName}: ${problem}. Fix the call and try again.`);
      }
      // A call the tool already knows it will refuse, answered here for the
      // same reason: nobody should be asked to approve it. A hook that
      // throws is no answer, and the call goes on to be judged as before.
      let refusal: string | undefined;
      try {
        refusal = await tool.refusalFor?.(call.input, session);
      } catch {
        refusal = undefined;
      }
      if (typeof refusal === 'string' && refusal.trim().length > 0) {
        return rejected(refusal.trim());
      }
    }

    // Only a call that can actually be held for a human is checkpointed:
    // a `safe` one is never asked about, and writing a record for it would
    // add a save to every unattended call to describe a wait that does not
    // happen.
    // Asked about either way — only whether the wait leaves a re-enterable
    // checkpoint differs.
    const checkpointed = risk !== 'safe' && options.recoverable !== false;
    if (checkpointed) {
      await this.checkpointPendingApproval(session, {
        call,
        remaining,
        turn: options.turn ?? 1,
        parkedAt: options.parkedAt ?? new Date().toISOString(),
      });
    }

    /**
     * Where this call was judged, captured the instant the policy answered.
     *
     * `Tool.originFor` says a call is judged by the page its conversation
     * is on, and the approval is not the last thing between that judgement
     * and the act: clearing the checkpoint is a store write, and
     * `tool.called` is delivered to every subscriber, awaited, before the
     * executor is reached. A page that navigates inside all that would be
     * clicked on having been judged somewhere else, and the policy's own
     * re-read cannot see past its own return. So the seam's contract is
     * enforced where the dispatch happens, which is the only place that
     * can — read again below, immediately before the executor.
     *
     * Read *after* the policy rather than before it, and that is not a
     * detail: a policy judges the page as it stands when it decides, which
     * is deliberately after it has loaded whatever grants it consults. A
     * snapshot taken before the call would disagree with the answer for
     * every page that moved during that load, and would refuse an action
     * the policy had just correctly allowed. Nothing awaits between the
     * policy's return and this line, so the two agree by construction.
     *
     * A tool that does not answer this reads `undefined` both times and is
     * unaffected.
     */
    let originWhenJudged: string | undefined;

    // What the call may read, lowered into the session before the policy
    // reads the session's label, so the decision covers this call and not
    // only the next one. Asked again after an approval, because a human's
    // answer can take minutes and the label can drop in that time; one
    // re-decision, then a refusal, so a label that keeps moving cannot
    // hold the call in a loop of questions.
    const lowerBeforeCall = async (): Promise<TrustLevel | undefined> => {
      if (!tool.trustBeforeCall) {
        return undefined;
      }
      const label = await trustBeforeCallOf(tool, session);
      if (label !== undefined) {
        await this.taint(session, label, call.toolName);
      }
      return label;
    };

    let approved: boolean;
    /** The policy's reason for its last "no", when it gave one. */
    let refusal: string | undefined;
    let decidedTrust: TrustLevel = sessionTrustOf(session);
    let movedTwice = false;
    try {
      await lowerBeforeCall();
      const decide = async (): Promise<boolean> => {
        decidedTrust = sessionTrustOf(session);
        // Reports made while the policy decides wait for its answer, so a
        // surface reads the decision before the call it is about; one made
        // after (worked out off the call path) goes out when it is made.
        const reported: StratusEvent[] = [];
        let answered = false;
        const decided = (decision: ApprovalDecision): void => {
          const event = permissionDecidedEvent(session, call, risk, decision);
          if (answered) {
            void this.bus.emit(event);
          } else {
            reported.push(event);
          }
        };
        let answer: boolean | ApprovalRefusal;
        try {
          answer = await this.approvals.approve({
            session,
            call,
            tool,
            risk,
            ...(signal ? { signal } : {}),
            ...(options.parkedAt ? { parkedAt: options.parkedAt } : {}),
            decided,
          });
        } finally {
          answered = true;
        }
        // With nothing awaited since the policy returned (see above).
        originWhenJudged = originForSession(tool, session, call.input);
        for (const event of reported) {
          await this.bus.emit(event);
        }
        // Only `true` runs. An object is a refusal now, so reading any
        // truthy answer as a yes, as a plain-JavaScript policy once could,
        // would run the very call it refused.
        refusal = answer === true ? undefined : refusalReasonOf(answer);
        return answer === true;
      };
      approved = await decide();
      if (approved && tool.trustBeforeCall) {
        const dropped = async (): Promise<boolean> => {
          const label = await lowerBeforeCall();
          return label !== undefined && leastTrusted(decidedTrust, label) !== decidedTrust;
        };
        if (await dropped()) {
          approved = await decide();
          movedTwice = approved && await dropped();
        }
      }
    } finally {
      // Cleared before anything executes and on every exit — an abort that
      // throws out of the policy must not leave the session looking parked
      // on a question nobody is waiting for.
      if (checkpointed) {
        await this.checkpointPendingApproval(session, undefined);
      }
    }

    if (movedTwice) {
      const why = 'what it may read was marked less trusted twice while it was being approved';
      // The policy reported its yeses; this "no" is the runner's, and it is
      // the one that stands, so it goes out last, ahead of the denial.
      await this.bus.emit(permissionDecidedEvent(session, call, risk, {
        allowed: false,
        layer: 'trust',
        reason: `${call.toolName} did not run: ${why}`,
      }));
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call });
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `${call.toolName} did not run: ${why}. Call again to have it judged as things stand now.`,
        trust: 'agent',
      };
    }

    if (!approved) {
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call });
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        // With no policy there is nobody whose "no" this was, and the fix
        // is in the app's code, not in anything the agent can do.
        error: this.options.approvals === undefined
          ? `${call.toolName} did not run: ${risk === resolveToolRisk(tool)
            ? `it is a ${risk} tool`
            : `it counts as a ${risk} tool once a conversation has read external content`}, `
            + 'and this runner was built with no `approvals` policy, '
            + 'so only safe tools run. The app that builds the runner passes one to allow it; '
            + 'AllowAllApprovalPolicy runs every call without asking.'
          : refusal ?? `Tool call denied by approval policy: ${call.toolName}`,
        // A policy's reason may name what the call was about, and the call
        // was composed in this conversation, so it is labeled no more
        // trusted than the conversation already is.
        trust: refusal === undefined ? 'agent' : leastTrusted('agent', sessionTrustOf(session)),
      };
    }

    throwIfAborted(signal);
    await this.bus.emit({ type: 'tool.called', sessionId: session.id, call });

    // The last thing before the executor, and after the emission above
    // rather than before it, because that emission is itself a wait on
    // whatever the host subscribed. A refusal here is a failed result, not
    // a denial: `tool.called` has been announced, and settling it with
    // `tool.completed` keeps the pairing every consumer reads — the
    // watchdog's phase, the channel's live line. The agent is told plainly,
    // because this is a page that moved rather than a permission it lacks.
    const originNow = originForSession(tool, session, call.input);
    if (originNow !== originWhenJudged) {
      const result: ToolResult = {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `${call.toolName} was judged on ${originWhenJudged ?? 'a page with no origin'} and this `
          + `conversation is now on ${originNow ?? 'no page'}, so it did not run. `
          + 'Check where the page is and call again.',
        trust: 'agent',
      };
      await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
      return result;
    }

    const collector = createImageCollector();
    const executed = await untilStoppedFor(this.executor.execute(call, tool, session, {
      ...(signal ? { signal } : {}),
      decidedTrust,
      attachImage: collector.attach,
    }), call, signal);
    // Only a call that succeeded shows what it attached: a failure's error
    // is the result, and an image ahead of it would read as the answer.
    const attached = executed.ok ? collector.images() : [];
    const result: ToolResult = attached.length > 0 ? { ...executed, images: attached } : withoutImages(executed);
    // Where tools execute, not in the provider loop above: this path also
    // serves `executeHostedToolCall`, through which `provider-claude-code`
    // and `provider-codex` run their bridged kernel tools. A hook in
    // `runToolCalls` would never fire for either, and a label that is
    // absent for every subscription-path agent is worse than one that is
    // wrong. An executor that returned no label is read as `unknown` —
    // absence of provenance is not evidence of trust, here either.
    await this.taint(session, result.trust ?? 'unknown', call.toolName);
    await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result: withoutImages(result) });
    return result;
  }
}
