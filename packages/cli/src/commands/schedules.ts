import { stat } from 'node:fs/promises';

import { canonicalDestination, describeCadence, describeSchedule, type ScheduleRecord } from '@stratusagent/agents';
import { fleetDbPath, legacySessionDbPath, legacyStateHeld } from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedSchedulesCommand } from '../parse.ts';

/**
 * Every schedule this home has, from every database it keeps them in.
 *
 * Both, for as long as the per-agent move is pending, and merged rather
 * than chosen between. Resolving to one file first — "where are the rows
 * right now" — reads as tidier and loses an audit: `stratus schedules` can
 * see rows in the legacy database, the exclusive migration can rename it in
 * the moment before the store opens, and SQLite creates an empty one at the
 * old name. The command then reports a fleet with nothing scheduled while
 * every row sits safely in `fleet.db`, which is the worst answer this
 * surface can give — an operator reads it as "nothing will fire".
 *
 * Deduped by id because the migration copies with `INSERT OR REPLACE` on
 * that key, so a row caught mid-move is the same row in both places. The
 * fleet database is read first so the copy that survives is the one the
 * fleet will fire.
 */
const listEverywhere = async (env: CliEnvironment): Promise<ScheduleRecord[]> => {
  const { SqliteScheduleStore } = await import('@stratusagent/gateway');
  const byId = new Map<string, ScheduleRecord>();
  for (const dbPath of [fleetDbPath(env), legacySessionDbPath(env)]) {
    if (!(await pathExists(dbPath))) {
      continue;
    }
    const store = new SqliteScheduleStore(dbPath);
    try {
      for (const record of store.list()) {
        if (!byId.has(record.id)) {
          byId.set(record.id, record);
        }
      }
    } finally {
      store.close();
    }
  }
  return [...byId.values()];
};

/**
 * Cancel a schedule out of every database this home has one in.
 *
 * Two of them exist for as long as the per-agent move is pending, and a row
 * that survives in either is a schedule that fires after the operator was
 * told it was cancelled — carrying the standing destination grant the
 * cancel was supposed to revoke with it, which is the failure this surface
 * exists to prevent.
 *
 * **The legacy database goes first**, and the order is the point. The
 * migration copies the rows out of it under an IMMEDIATE transaction, so a
 * delete there either lands before the copy — leaving nothing to copy — or
 * waits out the copy's brief lock and runs after it, in which case the row
 * is now in `fleet.db` and the second delete below removes it. Deleting the
 * fleet row first would invert that and let a copy still in flight put the
 * row back behind us.
 *
 * Returns the record as the first database holding it described it, or
 * undefined when nothing did.
 */
const cancelEverywhere = async (env: CliEnvironment, id: string): Promise<ScheduleRecord | undefined> => {
  const { SqliteScheduleStore } = await import('@stratusagent/gateway');
  let cancelled: ScheduleRecord | undefined;
  for (const dbPath of [legacySessionDbPath(env), fleetDbPath(env)]) {
    if (!(await pathExists(dbPath))) {
      continue;
    }
    const store = new SqliteScheduleStore(dbPath);
    try {
      const record = store.get(id);
      if (store.delete(id) && record) {
        cancelled ??= record;
      }
    } finally {
      store.close();
    }
  }
  return cancelled;
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * List and cancel what the fleet has scheduled — against the daemon's own
 * database, the way `stratus logs` reads the daemon's own log. WAL makes a
 * second process on the file routine; a running daemon re-reads due rows
 * every tick and the destination grant on every send, so a cancel from
 * here takes effect without asking it anything.
 */
export const runSchedules = async (
  command: ParsedSchedulesCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // Lazy like the serve path: node:sqlite loads only for the command that
  // needs it.
  if (command.action === 'cancel') {
    const id = command.scheduleId ?? '';
    const record = await cancelEverywhere(env, id);
    if (!record) {
      writeLine(streams.stderr, `No schedule with id ${id}. \`stratus schedules\` lists what exists.`);
      return 1;
    }
    writeLine(streams.stdout, `Cancelled ${id} (${record.agentId}, ${describeCadence(record.cadence)}).`);
    if (record.destination) {
      writeLine(streams.stdout, `Its pre-authorized destination ${canonicalDestination(record.destination)} is revoked with it.`);
    }
    return 0;
  }

  const schedules = await listEverywhere(env);
  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ schedules: schedules.map(describeSchedule) }, null, 2));
    return 0;
  }
  if (schedules.length === 0) {
    writeLine(streams.stdout, 'No schedules set. An agent sets one with the schedule.every / schedule.at tools.');
    return 0;
  }
  for (const record of schedules) {
    const destination = record.destination ? `  →  ${canonicalDestination(record.destination)}` : '';
    writeLine(streams.stdout, `${record.id}  [${record.agentId}]  ${describeCadence(record.cadence)}${destination}`);
    writeLine(streams.stdout, `  next: ${record.nextFireAt ?? '(spent — awaiting cleanup)'}${record.lastFiredAt ? `   last: ${record.lastFiredAt}` : ''}`);
    writeLine(streams.stdout, `  prompt: ${record.prompt}`);
  }
  return 0;
};
