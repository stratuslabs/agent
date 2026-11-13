// One background task, start to finish, against a running daemon. The Docker
// and systemd smoke tests (deploy/docker/smoke.sh, deploy/systemd/smoke.sh)
// run it once they have a daemon with this directory's plugin enabled and an
// agent on its scripted `smoke` provider, holding agent.delegate:
//
//   SMOKE_TOKEN=<operator token> node scripts/release-smoke/background-task.mjs <api base> <agent id>
//
// The token comes from the environment, so it is not on a command line.
//
// The agent's turn calls agent.delegate with background: true on itself. It
// must come back with a task id while the worker is still on its prompt
// (held 3 seconds by `SMOKE_WAIT`); then, with no one waiting on it,
// the worker's turn runs, the task ends `completed`, its outcome is
// `delivered` to the conversation that started it, and that conversation
// answers it in a new turn. No model and no network beyond the daemon.

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const [api, agent] = process.argv.slice(2);
const token = process.env.SMOKE_TOKEN;
// The worker answers 3 seconds late, so the start has to come back first.
const PROMPT = 'SMOKE_WAIT 3000 Background smoke task.';
const WAIT_MS = 60_000;

const fail = (message) => {
  console.error(`background-task smoke: ${message}`);
  process.exit(1);
};

if (!api || !agent || !token) {
  fail('usage: SMOKE_TOKEN=<token> node background-task.mjs <api base> <agent id>');
}

const call = async (method, route, body) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : undefined;
};

const textOf = (message) => (typeof message?.content === 'string' ? message.content : '');

// Polls `read` until it returns something, or fails naming what it last saw.
const until = async (what, read) => {
  const deadline = Date.now() + WAIT_MS;
  let last = 'nothing read yet';
  while (Date.now() < deadline) {
    try {
      const { value, seen } = await read();
      if (value !== undefined) {
        return value;
      }
      last = seen;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  fail(`${what} within ${WAIT_MS / 1000} seconds (last read: ${String(last).slice(0, 500)})`);
};

const session = async (id) => (await call('GET', `/sessions/${encodeURIComponent(id)}`)).session;

const origin = `web:${agent}:task-smoke-${randomBytes(6).toString('hex')}`;
console.log(`--- ${agent} starts a background task from ${origin}`);
await call('POST', `/sessions/${encodeURIComponent(origin)}/messages`, {
  agentId: agent,
  message: JSON.stringify({ tool: 'agent.delegate', input: { agent, prompt: PROMPT, background: true } }),
});

// The smoke provider answers a tool's result with one `SMOKE_RESULT <json>` line.
const started = await until('no answer to the agent.delegate call', async () => {
  const messages = (await session(origin)).messages ?? [];
  const line = messages.map(textOf).find((text) => text.startsWith('SMOKE_RESULT '));
  return { value: line === undefined ? undefined : JSON.parse(line.slice('SMOKE_RESULT '.length)), seen: `${messages.length} message(s)` };
});
if (started.tool !== 'agent.delegate' || started.ok !== true) {
  fail(`agent.delegate did not start a task: ${JSON.stringify(started).slice(0, 500)}`);
}
const { output } = JSON.parse(started.text);
const taskId = output?.task;
if (typeof taskId !== 'string' || !taskId.startsWith('t_')) {
  fail(`agent.delegate returned no task id: ${started.text.slice(0, 500)}`);
}
if (output.status !== 'running') {
  fail(`agent.delegate returned ${taskId} as ${output.status}, not running`);
}
// Read right after the start's answer, inside the worker's 3-second hold:
// a start that waited for the worker would find it finished.
const { tasks: atStart } = await call('GET', `/tasks?agent=${encodeURIComponent(agent)}`);
const rowAtStart = atStart.find((entry) => entry.id === taskId);
if (rowAtStart?.status !== 'running') {
  fail(`${taskId} was ${rowAtStart?.status ?? 'not listed'} when the start answered, not running: the start waited for the work`);
}
console.log(`started ${taskId}, still running when agent.delegate answered`);

console.log('--- it ends completed, and its outcome is delivered');
const task = await until(`${taskId} did not end completed and delivered`, async () => {
  const { tasks } = await call('GET', `/tasks?agent=${encodeURIComponent(agent)}`);
  const row = tasks.find((entry) => entry.id === taskId);
  if (row && ['failed', 'cancelled', 'interrupted'].includes(row.status)) {
    fail(`${taskId} ended ${row.status}: ${JSON.stringify(row)}`);
  }
  return {
    value: row?.status === 'completed' && row.delivery === 'delivered' ? row : undefined,
    seen: row ? `status ${row.status}, delivery ${row.delivery}` : `${taskId} is not listed`,
  };
});
if (task.originSessionId !== origin) {
  fail(`${taskId} names ${task.originSessionId} as its conversation, not ${origin}`);
}

const worker = await session(task.workerSessionId);
if (!(worker.messages ?? []).some((message) => textOf(message) === `SMOKE_TEXT ${PROMPT}`)) {
  fail(`the worker session ${task.workerSessionId} did not answer the task's prompt`);
}

console.log('--- the conversation that started it answers the outcome, once');
const answers = await until('the conversation did not answer the outcome', async () => {
  const messages = (await session(origin)).messages ?? [];
  const replies = messages.map(textOf).filter((text) => text.startsWith(`SMOKE_TEXT [Background task ${taskId} `));
  return { value: replies.length > 0 ? replies : undefined, seen: `${messages.length} message(s)` };
});
// A second notice would land right behind the first: look again a moment later.
await sleep(2_000);
const again = ((await session(origin)).messages ?? []).map(textOf)
  .filter((text) => text.startsWith(`SMOKE_TEXT [Background task ${taskId} `));
if (answers.length !== 1 || again.length !== 1) {
  fail(`the outcome was answered ${Math.max(answers.length, again.length)} times, not once`);
}
if (!answers[0].includes(' completed ')) {
  fail(`the outcome does not say completed: ${answers[0].slice(0, 300)}`);
}

console.log(`background task: ok (${taskId})`);
