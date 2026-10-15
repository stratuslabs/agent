import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ABANDONED_TURN_ERROR } from '@stratusagent/gateway';

import { crash, startDaemon, stop, waitFor, type Daemon } from './serve-daemon.ts';

// A crash, not a stop. The gateway's recovery sweeps are unit-tested by
// starting a second gateway on the same store, but that never kills a
// process: no SIGKILL mid-write, no lock left behind by a dead pid, no
// approval timer that simply vanishes. Here a real `stratus serve` is
// killed with SIGKILL at the two moments that matter and started again on
// the same home:
//
// - parked on an approval: the call has to be asked again, run once when
//   approved, and never run before it is;
// - inside a running tool: the turn has to be settled as abandoned, said so,
//   and the tool must not run a second time.
//
// The provider and tools come from a plugin written to a temp directory,
// because the built-in demo provider only calls demo.echo, which is safe
// and never parks. Each tool appends a line to a file so a test can count
// how often it actually ran.

const writeFixturePlugin = async (directory: string, counterFile: string): Promise<string> => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-recovery-fixture',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    stratus: {
      pluginVersion: 1,
      contributes: {
        providers: [{ name: 'recovery' }],
        tools: [{ name: 'fixture.mark', risk: 'gated' }, { name: 'fixture.hang', risk: 'gated' }],
      },
    },
  }));
  const entry = path.join(directory, 'index.js');
  await writeFile(entry, `
import { appendFileSync } from 'node:fs';
const counter = ${JSON.stringify(counterFile)};
const prompt = (session) => [...session.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
export const createPlugin = () => ({
  name: 'recovery-fixture',
  setup(context) {
    context.tools.register({
      name: 'fixture.mark',
      description: 'Record that this ran.',
      risk: 'gated',
      parameters: { type: 'object', properties: {} },
      async execute() { appendFileSync(counter, 'mark\\n'); return 'marked'; },
    });
    context.tools.register({
      name: 'fixture.hang',
      description: 'Record that this started, then never finish.',
      risk: 'gated',
      parameters: { type: 'object', properties: {} },
      async execute() { appendFileSync(counter, 'hang\\n'); return new Promise(() => {}); },
    });
    context.providers.register({
      name: 'recovery',
      create: () => ({
        name: 'recovery',
        async generate({ session }) {
          const last = session.messages.at(-1);
          if (last?.role === 'tool') {
            return { parts: [{ type: 'text', text: 'tool said: ' + JSON.stringify(last.toolResult?.ok ? last.toolResult.output : last.toolResult?.error) }] };
          }
          const text = prompt(session);
          const toolName = /hang/.test(text) ? 'fixture.hang' : /mark/.test(text) ? 'fixture.mark' : undefined;
          if (toolName === undefined) {
            return { parts: [{ type: 'text', text: 'no tool' }] };
          }
          const turn = session.messages.filter((m) => m.role === 'user').length;
          return { parts: [{ type: 'tool-call', call: { id: session.id + ':' + toolName + ':' + turn, toolName, input: {} } }] };
        },
      }),
    });
  },
});
`);
  return entry;
};

const newHome = async (): Promise<{ home: string; counter: string }> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-recovery-'));
  const counter = path.join(home, 'tool-runs.log');
  await writeFile(counter, '');
  const plugin = await writeFixturePlugin(path.join(home, 'plugin'), counter);
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'recovery',
    // Remote, so a gated call parks instead of being refused. No Slack app
    // is configured: the control API is the client that answers.
    approvals: { mode: 'remote' },
    plugins: { [plugin]: { enabled: true } },
  }));
  await writeFile(
    path.join(home, '.stratus', 'agents', 'ava.md'),
    '---\nname: Ava\nid: ava\nprovider: recovery\ntools: [fixture.mark, fixture.hang]\n---\n\nYou are Ava.\n',
  );
  return { home, counter };
};

const runs = async (counter: string): Promise<string[]> =>
  (await readFile(counter, 'utf8')).split('\n').filter((line) => line.length > 0);

const toolResults = (session: { messages: Array<{ role: string; toolResult?: { ok: boolean; output?: unknown; error?: string } }> }) =>
  session.messages.filter((message) => message.role === 'tool').map((message) => message.toolResult);

test('a turn parked on approval when the daemon is killed is asked again, and runs once when approved', async (t) => {
  const { home, counter } = await newHome();
  const daemons: Daemon[] = [];
  t.after(async () => {
    await Promise.all(daemons.map(stop));
    await rm(home, { recursive: true, force: true });
  });

  const first = await startDaemon(home);
  daemons.push(first);
  const sent = await first.api('POST', '/sessions/park-1/messages', { agentId: 'ava', message: 'please mark it' });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  const parked = await waitFor(async () => {
    const { json } = await first.api('GET', '/approvals');
    return (json.approvals as Array<{ requestId: string; sessionId: string; call: { toolName: string } }>)
      .find((approval) => approval.sessionId === 'park-1');
  }, 'the call to park', first);
  assert.equal(parked.call.toolName, 'fixture.mark');
  await crash(first);
  assert.deepEqual(await runs(counter), [], 'a parked call must not run before anyone approves it');

  // Whatever the killed process still held, its lock included, the next start has to take over.
  const second = await startDaemon(home);
  daemons.push(second);
  const reasked = await waitFor(async () => {
    const { json } = await second.api('GET', '/approvals');
    return (json.approvals as Array<{ requestId: string; sessionId: string; call: { id: string; toolName: string } }>)
      .find((approval) => approval.sessionId === 'park-1');
  }, 'the parked call to be asked again', second);
  assert.equal(reasked.call.toolName, 'fixture.mark');
  assert.equal(reasked.call.id, 'park-1:fixture.mark:1', 'the same call is asked again, not a new one');
  // The old request died with its process. Answering it must be refused,
  // not taken as a yes for the call that is being asked again.
  assert.notEqual(reasked.requestId, parked.requestId);
  const stale = await second.api('POST', '/approvals', { requestId: parked.requestId, answer: 'once' });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.deepEqual(await runs(counter), []);

  const approved = await second.api('POST', '/approvals', { requestId: reasked.requestId, answer: 'once' });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const done = await waitFor(async () => {
    const { json } = await second.api('GET', '/sessions/park-1');
    return json.session?.status === 'completed' ? json.session : undefined;
  }, 'the recovered turn to complete', second);
  assert.deepEqual(await runs(counter), ['mark'], 'approved once, so it ran exactly once');
  assert.deepEqual(toolResults(done).map((result) => result?.ok), [true], 'one tool result, and a successful one');
  assert.match(JSON.stringify(done.messages.at(-1)), /tool said: \\"marked\\"/);

  // And a clean restart after that finds nothing left to ask or run.
  await stop(second);
  const third = await startDaemon(home);
  daemons.push(third);
  const settled = await third.api('GET', '/sessions/park-1');
  assert.equal(settled.json.session.status, 'completed');
  assert.deepEqual((await third.api('GET', '/approvals')).json.approvals, []);
  assert.deepEqual(await runs(counter), ['mark']);
});

test('a turn killed inside an approved, running tool is settled as abandoned on restart, and the tool is not run again', async (t) => {
  const { home, counter } = await newHome();
  const daemons: Daemon[] = [];
  t.after(async () => {
    await Promise.all(daemons.map(stop));
    await rm(home, { recursive: true, force: true });
  });

  const first = await startDaemon(home);
  daemons.push(first);
  const sent = await first.api('POST', '/sessions/hang-1/messages', { agentId: 'ava', message: 'please hang' });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  // Approved, so the kill lands inside the running tool, after the
  // approval was spent, not on the approval itself.
  const parked = await waitFor(async () => {
    const { json } = await first.api('GET', '/approvals');
    return (json.approvals as Array<{ requestId: string; sessionId: string }>).find((approval) => approval.sessionId === 'hang-1');
  }, 'the call to park', first);
  assert.equal((await first.api('POST', '/approvals', { requestId: parked.requestId, answer: 'once' })).status, 200);
  await waitFor(async () => ((await runs(counter)).includes('hang') ? true : undefined), 'the tool to start', first);
  const during = await first.api('GET', '/sessions/hang-1');
  assert.equal(during.json.session.status, 'running');
  await crash(first);

  const second = await startDaemon(home);
  daemons.push(second);
  const failed = await waitFor(async () => {
    const { json } = await second.api('GET', '/sessions/hang-1');
    return json.session?.status === 'failed' ? json.session : undefined;
  }, 'the abandoned turn to be settled', second);
  // Said in the one wording a surface can match, not as a provider error.
  assert.equal(failed.lastError, ABANDONED_TURN_ERROR);
  assert.deepEqual(await runs(counter), ['hang'], 'a tool the crash interrupted must not run a second time');
  assert.deepEqual((await second.api('GET', '/approvals')).json.approvals, []);

  // The conversation is still usable: the next message gets a normal turn.
  const next = await second.api('POST', '/sessions/hang-1/messages', { agentId: 'ava', message: 'just say hi' });
  assert.equal(next.status, 202, JSON.stringify(next.json));
  const after = await waitFor(async () => {
    const { json } = await second.api('GET', '/sessions/hang-1');
    return json.session?.status === 'completed' ? json.session : undefined;
  }, 'the next turn to complete', second);
  assert.match(JSON.stringify(after.messages.at(-1)), /no tool/);
  assert.deepEqual(await runs(counter), ['hang']);
});
