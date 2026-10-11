import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { promotedVersionPath } from '@stratusagent/state';
import { holdsForVersion, readPromotedVersion, recordPromotedVersion } from '../src/promotion.ts';
import { parseCommand } from '../src/parse.ts';
import { serveArgv } from '../src/supervisor.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-promoted-'));

test('a home that never promoted holds, and one that promoted this version does not', async () => {
  const env = { homeDir: await newHome() };
  assert.equal(await holdsForVersion(env, '0.12.1'), true);
  await recordPromotedVersion(env, '0.12.1');
  assert.equal(await readPromotedVersion(env), '0.12.1');
  assert.equal(await holdsForVersion(env, '0.12.1'), false);
  // The next version waits for its own promotion.
  assert.equal(await holdsForVersion(env, '0.12.2'), true);
  assert.equal((await stat(promotedVersionPath(env))).mode & 0o777, 0o600);
});

test('an unreadable promotion record holds rather than serving an unvouched version', async () => {
  const env = { homeDir: await newHome() };
  await mkdir(path.dirname(promotedVersionPath(env)), { recursive: true });
  await writeFile(promotedVersionPath(env), '{ not json');
  assert.equal(await holdsForVersion(env, '0.12.1'), true);
});

test('serve --hold-new-version parses, and a restart carries it', () => {
  const parsed = parseCommand(['serve', '--hold-new-version', '--no-events']);
  assert.deepEqual(parsed, { command: 'serve', events: false, holdNewVersion: true });
  assert.deepEqual(serveArgv(parsed as Parameters<typeof serveArgv>[0]), ['serve', '--no-events', '--hold-new-version']);
});
