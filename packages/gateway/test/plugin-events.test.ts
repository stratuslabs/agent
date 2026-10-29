import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { EventIngestHandle, JsonObject, PluginContext } from '@stratusagent/core';
import { parseEventFilter } from '@stratusagent/agents';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import { fleetDbIn } from '@stratusagent/state';

import {
  SqliteEventStore,
  SqliteScheduleStore,
  createEventIntake,
  createGateway,
  createSchedulerRuntime,
  type EventIntakeOptions,
  type EventTrigger,
} from '../src/index.ts';

// Card 590 phase 2: a plugin source (a GitHub poller, an MCP bridge) feeds
// the same dedup, rule filter and firing path a signed delivery takes,
// through `PluginContext.events`. What's under test is that a plugin's event
// is held to the same rules as a webhook's, minus the signature, and that a
// plugin source is never reachable over HTTP.

const NOW = new Date('2026-10-29T22:30:00Z');

const review = (id: string, extra: JsonObject = {}): JsonObject => ({
  specversion: '1.0',
  id,
  source: 'https://github.com/stratuslabs/agent',
  type: 'com.github.pull_request_review.submitted',
  subject: 'pull/490',
  actor: 'chatgpt-codex-connector[bot]',
  author: 'atlasatstratuslabs[bot]',
  data: { review: { body: '<!-- codex-review-receipt:v1 --> looks good' } },
  ...extra,
});

const harness = async (overrides: Partial<EventIntakeOptions> = {}, triggers: EventTrigger[] = []) => {
  const store = new SqliteEventStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-intake-')), 'fleet.db'));
  const warnings: string[] = [];
  const intake = createEventIntake({
    store,
    sources: () => ({ board: { verify: 'standard-webhooks', secrets: ['events.board'] } }),
    pluginSources: () => ['github'],
    secret: async () => undefined,
    triggers: (sourceId) => triggers.filter((trigger) => trigger.source === sourceId),
    now: () => NOW,
    warn: (line) => warnings.push(line),
    ...overrides,
  });
  return { intake, store, warnings };
};

const codexTrigger: EventTrigger = {
  triggerId: 'sched-codex',
  agentId: 'atlas',
  source: 'github',
  filter: parseEventFilter({ exact: { actor: 'chatgpt-codex-connector[bot]', author: 'atlasatstratuslabs[bot]' } }),
};

test('a plugin event that matches a trigger leaves a pending firing, and the same id again is a duplicate', async () => {
  const { intake, store } = await harness({}, [codexTrigger]);
  assert.deepEqual(intake.ingest('github', review('poll-1')), { status: 'matched' });
  const open = store.open();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.dispatchKey, 'event:sched-codex:github:poll-1');
  assert.match(open[0]!.block ?? '', /^Event from source "github":/);
  assert.deepEqual(intake.ingest('github', review('poll-1')), { status: 'duplicate' });
  assert.equal(store.open().length, 1, 'the repeat fired nothing');
  assert.deepEqual(intake.ingest('github', review('poll-2', { actor: 'dylan' })), { status: 'unmatched' });
});

test('a plugin event that is not a CloudEvent is refused with the reason, and leaves a refused row', async () => {
  const { intake, store } = await harness();
  assert.throws(() => intake.ingest('github', { specversion: '1.0', id: 'bad-1', source: 's' }), /needs a non-empty string "type"/);
  assert.throws(() => intake.ingest('github', { id: 'bad-2', source: 's', type: 't' }), /specversion/);
  assert.throws(() => intake.ingest('github', { ...review('bad-3'), data_base64: 'AAAA' }), /data_base64 is not supported/);
  const rows = store.deliveries({ source: 'github' });
  assert.deepEqual(rows.map((row) => [row.eventId, row.status]), [['bad-3', 'refused'], ['bad-2', 'refused'], ['bad-1', 'refused']]);
  // No tombstone: the plugin can fix the event and send the same id.
  assert.deepEqual(intake.ingest('github', review('bad-1')), { status: 'unmatched' });
});

test('a plugin event over the size limit or past the source\'s minute is refused before it leaves a row', async () => {
  const { intake, store } = await harness({ maxBodyBytes: 2_000 });
  assert.throws(() => intake.ingest('github', review('big', { data: { text: 'x'.repeat(3_000) } })), /over 2000 bytes/);
  for (let i = 0; i < 120; i += 1) {
    intake.ingest('github', review(`burst-${i}`));
  }
  assert.throws(() => intake.ingest('github', review('burst-120')), /Over 120 events a minute/);
  assert.deepEqual(store.deliveries({ source: 'github' }).filter((row) => row.status === 'refused'), []);
  const counted = intake.counters().sources.github!;
  assert.equal(counted.tooLarge, 1);
  assert.equal(counted.rateLimited, 1);
  assert.match(counted.lastRefusal?.reason ?? '', /120/);
});

test('ingest takes only plugin sources, and the HTTP listener never serves one', async () => {
  const { intake } = await harness();
  assert.throws(() => intake.ingest('board', review('x')), /No plugin feeds an event source "board"/);
  const answer = await intake.receive({ sourceId: 'github', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(review('x'))) });
  assert.equal(answer.status, 404, 'a plugin source has no secret, so it is not a path anyone can post to');
});

test('a scheduler built before any source existed takes triggers once a plugin\'s source is attached', async () => {
  const db = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-attach-')), 'fleet.db');
  const schedules = new SqliteScheduleStore(db);
  const events = new SqliteEventStore(db);
  const runtime = createSchedulerRuntime({
    store: schedules,
    dispatch: async () => undefined,
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    hasAgent: () => true,
    log: () => {},
    warn: () => {},
  });
  const create = () => runtime.handle.create({
    agentId: 'atlas',
    cadence: { kind: 'event', source: 'github', filter: parseEventFilter({ exact: { type: 't' } }) },
    prompt: 'p',
  });
  try {
    await assert.rejects(create, /takes no events/);
    runtime.attachEvents({ store: events, sources: () => ['github'] });
    assert.equal((await create()).cadence.kind, 'event');
    assert.throws(() => runtime.attachEvents({ store: events, sources: () => [] }), /already/);
  } finally {
    events.close();
    schedules.close();
  }
});

/** The daemon the e2e runs, with the plugin host and a channel that records its posts. */
const createGatewayFor = (
  env: { homeDir: string; cwd: string; processEnv: Record<string, string> },
  fetchFake: typeof fetch,
  pluginHost: OptionalModuleHost,
  posts: Array<{ to: string; text: string }>,
  logged: string[],
) => createGateway({
    env: { ...env, fetch: fetchFake },
    idleTimeoutMs: 0,
    schedules: { tickMs: 25 },
    plugins: { 'stratus-plugin-polltest': { enabled: true } },
    pluginHost,
    log: (line) => logged.push(line),
    warn: () => {},
    channels: [{
      name: 'slack',
      async start() {},
      async stop() {},
      async resolveOutbound({ to }) {
        return { post: async (text: string) => { posts.push({ to, text }); return { channel: to, ts: '1' }; } };
      },
    }],
  });

test('a plugin\'s event wakes the trigger\'s agent through the daemon, on a daemon with no events config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-events-e2e-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), [
    '---', 'name: Ava', 'provider: openai', 'model: model-a', 'tools:', '  - message.send', '---', '', 'You are Ava.', '',
  ].join('\n'));
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } as Record<string, string> };

  const schedules = new SqliteScheduleStore(fleetDbIn(path.join(home, '.stratus')));
  schedules.insert({
    id: 'trig-codex',
    agentId: 'ava',
    cadence: { kind: 'event', source: 'github', filter: parseEventFilter({ exact: { actor: 'chatgpt-codex-connector[bot]' } }) },
    prompt: 'Codex reviewed your PR. Handle it.',
    destination: { channel: 'slack', to: 'C-ENG' },
    createdAt: new Date().toISOString(),
    trust: 'user',
  });
  schedules.close();

  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-events-pkgs-'));
  const directory = path.join(root, 'poll');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-polltest',
    stratus: { pluginVersion: 1, contributes: { eventSources: [{ name: 'github' }] } },
  }));
  let events: EventIngestHandle | undefined;
  const module = { createPlugin: () => ({ name: 'polltest', setup(context: PluginContext) { events = context.events; } }) };
  const host: OptionalModuleHost = {
    resolve: () => pathToFileURL(path.join(directory, 'dist', 'index.js')).href,
    import: async () => module,
  };

  const prompts: string[] = [];
  let calls = 0;
  const fetchFake = (async (_url: unknown, init?: { body?: unknown }) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
    const user = body.messages.filter((message) => message.role === 'user').map((message) => String(message.content));
    prompts.push(user[user.length - 1] ?? '');
    const first = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'message_send', arguments: JSON.stringify({ destination: { channel: 'slack', to: 'C-ENG' }, text: 'Handled the review on 490.' }) } },
    ] } }] };
    const done = { choices: [{ message: { role: 'assistant', content: 'Done.' } }] };
    return new Response(JSON.stringify(calls % 2 === 1 ? first : done), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const posts: Array<{ to: string; text: string }> = [];
  const logged: string[] = [];
  const gateway = createGatewayFor(env, fetchFake, host, posts, logged);
  await gateway.start();
  try {
    assert.ok(events, 'the daemon handed the plugin an events handle');
    assert.ok(logged.some((line) => line.startsWith('plugin stratus-plugin-polltest loaded') && line.includes('event source github')), logged.join('\n'));
    assert.deepEqual(await events.ingest('github', review('poll-1')), { status: 'matched' });

    const deadline = Date.now() + 5_000;
    while (posts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(posts, [{ to: 'C-ENG', text: 'Handled the review on 490.' }]);
    assert.match(prompts[0] ?? '', /^Codex reviewed your PR\. Handle it\.\n\nEvent from source "github":/);
    assert.deepEqual(await events.ingest('github', review('poll-1')), { status: 'duplicate' });

    const summary = gateway.eventSummary().sources.github;
    assert.equal(summary?.plugin, 'stratus-plugin-polltest');
    assert.deepEqual(summary?.deliveries, { matched: 1, duplicate: 1 });
    assert.equal((await gateway.receiveEvent({ sourceId: 'github', headers: {}, body: Buffer.from('{}') })).status, 404);
  } finally {
    await gateway.stop();
  }
  assert.equal(calls, 2, 'the duplicate started no turn');
  await assert.rejects(() => events!.ingest('github', review('poll-2')), /stopped/);
});
