/*
 * What a running turn takes in at its next tool step (card 948): the merged
 * batch waiting behind it. Moved out of `createGateway` in index.ts as is:
 * the statement is unchanged, inside a factory that takes what it closed
 * over there, and `createGateway` calls it where it was. The one kind of
 * edit: `stopping` is a `let` set at shutdown, so it is read through
 * `isStopping()`.
 */

import {
  abortErrorFor,
  leastTrusted,
  SENDER_TRUST_METADATA_KEY,
  senderTrustOf,
  type Session,
  type SteeredMessage,
  workItemState,
} from '@stratusagent/core';
import { type MergeBatch, MERGED_SEPARATOR, type MergeJoiner } from './merge-batch.ts';
import type { ShardedSessionStore } from './sessions.ts';
import type { Recovery } from './recovery.ts';

/** What steering closes over in `createGateway`. */
export interface SteeringDeps extends Pick<Recovery, 'archivedRepeat'> {
  log: (line: string) => void;
  store: ShardedSessionStore;
  releaseQueued: (sessionId: string) => void;
  waitingDispatches: Map<string, number>;
  isStopping: () => boolean;
  liveWorkItems: Map<
    string,
    Map<string, { turn: Promise<Session>; agentId: string | undefined; confirmed: boolean; addressed: boolean }>
  >;
  openBatches: Map<string, MergeBatch>;
}

export const createSteering = ({
  log,
  store,
  releaseQueued,
  waitingDispatches,
  isStopping,
  liveWorkItems,
  openBatches,
  archivedRepeat,
}: SteeringDeps) => {
  /**
   * What a running turn takes in at its next tool step (card 948): the
   * merged-turn batch waiting behind it, whole — leader and absorbed alike
   * — when it is for the same agent. The dispatches it takes join `into`,
   * which the running turn settles with its own outcome (`runSteerable`).
   *
   * A part cancelled while it waited is refused, as `runMerged` refuses it.
   * A part whose key this session (or the archive it rolled over from)
   * already holds is a repeat, and judging a repeat can mean settling a
   * turn — never something to do from inside one — so such a batch is not
   * taken: it waits and runs next, merged, where that is judged. Nor while
   * the gateway is stopping, when the batch is what the drain refuses.
   */
  const takeSteered = async (
    sessionId: string,
    agentId: string | undefined,
    into: MergeJoiner[],
    /**
     * Asked last, with nothing awaited after it: whether the running turn
     * still takes these callers, joining them to its cancellation if so. A
     * turn cancelled while the store was read takes nothing, and the batch
     * waits and runs next, as it would have.
     */
    admit: (parts: readonly MergeJoiner[]) => boolean,
  ): Promise<SteeredMessage | undefined> => {
    const batch = openBatches.get(sessionId);
    if (isStopping() || batch === undefined || !batch.firstInLine || batch.agentId !== agentId) {
      return undefined;
    }
    // Until every key in it is checked with nothing awaited since: a message
    // can join while the store is read, and is checked on the next pass; a
    // batch closed meanwhile is no longer this turn's to take.
    const checked = new Set<string>();
    let session: Session | undefined;
    for (;;) {
      if (isStopping() || openBatches.get(sessionId) !== batch) {
        return undefined;
      }
      const unchecked = [batch.leader, ...batch.absorbed].flatMap((part) => (
        part.input.idempotencyKey !== undefined && !checked.has(part.input.idempotencyKey) ? [part.input.idempotencyKey] : []
      ));
      if (unchecked.length === 0) {
        break;
      }
      session ??= await store.get(sessionId);
      for (const key of unchecked) {
        checked.add(key);
        if (session !== undefined && (workItemState(session, key) !== undefined || await archivedRepeat(session, key) !== undefined)) {
          return undefined;
        }
      }
    }
    const all = [batch.leader, ...batch.absorbed];
    if (!admit(all.filter((part) => part.input.signal?.aborted !== true))) {
      return undefined;
    }
    openBatches.delete(sessionId);
    batch.steered = true;
    // Its place on the chain runs nothing now, so it is not ahead of a batch
    // opening behind it, which can then be steered at a later step.
    releaseQueued(sessionId);
    // Not waiting any more; the leader's place on the chain does not count it again.
    const left = (waitingDispatches.get(sessionId) ?? all.length) - all.length;
    if (left > 0) {
      waitingDispatches.set(sessionId, left);
    } else {
      waitingDispatches.delete(sessionId);
    }
    const runnable: MergeJoiner[] = [];
    for (const part of all) {
      if (part.input.signal?.aborted) {
        part.reject(abortErrorFor(part.input.signal));
        continue;
      }
      runnable.push(part);
    }
    if (runnable.length === 0) {
      return undefined;
    }
    const keys = runnable.flatMap((part) => (part.input.idempotencyKey !== undefined ? [part.input.idempotencyKey] : []));
    const items = liveWorkItems.get(sessionId);
    for (const key of keys) {
      const item = items?.get(key);
      if (item !== undefined) {
        item.confirmed = true;
      }
    }
    into.push(...runnable);
    const labelled = runnable.some((part) => part.input.metadata !== undefined && SENDER_TRUST_METADATA_KEY in part.input.metadata);
    const lowest = leastTrusted(...runnable.map((part) => senderTrustOf(part.input.metadata)));
    const images = runnable.flatMap((part) => part.input.images ?? []);
    log(`${sessionId}: ${runnable.length} message(s) sent during the running turn reached it at its next step`);
    return {
      userMessage: runnable.map((part) => part.input.userMessage).join(MERGED_SEPARATOR),
      ...(images.length > 0 ? { images } : {}),
      ...(labelled ? { metadata: { [SENDER_TRUST_METADATA_KEY]: lowest } } : {}),
      ...(keys.length > 0 ? { keys } : {}),
    };
  };

  return { takeSteered };
};

export type Steering = ReturnType<typeof createSteering>;
