/*
 * The gateway's `dispatch`: the shutdown and intake checks, repeated
 * idempotency keys, merging messages that arrive while a session is busy,
 * and the per-session chain every turn runs on. Moved out of
 * `createGateway` in index.ts as is: the statement is unchanged, inside a
 * factory that takes what it closed over there, and `createGateway` calls
 * it where it was. The edits: `stopping`, `intakeState` and `heldState` are
 * `let`s reassigned later, so they are read through `isStopping()`,
 * `getIntakeState()` and `isHeld()`.
 */

import {
  abortErrorFor,
  leastTrusted,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  SENDER_TRUST_METADATA_KEY,
  senderTrustOf,
  type Session,
  type SteeredMessage,
  workItemState,
} from '@stratusagent/core';
import {
  allAborted,
  fitsReplayBudget,
  joinableSignal,
  type MergeBatch,
  MERGED_SEPARATOR,
  MERGED_TEXT_BUDGET_CHARS,
  type MergeJoiner,
} from './merge-batch.ts';
import { isScheduleSessionId, SCHEDULE_SESSION_ID_PREFIX } from './schedules.ts';
import type { ShardedSessionStore } from './sessions.ts';
import { DEFAULT_PAUSED_MESSAGE, HELD_MESSAGE, IntakePausedError, type IntakeState } from './lifecycle.ts';
import type { DispatchInput } from './types.ts';
import {
  crossIdentityError,
  CrossIdentityError,
  RESERVED_SESSION_METADATA_KEYS,
  reservedSessionMetadataKey,
} from './session-keys.ts';
import type { TurnDispatch } from './turn-dispatch.ts';
import type { Recovery } from './recovery.ts';
import type { Steering } from './steering.ts';

/** What `dispatch` closes over in `createGateway`. */
export interface DispatchDeps extends Pick<TurnDispatch, 'dispatchInternal'>, Pick<Recovery, 'settleRepeat'>, Pick<Steering, 'takeSteered'> {
  store: ShardedSessionStore;
  sessionChains: Map<string, Promise<unknown>>;
  queuedWork: Map<string, number>;
  waitingDispatches: Map<string, number>;
  isStopping: () => boolean;
  getIntakeState: () => IntakeState;
  isHeld: () => boolean;
  refusal: () => Error;
  activeTurns: Map<string, string>;
  liveWorkItems: Map<
    string,
    Map<string, { turn: Promise<Session>; agentId: string | undefined; confirmed: boolean; addressed: boolean }>
  >;
  openBatches: Map<string, MergeBatch>;
  settleOrphanedItem: (sessionId: string) => Promise<void>;
  onSessionChain: <T>(sessionId: string, work: () => Promise<T>, released?: () => boolean) => Promise<T>;
}

export const createDispatch = ({
  store,
  sessionChains,
  queuedWork,
  waitingDispatches,
  isStopping,
  getIntakeState,
  isHeld,
  refusal,
  activeTurns,
  liveWorkItems,
  openBatches,
  settleOrphanedItem,
  onSessionChain,
  dispatchInternal,
  settleRepeat,
  takeSteered,
}: DispatchDeps) => {
  const dispatch = async (input: DispatchInput): Promise<Session> => {
    if (isStopping()) {
      throw refusal();
    }

    // The reserved namespace is the scheduler's alone. A caller that could
    // name a firing's session id — derivable from `GET /schedules` — would
    // otherwise queue a turn of its own behind the firing (single-flight)
    // and run inside the grant, using `message.send` to the schedule's
    // approved destination without its own approval. Refused here, at the
    // one door every external dispatch comes through.
    if (isScheduleSessionId(input.sessionId)) {
      throw new Error(
        `Session ids beginning with "${SCHEDULE_SESSION_ID_PREFIX}" are reserved for scheduled firings and cannot be dispatched externally.`,
      );
    }

    // The daemon's own bookkeeping keys, by the same logic as the reserved
    // id namespace above: what the runner, the scheduler, and delegation
    // record about a session must be something only they can have written.
    const reserved = reservedSessionMetadataKey(input.metadata);
    if (reserved !== undefined) {
      throw new Error(
        `Session metadata key "${reserved}" is reserved for the daemon's own records and cannot be supplied by a dispatch. Reserved keys: ${RESERVED_SESSION_METADATA_KEYS.join(', ')}.`,
      );
    }

    const { turnId, idempotencyKey } = input;
    if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
      throw new Error(`An idempotency key is 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters; this one is ${idempotencyKey.length}.`);
    }
    // A repeat of a dispatch still queued or running is that dispatch: it
    // resolves with it rather than queueing behind it, which would let
    // another caller's turn land in between and then find a finished item.
    // Attached only when it names no other agent than the live dispatch
    // did; otherwise it queues, and `settleRepeat` refuses it there.
    const live = idempotencyKey !== undefined ? liveWorkItems.get(input.sessionId)?.get(idempotencyKey) : undefined;
    // A claim naming an agent other than this delivery does, that the chain
    // has not yet confirmed — this delivery naming nobody, or someone else.
    // The claim may be refused for who it named, and then the item is still
    // unowned: inheriting the refusal would drop a valid message, and
    // queueing behind it would leave this delivery to find the turn that a
    // later valid delivery runs `finished`, and answer it twice. So it
    // waits for the claim to settle and decides then: a claim that stood
    // is repeated, by a delivery naming its owner or nobody, and refuses
    // anyone else; a claim that left the item unowned is dispatched again,
    // where the first delivery to get there runs it and the rest attach.
    if (live !== undefined && !live.confirmed && live.agentId !== undefined && input.agentId !== live.agentId) {
      const claim = live.turn;
      const claimedBy = input.agentId;
      const repeatOf = (owner: string): void => {
        if (claimedBy !== undefined && claimedBy !== owner) {
          throw crossIdentityError(input.sessionId, owner, claimedBy);
        }
        input.onRepeat?.('live');
      };
      return claim.then(
        (session) => {
          repeatOf(session.agent.id);
          return session;
        },
        async (error: unknown) => {
          // Refused for who it named, or failed before its keyed message was
          // ever written (an agent gone, a provider it could not build): the
          // item is still unowned, and there is no turn to have repeated.
          const stored = error instanceof CrossIdentityError || idempotencyKey === undefined ? undefined : await store.get(input.sessionId);
          const owned = stored !== undefined && idempotencyKey !== undefined && workItemState(stored, idempotencyKey) !== undefined;
          if (owned) {
            repeatOf(stored.agent.id);
            throw error;
          }
          // Its own cleanup runs a tick later; the dispatch below must not
          // find the dead claim still standing and wait on it again.
          const items = liveWorkItems.get(input.sessionId);
          if (idempotencyKey !== undefined && items?.get(idempotencyKey)?.turn === claim) {
            items.delete(idempotencyKey);
            if (items.size === 0) {
              liveWorkItems.delete(input.sessionId);
            }
          }
          return dispatch(input);
        },
      );
    }
    if (live !== undefined && (input.agentId === undefined || input.agentId === live.agentId)) {
      input.onRepeat?.('live');
      return live.turn;
    }
    // The one door every external dispatch comes through, so a pause holds
    // for every channel at once. Work already accepted is not behind this
    // check: a turn running, a redelivery of a message whose turn is live
    // (answered above), a message queued behind it, a delegation or
    // an approval resuming a parked turn all go on.
    if (getIntakeState().paused) {
      throw new IntakePausedError(getIntakeState().message ?? DEFAULT_PAUSED_MESSAGE);
    }
    if (isHeld()) {
      throw new IntakePausedError(HELD_MESSAGE);
    }
    // The live dispatch named no agent, so whose session it is is known
    // only once its turn resolves. Queueing instead would make this a
    // `finished` repeat of a turn the live caller is still rendering — two
    // answers — so it attaches, and is held to the agent it named then:
    // told it repeated only if that agent owns the session, refused if not.
    const claimed = input.agentId;
    if (live !== undefined && live.agentId === undefined && claimed !== undefined) {
      const shared = live.turn;
      // Whichever way the turn ends: a failed one is still that agent's,
      // its owner read from the store, and a repeat of it is still told so
      // — or refused, rather than handed another agent's error.
      const attach = async (): Promise<Session> => {
        let outcome: { session: Session } | { error: unknown };
        try {
          outcome = { session: await shared };
        } catch (error) {
          outcome = { error };
        }
        const owner = 'session' in outcome ? outcome.session.agent.id : (await store.get(input.sessionId))?.agent.id;
        if (owner !== undefined && owner !== claimed) {
          throw crossIdentityError(input.sessionId, owner, claimed);
        }
        // No owner means the dispatch failed before its session was ever
        // written: there is no turn to have repeated, only its error.
        if (owner !== undefined) {
          input.onRepeat?.('live');
        }
        if ('error' in outcome) {
          throw outcome.error;
        }
        return outcome.session;
      };
      return attach();
    }

    // Merged turns (card 423): an opted-in message behind a running turn
    // joins the batch already waiting, if there is one for the same agent.
    const mergeable = input.onAbsorbed !== undefined && input.addressed !== false;
    const open = openBatches.get(input.sessionId);
    if (
      mergeable &&
      open !== undefined &&
      open.agentId === input.agentId &&
      fitsReplayBudget([...open.images, ...(input.images ?? [])]) &&
      open.chars + MERGED_SEPARATOR.length + input.userMessage.length <= MERGED_TEXT_BUDGET_CHARS
    ) {
      open.images.push(...(input.images ?? []));
      open.chars += MERGED_SEPARATOR.length + input.userMessage.length;
      waitingDispatches.set(input.sessionId, (waitingDispatches.get(input.sessionId) ?? 0) + 1);
      const joined = new Promise<Session>((resolve, reject) => {
        open.absorbed.push({ input, resolve, reject });
      });
      if (idempotencyKey !== undefined) {
        // Provisional, like a queued dispatch's: a redelivery while it waits
        // attaches here; the merged turn confirms it once it owns the key.
        const items = liveWorkItems.get(input.sessionId) ?? new Map<string, { turn: Promise<Session>; agentId: string | undefined; confirmed: boolean; addressed: boolean }>();
        if (!items.has(idempotencyKey)) {
          items.set(idempotencyKey, { turn: joined, agentId: input.agentId, confirmed: false, addressed: true });
          liveWorkItems.set(input.sessionId, items);
        }
        void joined.catch(() => {}).finally(() => {
          const current = liveWorkItems.get(input.sessionId);
          if (current?.get(idempotencyKey)?.turn === joined) {
            current.delete(idempotencyKey);
            if (current.size === 0) {
              liveWorkItems.delete(input.sessionId);
            }
          }
        });
      }
      return joined;
    }
    // It cannot join (or its images or text would overflow the batch's
    // budget), so the open batch takes no more: a message arriving
    // after this one must not be answered ahead of it.
    if (open !== undefined) {
      openBatches.delete(input.sessionId);
    }
    // Otherwise it leads a new batch, if it is waiting behind a turn at all:
    // a message to an idle session runs at once, alone.
    const batch: MergeBatch | undefined = mergeable && sessionChains.has(input.sessionId)
      ? {
        agentId: input.agentId,
        // Settled through `settleLeader`, read when called: it is assigned below.
        leader: { input, resolve: (session) => settleLeader({ session }), reject: (error) => settleLeader({ error }) },
        firstInLine: (queuedWork.get(input.sessionId) ?? 0) === 0,
        absorbed: [],
        steered: false,
        images: [...(input.images ?? [])],
        chars: input.userMessage.length,
      }
      : undefined;
    if (batch !== undefined) {
      openBatches.set(input.sessionId, batch);
    }

    // Reads `turn` only once it is assigned: the registration below runs
    // after it, and the chain's work runs in a later tick (`.then`).
    const claimLiveItem = (key: string, confirmed: boolean): void => {
      const items = liveWorkItems.get(input.sessionId) ?? new Map<string, { turn: Promise<Session>; agentId: string | undefined; confirmed: boolean; addressed: boolean }>();
      items.set(key, { turn, agentId: input.agentId, confirmed, addressed: input.addressed !== false });
      liveWorkItems.set(input.sessionId, items);
    };

    /**
     * This dispatch's turn with the messages it absorbed (card 423). Each
     * part is judged on its own first, as it would have been alone: one
     * cancelled while it waited is refused, one that repeats a turn the
     * session already holds is that turn. What is left runs as one turn.
     */
    const runMerged = async (absorbed: readonly MergeJoiner[]): Promise<Session> => {
      type Part = { input: DispatchInput; joiner?: MergeJoiner };
      const parts: Part[] = [{ input }, ...absorbed.map((joiner) => ({ input: joiner.input, joiner }))];
      let leader: { session: Session } | { error: unknown } | undefined;
      const settle = (part: Part, outcome: { session: Session } | { error: unknown }): void => {
        if (part.joiner === undefined) {
          // Settled the moment it is known, not when the chain moves on: a
          // leader cancelled or repeated while it waited must leave its
          // caller's queue before the turn it handed over starts rendering.
          leader = outcome;
          settleLeader(outcome);
        } else if ('session' in outcome) {
          part.joiner.resolve(outcome.session);
        } else {
          part.joiner.reject(outcome.error);
        }
      };
      const runnable: Part[] = [];
      for (const part of parts) {
        const own = part.input;
        if (own.signal?.aborted) {
          settle(part, { error: abortErrorFor(own.signal) });
          continue;
        }
        if (own.idempotencyKey !== undefined) {
          try {
            const repeated = await settleRepeat(input.sessionId, own.idempotencyKey, own.agentId, own.turnId, own.onRepeat);
            if (repeated !== undefined) {
              settle(part, { session: repeated });
              continue;
            }
          } catch (error) {
            settle(part, { error });
            continue;
          }
        }
        runnable.push(part);
      }
      const head = runnable[0];
      if (head === undefined) {
        return finish(leader);
      }

      // Every runnable key now belongs to this turn.
      const keys = runnable.flatMap((part) => (part.input.idempotencyKey !== undefined ? [part.input.idempotencyKey] : []));
      const items = liveWorkItems.get(input.sessionId);
      for (const key of keys) {
        const item = items?.get(key);
        if (item !== undefined) {
          item.confirmed = true;
        }
      }

      // The turn runs at the least trusted sender in it: everyone's words
      // are in its one message.
      const labelled = runnable.some((part) => part.input.metadata !== undefined && SENDER_TRUST_METADATA_KEY in part.input.metadata);
      const lowest = leastTrusted(...runnable.map((part) => senderTrustOf(part.input.metadata)));
      const newest = runnable[runnable.length - 1]!.input;
      const metadata = labelled ? { ...newest.metadata, [SENDER_TRUST_METADATA_KEY]: lowest } : newest.metadata;
      const images = runnable.flatMap((part) => part.input.images ?? []);
      const signals = runnable.map((part) => part.input.signal);
      // Cancelled only when every caller in it is: one caller giving up
      // must not take the others' answer with it.
      const signal = signals.every((candidate): candidate is AbortSignal => candidate !== undefined)
        ? allAborted(signals)
        : undefined;
      const [primaryKey, ...absorbedKeys] = keys;
      const merged: DispatchInput = {
        sessionId: input.sessionId,
        ...(head.input.agentId !== undefined ? { agentId: head.input.agentId } : {}),
        userMessage: runnable.map((part) => part.input.userMessage).join(MERGED_SEPARATOR),
        ...(images.length > 0 ? { images } : {}),
        ...(runnable.every((part) => part.input.replyOptional === true) ? { replyOptional: true } : {}),
        ...(head.input.earlier !== undefined ? { earlier: head.input.earlier } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(head.input.turnId !== undefined ? { turnId: head.input.turnId } : {}),
        ...(primaryKey !== undefined ? { idempotencyKey: primaryKey } : {}),
      };

      await settleOrphanedItem(input.sessionId);
      let outcome: { session: Session } | { error: unknown };
      if (merged.turnId !== undefined) {
        activeTurns.set(input.sessionId, merged.turnId);
      }
      try {
        outcome = { session: await runSteerable(merged, absorbedKeys) };
      } catch (error) {
        outcome = { error };
      } finally {
        if (merged.turnId !== undefined) {
          activeTurns.delete(input.sessionId);
        }
      }
      for (const part of runnable) {
        if (part !== head) {
          part.input.onAbsorbed?.();
        }
        settle(part, outcome);
      }
      return finish(leader);
    };
    const finish = (outcome: { session: Session } | { error: unknown } | undefined): Session => {
      if (outcome === undefined) {
        throw new Error('A merged turn settled without an outcome for its leader.');
      }
      if ('error' in outcome) {
        throw outcome.error;
      }
      return outcome.session;
    };
    // What this caller is handed. It follows the chain's work, except that a
    // batch leader settles it early (`settle` in `runMerged`).
    let settleLeader: (outcome: { session: Session } | { error: unknown }) => void = () => {};
    const turn = new Promise<Session>((resolve, reject) => {
      settleLeader = (outcome) => ('error' in outcome ? reject(outcome.error) : resolve(outcome.session));
    });
    waitingDispatches.set(input.sessionId, (waitingDispatches.get(input.sessionId) ?? 0) + 1);
    /**
     * Runs this dispatch's turn, handing it whatever queues behind it at
     * each tool step (`takeSteered`), then settles every dispatch it took
     * with the turn's outcome — the outcome they joined. Only for a caller
     * that opted into merged turns: it is the one that renders an answer
     * covering messages other than its own.
     */
    const runSteerable = async (turnInput: DispatchInput, absorbedKeys: readonly string[] = []): Promise<Session> => {
      const steered: MergeJoiner[] = [];
      // Cancelled only when every caller in it is, as a merged turn is, the
      // ones steered in later included: one caller giving up must not take
      // the others' answer with it. A turn with a caller who cannot cancel
      // has no signal to join.
      const joint = turnInput.signal !== undefined ? joinableSignal([turnInput.signal]) : undefined;
      // Admitted on the turn's own signal, not only the callers' joint one:
      // the watchdog, `abortTurns` and a restart's window stop the turn
      // without touching its callers, and a batch taken into a turn stopped
      // while the store was read would share its failure instead of running
      // next (card 959). The turn's signal follows the joint one, so this
      // covers every caller giving up too.
      const steer = mergeable
        ? (turnSignal: AbortSignal): Promise<SteeredMessage | undefined> => takeSteered(input.sessionId, input.agentId, steered, (parts) => {
          if (turnSignal.aborted) {
            return false;
          }
          for (const part of parts) {
            joint?.join(part.input.signal);
          }
          return true;
        })
        : undefined;
      const running = joint !== undefined ? { ...turnInput, signal: joint.signal } : turnInput;
      let outcome: { session: Session } | { error: unknown };
      try {
        outcome = { session: await dispatchInternal(running, absorbedKeys, undefined, steer) };
      } catch (error) {
        outcome = { error };
      }
      for (const part of steered) {
        part.input.onAbsorbed?.();
        if ('session' in outcome) {
          part.resolve(outcome.session);
        } else {
          part.reject(outcome.error);
        }
      }
      if ('error' in outcome) {
        throw outcome.error;
      }
      return outcome.session;
    };
    const chained: Promise<Session> = onSessionChain(input.sessionId, async () => {
      // Steered into the turn that ran ahead of it, which has answered and
      // settled everyone in the batch already — this caller included.
      if (batch?.steered === true) {
        return turn;
      }
      // The batch closes here: anything arriving from now on waits behind
      // this turn and leads the next one.
      if (batch !== undefined && openBatches.get(input.sessionId) === batch) {
        openBatches.delete(input.sessionId);
      }
      const absorbed = batch?.absorbed ?? [];
      // No longer waiting once it reaches the head of the chain — nor is
      // anything it absorbed.
      const left = (waitingDispatches.get(input.sessionId) ?? 1) - 1 - absorbed.length;
      if (left > 0) {
        waitingDispatches.set(input.sessionId, left);
      } else {
        waitingDispatches.delete(input.sessionId);
      }
      if (absorbed.length > 0) {
        return runMerged(absorbed);
      }
      // Before `activeTurns` is touched: a repeat that runs nothing must
      // not claim the session's turn id, even for the instant it takes.
      const repeated = idempotencyKey !== undefined ? await settleRepeat(input.sessionId, idempotencyKey, input.agentId, turnId, input.onRepeat) : undefined;
      if (repeated !== undefined) {
        return repeated;
      }
      // Past the identity check with a key the session has not seen, so this
      // dispatch owns the item: it becomes the live entry even if a claimant
      // that was then refused registered first, or a repeat arriving while
      // this turn runs would find nothing to attach to, queue, and read the
      // turn as finished — a second answer beside this caller's.
      if (idempotencyKey !== undefined) {
        claimLiveItem(idempotencyKey, true);
      }
      await settleOrphanedItem(input.sessionId);
      if (turnId === undefined) {
        return runSteerable(input);
      }
      activeTurns.set(input.sessionId, turnId);
      try {
        return await runSteerable(input);
      } finally {
        // Unconditional, and safe to be: the chain guarantees no other turn
        // for this session ran between the set above and here, so this can
        // only ever be clearing its own entry.
        activeTurns.delete(input.sessionId);
      }
    }, () => batch?.steered === true);
    // A second settle (a leader already settled early) is a no-op.
    chained.then((session) => settleLeader({ session }), (error: unknown) => settleLeader({ error }));
    if (idempotencyKey !== undefined) {
      // A repeat that queued instead of attaching — it named another agent,
      // and is about to be refused — must not displace the turn it repeats.
      // The first registration is provisional; the chain confirms it
      // (`claimLiveItem` above) once the dispatch is known to own the item.
      if (liveWorkItems.get(input.sessionId)?.has(idempotencyKey) !== true) {
        claimLiveItem(idempotencyKey, false);
      }
      void turn.catch(() => {}).finally(() => {
        const current = liveWorkItems.get(input.sessionId);
        if (current?.get(idempotencyKey)?.turn === turn) {
          current.delete(idempotencyKey);
          if (current.size === 0) {
            liveWorkItems.delete(input.sessionId);
          }
        }
      });
    }
    return turn;
  };

  return { dispatch };
};

export type Dispatch = ReturnType<typeof createDispatch>;
