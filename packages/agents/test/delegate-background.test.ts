import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry, SESSION_TRUST_METADATA_KEY, type AgentDefinition, type JsonObject, type Session } from '@stratusagent/core';

import {
  createDelegateTool,
  TASK_ID_METADATA_KEY,
  type DelegateBackgroundStart,
} from '../src/index.ts';

/**
 * AGT-356 (AGT-211 phase 1): `agent.delegate` with `background: true` hands
 * the start to the host and returns a task id at once, instead of waiting
 * for the worker's reply. The host owns the task table, the worker's abort
 * handle and delivering the outcome; the tool owns who may start what.
 */

const ATLAS: AgentDefinition = { id: 'atlas', name: 'Atlas', delegates: ['blair'] };
const BLAIR: AgentDefinition = { id: 'blair', name: 'Blair' };
const QUINN: AgentDefinition = { id: 'quinn', name: 'Quinn' };

const registry = (): AgentRegistry => {
  const agents = new AgentRegistry();
  for (const agent of [ATLAS, BLAIR, QUINN]) {
    agents.register(agent);
  }
  return agents;
};

const sessionOf = (agent: AgentDefinition, id = 'slack:C1:1700.1', metadata?: JsonObject): Session => ({
  id,
  agent,
  status: 'running',
  messages: [],
  createdAt: '',
  updatedAt: '',
  ...(metadata ? { metadata } : {}),
});

type StartInput = Parameters<DelegateBackgroundStart>[0];

const recordingHost = (result: Awaited<ReturnType<DelegateBackgroundStart>> = { task: 't_01TEST', status: 'running' }) => {
  const starts: StartInput[] = [];
  const background: DelegateBackgroundStart = async (input) => {
    starts.push(input);
    return result;
  };
  return { starts, background };
};

const refuseForeground = async (): Promise<Session> => {
  throw new Error('a background start must not run the worker in the foreground');
};

test('background: true hands the start to the host and returns the task id at once', async () => {
  const { starts, background } = recordingHost();
  const tool = createDelegateTool({ registry: registry(), dispatch: refuseForeground, background });
  const origin = sessionOf(ATLAS, 'slack:C1:1700.1', { [SESSION_TRUST_METADATA_KEY]: 'external' });

  const result = await tool.execute({ agent: 'Blair', prompt: '  get #512 merged  ', background: true }, origin) as JsonObject;

  assert.equal(result.task, 't_01TEST');
  assert.equal(result.status, 'running');
  assert.equal(result.agent, 'Blair');
  assert.match(String(result.note), /new message in this conversation/);
  assert.equal(result.existing, undefined);

  assert.equal(starts.length, 1);
  const [start] = starts;
  assert.equal(start!.origin, origin);
  assert.equal(start!.agent.id, 'blair');
  assert.equal(start!.prompt, 'get #512 merged');
  // The worker is named the way a foreground delegation names one, with
  // the task id as the suffix, so every existing delegated-session check
  // (approval routing, an older build's sweeps) applies to it unchanged.
  assert.equal(start!.workerSessionId('t_01ABC'), 'slack:C1:1700.1:delegate:blair:1:t_01ABC');
  assert.deepEqual(start!.metadata, {
    delegationDepth: 1,
    delegatedBy: 'atlas',
    rootSessionId: 'slack:C1:1700.1',
    // The prompt is the origin's text, at the origin's label.
    senderTrust: 'external',
  });
});

test('a background task may be the caller itself, without listing itself in delegates', async () => {
  const { starts, background } = recordingHost();
  const tool = createDelegateTool({ registry: registry(), dispatch: refuseForeground, background });

  const result = await tool.execute({ agent: 'atlas', prompt: 'review #512', background: true }, sessionOf(ATLAS)) as JsonObject;

  assert.equal(result.task, 't_01TEST');
  assert.equal(starts[0]!.agent.id, 'atlas');
  assert.equal(starts[0]!.workerSessionId('t_1'), 'slack:C1:1700.1:delegate:atlas:1:t_1');

  // In the foreground it is still refused, and the refusal points at the
  // mode that allows it.
  await assert.rejects(
    () => tool.execute({ agent: 'atlas', prompt: 'review #512' }, sessionOf(ATLAS)),
    /cannot delegate to itself.*background: true/s,
  );
});

test('another agent still has to be on the delegates list in background mode', async () => {
  const { starts, background } = recordingHost();
  const tool = createDelegateTool({ registry: registry(), dispatch: refuseForeground, background });

  await assert.rejects(
    () => tool.execute({ agent: 'quinn', prompt: 'deploy', background: true }, sessionOf(ATLAS)),
    /Agent atlas may not delegate to quinn/,
  );
  assert.equal(starts.length, 0);
});

test('a delegated session, a task worker included, cannot start background tasks', async () => {
  const { starts, background } = recordingHost();
  const tool = createDelegateTool({ registry: registry(), dispatch: refuseForeground, background });

  const worker = sessionOf(ATLAS, 'slack:C1:1700.1:delegate:atlas:1:t_01PARENT', {
    delegationDepth: 1,
    delegatedBy: 'atlas',
    rootSessionId: 'slack:C1:1700.1',
    [TASK_ID_METADATA_KEY]: 't_01PARENT',
  });
  await assert.rejects(
    () => tool.execute({ agent: 'blair', prompt: 'fan out', background: true }, worker),
    /can't start background tasks/,
  );

  const delegated = sessionOf(ATLAS, 'cli-1:delegate:atlas:1:0-abc', {
    delegationDepth: 1,
    delegatedBy: 'quinn',
    rootSessionId: 'cli-1',
  });
  await assert.rejects(
    () => tool.execute({ agent: 'blair', prompt: 'fan out', background: true }, delegated),
    /can't start background tasks/,
  );

  // The task id key alone is enough: only the host writes it.
  const marked = sessionOf(ATLAS, 'cli-2', { [TASK_ID_METADATA_KEY]: 't_01X' });
  await assert.rejects(
    () => tool.execute({ agent: 'blair', prompt: 'fan out', background: true }, marked),
    /can't start background tasks/,
  );
  assert.equal(starts.length, 0);
});

test('the same job already running comes back as that task', async () => {
  const { background } = recordingHost({ task: 't_01SAME', status: 'waiting_approval', existing: true });
  const tool = createDelegateTool({ registry: registry(), dispatch: refuseForeground, background });

  const result = await tool.execute({ agent: 'blair', prompt: 'get #512 merged', background: true }, sessionOf(ATLAS)) as JsonObject;

  assert.equal(result.task, 't_01SAME');
  assert.equal(result.status, 'waiting_approval');
  assert.equal(result.existing, true);
  assert.match(String(result.note), /already running/);
});

test("the host's refusal reaches the agent as the tool's error", async () => {
  const tool = createDelegateTool({
    registry: registry(),
    dispatch: refuseForeground,
    background: async () => {
      throw new Error('atlas already has 3 background tasks running, the most it may.');
    },
  });

  await assert.rejects(
    () => tool.execute({ agent: 'blair', prompt: 'one more', background: true }, sessionOf(ATLAS)),
    /already has 3 background tasks running/,
  );
});

test('without a host that runs background tasks, background: true is refused, never run in the foreground', async () => {
  let foreground = 0;
  const tool = createDelegateTool({
    registry: registry(),
    dispatch: async (input) => {
      foreground += 1;
      return { ...sessionOf(input.agent, input.sessionId), status: 'completed', messages: [] };
    },
  });

  await assert.rejects(
    () => tool.execute({ agent: 'blair', prompt: 'long job', background: true }, sessionOf(ATLAS)),
    /isn't available here/,
  );
  assert.equal(foreground, 0);

  // The schema offers it only where it works.
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal(properties.background, undefined);
  const withHost = createDelegateTool({ registry: registry(), dispatch: refuseForeground, background: recordingHost().background });
  assert.equal((withHost.parameters as { properties: Record<string, { type: string }> }).properties.background?.type, 'boolean');
  assert.match(withHost.description ?? '', /background/);

  // background: false is the foreground, as it is when left out.
  await tool.execute({ agent: 'blair', prompt: 'short job', background: false }, sessionOf(ATLAS));
  assert.equal(foreground, 1);
});

test('background must be a boolean', async () => {
  const { starts, background } = recordingHost();
  let foreground = 0;
  const tool = createDelegateTool({
    registry: registry(),
    dispatch: async (input) => {
      foreground += 1;
      return { ...sessionOf(input.agent, input.sessionId), status: 'completed', messages: [] };
    },
    background,
  });

  for (const value of ['true', 1, null]) {
    await assert.rejects(
      () => tool.execute({ agent: 'blair', prompt: 'job', background: value }, sessionOf(ATLAS)),
      /"background" must be true or false/,
    );
  }
  assert.equal(starts.length, 0);
  assert.equal(foreground, 0);
});
