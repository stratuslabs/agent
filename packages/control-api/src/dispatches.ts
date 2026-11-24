import { RunAbortedError } from '@stratusagent/core';

/**
 * The turns this API dispatched that the gateway has not finished, by
 * session, each with the signal its dispatch was handed.
 *
 * A stop has to reach these as well as the running turns `abortTurns`
 * knows about. A dispatch still in its preflight, or queued behind another
 * turn, has no controller the gateway tracks yet, so a stop clicked a
 * moment after the send found nothing to stop and the turn then ran
 * anyway. Aborting the signal it was dispatched with ends it wherever it
 * is: a queued dispatch whose signal has fired never starts, and a running
 * one is aborted like any other.
 */
export interface ApiDispatches {
  /** Hold a signal for one dispatch, released when the dispatch settles. */
  hold(sessionId: string): { signal: AbortSignal; release(): void };
  /**
   * Abort every dispatch held on the session with `reason`. Returns how
   * many are held, each now stopping; one aborted earlier that has not
   * settled still counts, the way `abortTurns` counts.
   */
  abort(sessionId: string, reason: string): number;
}

export const createApiDispatches = (): ApiDispatches => {
  const bySession = new Map<string, Set<AbortController>>();
  return {
    hold(sessionId) {
      const controller = new AbortController();
      let held = bySession.get(sessionId);
      if (held === undefined) {
        held = new Set();
        bySession.set(sessionId, held);
      }
      held.add(controller);
      const set = held;
      return {
        signal: controller.signal,
        release() {
          set.delete(controller);
          if (set.size === 0 && bySession.get(sessionId) === set) {
            bySession.delete(sessionId);
          }
        },
      };
    },
    abort(sessionId, reason) {
      const held = bySession.get(sessionId);
      if (held === undefined) {
        return 0;
      }
      for (const controller of held) {
        if (!controller.signal.aborted) {
          controller.abort(new RunAbortedError(reason));
        }
      }
      return held.size;
    },
  };
};
