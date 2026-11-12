import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCommand, runCli } from '../src/index.ts';

const createStreams = () => {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
};

/** A home with two roster agents (ava, bea) and, if given, a config. */
const homeWith = async (config?: unknown): Promise<{ home: string; configPath: string; env: { cwd: string; homeDir: string; processEnv: NodeJS.ProcessEnv; fetch?: typeof fetch } }> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-people-'));
  const agents = path.join(home, '.stratus', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, 'ava.md'), '---\nname: Ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  await writeFile(path.join(agents, 'bea.md'), '---\nname: Bea\nprovider: anthropic\n---\n\nYou are Bea.\n');
  const configPath = path.join(home, '.stratus', 'config.json');
  if (config !== undefined) {
    await writeFile(configPath, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  }
  return { home, configPath, env: { cwd: home, homeDir: home, processEnv: {} } };
};

const readConfig = async (configPath: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;

const run = async (argv: string[], env: object) => {
  const io = createStreams();
  const code = await runCli({ argv, streams: io.streams, env });
  return { code, stdout: io.stdout, stderr: io.stderr };
};

/** A daemon that answers health with `version` and a roster reload with `channels`. */
const publishDaemon = async (
  home: string,
  answer: { version?: string | null; channels?: unknown; reloadStatus?: number; configPath?: string },
): Promise<{ fetch: typeof fetch; calls: string[] }> => {
  await writeFile(path.join(home, '.stratus', 'gateway.json'), JSON.stringify({ url: 'http://127.0.0.1:4123', pid: process.pid }));
  await writeFile(path.join(home, '.stratus', 'gateway-token'), 'tok-1\n');
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${target.pathname}`);
    if (target.pathname === '/api/v1/health') {
      // By default, the first release whose reload re-reads the people lists.
      // `null` leaves the version out.
      return new Response(JSON.stringify({ ok: true, version: answer.version === null ? undefined : answer.version ?? '0.14.13' }), { status: 200 });
    }
    if (target.pathname === '/api/v1/config' && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ path: answer.configPath ?? path.join(home, '.stratus', 'config.json'), config: {} }), { status: 200 });
    }
    if (target.pathname === '/api/v1/roster/reload') {
      return answer.reloadStatus !== undefined && answer.reloadStatus !== 200
        ? new Response(JSON.stringify({ error: { code: 'boom', message: 'reload broke' } }), { status: answer.reloadStatus })
        : new Response(JSON.stringify({ agents: [], channels: answer.channels ?? [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

// ---- parsing -----------------------------------------------------------------

test('parseCommand reads stratus people, add and remove', () => {
  assert.deepEqual(parseCommand(['people']), { command: 'people', action: 'list' });
  assert.deepEqual(parseCommand(['people', 'list', '--config', 'c.json']), { command: 'people', action: 'list', configPath: 'c.json' });
  assert.deepEqual(parseCommand(['people', 'add', 'U0123ABCD']), { command: 'people', action: 'add', memberId: 'U0123ABCD', approver: false });
  assert.deepEqual(parseCommand(['people', 'add', 'W0123ABCD', '--agent', 'ava', '--approver']), {
    command: 'people', action: 'add', memberId: 'W0123ABCD', agentId: 'ava', approver: true,
  });
  assert.deepEqual(parseCommand(['people', 'remove', 'U0123ABCD', '--approver', '--config', 'c.json']), {
    command: 'people', action: 'remove', memberId: 'U0123ABCD', approver: true, configPath: 'c.json',
  });
  assert.throws(() => parseCommand(['people', 'add']), /needs a Slack member ID/);
  assert.throws(() => parseCommand(['people', 'add', '@dylan']), /"@dylan" is not a Slack member ID/);
  assert.throws(() => parseCommand(['people', 'add', 'u0123abcd']), /not a Slack member ID/);
  assert.throws(() => parseCommand(['people', 'add', 'U0123ABCD', 'U0456DEFG']), /Unexpected argument: U0456DEFG/);
  assert.throws(() => parseCommand(['people', 'add', 'U0123ABCD', '--everyone']), /Unknown option: --everyone/);
  assert.throws(() => parseCommand(['people', 'add', 'U0123ABCD', '--agent', '__proto__']), /cannot be an agent id/);
  assert.throws(() => parseCommand(['people', 'list', '--approver']), /Unknown option: --approver/);
  assert.throws(() => parseCommand(['people', 'promote', 'U0123ABCD']), /Unknown people command: promote/);
});

// ---- add ---------------------------------------------------------------------

test('people add writes the shared list of a fresh home, owner-only, and says a stopped daemon picks it up at start', async () => {
  const { home, configPath, env } = await homeWith();
  const result = await run(['people', 'add', 'U01AAAAAA'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readConfig(configPath)).principals, { slackUsers: ['U01AAAAAA'] });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.match(result.stdout, /Added U01AAAAAA to principals\.slackUsers in .*config\.json\./);
  assert.match(result.stdout, /No daemon is serving the control API for this home, so this applies when one starts; a daemon running without it needs `stratus restart`\./);
  assert.ok(home);
});

test('people add keeps every other key in the config exactly as it was', async () => {
  const original = {
    $schema: 'https://example.com/stratus.schema.json',
    provider: 'anthropic',
    somethingNewer: { kept: true },
    plugins: { 'stratus-plugin-web': { enabled: true } },
    principals: { admit: 'principals', slackUsers: ['U01AAAAAA'] },
  };
  const { configPath, env } = await homeWith(original);
  assert.equal((await run(['people', 'add', 'U02BBBBBB'], env)).code, 0);
  assert.deepEqual(await readConfig(configPath), {
    ...original,
    principals: { admit: 'principals', slackUsers: ['U01AAAAAA', 'U02BBBBBB'] },
  });
});

test('people add --agent starts the agent\'s own list as a copy of the shared one, so nobody loses access', async () => {
  const { configPath, env } = await homeWith({ principals: { slackUsers: ['U01AAAAAA'] } });
  const result = await run(['people', 'add', 'U02BBBBBB', '--agent', 'ava'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readConfig(configPath)).principals, {
    slackUsers: ['U01AAAAAA'],
    agents: { ava: { slackUsers: ['U01AAAAAA', 'U02BBBBBB'] } },
  });
  assert.match(result.stdout, /ava used the shared list, so principals\.agents\.ava\.slackUsers starts as a copy of it/);
});

test('people add --agent copies the shared list even when they are on it already, so later shared changes stop reaching that agent', async () => {
  const { configPath, env } = await homeWith({ principals: { slackUsers: ['U01AAAAAA'] }, approvals: { slackApprovers: ['U09ZZZZZZ'] } });
  const result = await run(['people', 'add', 'U01AAAAAA', '--agent', 'ava', '--approver'], env);
  assert.equal(result.code, 0, result.stderr);
  const written = await readConfig(configPath);
  assert.deepEqual(written.principals, { slackUsers: ['U01AAAAAA'], agents: { ava: { slackUsers: ['U01AAAAAA'] } } });
  assert.deepEqual(written.approvals, { slackApprovers: ['U09ZZZZZZ'], agents: { ava: { slackApprovers: ['U09ZZZZZZ', 'U01AAAAAA'] } } });
  assert.match(result.stdout, /U01AAAAAA is already on principals\.agents\.ava\.slackUsers\./);
  assert.doesNotMatch(result.stdout, /nothing changed/);
  assert.match(result.stdout, /Added U01AAAAAA to approvals\.agents\.ava\.slackApprovers in /);
  assert.match(result.stdout, /ava used the shared list, so principals\.agents\.ava\.slackUsers starts as a copy of it/);
  assert.match(result.stdout, /ava used the shared list, so approvals\.agents\.ava\.slackApprovers starts as a copy of it/);
});

test('people add --agent of someone the shared list already has gives the agent its own copy and says so', async () => {
  const { configPath, env } = await homeWith({ principals: { slackUsers: ['U01AAAAAA'] } });
  const result = await run(['people', 'add', 'U01AAAAAA', '--agent', 'ava'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readConfig(configPath)).principals, { slackUsers: ['U01AAAAAA'], agents: { ava: { slackUsers: ['U01AAAAAA'] } } });
  assert.doesNotMatch(result.stdout, /Added|nothing changed/);
  assert.match(result.stdout, /^U01AAAAAA is already on principals\.agents\.ava\.slackUsers\.\nava used the shared list, so principals\.agents\.ava\.slackUsers starts as a copy of it\./m);
});

test('people add without --agent names the agents whose own list it does not reach', async () => {
  const { configPath, env } = await homeWith({ principals: { slackUsers: ['U01AAAAAA'], agents: { bea: { slackUsers: ['U01AAAAAA'] } } } });
  const result = await run(['people', 'add', 'U02BBBBBB'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readConfig(configPath)).principals.agents, { bea: { slackUsers: ['U01AAAAAA'] } });
  assert.match(result.stdout, /bea has its own list, so this doesn't reach it: stratus people add U02BBBBBB --agent bea/);
});

test('people add --approver also adds an approver, and warns when approvals are not asked for remotely', async () => {
  const { configPath, env } = await homeWith({});
  const headless = await run(['people', 'add', 'U01AAAAAA', '--approver'], env);
  assert.equal(headless.code, 0, headless.stderr);
  const written = await readConfig(configPath);
  assert.deepEqual(written.principals, { slackUsers: ['U01AAAAAA'] });
  assert.deepEqual(written.approvals, { slackApprovers: ['U01AAAAAA'] });
  assert.match(headless.stdout, /Added U01AAAAAA to principals\.slackUsers and approvals\.slackApprovers/);
  assert.match(headless.stdout, /approvals\.mode is headless/);

  await writeFile(configPath, JSON.stringify({ approvals: { mode: 'remote' } }));
  const remote = await run(['people', 'add', 'U01AAAAAA', '--approver'], env);
  assert.equal(remote.code, 0, remote.stderr);
  assert.doesNotMatch(remote.stdout, /approvals\.mode is/);
});

test('people add of someone already listed changes nothing', async () => {
  const original = JSON.stringify({ principals: { slackUsers: ['U01AAAAAA'] } });
  const { configPath, env } = await homeWith(original);
  const result = await run(['people', 'add', 'U01AAAAAA'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /U01AAAAAA is already on principals\.slackUsers; nothing changed\./);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('people add of someone the shared list already has still names the agents whose own list lacks them', async () => {
  const original = JSON.stringify({ principals: { slackUsers: ['U01AAAAAA'], agents: { bea: { slackUsers: ['U02BBBBBB'] } } } });
  const { configPath, env } = await homeWith(original);
  const result = await run(['people', 'add', 'U01AAAAAA'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /U01AAAAAA is already on principals\.slackUsers; nothing changed\./);
  assert.match(result.stdout, /bea has its own list, so this doesn't reach it: stratus people add U01AAAAAA --agent bea/);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('people add refuses an agent that is not in the roster', async () => {
  const { configPath, env } = await homeWith({});
  const result = await run(['people', 'add', 'U01AAAAAA', '--agent', 'cal'], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No agent cal here/);
  assert.equal(await readFile(configPath, 'utf8'), '{}');
});

// ---- remove ------------------------------------------------------------------

test('people remove takes someone off the shared list and every agent\'s own list, people and approvers', async () => {
  const { configPath, env } = await homeWith({
    principals: { slackUsers: ['U01AAAAAA', 'U02BBBBBB'], agents: { ava: { slackUsers: ['U02BBBBBB'] }, bea: { admit: 'anyone' } } },
    approvals: { mode: 'remote', slackApprovers: ['U02BBBBBB'], agents: { ava: { slackApprovers: ['U02BBBBBB', 'U01AAAAAA'] } } },
  });
  const result = await run(['people', 'remove', 'U02BBBBBB'], env);
  assert.equal(result.code, 0, result.stderr);
  const written = await readConfig(configPath);
  // ava's own list stays, empty: deleting it would hand ava the shared
  // list, and so let in people it had been kept from.
  assert.deepEqual(written.principals, { slackUsers: ['U01AAAAAA'], agents: { ava: { slackUsers: [] }, bea: { admit: 'anyone' } } });
  assert.deepEqual(written.approvals, { mode: 'remote', slackApprovers: [], agents: { ava: { slackApprovers: ['U01AAAAAA'] } } });
  assert.match(result.stdout, /Removed U02BBBBBB from principals\.slackUsers, principals\.agents\.ava\.slackUsers, approvals\.slackApprovers, approvals\.agents\.ava\.slackApprovers/);
});

test('people remove --approver takes away approving only', async () => {
  const { configPath, env } = await homeWith({
    principals: { slackUsers: ['U01AAAAAA'] },
    approvals: { slackApprovers: ['U01AAAAAA'] },
  });
  const result = await run(['people', 'remove', 'U01AAAAAA', '--approver'], env);
  assert.equal(result.code, 0, result.stderr);
  const written = await readConfig(configPath);
  assert.deepEqual(written.principals, { slackUsers: ['U01AAAAAA'] });
  assert.deepEqual(written.approvals, { slackApprovers: [] });
});

test('people remove --agent gives an inheriting agent its own copy of the shared list without them', async () => {
  const { configPath, env } = await homeWith({
    principals: { slackUsers: ['U01AAAAAA', 'U02BBBBBB'] },
    approvals: { slackApprovers: ['U02BBBBBB'] },
  });
  const result = await run(['people', 'remove', 'U02BBBBBB', '--agent', 'ava'], env);
  assert.equal(result.code, 0, result.stderr);
  const written = await readConfig(configPath);
  assert.deepEqual(written.principals, { slackUsers: ['U01AAAAAA', 'U02BBBBBB'], agents: { ava: { slackUsers: ['U01AAAAAA'] } } });
  assert.deepEqual(written.approvals, { slackApprovers: ['U02BBBBBB'], agents: { ava: { slackApprovers: [] } } });
});

test('people remove of someone on no list fails and changes nothing', async () => {
  const original = JSON.stringify({ principals: { slackUsers: ['U01AAAAAA'] } });
  const { configPath, env } = await homeWith(original);
  const result = await run(['people', 'remove', 'U09ZZZZZZ'], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /U09ZZZZZZ isn't on any people or approver list in .*config\.json, so nothing changed\./);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

// ---- a config that can't be edited -------------------------------------------

test('people add leaves a config it cannot read, or one that does not validate, untouched', async () => {
  for (const original of ['{ "principals": ', JSON.stringify({ principals: { admit: 'everyone' } })]) {
    const { configPath, env } = await homeWith(original);
    const result = await run(['people', 'add', 'U01AAAAAA'], env);
    assert.equal(result.code, 1, original);
    assert.match(result.stderr, /left untouched/, original);
    assert.equal(await readFile(configPath, 'utf8'), original);
  }
});

test('people add writes the config STRATUS_CONFIG names, not a project file in the working directory', async () => {
  const { home, env } = await homeWith({});
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-people-project-'));
  await writeFile(path.join(project, 'stratus.config.json'), '{}');
  const chosen = path.join(home, 'chosen.json');
  const result = await run(['people', 'add', 'U01AAAAAA'], { ...env, cwd: project, processEnv: { STRATUS_CONFIG: chosen } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readConfig(chosen)).principals, { slackUsers: ['U01AAAAAA'] });
  assert.equal(await readFile(path.join(project, 'stratus.config.json'), 'utf8'), '{}');
});

// ---- a running daemon --------------------------------------------------------

test('people add reloads a running daemon and says when Slack applied it with no restart', async () => {
  const { home, env } = await homeWith({});
  const daemon = await publishDaemon(home, { channels: [{ name: 'slack', outcome: 'reloaded' }] });
  const result = await run(['people', 'add', 'U01AAAAAA'], { ...env, fetch: daemon.fetch });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(daemon.calls.includes('POST /api/v1/roster/reload'), daemon.calls.join(', '));
  assert.match(result.stdout, /The running daemon \(http:\/\/127\.0\.0\.1:4123\) applied this now, with no restart\./);
});

test('people add does not claim an older daemon applied it', async () => {
  const { home, env } = await homeWith({});
  const daemon = await publishDaemon(home, { version: '0.0.1', channels: [{ name: 'slack', outcome: 'reloaded' }] });
  const result = await run(['people', 'add', 'U01AAAAAA'], { ...env, fetch: daemon.fetch });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /applied this now/);
  assert.match(result.stdout, /is 0\.0\.1, which reads these lists only when it starts, .* stratus restart/);
});

test('people add does not claim a 0.14.12 daemon applied it: its reload kept the lists it started with', async () => {
  // 0.14.12 is the last release whose Slack reload did not re-read the
  // people lists, and it reports `reloaded` all the same. A CLI built from
  // source before the next release carries the same version number, so the
  // CLI's own version cannot be the bar.
  const { home, env } = await homeWith({});
  const daemon = await publishDaemon(home, { version: '0.14.12', channels: [{ name: 'slack', outcome: 'reloaded' }] });
  const result = await run(['people', 'add', 'U01AAAAAA'], { ...env, fetch: daemon.fetch });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /applied this now/);
  assert.match(result.stdout, /is 0\.14\.12, which reads these lists only when it starts, .* stratus restart/);
});

test('people add does not claim a daemon that names no version applied it', async () => {
  for (const version of [null, '']) {
    const { home, env } = await homeWith({});
    const daemon = await publishDaemon(home, { version, channels: [{ name: 'slack', outcome: 'reloaded' }] });
    const result = await run(['people', 'add', 'U01AAAAAA'], { ...env, fetch: daemon.fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /applied this now/);
    assert.match(result.stdout, /did not say which version it is, so it may still use the old lists\. Apply them with: stratus restart/, String(version));
  }
});

test('people add believes a daemon newer than this CLI', async () => {
  const { home, env } = await homeWith({});
  const daemon = await publishDaemon(home, { version: '99.0.0', channels: [{ name: 'slack', outcome: 'reloaded' }] });
  const result = await run(['people', 'add', 'U01AAAAAA'], { ...env, fetch: daemon.fetch });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /applied this now, with no restart\./);
});

test('people add says so when the daemon could not reload Slack or has no Slack connection', async () => {
  const failed = await homeWith({});
  const failing = await publishDaemon(failed.home, { channels: [{ name: 'slack', outcome: 'failed', reason: 'invalid_auth' }] });
  const one = await run(['people', 'add', 'U01AAAAAA'], { ...failed.env, fetch: failing.fetch });
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /could not reload slack \(invalid_auth\), so this applies at its next start: `stratus restart`/);

  const none = await homeWith({});
  const noSlack = await publishDaemon(none.home, { channels: [] });
  const two = await run(['people', 'add', 'U01AAAAAA'], { ...none.env, fetch: noSlack.fetch });
  assert.equal(two.code, 0, two.stderr);
  assert.match(two.stdout, /has no Slack connection right now/);

  const broken = await homeWith({});
  const refusing = await publishDaemon(broken.home, { reloadStatus: 500 });
  const three = await run(['people', 'add', 'U01AAAAAA'], { ...broken.env, fetch: refusing.fetch });
  assert.equal(three.code, 0, three.stderr);
  assert.match(three.stdout, /did not reload: .*stratus restart/);
});

test('people add refuses to edit a config the running daemon does not read', async () => {
  const { home, configPath, env } = await homeWith({});
  const pinned = path.join(home, 'pinned config.json');
  await writeFile(pinned, '{}');
  const daemon = await publishDaemon(home, { configPath: pinned, channels: [{ name: 'slack', outcome: 'reloaded' }] });
  const result = await run(['people', 'add', 'U01AAAAAA', '--agent', 'ava', '--approver'], { ...env, fetch: daemon.fetch });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The running daemon \(http:\/\/127\.0\.0\.1:4123\) reads .*pinned config\.json, so a change to .*config\.json wouldn't reach it\. Nothing changed\./);
  assert.match(result.stderr, /stratus people add U01AAAAAA --agent ava --approver --config '.*pinned config\.json'/);
  assert.ok(!daemon.calls.includes('POST /api/v1/roster/reload'));
  assert.equal(await readFile(configPath, 'utf8'), '{}');
  assert.equal(await readFile(pinned, 'utf8'), '{}');

  // Pointed at the daemon's file, it goes through.
  const pointed = await run(['people', 'add', 'U01AAAAAA', '--config', pinned], { ...env, fetch: daemon.fetch });
  assert.equal(pointed.code, 0, pointed.stderr);
  assert.deepEqual((await readConfig(pinned)).principals, { slackUsers: ['U01AAAAAA'] });
  assert.match(pointed.stdout, /applied this now/);

  const listed = await run(['people'], { ...env, fetch: daemon.fetch });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /The running daemon reads .*pinned config\.json, not this file: stratus people --config '.*pinned config\.json'/);
});

// ---- list --------------------------------------------------------------------

test('stratus people lists each agent\'s admit setting, people and approvers, and where each list comes from', async () => {
  const { env } = await homeWith({
    principals: { slackUsers: ['U01AAAAAA', 'U02BBBBBB'], agents: { bea: { admit: 'anyone', slackUsers: ['U03CCCCCC'] } } },
    approvals: { slackApprovers: ['U01AAAAAA'] },
  });
  const result = await run(['people'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ava\n {2}admits {5}listed people only\n {2}people {5}U01AAAAAA, U02BBBBBB \(shared list\)\n {2}approvers {2}U01AAAAAA \(shared list\)$/m);
  assert.match(result.stdout, /^bea\n {2}admits {5}anyone\n {2}people {5}U03CCCCCC \(its own list\)\n {2}approvers {2}U01AAAAAA \(shared list\)$/m);
  assert.match(result.stdout, /approvals\.mode is headless/);
});

test('stratus people lists the built-in agent too, which every daemon serves', async () => {
  const { env } = await homeWith({ principals: { slackUsers: ['U01AAAAAA'] } });
  const result = await run(['people'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^stratus\n {2}admits {5}listed people only\n {2}people {5}U01AAAAAA \(shared list\)\n {2}approvers {2}nobody$/m);
});

test('stratus people says nobody is listed on a fresh home', async () => {
  const { env } = await homeWith();
  const result = await run(['people'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ava\n {2}admits {5}listed people only\n {2}people {5}nobody\n {2}approvers {2}nobody$/m);
  assert.match(result.stdout, /stratus people add <member-id>/);
});
