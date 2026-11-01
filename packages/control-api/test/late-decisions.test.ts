import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus, type StratusEvent } from '@stratusagent/core';
import type { Gateway } from '@stratusagent/gateway';
import type { WebSocket } from 'ws';

import { createEventStream, type EventEnvelope } from '../src/events.ts';

// Card 992 (from #537's review): a decision worked out off the call path
// (the review posture's shadow mode) can arrive after its turn has ended.
// It is stamped with the turn its call ran in, not whatever runs now.

const harness = () => {
  const bus = new EventBus();
  let active: string | undefined;
  const sideRuns = new Set<string>();
  const gateway = {
    bus,
    activeTurnId: () => active,
    isSideRun: (sessionId: string) => sideRuns.has(sessionId),
    store: { list: () => [] },
  } as unknown as Gateway;
  const stream = createEventStream(gateway);
  const frames: EventEnvelope[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data: string) => {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.event !== undefined) {
        frames.push(frame as unknown as EventEnvelope);
      }
    },
    on: () => undefined,
    close: () => undefined,
  } as unknown as WebSocket;
  stream.attach(socket, {});
  return { bus, frames, sideRuns, turn: (id: string | undefined) => { active = id; }, stream };
};

const called = (callId: string): StratusEvent => ({
  type: 'tool.called',
  sessionId: 's1',
  call: { id: callId, toolName: 'notes.add', input: {} },
});

const decided = (callId: string, shadow: boolean): StratusEvent => ({
  type: 'permission.decided',
  sessionId: 's1',
  agentId: 'ava',
  callId,
  toolName: 'notes.add',
  risk: 'gated',
  allowed: !shadow,
  layer: shadow ? 'review' : 'risk',
  reason: 'r',
  ...(shadow ? { verdict: 'block' as const, reviewCode: 'not-asked-for', shadow: true } : {}),
});

test('a shadow decision that arrives after its turn is stamped with the turn its call ran in', async () => {
  const { bus, frames, turn, stream } = harness();
  try {
    turn('turn-A');
    await bus.emit(decided('call-1', false));
    await bus.emit(called('call-1'));
    turn('turn-B');
    await bus.emit(decided('call-1', true));
    assert.equal(frames.at(-1)?.turnId, 'turn-A', 'the late shadow decision belongs to turn A');

    // Not a shadow decision: stamped as before, with what runs now.
    await bus.emit(decided('call-9', false));
    assert.equal(frames.at(-1)?.turnId, 'turn-B');

    // A call id the endpoint reused in turn B: the latest call wins.
    await bus.emit(called('call-1'));
    await bus.emit(decided('call-1', true));
    assert.equal(frames.at(-1)?.turnId, 'turn-B');

    // A shadow decision for a call never seen goes with what runs now.
    turn(undefined);
    await bus.emit(decided('call-unknown', true));
    assert.equal(frames.at(-1)?.turnId, undefined);
  } finally {
    stream.close();
  }
});

test('a side run\'s events never reach the stream, and the conversation\'s still do', async () => {
  const { bus, frames, sideRuns, stream } = harness();
  const forAva: EventEnvelope[] = [];
  const forBo: EventEnvelope[] = [];
  for (const [agentId, into] of [['ava', forAva], ['bo', forBo]] as const) {
    stream.attach({
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: (data: string) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.event !== undefined) {
          into.push(frame as unknown as EventEnvelope);
        }
      },
      on: () => undefined,
      close: () => undefined,
    } as unknown as WebSocket, { agentId });
  }
  sideRuns.add('review:1');
  await bus.emit({ type: 'session.created', sessionId: 'review:1', agentId: 'ava' });
  await bus.emit({ type: 'provider.delta', sessionId: 'review:1', delta: { type: 'text', text: '{"verdict":"allow"' } } as StratusEvent);
  // What it cost still comes through, counts only.
  await bus.emit({ type: 'session.usage', sessionId: 'review:1', agentId: 'ava', records: [] });
  await bus.emit({ type: 'session.completed', sessionId: 'review:1' } as StratusEvent);
  await bus.emit({ type: 'session.created', sessionId: 's1', agentId: 'ava' });
  sideRuns.delete('review:1');
  // Known by the run, not the id: a conversation that happens to be named
  // like one is still shown.
  await bus.emit({ type: 'session.created', sessionId: 'review:mine', agentId: 'ava' });
  assert.deepEqual(frames.map((frame) => `${frame.sessionId} ${frame.event.type}`), [
    'review:1 session.usage',
    's1 session.created',
    'review:mine session.created',
  ]);
  // An agent's subscriber gets its side runs' usage, and only its own.
  assert.deepEqual(forAva.map((frame) => `${frame.sessionId} ${frame.event.type}`), [
    'review:1 session.usage',
    's1 session.created',
    'review:mine session.created',
  ]);
  assert.deepEqual(forBo, []);
});
