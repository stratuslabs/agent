/*
 * Restart recovery: the turns the last process left parked on a person or
 * still running, the sub-sessions it orphaned, and how a repeated
 * idempotency key settles against an unfinished item or a rollover's
 * archived transcript. Moved out of `createGateway` in index.ts as is: the
 * statements are unchanged, inside a factory that takes what they closed
 * over there, and `createGateway` calls it where they were. The edits:
 * `stopping`, `abortingWith` and `orphanedAtStart` are `let`s reassigned
 * later, so they are read through `isStopping()`, `getAbortingWith()` and
 * `getOrphanedAtStart()`, and `onSessionChain`, declared further down, is
 * passed late-bound.
 */

import {
  type AgentRunner,
  type AgentRuntimeContext,
  completeAnsweredTurn,
  type EventBus,
  type JsonObject,
  lastResponseIsAnswer,
  PENDING_APPROVAL_METADATA_KEY,
  readPendingApproval,
  recordTurnFailure,
  type RunAbortedError,
  type Session,
  turnKeyOf,
  turnMessageOf,
  workItemState,
} from '@stratusagent/core';
import {
  delegatingSessionIdOf,
  isDelegatedSession,
  outstandingDelegationFor,
  SCHEDULE_ID_METADATA_KEY,
} from '@stratusagent/agents';
import type { AgentSource } from './agent-source.ts';
import type { SchedulerRuntime } from './schedules.ts';
import type { ShardedSessionStore } from './sessions.ts';
import type { DispatchInput } from './types.ts';
import {
  ABANDONED_TURN_ERROR,
  crossIdentityError,
  isSubAgentSession,
  ORPHANED_DELEGATION_ERROR,
  ROLLED_OVER_FROM_METADATA_KEY,
  ROLLOVER_REPEAT_WINDOW_MS,
} from './session-keys.ts';
import { FALLBACK_ACTIVE_METADATA_KEY, type RuntimeConfig } from '@stratusagent/state';

/** What restart recovery closes over in `createGateway`. */
export interface RecoveryDeps {
  log: (line: string) => void;
  warn: (line: string) => void;
  bus: EventBus;
  store: ShardedSessionStore;
  scheduler: SchedulerRuntime;
  effectiveApprovalTimeoutMs: number;
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
  isStopping: () => boolean;
  trackTurn: (sessionId: string, controller: AbortController) => void;
  untrackTurn: (sessionId: string, controller: AbortController) => void;
  getAbortingWith: () => string | undefined;
  shutdownAbort: () => RunAbortedError;
  activeTurns: Map<string, string>;
  onTurnRuntime: <T>(
    sessionId: string,
    runtime: { source: AgentSource; config: RuntimeConfig },
    work: () => Promise<T>,
  ) => Promise<T>;
  getOrphanedAtStart: () => ReadonlySet<string>;
  /**
   * The worker sessions of the background tasks the last process left
   * unsettled, read before the channels start. The task sweep owns them, so
   * these sweeps skip them: failing one as abandoned would report it
   * `failed`, and re-asking its parked approval would run it again.
   */
  getTaskWorkersAtStart: () => ReadonlySet<string>;
  runtimeForAgent: (source: AgentSource) => Promise<RuntimeConfig>;
  watchdogStreamsFor: (
    session: Pick<Session, 'metadata'> | undefined,
    config: RuntimeConfig,
  ) => { switchedToFallback: boolean; effectiveStreams: boolean; fallbackStreams: boolean };
  reachesHarness: (config: RuntimeConfig, switchedToFallback: boolean) => boolean;
  onSessionChain: <T>(sessionId: string, work: () => Promise<T>, released?: () => boolean) => Promise<T>;
}

export const createRecovery = ({
  log,
  warn,
  bus,
  store,
  scheduler,
  effectiveApprovalTimeoutMs,
  refreshAgent,
  runtimeContextFor,
  runnerFor,
  withWatchdog,
  isStopping,
  trackTurn,
  untrackTurn,
  getAbortingWith,
  shutdownAbort,
  activeTurns,
  onTurnRuntime,
  getOrphanedAtStart,
  getTaskWorkersAtStart,
  runtimeForAgent,
  watchdogStreamsFor,
  reachesHarness,
  onSessionChain,
}: RecoveryDeps) => {
  /**
   * Finishes the turns that were parked on a human when this daemon last
   * went down.
   *
   * Run after the channels are up, deliberately: recovery re-asks, and a
   * request emitted into a gateway with no live adapter would be declined
   * for want of anywhere to put it — turning "your approval survived the
   * restart" into "your approval was denied by the restart".
   *
   * Each session is recovered independently and failures are per-session:
   * one unrecoverable turn must not stop the daemon from serving, or from
   * recovering the others.
   */
  const recoverParkedTurns = async (orphaned: ReadonlySet<string>): Promise<void> => {
    if (!store.listIdsByStatus) {
      return;
    }
    const taskWorkers = getTaskWorkersAtStart();
    const parked = (await store.listIdsByStatus('pending_approval')).filter((id) => !taskWorkers.has(id));
    if (parked.length === 0) {
      return;
    }
    log(`recovering ${parked.length} turn(s) parked on approval`);

    // Started together, not one after another. Each recovery re-asks and
    // then waits on a human, so awaiting them in sequence would mean the
    // second parked turn is not even *announced* until the first is
    // answered — fifteen minutes later by default, and never at all with a
    // zero timeout. They are independent turns; only same-session work is
    // ordered, and onSessionChain already guarantees that.
    await Promise.allSettled(parked.map((sessionId) => recoverOne(sessionId, orphaned.has(sessionId))));
  };

  /**
   * The parked sub-sessions whose delegating turn the last process was
   * still inside — read BEFORE the channels start, for the same reason the
   * abandoned list is.
   *
   * The proof is the parent's transcript: only the runner writes an
   * assistant `agent.delegate` call, and only a delegation in flight leaves
   * one with no result behind it. That evidence does not survive contact
   * with a channel, though — a message for the parent arriving once the
   * adapters are up resumes it, and the resume closes the dangling call as
   * interrupted. Read live from the sweep, the parent would then look as if
   * it awaited nothing and the child would be re-asked after all, which is
   * the bug this exists to stop. So it is read while nothing can dispatch,
   * and the sweep judges from the snapshot; a child whose parent is missing
   * or not inside such a call is left to ordinary recovery.
   *
   * Matched call by call, not parent by parent: the call that awaits a
   * child names it (see `outstandingDelegationFor`), and a call can await
   * only one. Two parked children claiming the same call — one of them a
   * sub-session continued from outside under a version that kept its
   * markers, parked again on something of its own — is an ambiguity this
   * cannot settle, and both are left to ordinary recovery rather than one
   * of them being failed for a delegation that was never its.
   */
  const listOrphanedDelegations = async (): Promise<Set<string>> => {
    const claimants = new Map<string, string[]>();
    if (!store.listIdsByStatus) {
      return new Set();
    }
    for (const sessionId of await store.listIdsByStatus('pending_approval')) {
      const parentId = delegatingSessionIdOf(sessionId);
      if (parentId === undefined) {
        continue;
      }
      const session = await store.get(sessionId);
      if (!session || !isDelegatedSession(session)) {
        continue;
      }
      const parent = await store.get(parentId);
      const callId = parent ? outstandingDelegationFor(parent, session) : undefined;
      if (callId !== undefined) {
        const key = `${parentId}\u0000${callId}`;
        claimants.set(key, [...(claimants.get(key) ?? []), sessionId]);
      }
    }
    return new Set([...claimants.values()].filter((ids) => ids.length === 1).map(([id]) => id!));
  };

  const recoverOne = (sessionId: string, orphaned: boolean): Promise<void> =>
    onSessionChain(sessionId, () => recoverParked(sessionId, orphaned));

  /**
   * `recoverOne`'s work, for a caller already on the session's chain: a
   * repeated idempotency key that reached the chain before the parked sweep
   * did, and would otherwise wait on a turn nothing is running yet.
   */
  const recoverParked = async (sessionId: string, orphaned: boolean): Promise<void> => {
    if (isStopping()) {
      return;
    }
    try {
      const session = await store.get(sessionId);
      if (!session) {
        return;
      }
      const record = readPendingApproval(session);
      // A delegated sub-session is only ever awaited by its parent's
      // `agent.delegate` call, and that parent was running when the last
      // process died — it is in the abandoned sweep, not in this one.
      // Nothing will read the reply, so the parked call is not re-asked:
      // a person would be approving a command that runs for no one.
      //
      // Judged on the re-read, on the chain: the channels are up before
      // this sweep starts, so a message for this id can have taken the
      // chain first and moved the session on — and a turn that finished
      // normally must not be rewritten as failed. The delegation metadata
      // is durable, so it proves what the session is, not what state it
      // is in; the status and the checkpoint say that.
      //
      // Whether it IS an orphan was decided before the channels started
      // (`listOrphanedDelegations`), from the parent's transcript, which
      // a message arriving since may already have rewritten.
      // A sub-agent never parks (nobody is asked for it), and if one ever
      // did, its parent's turn died with the last process: nothing would
      // read its answer, and recovering it would run it as the full agent.
      if (isSubAgentSession(session) && session.status === 'pending_approval') {
        log(`${sessionId}: a sub-agent parked when the last stratusd stopped; failing it`);
        await failParked(session, ABANDONED_TURN_ERROR);
        return;
      }
      if (orphaned && isDelegatedSession(session) && session.status === 'pending_approval' && record) {
        log(`${sessionId}: parked on ${record.call.toolName} for a delegating turn the last stratusd was still running; failing it`);
        await failOrphanedDelegation(session);
        return;
      }
      // A wait that outlived its window while the daemon was down is
      // honoured, not restarted: the request really did go unanswered for
      // the whole time it was configured to wait, and downtime is not a
      // reason to extend a security decision. Measured from when the turn
      // parked against this daemon's timeout — the transport's original
      // deadline was chosen after the checkpoint was written and is gone
      // with the process that chose it. Denying goes through the same
      // recovery path, so the queue behind it still drains.
      const parkedAt = record ? Date.parse(record.parkedAt) : Number.NaN;
      const expired = effectiveApprovalTimeoutMs > 0
        && Number.isFinite(parkedAt)
        && Date.now() - parkedAt >= effectiveApprovalTimeoutMs;
      if (expired) {
        log(`${sessionId}: the approval for ${record?.call.toolName} outlived its window while the daemon was down; denying it`);
      }

      // Resolved the way a dispatch for this agent would resolve it, so a
      // recovered turn finishes on the same provider, model, and
      // credentials it was parked on.
      const source = await refreshAgent(session.agent.id);

      // And on the CURRENT definition, saved before recovery reads the
      // session back. An allowlist is a permission boundary: a soul that
      // dropped a tool while the daemon was down must not have that tool
      // executed by the turn that outlived the change, and
      // `allowedToolsFor` reads the definition frozen into the session
      // ahead of the registry. Dispatch refreshes it the same way before
      // resuming.
      session.agent = source.definition;
      await store.save(session);

      const recoveredConfig = await runtimeForAgent(source);
      const runner = runnerFor(recoveredConfig, source.definition.id);
      // Tracked like a dispatched turn's controller: a recovered turn that
      // runs on past its approval is a turn like any other, so a restart's
      // window has to be able to cut it short with the same reason (or it
      // runs unseen to the second window and the restart reports
      // undrained), and a stop for the session has to find it. Only once
      // the checkpoint has been read on this chain, right before the runner
      // takes it: a stop counted then always ends in the turn's own
      // outcome. A stop sent during the reads above finds nothing running
      // and reaches the session as an ordinary message, queued behind it.
      const controller = new AbortController();
      if (record) {
        trackTurn(sessionId, controller);
        if (getAbortingWith() !== undefined) {
          controller.abort(shutdownAbort());
        }
      }
      try {
        await onTurnRuntime(sessionId, { source, config: recoveredConfig }, () => runner.recoverPendingApproval(sessionId, {
          denyPending: expired,
          runtime: runtimeContextFor(source, recoveredConfig, session.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true, session.metadata),
          signal: controller.signal,
        }));
      } finally {
        untrackTurn(sessionId, controller);
        // A recovered firing's row outlived the process that would have
        // retired it, and the firing is over either way — a recovery that
        // failed has durably failed its session, which is as finished as
        // completing. The scheduler decides whether there is a row to
        // retire, and only this firing's own.
        const scheduleId = session.metadata?.[SCHEDULE_ID_METADATA_KEY];
        if (typeof scheduleId === 'string') {
          scheduler.retireSpentOneShot(scheduleId, sessionId);
        }
      }
    } catch (error) {
      warn(`could not recover parked session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      // A keyed item is a promise to its caller, and one whose recovery
      // cannot even start (its agent gone, its provider unresolvable) would
      // otherwise stay parked for every later start and redelivery to try
      // again. An unkeyed one keeps waiting for a sweep that can, as before.
      const after = await store.get(sessionId).catch(() => undefined);
      const key = after === undefined ? undefined : turnKeyOf(turnMessageOf(after));
      if (after !== undefined && key !== undefined && after.status === 'pending_approval' && workItemState(after, key) === 'unfinished') {
        await failParked(after, ABANDONED_TURN_ERROR).catch(() => {});
      }
    }
  };

  /**
   * Closes an orphaned sub-session the way the abandoned sweep closes its
   * parent: durably failed, with the checkpoint retired so no later sweep
   * can find a call to re-enter, and announced where surfaces can hear it.
   */
  const failOrphanedDelegation = (session: Session): Promise<void> => failParked(session, ORPHANED_DELEGATION_ERROR);

  const failParked = async (session: Session, error: string): Promise<void> => {
    const metadata = { ...(session.metadata ?? {}) };
    delete metadata[PENDING_APPROVAL_METADATA_KEY];
    session.metadata = metadata;
    recordTurnFailure(session, error);
    await store.save(session);
    await bus.emit({ type: 'session.updated', sessionId: session.id, status: 'failed' });
    await bus.emit({ type: 'session.failed', sessionId: session.id, error });
  };

  /**
   * Turns the last process was still running when it stopped being able to
   * finish them.
   *
   * `pending_approval` is the one window a turn can be picked up from, and
   * it has its own sweep above. Everything else a turn does is saved as
   * `running`: the provider call, the executor, and — on a provider that
   * hosts its own loop — the approval wait too, since a hosted call is
   * deliberately not checkpointed (`executeHostedToolCall` passes
   * `recoverable: false`, because the SDK's inner loop is not something a
   * restart can rebuild). None of those can be re-entered where they
   * stopped, and nothing else sweeps them, so the record would go on
   * claiming the turn is running for as long as the session exists. A turn
   * whose caller gave it an idempotency key is continued from its
   * transcript instead, with its dangling calls closed as interrupted
   * (`settleAbandonedTurn`); the rest are failed.
   *
   * Note what this is *not* for. A graceful stop denies everything parked
   * and drains the turns those denials release, so an operator restarting
   * the daemon normally has nothing here. These are the turns a crash, a
   * SIGKILL, or a lost machine left behind.
   */
  const listAbandonedTurns = async (): Promise<string[]> => {
    if (!store.listIdsByStatus) {
      return [];
    }
    return store.listIdsByStatus('running');
  };

  /**
   * Settles each of them — continued if keyed, otherwise marked failed with
   * a reason that says what happened.
   *
   * Read BEFORE the channels start and applied after, which is the only
   * ordering that is both honest and safe. Reading first means the list is
   * exactly what the last process left, with no chance of a turn this
   * process started being in it. Applying after means the failure is
   * emitted into a gateway whose surfaces are listening, rather than into
   * one where nothing is.
   *
   * The gap between the two is real, though: an inbound message for one of
   * these sessions can arrive as soon as the channels are up. What makes
   * that safe is single-flight — every writer of a session goes through
   * `onSessionChain`, so this runs either wholly before that turn (it
   * fails, and `resume()` then clears `lastError` and starts fresh) or
   * wholly after it (the status has moved off `running`, and the re-read
   * below leaves it alone). There is no interleaving in which this
   * overwrites a live turn.
   *
   * What that invariant does NOT cover is a second daemon on the same
   * database, whose turns are running with no chain of ours in front of
   * them. Two processes sharing a session store is already unsupported —
   * the parked sweep above would re-ask that daemon's approvals for the
   * same reason — and no check here would make it supported.
   */
  const failAbandonedTurns = async (all: string[]): Promise<void> => {
    const taskWorkers = getTaskWorkersAtStart();
    const abandoned = all.filter((id) => !taskWorkers.has(id));
    if (abandoned.length === 0) {
      return;
    }
    log(`settling ${abandoned.length} turn(s) left running by the last stratusd`);
    await Promise.allSettled(abandoned.map((id) => failAbandonedTurn(id)));
  };

  const failAbandonedTurn = (id: string): Promise<void> =>
    onSessionChain(id, async () => {
      if (isStopping()) {
        return;
      }
      try {
        const session = await store.get(id);
        // Re-read on the chain, because the snapshot is from before the
        // channels came up: a message that arrived since has already taken
        // this session somewhere else, and that turn owns it now.
        if (!session || session.status !== 'running') {
          return;
        }
        await settleAbandonedTurn(session);
      } catch (error) {
        warn(`could not settle abandoned turn ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  /**
   * A turn left `running` with nothing running it, read on its chain.
   *
   * One whose message carries an idempotency key is a work item its caller
   * was promised would finish, so it is continued from the transcript
   * (`AgentRunner.continueTurn`) — once. A turn that already was, and is
   * here again, took the last process down with it, and continuing it again
   * would do the same on every start; it is failed like an unkeyed one,
   * whose caller was never promised anything and is told to send again.
   */
  const settleAbandonedTurn = async (session: Session): Promise<Session> => {
    const message = turnMessageOf(session);
    if (message === undefined || turnKeyOf(message) === undefined) {
      return failAbandoned(session);
    }
    // An answer already in the transcript is completed whatever came before
    // — a second crash, a harness, an agent or provider gone since —
    // because completing it needs none of them and runs nothing again;
    // failing it would throw away a finished reply.
    if (lastResponseIsAnswer(session)) {
      log(`${session.id}: a keyed turn the last stratusd was running had saved its answer; completing it`);
      return completeAnsweredTurn(session, store, bus);
    }
    if (message.continuedAfterCrash === true) {
      return failAbandoned(session);
    }
    if (message.hostedLoop === true) {
      log(`${session.id}: a keyed turn the last stratusd was running could reach a harness, which cannot be continued; failing it`);
      return failAbandoned(session);
    }
    return continueAbandonedTurn(session);
  };

  const failAbandoned = async (session: Session): Promise<Session> => {
    recordTurnFailure(session, ABANDONED_TURN_ERROR);
    await store.save(session);
    await bus.emit({ type: 'session.updated', sessionId: session.id, status: 'failed' });
    await bus.emit({ type: 'session.failed', sessionId: session.id, error: ABANDONED_TURN_ERROR });
    return session;
  };

  /**
   * Continues an abandoned turn on the configuration a dispatch for its
   * agent would resolve now, and under the same watchdog — it is a provider
   * call like any turn's. The definition is refreshed and saved first, as
   * `recoverOne` does and for the same reason: an allowlist is a permission
   * boundary, and a tool dropped while the daemon was down must not run.
   *
   * Not on a harness (`runsOnHarness`) — neither one the turn could have
   * run on (`Message.hostedLoop`, recorded when it was accepted) nor one it
   * would continue on. A harness runs its own tool loop inside a single
   * provider call and keeps its own conversation, so the prompt the dead
   * turn sent may already have run tools there that the transcript never
   * saw, and continuing would send it again. That turn is failed as an
   * unkeyed one is — the same answer as before keys existed. (A turn whose
   * answer is already saved never gets here: `settleAbandonedTurn`
   * completes it first.)
   */
  const continueAbandonedTurn = async (session: Session): Promise<Session> => {
    // Its parent's turn died with the last process, and continuing it here
    // would run it as the full agent. (Sub-agent turns carry no key today,
    // so this is a guard, not a path.)
    if (isSubAgentSession(session)) {
      return failAbandoned(session);
    }
    // Settled either way: a turn whose agent left the roster, or whose
    // provider no longer resolves, must not stay `running` for every later
    // start and every redelivery to find unfinished and trip over again.
    let source: AgentSource;
    let config: RuntimeConfig;
    try {
      source = await refreshAgent(session.agent.id);
      config = await runtimeForAgent(source);
    } catch (error) {
      log(`${session.id}: a keyed turn the last stratusd was running cannot be continued (${error instanceof Error ? error.message : String(error)}); failing it`);
      return failAbandoned(session);
    }
    const { switchedToFallback, effectiveStreams, fallbackStreams } = watchdogStreamsFor(session, config);
    // The message's own record covers the runtimes the turn could have run
    // on; this covers the ones it would continue on — a fallback included —
    // which a changed config may make a harness.
    if (reachesHarness(config, switchedToFallback)) {
      log(`${session.id}: a keyed turn the last stratusd was running would continue on a harness; failing it`);
      return failAbandoned(session);
    }
    log(`${session.id}: continuing a keyed turn the last stratusd was still running`);
    session.agent = source.definition;
    await store.save(session);
    const runner = runnerFor(config, source.definition.id);
    return onTurnRuntime(session.id, { source, config }, () => withWatchdog(session.id, undefined, effectiveStreams, fallbackStreams, async (signal) =>
      await runner.continueTurn(session.id, {
        runtime: runtimeContextFor(source, config, switchedToFallback, session.metadata),
        signal,
      }) ?? session));
  };

  /**
   * A repeated idempotency key that reached the session's chain, so nothing
   * else is running on the session. `undefined` means the key is new here
   * and the dispatch runs as any other; otherwise this is the session to
   * resolve with, and no new turn starts.
   *
   * An unfinished item here has no live turn — the live map would have
   * answered first — so it is one the last process left, reached before
   * the start-up sweep that would have settled it: settled now, the way
   * that sweep would, which then finds it no longer needs anything.
   */
  const settleRepeat = async (
    sessionId: string,
    idempotencyKey: string,
    agentId: string | undefined,
    turnId: string | undefined,
    onRepeat: DispatchInput['onRepeat'],
  ): Promise<Session | undefined> => {
    const session = await store.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    // Before anything is returned: the turn a dispatch would run is refused
    // for naming another agent, and the one it would repeat is no less that
    // agent's — a repeat is not a way to read its transcript.
    if (agentId !== undefined && session.agent.id !== agentId) {
      throw crossIdentityError(sessionId, session.agent.id, agentId);
    }
    const state = workItemState(session, idempotencyKey);
    if (state === undefined) {
      const archived = await archivedRepeat(session, idempotencyKey);
      if (archived !== undefined) {
        onRepeat?.('finished');
      }
      return archived;
    }
    if (state === 'finished') {
      onRepeat?.('finished');
      return session;
    }
    // Run now, on this caller's behalf, so its events are this caller's
    // turn — the adapter waiting on them has no other way to claim them.
    if (turnId !== undefined) {
      activeTurns.set(sessionId, turnId);
    }
    try {
      return await settleUnfinished(session);
    } finally {
      if (turnId !== undefined) {
        activeTurns.delete(sessionId);
      }
    }
  };

  /**
   * The archived transcript holding a key the live row does not, when the
   * row is a rollover's fresh one made inside `ROLLOVER_REPEAT_WINDOW_MS`.
   * Only the one rollover back: a second inside the window is a redelivery
   * outliving two deliberate resets, and the chain is not walked for it.
   * Always finished — a rollover refuses a session with a turn in flight.
   */
  const archivedRepeat = async (session: Session, idempotencyKey: string): Promise<Session | undefined> => {
    const archivedAs = session.metadata?.[ROLLED_OVER_FROM_METADATA_KEY];
    if (typeof archivedAs !== 'string' || Date.now() - Date.parse(session.createdAt) > ROLLOVER_REPEAT_WINDOW_MS) {
      return undefined;
    }
    const archived = await store.get(archivedAs);
    return archived !== undefined && workItemState(archived, idempotencyKey) !== undefined ? archived : undefined;
  };

  /** An unfinished item with no live turn, settled the way the start-up sweeps would. */
  const settleUnfinished = async (session: Session): Promise<Session> => {
    if (session.status === 'pending_approval') {
      await recoverParked(session.id, getOrphanedAtStart().has(session.id));
      return (await store.get(session.id)) ?? session;
    }
    return settleAbandonedTurn(session);
  };

  return {
    recoverParkedTurns,
    listOrphanedDelegations,
    listAbandonedTurns,
    failAbandonedTurns,
    settleRepeat,
    archivedRepeat,
    settleUnfinished,
  };
};

export type Recovery = ReturnType<typeof createRecovery>;
