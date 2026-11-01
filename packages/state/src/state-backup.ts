import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { isValidAgentId } from '@stratusagent/agents';
import { syncDirectory, writeFileSynced } from './durable-write.ts';
import { type StateEnvironment } from './environment.ts';
import type { StateStamp } from './migrations.ts';
import {
  agentsDirPath,
  backupsDirPath,
  credentialsPath,
  gatewayInfoPath,
  gatewayTokenPath,
  stratusHomePath,
} from './paths.ts';

/** A copy of a home's state taken before a migration changed it. */
export interface StateBackup {
  /** The backup's directory: `backup.json` and the copied files under `files/`. */
  path: string;
  /** What was copied, relative to `~/.stratus` and to `files/`. */
  files: string[];
  createdAt: string;
  /** An earlier backup was kept instead of taking a new one: see `changedSince`. */
  reused: boolean;
  /**
   * The state changed after this copy, because a migration began on it and
   * never finished. It is still the copy to go back to, since an older
   * build can't run a half-migrated home, and what was written after it is
   * not in it. False for a new copy, and for an earlier one of this same
   * state, taken in the last day with nothing written since.
   */
  changedSince: boolean;
}

interface BackupManifest {
  from: StateStamp;
  migrations: string[];
  createdAt: string;
  files: string[];
  /** Each state file as it was just before the copy: see `stateInputs`. */
  inputs: Record<string, string>;
}

/**
 * A retry of the same upgrade inside this window reuses its backup, as long
 * as no state file changed since that copy. The case it is for is a daemon
 * whose service manager restarts it over a migration that keeps failing:
 * every start runs the migrations again, and a fresh copy of every
 * conversation each time would fill the disk. When anything was written in
 * between (the older daemon, started again after a failed upgrade, saved a
 * conversation), the old copy would drop it on restore, so a new one is
 * taken and the old one stays. Unless what changed it was a migration that
 * began on that copy: see `MIGRATION_BEGUN`.
 */
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Left in a backup's directory just before the first migration runs on the
 * state it holds. While the stamp still reads as before (the run failed or
 * was killed), the state may be half migrated, so a retry keeps this copy
 * as the way back rather than copy a layout no older build can read. A run
 * that failed with every state file as the copy found it takes it off.
 */
const MIGRATION_BEGUN = 'migration-begun';

/**
 * `node:sqlite`, loaded only when a database is copied: every importer of
 * this package would otherwise load it, and with it the experimental
 * warning Node still prints (see `file-lock.ts`).
 */
const sqlite = (): typeof import('node:sqlite') =>
  process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

const SQLITE_HEADER = 'SQLite format 3\0';

/**
 * Never copied. Secrets no migration rewrites (a second copy of a key is a
 * second place to leak it from), the running daemon's address, and files
 * that only mean something beside a live process: SQLite's sidecars, whose
 * committed content the database copy already holds, and locks. A
 * `.migrated` file is an original a migration already kept.
 */
const isLeftOut = (env: StateEnvironment, filePath: string): boolean => {
  if ([credentialsPath(env), gatewayTokenPath(env), gatewayInfoPath(env)].includes(filePath)) {
    return true;
  }
  const name = path.basename(filePath);
  return /-(wal|shm|journal)$/.test(name) || name.endsWith('.lock') || name.endsWith('.migrated');
};

const listDirectory = async (directory: string): Promise<Dirent[]> => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

/**
 * The state files: what sits directly in `~/.stratus`, in `agents/`, and
 * in each `agents/<id>/`. That is every database, memory file, grant file,
 * schedule store and stamp a migration has ever moved or rewritten, and it
 * picks up a new one without a list to keep current. Workspaces, logs,
 * skills and plugins are directories below that and are not copied: no
 * migration rewrites their contents, and a workspace can be any size. A
 * link is copied as the link, never followed, so a soul or workspace linked
 * into the visible agents folder comes back pointing where it did.
 */
const stateFiles = async (env: StateEnvironment): Promise<string[]> => {
  const home = stratusHomePath(env);
  const found: string[] = [];
  // Only into real directories: `agents` (or an agent's directory) that is
  // itself a link is copied as the link, and nothing is ever listed, or
  // later written, through one.
  const collect = async (directory: string, level: 'home' | 'agents' | 'agent'): Promise<void> => {
    for (const entry of await listDirectory(directory)) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (level === 'home' && full === agentsDirPath(env)) {
          await collect(full, 'agents');
        } else if (level === 'agents' && isValidAgentId(entry.name)) {
          await collect(full, 'agent');
        }
      } else if ((entry.isFile() || entry.isSymbolicLink()) && !isLeftOut(env, full)) {
        found.push(path.relative(home, full));
      }
    }
  };
  await collect(home, 'home');
  return found.sort();
};

/** A regular file that starts with SQLite's header. Never follows a link. */
const isDatabase = async (filePath: string): Promise<boolean> => {
  if (!(await lstat(filePath)).isFile()) {
    return false;
  }
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('latin1') === SQLITE_HEADER;
  } finally {
    await handle.close();
  }
};

const syncFile = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * One file into the backup. A database goes through SQLite's own backup,
 * so rows still in its write-ahead log come along and a writer cannot tear
 * the copy; anything else is copied byte for byte. Flushed before the
 * migration that follows can touch the original.
 */
const copyInto = async (source: string, destination: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if ((await lstat(source)).isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  if (await isDatabase(source)) {
    // Opened for writing, though nothing is written: a read-only
    // connection can't remove the -wal and -shm files it creates, and would
    // leave them beside the original.
    const { DatabaseSync, backup } = sqlite();
    const database = new DatabaseSync(source);
    try {
      await backup(database, destination);
    } finally {
      database.close();
    }
  } else {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
  await chmod(destination, 0o600);
  await syncFile(destination);
};

const readManifest = async (directory: string): Promise<BackupManifest | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, 'backup.json'), 'utf8')) as Partial<BackupManifest>;
    if (
      typeof parsed.createdAt === 'string'
      && typeof parsed.from?.schemaVersion === 'number'
      && Array.isArray(parsed.from.applied)
      && Array.isArray(parsed.files)
      && typeof parsed.inputs === 'object'
      && parsed.inputs !== null
    ) {
      return parsed as BackupManifest;
    }
  } catch {
    // Not a backup this build wrote, or not a finished one.
  }
  return undefined;
};

const sameStamp = (a: StateStamp, b: StateStamp): boolean =>
  a.schemaVersion === b.schemaVersion
  && a.applied.length === b.applied.length
  && a.applied.every((id, index) => b.applied[index] === id);

/**
 * What says a state file changed: its type, inode, size and modification
 * and change times, and a link's target, read without following it. A
 * database's `-wal` and `-journal` are read too, though never copied: a row
 * a daemon commits lands in the write-ahead log, and the database file
 * itself may not change until a checkpoint.
 */
const stateInputs = async (env: StateEnvironment, files: readonly string[]): Promise<Record<string, string>> => {
  const home = stratusHomePath(env);
  const describe = async (filePath: string): Promise<string | undefined> => {
    try {
      const info = await lstat(filePath, { bigint: true });
      const kind = info.isSymbolicLink() ? `link:${await readlink(filePath)}` : info.isFile() ? 'file' : 'other';
      return `${kind}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  };
  const inputs: Record<string, string> = {};
  for (const file of files) {
    for (const name of [file, `${file}-wal`, `${file}-journal`]) {
      const described = await describe(path.join(home, name));
      if (described !== undefined) {
        inputs[name] = described;
      }
    }
  }
  return inputs;
};

const sameInputs = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/**
 * The backup to keep instead of taking one: an earlier copy of exactly this
 * state, or else the newest copy from this stamp that a migration began on,
 * whatever has been written since. Neither: undefined, and a new copy.
 */
const recentBackupOf = async (
  env: StateEnvironment,
  stamp: StateStamp,
  inputs: Record<string, string>,
  now: Date,
): Promise<StateBackup | undefined> => {
  let begun: StateBackup | undefined;
  for (const entry of await listDirectory(backupsDirPath(env))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const directory = path.join(backupsDirPath(env), entry.name);
    const manifest = await readManifest(directory);
    if (manifest === undefined || !sameStamp(manifest.from, stamp)) {
      continue;
    }
    const kept = { path: directory, files: manifest.files, createdAt: manifest.createdAt, reused: true };
    const age = now.getTime() - Date.parse(manifest.createdAt);
    if (age >= 0 && age < REUSE_WINDOW_MS && sameInputs(manifest.inputs, inputs)) {
      return { ...kept, changedSince: false };
    }
    if (
      await exists(path.join(directory, MIGRATION_BEGUN))
      && (begun === undefined || Date.parse(manifest.createdAt) > Date.parse(begun.createdAt))
    ) {
      begun = { ...kept, changedSince: true };
    }
  }
  return begun;
};

/**
 * Called by the migration run once it has its backup and before the first
 * migration changes anything: see `MIGRATION_BEGUN`.
 */
export const markMigrationBegun = async (backup: StateBackup): Promise<void> => {
  const marker = path.join(backup.path, MIGRATION_BEGUN);
  if (await exists(marker)) {
    return;
  }
  await writeFileSynced(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  await syncDirectory(backup.path);
};

/**
 * Called when a migration threw. If every state file is still as the
 * backup copied it, nothing was half done: the mark comes off, and a retry
 * after the older build writes more takes a fresh copy with those writes.
 * Anything else keeps it. Best effort: keeping the mark is the safe side.
 */
export const settleFailedMigration = async (env: StateEnvironment, backup: StateBackup): Promise<void> => {
  const manifest = await readManifest(backup.path);
  if (manifest !== undefined && sameInputs(manifest.inputs, await stateInputs(env, await stateFiles(env)))) {
    await rm(path.join(backup.path, MIGRATION_BEGUN), { force: true });
  }
};

/** The line a command prints about the backup a migration run took or kept. */
export const describeStateBackup = (backup: StateBackup): string =>
  backup.changedSince
    ? `state backup: keeping ${backup.path}, the state as it was before this upgrade first ran (taken ${backup.createdAt}). `
      + 'A migration that did not finish has changed the state since, so that copy is still the one to go back to; '
      + 'what was written after it is not in it'
    : backup.reused
      ? `state backup: ${backup.path} already holds this state as it was before this upgrade (taken ${backup.createdAt})`
      : `state backup: copied ${backup.files.length} state files to ${backup.path} before migrating`;

/** `2026-11-01T01:30:00.000Z` as `20261101T013000Z`: sorts by time, and is a plain file name everywhere. */
const directoryName = (now: Date): string =>
  `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * Copies the home's state files to `~/.stratus/backups/<time>/` before the
 * listed migrations run, and says where. Nothing to copy when the home
 * holds no database or memory file — a fresh install has no conversation
 * to lose — and then there is no backup and no `backups/` directory.
 *
 * Built in a hidden directory and renamed into place once every file is
 * flushed, so a backup that exists under its name is a whole one. A
 * failure removes what it had copied and throws, and the caller runs no
 * migration: an upgrade that cannot keep a copy of the state does not
 * change it.
 */
export const backUpStateBeforeMigrating = async (
  env: StateEnvironment,
  stamp: StateStamp,
  migrations: readonly string[],
  now: Date = new Date(),
): Promise<StateBackup | undefined> => {
  const home = stratusHomePath(env);
  const files = await stateFiles(env);
  const holdsData = await Promise.all(files.map(async (file) =>
    path.basename(file) === 'memory.jsonl' || await isDatabase(path.join(home, file))));
  if (!holdsData.includes(true)) {
    return undefined;
  }
  // Read before anything is copied, so a write that lands during the copy
  // makes the next retry take a new one rather than trust this one.
  const inputs = await stateInputs(env, files);
  const reusable = await recentBackupOf(env, stamp, inputs, now);
  if (reusable !== undefined) {
    return reusable;
  }

  const root = backupsDirPath(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const partial = path.join(root, `.partial-${randomUUID()}`);
  await mkdir(partial, { mode: 0o700 });
  const createdAt = now.toISOString();
  try {
    for (const file of files) {
      try {
        await copyInto(path.join(home, file), path.join(partial, 'files', file));
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    // Deepest first, so each directory's entry is flushed after what it holds.
    const directories = [...new Set(files.map((file) => path.dirname(path.join(partial, 'files', file))))]
      .sort((a, b) => b.length - a.length);
    for (const directory of [...directories, path.join(partial, 'files', 'agents'), path.join(partial, 'files')]) {
      await syncDirectory(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
    const manifest: BackupManifest = { from: stamp, migrations: [...migrations], createdAt, files, inputs };
    await writeFileSynced(path.join(partial, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await syncDirectory(partial);
    let name = directoryName(now);
    for (let attempt = 2; ; attempt += 1) {
      try {
        await rename(partial, path.join(root, name));
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || attempt > 100) {
          throw error;
        }
        name = `${directoryName(now)}-${attempt}`;
      }
    }
    await syncDirectory(root);
    return { path: path.join(root, name), files, createdAt, reused: false, changedSince: false };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
};
