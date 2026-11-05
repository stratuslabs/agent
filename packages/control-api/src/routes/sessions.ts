import { randomUUID } from 'node:crypto';
import { isValidSessionId, MAX_SESSION_ID_LENGTH } from '@stratusagent/agents';
import type { JsonObject } from '@stratusagent/core';
import {
  isScheduleSessionId,
  RESERVED_SESSION_METADATA_KEYS,
  reservedSessionMetadataKey,
  DEFAULT_PAUSED_MESSAGE,
  HELD_MESSAGE,
  ROLLED_OVER_TO_METADATA_KEY,
  SCHEDULE_SESSION_ID_PREFIX,
} from '@stratusagent/gateway';
import { redactProviderReplayState } from '@stratusagent/state';

import { API_PREFIX, ApiError, optionalString, readJsonObject, requireString } from '../http.ts';
import type { Route } from '../routes.ts';

export const sessionRoutes: Route[] = [
  // ---- sessions ------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/sessions`,
    async handler(context) {
      const agent = context.url.searchParams.get('agent') ?? undefined;
      const raw = context.url.searchParams.get('limit');
      if (raw !== null && !/^\d+$/.test(raw)) {
        throw new ApiError(400, 'invalid_limit', 'limit must be a non-negative whole number.');
      }
      return {
        sessions: context.gateway.store.list(agent, raw === null ? undefined : Number(raw)),
      };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/sessions/:id`,
    async handler(context) {
      const session = await context.gateway.store.get(context.params.id ?? '');
      if (!session) {
        throw new ApiError(404, 'session_not_found', `No session with id ${context.params.id}.`);
      }
      // Provider replay state is an implementation detail of resumption, and
      // it carries raw model turns. It never leaves the daemon.
      return { session: redactProviderReplayState(session) };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/sessions/:id/messages`,
    async handler(context) {
      const sessionId = context.params.id ?? '';
      const body = await readJsonObject(context.request);
      const message = requireString(body, 'message');
      const agentId = optionalString(body, 'agentId');

      // The gateway refuses this at its own door and nothing is created —
      // but it refuses by rejecting the dispatch, which nobody is awaiting,
      // so the caller was handed a 202 and a turn id for a turn that could
      // never run. Preflighted here for the same reason the two checks
      // below are: a refusal the caller can see beats one only the event
      // stream carries.
      // Paused intake is refused here for the same reason: the dispatch is
      // not awaited, so its refusal would otherwise reach only the stream.
      if (context.gateway.intake().paused) {
        throw new ApiError(503, 'intake_paused', context.gateway.intake().message ?? DEFAULT_PAUSED_MESSAGE);
      }
      if (context.gateway.held()) {
        throw new ApiError(503, 'held', HELD_MESSAGE);
      }

      if (isScheduleSessionId(sessionId)) {
        throw new ApiError(
          400,
          'session_id_reserved',
          `Session ids beginning with "${SCHEDULE_SESSION_ID_PREFIX}" belong to scheduled firings and cannot be dispatched externally. `
            + 'Use your own id for a conversation; `GET /schedules` lists the schedules whose firings own those.',
        );
      }

      const existing = await context.gateway.store.get(sessionId);
      if (!existing && agentId === undefined) {
        throw new ApiError(
          400,
          'agent_required',
          'A new session needs an explicit agentId: there is no stored agent to recover one from.',
        );
      }
      if (agentId !== undefined && !context.gateway.agents().some((agent) => agent.id === agentId)) {
        // Caught here so a typo answers 404 rather than being accepted and
        // then failing where only the event stream can see it.
        throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}.`);
      }
      // The stored agent is held to the roster too. A soul removed since
      // the conversation started is the same failure one door later: the
      // dispatch rejects "Agent not found" with nobody awaiting it, the
      // caller holds a 202 and a turn id, and the session record shows
      // nothing — the message is not even on it. Seen against a running
      // daemon: `session.failed` on the event stream, and a session still
      // reading `completed` with the message that failed absent from it.
      if (existing && !context.gateway.agents().some((agent) => agent.id === existing.agent.id)) {
        throw new ApiError(
          404,
          'agent_not_found',
          `Session ${sessionId} belongs to agent ${existing.agent.id}, which is not on the roster now. `
            + 'Restore its soul under ~/.stratus/agents and reload the roster, or start a new session with an agent that is.',
        );
      }
      // After the agent checks, deliberately: the length budget spends the
      // agent id this session addresses, and that only means anything once
      // the id is known to be a real one off the roster.
      //
      // Only a NEW id is held to the rule. An id already in the store
      // addresses a real conversation whatever shape it is, and refusing it
      // here would lock a caller out of its own history over a rule that
      // postdates the row.
      if (!existing && !isValidSessionId(sessionId, agentId)) {
        throw new ApiError(
          400,
          'invalid_session_id',
          'That session id cannot start a conversation: an id must be a single addressable segment — no path separators or control characters, '
            + `no leading dot, no surrounding whitespace, and at most ${MAX_SESSION_ID_LENGTH} characters beyond the agent id it names. `
            + 'Mint one per conversation the way the dashboard does, as web:<agentId>:<uuid>.',
        );
      }
      if (existing && agentId !== undefined && existing.agent.id !== agentId) {
        // The gateway refuses this too. Checked here so the caller gets a
        // 409 that names both identities instead of a 500 from a rejected
        // dispatch nobody is awaiting.
        throw new ApiError(
          409,
          'session_agent_mismatch',
          `Session ${sessionId} belongs to agent ${existing.agent.id}, not ${agentId} — sessions never cross agent identities.`,
        );
      }

      const metadata = typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
        ? (body.metadata as JsonObject)
        : undefined;
      // The gateway refuses these at dispatch, for the same reason it
      // refuses the reserved id namespace — and, as with that, by rejecting
      // a dispatch nobody awaits. Preflighted here so the caller learns
      // which key rather than receiving a 202 for a turn that never runs.
      const reserved = reservedSessionMetadataKey(metadata);
      if (reserved !== undefined) {
        throw new ApiError(
          400,
          'metadata_reserved',
          `Session metadata key "${reserved}" is reserved for the daemon's own records and cannot be supplied by a caller. `
            + `Reserved keys: ${RESERVED_SESSION_METADATA_KEYS.join(', ')}.`,
        );
      }

      // Again, with nothing awaited between here and the dispatch: a pause
      // that landed while this handler was reading the store would otherwise
      // be refused by the gateway after the caller had been handed a 202.
      if (context.gateway.intake().paused) {
        throw new ApiError(503, 'intake_paused', context.gateway.intake().message ?? DEFAULT_PAUSED_MESSAGE);
      }
      if (context.gateway.held()) {
        throw new ApiError(503, 'held', HELD_MESSAGE);
      }

      const turnId = randomUUID();
      // Armed before the dispatch, so a failure that arrives while the runner
      // is still unwinding is seen rather than missed.
      const watch = context.watchTurn(sessionId, turnId);
      // Deliberately not awaited: a turn runs for as long as a model takes,
      // and the caller watches it on the event stream. The turn id returned
      // here is what lets them recognise it there.
      void context.gateway
        .dispatch({
          sessionId,
          ...(agentId ? { agentId } : {}),
          userMessage: message,
          turnId,
          ...(metadata !== undefined ? { metadata } : {}),
        })
        .catch(async (error: unknown) => {
          // A turn the runner actually ran reports its own failure. One that
          // never got that far — the gateway stopping, a soul that no longer
          // resolves, credentials that stopped resolving between the
          // preflight above and the chain reaching this turn — rejects here,
          // and nothing else would ever tell the caller. Without this they
          // hold a turn id that produces silence forever.
          const message = error instanceof Error ? error.message : String(error);
          if (watch.reported()) {
            return;
          }
          // Stamped with the turn the caller was handed. The gateway cleared
          // its own record when the chained work unwound, so without this the
          // failure arrives unattributed and the client that queued this
          // message shows it as running indefinitely.
          await context.withTurn(sessionId, turnId, async () => {
            await context.gateway.bus
              .emit({ type: 'session.failed', sessionId, error: message })
              .catch(() => undefined);
          });
        })
        .finally(() => watch.release());

      context.response.statusCode = 202;
      return { sessionId, turnId };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/sessions/:id/rollover`,
    async handler(context) {
      const sessionId = context.params.id ?? '';
      const existing = await context.gateway.store.get(sessionId);
      if (!existing) {
        throw new ApiError(404, 'session_not_found', `No session with id ${sessionId}.`);
      }
      // Preflighted so the caller gets a status they can act on; the
      // gateway refuses the same two cases with a plain error.
      if (existing.status === 'running' || existing.status === 'pending_approval') {
        throw new ApiError(
          409,
          'session_busy',
          `Session ${sessionId} has a turn in flight (${existing.status}); roll it over once the turn has finished.`,
        );
      }
      if (typeof existing.metadata?.[ROLLED_OVER_TO_METADATA_KEY] === 'string') {
        throw new ApiError(
          409,
          'session_archived',
          `Session ${sessionId} is an archived transcript; roll over the live session ${String(existing.metadata[ROLLED_OVER_TO_METADATA_KEY])} instead.`,
        );
      }
      return context.gateway.rolloverSession(sessionId);
    },
  },
];
