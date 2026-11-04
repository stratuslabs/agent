/*
 * A merged turn's batch: the dispatch that opened it and the ones absorbed
 * into it while it waits, and the rules a batch grows by. Moved out of
 * index.ts as is so the dispatch path split out of `createGateway` can name
 * them; index.ts does not re-export them.
 */

import { imagesWithinReplayBudget, type ImageAttachment, type Session } from '@stratusagent/core';
import type { DispatchInput } from './types.ts';

/** A dispatch absorbed into a merged turn, waiting for its outcome. */
export interface MergeJoiner {
  input: DispatchInput;
  resolve: (session: Session) => void;
  reject: (error: unknown) => void;
}

export interface MergeBatch {
  agentId: string | undefined;
  /** The dispatch that opened the batch and runs it, unless it is steered. */
  leader: MergeJoiner;
  /**
   * Nothing was queued on the session's chain when it opened, so nothing
   * can be ahead of it: the chain is first in, first out. Only such a batch
   * is steered (card 948); one behind other work waits its turn.
   */
  firstInLine: boolean;
  absorbed: MergeJoiner[];
  /**
   * Taken by the turn running ahead of it (card 948), which settles every
   * caller in it: the leader's place on the chain then runs nothing.
   */
  steered: boolean;
  /** Every image in the batch so far, leader's first. */
  images: ImageAttachment[];
  /** Characters of the merged user message so far, separators included. */
  chars: number;
}

/**
 * The most text one merged user message may hold (card 423). The runner's
 * overflow recovery can drop earlier transcript but never part of the
 * newest message, so a batch must not grow that message past what one
 * message could be on its own: this is Slack's own message-length limit.
 * A single message longer than this still runs, alone, as it would have
 * without merging.
 */
export const MERGED_TEXT_BUDGET_CHARS = 40_000;

/** Separator between merged messages; counted against the text budget. */
export const MERGED_SEPARATOR = '\n\n';

/**
 * Whether `images` all fit the replay budget together. A merged turn's
 * images are one message's, and the runner empties whatever falls outside
 * the budget before the provider sees it, so a batch that would overflow
 * must not take the message that overflows it (card 423).
 */
export const fitsReplayBudget = (images: readonly ImageAttachment[]): boolean =>
  images.length === 0 || imagesWithinReplayBudget([{ id: '', createdAt: '', role: 'user', content: '', images: [...images] }]).size === images.length;

/** A signal that aborts once every one of `signals` has. */
export const allAborted = (signals: readonly AbortSignal[]): AbortSignal => joinableSignal(signals).signal;

/**
 * `allAborted` for callers that keep joining: a turn that takes in messages
 * at its tool steps (card 948) is cancelled only once every caller in it
 * is, the ones who joined late included. A caller joining with no signal
 * can never cancel, so from then on neither can the turn.
 */
export const joinableSignal = (initial: readonly AbortSignal[]): { signal: AbortSignal; join: (signal: AbortSignal | undefined) => void } => {
  const controller = new AbortController();
  const signals = [...initial];
  let uncancellable = false;
  const check = (): void => {
    if (!uncancellable && !controller.signal.aborted && signals.every((signal) => signal.aborted)) {
      controller.abort(signals[signals.length - 1]?.reason);
    }
  };
  for (const signal of signals) {
    signal.addEventListener('abort', check, { once: true });
  }
  check();
  return {
    signal: controller.signal,
    join: (signal) => {
      if (signal === undefined) {
        uncancellable = true;
        return;
      }
      signals.push(signal);
      signal.addEventListener('abort', check, { once: true });
    },
  };
};
