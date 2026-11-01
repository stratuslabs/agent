import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  createFileCommandWhitelist,
  createPermissionPolicy,
  describeAgentGrants,
  parseDestinationGrant,
  whitelistPathFor,
  type ApprovalRequest,
  type PermissionDecision,
} from '../src/index.ts';
import { ran } from './answer.ts';

const session = (id = 'sess-1', trust?: TrustLevel): Session => ({
  id,
  agent: { id: 'nova', name: 'Nova' },
  status: 'running',
  messages: [],
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  ...(trust === undefined
    ? {}
    : { metadata: { [SESSION_TRUST_METADATA_KEY]: trust, [SESSION_TAINTED_BY_METADATA_KEY]: 'message.read' } }),
});

/** The shape `message.read` and `message.send` have: judged by `channel:to`. */
const messageTool = (name: string): Tool => ({
  name,
  risk: 'gated',
  destinationFor(input: JsonObject) {
    const source = input.source as { channel?: unknown; to?: unknown } | undefined;
    return typeof source?.channel === 'string' && typeof source.to === 'string'
      ? `${source.channel}:${source.to}`
      : undefined;
  },
  async execute() {
    return null;
  },
});

const read = messageTool('message.read');
const send = messageTool('message.send');

const call = (tool: Tool, to: string | undefined, sessionId = 'sess-1', trust?: TrustLevel): ApprovalContext => ({
  session: session(sessionId, trust),
  call: { id: 'call-1', toolName: tool.name, input: to === undefined ? {} : { source: { channel: 'slack', to } } },
  tool,
  risk: 'gated',
});

const newStore = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-destinations-'));
  const directory = path.join(home, 'agents');
  return { directory, store: createFileCommandWhitelist({ directory, stateHome: home }) };
};

test('always allow on message.read persists for that conversation, past a restart, with who answered', async () => {
  const { directory, store } = await newStore();
  const requests: ApprovalRequest[] = [];
  const first = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      requests.push(request);
      return { answer: 'always', actor: 'U-DYLAN' };
    },
    destinations: { isPreauthorized: () => false, whitelist: store },
  });
  assert.equal(ran(await first.approve(call(read, 'C0C6GF7R96X'))), true);
  assert.equal(requests[0]?.always, 'destination', 'the transport is told what always will remember');

  const file = JSON.parse(await readFile(whitelistPathFor(directory, 'nova'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(
    (file.destinations as Array<Record<string, unknown>>).map(({ tool, destination, grantedBy }) => ({ tool, destination, grantedBy })),
    [{ tool: 'message.read', destination: 'slack:C0C6GF7R96X', grantedBy: 'U-DYLAN' }],
  );

  // A new daemon (a fresh policy and store over the same file), a new
  // session, and nobody to ask: the grant is what lets it run.
  const decisions: PermissionDecision[] = [];
  const restarted = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    destinations: {
      isPreauthorized: () => false,
      whitelist: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }),
    },
  });
  assert.equal(ran(await restarted.approve(call(read, 'C0C6GF7R96X', 'sess-2'))), true);
  assert.equal(decisions[0]?.destination, 'slack:C0C6GF7R96X');
  assert.match(decisions[0]?.reason ?? '', /standing grant/);
  // The daemon's grant-use trace needs the grant itself, not prose.
  assert.equal(decisions[0]?.destinationGrant?.tool, 'message.read');
  assert.equal(decisions[0]?.destinationGrant?.destination, 'slack:C0C6GF7R96X');
  assert.equal(decisions[0]?.destinationGrant?.grantedBy, 'U-DYLAN');

  // Never wider than what was approved: another channel, or sending to
  // the same one, still has nobody to say yes.
  assert.equal(ran(await restarted.approve(call(read, 'C-OTHER', 'sess-2'))), false);
  assert.equal(ran(await restarted.approve(call(send, 'C0C6GF7R96X', 'sess-2'))), false);
});

test('a revoked destination grant asks again on the very next call', async () => {
  const { store } = await newStore();
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async () => {
      asks += 1;
      return asks === 1 ? 'always' : 'deny';
    },
    destinations: { isPreauthorized: () => false, whitelist: store },
  });
  assert.equal(ran(await policy.approve(call(read, 'C-ENG'))), true);
  assert.equal(ran(await policy.approve(call(read, 'C-ENG'))), true);
  assert.equal(asks, 1);

  assert.equal(await store.forgetDestination('nova', 'slack:C-ENG'), true);
  assert.equal(ran(await policy.approve(call(read, 'C-ENG'))), false);
  assert.equal(asks, 2);
  assert.equal(await store.forgetDestination('nova', 'slack:C-ENG'), false, 'nothing left to revoke');
});

test('forgetDestination with a tool keeps the other tool on that conversation', async () => {
  const { store } = await newStore();
  const at = '2026-10-12T00:00:00.000Z';
  await store.rememberDestination('nova', { tool: 'message.read', destination: 'slack:C-ENG', grantedAt: at });
  await store.rememberDestination('nova', { tool: 'message.send', destination: 'slack:C-ENG', grantedAt: at });
  // A second answer for the same pair replaces rather than duplicates.
  await store.rememberDestination('nova', { tool: 'message.read', destination: 'slack:C-ENG', grantedAt: at });
  assert.equal((await store.destinationsFor('nova')).length, 2);

  assert.equal(await store.forgetDestination('nova', 'slack:C-ENG', 'message.send'), true);
  assert.deepEqual((await store.destinationsFor('nova')).map((grant) => grant.tool), ['message.read']);
});

test('a destination grant is written beside the other kinds without dropping them', async () => {
  const { directory, store } = await newStore();
  const file = whitelistPathFor(directory, 'nova');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1,
    scopes: [{ command: 'git', subcommand: 'status' }],
    origins: [{ origin: 'https://example.com', tool: 'web.fetch' }],
    tools: [{ tool: 'web.search', grantedAt: '2026-10-01T00:00:00.000Z' }],
  }));
  await store.rememberDestination('nova', { tool: 'message.read', destination: 'slack:C-ENG', grantedAt: '2026-10-12T00:00:00.000Z' });

  const grants = await createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }).grantsFor('nova');
  assert.equal(grants.scopes.length, 1);
  assert.equal(grants.origins.length, 1);
  assert.equal(grants.tools.length, 1);
  assert.equal(grants.destinations.length, 1);
  assert.equal(describeAgentGrants(grants).destinations[0]?.description, 'slack:C-ENG (message.read)');
});

test('a conversation that read external content under the gate neither uses nor mints a destination grant', async () => {
  const { store } = await newStore();
  await store.rememberDestination('nova', { tool: 'message.read', destination: 'slack:C-ENG', grantedAt: '2026-10-12T00:00:00.000Z' });
  const requests: ApprovalRequest[] = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      requests.push(request);
      return 'always';
    },
    destinations: { isPreauthorized: () => false, whitelist: store },
    gateExternalContent: () => true,
  });
  assert.equal(ran(await policy.approve(call(read, 'C-ENG', 'sess-1', 'external'))), true);
  assert.equal(requests.length, 1, 'the grant did not cover a gated conversation');
  assert.equal(requests[0]?.oneShot, true);
  assert.equal(ran(await policy.approve(call(read, 'C-NEW', 'sess-1', 'external'))), true);
  assert.deepEqual((await store.destinationsFor('nova')).map((grant) => grant.destination), ['slack:C-ENG']);
});

test('a call naming no destination still gets only this session from always', async () => {
  const { store } = await newStore();
  const requests: ApprovalRequest[] = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      requests.push(request);
      return 'always';
    },
    destinations: { isPreauthorized: () => false, whitelist: store },
  });
  assert.equal(ran(await policy.approve(call(read, undefined))), true);
  assert.equal(requests[0]?.always, 'session');
  assert.deepEqual(await store.destinationsFor('nova'), []);
});

test('a hand-edited destination row missing its tool or destination grants nothing', () => {
  assert.equal(parseDestinationGrant({ destination: 'slack:C-ENG' }), undefined);
  assert.equal(parseDestinationGrant({ tool: 'message.read' }), undefined);
  assert.equal(parseDestinationGrant({ tool: 'message.read', destination: '' }), undefined);
  assert.deepEqual(parseDestinationGrant({ tool: 'message.read', destination: 'slack:C-ENG' }), {
    tool: 'message.read',
    destination: 'slack:C-ENG',
    grantedAt: new Date(0).toISOString(),
  });
});

test('a grant is bound to the workspace it was made in: the same channel id under another team does not match', async () => {
  const { directory, store } = await newStore();
  let team: string | undefined = 'T-ONE';
  const granting = createPermissionPolicy({
    mode: 'remote',
    request: async () => ({ answer: 'always', actor: 'U-DYLAN' }),
    destinations: { isPreauthorized: () => false, whitelist: store, accountFor: () => team },
  });
  assert.equal(ran(await granting.approve(call(read, 'C0C6GF7R96X'))), true);
  const file = JSON.parse(await readFile(whitelistPathFor(directory, 'nova'), 'utf8')) as Record<string, unknown>;
  assert.equal((file.destinations as Array<Record<string, unknown>>)[0]?.account, 'T-ONE', 'the grant records its workspace');

  const restart = () => createPermissionPolicy({
    mode: 'headless',
    destinations: {
      isPreauthorized: () => false,
      whitelist: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }),
      accountFor: () => team,
    },
  });
  // Same team after a restart: the grant still holds.
  assert.equal(ran(await restart().approve(call(read, 'C0C6GF7R96X', 'sess-2'))), true);
  // The agent's Slack app now belongs to another workspace that happens to
  // reuse the id: nobody approved that conversation.
  team = 'T-TWO';
  assert.equal(ran(await restart().approve(call(read, 'C0C6GF7R96X', 'sess-3'))), false);
  // Not connected at all: the workspace is unknown, so nothing matches.
  team = undefined;
  assert.equal(ran(await restart().approve(call(read, 'C0C6GF7R96X', 'sess-4'))), false);
});

test('answering always again in the new workspace replaces the old workspace grant', async () => {
  const { directory, store } = await newStore();
  let team = 'T-ONE';
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async () => ({ answer: 'always', actor: 'U-DYLAN' }),
    destinations: { isPreauthorized: () => false, whitelist: store, accountFor: () => team },
  });
  assert.equal(ran(await policy.approve(call(send, 'C0C6GF7R96X'))), true);
  team = 'T-TWO';
  assert.equal(ran(await policy.approve(call(send, 'C0C6GF7R96X', 'sess-2'))), true);
  const grants = await store.destinationsFor('nova');
  assert.deepEqual(grants.map(({ destination, account }) => ({ destination, account })), [
    { destination: 'slack:C0C6GF7R96X', account: 'T-TWO' },
  ]);
  assert.match(describeAgentGrants(await store.grantsFor('nova')).destinations[0]?.description ?? '', /T-TWO/);
});

test('a destination grant is bound to the package that contributed the tool: a replacement package asks again', async () => {
  const { directory, store } = await newStore();
  let contributor: string | undefined = '@acme/stratus-slack-tools';
  const granting = createPermissionPolicy({
    mode: 'remote',
    request: async () => ({ answer: 'always', actor: 'U-DYLAN' }),
    destinations: { isPreauthorized: () => false, whitelist: store },
    grants: { contributorOf: () => contributor },
  });
  assert.equal(ran(await granting.approve(call(read, 'C-ENG'))), true);
  const file = JSON.parse(await readFile(whitelistPathFor(directory, 'nova'), 'utf8')) as Record<string, unknown>;
  assert.equal(
    (file.destinations as Array<Record<string, unknown>>)[0]?.package,
    '@acme/stratus-slack-tools',
    'the grant records the contributing package',
  );

  const restart = () => createPermissionPolicy({
    mode: 'headless',
    destinations: {
      isPreauthorized: () => false,
      whitelist: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }),
    },
    grants: { contributorOf: () => contributor },
  });
  // Same package after a restart: the grant still holds.
  assert.equal(ran(await restart().approve(call(read, 'C-ENG', 'sess-2'))), true);
  // Another package now declares message.read: nobody approved its code.
  contributor = '@other/message-tools';
  assert.equal(ran(await restart().approve(call(read, 'C-ENG', 'sess-3'))), false);
  // A kernel tool of that name is a different tool too.
  contributor = undefined;
  assert.equal(ran(await restart().approve(call(read, 'C-ENG', 'sess-4'))), false);
  assert.match(describeAgentGrants(await store.grantsFor('nova')).destinations[0]?.description ?? '', /@acme\/stratus-slack-tools/);
});

test('a kernel-tool destination grant never matches a plugin of the same name', async () => {
  const { directory } = await newStore();
  let contributor: string | undefined;
  const policy = () => createPermissionPolicy({
    mode: 'remote',
    request: async () => ({ answer: 'always', actor: 'U-DYLAN' }),
    destinations: {
      isPreauthorized: () => false,
      whitelist: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }),
    },
    grants: { contributorOf: () => contributor },
  });
  assert.equal(ran(await policy().approve(call(send, 'C-ENG'))), true);
  contributor = '@evil/send';
  const headless = createPermissionPolicy({
    mode: 'headless',
    destinations: {
      isPreauthorized: () => false,
      whitelist: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }),
    },
    grants: { contributorOf: () => contributor },
  });
  assert.equal(ran(await headless.approve(call(send, 'C-ENG', 'sess-2'))), false);
});
