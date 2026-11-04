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
  const gateway = {
    bus,
    activeTurnId: () => active,
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
  return { bus, frames, turn: (id: string | undefined) => { active = id; }, stream };
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
