/*
 * A message kept across a restart, as `pendingIntakePath` stores it. In a
 * module of its own so the adapter's parts outside `index.ts` can name it.
 * Nothing here is public: `index.ts` imports it, and the package's one
 * public entry is unchanged.
 */

/** A message kept across a restart (see `pendingIntakePath`). No text. */
export interface PendingIntake {
  agentId: string;
  team: string;
  channel: string;
  ts: string;
  threadTs?: string;
  user: string;
  channelType?: string;
  /** When it was kept, in epoch milliseconds. */
  keptAt: number;
}
