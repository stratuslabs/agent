import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGateway, type Gateway } from '@stratusagent/gateway';
import { addNamedCredential, type StateEnvironment } from '@stratusagent/state';

import { createEventListener, type EventListener } from '../src/index.ts';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const sign = (id: string, timestamp: string, body: string): string => {
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
};

const signedPost = (id: string, body: string): RequestInit => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': sign(id, timestamp, body),
    },
    body,
  };
};

interface Running {
  env: StateEnvironment;
  gateway: Gateway;
  listener: EventListener;
  url: string;
  stop(): Promise<void>;
}

const start = async (options: { maxBodyBytes?: number; storeSecret?: boolean } = {}): Promise<Running> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-events-listener-'));
  const env: StateEnvironment = { homeDir: home, processEnv: {} };
  if (options.storeSecret !== false) {
    await addNamedCredential(env, { name: 'events.board', value: SECRET });
  }
  const listener = createEventListener({
    port: 0,
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
  });
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    log: () => {},
    warn: () => {},
    channels: [listener],
    events: {
      sources: { board: { verify: 'standard-webhooks', secrets: ['events.board'] } },
      ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    },
  });
  await gateway.start();
  assert.ok(listener.url, 'the listener announced its address');
  return { env, gateway, listener, url: listener.url, stop: () => gateway.stop() };
};

const event = (id: string): string => JSON.stringify({
  specversion: '1.0', id, source: 'https://board.example', type: 'card.moved', subject: 'card/590', data: { to: 'Todo' },
});

test('a signed delivery is answered with what became of it, and the repeat is a duplicate', async () => {
  const running = await start();
  try {
    const first = await fetch(`${running.url}/events/board`, signedPost('ce-1', event('ce-1')));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { status: 'unmatched' });
    const repeat = await fetch(`${running.url}/events/board`, signedPost('ce-1', event('ce-1')));
    assert.deepEqual(await repeat.json(), { status: 'duplicate' });
  } finally {
    await running.stop();
  }
});

test('the events port serves POST /events/<source> and nothing else', async () => {
  const running = await start();
  try {
    const get = await fetch(`${running.url}/events/board`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await fetch(`${running.url}/api/v1/health`)).status, 404, 'the control API is not served here');
    assert.equal((await fetch(`${running.url}/events/board/extra`, { method: 'POST', body: '{}' })).status, 404);
    const unknown = await fetch(`${running.url}/events/nope`, { method: 'POST', body: '{}' });
    assert.equal(unknown.status, 404);
    assert.equal(running.gateway.eventSummary()!.unknownSource, 1);
  } finally {
    await running.stop();
  }
});

test('an unsigned delivery is refused 401 and counted, with no row', async () => {
  const running = await start();
  try {
    const response = await fetch(`${running.url}/events/board`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': 'ce-1', 'webhook-timestamp': '1' },
      body: event('ce-1'),
    });
    assert.equal(response.status, 401);
    assert.equal(running.gateway.eventSummary()!.sources.board!.refusedBeforeRow.badSignature, 1);
  } finally {
    await running.stop();
  }
});

test('a body past the limit is answered 413 without reading the rest, and the connection closes', async () => {
  const running = await start({ maxBodyBytes: 64 });
  try {
    const response = await fetch(`${running.url}/events/board`, signedPost('ce-1', event('ce-1')));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('connection'), 'close');
    assert.equal(running.gateway.eventSummary()!.sources.board!.refusedBeforeRow.tooLarge, 1);
  } finally {
    await running.stop();
  }
});

test('a secret stored while the daemon runs works on the next delivery, with no restart', async () => {
  const running = await start({ storeSecret: false });
  try {
    const before = await fetch(`${running.url}/events/board`, signedPost('ce-1', event('ce-1')));
    assert.equal(before.status, 503);
    assert.match(((await before.json()) as { message: string }).message, /stratus credential set events\.board/);
    await addNamedCredential(running.env, { name: 'events.board', value: SECRET });
    const after = await fetch(`${running.url}/events/board`, signedPost('ce-1', event('ce-1')));
    assert.equal(after.status, 200);
  } finally {
    await running.stop();
  }
});

test('stopping the gateway closes the events port', async () => {
  const running = await start();
  const { url } = running;
  await running.stop();
  assert.equal(running.listener.url, undefined);
  await assert.rejects(fetch(`${url}/events/board`, signedPost('ce-1', event('ce-1'))));
});
