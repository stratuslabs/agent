/*
 * The gateway's approval broker: parked tool calls waiting on a person, how
 * a request is asked (and refused for a sub-agent or during shutdown), how an
 * answer settles it, and the per-session approval waits the turn watchdog
 * reads. Moved out of `createGateway` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * `createGateway` calls it where they were and destructures what it returns.
 * The one edit: `stopping` is a `let` declared later in `createGateway`, so
 * the broker reads it through `isStopping()`.
 */

import { randomUUID } from 'node:crypto';
import type {
  ApprovalAnswer,
  ApprovalDelegationOrigin,
  ApprovalOutcome,
  ApprovalResolutionReason,
  EventBus,
  Session,
} from '@stratusagent/core';
import { isDelegatedSession, ROOT_SESSION_ID_METADATA_KEY } from '@stratusagent/agents';
import type { SchedulerRuntime } from './schedules.ts';
import type { ShardedSessionStore } from './sessions.ts';
import type {
  ApprovalRequester,
  GatewayApprovalRequest,
  PendingApproval,
  ResolveApprovalInput,
} from './types.ts';
import { isSubAgentSession } from './session-keys.ts';

export type SettleApproval = (
  answer: ApprovalAnswer,
  reason: ApprovalResolutionReason,
  actor?: string,
) => void;

/**
 * One parked call: how to settle it, and what it is. The summary is kept
 * alongside the settler because a listing needs the request itself, and
 * the map is the only place that knows a request is still outstanding.
 */
export interface ParkedCall {
  settle: SettleApproval;
  pending: PendingApproval;
}

/** What the approval broker closes over in `createGateway`. */
export interface ApprovalBrokerDeps {
  warn: (line: string) => void;
  bus: EventBus;
  store: ShardedSessionStore;
  scheduler: SchedulerRuntime;
  effectiveApprovalTimeoutMs: number;
  isStopping: () => boolean;
}

export const createApprovalBroker = ({
  warn,
  bus,
  store,
  scheduler,
  effectiveApprovalTimeoutMs,
  isStopping,
}: ApprovalBrokerDeps) => {
  const pendingApprovals = new Map<string, ParkedCall>();

  /**
   * In-flight `tool.approval-resolved` emissions. `EventBus.emit` awaits its
   * subscribers in order, so one async handler ahead of a channel adapter
   * suspends the emission before the adapter ever sees it. Nothing today is
   * async in front of one — which is exactly the problem: the shutdown
   * guarantee below would rest on that staying true, and the first async
   * subscriber anyone adds would silently leave live-looking buttons in a
   * workspace the daemon has left.
   */
  const approvalEmissions = new Set<Promise<void>>();

  /**
   * Publishes one parked call and settles when somebody answers it, the
   * request expires, or the turn is cancelled.
   *
   * All three endings run through the same `settle`, which removes the
   * request from the registry BEFORE resolving. That ordering is the whole
   * point: a request that is no longer pending cannot be resolved twice,
   * so a click racing the timeout — or arriving after an abort — is refused
   * rather than executing a tool for a turn that has already moved on.
   */
  /**
   * The conversation a delegated sub-session's work was asked from, read
   * from the store rather than from anything the caller wrote: the root
   * session `agent.delegate` recorded, which is where the person waiting
   * on the answer is. Undefined for an ordinary session, or a root that no
   * longer exists — the request is then asked the way it always was.
   */
  const delegationOriginOf = async (session: Session): Promise<ApprovalDelegationOrigin | undefined> => {
    if (!isDelegatedSession(session)) {
      return undefined;
    }
    const rootId = session.metadata?.[ROOT_SESSION_ID_METADATA_KEY];
    if (typeof rootId !== 'string' || rootId === session.id) {
      return undefined;
    }
    let root: Session | undefined;
    try {
      root = await store.get(rootId);
    } catch (error) {
      warn(`${session.id}: could not read the delegating session ${rootId} to route an approval (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
    if (!root) {
      return undefined;
    }
    return { agentId: root.agent.id, sessionId: root.id, ...(root.metadata ? { metadata: root.metadata } : {}) };
  };

  /**
   * Which sessions are sub-agents, as the host knows it rather than as the
   * session says (roadmap 24). Every tool in a slice is handed the same
   * mutable Session, so the metadata marker and the id are claims a tool
   * can rewrite. The ids are the ones `subAgents.run` minted, held while
   * the sub-agent runs. A session object's id is read once, by the
   * executor on its first tool call, before any tool has been handed it,
   * so a session a tool renamed is still known by the id it ran under.
   */
  const liveSubAgentIds = new Set<string>();

  const idAtFirstCall = new WeakMap<Session, string>();

  const hostIdOf = (session: Session): string => idAtFirstCall.get(session) ?? session.id;

  const isHostSubAgent = (session: Session): boolean =>
    liveSubAgentIds.has(hostIdOf(session)) || isSubAgentSession(session);

  const requestApproval: ApprovalRequester = async (request) => {
    // A sub-agent asks no one (roadmap 24): its parent turn is the one a
    // person is accountable for, and that turn gets the refusal back as a
    // result and decides what to do. Denied as undeliverable, since nobody
    // was asked, and announced only as a resolution, so no channel renders
    // a question nobody may answer.
    if (isHostSubAgent(request.session)) {
      void bus.emit({
        type: 'tool.approval-resolved',
        sessionId: request.session.id,
        requestId: randomUUID(),
        answer: 'deny',
        reason: 'undeliverable',
      });
      return { answer: 'deny' };
    }
    const delegatedFrom = await delegationOriginOf(request.session);
    return requestApprovalFrom(request, delegatedFrom);
  };

  const requestApprovalFrom = (
    request: GatewayApprovalRequest,
    delegatedFrom: ApprovalDelegationOrigin | undefined,
  ): Promise<ApprovalOutcome> => new Promise<ApprovalOutcome>((resolve) => {
    // A shutdown denies what is parked once, at the top of stop(). Turns
    // already running keep going through the drain, though, and one of them
    // can reach a gated tool AFTER that snapshot — finishing a provider
    // call, or moving to the next call in the same response. Parking it
    // would deadlock the drain against a question nobody is left to answer:
    // stop() waits for the turn, the turn waits for the approval, and the
    // approval waits out its timeout — forever when there is none.
    if (isStopping()) {
      resolve({ answer: 'deny' });
      void bus.emit({
        type: 'tool.approval-resolved',
        sessionId: request.session.id,
        requestId: randomUUID(),
        answer: 'deny',
        reason: 'cancelled',
      });
      return;
    }

    const requestId = randomUUID();

    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => settle('deny', 'cancelled');

    /**
     * Settles once the request has finished being announced.
     *
     * Both emissions go through the same subscriber list, in order, and
     * `EventBus.emit` awaits each one — so an async subscriber ahead of a
     * channel can hold the announcement while a timeout or abort fires
     * behind it, and the channel would hear that a request it has never
     * heard of was resolved. It drops that, then renders the announcement
     * when it finally arrives, leaving buttons for a settled request that
     * nothing will ever retract.
     *
     * Chaining is the fix rather than remembering orphaned resolutions in
     * the channel: a resolution that arrives before its request is not
     * something a consumer can act on, so it should not be able to happen.
     * Starts resolved, because a turn already aborted never announces at
     * all and its denial should not wait on an emission that never runs.
     */
    let announced: Promise<void> = Promise.resolve();

    // Read when the request is made, from the scheduler's own records: a
    // live firing of a schedule approved with a destination, nothing else.
    // Delegated work is not included yet; its sub-session is not a firing.
    const scheduleDestination = scheduler.approvalDestinationFor(request.session);

    // Work one agent does for another is allowed one call at a time. The
    // people asked are the delegating conversation's, and a standing grant
    // would widen what the other agent may do on its own work for good —
    // so nothing offers **Always allow** here, and an `always` that
    // arrives anyway (the control API takes all three answers) runs the
    // call once, recorded as exactly that.
    const forAnotherAgent = delegatedFrom !== undefined && delegatedFrom.agentId !== request.session.agent.id;
    const oneShot = request.oneShot === true || forAnotherAgent;
    const always = forAnotherAgent ? undefined : request.always;

    const settle: SettleApproval = (given, reason, actor) => {
      const answer: ApprovalAnswer = forAnotherAgent && given === 'always' ? 'once' : given;
      // Identity, not presence: a request that already settled is gone from
      // the registry, and comparing against this exact function is what
      // makes every ending — click, timeout, abort, shutdown — idempotent.
      if (pendingApprovals.get(requestId)?.settle !== settle) {
        return;
      }
      pendingApprovals.delete(requestId);
      if (timer) {
        clearTimeout(timer);
      }
      request.signal?.removeEventListener('abort', onAbort);
      resolve({ answer, ...(actor ? { actor } : {}) });
      const emitted = announced.then(() => bus.emit({
        type: 'tool.approval-resolved',
        sessionId: request.session.id,
        requestId,
        answer,
        reason,
        ...(actor ? { actor } : {}),
      }));
      approvalEmissions.add(emitted);
      void emitted.finally(() => approvalEmissions.delete(emitted));
    };

    // What is left of the window, not a fresh one: a re-asked request
    // carries when it originally parked, and the elapsed time counts.
    // Computed before registration because the summary below quotes the
    // deadline, and a listing that disagreed with the announcing event about
    // when a request expires would be worse than one that said nothing.
    const alreadyWaitedMs = request.parkedAt ? Date.now() - Date.parse(request.parkedAt) : 0;
    const remainingTimeoutMs = effectiveApprovalTimeoutMs > 0
      ? effectiveApprovalTimeoutMs - (Number.isFinite(alreadyWaitedMs) ? Math.max(0, alreadyWaitedMs) : 0)
      : 0;
    const expiresAt = remainingTimeoutMs > 0
      ? new Date(Date.now() + remainingTimeoutMs).toISOString()
      : undefined;

    pendingApprovals.set(requestId, {
      settle,
      pending: {
        requestId,
        sessionId: request.session.id,
        agentId: request.session.agent.id,
        call: request.call,
        risk: request.risk,
        ...(request.origin !== undefined ? { origin: request.origin } : {}),
        ...(oneShot ? { oneShot: true } : {}),
        ...(always !== undefined ? { always } : {}),
        ...(request.reviewNote !== undefined ? { reviewNote: request.reviewNote } : {}),
        parkedAt: request.parkedAt ?? new Date().toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
        ...(request.session.metadata ? { metadata: request.session.metadata } : {}),
        ...(delegatedFrom ? { delegatedFrom } : {}),
        ...(scheduleDestination ? { scheduleDestination } : {}),
      },
    });

    if (effectiveApprovalTimeoutMs > 0 && remainingTimeoutMs <= 0) {
      // Nothing left to wait with. Settled here rather than armed with a
      // zero timer, which `setTimeout` would still run a tick later — long
      // enough to announce a request that is already over.
      settle('deny', 'timeout');
      return;
    }

    if (remainingTimeoutMs > 0) {
      // Deliberately NOT unref'd. A parked turn is real outstanding work,
      // and its timer is the only thing that will ever finish it — letting
      // the process exit out from under one would abandon the turn instead
      // of denying it. Shutdown is handled where it belongs, in stop(),
      // which settles every outstanding request before draining.
      timer = setTimeout(() => settle('deny', 'timeout'), remainingTimeoutMs);
    }

    // The abort listener is attached before the request is announced, so a
    // turn cancelled while the event is still being delivered still ends
    // the request rather than leaving it pending forever.
    if (request.signal) {
      if (request.signal.aborted) {
        settle('deny', 'cancelled');
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });
    }

    // `announced` is assigned BEFORE the emission starts, because emit runs
    // its first subscribers synchronously — one of them settling the
    // request inline would otherwise chain onto the already-resolved
    // placeholder and race the very announcement it is answering.
    let markAnnounced = (): void => {};
    announced = new Promise<void>((resolveAnnounced) => {
      markAnnounced = resolveAnnounced;
    });
    const announcing = bus.emit({
      type: 'tool.approval-requested',
      sessionId: request.session.id,
      agentId: request.session.agent.id,
      requestId,
      call: request.call,
      risk: request.risk,
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      ...(oneShot ? { oneShot: true } : {}),
      ...(always !== undefined ? { always } : {}),
      ...(request.reviewNote !== undefined ? { reviewNote: request.reviewNote } : {}),
      ...(request.session.metadata ? { metadata: request.session.metadata } : {}),
      ...(delegatedFrom ? { delegatedFrom } : {}),
      ...(scheduleDestination ? { scheduleDestination } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    // Drained at shutdown alongside the resolutions: a channel that has not
    // yet been told a request exists cannot be told it was denied either.
    approvalEmissions.add(announcing);
    void announcing.finally(() => {
      approvalEmissions.delete(announcing);
      markAnnounced();
    });
  });

  const resolveApproval = (input: ResolveApprovalInput): boolean => {
    const parked = pendingApprovals.get(input.requestId);
    if (!parked) {
      return false;
    }
    parked.settle(input.answer, input.reason ?? 'decided', input.actor);
    return true;
  };

  /**
   * How a turn's watchdog stops its own clock, registered while it runs.
   *
   * Recording that a tool phase is open is not enough on its own: the
   * timer is only re-evaluated when an event arrives, so a phase opened by
   * something that emits nothing — an approval policy handed straight to
   * the gateway — would leave an already-armed timer running to fire
   * mid-wait.
   */
  const suspendWatchdog = new Map<string, () => void>();

  /**
   * Approval waits in progress, per session.
   *
   * Deliberately a balanced counter and not a set of call ids. An earlier
   * shape had the approval wrapper *open* a phase that the watchdog's
   * event observer was expected to close, and that handoff was wrong in
   * every way it could be: the observer does not exist when no watchdog is
   * armed, so nothing closed it; a policy that threw closed nothing; and a
   * stale entry did not merely leak, it suppressed the watchdog for the
   * next turn on that session. Four separate exits, each patched in turn.
   *
   * A counter incremented and decremented in one `finally` cannot have any
   * of those bugs, because the thing that opens the phase is the thing
   * that closes it, in the same scope, on every path out.
   */
  const approvalWaits = new Map<string, number>();

  const holdApprovalWait = (sessionId: string): (() => void) => {
    approvalWaits.set(sessionId, (approvalWaits.get(sessionId) ?? 0) + 1);
    // Stop any clock already running: this wait produces no events, so
    // nothing else would.
    suspendWatchdog.get(sessionId)?.();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (approvalWaits.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        approvalWaits.set(sessionId, remaining);
      } else {
        approvalWaits.delete(sessionId);
      }
    };
  };

  return {
    pendingApprovals,
    approvalEmissions,
    liveSubAgentIds,
    idAtFirstCall,
    hostIdOf,
    isHostSubAgent,
    requestApproval,
    resolveApproval,
    suspendWatchdog,
    approvalWaits,
    holdApprovalWait,
  };
};

export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
