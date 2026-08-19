import type { StratusEvent } from '@stratusagent/core';
import type { Gateway } from '@stratusagent/gateway';
import type { WebSocket } from 'ws';

/**
 * What a client asked to see. Both filters are ANDed, and both are optional —
 * no filter is a subscription to the whole fleet, which is what a monitoring
 * view wants.
 */
export interface EventFilter {
  sessionId?: string;
  agentId?: string;
}

/**
 * One frame on the wire.
 *
 * The turn id lives on the envelope rather than inside the event because
 * `StratusEvent` has no turn identifier and should not grow one: it is the
 * kernel's vocabulary, and "which of this client's requests caused this" is a
 * transport concern. Without it a session that processes several messages in
 * sequence gives a client no way to tell its own deltas from the next
 * caller's.
 */
export interface EventEnvelope {
  sessionId: string;
  turnId?: string;
  event: StratusEvent;
}

/**
 * How much unsent data a socket may accumulate before deltas start being
 * dropped for it.
 *
 * A slow reader is the normal case — a backgrounded tab, a laptop that slept
 * — and a streaming turn produces a frame per token. Without a ceiling that
 * backlog is unbounded daemon memory held on behalf of a client that may
 * never read again.
 */
const MAX_BUFFERED_BYTES = 1_048_576;

interface Client {
  socket: WebSocket;
  filter: EventFilter;
  /**
   * Sessions known to belong to the filtered agent.
   *
   * Resolved once at subscribe time from the store and extended as
   * `session.created` arrives, because most events name only a session and
   * looking the agent up per event would mean an async hop in the middle of a
   * synchronous fan-out — which reorders the stream it is trying to deliver.
   */
  agentSessions: Set<string> | undefined;
  /** Deltas dropped for this client, reported once the backlog clears. */
  dropped: number;
}

export const createEventStream = (gateway: Gateway) => {
  const clients = new Set<Client>();
  /**
   * Turn ids for events emitted *outside* the turn they belong to.
   *
   * The gateway clears its active turn in a `finally` inside the chained
   * work, so a dispatch that rejects has already lost it by the time anything
   * can react to the rejection. A failure reported without the turn id the
   * caller was handed is a turn they cannot recognise — and so one their UI
   * shows as running forever.
   */
  const turnOverrides = new Map<string, string>();
  /**
   * Turns whose own terminal event this stream has already seen.
   *
   * A dispatch that rejects has to decide whether the runner got far enough
   * to report the failure itself. Asking the session's status cannot answer
   * that: a session left `failed` by an earlier turn looks identical to one
   * this turn just failed, so a preflight failure on a retry would be
   * swallowed and the caller's turn id would never receive a terminal event.
   *
   * Registered for the life of a dispatch and released after, so this holds
   * turns in flight rather than every session the daemon has served.
   */
  const watchedTurns = new Map<string, { reported: boolean }>();
  const watchKey = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

  const resolveAgentSessions = (agentId: string): Set<string> =>
    new Set(gateway.store.list(agentId).map((session) => session.id));

  const applyFilter = (client: Client, filter: EventFilter): void => {
    client.filter = filter;
    client.agentSessions = filter.agentId === undefined
      ? undefined
      : resolveAgentSessions(filter.agentId);
  };

  const wants = (client: Client, event: StratusEvent): boolean => {
    if (client.filter.sessionId !== undefined && event.sessionId !== client.filter.sessionId) {
      return false;
    }
    if (client.agentSessions && !client.agentSessions.has(event.sessionId)) {
      return false;
    }
    return true;
  };

  const send = (client: Client, envelope: EventEnvelope): void => {
    if (client.socket.readyState !== client.socket.OPEN) {
      return;
    }
    // Deltas are the droppable ones, and only they: losing a token from a
    // reply a client cannot keep up with is a cosmetic gap, while losing a
    // completion, a failure, or an approval leaves a UI stuck on a turn that
    // already ended.
    if (envelope.event.type === 'provider.delta' && client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.dropped += 1;
      return;
    }
    if (client.dropped > 0 && envelope.event.type !== 'provider.delta') {
      // Said once, when the backlog has cleared enough to say it: a client
      // that silently missed output should know its transcript has a hole.
      const skipped = client.dropped;
      client.dropped = 0;
      client.socket.send(JSON.stringify({ type: 'dropped', deltas: skipped }));
    }
    client.socket.send(JSON.stringify(envelope));
  };

  /**
   * Deliberately synchronous.
   *
   * `EventBus.emit` awaits every subscriber in order, so anything awaited
   * here lands on the critical path of each streamed token — for every
   * connected client. `ws.send` queues and returns, which is exactly the
   * shape this needs.
   */
  const unsubscribe = gateway.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'session.created') {
      for (const client of clients) {
        if (client.filter.agentId === event.agentId) {
          client.agentSessions?.add(event.sessionId);
        }
      }
    }
    // The override wins, and is not a fallback. It is set only for the span
    // of a `withTurn` call, and everything emitted inside that span belongs
    // to the turn it names — while `activeTurnId` answers about whatever the
    // session chain is running *now*. Those differ exactly when two messages
    // are queued on one session and the first is rejected during preflight:
    // the chain can already have started the second turn by the time the
    // first route emits its synthetic failure, so ranking `activeTurnId`
    // first stamped that failure with the second turn's id — falsely killing
    // a turn that was fine while the client waiting on the first one never
    // heard anything.
    const turnId = turnOverrides.get(event.sessionId) ?? gateway.activeTurnId(event.sessionId);
    if (turnId !== undefined && (event.type === 'session.failed' || event.type === 'session.completed')) {
      // Noted before the no-clients shortcut below: whether a turn reported
      // its own outcome is not a question about who is watching.
      const watched = watchedTurns.get(watchKey(event.sessionId, turnId));
      if (watched) {
        watched.reported = true;
      }
    }
    if (clients.size === 0) {
      return;
    }
    const envelope: EventEnvelope = {
      sessionId: event.sessionId,
      ...(turnId ? { turnId } : {}),
      event,
    };
    for (const client of clients) {
      if (wants(client, event)) {
        send(client, envelope);
      }
    }
  });

  return {
    /** Register a connected socket and start delivering to it. */
    attach(socket: WebSocket, filter: EventFilter): void {
      const client: Client = { socket, filter: {}, agentSessions: undefined, dropped: 0 };
      applyFilter(client, filter);
      clients.add(client);

      socket.on('message', (data) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(data));
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Frames must be JSON.' }));
          return;
        }
        if (typeof frame !== 'object' || frame === null) {
          socket.send(JSON.stringify({ type: 'error', message: 'Frames must be JSON objects.' }));
          return;
        }
        const message = frame as { type?: unknown; sessionId?: unknown; agentId?: unknown };
        if (message.type !== 'subscribe') {
          socket.send(JSON.stringify({ type: 'error', message: `Unknown frame type: ${String(message.type)}` }));
          return;
        }
        applyFilter(client, {
          ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
          ...(typeof message.agentId === 'string' ? { agentId: message.agentId } : {}),
        });
        socket.send(JSON.stringify({ type: 'subscribed', filter: client.filter }));
      });

      const drop = (): void => {
        clients.delete(client);
      };
      socket.on('close', drop);
      socket.on('error', drop);

      socket.send(JSON.stringify({ type: 'subscribed', filter: client.filter }));
    },

    /**
     * Watch a turn for a terminal event of its own, until released.
     *
     * The caller dispatches, and on rejection asks `reported()` whether the
     * runner already emitted `session.failed` or `session.completed` for
     * *this* turn — the only honest way to tell a failure that reported
     * itself from one that never reached the runner at all.
     */
    watchTurn(sessionId: string, turnId: string) {
      const key = watchKey(sessionId, turnId);
      const record = { reported: false };
      watchedTurns.set(key, record);
      return {
        reported: (): boolean => record.reported,
        release: (): void => {
          watchedTurns.delete(key);
        },
      };
    },

    /**
     * Run `work` with events for this session stamped as belonging to this
     * turn. Scoped to the call, so nothing can leak onto a later turn.
     */
    async withTurn(sessionId: string, turnId: string, work: () => Promise<void>): Promise<void> {
      turnOverrides.set(sessionId, turnId);
      try {
        await work();
      } finally {
        turnOverrides.delete(sessionId);
      }
    },

    /** Test seam: how many sockets are being served. */
    clientCount(): number {
      return clients.size;
    },

    close(): void {
      unsubscribe();
      for (const client of clients) {
        client.socket.close(1001, 'stratusd is stopping');
      }
      clients.clear();
    },
  };
};

export type EventStream = ReturnType<typeof createEventStream>;
