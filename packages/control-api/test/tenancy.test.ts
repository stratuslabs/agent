import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createFileCommandWhitelist } from '@stratusagent/permissions';
import {
  agentWorkspacePath,
  createApiToken,
  createHomeMemoryStore,
  stratusHomePath,
  type StateEnvironment,
} from '@stratusagent/state';
import { newHome, openSocket, startApi, writeSoul, type Harness } from './harness.ts';

/**
 * Step 08's hosted profile, as its acceptance criterion states it: two
 * tenants, isolated, tested per resource — including the same agent id in
 * both. A tenant is a cell: one home, served by its own daemon and API. So
 * the test is two of those side by side in one process, each with its own
 * operator-held provider key and a member token, which is exactly what a
 * hosting control plane runs one container each of.
 */
interface Cell {
  name: string;
  home: string;
  env: StateEnvironment;
  harness: Harness;
  member: string;
  providerCalls: number;
}

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 60, completion_tokens: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const startCell = async (name: string, config: object): Promise<Cell> => {
  const home = await newHome();
  // The same agent id in both cells, on purpose.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(config));
  const env: StateEnvironment = { homeDir: home, cwd: home };
  const grants = createFileCommandWhitelist({ directory: path.join(home, '.stratus', 'agents'), stateHome: stratusHomePath(env) });
  const cell: Partial<Cell> & { providerCalls: number } = { name, home, env, providerCalls: 0 };
  const harness = await startApi({
    home,
    options: { grants },
    env: {
      // The operator's key, one per cell here so each cell's spend is its
      // own to count — held in the daemon's environment, never in the home.
      processEnv: { OPENAI_API_KEY: `sk-operator-${name}` },
      fetch: (async () => {
        cell.providerCalls += 1;
        return openAiText(`answer from tenant ${name}`);
      }) as typeof fetch,
    },
  });
  const { token: member } = await createApiToken(env, { name: 'web' });
  return Object.assign(cell, { harness, member }) as Cell;
};

const asMember = (cell: Cell, pathname: string, init: RequestInit = {}): Promise<Response> =>
  cell.harness.call(pathname, {
    ...init,
    auth: 'none',
    headers: { authorization: `Bearer ${cell.member}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });

const sendAs = async (cell: Cell, sessionId: string, text: string, agentId = 'ava'): Promise<Response> =>
  asMember(cell, `/api/v1/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ agentId, message: text }) });

test('two tenants with the same agent id share nothing: sessions, events, memory, grants, workspaces, tokens, or spend', async () => {
  // Tenant A has a budget that two messages spend; B has none.
  const a = await startCell('a', { budget: { daily: 140 } });
  const b = await startCell('b', {});
  try {
    // ---- sessions: the same agent id and the same session id in both.
    await a.harness.gateway.dispatch({ sessionId: 'shared-id', agentId: 'ava', userMessage: 'hello from a' });
    await b.harness.gateway.dispatch({ sessionId: 'shared-id', agentId: 'ava', userMessage: 'hello from b' });
    type SessionRead = { session: { messages: Array<{ content: string }> } };
    const readA = await (await asMember(a, '/api/v1/sessions/shared-id')).json() as SessionRead;
    const readB = await (await asMember(b, '/api/v1/sessions/shared-id')).json() as SessionRead;
    assert.deepEqual(readA.session.messages.map((message) => message.content), ['hello from a', 'answer from tenant a']);
    assert.deepEqual(readB.session.messages.map((message) => message.content), ['hello from b', 'answer from tenant b']);
    const listedB = await (await asMember(b, '/api/v1/sessions')).json() as { sessions: Array<{ id: string }> };
    assert.deepEqual(listedB.sessions.map((session) => session.id), ['shared-id']);

    // ---- tokens: neither of A's tokens opens anything of B's.
    for (const token of [a.harness.token, a.member]) {
      const crossed = await b.harness.call('/api/v1/sessions', { auth: 'none', headers: { authorization: `Bearer ${token}` } });
      assert.equal(crossed.status, 401);
    }
    const crossedSocket = await openSocket(`${b.harness.url.replace(/^http/, 'ws')}/api/v1/events`, {
      headers: { authorization: `Bearer ${a.member}` },
    });
    assert.equal(crossedSocket.opened, false);
    assert.equal(crossedSocket.status, 401);

    // ---- events: B's member stream, whole-fleet, hears B and only B.
    const stream = await openSocket(`${b.harness.url.replace(/^http/, 'ws')}/api/v1/events`, {
      headers: { authorization: `Bearer ${b.member}` },
    });
    assert.ok(stream.opened);
    const aOnly = await a.harness.gateway.dispatch({ sessionId: 'a-only', agentId: 'ava', userMessage: 'secret plans' });
    assert.equal(aOnly.status, 'completed');
    assert.equal((await sendAs(b, 'b-only', 'status?')).status, 202);
    await stream.waitFor(
      (frame) => frame.sessionId === 'b-only' && (frame.event as { type?: string } | undefined)?.type === 'session.completed',
      'tenant B\'s own completion',
    );
    assert.equal(stream.frames.some((frame) => frame.sessionId === 'a-only'), false);
    assert.equal(JSON.stringify(stream.frames).includes('secret plans'), false);
    stream.close();

    // ---- memory: what ava remembers in A, ava in B has never heard.
    await createHomeMemoryStore(a.env).append('ava', 'the launch code is 1234');
    assert.equal((await createHomeMemoryStore(b.env).list('ava')).entries.length, 0);
    assert.equal((await createHomeMemoryStore(a.env).list('ava')).entries.length, 1);

    // ---- whitelists: a standing grant in A is not one in B.
    await createFileCommandWhitelist({ directory: path.join(a.home, '.stratus', 'agents'), stateHome: stratusHomePath(a.env) })
      .rememberTool('ava', { tool: 'demo.echo', grantedAt: new Date().toISOString(), grantedBy: 'U-A' });
    const grantsA = await (await asMember(a, '/api/v1/agents/ava/grants')).json() as { tools: Array<{ tool: string }> };
    const grantsB = await (await asMember(b, '/api/v1/agents/ava/grants')).json() as { tools: Array<{ tool: string }> };
    assert.deepEqual(grantsA.tools.map((grant) => grant.tool), ['demo.echo']);
    assert.deepEqual(grantsB.tools, []);

    // ---- workspaces: each ava's lives inside its own cell's home, and
    // neither is reachable from the other's.
    const workspaceA = agentWorkspacePath(a.env, 'ava');
    const workspaceB = agentWorkspacePath(b.env, 'ava');
    assert.ok(workspaceA.startsWith(`${a.home}${path.sep}`));
    assert.ok(workspaceB.startsWith(`${b.home}${path.sep}`));
    assert.equal(path.relative(b.home, workspaceA).startsWith('..'), true);

    // ---- spend: each cell's ledger is its own, and matches its provider calls.
    const usageA = await (await asMember(a, '/api/v1/usage')).json() as { usage: Array<{ calls: number; inputTokens: number }> };
    const usageB = await (await asMember(b, '/api/v1/usage')).json() as { usage: Array<{ calls: number; inputTokens: number }> };
    assert.equal(usageA.usage[0]?.calls, a.providerCalls);
    assert.equal(usageB.usage[0]?.calls, b.providerCalls);
    assert.equal(usageB.usage[0]?.inputTokens, 60 * b.providerCalls);

    // ---- a capped tenant is stopped with a sentence; the other keeps serving.
    // A spent 70 on each of its two messages, which is its whole day.
    await assert.rejects(
      a.harness.gateway.dispatch({ sessionId: 'shared-id', agentId: 'ava', userMessage: 'one more?' }),
      /This Stratus install has used its daily model budget/,
    );
    const stillServing = await b.harness.gateway.dispatch({ sessionId: 'shared-id', agentId: 'ava', userMessage: 'and you?' });
    assert.equal(stillServing.status, 'completed');

    // ---- and a tenant cannot lift its own cap, or point the operator's key elsewhere.
    const raise = await asMember(a, '/api/v1/config', { method: 'PUT', body: JSON.stringify({ budget: { daily: 1_000_000 } }) });
    assert.equal(raise.status, 403);
    assert.equal((await raise.json() as { error: { code: string } }).error.code, 'operator_required');
    const redirect = await asMember(a, '/api/v1/config', { method: 'PUT', body: JSON.stringify({ baseUrl: 'https://attacker.example' }) });
    assert.equal(redirect.status, 403);
  } finally {
    await a.harness.stop();
    await b.harness.stop();
  }
});
