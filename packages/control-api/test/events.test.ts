import test from 'node:test';
import assert from 'node:assert/strict';

import type { StratusEvent } from '@stratusagent/core';

import { newHome, openSocket, settles, startApi, writeSoul, type SocketClient } from './harness.ts';

interface Envelope extends Record<string, unknown> {
  sessionId: string;
  turnId?: string;
  event: StratusEvent;
}

const isEnvelopeOf = (type: StratusEvent['type']) =>
  (frame: Record<string, unknown>): boolean =>
    (frame.event as StratusEvent | undefined)?.type === type;

const connect = async (
  harness: Awaited<ReturnType<typeof startApi>>,
  query = '',
): Promise<SocketClient> => {
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events${query}`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  assert.equal(client.opened, true, 'the event stream accepted a bearer upgrade');
  // The ack confirms what the server thinks it subscribed to, so a client
  // never has to guess whether its filter took effect.
  await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');
  return client;
};

const send = (harness: Awaited<ReturnType<typeof startApi>>, sessionId: string, agentId: string, message: string) =>
  harness.call(`/api/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, agentId }),
  });

test('events arrive as envelopes stamped with the turn that caused them', async () => {
  const harness = await startApi();
  const client = await connect(harness);
  try {
    const response = await send(harness, 's-live', 'stratus', 'hello');
    const { turnId } = await response.json() as { turnId: string };

    const envelope = await client.waitFor<Envelope>(isEnvelopeOf('session.completed'), 'the completion frame');
    assert.equal(envelope.sessionId, 's-live');
    // The whole point of the envelope: a session processes several messages
    // in sequence and `StratusEvent` carries no turn identifier, so this is
    // the only thing tying an event back to the request that caused it.
    assert.equal(envelope.turnId, turnId);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a session filter delivers only that conversation', async () => {
  const harness = await startApi();
  const client = await connect(harness, '?session=wanted');
  try {
    // Started first, so an unfiltered stream would have delivered plenty of
    // its frames before the wanted conversation even begins.
    await send(harness, 'ignored', 'stratus', 'not for you');
    await send(harness, 'wanted', 'stratus', 'hello');

    await client.waitFor<Envelope>(
      (frame) => isEnvelopeOf('session.completed')(frame) && (frame as Envelope).sessionId === 'wanted',
      'the wanted conversation completing',
    );

    const delivered = client.frames.filter((frame) => frame.event !== undefined) as Envelope[];
    assert.ok(delivered.length > 0, 'the wanted conversation was delivered');
    assert.ok(
      delivered.every((frame) => frame.sessionId === 'wanted'),
      `another conversation leaked: ${JSON.stringify(delivered.map((frame) => frame.sessionId))}`,
    );
  } finally {
    client.close();
    await harness.stop();
  }
});

test('an agent filter follows sessions created after the subscription', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  const client = await connect(harness, '?agent=ava');
  try {
    await send(harness, 'stratus-1', 'stratus', 'other agent');
    // This session does not exist at subscribe time, so it can only be
    // matched by following `session.created` — which is why the filter is not
    // simply a snapshot of the store.
    await send(harness, 'ava-1', 'ava', 'hello');

    await client.waitFor<Envelope>(
      (frame) => isEnvelopeOf('session.completed')(frame) && (frame as Envelope).sessionId === 'ava-1',
      "Ava's conversation completing",
    );

    const delivered = client.frames.filter((frame) => frame.event !== undefined) as Envelope[];
    assert.ok(
      delivered.every((frame) => frame.sessionId === 'ava-1'),
      `another agent's session leaked: ${JSON.stringify(delivered.map((frame) => frame.sessionId))}`,
    );
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a subscribe frame re-filters a live connection', async () => {
  const harness = await startApi();
  const client = await connect(harness);
  try {
    client.socket.send(JSON.stringify({ type: 'subscribe', sessionId: 'only-this' }));
    const acked = await client.waitFor<{ filter: { sessionId?: string } }>(
      (frame) => frame.type === 'subscribed',
      'the re-subscribe ack',
    );
    assert.deepEqual(acked.filter, { sessionId: 'only-this' });

    client.socket.send(JSON.stringify({ type: 'nonsense' }));
    const rejected = await client.waitFor<{ message: string }>(
      (frame) => frame.type === 'error',
      'the error frame',
    );
    assert.match(rejected.message, /Unknown frame type/);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('an approval raised anywhere reaches the stream, and resolving it there settles the turn', async () => {
  const harness = await startApi({ approvals: true });
  const transport = harness.transport;
  assert.ok(transport, 'the harness captured the approval transport');
  const client = await connect(harness);
  try {
    // Raised through the gateway's own transport — the same path a
    // Slack-hosted turn parks through. One event stream serves both surfaces,
    // which is what makes resolving in either place work.
    const answer = transport.request({
      session: {
        id: 'sess-both',
        agent: { id: 'stratus', name: 'Stratus' },
        status: 'running',
        messages: [],
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
      call: { id: 'call-1', toolName: 'shell.run', input: { command: 'ls' } },
      risk: 'gated',
    });

    const announced = await client.waitFor<Envelope>(
      isEnvelopeOf('tool.approval-requested'),
      'the approval announcement',
    );
    const requested = announced.event;
    assert.equal(requested.type, 'tool.approval-requested');
    const requestId = requested.type === 'tool.approval-requested' ? requested.requestId : '';

    const resolved = await harness.call('/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, answer: 'once', actor: 'web' }),
    });
    assert.equal(resolved.status, 200);
    assert.equal(await settles(answer, 'the parked call'), 'once');

    const resolution = (await client.waitFor<Envelope>(
      isEnvelopeOf('tool.approval-resolved'),
      'the resolution frame',
    )).event;
    assert.equal(resolution.type === 'tool.approval-resolved' ? resolution.answer : undefined, 'once');
    assert.equal(resolution.type === 'tool.approval-resolved' ? resolution.actor : undefined, 'web');
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a dispatch that fails before the runner starts still reports on the stream', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  const client = await connect(harness);
  try {
    // The soul file now declares a different agent, so the gateway refuses
    // the dispatch rather than running one identity's session on another's
    // provider pins. That refusal happens before the runner touches durable
    // state — nothing else would ever tell the caller.
    await writeSoul(home, 'ava.md', '---\nname: Someone Else\nid: someone-else\n---\n\nNot Ava.\n');
    const accepted = await send(harness, 'doomed', 'ava', 'hello');
    assert.equal(accepted.status, 202);

    const envelope = await client.waitFor<Envelope>(isEnvelopeOf('session.failed'), 'the failure frame');
    assert.equal(envelope.sessionId, 'doomed');
    assert.match(
      envelope.event.type === 'session.failed' ? envelope.event.error : '',
      /refusing the dispatch/,
    );
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a preflight failure is stamped with its own turn, not whatever is running now', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  const client = await connect(harness);
  try {
    // Two messages can be queued on one session, and the chain can start the
    // second turn before the first one's rejection handler emits. Standing in
    // for that ordering, because a real one would be a race to stage: the
    // gateway reports a different turn as active than the one whose failure
    // the route is emitting.
    harness.gateway.activeTurnId = () => 'a-turn-that-is-running-now';

    await writeSoul(home, 'ava.md', '---\nname: Someone Else\nid: someone-else\n---\n\nNot Ava.\n');
    const accepted = await send(harness, 'doomed', 'ava', 'hello');
    assert.equal(accepted.status, 202);
    const { turnId } = await accepted.json() as { turnId: string };

    const envelope = await client.waitFor<Envelope>(isEnvelopeOf('session.failed'), 'the failure frame');
    // Stamped with the other turn, this failure kills a turn that was fine
    // while the client waiting on this one never hears anything at all.
    assert.equal(
      envelope.turnId,
      turnId,
      'the failure belongs to the turn that was rejected, whatever else is running',
    );
  } finally {
    client.close();
    await harness.stop();
  }
});
