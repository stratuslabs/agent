/*
 * The provider contract: the parts and deltas a model streams, token usage
 * and how it is recorded, the runtime and conversation context a call
 * carries, the request and response, ModelProvider itself and the call
 * guard. A module of its own because every provider adapter builds against
 * it. `index.ts` re-exports every public name, so the package's one public
 * entry is unchanged.
 */
import {
  type JsonObject,
  type MemoryEntry,
  type MemoryInjection,
  type Message,
  type Session,
  type SkillDescriptor,
  type SteeredMessage,
  type ToolCall,
  type ToolDescriptor,
} from './index.ts';

export type ProviderPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall };

/**
 * A streamed fragment of an in-progress provider response. Text deltas carry
 * output as it is generated; tool-call deltas announce that the model has
 * started emitting a call (input may still be incomplete); thinking and
 * progress deltas carry nothing but the fact of activity. A reset delta
 * tells consumers to DISCARD every fragment streamed so far for this
 * response — emitted when a provider abandons a partial attempt (e.g. a
 * fallback wrapper retrying after the primary failed mid-stream), so
 * renderers never fuse two attempts into one message.
 */
export type ProviderDelta =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; inputFragment?: string }
  /**
   * The model is reasoning: a content-free progress signal so activity
   * watchdogs see a healthy turn during long thinking stretches. The
   * reasoning itself is deliberately never carried here.
   */
  | { type: 'thinking' }
  /**
   * The provider is working on this response and has nothing to show for
   * it yet: a retry it is waiting out, a context compaction, a message
   * boundary. Content-free like `thinking`, and for the same reader — an
   * activity watchdog that would otherwise take a busy provider for a
   * stalled one. A renderer has nothing to draw for it.
   */
  | { type: 'progress' }
  | {
      type: 'reset';
      /**
       * Why the partial was abandoned.
       *
       * `fallback` means a *different provider* is now serving this turn,
       * and is the only case in which anything about the active provider
       * changed. Everything else is the same provider starting over — a
       * retried attempt after a failed resume, say — and a consumer that
       * tracks which provider is running must not treat it as a switch.
       *
       * Absent reads as `retry`, deliberately: the conservative answer for
       * an emitter that has not thought about it is "nothing changed", not
       * "the provider swapped underneath you".
       */
      reason?: 'fallback' | 'retry';
    };

/**
 * What one provider call consumed, in the four buckets every vendor
 * distinguishes and a price table charges separately for.
 *
 * Every count is optional and **absent means "not reported"**, never zero:
 * zero is a measurement, and a fabricated one would let a consumer state a
 * cost for a provider that said nothing about it.
 *
 * The buckets are **disjoint**. `inputTokens` is prompt input billed at the
 * full rate — cache reads and cache writes are counted in their own fields
 * and never again here. That is Anthropic's own shape; vendors that report
 * an all-inclusive prompt count (the OpenAI family's `prompt_tokens`, which
 * includes its cached tokens) are normalized to it by their adapter, with
 * `uncachedInputTokens` doing the subtraction so the rule has one
 * implementation. Records from two providers are directly comparable
 * because of it, which is the whole point of preserving attribution.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * One provider call's usage as the adapter reports it — the counts plus the
 * attribution only the adapter knows.
 *
 * `provider` defaults to the name of the provider the runner asked, which is
 * right for a plain adapter and **wrong under the fallback wrapper**: that
 * wrapper answers to the primary's name for the life of the session, so a
 * call the fallback actually served would be attributed to the primary. Every
 * adapter in this repository sets it explicitly, and the wrapper fills it in
 * for adapters that do not.
 *
 * `model` is absent rather than guessed when a harness switched models
 * internally and did not say which one ran.
 */
export interface ProviderCallUsage extends TokenUsage {
  provider?: string;
  model?: string;
}

/**
 * One provider call's usage, attributed. This is the *stored* form: a
 * session keeps the records, never a summed scalar.
 *
 * A thousand tokens of one model is not a thousand of another, input and
 * output are priced differently, cache reads and writes differ again, and
 * the fallback wrapper can cross providers inside one session. Collapsing
 * any of those at write time throws away what no downstream consumer can
 * reconstruct — so nothing is collapsed. `totalTokenUsage` derives a
 * convenience total, and that total is a view.
 */
export interface UsageRecord extends TokenUsage {
  /**
   * The Stratus turn these tokens belong to — one pass through the runner,
   * which is one provider call for the kernel-loop adapters and several for
   * a harness provider running its own inner loop.
   *
   * Part of the record rather than something to reconstruct: ordering does
   * not recover the boundaries once a harness turn contributes several
   * records of its own, and a durable session resumed across many turns
   * accumulates records that are otherwise indistinguishable the moment two
   * share a provider and model.
   */
  turnId: string;
  provider: string;
  model?: string;
  /**
   * Unique to this one provider call, assigned when the record is made and
   * saved with it. What lets a consumer that meters spend outside the
   * session (a usage ledger) count each call exactly once however many
   * times it sees it: from the `session.usage` announcement, and again from
   * the saved session after a crash that came between the save and the
   * announcement. Absent on records saved before it existed.
   */
  id?: string;
  /**
   * When the call's usage was recorded, ISO 8601. A consumer that learns of
   * a call late (reconciling a session after a crash) still files it under
   * the day it was spent. Absent on records saved before it existed.
   */
  at?: string;
}

/**
 * `TokenUsage.inputTokens` for a vendor that reports its prompt count
 * *inclusive* of the cache buckets, normalized to the exclusive form the
 * field promises.
 *
 * Floored at zero: the subtraction rests on a reading of each vendor's
 * accounting, and a negative token count would be a worse answer than a
 * slightly low one.
 */
export const uncachedInputTokens = (total: number, ...cached: Array<number | undefined>): number =>
  Math.max(0, total - cached.reduce<number>((sum, value) => sum + (value ?? 0), 0));

const TOKEN_USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/**
 * The counts a provider actually reported, with nothing else carried over.
 *
 * A key present but `undefined` says exactly what an absent key says, and
 * only one of the two survives a round trip through JSON — so the written
 * record keeps the absent form. Absence is load-bearing here.
 */
export const definedTokenCounts = (usage: TokenUsage): TokenUsage => {
  const counts: TokenUsage = {};
  for (const key of TOKEN_USAGE_KEYS) {
    const value = usage[key];
    if (value !== undefined) {
      counts[key] = value;
    }
  }
  return counts;
};

/**
 * The sum of a record set, as the convenience view a session may expose.
 *
 * Absence propagates: a bucket no record reported stays absent, so a total
 * never claims a zero nobody measured. Undefined when the records report
 * nothing at all.
 */
export const totalTokenUsage = (records: readonly TokenUsage[]): TokenUsage | undefined => {
  const total: TokenUsage = {};
  let reported = false;
  for (const key of TOKEN_USAGE_KEYS) {
    let sum: number | undefined;
    for (const record of records) {
      const value = record[key];
      if (value !== undefined) {
        sum = (sum ?? 0) + value;
      }
    }
    if (sum !== undefined) {
      total[key] = sum;
      reported = true;
    }
  }
  return reported ? total : undefined;
};

/**
 * Facts about how an agent is run that only the host knows, told to the
 * agent so it does not have to guess them.
 *
 * It does guess otherwise, and guesses wrong: an agent asked to reread its
 * soul after an edit answered that it had none, because there was no
 * `SOUL.md` in its workspace, which is where other agent runtimes keep one.
 * Handed in by the host rather than written into the soul because the
 * paths are the host's to own, and a copy in every soul would go stale the
 * next time the layout moved, the way the workspace already did once.
 */
export interface AgentRuntimeContext {
  /** Absolute path of the soul file this agent's persona was loaded from. */
  soulPath?: string;
  /**
   * True when the host reads the soul again before every turn, so an edit
   * reaches the agent's next reply. The daemon does; a one-shot run reads
   * it once, and leaving this out says nothing either way.
   */
  soulReloads?: boolean;
  /** Where this agent's files go: `AgentWorkspaces.forAgent`. */
  workspace?: string;
  /**
   * The language the agent writes in, as a tag `isLanguageTag` accepts,
   * already resolved by the host: the soul's `language:`, then the config
   * file's. Absent means {@link DEFAULT_LANGUAGE}. Rendered in the reply
   * section rather than here, so a host that says nothing else still gets
   * the default rule.
   */
  language?: string;
  /**
   * What the host has configured to answer as this agent, and what it has
   * observed: `onFallback` is true once this conversation has switched to
   * the fallback, which is sticky, so a model asked what it is can tell a
   * configured default from the one actually answering. The fallback
   * wrapper sets it on the request it hands the fallback mid-turn, so the
   * model that took over is not told it is the default.
   */
  model?: AgentModelContext;
  /**
   * Who can read this conversation, as the channel that carried the turn
   * reported it on the turn's metadata (`conversationContextFrom`). Per
   * turn rather than read off the session, so a thread that started before
   * this existed, or a channel that grew since, is described as it is now.
   */
  conversation?: ConversationContext;
}

/**
 * What kind of room a conversation is: one person, a few, a closed
 * channel, or one the whole workspace can read. An agent that did not
 * know told a person in a Slack DM they were "talking on the terminal",
 * and would have posted the same reply to a thousand-person channel.
 */
export type ConversationKind = 'direct' | 'group' | 'private' | 'public';

export interface ConversationContext {
  kind: ConversationKind;
  /** Members as the channel counts them, the agent included. */
  members?: number;
  /**
   * Who a direct message is with. It reaches the system prompt, so a
   * channel sets it only for someone the operator vouched for (a Slack
   * principal), never from a name anyone could have typed.
   */
  with?: string;
  /** The turn is a reply in a thread rather than the channel itself. */
  thread?: boolean;
  /**
   * The channel's id for the root of that thread (Slack: its `ts`), so a
   * schedule set from this conversation can report back into it rather
   * than at the top of the channel. Platform-assigned, never typed text.
   */
  threadRoot?: string;
  /**
   * People outside this workspace read it too: a Slack Connect channel,
   * or one shared across an organization's workspaces. Never set for a
   * direct message.
   */
  shared?: boolean;
  /**
   * The channel's own id for the room, such as Slack's `C0123456789`: what
   * `message.read` and `message.send` take, and what lets an agent say or
   * remember which room this is. Never set for a direct message, where the
   * id names nothing the agent can use elsewhere.
   */
  id?: string;
  // No channel name, deliberately: anyone who can create or rename a
  // channel chooses it, and this reaches the system prompt, where a name
  // like `ignore-all-previous-instructions` would outrank the soul. The
  // kind, the count, and the id are what it needs, and none of them is text
  // a person chose.
}

/**
 * The metadata key a channel adapter records a turn's room under: a
 * `ConversationContext`-shaped object, read back by
 * `conversationContextFrom`.
 */
export const CONVERSATION_METADATA_KEY = 'conversation';

const CONVERSATION_KINDS: readonly string[] = ['direct', 'group', 'private', 'public'];
// A principal's display name, which is what a channel may put in `with`:
// vouched for, but still typed, so anything that is not plainly a name is
// dropped rather than quoted.
const CONVERSATION_WITH_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'\u2019-]{0,63}$/u;
// A platform-assigned id, never a word anyone typed: Slack's are capitals
// and digits. Anything else is dropped rather than quoted.
const CONVERSATION_ID_PATTERN = /^[A-Z0-9]{6,32}$/;
// A thread root is a platform message id (Slack: `1791332967.606559`).
const CONVERSATION_THREAD_ROOT_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$/;

/**
 * The room a turn's metadata describes, keeping only what is safe to put
 * in front of the model, or undefined when it describes none.
 */
export const conversationContextFrom = (metadata: JsonObject | undefined): ConversationContext | undefined => {
  const raw = metadata?.[CONVERSATION_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const { kind, members, with: withWhom, thread, threadRoot, shared, id } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !CONVERSATION_KINDS.includes(kind)) {
    return undefined;
  }
  return {
    kind: kind as ConversationKind,
    ...(typeof members === 'number' && Number.isInteger(members) && members > 0 && members <= 10_000_000 ? { members } : {}),
    ...(kind === 'direct' && typeof withWhom === 'string' && CONVERSATION_WITH_PATTERN.test(withWhom.trim()) ? { with: withWhom.trim() } : {}),
    ...(thread === true ? { thread: true } : {}),
    ...(kind !== 'direct' && thread === true && typeof threadRoot === 'string' && CONVERSATION_THREAD_ROOT_PATTERN.test(threadRoot) ? { threadRoot } : {}),
    ...(kind !== 'direct' && shared === true ? { shared: true } : {}),
    ...(kind !== 'direct' && typeof id === 'string' && CONVERSATION_ID_PATTERN.test(id) ? { id } : {}),
  };
};

export interface AgentModelContext {
  provider: string;
  model?: string;
  fallback?: { provider: string; model: string };
  onFallback?: boolean;
}

export interface ProviderRequest {
  /**
   * The live session. **Persistable**: a provider that saves it, or hands
   * it to `executeHostedToolCall`, is writing the real conversation — so
   * this is always the whole session, never a view. Read the transcript
   * through `transcriptOf(request)` instead of from here.
   */
  session: Session;
  /**
   * The transcript to send, when it is not the whole of `session.messages`
   * — the tail left by the session's context floor, with a note in place
   * of what was cut.
   *
   * Separate from `session` because the two are used for different things
   * and only one of them may be written back. The harness providers pass
   * `request.session` to `executeHostedToolCall`, which appends tool
   * records and saves; the fallback wrapper persists `request.session` to
   * make its switch durable. Handing either a shortened *session* would
   * write the window over the stored transcript and lose everything below
   * the floor, permanently.
   *
   * Absent means "all of them", so an adapter that ignores this field
   * behaves exactly as it did — which is right for a harness provider,
   * since it manages its own context and the window is not its to apply.
   */
  messages?: readonly Message[];
  tools?: ToolDescriptor[];
  /**
   * `none` asks for an answer in words: the tools stay declared, because
   * the history holds calls to them and an API that is sent tool calls
   * with no tools to match refuses the request, but the model may not
   * call one. Sent on the turn that wraps up a message which has used its
   * `maxTurns` (see `TURN_LIMIT_NOTE`).
   *
   * Optional to honour. A provider that ignores it sends a request the
   * model may still answer with a call, and the runner then fails the turn
   * the way it did before wrap-up existed, rather than run the call.
   */
  toolChoice?: 'none';
  /**
   * Agent-scoped long-term memory as the turn injects it: the pinned core,
   * the topic index, and the recency tail. A bare array is the tail alone —
   * what `memory` meant before the three blocks existed, and still what a
   * host building a request by hand may pass.
   */
  memory?: MemoryEntry[] | MemoryInjection;
  /**
   * The skills enabled for this agent — descriptors only, one prompt line
   * each. Bodies never travel here; they arrive through `skill.read` when
   * the model decides a description is relevant.
   */
  skills?: SkillDescriptor[];
  /**
   * What the host can say about how this agent is run: where its soul and
   * workspace are. Rendered as the `runtime` section; see
   * {@link AgentRuntimeContext}.
   */
  runtime?: AgentRuntimeContext;
  /**
   * Streaming sink. Adapters that stream call this per fragment and MUST
   * await the returned promise before the next call (backpressure); the
   * runner drains every pending delta before emitting the final
   * provider.response, so a delta can never arrive after the response.
   * A single-promise generate() cannot stream on its own — this is the
   * provider-to-runner streaming contract. Optional on both sides:
   * non-streaming adapters ignore it.
   */
  onDelta?: (delta: ProviderDelta) => void | Promise<void>;
  /**
   * Usage sink. An adapter calls this once per *provider call* — one request
   * to one model — as each completes, including calls made inside a harness
   * provider's own loop and calls that went on to fail.
   *
   * `ProviderResponse.usage` cannot carry those two cases, which is why this
   * exists: a harness makes several model calls that never cross this
   * interface, so only the last could be reported on the response; and a call
   * that throws returns no response at all, while its tokens were still
   * spent.
   *
   * **Synchronous and non-blocking**, unlike `onDelta`: there is no
   * backpressure to apply to a token count, and an adapter reporting one from
   * a `finally` on its way out with an error must not be made to await. A host
   * that wants to do real work with a count queues it.
   *
   * Reporting through this sink is exclusive **for the whole `generate`**,
   * not per inner call: once anything has reported through it, the
   * response's `usage` is ignored, so an adapter that uses both does not
   * have its final call counted twice. The runner cannot scope that more
   * finely, because it cannot see where one provider call ends and the next
   * begins.
   *
   * The consequence binds anything that composes providers behind one
   * `generate` — the fallback wrapper is the live example. If its primary
   * reported a failed attempt through the sink and its fallback then answers
   * with `usage` on the response, that response field is already excluded:
   * the composing wrapper MUST forward it through the sink itself, or the
   * turn that actually succeeded goes uncounted.
   */
  onUsage?: (usage: ProviderCallUsage) => void;
  /**
   * For a provider that makes another model call inside one `generate` on
   * its own decision, the fallback wrapper's switch being the live example:
   * await this before that call, naming the provider about to answer. The
   * runner announces the usage reported so far, then asks the host's
   * `ProviderCallGuard`s, so a budget the first call just spent is read
   * before the next one starts. It resolves to allow the call and throws to
   * refuse it; let the error propagate, because a refusal ends the turn.
   *
   * Not for a harness's own inner calls, which this interface never sees.
   */
  guardCall?: (provider: string) => Promise<void>;
  /**
   * For a provider that runs its own tool loop (the harness runtimes): ask,
   * when its inner budget runs out mid-work, whether to carry on with a
   * fresh one instead of wrapping up. True grants it, and counts it against
   * the agent's `autoContinue` cap. Absent when auto-continue is off.
   */
  mayContinue?: () => boolean;
  /**
   * For a provider that runs its own tool loop: ask, right after a hosted
   * call's result is in (`executeHostedToolCall`), for what somebody has
   * said since the turn started — the step `RunInput.steer` covers for the
   * runner's own loop, which never sees a harness's steps (card 958). A
   * message handed back is already in the transcript, a `steered` user
   * message right after that result with its keys and its sender's trust,
   * so the provider must get it to the model before the model's next step,
   * or fail the turn. Hands back nothing unless the newest message is a
   * tool result. Absent when the turn has no `steer`, on a turn that may
   * stay quiet, and on the wrap-up; a provider that cannot deliver a
   * message mid-loop must not call it.
   */
  steer?: () => Promise<SteeredMessage | undefined>;
  /**
   * Abort signal for the turn. Adapters MUST cancel their underlying
   * operation (HTTP request, SDK query) when it fires — racing the promise
   * is not cancellation; the underlying work has to stop.
   */
  signal?: AbortSignal;
}

/**
 * The transcript a provider should send: the request's window when it has
 * one, the whole session otherwise.
 *
 * One implementation because there is one rule, and because the wrong
 * answer is silent — an adapter reading `session.messages` directly still
 * works, it just ignores the floor and sends the request that was already
 * refused.
 */
export const transcriptOf = (request: Pick<ProviderRequest, 'session' | 'messages'>): readonly Message[] =>
  request.messages ?? request.session.messages;

export interface ProviderResponse {
  parts: ProviderPart[];
  /**
   * What this call consumed, for an adapter where one request is one model
   * call. Absent when the provider reports nothing — never a zero.
   *
   * The simple half of the usage contract; `ProviderRequest.onUsage` is the
   * other, and an adapter that reported through the sink leaves this alone.
   */
  usage?: ProviderCallUsage;
  /**
   * For a provider that runs its own tool loop (the harness runtimes): set
   * when this answer is that loop's wrap-up, given because its inner budget
   * ran out, so the runner marks the session `stoppedEarly` as it does for
   * its own wrap-up. A value the runner does not know is ignored. Absent
   * for every ordinary answer.
   */
  stoppedEarly?: 'turn-limit';
}

export interface ModelProvider {
  name: string;
  /**
   * For a provider that hands a session's calls to another provider while
   * keeping its own `name` (the fallback wrapper, once a session has
   * switched): the name of the provider that answers this session's next
   * call. The `ProviderCallGuard`s are told it, so a rule about one model
   * holds whichever wrapper it sits behind. Absent means `name`.
   */
  nameFor?(session: Session): string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

/** Who is about to spend a provider call: what a `ProviderCallGuard` is asked about. */
export interface ProviderCallCheck {
  agentId: string;
  sessionId: string;
  /**
   * The provider about to answer, by name: the runner's provider, or the
   * one it says answers this session (`ModelProvider.nameFor`). Under a
   * configured fallback that is the primary until the session switches and
   * the fallback after. A switch inside a call asks again before the
   * fallback's call, naming the fallback (`ProviderRequest.guardCall`).
   */
  provider: string;
}

/**
 * A host's say over each provider call before it is made: a token budget
 * is the case it exists for. Resolving allows the call. Throwing refuses
 * it and fails the turn: a `HostRefusalError` for a refusal made on purpose,
 * whose message is a sentence for the person in the conversation, and any
 * other error for a guard that could not decide, which refuses as well,
 * because a budget that cannot be read is not a budget that said yes.
 *
 * Asked once per `ModelProvider.generate`, which is one model call for the
 * kernel-loop adapters and one Stratus turn for a harness running its own
 * inner loop, and again before any further call a provider makes inside one
 * `generate` and asks about through `ProviderRequest.guardCall` (the
 * fallback model's call after the primary fails). The usage of every
 * earlier call has been announced (`session.usage`) before a guard is asked
 * about the next one.
 */
export type ProviderCallGuard = (check: ProviderCallCheck) => Promise<void> | void;
