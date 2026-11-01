import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup as backUpDatabase } from 'node:sqlite';

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
  /** An earlier backup of this same state, taken in the last day, was kept instead. */
  reused: boolean;
}

interface BackupManifest {
  from: StateStamp;
  migrations: string[];
  createdAt: string;
  files: string[];
}

/**
 * A retry of the same upgrade inside this window reuses its backup. The
 * case it is for is a daemon whose service manager restarts it over a
 * migration that keeps failing: every start runs the migrations again, and
 * a fresh copy of every conversation each time would fill the disk. Past a
 * day the older build may have written more under the same stamp, and the
 * old copy stops being the one to restore.
 */
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    const database = new DatabaseSync(source);
    try {
      await backUpDatabase(database, destination);
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

const recentBackupOf = async (
  env: StateEnvironment,
  stamp: StateStamp,
  now: Date,
): Promise<StateBackup | undefined> => {
  for (const entry of await listDirectory(backupsDirPath(env))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const directory = path.join(backupsDirPath(env), entry.name);
    const manifest = await readManifest(directory);
    const age = manifest === undefined ? Number.NaN : now.getTime() - Date.parse(manifest.createdAt);
    if (manifest !== undefined && sameStamp(manifest.from, stamp) && age >= 0 && age < REUSE_WINDOW_MS) {
      return { path: directory, files: manifest.files, createdAt: manifest.createdAt, reused: true };
    }
  }
  return undefined;
};

/** The line a command prints about the backup a migration run took or kept. */
export const describeStateBackup = (backup: StateBackup): string =>
  backup.reused
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
  const reusable = await recentBackupOf(env, stamp, now);
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
    const manifest: BackupManifest = { from: stamp, migrations: [...migrations], createdAt, files };
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
    return { path: path.join(root, name), files, createdAt, reused: false };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
};
