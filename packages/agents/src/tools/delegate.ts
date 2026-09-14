import {
  AgentRegistry,
  SENDER_TRUST_METADATA_KEY,
  sessionTrustOf,
  sessionWriteTrust,
  type AgentDefinition,
  type AgentRunner,
  type JsonObject,
  type Session,
  type Tool,
} from '@stratusagent/core';
import { isDelegateAllowed, suggestedDelegatesEdit } from '../soul.ts';

export const DELEGATE_TOOL_NAME = 'agent.delegate';

/**
 * Metadata a delegated sub-session carries: which agent delegated, and the
 * session at the root of the chain. Written by `agent.delegate` and read by
 * the gateway's restart sweep, which is why the keys are named here rather
 * than spelled twice — a sub-session's parent is a turn in some other
 * process's memory, and after a restart nothing can consume its reply.
 */
export const DELEGATED_BY_METADATA_KEY = 'delegatedBy';

export const ROOT_SESSION_ID_METADATA_KEY = 'rootSessionId';

export const DELEGATION_DEPTH_METADATA_KEY = 'delegationDepth';

/**
 * The segment `agent.delegate` mints into every sub-session's id —
 * `<parent>:delegate:<agent>:<depth>:<suffix>`. The second half of what
 * identifies a sub-session, beside the metadata above: the gateway refuses
 * the metadata keys at its public door, but rows written before it did
 * cannot be told apart by their metadata alone, and a caller who wrote
 * `delegatedBy` onto a session of its own would not also have minted an
 * id in this shape.
 */
export const DELEGATED_SESSION_ID_MARKER = ':delegate:';

/**
 * Whether this session is a delegated sub-session — one whose reply is
 * consumed by a parent turn's `agent.delegate` call and by nothing else.
 * Both halves are required: the metadata `agent.delegate` writes, and the
 * id shape it mints.
 */
export const isDelegatedSession = (session: Pick<Session, 'id' | 'metadata'>): boolean =>
  typeof session.metadata?.[DELEGATED_BY_METADATA_KEY] === 'string'
  && session.id.includes(DELEGATED_SESSION_ID_MARKER);

/**
 * The id of the session whose `agent.delegate` call started this one, read
 * off the id shape above — the text before the last marker, since a nested
 * sub-session embeds its parent's id whole. Undefined for an id that was
 * not minted that way.
 */
export const delegatingSessionIdOf = (sessionId: string): string | undefined => {
  const at = sessionId.lastIndexOf(DELEGATED_SESSION_ID_MARKER);
  return at > 0 ? sessionId.slice(0, at) : undefined;
};

/**
 * The id of the `agent.delegate` call in `parent` that is still awaiting
 * `child`, or undefined when none is.
 *
 * The one thing about a delegation nothing outside the runner can forge:
 * a caller can name a session in the sub-session id shape and write the
 * metadata keys, but only the runner writes assistant tool calls, and only
 * a delegation in flight leaves one with no result behind it. Matched to
 * the child and not merely counted, because a parent can be inside one
 * delegation while an earlier sub-session of its — continued from outside
 * under a version that kept the markers — is parked on something of its
 * own. The call names its target and its prompt, and `agent.delegate`
 * made the prompt the child's first user message. Read against the
 * transcript order so a re-used call id cannot make a later call look
 * answered.
 */
export const outstandingDelegationFor = (
  parent: Pick<Session, 'messages'>,
  child: Pick<Session, 'agent' | 'messages'>,
): string | undefined => {
  const firstMessage = child.messages.find((message) => message.role === 'user')?.content;
  if (firstMessage === undefined) {
    return undefined;
  }
  const answered = new Map<string, number>();
  for (const message of parent.messages) {
    if (message.role === 'tool' && message.toolResult) {
      answered.set(message.toolResult.callId, (answered.get(message.toolResult.callId) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  for (const message of parent.messages) {
    if (message.role !== 'assistant' || !message.toolCalls) {
      continue;
    }
    for (const call of message.toolCalls) {
      const occurrence = (seen.get(call.id) ?? 0) + 1;
      seen.set(call.id, occurrence);
      if (call.toolName !== DELEGATE_TOOL_NAME || occurrence <= (answered.get(call.id) ?? 0)) {
        continue;
      }
      const target = typeof call.input.agent === 'string' ? call.input.agent : '';
      const prompt = typeof call.input.prompt === 'string' ? call.input.prompt.trim() : '';
      if ((target === child.agent.id || target === child.agent.name) && prompt === firstMessage) {
        return call.id;
      }
    }
  }
  return undefined;
};

/**
 * `metadata` with the delegation markers removed — what a sub-session
 * carries once it has been addressed from outside. The delegation ended
 * with the turn that awaited it; a conversation somebody continues on the
 * same id afterwards is an ordinary one, and must not be closed as an
 * orphan by a later restart.
 */
export const withoutDelegation = (metadata: JsonObject): JsonObject => {
  const {
    [DELEGATED_BY_METADATA_KEY]: _delegatedBy,
    [ROOT_SESSION_ID_METADATA_KEY]: _root,
    [DELEGATION_DEPTH_METADATA_KEY]: _depth,
    ...rest
  } = metadata;
  return rest;
};

/**
 * Runs a delegated sub-session. A plain runner works when every agent
 * shares one provider; a host with per-agent provider routing (the
 * gateway) supplies its own dispatcher so the target runs on the
 * target's resolved provider and credentials — never the delegator's.
 */
export type DelegateDispatch = (input: {
  sessionId: string;
  agent: AgentDefinition;
  userMessage: string;
  metadata: JsonObject;
  /** The parent turn's abort signal — a cancelled parent cancels the delegated run too. */
  signal?: AbortSignal;
}) => Promise<Session>;

export type DelegateToolOptions = {
  registry: AgentRegistry;
  /** Maximum delegation depth to stop orchestrator loops. Default 3. */
  maxDepth?: number;
} & ({ runner: AgentRunner; dispatch?: never } | { dispatch: DelegateDispatch; runner?: never });

const DEFAULT_MAX_DELEGATION_DEPTH = 3;

/**
 * The orchestrator primitive: a tool that runs another agent in its own
 * sub-session (with that agent's memory, tool allowlist, and credentials)
 * and returns its final reply as the tool result.
 */
export const createDelegateTool = ({
  registry,
  runner,
  dispatch,
  maxDepth = DEFAULT_MAX_DELEGATION_DEPTH,
}: DelegateToolOptions): Tool => {
  const runDelegated: DelegateDispatch = dispatch ?? ((input) => runner.run(input));
  // Sub-session ids must be unique even when one orchestrator delegates to
  // the same target repeatedly, and must stay unique across tool rebuilds
  // sharing one SessionStore — so a counter alone is not enough.
  let delegationCount = 0;
  const uniqueSuffix = (): string =>
    `${delegationCount}-${Math.random().toString(36).slice(2, 10)}`;

  return {
  name: DELEGATE_TOOL_NAME,
  description: 'Delegate a task to another agent by name and get their reply back.',
  // Safe, and the call is arguable enough to record why. Delegation spends
  // provider tokens and starts work as another agent, which reads like
  // `gated` — but the money argument proves too much: the turn that decides
  // to delegate was itself an unapproved provider call, so gating on spend
  // gates the conversation. What delegation does NOT do is act outside
  // Stratus. It stays in the fleet, the delegate's own tool calls face the
  // policy again under the delegate's allowlist, and maxDepth bounds the
  // chain.
  //
  // The practical half: `gated` here means a headless daemon refuses every
  // delegation, and headless is what every installed service runs. That
  // would remove the orchestrator pattern from the product until remote
  // approval exists — a feature removal wearing a safety hat, with no way
  // for an operator to say yes. Revisit when a human can actually be asked.
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Name or id of the agent to delegate to.' },
      prompt: { type: 'string', description: 'The task or question for that agent.' },
    },
    required: ['agent', 'prompt'],
  },
  async execute(input: JsonObject, session: Session, context) {
    const targetRef = typeof input.agent === 'string' ? input.agent : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!targetRef || !prompt) {
      throw new Error('agent.delegate requires "agent" and "prompt" strings.');
    }

    const depth = typeof session.metadata?.[DELEGATION_DEPTH_METADATA_KEY] === 'number'
      ? session.metadata[DELEGATION_DEPTH_METADATA_KEY]
      : 0;
    if (depth >= maxDepth) {
      throw new Error(`Delegation depth limit reached (${maxDepth}).`);
    }

    const target = registry.get(targetRef) ?? registry.getByName(targetRef);
    if (!target) {
      throw new Error(`Agent not found: ${targetRef}`);
    }
    if (target.id === session.agent.id) {
      throw new Error('An agent cannot delegate to itself.');
    }
    // Judged on the session's frozen copy of the agent, as the tool
    // allowlist is: the target is model-chosen input, and without this
    // list any agent holding this tool could run a turn as any other —
    // under the other's tools, credentials, and memory — which is the
    // lateral move a prompt-injected agent would take.
    if (!isDelegateAllowed(session.agent, target.id)) {
      throw new Error(
        `Agent ${session.agent.id} may not delegate to ${target.id}. `
        + `Add ${suggestedDelegatesEdit(target.id)} to its soul, or delegates: ['*'] for any agent on the roster.`,
      );
    }

    delegationCount += 1;
    let result;
    try {
      result = await runDelegated({
      sessionId: `${session.id}${DELEGATED_SESSION_ID_MARKER}${target.id}:${depth + 1}:${uniqueSuffix()}`,
      agent: target,
      userMessage: prompt,
      metadata: {
        [DELEGATION_DEPTH_METADATA_KEY]: depth + 1,
        [DELEGATED_BY_METADATA_KEY]: session.agent.id,
        [ROOT_SESSION_ID_METADATA_KEY]: typeof session.metadata?.[ROOT_SESSION_ID_METADATA_KEY] === 'string'
          ? session.metadata[ROOT_SESSION_ID_METADATA_KEY]
          : session.id,
        // Outbound: the prompt is the parent's text, and the parent is its
        // "sender" — a tainted parent must not hand attacker text to a
        // teammate whose session has seen nothing. At most `agent`: the
        // prompt is something an agent wrote, whoever it was talking to.
        [SENDER_TRUST_METADATA_KEY]: sessionWriteTrust(session),
      },
      // A cancelled parent turn cancels the delegated run with it —
      // otherwise the parent cannot settle until the target gives up.
      ...(context?.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      // A failed run has no session to read a label from here, and its
      // error text is the target's — a provider quoting the request it
      // refused, which is the target's prompt and injected memory, whatever
      // label those carried. The parent sees that text as a tool error, so
      // the call is marked at the label for provenance nobody can vouch
      // for before it is rethrown. The parent's own cancellation is the
      // exception: that error is this process's sentence, not the target's.
      if (!context?.signal?.aborted) {
        context?.markTrust?.('unknown');
      }
      throw error;
    }

    // Inbound: the reply carries the target session's label, whatever it
    // is — not only `external`. A target whose own injected memory was
    // `unknown` replies from content the parent never saw and cannot
    // assess; the parent takes the lower of its own label and this one,
    // by the same ordering as everything else.
    const targetTrust = sessionTrustOf(result);
    context?.markTrust?.(targetTrust);

    const reply = [...result.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.length > 0);

    return {
      agent: target.name,
      reply: reply?.content ?? '(no reply)',
      sessionId: result.id,
      trust: targetTrust,
    };
  },
  };
};
