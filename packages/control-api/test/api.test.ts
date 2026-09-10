import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createGateway } from '@stratusagent/gateway';

import { CONTROL_API_VERSION, createControlApi } from '../src/index.ts';
import { newHome, openSocket, rawPost, settles, startApi, writeSoul } from './harness.ts';

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

    // Every allowlist is editable by field — skills exactly as tools and
    // credentials, or a client can grant tools but not the procedures
    // that use them.
    const allowlisted = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: ['fs.read'], skills: ['code-review'] }),
    });
    assert.equal(allowlisted.status, 200);
    const withSkills = await readFile(path.join(home, '.stratus', 'agents', 'ava.md'), 'utf8');
    assert.match(withSkills, /skills:\n  - code-review/);
    assert.match(withSkills, /tools:\n  - fs\.read/);

    const badSkills = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skills: 'code-review' }),
    });
    assert.equal(badSkills.status, 400);
    assert.equal((await json<{ error: { code: string } }>(badSkills)).error.code, 'invalid_allowlist');

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

    // And a stored agent that has since left the roster answers like a
    // typo, one door later. Without this the dispatch rejected with nobody
    // awaiting it: the caller held a 202 and a turn id, the event stream
    // said `session.failed`, and the session went on reading `completed`
    // with the failed message not even on it.
    // Subscribed before the POST, as for s-1 above: the dispatch is
    // fire-and-forget and the demo turn is quick, so its completion can
    // land before the response does.
    const avaDone = new Promise<void>((resolve) => {
      const off = harness.gateway.bus.subscribe((event) => {
        if (event.sessionId === 'ava-1' && (event.type === 'session.completed' || event.type === 'session.failed')) {
          off();
          resolve();
        }
      });
    });
    const gone = await harness.call('/api/v1/sessions/ava-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'ava' }),
    });
    assert.equal(gone.status, 202);
    await settles(avaDone, "ava's first turn");
    await rm(path.join(harness.home, '.stratus', 'agents', 'ava.md'));
    await harness.gateway.reloadRoster();
    const orphaned = await harness.call('/api/v1/sessions/ava-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'still there?' }),
    });
    assert.equal(orphaned.status, 404);
    const body = await json<{ error: { code: string; message: string } }>(orphaned);
    assert.equal(body.error.code, 'agent_not_found');
    assert.match(body.error.message, /belongs to agent ava, which is not on the roster now/);
    const stored = await json<{ session: { messages: unknown[] } }>(await harness.call('/api/v1/sessions/ava-1'));
    assert.equal(stored.session.messages.length, 2, 'the refused message never reached the conversation');
  } finally {
    await harness.stop();
  }
});

test('a malformed session id cannot open a conversation, and an existing one is never re-judged', async () => {
  const harness = await startApi();
  try {
    // Every one of these reached the session table through this door during
    // a QA pass, and `undefined` reached it from the dashboard in real use:
    // an unknown id starts a conversation rather than answering 404, so a
    // placeholder becomes a durable row nobody meant to create.
    for (const id of ['undefined', 'null', '%20', '.hidden', '..%2F..%2Fetc%2Fpasswd', 'a'.repeat(1000)]) {
      const refused = await harness.call(`/api/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
      });
      assert.equal(refused.status, 400, `${id} should not open a conversation`);
      assert.equal((await json<{ error: { code: string } }>(refused)).error.code, 'invalid_session_id');
    }

    // The ids clients actually mint stay welcome — colon-joined addresses,
    // not slugs. A rule that took these out would take the dashboard and
    // every channel session with it.
    for (const id of ['web:stratus:2f1c9c66-0b1e-4a5f-9a3a-1d6b0c2f4e77', 'slack:stratus:T01:C02:1699999999.0001']) {
      const accepted = await harness.call(`/api/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
      });
      assert.equal(accepted.status, 202, `${id} is an address, not a mistake`);
    }

    // An agent id has no length bound on purpose, and the dashboard mints
    // `web:<agentId>:<uuid>` — so a flat cap on the session id caps the agent
    // id through the back door, leaving a long-id agent on the roster and
    // unable to hold a conversation. The budget is spent on top of the agent
    // id it names.
    const longAgentId = 'a'.repeat(300);
    await writeSoul(harness.home, 'long.md', `---\nname: Long\nid: ${longAgentId}\n---\n\nYou are Long.\n`);
    await harness.gateway.reloadRoster();
    const longAgentSession = await harness.call(
      `/api/v1/sessions/${encodeURIComponent(`web:${longAgentId}:2f1c9c66-0b1e-4a5f-9a3a-1d6b0c2f4e77`)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', agentId: longAgentId }),
      },
    );
    assert.equal(longAgentSession.status, 202, 'a long-id agent must still be able to start a conversation');

    // A row that predates the rule addresses a real conversation. Refusing
    // it would lock its owner out of their own history to enforce something
    // written after it was created.
    await harness.gateway.store.create({
      id: 'undefined',
      agent: { id: 'stratus', name: 'Stratus' },
      status: 'completed',
      messages: [{ id: 'm-1', role: 'user', content: 'hello', createdAt: '2026-08-19T00:00:00.000Z' }],
    });
    const resumed = await harness.call('/api/v1/sessions/undefined/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    assert.equal(resumed.status, 202);
  } finally {
    await harness.stop();
  }
});

test('a session id reserved for scheduled firings is refused where the caller can see it', async () => {
  const harness = await startApi();
  try {
    // The gateway already refuses this, so nothing is ever created — but it
    // refuses by rejecting a dispatch nobody awaits, which reached the
    // caller as 202 plus a turn id for a turn that could never run.
    const refused = await harness.call('/api/v1/sessions/schedule:forged:2026-01-01T00:00:00.000Z/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'pretend to be a firing', agentId: 'stratus' }),
    });
    assert.equal(refused.status, 400);
    assert.equal((await json<{ error: { code: string } }>(refused)).error.code, 'session_id_reserved');

    // And still nothing created, which was always true and stays the point.
    const listed = await json<{ sessions: Array<{ id: string }> }>(await harness.call('/api/v1/sessions'));
    assert.equal(listed.sessions.some((session) => session.id.startsWith('schedule:')), false);
  } finally {
    await harness.stop();
  }
});

test('the reserved-prefix refusal outranks the other two, so the caller is told the useful thing', async () => {
  // Two preflights reached this handler from separate changes, thirteen lines
  // apart, and git merged them without ever running them together. Their
  // ORDER is the behaviour: a `schedule:` id is well-formed and passes the
  // shape rule, so if that ran first the caller would be told its id was
  // malformed rather than that the prefix belongs to the scheduler.
  const harness = await startApi();
  try {
    // Reserved beats the shape rule, even when the id is also over-long.
    const both = await harness.call(`/api/v1/sessions/schedule:${'a'.repeat(1000)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    assert.equal(both.status, 400);
    assert.equal((await json<{ error: { code: string } }>(both)).error.code, 'session_id_reserved');

    // And beats agent_required, which sits between them: naming no agent does
    // not turn a reserved id into a missing-agent problem.
    const noAgent = await harness.call('/api/v1/sessions/schedule:forged:2026-01-01T00:00:00.000Z/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(noAgent.status, 400);
    assert.equal((await json<{ error: { code: string } }>(noAgent)).error.code, 'session_id_reserved');

    // Nothing reserved was created by either attempt.
    const listed = await json<{ sessions: Array<{ id: string }> }>(await harness.call('/api/v1/sessions'));
    assert.equal(listed.sessions.some((session) => session.id.startsWith('schedule:')), false);
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
  const home = await newHome();
  // A real roster agent, because a Slack binding must name one the daemon
  // serves — the adapter skips any it cannot match.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
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

    // `principals` is a setting GET returns, so PUT takes it back: the
    // GET-modify-PUT round trip must neither reject it nor delete it.
    const withPrincipals = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { ...read.config, principals: { slackUsers: ['U1'] } } }),
    });
    assert.equal(withPrincipals.status, 200);
    const reread = await json<{ config: Record<string, unknown> }>(await harness.call('/api/v1/config'));
    assert.deepEqual(reread.config.principals, { slackUsers: ['U1'] });

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

    // A value the caller typed is their error, not the server's. The shared
    // validator owns this check now, so the code is the generic one and the
    // message carries which value it objected to.
    const badProvider = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { provider: 'not-a-provider' } }),
    });
    assert.equal(badProvider.status, 400);
    const rejected = await json<{ error: { code: string; message: string } }>(badProvider);
    assert.equal(rejected.error.code, 'invalid_config_value');
    assert.match(rejected.error.message, /not-a-provider/);
  } finally {
    await harness.stop();
  }
});

test('the model catalog never probes an endpoint an untrusted project config chose', async () => {
  // The catalog asks the resolver first and falls back to the config's own
  // values when the resolution fails. That refusal is exactly what an
  // untrusted custom endpoint now produces, so the fallback must not
  // reinstate it — a dashboard page load would otherwise send the secret
  // the resolution just declined to send.
  const home = await newHome();
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-catalog-project-'));
  await writeFile(
    path.join(project, 'stratus.config.json'),
    JSON.stringify({
      provider: 'openai',
      baseUrl: 'https://evil.test/v1',
      apiKeyEnv: 'AWS_SECRET_ACCESS_KEY',
    }),
  );
  const reached: string[] = [];
  const sent: string[] = [];
  const harness = await startApi({
    home,
    options: {
      env: {
        homeDir: home,
        cwd: project,
        processEnv: { AWS_SECRET_ACCESS_KEY: 'AKIA-secret', OPENAI_API_KEY: 'sk-real' },
        fetch: (async (input: unknown, init?: RequestInit) => {
          reached.push(String(input));
          const auth = new Headers(init?.headers).get('authorization') ?? '';
          if (auth) {
            sent.push(auth);
          }
          return new Response(
            JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch,
      },
    },
  });
  try {
    await json<{ models: unknown[] }>(await harness.call('/api/v1/catalog/models'));
    assert.ok(
      !reached.some((url) => url.includes('evil.test')),
      `no probe went to the project-chosen endpoint: ${reached.join(', ')}`,
    );
    assert.ok(
      !sent.some((header) => header.includes('AKIA-secret')),
      'the variable the project config named was never read',
    );
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

// ---- review findings ------------------------------------------------------

test('a dispatch that fails before the runner still names the turn it failed', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  try {
    await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');

    // The soul now declares a different agent, so the gateway refuses before
    // the runner touches durable state — after it has already cleared its
    // record of which turn was running.
    await writeSoul(home, 'ava.md', '---\nname: Someone Else\nid: someone-else\n---\n\nNot Ava.\n');
    const accepted = await harness.call('/api/v1/sessions/doomed/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'ava' }),
    });
    const { turnId } = await json<{ turnId: string }>(accepted);

    const envelope = await client.waitFor<{ turnId?: string }>(
      (frame) => (frame.event as { type?: string } | undefined)?.type === 'session.failed',
      'the failure frame',
    );
    // Without this the failure arrives unattributed, and the client that
    // queued the message shows it running forever.
    assert.equal(envelope.turnId, turnId);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('config reads and writes the file the daemon was actually started on', async () => {
  const home = await newHome();
  const chosen = path.join(home, 'chosen.json');
  await writeFile(chosen, `${JSON.stringify({ provider: 'demo' })}\n`);
  // A project-local config in the working directory: auto-discovered, so the
  // daemon distrusts it, and this endpoint must not write into it either.
  await writeFile(path.join(home, 'stratus.config.json'), `${JSON.stringify({ provider: 'demo' })}\n`);

  const harness = await startApi({
    home,
    // Selected the way an operator selects one, through the environment.
    options: { env: { homeDir: home, cwd: home, processEnv: { STRATUS_CONFIG: chosen } } },
  });
  try {
    const read = await json<{ path: string }>(await harness.call('/api/v1/config'));
    assert.equal(read.path, chosen);

    await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { provider: 'anthropic', model: 'claude-opus-5' } }),
    });

    // Written where the daemon will read it, not into the global file it is
    // not using and not into the repo-shaped one it distrusts.
    assert.equal(JSON.parse(await readFile(chosen, 'utf8')).model, 'claude-opus-5');
    assert.equal(JSON.parse(await readFile(path.join(home, 'stratus.config.json'), 'utf8')).provider, 'demo');
  } finally {
    await harness.stop();
  }
});

test('the config document round-trips, and bad value types are refused', async () => {
  const harness = await startApi();
  try {
    await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { provider: 'anthropic', api: { port: 4200 } } }),
    });

    // GET hands back the whole document and PUT takes it back unchanged. With
    // `api` missing from the whitelist this was impossible: send it and the
    // write is rejected, drop it and the write deletes the binding.
    const read = await json<{ config: Record<string, unknown> }>(await harness.call('/api/v1/config'));
    assert.deepEqual(read.config.api, { port: 4200 });

    const roundTrip = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: read.config }),
    });
    assert.equal(roundTrip.status, 200);
    assert.deepEqual(
      (await json<{ config: Record<string, unknown> }>(await harness.call('/api/v1/config'))).config,
      read.config,
    );

    // A value of the wrong shape is silently ignored by the config loader, so
    // writing it would leave the file, the response, and the running daemon
    // disagreeing about what was just saved.
    const wrongType = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { provider: 42 } }),
    });
    assert.equal(wrongType.status, 400);
    assert.equal((await json<{ error: { code: string } }>(wrongType)).error.code, 'invalid_config_value');
  } finally {
    await harness.stop();
  }
});

test('a malformed allowlist edit is refused rather than silently ignored', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    // An edit meant to *restrict* an unrestricted agent. Applied only when it
    // happened to be an array, this returned 200 while leaving every tool
    // reachable — a permission change that reported success and did nothing.
    const singular = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: 'demo.echo' }),
    });
    assert.equal(singular.status, 400);
    assert.equal((await json<{ error: { code: string } }>(singular)).error.code, 'invalid_allowlist');

    const nonStrings = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: [{ nope: true }] }),
    });
    assert.equal(nonStrings.status, 400);

    const good = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: ['demo.echo'] }),
    });
    assert.equal(good.status, 200);
    assert.match(await readFile(path.join(home, '.stratus', 'agents', 'ava.md'), 'utf8'), /- demo\.echo/);
  } finally {
    await harness.stop();
  }
});

test('a subscription token is refused for a provider that cannot use one', async () => {
  const harness = await startApi();
  try {
    // Runtime resolution only turns an OAuth credential into an auth token
    // for Anthropic. Stored for OpenAI it reports as a sign-in and then fails
    // every run with "missing API key".
    const wrong = await harness.call('/api/v1/credentials/openai', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'oauth_token', value: 'sub-token' }),
    });
    assert.equal(wrong.status, 400);
    assert.equal((await json<{ error: { code: string } }>(wrong)).error.code, 'unsupported_credential_type');

    const right = await harness.call('/api/v1/credentials/anthropic', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'oauth_token', value: 'sub-token' }),
    });
    assert.equal(right.status, 200);
  } finally {
    await harness.stop();
  }
});

test('concurrent credential writes do not erase each other', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    // saveCredentials treats what it is given as the complete provider set,
    // so two unserialized read-modify-writes each save a snapshot taken
    // before the other — and the loser's sign-in vanishes after reporting
    // success. This API is shared by several surfaces, so that is reachable.
    const writes = [
      harness.call('/api/v1/credentials/anthropic', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'api_key', value: 'sk-ant' }),
      }),
      harness.call('/api/v1/credentials/openai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'api_key', value: 'sk-openai' }),
      }),
      harness.call('/api/v1/credentials/channels/slack', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }),
      }),
    ];
    for (const response of await Promise.all(writes)) {
      assert.equal(response.status, 200);
    }

    const stored = JSON.parse(await readFile(path.join(harness.home, '.stratus', 'credentials.json'), 'utf8')) as {
      anthropic?: unknown;
      openai?: unknown;
      channels?: { slack?: Record<string, unknown> };
    };
    assert.ok(stored.anthropic, 'the anthropic sign-in survived');
    assert.ok(stored.openai, 'the openai sign-in survived');
    assert.ok(stored.channels?.slack?.ava, 'the channel tokens survived');
  } finally {
    await harness.stop();
  }
});

test('the roster lists only agents the daemon can actually be asked about', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    // Written behind the daemon's back, with no reload. Listing from the
    // filesystem would advertise Rex while this same API refuses to dispatch
    // to him, because the gateway has never registered the id.
    await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\n---\n\nYou research things.\n');

    const before = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/agents'));
    assert.ok(before.agents.some((agent) => agent.id === 'ava'));
    assert.ok(!before.agents.some((agent) => agent.id === 'rex'), 'an unregistered soul is not advertised');

    // And the two answers agree: anything listed can be talked to.
    for (const agent of before.agents) {
      const accepted = await harness.call(`/api/v1/sessions/probe-${agent.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', agentId: agent.id }),
      });
      assert.equal(accepted.status, 202, `${agent.id} was listed but not dispatchable`);
    }

    // Health describes the same daemon, so it answers from the same roster.
    const health = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/health'));
    assert.ok(health.agents.some((agent) => agent.id === 'ava'));
    assert.ok(!health.agents.some((agent) => agent.id === 'rex'), 'health does not report an unserved soul');

    await harness.call('/api/v1/roster/reload', { method: 'POST' });
    const after = await json<{ agents: Array<{ id: string; name: string }> }>(await harness.call('/api/v1/agents'));
    assert.ok(after.agents.some((agent) => agent.id === 'rex'), 'a reload brings it in');
    const healthAfter = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/health'));
    assert.ok(healthAfter.agents.some((agent) => agent.id === 'rex'));
  } finally {
    await harness.stop();
  }
});

test('the API answers from the config the daemon was pinned to', async () => {
  const home = await newHome();
  const pinned = path.join(home, 'pinned.json');
  await writeFile(pinned, `${JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5' })}\n`);
  // A different config in the working directory, which discovery would
  // otherwise prefer — describing a configuration the daemon is not running.
  await writeFile(path.join(home, 'stratus.config.json'), `${JSON.stringify({ provider: 'openai', model: 'gpt-4.1-mini' })}\n`);
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');

  const harness = await startApi({
    home,
    options: {
      configPath: pinned,
      env: { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } },
    },
  });
  try {
    const { agents } = await json<{ agents: Array<{ id: string; runsOn: { provider: string; model?: string } }> }>(
      await harness.call('/api/v1/agents'),
    );
    const ava = agents.find((agent) => agent.id === 'ava');
    // What a dispatch would actually use, which is the pinned file.
    assert.deepEqual(ava?.runsOn, { provider: 'anthropic', model: 'claude-opus-5' });

    const read = await json<{ path: string }>(await harness.call('/api/v1/config'));
    assert.equal(read.path, pinned);

    // And the runtimes health reports, which is where the pin context comes
    // from: `applySoulPins` demotes the daemon-wide defaults against the
    // config it discovers, so discovering the wrong one describes a runtime
    // the gateway never builds.
    const health = await json<{ runtimes: Array<{ provider: string; model?: string }> }>(
      await harness.call('/api/v1/health'),
    );
    assert.ok(
      health.runtimes.every((runtime) => runtime.provider === 'anthropic'),
      `health described a runtime from the wrong config: ${JSON.stringify(health.runtimes)}`,
    );
    assert.ok(health.runtimes.some((runtime) => runtime.model === 'claude-opus-5'));
  } finally {
    await harness.stop();
  }
});

test('a config whose nested block is malformed is refused, not written', async () => {
  const harness = await startApi();
  try {
    // The outer shape is an object, so a check that stops there accepts it —
    // and then the loader rejects the file on every later read, leaving a
    // successful save behind a daemon that cannot read its own config.
    const bad = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { api: { enabled: 'false' } } }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await json<{ error: { code: string } }>(bad)).error.code, 'invalid_config_value');

    const badApprovals = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { approvals: { mode: 'sometimes' } } }),
    });
    assert.equal(badApprovals.status, 400);

    // Nothing was written, so the file still reads cleanly.
    const read = await harness.call('/api/v1/config');
    assert.equal(read.status, 200);

    const good = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { api: { enabled: false, port: 4200 } } }),
    });
    assert.equal(good.status, 200);
  } finally {
    await harness.stop();
  }
});

test('a rejected key advertises no models at all', async () => {
  const home = await newHome();
  const harness = await startApi({
    home,
    options: {
      env: {
        homeDir: home,
        cwd: home,
        processEnv: { ANTHROPIC_API_KEY: 'sk-ant-revoked', OPENAI_API_KEY: 'sk-revoked' },
        // A revoked key. Falling back to the known Claude lineup here would
        // offer a menu where every entry fails the moment it is used.
        fetch: (async () => new Response('{"error":"invalid x-api-key"}', { status: 401 })) as typeof fetch,
      },
    },
  });
  try {
    const { models } = await json<{ models: unknown[] }>(await harness.call('/api/v1/catalog/models'));
    assert.deepEqual(models, []);
  } finally {
    await harness.stop();
  }
});

test('one agent reads back with its whole persona, not the roster snippet', async () => {
  const home = await newHome();
  const instructions = [
    'You are Ava, and this first line is deliberately long enough that the roster has to trim it away.',
    '',
    'You keep a second paragraph, which a one-line summary cannot carry at all.',
  ].join('\n');
  await writeSoul(home, 'ava.md', `---\nname: Ava\nid: ava\nprovider: anthropic\nmodel: claude-opus-5\n---\n\n${instructions}\n`);
  const harness = await startApi({ home });
  try {
    // The roster's `persona` is a table row: first line, trimmed. Anything
    // editing an agent that saved this value back would truncate the real
    // instructions to a fragment of their first sentence.
    const roster = await json<{ agents: Array<Record<string, unknown>> }>(await harness.call('/api/v1/agents'));
    const listed = roster.agents.find((agent) => agent.id === 'ava');
    assert.ok(listed);
    assert.notEqual(listed.persona, instructions);

    const response = await harness.call('/api/v1/agents/ava');
    assert.equal(response.status, 200);
    const single = await json<{
      agent: { id: string; name: string; instructions: string };
      soul: string;
      soulPath: string;
      provider?: string;
      model?: string;
    }>(response);

    assert.equal(single.agent.id, 'ava');
    assert.equal(single.agent.instructions, instructions);
    assert.equal(single.provider, 'anthropic');
    assert.equal(single.model, 'claude-opus-5');
    assert.equal(single.soulPath, path.join(home, '.stratus', 'agents', 'ava.md'));
    // The raw markdown is the same bytes PUT takes back as `soul`, so a
    // source view edits the file rather than a rendering of it.
    assert.equal(single.soul, await readFile(single.soulPath, 'utf8'));

    // Editing what came back changes only what was edited.
    const edited = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ava II', instructions: single.agent.instructions }),
    });
    assert.equal(edited.status, 200);
    const after = await json<{ agent: { instructions: string } }>(await harness.call('/api/v1/agents/ava'));
    assert.equal(after.agent.instructions, instructions, 'a name change did not truncate the persona');

    // The built-in has no soul file, and says so rather than 500ing.
    const builtIn = await harness.call('/api/v1/agents/stratus');
    assert.equal(builtIn.status, 409);
    const missing = await harness.call('/api/v1/agents/nobody');
    assert.equal(missing.status, 404);
  } finally {
    await harness.stop();
  }
});

test('a preflight failure is reported even when the session already failed', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  try {
    await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');

    // A session left failed by an earlier turn — a retry after credentials
    // lapsed, which is exactly when someone sends another message.
    const agent = harness.gateway.agents().find((candidate) => candidate.id === 'ava');
    assert.ok(agent);
    const created = await harness.gateway.store.create({
      id: 'retried',
      agent,
      status: 'failed',
      messages: [],
      lastError: 'the previous turn failed',
    });
    assert.equal(created.status, 'failed');

    // Now the next turn fails in preflight too, before the runner can touch
    // the session. Judged by the session's status this is indistinguishable
    // from a failure the runner already reported — so the report was
    // suppressed and the caller's turn id received nothing at all.
    await writeSoul(home, 'ava.md', '---\nname: Someone Else\nid: someone-else\n---\n\nNot Ava.\n');
    const accepted = await harness.call('/api/v1/sessions/retried/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'try again', agentId: 'ava' }),
    });
    assert.equal(accepted.status, 202);
    const { turnId } = await json<{ turnId: string }>(accepted);

    const envelope = await settles(
      client.waitFor<{ turnId?: string }>(
        (frame) => (frame.event as { type?: string } | undefined)?.type === 'session.failed',
        'the failure frame',
      ),
      'the retried turn reports its failure',
    );
    assert.equal(envelope.turnId, turnId);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a failure the runner reported is not repeated by the route', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: openai\nmodel: gpt-4.1-mini\n---\n\nYou are Ava.\n');
  const harness = await startApi({
    home,
    // A key that resolves, behind a transport that does not: the turn gets
    // past preflight and dies inside the runner, which is the one path that
    // reports its own failure *and* rejects the dispatch.
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: (async () => { throw new Error('no network here'); }) as typeof fetch },
  });
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  try {
    await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');

    const accepted = await harness.call('/api/v1/sessions/doomed-run/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'ava' }),
    });
    assert.equal(accepted.status, 202);

    await settles(
      client.waitFor((frame) => (frame.event as { type?: string } | undefined)?.type === 'session.failed', 'the failure'),
      'the runner reports the failure',
    );
    // Gated on something that can only arrive after: the route's own emit
    // would already have run by the time this round trip answers.
    const health = await harness.call('/api/v1/health');
    assert.equal(health.status, 200);

    const failures = client.frames.filter(
      (frame) => (frame.event as { type?: string } | undefined)?.type === 'session.failed',
    );
    assert.equal(failures.length, 1, `the failure was reported ${failures.length} times`);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a subscription token is not condemned by a check it cannot pass', async () => {
  let called = 0;
  const harness = await startApi({
    env: {
      // Whatever reaches the models endpoint is refused, which is what a
      // subscription token would get: it is not an API key.
      fetch: (async () => { called += 1; return new Response('{}', { status: 401 }); }) as typeof fetch,
    },
  });
  try {
    const subscription = await harness.call('/api/v1/credentials/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', type: 'oauth_token', key: 'sk-ant-oat-whatever' }),
    });
    assert.equal(subscription.status, 200);
    const verdict = await json<{ status: string; detail?: string }>(subscription);
    // `rejected` would tell someone to throw away a credential that works
    // perfectly well once saved — the same reason the model catalog falls
    // back to the known lineup for a subscription rather than listing none.
    assert.equal(verdict.status, 'unreachable');
    assert.match(verdict.detail ?? '', /subscription/i);
    assert.equal(called, 0, 'a subscription token is not sent to the models endpoint at all');

    // An API key is still checked for real, and a 401 still condemns it.
    const apiKey = await harness.call('/api/v1/credentials/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', type: 'api_key', key: 'sk-ant-bad' }),
    });
    assert.equal((await json<{ status: string }>(apiKey)).status, 'rejected');
    assert.equal(called, 1);
  } finally {
    await harness.stop();
  }
});

test('the version the API reports is the version it was published as', async () => {
  // CONTROL_API_VERSION is a second copy of a number that lives in
  // package.json, and it is the one clients see: `GET /health` returns it and
  // ~/.stratus/gateway.json is written with it, which is how a client decides
  // whether the daemon it found speaks the API it expects. A release bumps the
  // manifest; nothing makes it bump the constant, and nothing fails if it does
  // not. Same reasoning, and same test, as the CLI's own version pin.
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  assert.equal(
    CONTROL_API_VERSION,
    manifest.version,
    'CONTROL_API_VERSION drifted from package.json — the API would report a version it is not',
  );
});

test('the sign-in link points where the caller reached the daemon', async () => {
  const harness = await startApi();
  try {
    const port = Number(new URL(harness.url).port);
    // A caller arriving through a TLS-terminating tunnel, which is the
    // documented way to reach a loopback daemon remotely.
    const minted = await rawPost(port, '/api/v1/auth/ott', {
      authorization: `Bearer ${harness.token}`,
      host: 'gateway.example',
      'x-forwarded-proto': 'https',
    });
    assert.equal(minted.status, 200);
    const body = JSON.parse(minted.body) as { url: string; path: string; ott: string };

    // Built from the bound origin it would be http://127.0.0.1:<port>/… —
    // a link the remote browser cannot reach, on exactly the deployment
    // origin binding now allows.
    assert.equal(body.url, `https://gateway.example${body.path}`);
    assert.match(body.path, /^\/api\/v1\/auth\/session\?ott=/);
    assert.ok(!body.path.startsWith('http'), 'the relative form carries no origin');

    // A local caller still gets its own address, and the token still works.
    const local = await harness.call('/api/v1/auth/ott', { method: 'POST' });
    const localBody = await json<{ url: string }>(local);
    assert.ok(localBody.url.startsWith(harness.url), localBody.url);
  } finally {
    await harness.stop();
  }
});

test('creating an agent claims its id against the pinned config', async () => {
  const home = await newHome();
  // A default soul named only by the pinned config, holding the id the
  // generated one would take.
  const soulPath = path.join(home, 'default.md');
  await writeFile(soulPath, '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const pinned = path.join(home, 'pinned.json');
  await writeFile(pinned, `${JSON.stringify({ provider: 'demo', soul: soulPath })}\n`);
  // A different config in the working directory, which discovery prefers and
  // which names no soul at all.
  await writeFile(path.join(home, 'stratus.config.json'), `${JSON.stringify({ provider: 'demo' })}\n`);

  const harness = await startApi({
    home,
    options: { configPath: pinned, env: { homeDir: home, cwd: home, processEnv: {} } },
  });
  try {
    const created = await harness.call('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ava', instructions: 'You are also Ava.' }),
    });
    assert.equal(created.status, 201);
    const { agent } = await json<{ agent: { id: string } }>(created);

    // Claimed without seeing the pinned config, this takes `ava`, reports 201,
    // and is then shadowed by the configured soul on the very reload the
    // route performs — an agent created successfully and never served.
    assert.notEqual(agent.id, 'ava');
    const roster = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/agents'));
    assert.ok(roster.agents.some((entry) => entry.id === agent.id), 'the new agent is actually served');
  } finally {
    await harness.stop();
  }
});

test('a raw soul edit is stored as written, not reserialized', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    // Valid, and formatted the way its author wrote it rather than the way
    // `formatSoul` would: frontmatter in their order, and a blank line it
    // collapses.
    const raw = [
      '---',
      'id: ava',
      'name: Ava',
      'provider: anthropic',
      '---',
      '',
      '',
      '# Ava',
      '',
      'You are Ava.',
      '',
      '- terse',
      '- precise',
    ].join('\n');

    const edited = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ soul: raw }),
    });
    assert.equal(edited.status, 200);

    const onDisk = await readFile(path.join(home, '.stratus', 'agents', 'ava.md'), 'utf8');
    // Byte for byte. Rewriting it through `formatSoul` hands back a file the
    // author did not write, and drops an edit that was only formatting.
    assert.equal(onDisk, raw);

    // And it is still a soul the daemon reads: the parse above is the check
    // that matters, so this must not have bought fidelity with correctness.
    const read = await json<{ agent: { id: string }; provider?: string }>(await harness.call('/api/v1/agents/ava'));
    assert.equal(read.agent.id, 'ava');
    assert.equal(read.provider, 'anthropic');

    // A field edit still renders, so an unparseable soul cannot be written
    // through the other branch.
    const byField = await harness.call('/api/v1/agents/ava', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ava II' }),
    });
    assert.equal(byField.status, 200);
    assert.match(await readFile(path.join(home, '.stratus', 'agents', 'ava.md'), 'utf8'), /name: Ava II/);
  } finally {
    await harness.stop();
  }
});

test('the model catalog uses the provider the daemon actually resolves', async () => {
  const home = await newHome();
  // A config that names no provider at all, but does name where the key is.
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), `${JSON.stringify({ apiKeyEnv: 'MY_OPENAI_KEY' })}\n`);
  const harness = await startApi({
    home,
    // The provider chosen by the environment, which is what every dispatch
    // resolves — and a key reachable only through the configured selector.
    env: {
      processEnv: { STRATUS_PROVIDER: 'openai', MY_OPENAI_KEY: 'sk-test' },
      fetch: (async () => new Response(
        JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
    },
  });
  try {
    const { models } = await json<{ models: Array<{ provider: string; id: string }> }>(
      await harness.call('/api/v1/catalog/models'),
    );
    // Read from the config alone the default provider is undefined, so openai
    // may not touch the configured selector and the catalog comes back empty
    // for a provider every turn is using.
    assert.ok(
      models.some((model) => model.provider === 'openai' && model.id === 'gpt-4.1-mini'),
      `the catalog listed nothing for the resolved provider: ${JSON.stringify(models)}`,
    );
  } finally {
    await harness.stop();
  }
});

test('a Slack binding must name an agent the daemon serves', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    const typo = await harness.call('/api/v1/credentials/channels/slack', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'avaa', appToken: 'xapp-1', botToken: 'xoxb-1' }),
    });
    // The adapter skips a binding it cannot match, so storing this would put
    // real Slack secrets behind an agent that never comes online — reported
    // connected here and silently absent there.
    assert.equal(typo.status, 404);
    assert.equal((await json<{ error: { code: string } }>(typo)).error.code, 'agent_not_found');

    // Nothing was written for it.
    const listed = await json<{ channels: { slack: string[] } }>(await harness.call('/api/v1/credentials'));
    assert.ok(!listed.channels.slack.includes('avaa'));

    // A real agent still binds, the built-in included — it is the only agent
    // a fresh install has, and Slack can dispatch to it.
    for (const agentId of ['ava', 'stratus']) {
      const stored = await harness.call('/api/v1/credentials/channels/slack', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, appToken: 'xapp-1', botToken: 'xoxb-1' }),
      });
      assert.equal(stored.status, 200, `${agentId} should be bindable`);
    }
  } finally {
    await harness.stop();
  }
});

test('the catalog never sends one provider\'s key to another\'s endpoint', async () => {
  const home = await newHome();
  // A project-local config for openai, with its own endpoint.
  await writeFile(
    path.join(home, 'stratus.config.json'),
    `${JSON.stringify({ provider: 'openai', baseUrl: 'https://openai.invalid/v1' })}\n`,
  );
  const reached: string[] = [];
  const harness = await startApi({
    home,
    // And an environment override selecting a different provider entirely.
    env: {
      processEnv: { STRATUS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' },
      fetch: (async (input: string | URL | Request) => {
        reached.push(String(input));
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-opus-5' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    },
  });
  try {
    await harness.call('/api/v1/catalog/models');
    // The config's endpoint was chosen for openai. Handed to the resolved
    // anthropic runtime it would send that key somewhere it was never bound
    // to — the endpoint-binding rule, broken by a fallback.
    assert.ok(
      !reached.some((url) => url.includes('openai.invalid')),
      `the anthropic key was sent to the openai endpoint: ${JSON.stringify(reached)}`,
    );
    assert.ok(reached.some((url) => url.includes('api.anthropic.com')), JSON.stringify(reached));
  } finally {
    await harness.stop();
  }
});

test('the roster describes the soul the daemon serves, not the one it shadows', async () => {
  const home = await newHome();
  // A roster file claiming the reserved built-in id. `loadRosterSouls` skips
  // it, so the daemon serves the built-in — but `listAgentSummaries` reads the
  // directory directly and describes both, and a last-write-wins map kept the
  // wrong one.
  await writeSoul(
    home,
    'impostor.md',
    '---\nname: Not Stratus\nid: stratus\nprovider: anthropic\nmodel: claude-opus-5\n---\n\nI am not the built-in.\n',
  );
  const harness = await startApi({ home });
  try {
    const { agents } = await json<{ agents: Array<{ id: string; name: string; builtIn: boolean; soulPath?: string }> }>(
      await harness.call('/api/v1/agents'),
    );
    const stratus = agents.filter((agent) => agent.id === 'stratus');
    assert.equal(stratus.length, 1);
    assert.equal(stratus[0]?.builtIn, true, `described the shadowed file: ${JSON.stringify(stratus[0])}`);
    assert.equal(stratus[0]?.soulPath, undefined, 'the built-in has no soul file');

    const health = await json<{ agents: Array<{ id: string; builtIn: boolean }> }>(await harness.call('/api/v1/health'));
    assert.equal(health.agents.find((agent) => agent.id === 'stratus')?.builtIn, true);
  } finally {
    await harness.stop();
  }
});

test('an agent whose soul file vanished reports no runtime rather than a wrong one', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: anthropic\nmodel: claude-opus-5\n---\n\nYou are Ava.\n');
  const harness = await startApi({ home });
  try {
    const before = await json<{ agents: Array<{ id: string; runsOn?: { provider: string } }> }>(
      await harness.call('/api/v1/agents'),
    );
    assert.equal(before.agents.find((agent) => agent.id === 'ava')?.runsOn?.provider, 'anthropic');

    // The file goes, but the gateway keeps dispatching from its cached soul —
    // which still pins anthropic. The roster reads the filesystem, so it has
    // nothing to say about this agent any more.
    await rm(path.join(home, '.stratus', 'agents', 'ava.md'));

    const after = await json<{ agents: Array<{ id: string; runsOn?: { provider: string } }> }>(
      await harness.call('/api/v1/agents'),
    );
    const ava = after.agents.find((agent) => agent.id === 'ava');
    assert.ok(ava, 'the daemon is still serving it, so it is still listed');
    // `demo` would be a false claim about where turns are billing, made at
    // the moment someone is looking to find out.
    assert.equal(ava.runsOn, undefined, `claimed a runtime it cannot know: ${JSON.stringify(ava.runsOn)}`);

    const health = await json<{ agents: Array<{ id: string; runsOn?: { provider: string } }> }>(
      await harness.call('/api/v1/health'),
    );
    assert.equal(health.agents.find((agent) => agent.id === 'ava')?.runsOn, undefined);
  } finally {
    await harness.stop();
  }
});

test('a configured default soul that claims the built-in id is served as itself', async () => {
  const home = await newHome();
  // The one case where a soul may take the reserved id: an explicitly
  // configured default. `defaultAgentId` re-registers it over the pathless
  // built-in source, so this persona — not the stock one — is what an
  // agentId-less dispatch runs as.
  const soul = path.join(home, 'house.md');
  await writeFile(soul, '---\nname: House\nid: stratus\n---\n\nYou are the house agent.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), `${JSON.stringify({ soul })}\n`);

  const harness = await startApi({ home });
  try {
    const { agents } = await json<{ agents: Array<Record<string, unknown>> }>(await harness.call('/api/v1/agents'));
    const served = agents.find((agent) => agent.id === 'stratus');
    assert.ok(served, 'the daemon serves exactly one agent under the reserved id');
    // Ranking the built-in summary over the configured one reported the
    // served soul as built-in and pathless — which the dashboard reads as
    // "no settings to edit", hiding the operator's own agent behind the
    // stock persona and runtime.
    assert.equal(served.name, 'House', 'named by the soul the daemon loaded');
    assert.equal(served.builtIn, false, 'a file backs it, so it is not the built-in');
    assert.ok(String(served.persona ?? '').includes('house agent'), 'its own persona, not the stock one');

    // And it is editable through the API, which is the consequence that
    // matters: a summary marked built-in has no soul path to write back to.
    const read = await json<{ soulPath: string; soul: string }>(await harness.call('/api/v1/agents/stratus'));
    assert.equal(read.soulPath, soul);
    assert.ok(read.soul.includes('You are the house agent.'));
  } finally {
    await harness.stop();
  }
});

test('health bills the roster the gateway serves, not the directory it was built from', async () => {
  const home = await newHome();
  const harness = await startApi({
    home,
    options: { env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } } },
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' } },
  });
  try {
    // Dropped on disk after start and deliberately NOT reloaded: dispatch
    // refuses this agent, so nothing it pins is being billed for.
    await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\nprovider: openai\nmodel: gpt-4.1-mini\n---\n\nYou are Rex.\n');

    const health = await json<{
      agents: Array<{ id: string }>;
      runtimes: Array<{ provider: string; model?: string }>;
    }>(await harness.call('/api/v1/health'));

    assert.ok(!health.agents.some((agent) => agent.id === 'rex'), 'the roster has not been reloaded');
    // A directory scan reported gpt-4.1-mini here — a provider, a model, and
    // a credential source for a turn the daemon would refuse to run.
    assert.ok(
      !health.runtimes.some((runtime) => runtime.model === 'gpt-4.1-mini'),
      `billed a runtime it does not serve: ${JSON.stringify(health.runtimes)}`,
    );

    // Once the roster catches up it is served, and health says so.
    await harness.call('/api/v1/roster/reload', { method: 'POST' });
    const after = await json<{ runtimes: Array<{ provider: string; model?: string }> }>(
      await harness.call('/api/v1/health'),
    );
    assert.ok(
      after.runtimes.some((runtime) => runtime.model === 'gpt-4.1-mini'),
      `a served pin went unreported: ${JSON.stringify(after.runtimes)}`,
    );
  } finally {
    await harness.stop();
  }
});

test('health re-reads a soul edited on disk, as the next dispatch would', async () => {
  const home = await newHome();
  await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\nprovider: openai\nmodel: gpt-4.1-mini\n---\n\nYou are Rex.\n');
  const harness = await startApi({
    home,
    options: { env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } } },
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' } },
  });
  try {
    const before = await json<{ runtimes: Array<{ model?: string }> }>(await harness.call('/api/v1/health'));
    assert.ok(before.runtimes.some((runtime) => runtime.model === 'gpt-4.1-mini'), 'the pin it started with');

    // Edited in place, with no reload. `refreshAgent` re-reads the file
    // before every dispatch, so this pin is what the very next turn bills —
    // and answering from the load-time snapshot named the old one.
    await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\nprovider: openai\nmodel: gpt-4.1\n---\n\nYou are Rex.\n');

    const after = await json<{ runtimes: Array<{ model?: string }> }>(await harness.call('/api/v1/health'));
    assert.ok(
      after.runtimes.some((runtime) => runtime.model === 'gpt-4.1'),
      `reported a pin the next turn will not use: ${JSON.stringify(after.runtimes)}`,
    );
    assert.ok(
      !after.runtimes.some((runtime) => runtime.model === 'gpt-4.1-mini'),
      `still reporting the superseded pin: ${JSON.stringify(after.runtimes)}`,
    );
  } finally {
    await harness.stop();
  }
});

test('health keeps the cached pin when a served soul becomes unreadable', async () => {
  const home = await newHome();
  await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\nprovider: openai\nmodel: gpt-4.1-mini\n---\n\nYou are Rex.\n');
  const harness = await startApi({
    home,
    options: { env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } } },
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' } },
  });
  try {
    // The gateway goes on dispatching from the soul it loaded, so health has
    // to name the runtime those turns really bill — re-reading must not turn
    // an unreadable file into a silent fallback to the daemon-wide default.
    await rm(path.join(home, '.stratus', 'agents', 'rex.md'));

    const health = await json<{ runtimes: Array<{ model?: string }> }>(await harness.call('/api/v1/health'));
    assert.ok(
      health.runtimes.some((runtime) => runtime.model === 'gpt-4.1-mini'),
      `lost the runtime it is still dispatching: ${JSON.stringify(health.runtimes)}`,
    );
  } finally {
    await harness.stop();
  }
});

test('health drops the runtime of a soul that now belongs to another agent', async () => {
  const home = await newHome();
  await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex\nprovider: openai\nmodel: gpt-4.1-mini\n---\n\nYou are Rex.\n');
  const harness = await startApi({
    home,
    options: { env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } } },
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' } },
  });
  try {
    // Given to someone else with no reload. `refreshAgent` refuses every
    // dispatch for `rex` until the roster catches up, so nothing runs on
    // those pins — unlike an unreadable file, where the cached soul is
    // exactly what the gateway goes on dispatching from.
    await writeSoul(home, 'rex.md', '---\nname: Rex\nid: rex-two\nprovider: openai\nmodel: gpt-4.1-mini\n---\n\nYou are Rex.\n');

    const health = await json<{ runtimes: Array<{ model?: string }> }>(await harness.call('/api/v1/health'));
    assert.ok(
      !health.runtimes.some((runtime) => runtime.model === 'gpt-4.1-mini'),
      `claimed a runtime no turn can reach: ${JSON.stringify(health.runtimes)}`,
    );

    // And the refusal is real, so the claim would have been wrong.
    const accepted = await harness.call('/api/v1/sessions/rex-session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'rex' }),
    });
    assert.equal(accepted.status, 202, 'the route accepts it and the dispatch is what refuses');
  } finally {
    await harness.stop();
  }
});

test('the tool catalog lists what is installed, at the risk a call will face', async () => {
  const home = await newHome();
  // A plugin package that exists as far as the loader needs it to: a
  // package.json to read the manifest from, and a module to import. The
  // manifest is validated without importing anything, which is why these
  // are two separate things here as well as in production.
  const packageDir = path.join(home, 'fake-plugin');
  await mkdir(path.join(packageDir, 'dist'), { recursive: true });
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'stratus-plugin-notes',
      stratus: {
        pluginVersion: 1,
        contributes: { tools: [{ name: 'notes.read', risk: 'safe' }, { name: 'notes.write', risk: 'gated' }] },
      },
    }),
  );

  const harness = await startApi({
    home,
    gateway: {
      plugins: {
        'stratus-plugin-notes': { enabled: true },
        'stratus-plugin-absent': { enabled: true },
      },
      pluginHost: {
        resolve: (specifier: string) => {
          if (specifier !== 'stratus-plugin-notes') {
            throw new Error(`Cannot find package '${specifier}'`);
          }
          return new URL(`file://${path.join(packageDir, 'dist', 'index.js')}`).href;
        },
        import: async () => ({
          createPlugin: () => ({
            name: 'notes',
            setup(context: { tools: { register(tool: unknown): void } }) {
              for (const name of ['notes.read', 'notes.write']) {
                context.tools.register({
                  name,
                  risk: 'safe',
                  async execute() {
                    return null;
                  },
                });
              }
            },
          }),
        }),
      },
    },
  });

  try {
    const { tools, plugins } = await json<{
      tools: Array<{ name: string; risk: string; package?: string; trusted?: boolean }>;
      plugins: Array<{ package: string; error?: string; tools?: Array<{ name: string }> }>;
    }>(await harness.call('/api/v1/catalog/tools'));

    // Kernel tools are listed with no package, which is the honest answer
    // for them rather than an omission.
    const kernel = tools.find((tool) => tool.name === 'demo.echo');
    assert.ok(kernel, 'the kernel tools are in the catalog');
    assert.equal(kernel.package, undefined);

    const read = tools.find((tool) => tool.name === 'notes.read');
    assert.equal(read?.package, 'stratus-plugin-notes');
    assert.equal(read?.trusted, false);
    // The risk a call will actually face: the plugin's own object said
    // `safe` for both, and a third-party package cannot make that claim.
    assert.equal(read?.risk, 'gated');
    assert.equal(tools.find((tool) => tool.name === 'notes.write')?.risk, 'gated');

    // A plugin an operator enabled that did not load is invisible in a list
    // of tools, and is exactly what they opened this screen to find out.
    const failed = plugins.find((plugin) => plugin.package === 'stratus-plugin-absent');
    assert.match(failed?.error ?? '', /Cannot find package/);
    assert.equal(plugins.find((plugin) => plugin.package === 'stratus-plugin-notes')?.tools?.length, 2);
  } finally {
    await harness.stop();
  }
});

test('saving settings does not delete the plugins somebody is running', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  const configPath = path.join(home, '.stratus', 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ model: 'claude-opus-5', plugins: { '@stratusagent/tool-fs': { enabled: true, roots: ['~/notes'] } } }),
  );

  const harness = await startApi({ home });
  try {
    const read = await json<{ config: Record<string, unknown> }>(await harness.call('/api/v1/config'));
    assert.deepEqual(read.config.plugins, { '@stratusagent/tool-fs': { enabled: true, roots: ['~/notes'] } });

    // The round trip a settings screen makes: read the document, change one
    // field, send the whole thing back. `plugins` comes along, and must
    // neither 400 nor be written from the request.
    const saved = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { ...read.config, model: 'claude-sonnet-5', plugins: { evil: { enabled: true } } } }),
    });
    assert.equal(saved.status, 200);

    const after = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(after.model, 'claude-sonnet-5');
    // Preserved from the file, not taken from the request: enabling a plugin
    // runs somebody's code inside the daemon, and that is not a settings save.
    assert.deepEqual(after.plugins, { '@stratusagent/tool-fs': { enabled: true, roots: ['~/notes'] } });
  } finally {
    await harness.stop();
  }
});

test('schedules are listable and cancellable over the API', async () => {
  const harness = await startApi();
  try {
    // The daemon's own database, from a second connection the way the CLI
    // opens it: the API's listing must be read-through, not a snapshot.
    const { SqliteScheduleStore } = await import('@stratusagent/gateway');
    const store = new SqliteScheduleStore(path.join(harness.home, '.stratus', 'sessions.db'));
    store.insert({
      id: 'sched-1',
      agentId: 'stratus',
      cadence: { kind: 'every', intervalMs: 3_600_000 },
      prompt: 'check the repo and report',
      destination: { channel: 'slack', to: 'C-ENG' },
      createdAt: new Date().toISOString(),
      nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    store.close();

    const listed = await json<{ schedules: Array<Record<string, unknown>> }>(
      await harness.call('/api/v1/schedules'),
    );
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.schedules[0]?.id, 'sched-1');
    assert.equal(listed.schedules[0]?.cadence, 'every 1h');
    assert.equal(listed.schedules[0]?.destination, 'slack:C-ENG');
    assert.equal(listed.schedules[0]?.prompt, 'check the repo and report');

    const cancelled = await harness.call('/api/v1/schedules/sched-1', { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    const missing = await harness.call('/api/v1/schedules/sched-1', { method: 'DELETE' });
    assert.equal(missing.status, 404);

    const after = await json<{ schedules: unknown[] }>(await harness.call('/api/v1/schedules'));
    assert.equal(after.schedules.length, 0);
  } finally {
    await harness.stop();
  }
});

test('a codex sign-in is storable both ways and reachable through every credential route', async () => {
  const harness = await startApi();
  try {
    // The ChatGPT marker: an oauth_token for codex is accepted — runtime
    // resolution reads it as "this machine uses `codex login`" — while the
    // same type stays refused for openai (asserted in the test above).
    const marker = await harness.call('/api/v1/credentials/codex', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'oauth_token', value: 'chatgpt' }),
    });
    assert.equal(marker.status, 200);

    // The listing carries a codex row; without it an implemented provider
    // is simply unreachable from the dashboard.
    const listed = await json<{ providers: Array<{ provider: string; stored: boolean; type?: string }> }>(
      await harness.call('/api/v1/credentials'),
    );
    const codexRow = listed.providers.find((entry) => entry.provider === 'codex');
    assert.deepEqual(codexRow, { provider: 'codex', stored: true, type: 'oauth_token' });

    // A codex key is never endpoint-bound: the harness owns its endpoints,
    // and runtime resolution refuses a bound key rather than unbinding it —
    // so the store refuses the binding up front.
    const bound = await harness.call('/api/v1/credentials/codex', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'api_key', value: 'sk-proxy', baseUrl: 'https://proxy.local/v1' }),
    });
    assert.equal(bound.status, 400);
    assert.equal((await json<{ error: { code: string } }>(bound)).error.code, 'unsupported_credential_endpoint');

    // A ChatGPT sign-in has no key to check: the verify route says so
    // instead of condemning a credential that works once saved.
    const verify = await json<{ status: string; detail?: string }>(await harness.call('/api/v1/credentials/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', type: 'oauth_token', key: 'chatgpt' }),
    }));
    assert.equal(verify.status, 'unreachable');
    assert.match(verify.detail ?? '', /codex login/);
  } finally {
    await harness.stop();
  }
});

test('metadata carrying a key the daemon reserves is refused where the caller can see it', async () => {
  const harness = await startApi();
  try {
    // The gateway refuses this at dispatch, but a dispatch nobody awaits
    // refuses into the event stream; the caller would otherwise hold a 202
    // and a turn id for a turn that never ran — and a caller who could
    // write `delegatedBy` would have the restart sweep fail its own parked
    // turn as an orphaned delegation.
    const refused = await harness.call('/api/v1/sessions/forged-meta-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus', metadata: { delegatedBy: 'stratus', channel: 'web' } }),
    });
    assert.equal(refused.status, 400);
    const body = await json<{ error: { code: string; message: string } }>(refused);
    assert.equal(body.error.code, 'metadata_reserved');
    assert.match(body.error.message, /"delegatedBy"/);

    const listed = await json<{ sessions: Array<{ id: string }> }>(await harness.call('/api/v1/sessions'));
    assert.equal(listed.sessions.some((session) => session.id === 'forged-meta-1'), false, 'nothing was created');
  } finally {
    await harness.stop();
  }
});

test('reloading skills serves a skill installed behind the daemon\'s back, and refuses a broken one whole', async () => {
  const home = await newHome();
  const harness = await startApi({ home });
  try {
    const skillsDir = path.join(home, '.stratus', 'skills');
    await mkdir(path.join(skillsDir, 'triage'), { recursive: true });
    await writeFile(path.join(skillsDir, 'triage', 'SKILL.md'), '---\nname: Triage\ndescription: Use when sorting issues.\n---\n\n# Triage\n');

    const reloaded = await harness.call('/api/v1/skills/reload', { method: 'POST' });
    assert.equal(reloaded.status, 200);
    const { skills } = await json<{ skills: Array<{ id: string; path: string }> }>(reloaded);
    assert.deepEqual(skills.map((skill) => skill.id), ['triage']);
    // The same listing the catalog serves, so a surface can swap one for
    // the other without a second fetch.
    const catalog = await json<{ skills: Array<{ id: string }> }>(await harness.call('/api/v1/catalog/tools'));
    assert.deepEqual(catalog.skills.map((skill) => skill.id), ['triage']);

    // A file that will not load names itself and changes nothing — and it
    // is not the daemon that is broken, so not a 500.
    await mkdir(path.join(skillsDir, 'broken'), { recursive: true });
    await writeFile(path.join(skillsDir, 'broken', 'SKILL.md'), '---\nname: Broken\n---\n\nNo description.\n');
    const refused = await harness.call('/api/v1/skills/reload', { method: 'POST' });
    assert.equal(refused.status, 422);
    const { error } = await json<{ error: { code: string; message: string } }>(refused);
    assert.equal(error.code, 'skills_reload_refused');
    assert.ok(error.message.includes(path.join(skillsDir, 'broken', 'SKILL.md')), error.message);
    assert.deepEqual(harness.gateway.skills().map((skill) => skill.id), ['triage']);
  } finally {
    await harness.stop();
  }
});

test('an announced restart is accepted, refuses the next message, and reaches the host', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  let handOff!: (outcome: { drained: boolean; reason?: string }) => void;
  const restarted = new Promise<{ drained: boolean; reason?: string }>((resolve) => { handOff = resolve; });
  const harness = await startApi({ home, gateway: { onRestart: (outcome) => handOff(outcome) } });
  try {
    const invalid = await harness.call('/api/v1/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drainTimeoutMs: 'soon' }),
    });
    assert.equal(invalid.status, 400);

    const accepted = await harness.call('/api/v1/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'plugin enabled', drainTimeoutMs: 5000 }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await json(accepted), { restarting: true, reason: 'plugin enabled', drainTimeoutMs: 5000, inflight: 0 });

    // Refused from the announcement on, whichever surface asks.
    await assert.rejects(
      harness.gateway.dispatch({ sessionId: 's-late', agentId: 'ava', userMessage: 'hello' }),
      /restarting/,
    );
    assert.deepEqual(await restarted, { reason: 'plugin enabled', drained: true });
  } finally {
    await harness.stop();
  }
});

test('a daemon whose host cannot restart it says so as 501, not as a failure', async () => {
  const harness = await startApi();
  try {
    const response = await harness.call('/api/v1/restart', { method: 'POST' });
    assert.equal(response.status, 501);
    const { error } = await json<{ error: { code: string } }>(response);
    assert.equal(error.code, 'restart_unsupported');
    // Still serving: a refused restart is not a stop.
    assert.equal((await harness.call('/api/v1/health')).status, 200);
  } finally {
    await harness.stop();
  }
});

test('the API is a required channel, and a port it cannot bind is named with what to do', async () => {
  // Something else on the port — another stratusd on this home, in the
  // case this exists for. The gateway used to log the bind failure and
  // serve on with no API, which is how a second `stratus serve` became a
  // second daemon on the same database.
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as { port: number };
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  const api = createControlApi({ env, port });

  try {
    assert.equal(api.required, true);
    await assert.rejects(
      api.start(gateway),
      new RegExp(`could not listen on 127\\.0\\.0\\.1:${port} \\(listen EADDRINUSE.*--api-port <port>.*--no-api`),
    );
    assert.equal(api.url, undefined, 'a bind that failed publishes nowhere');
  } finally {
    await api.stop();
    await gateway.stop();
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test('a session rolls over through the API, and the archive and the busy session refuse it', async () => {
  const harness = await startApi();
  try {
    await harness.gateway.store.create({
      id: 's-roll',
      agent: { id: 'stratus', name: 'Stratus' },
      status: 'completed',
      messages: [{ id: 'm-1', role: 'user', content: 'from before', createdAt: '2026-08-19T00:00:00.000Z' }],
      metadata: { channel: 'web' },
    });

    const rolled = await harness.call('/api/v1/sessions/s-roll/rollover', { method: 'POST' });
    assert.equal(rolled.status, 200);
    const outcome = await json<{ sessionId: string; archivedAs: string }>(rolled);
    assert.equal(outcome.sessionId, 's-roll');
    assert.match(outcome.archivedAs, /^s-roll:rolledover:/);

    const fresh = await json<{ session: { messages: unknown[]; metadata?: Record<string, unknown> } }>(await harness.call('/api/v1/sessions/s-roll'));
    assert.deepEqual(fresh.session.messages, []);
    assert.equal(fresh.session.metadata?.rolledOverFrom, outcome.archivedAs);
    assert.equal(fresh.session.metadata?.sessionTrust, 'user');
    const archived = await json<{ session: { messages: unknown[] } }>(await harness.call(`/api/v1/sessions/${encodeURIComponent(outcome.archivedAs)}`));
    assert.equal(archived.session.messages.length, 1);

    // The archive is a record; the live row is what a caller rolls over.
    const again = await harness.call(`/api/v1/sessions/${encodeURIComponent(outcome.archivedAs)}/rollover`, { method: 'POST' });
    assert.equal(again.status, 409);
    assert.equal((await json<{ error: { code: string } }>(again)).error.code, 'session_archived');

    await harness.gateway.store.create({
      id: 's-busy',
      agent: { id: 'stratus', name: 'Stratus' },
      status: 'running',
      messages: [],
    });
    const busy = await harness.call('/api/v1/sessions/s-busy/rollover', { method: 'POST' });
    assert.equal(busy.status, 409);
    assert.equal((await json<{ error: { code: string } }>(busy)).error.code, 'session_busy');

    assert.equal((await harness.call('/api/v1/sessions/nope/rollover', { method: 'POST' })).status, 404);

    // And the label is the daemon's: a caller cannot seed it on a new session.
    const seeded = await harness.call('/api/v1/sessions/s-seeded/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', agentId: 'stratus', metadata: { sessionTrust: 'user' } }),
    });
    assert.equal(seeded.status, 400);
    assert.equal((await json<{ error: { code: string } }>(seeded)).error.code, 'metadata_reserved');
  } finally {
    await harness.stop();
  }
});
