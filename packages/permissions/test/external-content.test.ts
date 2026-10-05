import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_TAINTED_BY_METADATA_KEY,
  SESSION_TRUST_METADATA_KEY,
  type ApprovalContext,
  type JsonObject,
  type Session,
  type Tool,
  type TrustLevel,
} from '@stratusagent/core';

import {
  createPermissionPolicy,
  type CommandScope,
  type CommandWhitelistStore,
  type OriginScope,
  type OriginWhitelistStore,
  type PermissionDecision,
  type ToolGrant,
  type ToolGrantStore,
} from '../src/index.ts';

const sessionAt = (trust: TrustLevel | undefined, agentId = 'ava', taintedBy = 'web.fetch'): Session => {
  const now = new Date().toISOString();
  return {
    id: `session-${agentId}`,
    agent: { id: agentId, name: agentId },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...(trust === undefined
      ? {}
      : { metadata: { [SESSION_TRUST_METADATA_KEY]: trust, [SESSION_TAINTED_BY_METADATA_KEY]: taintedBy } }),
  };
};

const fetchTool: Tool = {
  name: 'web.fetch',
  risk: 'gated',
  async execute() {
    return null;
  },
};

const shellTool: Tool = {
  name: 'shell.run',
  risk: 'gated',
  commandFor: (input: JsonObject) => (typeof input.command === 'string' ? input.command : undefined),
  async execute() {
    return null;
  },
};

const browserTool: Tool = {
  name: 'browser.act',
  risk: 'gated',
  originFor: () => 'https://app.example.com',
  async execute() {
    return null;
  },
};

const sendTool: Tool = {
  name: 'message.send',
  risk: 'gated',
  destinationFor: (input: JsonObject) => (typeof input.destination === 'string' ? input.destination : undefined),
  async execute() {
    return null;
  },
};

const call = (tool: Tool, session: Session, input: JsonObject = {}): ApprovalContext => ({
  session,
  call: { id: 'call-1', toolName: tool.name, input },
  tool,
  risk: tool.risk ?? 'gated',
});

const stubGrants = (granted: ToolGrant[] = [{ tool: 'web.fetch', grantedAt: '2026-10-01T00:00:00.000Z' }]) => {
  const remembered: ToolGrant[] = [];
  const store: ToolGrantStore = {
    toolGrantsFor: async () => [...granted, ...remembered],
    rememberTool: async (_agentId, grant) => {
      remembered.push(grant);
    },
  };
  return { store, remembered };
};

const stubScopes = (granted: CommandScope[]): CommandWhitelistStore => ({
  scopesFor: async () => granted,
  remember: async () => {},
});

const stubOrigins = (granted: OriginScope[]): OriginWhitelistStore => ({
  originsFor: async () => granted,
  rememberOrigin: async () => {},
});

test('a standing grant stops covering a conversation once it has read external content', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    grants: { store: stubGrants().store },
    gateExternalContent: () => true,
  });

  // Before the page, and with content from the operator or the agent's own
  // work, the grant is what it always was.
  assert.equal(await policy.approve(call(fetchTool, sessionAt(undefined))), true);
  assert.equal(await policy.approve(call(fetchTool, sessionAt('user'))), true);
  assert.equal(await policy.approve(call(fetchTool, sessionAt('agent'))), true);

  // After it, the same grant covers nothing, and the refusal names the
  // cause and the setting — the operator has a grant on file that reads
  // as if it should have applied.
  assert.equal(await policy.approve(call(fetchTool, sessionAt('external'))), false);
  const refusal = decisions.at(-1);
  assert.equal(refusal?.allowed, false);
  assert.equal(refusal?.grant, undefined);
  assert.match(refusal?.reason ?? '', /read external content \(from web\.fetch\)/);
  assert.match(refusal?.reason ?? '', /approvals\.externalContent/);
});

test('without the gate, external content changes nothing about what a grant covers', async () => {
  const unset = createPermissionPolicy({ mode: 'headless', grants: { store: stubGrants().store } });
  assert.equal(await unset.approve(call(fetchTool, sessionAt('external'))), true);

  const off = createPermissionPolicy({
    mode: 'headless',
    grants: { store: stubGrants().store },
    gateExternalContent: () => false,
  });
  assert.equal(await off.approve(call(fetchTool, sessionAt('external'))), true);
});

test('unknown content does not trip the gate — a shell output is not a web page', async () => {
  const policy = createPermissionPolicy({
    mode: 'headless',
    grants: { store: stubGrants().store },
    gateExternalContent: () => true,
  });
  assert.equal(await policy.approve(call(fetchTool, sessionAt('unknown', 'ava', 'shell.run'))), true);
});

test('the gate is asked per agent, with the agent whose conversation it is', async () => {
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    grants: { store: stubGrants().store },
    gateExternalContent: (agentId) => {
      asked.push(agentId);
      return agentId === 'scout';
    },
  });
  assert.equal(await policy.approve(call(fetchTool, sessionAt('external', 'scout'))), false);
  assert.equal(await policy.approve(call(fetchTool, sessionAt('external', 'ava'))), true);
  assert.deepEqual(asked, ['scout', 'ava']);
});

test('built-in safe command scopes survive the gate and granted ones do not', async () => {
  const policy = createPermissionPolicy({
    mode: 'headless',
    commands: { whitelist: stubScopes([{ command: 'git', args: ['push'] }]) },
    gateExternalContent: () => true,
  });
  const tainted = sessionAt('external');

  assert.equal(await policy.approve(call(shellTool, tainted, { command: 'git status' })), true);
  assert.equal(await policy.approve(call(shellTool, tainted, { command: 'git push origin main' })), false);
  // The same granted scope still covers a conversation that read nothing.
  assert.equal(await policy.approve(call(shellTool, sessionAt('user'), { command: 'git push origin main' })), true);
});

test('a site grant stops covering a conversation that has read external content', async () => {
  const policy = createPermissionPolicy({
    mode: 'headless',
    origins: { whitelist: stubOrigins([{ origin: 'https://app.example.com' }]) },
    gateExternalContent: () => true,
  });
  assert.equal(await policy.approve(call(browserTool, sessionAt('user'))), true);
  assert.equal(await policy.approve(call(browserTool, sessionAt('external'))), false);
});

test('a schedule\'s pre-authorized destination is the one grant the gate spares', async () => {
  const policy = createPermissionPolicy({
    mode: 'headless',
    destinations: { isPreauthorized: (_session, destination) => destination === 'slack:C-ENG' },
    gateExternalContent: () => true,
  });
  const tainted = sessionAt('external');
  assert.equal(await policy.approve(call(sendTool, tainted, { destination: 'slack:C-ENG' })), true);
  assert.equal(await policy.approve(call(sendTool, tainted, { destination: 'slack:C-OTHER' })), false);
});

test('safe tools run regardless of the gate', async () => {
  const policy = createPermissionPolicy({ mode: 'headless', gateExternalContent: () => true });
  const read: Tool = { name: 'fs.read', risk: 'safe', async execute() { return null; } };
  assert.equal(await policy.approve(call(read, sessionAt('external'))), true);
});

test('a gated conversation can be approved once but never mints a grant, however the human answers', async () => {
  const { store, remembered } = stubGrants([]);
  const prompts: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      prompts.push(question);
      return 'always';
    },
    grants: { store },
    gateExternalContent: () => true,
  });
  const tainted = sessionAt('external');

  assert.equal(await policy.approve(call(fetchTool, tainted)), true);
  assert.match(prompts[0] ?? '', /not remembered — this conversation has read external content/);
  assert.deepEqual(remembered, []);

  // Nor did "always" become a session grant: the next call asks again.
  assert.equal(await policy.approve(call(fetchTool, tainted)), true);
  assert.equal(prompts.length, 2);
});

test('a remote request from a gated conversation is one-shot, so no transport offers always', async () => {
  const requests: Array<{ oneShot?: boolean }> = [];
  const { store, remembered } = stubGrants([]);
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      requests.push(request.oneShot === undefined ? {} : { oneShot: request.oneShot });
      return 'always';
    },
    grants: { store },
    gateExternalContent: () => true,
  });

  assert.equal(await policy.approve(call(fetchTool, sessionAt('external'))), true);
  assert.deepEqual(requests[0], { oneShot: true });
  assert.deepEqual(remembered, []);

  // The same tool in a conversation that read nothing still offers one.
  assert.equal(await policy.approve(call(fetchTool, sessionAt('user'))), true);
  assert.deepEqual(requests[1], {});
  assert.equal(remembered.length, 1);
});
