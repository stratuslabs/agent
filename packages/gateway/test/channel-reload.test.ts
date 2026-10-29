import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGateway, type Gateway, type GatewayChannelAdapter } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-channel-reload-'));

const writeSoul = async (home: string, id: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.md`), `---\nname: ${id}\nid: ${id}\n---\n\nYou are ${id}.\n`);
};

interface Recorded {
  adapter: GatewayChannelAdapter;
  reloads: string[][];
}

/** A channel that records the roster it saw on each reload. */
const reloading = (name: string, reload?: () => Promise<void>): Recorded => {
  let gatewayRef: Gateway | undefined;
  const reloads: string[][] = [];
  return {
    reloads,
    adapter: {
      name,
      async start(gateway) {
        gatewayRef = gateway;
      },
      async stop() {
        gatewayRef = undefined;
      },
      async reload() {
        reloads.push(gatewayRef ? gatewayRef.agents().map((agent) => agent.id).sort() : []);
        await reload?.();
      },
    },
  };
};

const gatewayWith = async (
  t: { after(fn: () => Promise<void>): void },
  channels: GatewayChannelAdapter[],
  extra: { channelReloadTimeoutMs?: number } = {},
) => {
  const home = await newHome();
  await writeSoul(home, 'ava');
  const warnings: string[] = [];
  const logs: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    channels,
    ...extra,
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
  });
  await gateway.start();
  // A failed assertion must not leave the gateway's timers holding the run open.
  t.after(() => gateway.stop());
  return { gateway, home, warnings, logs };
};

test('a roster reload reloads every started channel that can, after the new roster is in place', async (t) => {
  const first = reloading('first');
  const second = reloading('second');
  const plain: GatewayChannelAdapter = { name: 'plain', async start() {}, async stop() {} };
  const { gateway, home } = await gatewayWith(t, [first.adapter, plain, second.adapter]);
  assert.deepEqual(first.reloads, [], 'starting is not a reload');

  await writeSoul(home, 'bea');
  await gateway.reloadRoster();

  assert.deepEqual(first.reloads, [['ava', 'bea', 'stratus']]);
  assert.deepEqual(second.reloads, [['ava', 'bea', 'stratus']]);
});

test('one channel that fails to reload is logged, and the roster and the other channels still reload', async (t) => {
  const broken = reloading('broken', async () => {
    throw new Error('the token file is unreadable');
  });
  const healthy = reloading('healthy');
  const { gateway, home, warnings } = await gatewayWith(t, [broken.adapter, healthy.adapter]);

  await writeSoul(home, 'bea');
  const roster = await gateway.reloadRoster();

  assert.deepEqual(roster.map((agent) => agent.id).sort(), ['ava', 'bea', 'stratus']);
  assert.equal(healthy.reloads.length, 1);
  assert.ok(warnings.some((line) => line.includes('channel broken could not reload') && line.includes('the token file is unreadable')), warnings.join('\n'));
});

test('a channel whose reload hangs holds the roster reload only for the bound, and the next reload still runs', async (t) => {
  let release: () => void = () => {};
  let calls = 0;
  const stuck = reloading('stuck', () => {
    calls += 1;
    return calls === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  });
  const after = reloading('after');
  const { gateway, warnings, logs } = await gatewayWith(t, [stuck.adapter, after.adapter], { channelReloadTimeoutMs: 50 });

  const started = Date.now();
  await gateway.reloadRoster();
  assert.ok(Date.now() - started < 2_000);
  assert.equal(after.reloads.length, 1, 'the channel after the stuck one is still reloaded');
  assert.ok(warnings.some((line) => line.includes('channel stuck is still reloading after 50 ms')), warnings.join('\n'));

  await gateway.reloadRoster();
  assert.equal(stuck.reloads.length, 2);
  assert.equal(after.reloads.length, 2);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((line) => line.includes('channel stuck finished reloading')), logs.join('\n'));
});

test('a reload that rejects after the bound is reported, not left unhandled', async (t) => {
  let fail: (error: Error) => void = () => {};
  const late = reloading('late', () => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const { gateway, warnings } = await gatewayWith(t, [late.adapter], { channelReloadTimeoutMs: 20 });

  await gateway.reloadRoster();
  fail(new Error('auth.test timed out'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(warnings.some((line) => line.includes('channel late could not reload') && line.includes('auth.test timed out')), warnings.join('\n'));
});

test('a roster that fails to load reloads no channel', async (t) => {
  const channel = reloading('slack');
  const { gateway, home } = await gatewayWith(t, [channel.adapter]);
  // A soul file with an id another soul already uses refuses the roster.
  await writeFile(path.join(home, '.stratus', 'agents', 'copy.md'), '---\nname: copy\nid: ava\n---\n\nAgain.\n');

  await assert.rejects(gateway.reloadRoster());
  assert.deepEqual(channel.reloads, []);
});

test('after a stop, a roster reload asks no channel to reload', async (t) => {
  const channel = reloading('slack');
  const { gateway } = await gatewayWith(t, [channel.adapter]);
  await gateway.stop();

  await gateway.reloadRoster().catch(() => undefined);
  assert.deepEqual(channel.reloads, []);
});
