// An agent with a `front:` block, against a running daemon: its
// conversation turns run on the front model with the front's tools, and the
// background task it starts runs on the agent's own model and tools. The
// Docker and systemd smoke tests (deploy/docker/smoke.sh,
// deploy/systemd/smoke.sh) run it once they have a daemon with this
// directory's plugin enabled and an agent on its scripted `smoke` provider
// whose soul says:
//
//   model: smoke-main
//   tools: [agent.delegate, agent.tasks, smoke.credential]
//   front:
//     model: smoke-front
//
//   SMOKE_TOKEN=<operator token> node scripts/release-smoke/front-agent.mjs <api base> <agent id>
//
// The token comes from the environment, so it is not on a command line.
//
// The smoke provider answers a message holding `SMOKE_WHO` with the model it
// was built for, whether the turn ran as the front, and the tools it was
// offered. So: a message in a conversation must be answered on smoke-front,
// as the front, without smoke.credential (not in the front's set) or
// credential.request (which a front turn never holds); the task
// it starts must run on smoke-main, not as the front, with smoke.credential;
// and the task's outcome, back in the conversation, is answered as the front
// again. No model and no network beyond the daemon.

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const [api, agent] = process.argv.slice(2);
const token = process.env.SMOKE_TOKEN;
const FRONT_MODEL = 'smoke-front';
const MAIN_MODEL = 'smoke-main';
// In the agent's own tools, not in the front's quick set.
const MAIN_ONLY_TOOL = 'smoke.credential';
// Every other turn holds it; a front turn never does.
const NOT_ON_FRONT = [MAIN_ONLY_TOOL, 'credential.request'];
const WAIT_MS = 60_000;

const fail = (message) => {
  console.error(`front-agent smoke: ${message}`);
  process.exit(1);
};

if (!api || !agent || !token) {
  fail('usage: SMOKE_TOKEN=<token> node front-agent.mjs <api base> <agent id>');
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

// `SMOKE_WHO model=<m> front=<yes|no> tools=<a,b>` -> { model, front, tools, line }
const who = (text) => {
  const match = /^SMOKE_WHO model=(\S+) front=(yes|no) tools=(\S*)$/.exec(text);
  return match ? { model: match[1], front: match[2] === 'yes', tools: match[3] ? match[3].split(',') : [], line: text } : undefined;
};

const expectWho = (where, seen, { model, front, has, lacks }) => {
  if (seen.model !== model || seen.front !== front) {
    fail(`${where} ran on ${seen.model} ${seen.front ? 'as' : 'not as'} the front, not on ${model} ${front ? 'as' : 'not as'} the front: ${seen.line}`);
  }
  for (const name of has) {
    if (!seen.tools.includes(name)) {
      fail(`${where} was not offered ${name}: ${seen.line}`);
    }
  }
  for (const name of lacks) {
    if (seen.tools.includes(name)) {
      fail(`${where} was offered ${name}, which the front does not get: ${seen.line}`);
    }
  }
};

console.log(`--- ${agent} lists its front`);
const { agents } = await call('GET', '/agents');
const listed = agents.find((entry) => entry.id === agent);
if (!listed) {
  fail(`${agent} is not on the roster`);
}
if (listed.front?.model !== FRONT_MODEL) {
  fail(`GET /agents shows ${agent}'s front as ${JSON.stringify(listed.front)}, not model ${FRONT_MODEL}`);
}

const origin = `web:${agent}:front-smoke-${randomBytes(6).toString('hex')}`;
console.log(`--- a message from ${origin} is answered by the front`);
await call('POST', `/sessions/${encodeURIComponent(origin)}/messages`, { agentId: agent, message: 'SMOKE_WHO in the conversation' });
const conversation = await until('no answer to the conversation message', async () => {
  const messages = (await session(origin)).messages ?? [];
  const found = messages.map(textOf).map(who).find(Boolean);
  return { value: found, seen: `${messages.length} message(s)` };
});
expectWho('the conversation turn', conversation, {
  model: FRONT_MODEL,
  front: true,
  has: ['agent.delegate', 'agent.tasks'],
  lacks: NOT_ON_FRONT,
});
console.log(`answered on ${conversation.model}, tools ${conversation.tools.join(', ')}`);

console.log('--- the task it starts runs on the agent\'s own model and tools');
await call('POST', `/sessions/${encodeURIComponent(origin)}/messages`, {
  agentId: agent,
  message: JSON.stringify({ tool: 'agent.delegate', input: { agent, prompt: 'SMOKE_WHO in the task', background: true } }),
});
const started = await until('no answer to the agent.delegate call', async () => {
  const messages = (await session(origin)).messages ?? [];
  const line = messages.map(textOf).find((text) => text.startsWith('SMOKE_RESULT '));
  return { value: line === undefined ? undefined : JSON.parse(line.slice('SMOKE_RESULT '.length)), seen: `${messages.length} message(s)` };
});
if (started.tool !== 'agent.delegate' || started.ok !== true) {
  fail(`the front's agent.delegate did not start a task: ${JSON.stringify(started).slice(0, 500)}`);
}
const taskId = JSON.parse(started.text).output?.task;
if (typeof taskId !== 'string' || !taskId.startsWith('t_')) {
  fail(`agent.delegate returned no task id: ${started.text.slice(0, 500)}`);
}

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
const worker = ((await session(task.workerSessionId)).messages ?? []).map(textOf).map(who).find(Boolean);
if (!worker) {
  fail(`the worker session ${task.workerSessionId} did not answer the task's prompt`);
}
expectWho(`the task ${taskId}`, worker, { model: MAIN_MODEL, front: false, has: [MAIN_ONLY_TOOL], lacks: [] });
console.log(`${taskId} ran on ${worker.model}, tools ${worker.tools.join(', ')}`);

console.log('--- its outcome is answered by the front');
const outcome = await until('the conversation did not answer the outcome', async () => {
  const messages = (await session(origin)).messages ?? [];
  const notice = messages.findIndex((message) => message.role === 'user' && textOf(message).startsWith(`[Background task ${taskId} `));
  const answer = notice < 0
    ? undefined
    : messages.slice(notice + 1).find((message) => message.role === 'assistant' && who(textOf(message)));
  return { value: answer && who(textOf(answer)), seen: notice < 0 ? `no notice yet in ${messages.length} message(s)` : 'the notice, no answer yet' };
});
expectWho('the outcome turn', outcome, { model: FRONT_MODEL, front: true, has: ['agent.delegate'], lacks: NOT_ON_FRONT });

console.log(`front agent: ok (${taskId})`);
