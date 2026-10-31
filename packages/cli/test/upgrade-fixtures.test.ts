import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSoul } from '@stratusagent/agents';
import { STATE_SCHEMA_VERSION, createHomeMemoryStore, loadCredentials, loadNamedCredentials } from '@stratusagent/state';

import { runCli } from '../src/index.ts';

// Homes written by published releases, not by hand. Each one was made by
// that version's own `stratus serve` (two agents created and talked to over
// its control API, demo provider) plus two memories appended through that
// version's own memory store. 0.13.5 adds what a working host accumulates,
// and has its own test below. See fixtures/homes/README.md.
//
// An upgrade has to keep every one of these: the agents, their
// conversations (readable and still continuable), their memories, and the
// stored sign-in, and a second start must find nothing left to migrate.
const fixturesDir = fileURLToPath(new URL('./fixtures/homes/', import.meta.url));
const RELEASES = ['0.11.0', '0.12.0'] as const;

/**
 * Re-point every link under `dir` that pointed into the home the release
 * wrote (`from`) at the same place in this one (`to`). 0.13 links each soul
 * and workspace in `~/.stratus/agents` to the visible `~/Agents` folder by
 * absolute path, and the fixture keeps the links exactly as written.
 */
const relink = async (dir: string, from: string, to: string): Promise<void> => {
  for (const entry of await readdir(dir)) {
    const at = path.join(dir, entry);
    const info = await lstat(at);
    if (info.isSymbolicLink()) {
      const target = await readlink(at);
      if (target.startsWith(`${from}/`)) {
        await unlink(at);
        await symlink(path.join(to, target.slice(from.length + 1)), at);
      }
    } else if (info.isDirectory()) {
      await relink(at, from, to);
    }
  }
};

/**
 * `relinked: false` leaves the links naming the home the release wrote, as
 * a home copied or restored to another path has them.
 */
const homeFrom = async (release: string, { relinked = true }: { relinked?: boolean } = {}): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), `stratus-upgrade-${release}-`));
  // Stored as `stratus/`, because the repository ignores `.stratus/`.
  await cp(path.join(fixturesDir, release, 'stratus'), path.join(home, '.stratus'), { recursive: true, verbatimSymlinks: true });
  const visible = path.join(fixturesDir, release, 'Agents');
  if (existsSync(visible)) {
    await cp(visible, path.join(home, 'Agents'), { recursive: true });
    const written = JSON.parse(await readFile(path.join(fixturesDir, release, 'home.json'), 'utf8')) as { home: string };
    if (relinked) {
      await relink(path.join(home, '.stratus'), written.home, home);
    }
  }
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
    // Neither soul had a tools: list, which these releases read as every
    // tool. An omitted list is safe tools only now, so the upgrade writes
    // the line that keeps them as they were, and says so.
    assert.match(first, /state migration 0005-explicit-tools-lists: wrote tools: \["\*"\] into the soul of ava, bob/);
    for (const id of ['ava', 'bob']) {
      const soulPath = path.join(home, '.stratus', 'agents', `${id}.md`);
      assert.deepEqual(parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath }).agent.tools, ['*'], id);
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

// A home the way a working host leaves it, written by 0.13.5's own daemon
// (fixtures/homes/make-home.mjs): souls in the visible ~/Agents folder,
// linked from ~/.stratus; grants of three kinds, each written by the
// release's approval path; a recurring schedule; a subscription sign-in, an
// API key and a per-agent named credential; approval and plugin config; and
// a file in an agent's workspace. An upgrade has to keep all of it, and the
// current build has to read it back the same way.
test('a home written by 0.13.5 upgrades with its grants, schedule, sign-ins, config and workspace intact', async () => {
  const home = await homeFrom('0.13.5');
  const stratusHome = path.join(home, '.stratus');
  const kept = [
    path.join(stratusHome, 'credentials.json'),
    path.join(stratusHome, 'config.json'),
    path.join(stratusHome, 'agents', 'ava', 'whitelist.json'),
    path.join(home, 'Agents', 'ava', 'soul.md'),
    path.join(home, 'Agents', 'ava', 'workspace', 'notes.md'),
  ];
  const before = await Promise.all(kept.map((file) => readFile(file, 'utf8')));

  type Schedule = { id: string; agentId: string; cadence: string; prompt: string; nextFireAt?: string };
  // The row as the release stored it, read before this build opens the home.
  const fleet = new DatabaseSync(path.join(stratusHome, 'fleet.db'), { readOnly: true });
  const stored = (fleet.prepare('SELECT body FROM schedules').all() as Array<{ body: string }>).map((row) => JSON.parse(row.body) as Schedule);
  fleet.close();
  assert.equal(stored.length, 1);
  const written = stored[0] as Schedule;
  const checkHome = async (api: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>) => {
    const ids = ((await api('GET', '/agents')).json.agents as Array<{ id: string }>).map((agent) => agent.id);
    assert.ok(ids.includes('ava') && ids.includes('bob'), `roster after upgrade: ${ids.join(', ')}`);
    const sessionIds = ((await api('GET', '/sessions')).json.sessions as Array<{ id: string }>).map((session) => session.id);
    assert.ok(sessionIds.includes('fixture-ava-1') && sessionIds.includes('fixture-bob-1'), sessionIds.join(', '));

    // Ava's conversation keeps every tool turn the release ran.
    const ava = (await api('GET', '/sessions/fixture-ava-1')).json.session as { messages: Array<{ role: string; toolResult?: { toolName: string; ok: boolean; output?: any } }> };
    const ran = ava.messages.filter((message) => message.role === 'tool').map((message) => `${message.toolResult?.toolName}:${message.toolResult?.ok}`);
    assert.deepEqual(ran, ['demo.echo:true', 'shell.run:true', 'web.fetch:true', 'schedule.every:true']);
    const created = ava.messages.find((message) => message.toolResult?.toolName === 'schedule.every')?.toolResult?.output?.schedule as Schedule | undefined;
    assert.equal(created?.id, written.id, 'the stored schedule is the one Ava\'s call created');

    // Each grant reads back as the kind the release wrote, and none has gone stale.
    const grants = (await api('GET', '/agents/ava/grants')).json;
    assert.deepEqual(grants.scopes.map((entry: { scope: { command: string; args: string[] } }) => [entry.scope.command, ...entry.scope.args]), [['git', '--version']]);
    assert.deepEqual(grants.origins.map((entry: { origin: string; tool: string }) => `${entry.tool} ${entry.origin}`), ['web.fetch https://example.com']);
    assert.deepEqual(grants.tools.map((entry: { tool: string; grantedBy?: string; stale?: string }) => [entry.tool, entry.grantedBy, entry.stale]), [['schedule.every', 'api:make-home', undefined]]);

    // The schedule is the same row: same id, cadence and prompt. Its next
    // slot never moves back, though a start after a missed slot fires the
    // one catch-up (or skips a window gone entirely) and moves it forward.
    const schedules = (await api('GET', '/schedules')).json.schedules as Schedule[];
    assert.deepEqual(schedules.map((row) => [row.id, row.agentId, row.cadence, row.prompt]), [[written.id, 'ava', 'every 1d', 'Fixture: summarize the day.']]);
    assert.ok(schedules[0]?.nextFireAt && written.nextFireAt && schedules[0].nextFireAt >= written.nextFireAt, `next slot ${schedules[0]?.nextFireAt} vs written ${written.nextFireAt}`);

    // The named credential is still listed for Ava, by name only.
    const credentials = JSON.stringify((await api('GET', '/credentials')).json);
    assert.match(credentials, /fixture\.token/);
    assert.doesNotMatch(credentials, /FIXTURE-named-not-a-real-secret/);
  };

  const first = await serving(home, async (api) => {
    await checkHome(api);
    const sent = await api('POST', '/sessions/fixture-bob-1/messages', { message: 'Hello again' });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    await waitFor(async () => {
      const bob = await api('GET', '/sessions/fixture-bob-1');
      return bob.json.session.status === 'completed' && messageContents(bob.json.session).includes('user: Hello again') ? true : undefined;
    }, 'the continued turn to complete');
  });
  // Already at the current layout, so the one migration is the tools line,
  // and only for Bob: Ava's soul has its own list and stays byte-identical.
  assert.doesNotMatch(first, /state migration 000[1-4]/, '0.13.5 is already at the current layout');
  assert.match(first, /state migration 0005-explicit-tools-lists: wrote tools: \["\*"\] into the soul of bob,/);
  const bobSoul = path.join(stratusHome, 'agents', 'bob.md');
  assert.equal((await lstat(bobSoul)).isSymbolicLink(), true, 'the soul link stays a link');
  assert.deepEqual(parseSoul(await readFile(bobSoul, 'utf8'), { seed: bobSoul }).agent.tools, ['*']);

  const stamp = JSON.parse(await readFile(path.join(stratusHome, 'state.json'), 'utf8')) as { schemaVersion: number };
  assert.equal(stamp.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(await Promise.all(kept.map((file) => readFile(file, 'utf8'))), before, 'credentials, config, grants, soul and workspace file are byte-identical');
  assert.equal((await stat(path.join(stratusHome, 'credentials.json'))).mode & 0o077, 0, 'credentials must stay owner-only');
  assert.deepEqual(await loadCredentials({ homeDir: home, cwd: home }), {
    anthropic: { type: 'oauth_token', value: 'sk-ant-oat01-FIXTURE-anthropic-not-a-real-secret' },
    openai: { type: 'api_key', value: 'sk-FIXTURE-openai-not-a-real-secret' },
  });
  // Null-prototype maps, so compared as the plain JSON they are stored as.
  assert.deepEqual(JSON.parse(JSON.stringify(await loadNamedCredentials({ homeDir: home, cwd: home }))), {
    shared: {},
    agents: { ava: { 'fixture.token': 'FIXTURE-named-not-a-real-secret' } },
  });
  const memory = createHomeMemoryStore({ homeDir: home, cwd: home });
  assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['The deploy window is Tuesday (fixture fact).']);

  // A second start reads all of it back again, and keeps the continued turn.
  const second = await serving(home, async (api) => {
    await checkHome(api);
    assert.ok(messageContents((await api('GET', '/sessions/fixture-bob-1')).json.session).includes('user: Hello again'));
  });
  assert.doesNotMatch(second, /state migration/);
  assert.deepEqual(await Promise.all(kept.map((file) => readFile(file, 'utf8'))), before);
});

const doctorOutput = async (home: string): Promise<string> => {
  let output = '';
  const write = (chunk: string) => {
    output += chunk;
    return true;
  };
  await runCli({ argv: ['doctor'], streams: { stdout: { write }, stderr: { write } }, env: { homeDir: home, cwd: home, processEnv: {} } });
  return output;
};

/** The command doctor gives for recording the folder a copied home came from. */
const recordCommand = (doctor: string): string => {
  const found = /run `(printf [^`]+)` and restart/.exec(doctor);
  assert.ok(found?.[1], doctor);
  return found[1];
};

const rosterIds = async (api: (method: string, route: string) => Promise<{ json: any }>): Promise<string[]> =>
  ((await api('GET', '/agents')).json.agents as Array<{ id: string }>).map((agent) => agent.id);

// A 0.13.5 home has no record of the folder its links were made into, so
// a copy of one cannot tell its own links from an operator's link to
// storage that is offline: it names them, and the operator says which.
test('a home written by 0.13.5 and copied to another path starts with all its agents once doctor\'s command is run', async () => {
  const written = (JSON.parse(await readFile(path.join(fixturesDir, '0.13.5', 'home.json'), 'utf8')) as { home: string }).home;
  assert.equal(existsSync(written), false, `${written} must not exist for this test`);
  const home = await homeFrom('0.13.5', { relinked: false });
  const agents = path.join(home, '.stratus', 'agents');
  const old = path.join(written, 'Agents');
  assert.equal(await readlink(path.join(agents, 'ava.md')), path.join(old, 'ava', 'soul.md'), 'the copy names the old home');

  const doctor = await doctorOutput(home);
  assert.ok(doctor.includes(`3 of them point into ${old}. If this home was copied or restored from there`), doctor);
  assert.ok(!doctor.includes('no agent reads them'), `the copied souls are the ones the links need, never ones to delete: ${doctor}`);
  const command = recordCommand(doctor);

  const before = await serving(home, async (api) => {
    assert.deepEqual(await rosterIds(api), ['stratus'], 'nothing re-pointed without the record');
  });
  assert.ok(before.includes(`3 link(s) point into ${old} at files that are gone`), before);
  assert.equal(await readlink(path.join(agents, 'ava.md')), path.join(old, 'ava', 'soul.md'), 'left as it was');

  execFileSync('/bin/sh', ['-c', command]);
  const first = await serving(home, async (api) => {
    const ids = await rosterIds(api);
    assert.ok(ids.includes('ava') && ids.includes('bob'), `roster after the move: ${ids.join(', ')}`);
    const sessionIds = ((await api('GET', '/sessions')).json.sessions as Array<{ id: string }>).map((session) => session.id);
    assert.ok(sessionIds.includes('fixture-ava-1') && sessionIds.includes('fixture-bob-1'), sessionIds.join(', '));
  });
  assert.match(first, /re-pointed 3 link\(s\) at \S+\/Agents/);
  assert.equal(await readlink(path.join(agents, 'ava.md')), path.join(home, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readlink(path.join(agents, 'bob.md')), path.join(home, 'Agents', 'bob', 'soul.md'));
  assert.equal(await readlink(path.join(agents, 'ava', 'workspace')), path.join(home, 'Agents', 'ava', 'workspace'));
  assert.equal(await readFile(path.join(agents, 'ava', 'workspace', 'notes.md'), 'utf8'), await readFile(path.join(fixturesDir, '0.13.5', 'Agents', 'ava', 'workspace', 'notes.md'), 'utf8'));

  const second = await serving(home, async () => {});
  assert.doesNotMatch(second, /re-pointed|are gone/, 'nothing left to re-point');
});

// Copied without its agents folder: copying the folder over afterwards is
// not enough, since a 0.13.5 home has no record of where its links point.
test('a copied 0.13.5 home without its agents folder starts with all its agents once doctor\'s steps are followed', async () => {
  const written = (JSON.parse(await readFile(path.join(fixturesDir, '0.13.5', 'home.json'), 'utf8')) as { home: string }).home;
  const home = await homeFrom('0.13.5', { relinked: false });
  await rm(path.join(home, 'Agents'), { recursive: true });
  const old = path.join(written, 'Agents');

  const doctor = await doctorOutput(home);
  assert.ok(doctor.includes(`3 of them point into ${old}. If this home was copied or restored from there`), doctor);
  assert.ok(doctor.includes(`make sure ${path.join(home, 'Agents')} has everything that was in ${old}, hidden files included, then run`), doctor);
  const command = recordCommand(doctor);

  // The operator's steps, in order: the folder, the record, the restart.
  await cp(path.join(fixturesDir, '0.13.5', 'Agents'), path.join(home, 'Agents'), { recursive: true });
  execFileSync('/bin/sh', ['-c', command]);
  const output = await serving(home, async (api) => {
    const ids = await rosterIds(api);
    assert.ok(ids.includes('ava') && ids.includes('bob'), `roster: ${ids.join(', ')}`);
  });
  assert.match(output, /re-pointed 3 link\(s\)/);
  assert.equal(await readlink(path.join(home, '.stratus', 'agents', 'ava.md')), path.join(home, 'Agents', 'ava', 'soul.md'));
});

test('a copied 0.13.5 home missing an agent\'s folder names the link and where it points', async () => {
  const written = (JSON.parse(await readFile(path.join(fixturesDir, '0.13.5', 'home.json'), 'utf8')) as { home: string }).home;
  const home = await homeFrom('0.13.5', { relinked: false });
  await rm(path.join(home, 'Agents', 'bob'), { recursive: true });
  const bobSoul = path.join(home, '.stratus', 'agents', 'bob.md');

  const doctor = await doctorOutput(home);
  assert.ok(doctor.includes(`point at something that is gone: `) && doctor.includes(`${bobSoul} -> ${path.join(written, 'Agents', 'bob', 'soul.md')}`), doctor);
  assert.ok(doctor.includes(`3 of them point into ${path.join(written, 'Agents')}`), doctor);
  execFileSync('/bin/sh', ['-c', recordCommand(doctor)]);

  const output = await serving(home, async (api) => {
    const ids = await rosterIds(api);
    assert.ok(ids.includes('ava') && !ids.includes('bob'), ids.join(', '));
  });
  assert.match(output, /re-pointed 2 link\(s\)/);
  assert.ok(output.includes(`${bobSoul} is a link to ${path.join(written, 'Agents', 'bob', 'soul.md')}, which does not exist`), output);
  assert.equal(await readlink(bobSoul), path.join(written, 'Agents', 'bob', 'soul.md'), 'left as it was');
});
