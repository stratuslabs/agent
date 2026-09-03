import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PENDING_APPROVAL_METADATA_KEY, RunAbortedError, type StratusEvent } from '@stratusagent/core';
import type { OptionalModuleHost } from '@stratusagent/plugins';

import {
  RESTARTING_TURN_ERROR,
  RestartUnsupportedError,
  SqliteSessionStore,
  createGateway,
  type GatewayChannelAdapter,
  type RestartOutcome,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-reload-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const writeSkill = async (home: string, id: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), contents);
};

const skillFile = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: Use when the task is ${name}.\n---\n\n# ${name}\n\n${body}\n`;

const REVIEWER = [
  '---',
  'name: Ava',
  'id: ava',
  'provider: openai',
  'model: model-a',
  'skills:',
  '  - code-review',
  '  - triage',
  '---',
  '',
  'You review code.',
  '',
].join('\n');

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const openAiToolCall = (name: string, args: object): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * A provider that reads one skill at the start of every turn and answers
 * once the result is back. Decided from the request rather than a call
 * count, because the gateway builds the provider once per agent and the
 * tests below run several turns through it.
 */
const readingProvider = (skillId: string): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
    return body.messages.at(-1)?.role === 'tool'
      ? openAiText('done')
      : openAiToolCall('skill_read', { id: skillId });
  }) as typeof fetch;

/** The tool result the runner recorded for the turn's one skill read. */
const readResult = (session: { messages: Array<{ role: string; toolResult?: { ok: boolean; output?: unknown; error?: string } }> }) =>
  session.messages.find((message) => message.role === 'tool')?.toolResult;

const nextEvent = <T extends StratusEvent['type']>(
  bus: { subscribe(handler: (event: StratusEvent) => void): () => void },
  type: T,
): Promise<Extract<StratusEvent, { type: T }>> =>
  new Promise((resolve) => {
    const off = bus.subscribe((event) => {
      if (event.type === type) {
        off();
        resolve(event as Extract<StratusEvent, { type: T }>);
      }
    });
  });

test('a skill installed while the daemon runs is readable on the next turn, and one removed stops being', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', REVIEWER);
  await writeSkill(home, 'code-review', skillFile('code-review', 'Lead with the verdict.'));
  const log: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: readingProvider('triage') };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: (line) => log.push(line), warn: () => {} });
  await gateway.start();
  try {
    assert.deepEqual(gateway.skills().map((skill) => skill.id), ['code-review']);

    // Before the reload the soul lists triage, but nothing serves it: the
    // read fails the way any missing skill fails.
    const before = await gateway.dispatch({ sessionId: 'before', agentId: 'ava', userMessage: 'triage this' });
    assert.equal(readResult(before)?.ok, false);

    await writeSkill(home, 'triage', skillFile('triage', 'Sort by severity first.'));
    const reloaded = await gateway.reloadSkills();
    assert.deepEqual(reloaded.map((skill) => skill.id), ['code-review', 'triage']);
    assert.equal(reloaded.find((skill) => skill.id === 'triage')?.path, path.join(home, '.stratus', 'skills', 'triage', 'SKILL.md'));
    assert.ok(log.some((line) => /skills reloaded — 2 skill\(s\): added triage/.test(line)), log.join('\n'));

    // No restart happened and the same daemon carries on; the new skill
    // reaches the agent because its soul already listed it — loaded is
    // not enabled, and the reload widened nothing on its own.
    const after = await gateway.dispatch({ sessionId: 'after', agentId: 'ava', userMessage: 'triage this' });
    assert.equal(readResult(after)?.ok, true);
    assert.match(JSON.stringify(readResult(after)?.output), /Sort by severity first/);

    // Twice with nothing changed is a no-op, said so.
    await gateway.reloadSkills();
    assert.ok(log.some((line) => /skills reloaded — 2 skill\(s\) \(no change\)/.test(line)), log.join('\n'));

    // Removed while running: gone from the catalog, and the agent whose
    // soul still lists it fails its read like any missing skill.
    await rm(path.join(home, '.stratus', 'skills', 'triage'), { recursive: true });
    const shrunk = await gateway.reloadSkills();
    assert.deepEqual(shrunk.map((skill) => skill.id), ['code-review']);
    assert.ok(log.some((line) => /skills reloaded — 1 skill\(s\): removed triage/.test(line)), log.join('\n'));
    const gone = await gateway.dispatch({ sessionId: 'gone', agentId: 'ava', userMessage: 'triage this' });
    assert.equal(readResult(gone)?.ok, false);
  } finally {
    await gateway.stop();
  }
});

test('a skill that will not load refuses the reload, names the file, and leaves the previous set serving', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', REVIEWER);
  await writeSkill(home, 'code-review', skillFile('code-review', 'Lead with the verdict.'));
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: readingProvider('code-review') };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: (line) => warnings.push(line) });
  await gateway.start();
  try {
    // One good new skill and one with no description: the good one must
    // not land either — half a catalog is worse than a stale one.
    await writeSkill(home, 'triage', skillFile('triage', 'Sort by severity first.'));
    await writeSkill(home, 'broken', '---\nname: Broken\n---\n\nNo description.\n');
    const brokenPath = path.join(home, '.stratus', 'skills', 'broken', 'SKILL.md');
    await assert.rejects(
      gateway.reloadSkills(),
      (error: Error) => error.message.includes(brokenPath) && /previously loaded skills are still serving/.test(error.message),
    );
    assert.ok(warnings.some((line) => line.startsWith('skills reload refused') && line.includes(brokenPath)), warnings.join('\n'));
    assert.deepEqual(gateway.skills().map((skill) => skill.id), ['code-review']);

    // The old set really is serving, not just listed.
    const session = await gateway.dispatch({ sessionId: 'still', agentId: 'ava', userMessage: 'review' });
    assert.equal(readResult(session)?.ok, true);

    // A failed reload does not block the next one.
    await rm(path.join(home, '.stratus', 'skills', 'broken'), { recursive: true });
    assert.deepEqual((await gateway.reloadSkills()).map((skill) => skill.id), ['code-review', 'triage']);
  } finally {
    await gateway.stop();
  }
});

test('a reload during a turn that is reading a skill does not fail that turn', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', REVIEWER);
  await writeSkill(home, 'code-review', skillFile('code-review', 'Lead with the verdict.'));

  // The provider's first answer — the skill.read call — is held until the
  // test releases it, so the reload lands between the turn starting and
  // the read running.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let firstCall!: () => void;
  const started = new Promise<void>((resolve) => { firstCall = resolve; });
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      firstCall();
      await held;
      return openAiToolCall('skill_read', { id: 'code-review' });
    }
    return openAiText('done');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    const turn = gateway.dispatch({ sessionId: 'racing', agentId: 'ava', userMessage: 'review' });
    await started;
    await writeSkill(home, 'triage', skillFile('triage', 'Sort by severity first.'));
    await gateway.reloadSkills();
    release();
    const session = await turn;
    assert.equal(session.status, 'completed', session.lastError);
    assert.equal(readResult(session)?.ok, true);
    assert.match(JSON.stringify(readResult(session)?.output), /Lead with the verdict/);
  } finally {
    await gateway.stop();
  }
});

test('operator precedence and contested aliases survive a reload', async () => {
  const home = await newHome();
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-reload-pkgs-'));
  const entries = new Map<string, string>();
  const skillSource = (label: string): string =>
    `---\ndescription: Use when the task calls for ${label}.\n---\n\n# ${label}\n`;
  // acme and zephyr both want `pr-review`; acme alone wants `triage`.
  const packages: Record<string, string[]> = {
    'stratus-plugin-acme': ['pr-review', 'triage'],
    'stratus-plugin-zephyr': ['pr-review'],
  };
  for (const [name, skills] of Object.entries(packages)) {
    const directory = path.join(root, name.replace(/[@/]/g, '_'));
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await mkdir(path.join(directory, 'skills'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name,
      stratus: { pluginVersion: 1, contributes: { skills: skills.map((id) => ({ id, path: `./skills/${id}.md` })) } },
    }));
    for (const id of skills) {
      await writeFile(path.join(directory, 'skills', `${id}.md`), skillSource(`${name} ${id}`));
    }
    entries.set(name, pathToFileURL(path.join(directory, 'dist', 'index.js')).href);
  }
  const host: OptionalModuleHost = {
    resolve(specifier) {
      const resolved = entries.get(specifier);
      if (!resolved) {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return resolved;
    },
    async import(specifier) {
      return { createPlugin: () => ({ name: specifier, setup() {} }) };
    },
  };

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: {
      'stratus-plugin-acme': { enabled: true },
      'stratus-plugin-zephyr': { enabled: true },
    },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const aliasOf = (id: string): string | undefined => gateway.skills().find((skill) => skill.id === id)?.alias;
    assert.equal(aliasOf('stratus-plugin-acme:triage'), 'triage');
    assert.equal(aliasOf('stratus-plugin-acme:pr-review'), undefined, 'contested at load');
    assert.equal(aliasOf('stratus-plugin-zephyr:pr-review'), undefined);

    // An operator skill installed under the bare id takes it from the
    // plugin on reload, as it would have at start; the plugin's skill
    // stays reachable qualified, and the contested id stays dead — a
    // rebuild is exactly where that state would get dropped.
    await writeSkill(home, 'triage', skillFile('triage', 'The operator copy.'));
    const reloaded = await gateway.reloadSkills();
    assert.deepEqual(
      reloaded.map((skill) => skill.id).sort(),
      ['stratus-plugin-acme:pr-review', 'stratus-plugin-acme:triage', 'stratus-plugin-zephyr:pr-review', 'triage'],
    );
    assert.equal(aliasOf('stratus-plugin-acme:triage'), undefined, 'the operator outranks the bare alias');
    assert.equal(reloaded.find((skill) => skill.id === 'triage')?.package, undefined);
    assert.equal(aliasOf('stratus-plugin-acme:pr-review'), undefined, 'still contested');
    assert.equal(aliasOf('stratus-plugin-zephyr:pr-review'), undefined);
    for (const status of gateway.plugins()) {
      for (const skill of status.skills ?? []) {
        assert.equal(skill.alias, undefined, `${status.package} advertises ${skill.alias} after the reload`);
      }
    }

    // And back: removing the operator's copy returns the alias to the
    // plugin, which is what a restart would do too.
    await rm(path.join(home, '.stratus', 'skills', 'triage'), { recursive: true });
    await gateway.reloadSkills();
    assert.equal(aliasOf('stratus-plugin-acme:triage'), 'triage');
    assert.equal(aliasOf('stratus-plugin-acme:pr-review'), undefined);
  } finally {
    await gateway.stop();
  }
});

test('an announced restart refuses new turns, lets a running one finish, and hands the host a drained daemon', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let firstCall!: () => void;
  const started = new Promise<void>((resolve) => { firstCall = resolve; });
  const fetchImpl = (async () => {
    firstCall();
    await held;
    return openAiText('finished');
  }) as typeof fetch;

  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const log: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    log: (line) => log.push(line),
    warn: () => {},
    onRestart: (outcome) => handOff(outcome),
  });
  await gateway.start();

  const running = gateway.dispatch({ sessionId: 'long', agentId: 'ava', userMessage: 'take your time' });
  await started;
  const status = gateway.restart({ reason: 'plugin enabled', drainTimeoutMs: 60_000 });
  assert.equal(status.inflight, 1);
  assert.equal(status.reason, 'plugin enabled');
  assert.ok(log.some((line) => /restart requested \(plugin enabled\) — refusing new turns; 1 turn\(s\) in flight/.test(line)), log.join('\n'));
  // Announced once: a second call reports the same terms rather than
  // starting a second drain.
  assert.equal(gateway.restart(), status);

  // Refused at once, and the refusal says why — not "stopping", which a
  // channel would render as the daemon going away for good.
  await assert.rejects(
    gateway.dispatch({ sessionId: 'late', agentId: 'ava', userMessage: 'hello?' }),
    /restarting and will accept new work once it is back up/,
  );

  release();
  const finished = await running;
  assert.equal(finished.status, 'completed', finished.lastError);
  const outcome = await restarted;
  assert.deepEqual(outcome, { reason: 'plugin enabled', drained: true });
  assert.ok(log.some((line) => line === 'stratusd stopped'));
  // The host's own shutdown path finds nothing left to do.
  await gateway.stop();

  // What comes back is what a stop-and-start brings back: the session, with
  // the turn that finished inside the window.
  const next = createGateway({ env: { homeDir: home, cwd: home, processEnv: {} }, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await next.start();
  try {
    const stored = await next.store.get('long');
    assert.equal(stored?.status, 'completed');
    assert.equal(stored?.messages.at(-1)?.content, 'finished');
  } finally {
    await next.stop();
  }
});

test('a turn that outlives the drain window is aborted as restarting, and the restart still happens', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  // Never answers on its own; only the abort on the request's signal ends
  // it — so the window is not a race, it is the only way out.
  let firstCall!: () => void;
  const started = new Promise<void>((resolve) => { firstCall = resolve; });
  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      firstCall();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    log: () => {},
    warn: (line) => warnings.push(line),
    onRestart: (outcome) => handOff(outcome),
  });
  const failed = nextEvent(gateway.bus, 'session.failed');
  await gateway.start();

  const stuck = gateway.dispatch({ sessionId: 'stuck', agentId: 'ava', userMessage: 'hang' });
  await started;
  gateway.restart({ drainTimeoutMs: 50 });

  await assert.rejects(
    stuck,
    (error: Error) => error instanceof RunAbortedError && error.message === RESTARTING_TURN_ERROR,
  );
  // Aborted, then finished: the session records why, so the next daemon
  // finds a failed turn rather than an abandoned one.
  assert.equal((await failed).error, RESTARTING_TURN_ERROR);
  assert.deepEqual(await restarted, { drained: true });
  assert.ok(warnings.some((line) => /restart: 1 turn\(s\) still running after 50ms; aborting them/.test(line)), warnings.join('\n'));
  await gateway.stop();

  const next = createGateway({ env: { homeDir: home, cwd: home, processEnv: {} }, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await next.start();
  try {
    const stored = await next.store.get('stuck');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.lastError, RESTARTING_TURN_ERROR);
  } finally {
    await next.stop();
  }
});

test('a gateway whose host gave it no way back refuses to restart, and says so', async () => {
  const home = await newHome();
  const gateway = createGateway({ env: { homeDir: home, cwd: home, processEnv: {} }, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    assert.throws(() => gateway.restart(), RestartUnsupportedError);
    // Still serving: a refused restart is not a stop.
    const session = await gateway.dispatch({ sessionId: 'still-up', userMessage: 'hello' });
    assert.equal(session.status, 'completed');
  } finally {
    await gateway.stop();
  }
});

test('a drain window above Node\'s maximum timer delay is clamped, not fired at once', async () => {
  const home = await newHome();
  const warnings: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    log: () => {},
    warn: (line) => warnings.push(line),
    onRestart: () => {},
  });
  await gateway.start();
  // Node treats a delay above 2^31-1 ms as roughly 1 ms, so an unclamped
  // "very long" window would abort every running turn immediately.
  const status = gateway.restart({ drainTimeoutMs: 10 * 365 * 24 * 60 * 60 * 1000 });
  assert.equal(status.drainTimeoutMs, 2_147_483_647);
  assert.ok(warnings.some((line) => /restart drain window .* above Node's maximum timer delay/.test(line)), warnings.join('\n'));
  await gateway.stop();
});

test('a scheduled firing that ignores its abort does not hold the restart forever', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  // Never answers and never honours the signal: the worst a provider can
  // do. The firing it serves is tracked by the scheduler's drain as well as
  // the gateway's, and both have to give up for the restart to happen.
  let firing!: () => void;
  const firingStarted = new Promise<void>((resolve) => { firing = resolve; });
  const fetchImpl = (() => new Promise<Response>(() => { firing(); })) as typeof fetch;

  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    schedules: { minIntervalMs: 500, tickMs: 25 },
    log: () => {},
    warn: (line) => warnings.push(line),
    onRestart: (outcome) => handOff(outcome),
  });
  await gateway.start();

  const { SqliteScheduleStore, defaultSessionDbPath } = await import('../src/index.ts');
  const scheduleStore = new SqliteScheduleStore(defaultSessionDbPath({ homeDir: home }));
  scheduleStore.insert({
    id: 'sched-stuck',
    agentId: 'ava',
    cadence: { kind: 'every', intervalMs: 600_000 },
    prompt: 'do the scheduled thing',
    createdAt: new Date().toISOString(),
    nextFireAt: new Date(Date.now() - 5).toISOString(),
  });
  scheduleStore.close();
  await firingStarted;

  gateway.restart({ drainTimeoutMs: 50 });
  // The gate has a way to lose: a restart still waiting on the firing
  // after a bound far above its three windows is the hang this guards.
  const outcome = await Promise.race([
    restarted,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
  ]);
  assert.notEqual(outcome, 'hung', 'the restart waited on a firing that will never settle');
  assert.deepEqual(outcome, { drained: false });
  assert.ok(warnings.some((line) => /did not stop after being aborted/.test(line)), warnings.join('\n'));
  assert.ok(warnings.some((line) => /a scheduled firing did not stop/.test(line)), warnings.join('\n'));
  await gateway.stop();
});

test('a plugin whose dispose never settles does not hold the restart, and the host is told', async () => {
  const home = await newHome();
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-reload-dispose-'));
  const directory = path.join(root, 'stratus-plugin-stuck');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await mkdir(path.join(directory, 'skills'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-stuck',
    stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'triage', path: './skills/triage.md' }] } },
  }));
  await writeFile(path.join(directory, 'skills', 'triage.md'), '---\ndescription: Use when sorting.\n---\n\n# triage\n');
  const host: OptionalModuleHost = {
    resolve: () => pathToFileURL(path.join(directory, 'dist', 'index.js')).href,
    // The likeliest reason to restart is a plugin that misbehaves — and
    // this one will not let go of whatever it holds.
    async import() {
      return { createPlugin: () => ({ name: 'stuck', setup() {}, dispose: () => new Promise<void>(() => {}) }) };
    },
  };

  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const warnings: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-stuck': { enabled: true } },
    pluginHost: host,
    log: () => {},
    warn: (line) => warnings.push(line),
    onRestart: (outcome) => handOff(outcome),
  });
  await gateway.start();
  assert.ok(gateway.plugins().some((plugin) => plugin.package === 'stratus-plugin-stuck' && plugin.error === undefined));

  gateway.restart({ drainTimeoutMs: 50 });
  const outcome = await Promise.race([
    restarted,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
  ]);
  assert.notEqual(outcome, 'hung', 'the restart waited on a dispose that will never settle');
  assert.deepEqual(outcome, { drained: false });
  assert.ok(warnings.some((line) => /a plugin did not release what it holds within 50ms/.test(line)), warnings.join('\n'));
  await gateway.stop();
});

test('a channel whose stop rejects, or a plugin whose dispose rejects, leaves the restart undrained', async () => {
  const home = await newHome();
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-reload-reject-'));
  const directory = path.join(root, 'stratus-plugin-flaky');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await mkdir(path.join(directory, 'skills'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-flaky',
    stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'triage', path: './skills/triage.md' }] } },
  }));
  await writeFile(path.join(directory, 'skills', 'triage.md'), '---\ndescription: Use when sorting.\n---\n\n# triage\n');
  const host: OptionalModuleHost = {
    resolve: () => pathToFileURL(path.join(directory, 'dist', 'index.js')).href,
    async import() {
      return { createPlugin: () => ({ name: 'flaky', setup() {}, dispose: async () => { throw new Error('the browser would not close'); } }) };
    },
  };
  // Answers at once, and rejects: whether its connection is really gone
  // is exactly what nobody can say.
  const channel: GatewayChannelAdapter = {
    name: 'flaky-channel',
    async start() {},
    async stop() {
      throw new Error('socket refused to close');
    },
  };

  const outcomeOf = async (options: { plugin: boolean; channel: boolean }): Promise<{ outcome: RestartOutcome; warnings: string[] }> => {
    let handOff!: (outcome: RestartOutcome) => void;
    const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
    const warnings: string[] = [];
    const gateway = createGateway({
      env: { homeDir: home, cwd: home, processEnv: {} },
      idleTimeoutMs: 0,
      ...(options.plugin ? { plugins: { 'stratus-plugin-flaky': { enabled: true } }, pluginHost: host } : {}),
      ...(options.channel ? { channels: [channel] } : {}),
      log: () => {},
      warn: (line) => warnings.push(line),
      onRestart: (outcome) => handOff(outcome),
    });
    await gateway.start();
    gateway.restart({ drainTimeoutMs: 60_000 });
    const outcome = await restarted;
    await gateway.stop();
    return { outcome, warnings };
  };

  const plugin = await outcomeOf({ plugin: true, channel: false });
  assert.deepEqual(plugin.outcome, { drained: false });
  assert.ok(plugin.warnings.some((line) => /plugin stratus-plugin-flaky failed to shut down: the browser would not close/.test(line)), plugin.warnings.join('\n'));

  const adapter = await outcomeOf({ plugin: false, channel: true });
  assert.deepEqual(adapter.outcome, { drained: false });
  assert.ok(adapter.warnings.some((line) => /channel flaky-channel failed to stop: socket refused to close/.test(line)), adapter.warnings.join('\n'));

  // And with nothing misbehaving, the same daemon reports drained.
  assert.deepEqual((await outcomeOf({ plugin: false, channel: false })).outcome, { drained: true });
});

test('a turn queued behind the one aborted at the window is aborted too, not left running unrecorded', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  // Every provider call blocks until its request's signal aborts: the
  // running turn and the one queued behind it on the same session alike.
  let calls = 0;
  let firstCall!: () => void;
  const started = new Promise<void>((resolve) => { firstCall = resolve; });
  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      calls += 1;
      firstCall();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, onRestart: (outcome) => handOff(outcome) });
  await gateway.start();

  // Single-flight per session: the second message waits behind the first.
  const running = gateway.dispatch({ sessionId: 'queued', agentId: 'ava', userMessage: 'first' });
  const queued = gateway.dispatch({ sessionId: 'queued', agentId: 'ava', userMessage: 'second' });
  await started;
  // The window is armed twice: once for the turns to finish on their own
  // (they never will — the provider blocks until aborted), and once more
  // for the aborted turns to settle, which is two abort rejections, two
  // session writes, and their events. 50ms lost that second race on a
  // loaded CI runner and reported `drained: false` for a drain that was
  // merely slow; the number has to sit far above that work, not just
  // above it.
  gateway.restart({ drainTimeoutMs: 500 });

  const isRestartAbort = (error: Error): boolean => error instanceof RunAbortedError && error.message === RESTARTING_TURN_ERROR;
  await assert.rejects(running, isRestartAbort);
  // The gate has a way to lose: unaborted, the queued turn blocks on its
  // provider forever and the restart only ends by shutting down around it.
  const second = await Promise.race([
    queued.then(() => 'completed', (error: Error) => (isRestartAbort(error) ? 'aborted' : `failed: ${error.message}`)),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
  ]);
  assert.equal(second, 'aborted');
  assert.deepEqual(await restarted, { drained: true });
  await gateway.stop();

  const next = createGateway({ env: { homeDir: home, cwd: home, processEnv: {} }, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await next.start();
  try {
    const stored = await next.store.get('queued');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.lastError, RESTARTING_TURN_ERROR);
  } finally {
    await next.stop();
  }
});

test('a restart asked for with a window that is not a number of milliseconds is refused, and is not a restart', async () => {
  const home = await newHome();
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    log: () => {},
    warn: () => {},
    onRestart: () => {},
  });
  await gateway.start();
  try {
    assert.throws(() => gateway.restart({ drainTimeoutMs: -1 }), /non-negative number of milliseconds, not -1/);
    assert.throws(() => gateway.restart({ drainTimeoutMs: Number.NaN }), /not NaN/);
    // Refused before anything was announced: still serving.
    const session = await gateway.dispatch({ sessionId: 'still-up', userMessage: 'hello' });
    assert.equal(session.status, 'completed');
  } finally {
    await gateway.stop();
  }
});

test('a restart asked for while the daemon is still starting is refused, and works once it serves', async () => {
  const home = await newHome();
  // A channel that takes its time connecting — the control API, started
  // before it, is already answering by then.
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const slow: GatewayChannelAdapter = {
    name: 'slow',
    async start() {
      entered();
      await released;
    },
    async stop() {},
  };
  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    channels: [slow],
    log: () => {},
    warn: () => {},
    onRestart: (outcome) => handOff(outcome),
  });

  const start = gateway.start();
  await starting;
  assert.throws(() => gateway.restart(), /still starting/);
  release();
  await start;

  // Startup finished with its stores open, and the restart now proceeds.
  const status = gateway.restart({ reason: 'later' });
  assert.equal(status.reason, 'later');
  assert.deepEqual(await restarted, { reason: 'later', drained: true });
  await gateway.stop();
});

test('a turn recovered from a parked approval is aborted at the window like any other', async () => {
  const home = await newHome();
  const dbPath = path.join(home, 'sessions.db');
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  // A session left as a kill mid-approval leaves one. Recovery runs the
  // parked call and then asks the provider again — and that call is the
  // one that blocks until its signal aborts.
  const seed = new SqliteSessionStore(dbPath);
  const now = new Date().toISOString();
  await seed.create({
    id: 'parked-session',
    agent: { id: 'ava', name: 'Ava' },
    status: 'pending_approval',
    messages: [
      { id: 'm1', role: 'user', content: 'go', createdAt: now },
      { id: 'm2', role: 'assistant', content: '', createdAt: now, toolCalls: [{ id: 'c1', toolName: 'demo.echo', input: { text: 'one' } }] },
    ],
    metadata: {
      [PENDING_APPROVAL_METADATA_KEY]: {
        call: { id: 'c1', toolName: 'demo.echo', input: { text: 'one' } },
        remaining: [],
        parkedAt: now,
      },
    },
  });
  seed.close();

  let firstCall!: () => void;
  const started = new Promise<void>((resolve) => { firstCall = resolve; });
  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      firstCall();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

  let handOff!: (outcome: RestartOutcome) => void;
  const restarted = new Promise<RestartOutcome>((resolve) => { handOff = resolve; });
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    sessionDbPath: dbPath,
    log: () => {},
    warn: () => {},
    onRestart: (outcome) => handOff(outcome),
  });
  const failed = nextEvent(gateway.bus, 'session.failed');
  await gateway.start();
  await started;

  gateway.restart({ drainTimeoutMs: 50 });
  // Aborted inside the window, not shut down around after a second one:
  // the recovered turn is recorded as restart-aborted and the daemon
  // reports drained.
  const outcome = await Promise.race([
    restarted,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
  ]);
  assert.deepEqual(outcome, { drained: true });
  assert.equal((await failed).error, RESTARTING_TURN_ERROR);
  await gateway.stop();

  const after = new SqliteSessionStore(dbPath);
  const session = await after.get('parked-session');
  after.close();
  assert.equal(session?.status, 'failed');
  assert.equal(session?.lastError, RESTARTING_TURN_ERROR);
});
