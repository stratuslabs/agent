import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { newHome, settles, startApi, writeSoul } from './harness.ts';

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

test('the roster is served as data, avatar palette included', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: anthropic\nmodel: claude-opus-5\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    const response = await harness.call('/api/v1/agents');
    assert.equal(response.status, 200);
    const { agents } = await json<{ agents: Array<Record<string, unknown>> }>(response);

    const ava = agents.find((agent) => agent.id === 'ava');
    assert.ok(ava);
    assert.equal(ava.name, 'Ava');
    assert.deepEqual(ava.runsOn, { provider: 'anthropic', model: 'claude-opus-5' });
    // Structural, so a surface can draw it. The CLI renders the same data as
    // one prose line; neither is derived from the other's output.
    const avatar = ava.avatar as { hue: number; palette: string[] };
    assert.equal(typeof avatar.hue, 'number');
    assert.ok(avatar.palette.length > 0);

    assert.ok(agents.some((agent) => agent.builtIn === true), 'the built-in agent is listed too');
  } finally {
    await harness.stop();
  }
});

test('creating an agent writes a soul and makes it dispatchable without a restart', async () => {
  const harness = await startApi();
  try {
    const created = await harness.call('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Scout', instructions: 'You research things.' }),
    });
    assert.equal(created.status, 201);
    const { agent, soulPath } = await json<{ agent: { id: string; name: string }; soulPath: string }>(created);
    assert.equal(agent.name, 'Scout');

    // A real soul file the CLI can read, not an API-only record.
    const written = await readFile(soulPath, 'utf8');
    assert.match(written, /^---\nname: Scout\n/);
    assert.equal(path.dirname(soulPath), path.join(harness.home, '.stratus', 'agents'));

    // 07 creates an agent and expects to talk to it. The roster reload the
    // route performs is what makes that true without bouncing the daemon.
    const session = await settles(
      harness.gateway.dispatch({ sessionId: 's-new', agentId: agent.id, userMessage: 'hello' }),
      'a dispatch to the new agent',
    );
    assert.equal(session.agent.id, agent.id);

    const invalid = await harness.call('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No Persona' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await harness.stop();
  }
});

test('editing a soul round-trips through the parser and refuses an id change', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: anthropic\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    const edited = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 'You are Ava, and you are terse.', model: 'claude-sonnet-5' }),
    });
    assert.equal(edited.status, 200);

    const soul = await readFile(path.join(home, '.stratus', 'agents', 'ava.md'), 'utf8');
    assert.match(soul, /model: claude-sonnet-5/);
    assert.match(soul, /you are terse/);
    // Untouched keys survive: an edit is not a replacement.
    assert.match(soul, /provider: anthropic/);

    // An id keys sessions, memory, and credentials. Changing it in place
    // would not rename an agent — it would hand this one's history away.
    const renamed = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ soul: '---\nname: Ava\nid: someone-else\n---\n\nYou are Ava.\n' }),
    });
    assert.equal(renamed.status, 409);
    assert.equal((await json<{ error: { code: string } }>(renamed)).error.code, 'agent_id_immutable');

    // A soul that will not parse is refused before it can reach the roster.
    const broken = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ soul: 'no frontmatter at all' }),
    });
    assert.ok(broken.status === 400 || broken.status === 409, `expected a refusal, got ${broken.status}`);

    // The built-in has no file to edit and says so rather than 500ing.
    const builtIn = await harness.call('/api/v1/agents/stratus', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 'nope' }),
    });
    assert.equal(builtIn.status, 409);
  } finally {
    await harness.stop();
  }
});

test('sessions list and read back with provider replay state stripped', async () => {
  const harness = await startApi();
  try {
    await harness.gateway.store.create({
      id: 's-redact',
      agent: { id: 'stratus', name: 'Stratus' },
      status: 'completed',
      messages: [{ id: 'm-1', role: 'user', content: 'hello', createdAt: '2026-08-19T00:00:00.000Z' }],
      metadata: {
        anthropicRawTurns: { 'call-1': [{ type: 'thinking', thinking: 'internal' }] },
        channel: 'web',
      },
    });

    const listed = await json<{ sessions: Array<{ id: string }> }>(await harness.call('/api/v1/sessions'));
    assert.ok(listed.sessions.some((session) => session.id === 's-redact'));

    const read = await harness.call('/api/v1/sessions/s-redact');
    assert.equal(read.status, 200);
    const { session } = await json<{ session: { metadata?: Record<string, unknown>; messages: unknown[] } }>(read);
    // Replay state is how resumption works, not something a client needs —
    // and it carries raw model turns. It never leaves the daemon.
    assert.equal(session.metadata?.anthropicRawTurns, undefined);
    assert.equal(session.metadata?.channel, 'web');
    assert.equal(session.messages.length, 1);

    assert.equal((await harness.call('/api/v1/sessions/nope')).status, 404);
  } finally {
    await harness.stop();
  }
});

test('a message returns its turn id, and a new session must name an agent', async () => {
  const harness = await startApi();
  try {
    const orphan = await harness.call('/api/v1/sessions/s-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    // The runner cannot start a turn without an agent, and a new session has
    // no stored one to recover.
    assert.equal(orphan.status, 400);
    assert.equal((await json<{ error: { code: string } }>(orphan)).error.code, 'agent_required');

    const completed = new Promise<void>((resolve) => {
      const off = harness.gateway.bus.subscribe((event) => {
        if (event.sessionId === 's-1' && (event.type === 'session.completed' || event.type === 'session.failed')) {
          off();
          resolve();
        }
      });
    });

    const accepted = await harness.call('/api/v1/sessions/s-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    // Accepted, not completed: the turn runs for as long as the model takes
    // and the caller watches it on the event stream.
    assert.equal(accepted.status, 202);
    const { turnId } = await json<{ turnId: string }>(accepted);
    assert.match(turnId, /^[0-9a-f-]{36}$/);

    // The turn is fire-and-forget, so the session it creates does not exist
    // yet. Wait for the turn to finish before asserting on durable state —
    // gated on the event that says so, never on elapsed time.
    await settles(completed, 'the first turn');

    // An agent that does not exist is a typo, and answers like one.
    const unknown = await harness.call('/api/v1/sessions/s-2/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'nobody' }),
    });
    assert.equal(unknown.status, 404);

    // Sessions never cross agent identities.
    await writeSoul(harness.home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
    await harness.gateway.reloadRoster();
    const crossed = await harness.call('/api/v1/sessions/s-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'ava' }),
    });
    assert.equal(crossed.status, 409);
    assert.equal((await json<{ error: { code: string } }>(crossed)).error.code, 'session_agent_mismatch');
  } finally {
    await harness.stop();
  }
});

test('a parked approval is listed and resolvable, and a late second click is refused', async () => {
  const harness = await startApi({ approvals: true });
  const transport = harness.transport;
  assert.ok(transport, 'the harness captured the approval transport');
  try {
    const answer = transport.request({
      session: {
        id: 'sess-web',
        agent: { id: 'stratus', name: 'Stratus' },
        status: 'running',
        messages: [],
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
        metadata: { channel: 'slack', slackChannel: 'C1' },
      },
      call: { id: 'call-1', toolName: 'shell.run', input: { command: 'ls' } },
      risk: 'gated',
    });

    const listed = await json<{ approvals: Array<Record<string, unknown>> }>(
      await harness.call('/api/v1/approvals'),
    );
    assert.equal(listed.approvals.length, 1);
    const parked = listed.approvals[0] as { requestId: string; sessionId: string; risk: string };
    assert.equal(parked.sessionId, 'sess-web');
    assert.equal(parked.risk, 'gated');

    const resolved = await harness.call('/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: parked.requestId, answer: 'once', actor: 'web' }),
    });
    assert.equal(resolved.status, 200);
    assert.equal(await settles(answer, 'the parked call'), 'once');

    // The normal outcome of a button clicked a minute too late. Never a
    // "try again".
    const again = await harness.call('/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: parked.requestId, answer: 'deny' }),
    });
    assert.equal(again.status, 409);
    assert.equal((await json<{ error: { code: string } }>(again)).error.code, 'approval_not_pending');

    const bad = await harness.call('/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'x', answer: 'maybe' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await harness.stop();
  }
});

test('health reports the roster and its runtimes without probing a provider', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  let fetched = 0;
  const harness = await startApi({
    home,
    options: {
      env: {
        homeDir: home,
        cwd: home,
        processEnv: {},
        // A monitoring view polls health. A live call per poll would spend
        // the operator's rate limit to say what resolution already knows.
        fetch: (async () => { fetched += 1; return new Response('{}'); }) as typeof fetch,
      },
    },
  });
  try {
    const health = await json<{
      ok: boolean;
      uptimeMs: number;
      agents: Array<{ id: string }>;
      sessions: { total: number };
      approvals: { pending: number };
      runtimes: Array<{ provider: string; credentials: string }>;
    }>(await harness.call('/api/v1/health'));

    assert.equal(health.ok, true);
    assert.ok(health.uptimeMs >= 0);
    assert.ok(health.agents.some((agent) => agent.id === 'ava'));
    assert.equal(health.sessions.total, 0);
    assert.equal(health.approvals.pending, 0);
    // Demo, because nothing is signed in here — and reported as such rather
    // than guessed at.
    assert.ok(health.runtimes.some((runtime) => runtime.provider === 'demo'));
    assert.equal(fetched, 0, 'health made no network call');
  } finally {
    await harness.stop();
  }
});

test('credentials are writable but never readable, and channel tokens keep their own door', async () => {
  const harness = await startApi();
  try {
    const stored = await harness.call('/api/v1/credentials/anthropic', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'api_key', value: 'sk-ant-secret', baseUrl: 'https://proxy.local' }),
    });
    assert.equal(stored.status, 200);
    assert.ok(!(await stored.clone().text()).includes('sk-ant-secret'), 'the write does not echo the secret');

    const listed = await harness.call('/api/v1/credentials');
    const body = await listed.text();
    assert.ok(!body.includes('sk-ant-secret'), 'reading credentials never returns a value');
    assert.match(body, /"stored":true/);
    assert.match(body, /proxy\.local/);

    // Channel tokens are gateway infrastructure secrets in their own
    // namespace: this route writes them, and the provider-credential route
    // cannot reach them.
    const channel = await harness.call('/api/v1/credentials/channels/slack', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }),
    });
    assert.equal(channel.status, 200);

    const raw = JSON.parse(await readFile(path.join(harness.home, '.stratus', 'credentials.json'), 'utf8')) as {
      anthropic?: unknown;
      channels?: { slack?: Record<string, unknown> };
    };
    assert.ok(raw.channels?.slack?.ava, 'the token landed in the channels namespace');
    assert.ok(raw.anthropic, 'and the provider credential stayed in its own');

    const wrongChannel = await harness.call('/api/v1/credentials/channels/discord', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'ava', appToken: 'a', botToken: 'b' }),
    });
    assert.equal(wrongChannel.status, 400);

    const wrongProvider = await harness.call('/api/v1/credentials/slack', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'api_key', value: 'x' }),
    });
    assert.equal(wrongProvider.status, 400);
  } finally {
    await harness.stop();
  }
});

test('config round-trips, and an unknown key is refused rather than quietly kept', async () => {
  const harness = await startApi();
  try {
    const written = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { provider: 'anthropic', model: 'claude-opus-5' } }),
    });
    assert.equal(written.status, 200);

    const read = await json<{ path: string; config: Record<string, unknown> }>(
      await harness.call('/api/v1/config'),
    );
    assert.equal(read.config.provider, 'anthropic');
    assert.equal(read.config.model, 'claude-opus-5');
    assert.equal(read.path, path.join(harness.home, '.stratus', 'config.json'));

    // An unknown key would be silently preserved here and silently ignored by
    // every reader — and this endpoint must not become a way to write into a
    // namespace it does not own.
    const unknown = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { credentials: { anthropic: 'sk-sneaky' } } }),
    });
    assert.equal(unknown.status, 400);
    assert.equal((await json<{ error: { code: string } }>(unknown)).error.code, 'unknown_config_key');

    // A value the caller typed is their error, not the server's.
    const badProvider = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { provider: 'not-a-provider' } }),
    });
    assert.equal(badProvider.status, 400);
    assert.equal((await json<{ error: { code: string } }>(badProvider)).error.code, 'invalid_provider');
  } finally {
    await harness.stop();
  }
});

test('the model catalog lists what the stored sign-ins can reach', async () => {
  const home = await newHome();
  const harness = await startApi({
    home,
    options: {
      env: {
        homeDir: home,
        cwd: home,
        processEnv: { OPENAI_API_KEY: 'sk-test' },
        fetch: (async () => new Response(
          JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }, { id: 'text-embedding-3-small' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
      },
    },
  });
  try {
    const { models } = await json<{ models: Array<{ provider: string; id: string }> }>(
      await harness.call('/api/v1/catalog/models'),
    );
    assert.ok(models.some((model) => model.id === 'gpt-4.1-mini'));
    // Runs always call /chat/completions: a model that cannot serve one must
    // never be offered as a default.
    assert.ok(!models.some((model) => model.id === 'text-embedding-3-small'));
  } finally {
    await harness.stop();
  }
});

test('reloading the roster picks up a soul written behind the daemon\'s back', async () => {
  const home = await newHome();
  const harness = await startApi({ home });
  try {
    await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\n---\n\nYou research things.\n');

    const reloaded = await harness.call('/api/v1/roster/reload', { method: 'POST' });
    assert.equal(reloaded.status, 200);
    const { agents } = await json<{ agents: Array<{ id: string }> }>(reloaded);
    assert.ok(agents.some((agent) => agent.id === 'rex'));
  } finally {
    await harness.stop();
  }
});

test('the roster carries when each agent was last active, and how many turns are live', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    const before = await json<{ agents: Array<{ id: string; lastActiveAt?: string; activeSessions: number }> }>(
      await harness.call('/api/v1/agents'),
    );
    const idle = before.agents.find((agent) => agent.id === 'ava');
    // Never talked to: no timestamp to report, rather than a fabricated one.
    assert.equal(idle?.lastActiveAt, undefined);
    assert.equal(idle?.activeSessions, 0);

    await settles(
      harness.gateway.dispatch({ sessionId: 'ava-live', agentId: 'ava', userMessage: 'hello' }),
      'a turn for Ava',
    );

    const after = await json<{ agents: Array<{ id: string; lastActiveAt?: string; activeSessions: number }> }>(
      await harness.call('/api/v1/agents'),
    );
    const active = after.agents.find((agent) => agent.id === 'ava');
    assert.ok(active?.lastActiveAt, 'the roster now reports when Ava last did something');
    assert.ok(Date.parse(active.lastActiveAt) > 0);
    // Finished, so nothing is live — the timestamp is what a "recently
    // active" indicator reads, and the window it applies is the UI's call.
    assert.equal(active.activeSessions, 0);

    // Another agent's turn does not light this one up.
    const builtIn = after.agents.find((agent) => agent.id === 'stratus');
    assert.equal(builtIn?.lastActiveAt, undefined);
  } finally {
    await harness.stop();
  }
});

test('session listings can be bounded, and a bad bound is refused', async () => {
  const harness = await startApi();
  try {
    for (const id of ['s-1', 's-2', 's-3']) {
      await harness.gateway.store.create({
        id,
        agent: { id: 'stratus', name: 'Stratus' },
        status: 'completed',
        messages: [],
      });
    }

    const all = await json<{ sessions: unknown[] }>(await harness.call('/api/v1/sessions'));
    assert.equal(all.sessions.length, 3);

    const bounded = await json<{ sessions: unknown[] }>(await harness.call('/api/v1/sessions?limit=2'));
    assert.equal(bounded.sessions.length, 2);

    const bad = await harness.call('/api/v1/sessions?limit=lots');
    assert.equal(bad.status, 400);
    assert.equal((await json<{ error: { code: string } }>(bad)).error.code, 'invalid_limit');
  } finally {
    await harness.stop();
  }
});
