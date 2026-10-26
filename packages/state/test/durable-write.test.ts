import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { agentsDirPath, claimAgentsHome, runStateMigrations, saveCredentials, syncDirectory, writeFileSynced, writeNewSoulFile } from '../src/index.ts';

const newDir = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-durable-'));

type HandleProto = { sync: () => Promise<void>; stat: () => Promise<{ ino: number }> };

const handleProto = async (): Promise<HandleProto> => {
  const probe = await open(path.join(await newDir(), 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as HandleProto;
  await probe.close();
  return proto;
};

interface SyncEvent {
  ino: number;
  /** Which of the watched paths named this inode when it was synced. */
  named: string[];
}

/**
 * Records every `FileHandle.sync()` by the inode it was on, in order, and
 * which of `watch` already named that inode at the time. Durability can't
 * be shown by pulling a test machine's power, so this checks what the
 * kernel is asked for: a file's bytes flushed while it is still the
 * temporary (before its final name points at it), and the directory
 * flushed after the rename.
 */
const recordSyncs = async (t: test.TestContext, watch: string[] = []): Promise<SyncEvent[]> => {
  const events: SyncEvent[] = [];
  const proto = await handleProto();
  const { sync } = proto;
  t.mock.method(proto, 'sync', async function (this: HandleProto) {
    const { ino } = await this.stat();
    const named: string[] = [];
    for (const at of watch) {
      if ((await stat(at).catch(() => undefined))?.ino === ino) named.push(at);
    }
    events.push({ ino, named });
    return sync.call(this);
  });
  return events;
};

const inode = async (at: string): Promise<number> => (await stat(at)).ino;

test('writeFileSynced writes the bytes with the mode asked for, and wx refuses a file that exists', async () => {
  const dir = await newDir();
  const file = path.join(dir, 'token');
  await writeFileSynced(file, 'secret\n', { flag: 'wx', mode: 0o600 });
  assert.equal(await readFile(file, 'utf8'), 'secret\n');
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await assert.rejects(writeFileSynced(file, 'other\n', { flag: 'wx' }), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(await readFile(file, 'utf8'), 'secret\n', 'an exclusive write never touches the file it found');
  await writeFileSynced(file, 'replaced\n');
  assert.equal(await readFile(file, 'utf8'), 'replaced\n');
});

test('writeFileSynced flushes the bytes to disk', async (t) => {
  const events = await recordSyncs(t);
  const file = path.join(await newDir(), 'state.json');
  await writeFileSynced(file, '{}\n');
  const ino = await inode(file);
  assert.equal(events.filter((event) => event.ino === ino).length, 1);
});

test('syncDirectory flushes the directory; a filesystem that cannot is not an error, a failing disk is', async (t) => {
  const events = await recordSyncs(t);
  const dir = await newDir();
  await syncDirectory(dir);
  const ino = await inode(dir);
  assert.equal(events.filter((event) => event.ino === ino).length, 1);

  // Some filesystems answer fsync on a directory with EINVAL; the rename
  // before it already happened, so that is not a failed write.
  // Mocks stacked on one method restore in creation order, so each is put
  // back by hand, last first.
  const proto = await handleProto();
  const refused = t.mock.method(proto, 'sync', async () => {
    throw Object.assign(new Error('not supported'), { code: 'EINVAL' });
  });
  await syncDirectory(dir);
  refused.mock.restore();
  const failing = t.mock.method(proto, 'sync', async () => {
    throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
  });
  await assert.rejects(syncDirectory(dir), /disk on fire/, 'a real I/O error is not swallowed');
  failing.mock.restore();
});

// The live finding behind this: on a Fly volume snapshot taken 65 s after a
// fresh start, gateway-token, state.json and gateway.json were all zero
// bytes, and the restored daemon refused to start.
for (const [name, write] of [
  ['state.json', (env: { homeDir: string; cwd: string; processEnv: Record<string, string> }) => runStateMigrations(env, { exclusive: true })],
  ['credentials.json', (env: { homeDir: string; cwd: string; processEnv: Record<string, string> }) => saveCredentials(env, {})],
] as const) {
  test(`${name} is flushed as its temporary, then the directory it is renamed into`, async (t) => {
    const home = await newDir();
    const env = { homeDir: home, cwd: home, processEnv: {} };
    const stratus = path.join(home, '.stratus');
    // A home the daemon has run in.
    await mkdir(stratus, { recursive: true });
    const final = path.join(stratus, name);
    const events = await recordSyncs(t, [final]);
    await write(env);
    const ino = await inode(final);
    const bytes = events.findIndex((event) => event.ino === ino);
    assert.ok(bytes !== -1, `${name}'s bytes are synced`);
    assert.deepEqual(events[bytes]!.named, [], `${name} is synced as the temporary, before it is renamed into place`);
    const dirIno = await inode(stratus);
    assert.ok(events.some((event, index) => index > bytes && event.ino === dirIno), `then ${stratus} is synced`);
  });
}

// A new agent's soul is published by linking its hidden name to the visible
// soul: the bytes have to be on disk before that link is, and both
// directories after, or a crash leaves a link to an empty soul.
for (const replace of [false, true]) {
  test(`a new soul in the agents folder is flushed before it is linked, then both directories (${replace ? 'replace' : 'new'})`, async (t) => {
    const home = await realpath(await newDir());
    const env = { homeDir: home, processEnv: {} };
    const agentsHome = claimAgentsHome(env);
    assert.ok(agentsHome !== undefined);
    const visibleDir = path.join(agentsHome, 'ava');
    const visible = path.join(visibleDir, 'soul.md');
    const hidden = path.join(agentsDirPath(env), 'ava.md');
    if (replace) {
      await mkdir(visibleDir, { recursive: true });
      await writeFile(visible, 'kept');
    }
    const events = await recordSyncs(t, [hidden]);
    await writeNewSoulFile(env, 'ava.md', 'ava', '---\nid: ava\n---\nYou are ava.\n', { replace });
    assert.equal(await readFile(hidden, 'utf8'), '---\nid: ava\n---\nYou are ava.\n');
    const ino = await inode(visible);
    const bytes = events.findIndex((event) => event.ino === ino);
    assert.ok(bytes !== -1, 'the soul\'s bytes are synced');
    assert.deepEqual(events[bytes]!.named, [], 'before the hidden name links to them');
    for (const dir of [visibleDir, agentsDirPath(env)]) {
      const dirIno = await inode(dir);
      assert.ok(events.some((event, index) => index > bytes && event.ino === dirIno), `then ${dir} is synced`);
    }
  });
}
