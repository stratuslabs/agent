/*
 * Delegation: the `agent.delegate` tool, and sub-agents a plugin runs inside
 * a turn (per-turn slots, which tools a slice may carry, the tool calls in
 * flight they are bound to). Moved out of `createGateway` in index.ts as is:
 * the statements are unchanged, inside a factory that takes what they closed
 * over there, and `createGateway` calls it where they were and destructures
 * what it returns. dispatchInternal and onSessionChain are declared later in
 * `createGateway`, so it passes them late-bound.
 */

import { randomUUID } from 'node:crypto';
import {
  abortErrorFor,
  type AgentDefinition,
  type AgentRegistry,
  type Executor,
  matchesToolAllowlist,
  resolveToolRisk,
  SENDER_TRUST_METADATA_KEY,
  type Session,
  sessionTrustOf,
  sessionWriteTrust,
  type SteeredMessage,
  type SubAgentHandle,
  type SubAgentOutcome,
  type ToolRegistry,
  type UnlistedTools,
} from '@stratusagent/core';
import {
  createDelegateTool,
  type DelegateBackgroundStart,
  DEFAULT_MAX_DELEGATION_DEPTH,
  DELEGATED_BY_METADATA_KEY,
  DELEGATION_DEPTH_METADATA_KEY,
  ROOT_SESSION_ID_METADATA_KEY,
} from '@stratusagent/agents';
import type { ShardedSessionStore } from './sessions.ts';
import type { DispatchInput, GatewayOptions } from './types.ts';
import {
  DEFAULT_SUB_AGENTS_PER_TURN,
  isSubAgentSession,
  SUB_AGENT_METADATA_KEY,
  SUB_AGENT_SESSION_ID_MARKER,
  subAgentNeverGets,
} from './session-keys.ts';
import { FALLBACK_ACTIVE_METADATA_KEY } from '@stratusagent/state';
import type { ApprovalBroker } from './approvals.ts';

/** What delegation closes over in `createGateway`. */
export interface SubAgentsDeps extends Pick<ApprovalBroker, 'liveSubAgentIds' | 'idAtFirstCall' | 'hostIdOf' | 'isHostSubAgent'> {
  options: GatewayOptions;
  store: ShardedSessionStore;
  registry: AgentRegistry;
  unlistedTools: () => UnlistedTools;
  tools: ToolRegistry;
  dispatchInternal: (
    input: DispatchInput,
    absorbedKeys?: readonly string[],
    subAgent?: AgentDefinition,
    steer?: (turnSignal: AbortSignal) => Promise<SteeredMessage | undefined>,
  ) => Promise<Session>;
  onSessionChain: <T>(sessionId: string, work: () => Promise<T>, released?: () => boolean) => Promise<T>;
  /** How `agent.delegate` starts a background task (`background-tasks.ts`); absent while tasks are off. */
  background?: DelegateBackgroundStart;
}

export const createSubAgents = ({
  options,
  store,
  registry,
  unlistedTools,
  tools,
  dispatchInternal,
  onSessionChain,
  liveSubAgentIds,
  idAtFirstCall,
  hostIdOf,
  isHostSubAgent,
  background,
}: SubAgentsDeps) => {
  tools.register(createDelegateTool({
    registry,
    ...(background !== undefined ? { background } : {}),
    dispatch: (input) => dispatchInternal({
      sessionId: input.sessionId,
      agentId: input.agent.id,
      userMessage: input.userMessage,
      metadata: input.metadata,
      // A cancelled parent turn cancels its delegated runs too.
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  }));

  // ---- sub-agents (roadmap 24) -------------------------------------------

  /**
   * Running sub-agents per parent session, and who waits for a slot. A
   * parent session runs one turn at a time, so this is per turn.
   */
  const maxSubAgentsPerTurn = options.subAgents?.maxConcurrentPerTurn ?? DEFAULT_SUB_AGENTS_PER_TURN;

  // NaN, 0, a fraction or Infinity would queue every sub-agent forever or
  // defeat the cap, so refuse it here instead of failing later in a turn.
  if (!Number.isInteger(maxSubAgentsPerTurn) || maxSubAgentsPerTurn < 1) {
    throw new Error(`subAgents.maxConcurrentPerTurn must be a whole number of at least 1 (got ${String(maxSubAgentsPerTurn)}).`);
  }

  const subAgentSlots = new Map<string, { running: number; waiting: Array<() => void> }>();

  let subAgentCount = 0;

  /**
   * The session object each in-flight tool call was handed, with that
   * call's turn signal. `subAgents.run` accepts only a parent found here:
   * the session a running tool was given, by identity, never an id, so a
   * plugin cannot start sub-agents of another turn (another agent's
   * included) just because that turn is running. The signal is how the
   * parent's cancel reaches its sub-agents whether or not the plugin
   * passes one.
   */
  const toolCallsInFlight = new Map<Session, Array<AbortSignal | undefined>>();

  const bindToolCalls = (inner: Executor): Executor => ({
    async execute(call, tool, session, context) {
      if (!idAtFirstCall.has(session)) {
        idAtFirstCall.set(session, session.id);
      }
      const entry = toolCallsInFlight.get(session) ?? [];
      toolCallsInFlight.set(session, entry);
      const signal = context?.signal;
      entry.push(signal);
      try {
        return await inner.execute(call, tool, session, context);
      } finally {
        entry.splice(entry.indexOf(signal), 1);
        if (entry.length === 0) {
          toolCallsInFlight.delete(session);
        }
      }
    },
  });

  const subAgentSlot = (parentId: string, signal: AbortSignal | undefined): Promise<() => void> =>
    new Promise((resolve, reject) => {
      const entry = subAgentSlots.get(parentId) ?? { running: 0, waiting: [] };
      subAgentSlots.set(parentId, entry);
      const release = (): void => {
        entry.running -= 1;
        const next = entry.waiting.shift();
        if (next) {
          next();
        } else if (entry.running === 0) {
          subAgentSlots.delete(parentId);
        }
      };
      const take = (): void => {
        entry.running += 1;
        resolve(release);
      };
      if (entry.running < maxSubAgentsPerTurn) {
        take();
        return;
      }
      const onAbort = (): void => {
        const at = entry.waiting.indexOf(waiter);
        if (at >= 0) {
          entry.waiting.splice(at, 1);
        }
        reject(abortErrorFor(signal));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        take();
      };
      entry.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  /** Why this slice cannot be a sub-agent's, or undefined when it can. */
  const subAgentSliceProblem = (parent: Session, requested: unknown): string | undefined => {
    if (!Array.isArray(requested) || requested.some((name) => typeof name !== 'string' || name.length === 0)) {
      return 'A sub-agent\'s tools are a list of tool names.';
    }
    // Read the way the runner reads it for the parent's own calls: the
    // session's copy, else the registered agent's.
    const allowlist = parent.agent.tools ?? registry.get(parent.agent.id)?.tools;
    for (const name of requested as string[]) {
      if (/[*?]/.test(name)) {
        return `A sub-agent's tools are exact names, and ${name} is a pattern.`;
      }
      if (subAgentNeverGets(name)) {
        return `${name} is never given to a sub-agent, even by an agent that holds it.`;
      }
      const tool = tools.get(name);
      if (!tool) {
        return `There is no tool named ${name}.`;
      }
      // The parent's allowlist as its running turn holds it: a slice can
      // only narrow what that turn may already do. With no list, that is
      // the tools registered as safe (every tool on a home an older build
      // set up), and the slice is held to the same rule: naming a gated
      // tool must not hand it to the sub-agent.
      if (allowlist === undefined) {
        if (unlistedTools() !== 'every' && resolveToolRisk(tool) !== 'safe') {
          return `${name} is not a safe tool, and ${parent.agent.id}'s soul has no tools: list, so it gets only safe tools and a sub-agent of it cannot have ${name}.`;
        }
      } else if (!matchesToolAllowlist(name, allowlist)) {
        return `${name} is not one of ${parent.agent.id}'s tools, so a sub-agent of it cannot have it.`;
      }
    }
    return undefined;
  };

  const subAgents: SubAgentHandle = {
    async run(request) {
      // Copied before the first await, and only the copy is read from here
      // on: the plugin keeps its own objects and can change them while this
      // request is checked or waits for a slot, and a slice changed after
      // it was checked must not be the slice the sub-agent runs with.
      const handed = request?.parent as Session | undefined;
      const callSignals = handed ? toolCallsInFlight.get(handed) : undefined;
      if (!callSignals) {
        throw new Error('subAgents.run starts sub-agents only for the session your tool was handed, while that call is running. Pass that session object as "parent".');
      }
      // The parent turn's own stop, and the caller's as an extra one: a
      // plugin that passes no signal still has its sub-agents cancelled
      // with the turn.
      const stops = [...callSignals, request.signal].filter((signal): signal is AbortSignal => signal !== undefined);
      const input = {
        parent: { id: hostIdOf(handed!) },
        instruction: request?.instruction,
        tools: Array.isArray(request?.tools) ? [...request.tools] : request?.tools,
        model: request?.model,
        signal: stops.length === 0 ? undefined : stops.length === 1 ? stops[0] : AbortSignal.any(stops),
      };
      const parentId = typeof input.parent.id === 'string' ? input.parent.id : '';
      if (!parentId) {
        throw new Error('subAgents.run needs the session of the turn asking.');
      }
      const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
      if (!instruction) {
        throw new Error('subAgents.run needs an instruction.');
      }
      if (input.model !== undefined) {
        throw new Error('A sub-agent\'s model cannot be chosen yet: it runs on its parent\'s. Leave "model" out.');
      }
      const parent = await store.get(parentId);
      if (!parent) {
        throw new Error(`There is no session ${parentId} to start a sub-agent from.`);
      }
      if (isHostSubAgent(handed!) || isSubAgentSession(parent)) {
        throw new Error('A sub-agent cannot start sub-agents.');
      }
      if (parent.status !== 'running') {
        throw new Error(`Session ${parentId} is not running a turn, and sub-agents start only from one.`);
      }
      const depth = typeof parent.metadata?.[DELEGATION_DEPTH_METADATA_KEY] === 'number'
        ? parent.metadata[DELEGATION_DEPTH_METADATA_KEY]
        : 0;
      if (depth >= DEFAULT_MAX_DELEGATION_DEPTH) {
        throw new Error(`Delegation depth limit reached (${DEFAULT_MAX_DELEGATION_DEPTH}).`);
      }
      const problem = subAgentSliceProblem(parent, input.tools);
      if (problem) {
        throw new Error(problem);
      }
      if (input.signal?.aborted) {
        throw abortErrorFor(input.signal);
      }

      const release = await subAgentSlot(parent.id, input.signal);
      subAgentCount += 1;
      const sessionId = `${parent.id}${SUB_AGENT_SESSION_ID_MARKER}${depth + 1}:${subAgentCount}-${randomUUID().slice(0, 8)}`;
      // The parent agent, narrowed: its id, provider and credentials, the
      // slice for tools, and nothing else — no instructions (the persona),
      // no skills, no delegates.
      const definition: AgentDefinition = {
        id: parent.agent.id,
        name: parent.agent.name,
        tools: [...new Set(input.tools as string[])],
        skills: [],
        delegates: [],
        ...(parent.agent.credentials !== undefined ? { credentials: [...parent.agent.credentials] } : {}),
      };
      let session: Session;
      liveSubAgentIds.add(sessionId);
      try {
        session = await onSessionChain(sessionId, () => dispatchInternal({
          sessionId,
          agentId: parent.agent.id,
          userMessage: instruction,
          metadata: {
            [SUB_AGENT_METADATA_KEY]: true,
            [DELEGATION_DEPTH_METADATA_KEY]: depth + 1,
            [DELEGATED_BY_METADATA_KEY]: parent.agent.id,
            [ROOT_SESSION_ID_METADATA_KEY]: typeof parent.metadata?.[ROOT_SESSION_ID_METADATA_KEY] === 'string'
              ? parent.metadata[ROOT_SESSION_ID_METADATA_KEY]
              : parent.id,
            // The instruction is the parent's text, at the parent's label:
            // a tainted parent must not hand a stranger's words to a
            // session that has seen nothing.
            [SENDER_TRUST_METADATA_KEY]: sessionWriteTrust(parent),
            // On the runtime serving the parent's turn: a parent that has
            // switched to its sticky fallback must not have its helpers
            // retry the primary it left.
            ...(parent.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true ? { [FALLBACK_ACTIVE_METADATA_KEY]: true } : {}),
          },
          ...(input.signal ? { signal: input.signal } : {}),
        }, [], definition));
      } catch (error) {
        if (input.signal?.aborted) {
          throw error;
        }
        // The error text may be the provider quoting what it refused,
        // which is this sub-agent's context: labelled as nobody can vouch.
        return { status: 'error', error: error instanceof Error ? error.message : String(error), sessionId, trust: 'unknown' };
      } finally {
        liveSubAgentIds.delete(sessionId);
        release();
      }
      const trust = sessionTrustOf(session);
      if (session.status === 'failed') {
        return { status: 'error', error: session.lastError ?? 'The sub-agent failed.', sessionId, trust: 'unknown' };
      }
      const reply = [...session.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.content.trim().length > 0);
      const outcome: SubAgentOutcome = reply
        ? { status: 'result', text: reply.content, sessionId, trust }
        : { status: 'empty', sessionId, trust };
      return outcome;
    },
  };

  return { bindToolCalls, subAgents };
};

export type SubAgents = ReturnType<typeof createSubAgents>;
