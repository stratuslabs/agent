import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { crash, startDaemon, stop, waitFor, type Daemon } from './serve-daemon.ts';

// Isolation as one daemon serves it. The stores are already checked
// structurally (gateway sessions.test.ts, state memory.test.ts): one file
// per agent, no row of another's to filter. What those can't see is the
// running process: two agents and several conversations in flight at once,
// sharing one provider registry, one approval queue and one grant table.
// Here a real `stratus serve` carries all of that concurrently, and a
// fixture provider writes down everything each request was handed, so the
// test can check what each turn actually saw rather than what was stored.
//
// - a turn sees its own conversation's messages and its own agent's
//   memory, never another session's or another agent's;
// - an approval answers the one call it was asked for: approving one
//   session's call runs that call only, and denying another's runs nothing;
// - "Always allow" given to one agent covers that agent's other
//   conversations and never another agent's;
// - a session id one agent holds can't be written to as another agent;
// - one conversation stuck in a running tool doesn't hold up another
//   conversation of the same agent.

const writeFixturePlugin = async (directory: string, seenFile: string, runsFile: string): Promise<string> => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-isolation-fixture',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    stratus: {
      pluginVersion: 1,
      contributes: {
        providers: [{ name: 'isolation' }],
        tools: [{ name: 'fixture.mark', risk: 'gated' }, { name: 'fixture.hang', risk: 'gated' }],
      },
    },
  }));
  const entry = path.join(directory, 'index.js');
  await writeFile(entry, `
import { appendFileSync } from 'node:fs';
const seen = ${JSON.stringify(seenFile)};
const runs = ${JSON.stringify(runsFile)};
const latestUser = (session) => [...session.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
// Every fact the request carried, whichever of the injected blocks it is in.
const factsIn = (memory) => {
  if (memory === undefined) return [];
  if (Array.isArray(memory)) return memory.map((entry) => entry.content);
  const out = [];
  for (const value of Object.values(memory)) {
    if (Array.isArray(value)) for (const item of value) {
      if (item && typeof item.content === 'string') out.push(item.content);
      else if (item && typeof item.name === 'string') out.push('topic:' + item.name);
    }
  }
  return out;
};
export const createPlugin = () => ({
  name: 'isolation-fixture',
  setup(context) {
    context.tools.register({
      name: 'fixture.mark',
      description: 'Record which session ran this.',
      risk: 'gated',
      parameters: { type: 'object', properties: {} },
      async execute(_input, session) { appendFileSync(runs, 'mark ' + session.id + '\\n'); return 'marked'; },
    });
    context.tools.register({
      name: 'fixture.hang',
      description: 'Record that this started, then never finish.',
      risk: 'gated',
      parameters: { type: 'object', properties: {} },
      async execute(_input, session) { appendFileSync(runs, 'hang ' + session.id + '\\n'); return new Promise(() => {}); },
    });
    context.providers.register({
      name: 'isolation',
      create: () => ({
        name: 'isolation',
        async generate(request) {
          const { session } = request;
          appendFileSync(seen, JSON.stringify({
            sessionId: session.id,
            agentId: session.agent.id,
            texts: session.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.content).filter((text) => text.length > 0),
            facts: factsIn(request.memory),
          }) + '\\n');
          const last = session.messages.at(-1);
          if (last?.role === 'tool') {
            return { parts: [{ type: 'text', text: 'tool said: ' + JSON.stringify(last.toolResult?.ok ? last.toolResult.output : last.toolResult?.error) }] };
          }
          const text = latestUser(session);
          const turn = session.messages.filter((m) => m.role === 'user').length;
          const remember = /^remember (.+)$/.exec(text);
          if (remember) {
            return { parts: [{ type: 'tool-call', call: { id: session.id + ':remember:' + turn, toolName: 'memory.remember', input: { fact: remember[1] } } }] };
          }
          const toolName = /hang/.test(text) ? 'fixture.hang' : /mark/.test(text) ? 'fixture.mark' : undefined;
          if (toolName !== undefined) {
            return { parts: [{ type: 'tool-call', call: { id: session.id + ':' + toolName + ':' + turn, toolName, input: {} } }] };
          }
          return { parts: [{ type: 'text', text: 'echo ' + session.id + ': ' + text }] };
        },
      }),
    });
  },
});
`);
  return entry;
};

interface Home {
  home: string;
  seen: string;
  runs: string;
}

const newHome = async (): Promise<Home> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-isolation-'));
  const seen = path.join(home, 'seen.jsonl');
  const runs = path.join(home, 'tool-runs.log');
  await writeFile(seen, '');
  await writeFile(runs, '');
  const plugin = await writeFixturePlugin(path.join(home, 'plugin'), seen, runs);
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'isolation',
    // Remote, so a gated call parks and the control API answers it.
    approvals: { mode: 'remote' },
    plugins: { [plugin]: { enabled: true } },
  }));
  for (const [id, name] of [['ava', 'Ava'], ['bea', 'Bea']]) {
    await writeFile(
      path.join(home, '.stratus', 'agents', `${id}.md`),
      `---\nname: ${name}\nid: ${id}\nprovider: isolation\ntools: [fixture.mark, fixture.hang, memory.remember]\n---\n\nYou are ${name}.\n`,
    );
  }
  return { home, seen, runs };
};

interface Seen {
  sessionId: string;
  agentId: string;
  texts: string[];
  facts: string[];
}

const seenBy = async (file: string): Promise<Seen[]> =>
  (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Seen);

const runsOf = async (file: string): Promise<string[]> =>
  (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0);

const send = async (daemon: Daemon, sessionId: string, agentId: string, message: string): Promise<void> => {
  const sent = await daemon.api('POST', `/sessions/${sessionId}/messages`, { agentId, message });
  assert.equal(sent.status, 202, `${sessionId}: ${JSON.stringify(sent.json)}`);
};

const completed = (daemon: Daemon, sessionId: string, userTurns: number) =>
  waitFor(async () => {
    const { json } = await daemon.api('GET', `/sessions/${sessionId}`);
    const session = json.session;
    if (session?.status !== 'completed') return undefined;
    const users = (session.messages as Array<{ role: string }>).filter((message) => message.role === 'user').length;
    return users === userTurns ? session : undefined;
  }, `${sessionId} to complete turn ${userTurns}`, daemon);

type Approval = { requestId: string; sessionId: string; agentId?: string; call: { id: string; toolName: string } };

const pendingFor = (daemon: Daemon, sessionId: string) =>
  waitFor(async () => {
    const { json } = await daemon.api('GET', '/approvals');
    return (json.approvals as Approval[]).find((approval) => approval.sessionId === sessionId);
  }, `${sessionId} to park on approval`, daemon);

const pending = async (daemon: Daemon): Promise<Approval[]> => (await daemon.api('GET', '/approvals')).json.approvals as Approval[];

const lastText = (session: { messages: Array<{ role: string; content: string }> }): string =>
  session.messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '';

const withDaemon = async (t: test.TestContext): Promise<Home & { daemon: Daemon }> => {
  const home = await newHome();
  const daemon = await startDaemon(home.home);
  t.after(async () => {
    await stop(daemon);
    await rm(home.home, { recursive: true, force: true });
  });
  return { ...home, daemon };
};

test('concurrent turns see only their own conversation and their own agent\'s memory', async (t) => {
  const { daemon, seen } = await withDaemon(t);

  // Both agents learn something at the same time, in their first conversations.
  await Promise.all([
    send(daemon, 'a-1', 'ava', 'remember ava keeps the alpha ledger'),
    send(daemon, 'b-1', 'bea', 'remember bea keeps the beta ledger'),
  ]);
  await Promise.all([completed(daemon, 'a-1', 1), completed(daemon, 'b-1', 1)]);

  // Then four turns at once: each agent's first conversation again, and a
  // second conversation for each.
  await Promise.all([
    send(daemon, 'a-1', 'ava', 'a1 second'),
    send(daemon, 'a-2', 'ava', 'a2 first'),
    send(daemon, 'b-1', 'bea', 'b1 second'),
    send(daemon, 'b-2', 'bea', 'b2 first'),
  ]);
  const [a1, a2, b1, b2] = await Promise.all([
    completed(daemon, 'a-1', 2),
    completed(daemon, 'a-2', 1),
    completed(daemon, 'b-1', 2),
    completed(daemon, 'b-2', 1),
  ]);
  assert.equal(lastText(a1), 'echo a-1: a1 second');
  assert.equal(lastText(a2), 'echo a-2: a2 first');
  assert.equal(lastText(b1), 'echo b-1: b1 second');
  assert.equal(lastText(b2), 'echo b-2: b2 first');

  const owner: Record<string, string> = { 'a-1': 'ava', 'a-2': 'ava', 'b-1': 'bea', 'b-2': 'bea' };
  const mine: Record<string, RegExp> = { 'a-1': /a1|ava keeps|echo a-1|tool said/, 'a-2': /a2|echo a-2/, 'b-1': /b1|bea keeps|echo b-1|tool said/, 'b-2': /b2|echo b-2/ };
  const requests = await seenBy(seen);
  assert.ok(requests.length >= 8, `expected every turn to reach the provider, saw ${requests.length}`);
  for (const request of requests) {
    assert.equal(request.agentId, owner[request.sessionId], `${request.sessionId} was run as ${request.agentId}`);
    for (const text of request.texts) {
      assert.match(text, mine[request.sessionId]!, `${request.sessionId} was handed another conversation's message: ${text}`);
    }
    const other = request.agentId === 'ava' ? /beta/ : /alpha/;
    for (const fact of request.facts) {
      assert.doesNotMatch(fact, other, `${request.agentId} was handed another agent's memory: ${fact}`);
    }
  }

  // The positive control: memory is the agent's, so it follows it into a
  // conversation where it was never said. Without this, a request that
  // carried no memory at all would pass the check above.
  const fresh = (sessionId: string) => requests.filter((request) => request.sessionId === sessionId).at(-1)!;
  assert.ok(fresh('a-2').facts.some((fact) => /alpha ledger/.test(fact)), JSON.stringify(fresh('a-2')));
  assert.ok(fresh('b-2').facts.some((fact) => /beta ledger/.test(fact)), JSON.stringify(fresh('b-2')));
});

test('a session one agent holds cannot be written to as another agent', async (t) => {
  const { daemon, seen } = await withDaemon(t);
  await send(daemon, 'a-1', 'ava', 'hello');
  await completed(daemon, 'a-1', 1);
  const before = (await seenBy(seen)).length;

  const crossed = await daemon.api('POST', '/sessions/a-1/messages', { agentId: 'bea', message: 'let me in' });
  assert.equal(crossed.status, 409, JSON.stringify(crossed.json));
  assert.equal(crossed.json.error.code, 'session_agent_mismatch', JSON.stringify(crossed.json));

  const after = (await daemon.api('GET', '/sessions/a-1')).json.session;
  assert.equal(after.agent.id, 'ava');
  assert.equal(after.messages.filter((message: { role: string }) => message.role === 'user').length, 1);
  assert.equal((await seenBy(seen)).length, before, 'nothing reached the provider for the refused message');
});

test('an approval answers only the call it was asked for, and Always allow stays with one agent', async (t) => {
  const { daemon, runs } = await withDaemon(t);

  // Three calls to the same tool park at once: two of Ava's conversations and one of Bea's.
  await Promise.all([
    send(daemon, 'a-1', 'ava', 'please mark'),
    send(daemon, 'a-2', 'ava', 'please mark'),
    send(daemon, 'b-1', 'bea', 'please mark'),
  ]);
  const [a1, a2, b1] = await Promise.all([pendingFor(daemon, 'a-1'), pendingFor(daemon, 'a-2'), pendingFor(daemon, 'b-1')]);
  assert.equal(new Set([a1.requestId, a2.requestId, b1.requestId]).size, 3, 'each call is its own request');
  assert.deepEqual(await runsOf(runs), []);

  // Once, for one session: that call runs, the other two stay parked.
  assert.equal((await daemon.api('POST', '/approvals', { requestId: a1.requestId, answer: 'once' })).status, 200);
  await completed(daemon, 'a-1', 1);
  assert.deepEqual(await runsOf(runs), ['mark a-1']);
  assert.deepEqual((await pending(daemon)).map((approval) => approval.sessionId).sort(), ['a-2', 'b-1']);

  // Deny for another: nothing runs, the turn says so, Ava's other call is untouched.
  assert.equal((await daemon.api('POST', '/approvals', { requestId: b1.requestId, answer: 'deny' })).status, 200);
  const denied = await completed(daemon, 'b-1', 1);
  assert.match(lastText(denied), /tool said: /);
  assert.doesNotMatch(lastText(denied), /marked/);
  assert.deepEqual(await runsOf(runs), ['mark a-1']);
  assert.deepEqual((await pending(daemon)).map((approval) => approval.sessionId), ['a-2']);

  // Always, from one of Ava's conversations: a grant to Ava.
  assert.equal((await daemon.api('POST', '/approvals', { requestId: a2.requestId, answer: 'always' })).status, 200);
  await completed(daemon, 'a-2', 1);
  assert.deepEqual(await runsOf(runs), ['mark a-1', 'mark a-2']);

  // Ava's next call, in a conversation that never asked, runs without asking.
  await send(daemon, 'a-3', 'ava', 'please mark');
  await completed(daemon, 'a-3', 1);
  assert.deepEqual(await runsOf(runs), ['mark a-1', 'mark a-2', 'mark a-3']);

  // Bea still has to ask.
  await send(daemon, 'b-2', 'bea', 'please mark');
  const b2 = await pendingFor(daemon, 'b-2');
  assert.equal(b2.call.toolName, 'fixture.mark');
  assert.deepEqual(await runsOf(runs), ['mark a-1', 'mark a-2', 'mark a-3']);
  // And the grant table says the same: Ava holds one, Bea none.
  const toolsGranted = async (agentId: string): Promise<string[]> => {
    const { status, json } = await daemon.api('GET', `/agents/${agentId}/grants`);
    assert.equal(status, 200, JSON.stringify(json));
    return (json.tools as Array<{ tool: string }>).map((grant) => grant.tool);
  };
  assert.deepEqual(await toolsGranted('ava'), ['fixture.mark']);
  assert.deepEqual(await toolsGranted('bea'), []);
});

test('one conversation stuck in a running tool does not hold up the same agent\'s other conversations', async (t) => {
  const { daemon, runs } = await withDaemon(t);

  await send(daemon, 'a-1', 'ava', 'please hang');
  const parked = await pendingFor(daemon, 'a-1');
  assert.equal((await daemon.api('POST', '/approvals', { requestId: parked.requestId, answer: 'once' })).status, 200);
  await waitFor(async () => ((await runsOf(runs)).includes('hang a-1') ? true : undefined), 'the tool to start', daemon);

  await send(daemon, 'a-2', 'ava', 'hello');
  const other = await completed(daemon, 'a-2', 1);
  assert.equal(lastText(other), 'echo a-2: hello');
  assert.equal((await daemon.api('GET', '/sessions/a-1')).json.session.status, 'running');
  // The tool never returns, so an ordinary stop would sit out the drain
  // window. Nothing here is about shutdown.
  await crash(daemon);
});
