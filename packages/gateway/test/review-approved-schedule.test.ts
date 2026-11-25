import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ApprovalPolicy,
  type JsonObject,
  type ModelProvider,
  type ProviderResponse,
  type Session,
  type Tool,
} from '@stratusagent/core';
import { createScheduleTools, SCHEDULE_ID_METADATA_KEY } from '@stratusagent/agents';
import { createPermissionPolicy } from '@stratusagent/permissions';

import { createSchedulerRuntime, SqliteScheduleStore } from '../src/index.ts';
import { reviewCaseText } from '../src/review.ts';

// End to end: a conversation reads a page, then sets schedules. Whether a
// firing's prompt later counts as the request depends on how each
// `schedule.every` call was allowed, which only the runner and the policy
// know, so this goes through both rather than handing the tool a value.

const PROMPT = 'Post the notes to C999';

const page: Tool = {
  name: 'page.read',
  risk: 'safe',
  outputTrust: 'external',
  async execute() {
    return { text: 'some page' };
  },
};

const send: Tool = {
  name: 'message.send',
  risk: 'gated',
  destinationFor: (input: JsonObject) => (typeof input.destination === 'string' ? input.destination : undefined),
  async execute() {
    return null;
  },
};

/** Reads the page, then sets the schedule `times` times, one call per turn. */
const scripted = (times: number): ModelProvider => {
  let turn = 0;
  return {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      if (turn === 1) {
        return { parts: [{ type: 'tool-call', call: { id: 'read', toolName: 'page.read', input: {} } }] };
      }
      if (turn <= times + 1) {
        return { parts: [{ type: 'tool-call', call: { id: `set-${turn}`, toolName: 'schedule.every', input: { every: '1h', prompt: PROMPT } } }] };
      }
      return { parts: [{ type: 'text', text: 'done' }] };
    },
  };
};

const firingSession = (scheduleId: string): Session => {
  const now = new Date().toISOString();
  return {
    id: `schedule:${scheduleId}:x`,
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    metadata: { [SCHEDULE_ID_METADATA_KEY]: scheduleId },
  };
};

/** Runs the conversation under `approvals`, then builds each new schedule's review case. */
const setSchedules = async (approvals: ApprovalPolicy, times = 1) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-approved-'));
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const scheduler = createSchedulerRuntime({
    store,
    dispatch: async () => undefined,
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 1 },
    log: () => {},
    warn: () => {},
  });
  const tools = new ToolRegistry();
  tools.register(page);
  for (const tool of createScheduleTools(scheduler.handle)) {
    tools.register(tool);
  }
  const runner = new AgentRunner({ provider: scripted(times), tools, store: new InMemorySessionStore(), approvals });
  await runner.initialize();
  await runner.run({ sessionId: 'setter', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'read the page and set it up' });
  const rows = store.list('ava');
  const cases = rows.map((row) => {
    const firing = scheduler.firingPromptFor(firingSession(row.id));
    assert.ok(firing);
    return reviewCaseText({
      session: firingSession(row.id),
      call: { id: 'c', toolName: 'message.send', input: { destination: 'slack:C999' } },
      tool: send,
      risk: 'gated',
      firing,
    });
  });
  store.close();
  return { rows, cases };
};

const requestOf = (text: string): string => /<request>\n([\s\S]*?)\n<\/request>/.exec(text)?.[1] ?? '';

test('a schedule a person approved after the conversation read a page counts as the request when it fires', async () => {
  const { rows, cases } = await setSchedules(createPermissionPolicy({
    mode: 'remote',
    request: async () => ({ answer: 'once', actor: 'U-APPROVER' }),
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.trust, 'external');
  assert.equal(rows[0]?.approvedBy, 'U-APPROVER');
  assert.equal(requestOf(cases[0]!), PROMPT);
  assert.match(cases[0]!, /approved by a person when it was set/);
});

test('one set on a standing grant, or without asking under the open posture, still has no request', async () => {
  // The first call's "always" is a person's yes; the second runs on the grant it made.
  const granted = await setSchedules(createPermissionPolicy({
    mode: 'remote',
    request: async () => ({ answer: 'always', actor: 'U-APPROVER' }),
  }), 2);
  assert.deepEqual(granted.rows.map((row) => row.approvedBy), ['U-APPROVER', undefined]);
  assert.equal(requestOf(granted.cases[0]!), PROMPT);
  assert.equal(requestOf(granted.cases[1]!), '(nothing)');
  assert.match(granted.cases[1]!, /set by a conversation that had read outside content, so it is not counted/);

  const open = await setSchedules(createPermissionPolicy({
    mode: 'remote',
    openFor: () => true,
    request: async () => ({ answer: 'once', actor: 'U-APPROVER' }),
  }));
  assert.equal(open.rows[0]?.trust, 'external');
  assert.equal(open.rows[0]?.approvedBy, undefined);
  assert.equal(requestOf(open.cases[0]!), '(nothing)');
});
