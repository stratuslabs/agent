import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPluginStateDirectories, pluginStateDirPath } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-state-'));

test('a plugin state directory is under ~/.stratus/plugins by package name, a scoped one nested under its scope', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  assert.equal(pluginStateDirPath(env, '@stratusagent/channel-imessage'), path.join(home, '.stratus', 'plugins', '@stratusagent', 'channel-imessage'));
  assert.equal(pluginStateDirPath(env, 'stratus-plugin-weather'), path.join(home, '.stratus', 'plugins', 'stratus-plugin-weather'));
});

test('a name that is not an npm package name has no state directory, so it cannot choose a path', async () => {
  const env = { homeDir: await newHome() };
  for (const name of ['../escape', '@scope/../../escape', '.hidden', 'a/b/c', 'Upper', '']) {
    assert.throws(() => pluginStateDirPath(env, name), /is not an npm package name/, name);
  }
});

test('preparing a plugin state directory leaves every level 0700, whatever the umask and whatever was there', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const previous = process.umask(0o022);
  try {
    const directory = createPluginStateDirectories(env)('@stratusagent/channel-imessage').prepare();
    assert.equal(directory, pluginStateDirPath(env, '@stratusagent/channel-imessage'));
    for (const level of [directory, path.dirname(directory), path.dirname(path.dirname(directory))]) {
      assert.equal((await stat(level)).mode & 0o777, 0o700, level);
    }

    // A level an older build or a plugin's own mkdir already left loose is
    // tightened: `mkdir`'s mode only applies to what it creates.
    const loose = path.join(home, '.stratus', 'plugins', 'stratus-plugin-weather');
    await mkdir(loose, { recursive: true, mode: 0o755 });
    createPluginStateDirectories(env)('stratus-plugin-weather').prepare();
    assert.equal((await stat(loose)).mode & 0o777, 0o700);
  } finally {
    process.umask(previous);
  }
});

test('a linked plugins directory is refused rather than followed', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await chmod(elsewhere, 0o755);
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await symlink(elsewhere, path.join(home, '.stratus', 'plugins'));

  assert.throws(() => createPluginStateDirectories(env)('stratus-plugin-weather').prepare(), /link/i);
  // The target keeps its mode and gains nothing: `chmod` and `mkdir` would
  // both have followed the link into it.
  assert.equal((await stat(elsewhere)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(elsewhere), []);
});
