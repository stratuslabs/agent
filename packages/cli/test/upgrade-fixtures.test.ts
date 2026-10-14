import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE_SCHEMA_VERSION, createHomeMemoryStore, loadCredentials } from '@stratusagent/state';

import { runCli } from '../src/index.ts';

// Homes written by published releases, not by hand. Each one was made by
// that version's own `stratus serve` (two agents created and talked to over
// its control API, demo provider) plus two memories appended through that
// version's own memory store. See fixtures/homes/README.md.
//
// An upgrade has to keep every one of these: the agents, their
// conversations (readable and still continuable), their memories, and the
// stored sign-in, and a second start must find nothing left to migrate.
const fixturesDir = fileURLToPath(new URL('./fixtures/homes/', import.meta.url));
const RELEASES = ['0.11.0', '0.12.0'] as const;

const homeFrom = async (release: string): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), `stratus-upgrade-${release}-`));
  // Stored as `stratus/`, because the repository ignores `.stratus/`.
  await cp(path.join(fixturesDir, release, 'stratus'), path.join(home, '.stratus'), { recursive: true });
  // The release left its credentials owner-only, and its stamp already lists
  // the migration that tightens them, so the upgrade won't touch the mode.
  // Git checks the file out 0644; put back what the release left on disk.
  await chmod(path.join(home, '.stratus', 'credentials.json'), 0o600);
  return home;
};

/** Serve the home in-process on any free port, hand the API to `work`, then stop cleanly. */
const serving = async (
  home: string,
  work: (api: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<void>,
): Promise<string> => {
  let announce: (url: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });
  let stderr = '';
  let output = '';
  const controller = new AbortController();
  const streams = {
    stdout: {
      write(chunk: string) {
        output += chunk;
        const found = /control API on (http:\/\/\S+?)\s/.exec(chunk);
        if (found?.[1]) {
          announce(found[1]);
        }
        return true;
      },
    },
    stderr: { write(chunk: string) { stderr += chunk; output += chunk; return true; } },
  };
  const run = runCli({
    argv: ['serve', '--no-events', '--api-port', '0'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });
  const hung = Symbol('hung');
  let failed = true;
  try {
    let giveUp: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<typeof hung>((resolve) => {
      giveUp = setTimeout(() => resolve(hung), 10_000);
    });
    const url = await Promise.race([ready, gaveUp, run.then(() => hung)]).finally(() => clearTimeout(giveUp));
    assert.notEqual(url, hung, `the upgraded home never served its control API; stderr: ${stderr}`);
    const token = (await readFile(path.join(home, '.stratus', 'gateway-token'), 'utf8')).trim();
    await work(async (method, route, body) => {
      const response = await fetch(`${url as string}/api/v1${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: await response.json() };
    });
    failed = false;
  } finally {
    // Always stop the daemon, even when readiness or `work` failed, so a
    // failure is reported instead of leaving the test process running.
    controller.abort();
    const code = await run;
    if (!failed) {
      assert.equal(code, 0, `serve did not stop cleanly; stderr: ${stderr}`);
    }
  }
  return output;
};

const waitFor = async <T>(probe: () => Promise<T | undefined>, what: string): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const messageContents = (session: { messages: Array<{ role: string; content: unknown }> }): string[] =>
  session.messages.map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`);

for (const release of RELEASES) {
  test(`a home written by ${release} upgrades with its agents, conversations, memories and sign-in intact`, async () => {
    const home = await homeFrom(release);
    const credentialsBefore = await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8');

    let firstSessionLength = 0;
    const first = await serving(home, async (api) => {
      const agents = await api('GET', '/agents');
      assert.equal(agents.status, 200);
      const ids = (agents.json.agents as Array<{ id: string }>).map((agent) => agent.id);
      assert.ok(ids.includes('ava') && ids.includes('bob'), `roster after upgrade: ${ids.join(', ')}`);

      const sessions = await api('GET', '/sessions');
      const listed = (sessions.json.sessions as Array<{ id: string; agentId: string }>)
        .map((session) => `${session.id}:${session.agentId}`).sort();
      assert.deepEqual(listed, ['fixture-ava-1:ava', 'fixture-bob-1:bob']);

      const ava = await api('GET', '/sessions/fixture-ava-1');
      assert.equal(ava.status, 200);
      const before = messageContents(ava.json.session);
      assert.ok(before.includes('user: Say hello'), before.join('\n'));
      assert.ok(before.includes('user: Use the echo tool'), before.join('\n'));
      assert.ok(before.some((line) => line.startsWith('tool: ') || line.includes('demo.echo')), before.join('\n'));
      firstSessionLength = before.length;

      const bob = await api('GET', '/sessions/fixture-bob-1');
      assert.ok(messageContents(bob.json.session).includes('user: Hello Bob'));

      // An old conversation is still live, not just readable.
      const sent = await api('POST', '/sessions/fixture-ava-1/messages', { message: 'Say hello again' });
      assert.equal(sent.status, 202, JSON.stringify(sent.json));
      await waitFor(async () => {
        const after = await api('GET', '/sessions/fixture-ava-1');
        const lines = messageContents(after.json.session);
        return after.json.session.status === 'completed' && lines.includes('user: Say hello again')
          && lines.length > firstSessionLength + 1 ? lines : undefined;
      }, 'the continued turn to complete');
    });

    if (release === '0.11.0') {
      // Older than the per-agent layout, so the first start has real work to do.
      assert.match(first, /state migration 0003-per-agent-state-layout/);
    }

    const stamp = JSON.parse(await readFile(path.join(home, '.stratus', 'state.json'), 'utf8')) as { schemaVersion: number };
    assert.equal(stamp.schemaVersion, STATE_SCHEMA_VERSION);

    const memory = createHomeMemoryStore({ homeDir: home, cwd: home });
    assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['The deploy window is Tuesday (fixture fact).']);
    assert.deepEqual((await memory.list('bob')).entries.map((entry) => entry.content), ['Bob prefers short answers (fixture fact).']);

    assert.equal(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'), credentialsBefore);
    assert.equal((await stat(path.join(home, '.stratus', 'credentials.json'))).mode & 0o077, 0, 'credentials must stay owner-only');
    // ...and the stored sign-in is still one the current build can use.
    assert.deepEqual(await loadCredentials({ homeDir: home, cwd: home }), {
      anthropic: { type: 'api_key', value: 'sk-ant-FIXTURE-not-a-real-key' },
    });

    // A second start finds nothing to migrate and keeps the continued turn.
    const second = await serving(home, async (api) => {
      const ava = await api('GET', '/sessions/fixture-ava-1');
      assert.ok(messageContents(ava.json.session).includes('user: Say hello again'));
      assert.equal((await api('GET', '/sessions')).json.sessions.length, 2);
    });
    assert.doesNotMatch(second, /state migration/, 'a second start should have nothing left to migrate');
    assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['The deploy window is Tuesday (fixture fact).']);
  });
}
