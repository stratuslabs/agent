/*
 * One turn on a session, below the queueing `dispatch` does: resolve the
 * agent and its runtime, run it under the watchdog, and save what it left.
 * `dispatchInternal` is what `dispatch`, scheduled firings, tool-call
 * bindings and sub-agents call. Moved out of `createGateway` in index.ts as
 * is: the statement is unchanged, inside a factory that takes what it closed
 * over there, and `createGateway` calls it where it was. The one edit:
 * `selectedExecutor` is a `let` set when plugins start, so it is read through
 * `getSelectedExecutor()`.
 */

import {
  abortErrorFor,
  type AgentDefinition,
  type AgentRunner,
  type AgentRuntimeContext,
  CONVERSATION_METADATA_KEY,
  type Executor,
  type JsonObject,
  type Session,
  type SteeredMessage,
} from '@stratusagent/core';
import { isDelegatedSession, withoutDelegation } from '@stratusagent/agents';
import type { AgentSource } from './agent-source.ts';
import type { ShardedSessionStore } from './sessions.ts';
import type { DispatchInput, GatewayOptions } from './types.ts';
import {
  crossIdentityError,
  EXECUTOR_METADATA_KEY,
  isSubAgentSession,
  ROLLED_OVER_TO_METADATA_KEY,
  SUB_AGENT_METADATA_KEY,
} from './session-keys.ts';
import { assertStateCompatible, type RuntimeConfig, type StateEnvironment } from '@stratusagent/state';

/** What the turn dispatch closes over in `createGateway`. */
export interface TurnDispatchDeps {
  options: GatewayOptions;
  env: StateEnvironment;
  store: ShardedSessionStore;
  getSelectedExecutor: () => Executor | undefined;
  defaultAgentId: () => Promise<string>;
  refreshAgent: (agentId: string) => Promise<AgentSource>;
  runtimeContextFor: (
    source: AgentSource,
    config: RuntimeConfig,
    onFallback: boolean,
    metadata: JsonObject | undefined,
    subAgent?: boolean,
  ) => AgentRuntimeContext;
  runnerFor: (config: RuntimeConfig, agentId: string, subAgent?: boolean) => AgentRunner;
  withWatchdog: <T>(
    sessionId: string,
    external: AbortSignal | undefined,
    idleEnabled: boolean,
    fallbackStreams: boolean,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  onTurnRuntime: <T>(
    sessionId: string,
    runtime: { source: AgentSource; config: RuntimeConfig },
    work: () => Promise<T>,
  ) => Promise<T>;
  runtimeForAgent: (source: AgentSource) => Promise<RuntimeConfig>;
  watchdogStreamsFor: (
    session: Pick<Session, 'metadata'> | undefined,
    config: RuntimeConfig,
  ) => { switchedToFallback: boolean; effectiveStreams: boolean; fallbackStreams: boolean };
  reachesHarness: (config: RuntimeConfig, switchedToFallback: boolean) => boolean;
  settleLeftForNextStart: (input: DispatchInput, turn: Promise<Session>) => Promise<Session>;
}

export const createTurnDispatch = ({
  options,
  env,
  store,
  getSelectedExecutor,
  defaultAgentId,
  refreshAgent,
  runtimeContextFor,
  runnerFor,
  withWatchdog,
  onTurnRuntime,
  runtimeForAgent,
  watchdogStreamsFor,
  reachesHarness,
  settleLeftForNextStart,
}: TurnDispatchDeps) => {
  /**
   * `subAgent` is the narrowed definition `subAgents.run` built: the turn
   * runs as that, on the parent's resolved provider, with no memory and no
   * soul. Only that path passes it.
   */
  const dispatchInternal = async (
    input: DispatchInput,
    absorbedKeys: readonly string[] = [],
    subAgent?: AgentDefinition,
    /**
     * See `RunInput.steer`; passed by `dispatch` for an opted-in caller.
     * Handed the turn's own signal — the one the runner was given, which
     * the watchdog, `abortTurns` and a restart's window abort as well as
     * the callers — so it takes nothing into a turn that is already
     * stopping (card 959).
     */
    steer?: (turnSignal: AbortSignal) => Promise<SteeredMessage | undefined>,
  ): Promise<Session> => {
    // Re-read on every turn, not once at start: a newer build that stamps
    // the home while this daemon is serving has formats this build does not
    // understand, and a daemon that kept writing into them would be the
    // downgrade the stamp exists to refuse — from the inside. Inside the
    // session chain, so a turn already accepted is counted by the drain
    // before anything else runs. One small file read per turn.
    assertStateCompatible(env);
    // A dispatch whose signal fired while it queued behind another turn
    // must not touch durable state: without this check, the runner would
    // load the session, append the cancelled user message, and save it as
    // failed — polluting future model history with input never processed.
    if (input.signal?.aborted) {
      throw abortErrorFor(input.signal);
    }

    // A session pins its agent: when the caller names none, an existing
    // conversation keeps the agent it was created with even if the
    // configured default soul has changed since — only a brand-new session
    // takes the current default. (Loaded here, before the watchdog, also
    // because whether this turn streams depends on durable session state.)
    const existing = await store.get(input.sessionId);
    const agentId = input.agentId ?? existing?.agent.id ?? await defaultAgentId();
    const source = await refreshAgent(agentId);
    const agent = subAgent ?? source.definition;
    if (subAgent !== undefined && existing) {
      throw new Error(`Session ${input.sessionId} already exists; a sub-agent's session is new every time.`);
    }

    // An archived transcript is the record of a conversation that has moved
    // on. Continuing it would revive a session the operator deliberately
    // left behind, under an id nothing routes to any more.
    const continuedAs = existing?.metadata?.[ROLLED_OVER_TO_METADATA_KEY];
    if (typeof continuedAs === 'string') {
      throw new Error(
        `Session ${input.sessionId} was rolled over; it is an archived transcript and the conversation continues as ${continuedAs}.`,
      );
    }

    const config = await runtimeForAgent(source);
    const runner = runnerFor(config, source.definition.id, subAgent !== undefined);
    // Which executor the turn's tool calls run through — the built-in
    // under the name `stratus run` has always recorded, a contributed one
    // under its registered name — so a transcript says where a command
    // ran, not only which model asked for it.
    const executorRecord = getSelectedExecutor() && options.executor !== undefined ? options.executor : 'local-command';

    const metadata: JsonObject = {
      provider: config.provider,
      // A contributed provider may leave the model to its own default, in
      // which case there is none to record.
      ...(config.provider !== 'demo' && config.model !== undefined ? { model: config.model } : {}),
      ...input.metadata,
      // After the caller's metadata, and reserved besides: a dispatch that
      // could write it could make a transcript claim a sandbox ran what
      // the host ran.
      [EXECUTOR_METADATA_KEY]: executorRecord,
    };

    if (existing && existing.agent.id !== agent.id) {
      throw crossIdentityError(input.sessionId, existing.agent.id, agent.id);
    }

    // A sub-agent's session is new, but may start on its parent's fallback.
    const { switchedToFallback, effectiveStreams, fallbackStreams } = watchdogStreamsFor(
      existing ?? (subAgent !== undefined ? { metadata } : undefined),
      config,
    );
    // Recorded with a keyed message so a restart judges the turn by what it
    // could have run on, not by whatever the config resolves to by then.
    // The fallback counts: a turn can switch to it mid-run. Once a session
    // has switched for good, the primary is never called again, and only
    // the fallback counts.
    const hostedLoop = input.idempotencyKey !== undefined && reachesHarness(config, switchedToFallback);

    return settleLeftForNextStart(input, onTurnRuntime(input.sessionId, { source, config }, () => withWatchdog(input.sessionId, input.signal, effectiveStreams, fallbackStreams, async (signal) => {
      // The preflight above (agent refresh, config resolution, session
      // load) awaited filesystem work; the entry check has long passed.
      // Recheck before the runner touches durable state, or a dispatch
      // cancelled mid-preflight would still persist its user message.
      if (signal.aborted) {
        throw abortErrorFor(signal);
      }

      if (existing) {
        // Refresh the stored definition before resuming, so the turn runs
        // with the current instructions, tools, and credentials.
        existing.agent = agent;
        // A sub-session reached here is being continued from outside — a
        // delegation never resumes its own child; its ids are minted once.
        // The delegating turn is over, so the markers come off: what is
        // now an ordinary conversation must not be closed as an orphan if
        // a later turn of it parks and the daemon dies.
        if (isDelegatedSession(existing) && existing.metadata) {
          existing.metadata = withoutDelegation(existing.metadata);
        }
        // The same for a sub-agent's session, continued as the agent itself:
        // the marker that denies its approvals unasked comes off with the
        // delegation markers it carries.
        if (isSubAgentSession(existing) && existing.metadata) {
          const { [SUB_AGENT_METADATA_KEY]: _subAgent, ...rest } = withoutDelegation(existing.metadata);
          existing.metadata = rest;
        }
        // The executor record follows the daemon, not the session's first
        // turn: a restart that selected another executor runs this turn's
        // commands there, and a session from before the record existed
        // gets one now rather than never.
        if (existing.metadata?.[EXECUTOR_METADATA_KEY] !== executorRecord) {
          existing.metadata = { ...existing.metadata, [EXECUTOR_METADATA_KEY]: executorRecord };
        }
        // The room rides on the turn, but two readers have only the
        // session's: a turn parked on approval and recovered after a
        // restart, and a turn that brings no room of its own (a schedule
        // firing into the thread). Both get the latest room this way, not
        // the first turn's, which a channel made public since would make
        // read as more private than it is. A turn from a channel that
        // could not tell the room (its lookup failed) clears it instead:
        // no room is the generic line, and an old one is a claim.
        if (typeof input.metadata?.channel === 'string') {
          const room = input.metadata[CONVERSATION_METADATA_KEY];
          const { [CONVERSATION_METADATA_KEY]: _stale, ...rest } = existing.metadata ?? {};
          existing.metadata = room !== undefined ? { ...rest, [CONVERSATION_METADATA_KEY]: room } : rest;
        }
        await store.save(existing);
        // The turn's metadata rides along for the sender's trust: without
        // it a resumed turn has no way to say who sent it, and a stranger
        // mentioning the agent in a thread the operator opened would
        // inherit the operator's label.
        return runner.resume({
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          ...(input.images !== undefined ? { images: input.images } : {}),
          ...(input.addressed !== undefined ? { addressed: input.addressed } : {}),
          ...(input.replyOptional === true ? { replyOptional: true } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(absorbedKeys.length > 0 ? { absorbedKeys: [...absorbedKeys] } : {}),
          ...(hostedLoop ? { hostedLoop } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          runtime: runtimeContextFor(source, config, switchedToFallback, input.metadata),
          ...(steer !== undefined ? { steer: () => steer(signal) } : {}),
          signal,
        });
      }

      return runner.run({
        sessionId: input.sessionId,
        agent,
        userMessage: input.userMessage,
        ...(input.images !== undefined ? { images: input.images } : {}),
        ...(input.addressed !== undefined ? { addressed: input.addressed } : {}),
        ...(input.replyOptional === true ? { replyOptional: true } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(absorbedKeys.length > 0 ? { absorbedKeys: [...absorbedKeys] } : {}),
        ...(hostedLoop ? { hostedLoop } : {}),
        ...(input.earlier !== undefined && input.earlier.length > 0 ? { earlier: input.earlier } : {}),
        metadata,
        runtime: runtimeContextFor(source, config, switchedToFallback, input.metadata, subAgent !== undefined),
        ...(steer !== undefined ? { steer: () => steer(signal) } : {}),
        signal,
      });
    })));
  };

  return { dispatchInternal };
};

export type TurnDispatch = ReturnType<typeof createTurnDispatch>;
