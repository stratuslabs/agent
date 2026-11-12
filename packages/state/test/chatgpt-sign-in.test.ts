import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  chatgptSignInLockPath,
  chatgptSignInPath,
  claimFileLock,
  createChatGPTSignInFile,
  credentialsPath,
  FileLockHeldError,
  saveCredentials,
} from '../src/index.ts';

const newEnv = async () => ({ homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-chatgpt-sign-in-')) });

test('the ChatGPT sign-in file reads as nothing until written, then as written, owner-only and whole', async () => {
  const env = await newEnv();
  const file = createChatGPTSignInFile(env);
  assert.equal(await file.read(), undefined);

  await file.write({ hostId: 'urn:uuid:1', session: { clientId: 'oaiapp_1', refreshToken: 'rt-1' } });
  assert.deepEqual(await file.read(), { hostId: 'urn:uuid:1', session: { clientId: 'oaiapp_1', refreshToken: 'rt-1' } });
  assert.equal(chatgptSignInPath(env), path.join(env.homeDir, '.stratus', 'chatgpt-sign-in.json'));
  assert.equal((await stat(chatgptSignInPath(env))).mode & 0o777, 0o600);

  await file.write({ hostId: 'urn:uuid:1' });
  assert.deepEqual(await file.read(), { hostId: 'urn:uuid:1' });
  // Written beside and renamed over: no temporary file is left holding tokens.
  assert.deepEqual((await readdir(path.dirname(chatgptSignInPath(env)))).filter((name) => name.endsWith('.tmp')), []);
});

test('the sign-in is its own file, so a credentials.json writer never puts back a spent refresh token', async () => {
  // Every credentials.json writer rewrites the whole file, and a CLI's
  // writer doesn't share the daemon's lock. Kept in there, a rotated
  // refresh token saved by the daemon could be overwritten by `stratus
  // credential set` with the one it replaced, which is already spent.
  const env = await newEnv();
  const file = createChatGPTSignInFile(env);
  await file.write({ session: { refreshToken: 'rt-2' } });
  await saveCredentials(env, { anthropic: { type: 'api_key', value: 'sk-ant-1' } });
  assert.deepEqual(await file.read(), { session: { refreshToken: 'rt-2' } });
  assert.doesNotMatch(await readFile(credentialsPath(env), 'utf8'), /rt-2/);
});

test('a sign-in file that is not a JSON object is refused without quoting what it holds', async () => {
  const env = await newEnv();
  const file = createChatGPTSignInFile(env);
  await mkdir(path.dirname(chatgptSignInPath(env)), { recursive: true });
  for (const contents of ['{"session":{"refreshToken":"rt-SECRET"', '{"session":{"refreshToken": rt-SECRET}}', '["rt-SECRET"]', 'null']) {
    await writeFile(chatgptSignInPath(env), contents);
    await assert.rejects(file.read(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /chatgpt-sign-in\.json/);
      // JSON.parse's own message quotes the text, tokens included.
      assert.doesNotMatch(`${error.message} ${String(error.cause ?? '')}`, /rt-SECRET/);
      return true;
    });
  }
});

test('the sign-in lock is held across processes for the whole of the work', async () => {
  const env = await newEnv();
  const file = createChatGPTSignInFile(env);
  const seen = await file.withLock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      claimFileLock(chatgptSignInLockPath(env)).release();
      return 'free';
    } catch (error) {
      return error instanceof FileLockHeldError ? 'held' : 'failed';
    }
  });
  assert.equal(seen, 'held');
  claimFileLock(chatgptSignInLockPath(env)).release();
});

test('waiting for the sign-in lock another process holds leaves this process running', async () => {
  // The daemon waits on a foreground run that is refreshing, which can take
  // a network round trip. A blocking wait would stall every agent and the
  // Slack connection for that long.
  const env = await newEnv();
  const lockPath = chatgptSignInLockPath(env);
  claimFileLock(lockPath).release();
  const holder = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(lockPath)});
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('held\\n');
    setTimeout(() => { db.close(); }, 400);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [chunk] = await once(holder.stdout!, 'data') as [Buffer];
    assert.equal(chunk.toString().trim(), 'held');

    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);
    let ticksBeforeWork = -1;
    try {
      await createChatGPTSignInFile(env, { lockWaitMs: 10_000 }).withLock(async () => {
        ticksBeforeWork = ticks;
      });
    } finally {
      clearInterval(ticker);
    }
    assert.ok(ticksBeforeWork >= 10, `the thread ran only ${ticksBeforeWork} timers while waiting`);
  } finally {
    holder.kill();
  }
});

test('a sign-in lock still held after the wait is refused and the work never runs', async () => {
  const env = await newEnv();
  const holder = claimFileLock(chatgptSignInLockPath(env));
  let ran = false;
  const started = Date.now();
  try {
    await assert.rejects(
      createChatGPTSignInFile(env, { lockWaitMs: 150 }).withLock(async () => { ran = true; }),
      FileLockHeldError,
    );
  } finally {
    holder.release();
  }
  assert.equal(ran, false);
  assert.ok(Date.now() - started >= 150, 'gave up before the wait was over');
});
