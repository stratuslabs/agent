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

import { type SilentReaction } from './turns.ts';

import type { ImageAttachment } from './images.ts';

import type { JsonObject } from './json.ts';

/**
 * `pending_approval` is a turn parked on a human, and it is durable on
 * purpose: it is the index a restarting daemon uses to find the turns it
 * owes an answer. Everything else about the turn is already in the
 * session; this is what makes it findable without reading every row.
 */
export type SessionStatus = 'idle' | 'running' | 'pending_approval' | 'completed' | 'failed';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

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
   * On the empty assistant message a reply-optional turn's silence leaves
   * (card 1078): the reaction the model named with `NO_REPLY_MARKER`, one
   * of `SILENT_REACTIONS`, for the channel to put on the message the turn
   * was on. Recorded only on a turn whose message was said to the agent
   * (`replyOptional`), never on an overheard one. Present only when named;
   * an older build reads past it, and the turn is then plain silence.
   */
  reaction?: SilentReaction;
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
  postOf,
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
  type ToolPost,
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
  latestTurnReaction,
  latestTurnReply,
  markPromptDelivered,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  messagesAfterOverheard,
  NO_REPLY_MARKER,
  noReplyAnswerOf,
  OVERHEARD_IMAGES_NOTE,
  promptTextOf,
  type PromptTextOptions,
  promptWasDelivered,
  recordTurnFailure,
  redactedError,
  redactSecrets,
  REPLY_OPTIONAL_NOTE,
  SAID_TO_YOU_MARK,
  SILENT_REACTIONS,
  type SilentReaction,
  startsTurn,
  TURN_LIMIT_NOTE,
  turnFailureFor,
  turnFilesFor,
  turnKeyOf,
  turnMessageOf,
  turnPostsFor,
  turnReactionFor,
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

// Image attachments, their limits and the replay budget, in their own
// module (see the top of images.ts).
export {
  droppedImageNote,
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENT_MEDIA_TYPES,
  IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES,
  type ImageAttachment,
  type ImageAttachmentMediaType,
  imageDimensions,
  type ImageDimensions,
  type ImageReplayBudget,
  imagesWithinReplayBudget,
  isImageAttachmentMediaType,
  omitImage,
  omitImagesOutsideReplayBudget,
} from './images.ts';

// The JSON value types, in their own module (see the top of json.ts).
export {
  type JsonObject,
  type JsonValue,
} from './json.ts';

// Plugin contributions, their registries and the plugin context, in their
// own module (see the top of contributions.ts).
export {
  type AgentWorkspaces,
  BUILTIN_EXECUTOR_NAME,
  BUILTIN_MEMORY_STORE_NAME,
  BUILTIN_PROVIDER_NAMES,
  type BuiltinProviderName,
  type ChannelAdapterLike,
  channelClaimKey,
  type ChannelContribution,
  type ChannelRegistrationHandle,
  ChannelRegistry,
  type ChannelTransportSecrets,
  ContributionRegistry,
  createRoutedMemoryStore,
  type EventIngestHandle,
  type EventIngestResult,
  type ExecutorContribution,
  type ExecutorRegistrationHandle,
  type FleetAgent,
  type FleetPendingApproval,
  type FleetReader,
  type FleetSchedule,
  type FleetSession,
  MEMORY_STORE_CONTRACT_VERSION,
  type MemoryRegistrationHandle,
  type MemoryStoreContribution,
  type Plugin,
  type PluginContext,
  PluginRegistry,
  type PluginStateDirectory,
  type ProtectedPaths,
  type ProviderCallGuardHandle,
  type ProviderContribution,
  type ProviderRegistrationHandle,
  type ProviderSelection,
  type SubAgentHandle,
  type SubAgentOutcome,
  type SubAgentRunInput,
} from './contributions.ts';

// Run events and the event bus, in their own module (see the top of
// events.ts).
export {
  EventBus,
  type EventBusOptions,
  type EventHandler,
  type StratusEvent,
  type SubscribeOptions,
} from './events.ts';

// Approval answers and what an approval request carries, in their own
// module (see the top of approvals.ts).
export {
  type AlwaysMeans,
  type ApprovalAnswer,
  type ApprovalDelegationOrigin,
  type ApprovalOutcome,
  type ApprovalResolutionReason,
  type ApprovalScheduleDestination,
} from './approvals.ts';
