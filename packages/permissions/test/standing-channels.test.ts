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
  matchesStandingChannel,
  type ApprovalRequest,
  type ConversationKind,
  type DestinationScopeOptions,
  type PermissionDecision,
} from '../src/index.ts';

const session = (id = 'sess-1', trust?: TrustLevel): Session => ({
  id,
  agent: { id: 'nova', name: 'Nova' },
  status: 'running',
  messages: [],
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...(trust === undefined
    ? {}
    : { metadata: { [SESSION_TRUST_METADATA_KEY]: trust, [SESSION_TAINTED_BY_METADATA_KEY]: 'web.fetch' } }),
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

const call = (
  tool: Tool,
  to: string,
  options: { sessionId?: string; trust?: TrustLevel; risk?: 'gated' | 'dangerous' } = {},
): ApprovalContext => ({
  session: session(options.sessionId, options.trust),
  call: { id: 'call-1', toolName: tool.name, input: { source: { channel: 'slack', to } } },
  tool,
  risk: options.risk ?? 'gated',
});

/** What the Slack app would report for these conversations. */
const KINDS: Record<string, ConversationKind> = {
  'slack:C0C1YV12SLC': 'channel',
  'slack:C0OTHER': 'channel',
  'slack:G0PRIVATE': 'channel',
  'slack:G0GROUPDM': 'direct',
  'slack:D0DIRECT': 'direct',
};

const destinations = (
  channels: () => readonly string[],
  kindFor: DestinationScopeOptions['conversationKindFor'] = (_agentId, destination) => KINDS[destination],
): DestinationScopeOptions => ({
  isPreauthorized: () => false,
  standingChannelsFor: () => channels(),
  ...(kindFor ? { conversationKindFor: kindFor } : {}),
});

const headless = (options: DestinationScopeOptions, extra: Partial<Parameters<typeof createPermissionPolicy>[0]> = {}) => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    destinations: options,
    ...extra,
  });
  return { policy, decisions };
};

test('a configured channel reads and posts without asking, in any session, with the reason named', async () => {
  const { policy, decisions } = headless(destinations(() => ['slack:C0C1YV12SLC']));
  // Interactive, scheduled, and delegated turns are all sessions of the
  // same agent; the authorization is the agent's, not one session's.
  for (const sessionId of ['slack:T1:C0C1YV12SLC:1792.1', 'schedule:abc:2026-10-17T23:05:00Z', 'delegate:xyz']) {
    assert.equal(await policy.approve(call(read, 'C0C1YV12SLC', { sessionId })), true, `read in ${sessionId}`);
    assert.equal(await policy.approve(call(send, 'C0C1YV12SLC', { sessionId })), true, `send in ${sessionId}`);
  }
  assert.equal(decisions[0]?.destination, 'slack:C0C1YV12SLC');
  assert.match(decisions[0]?.reason ?? '', /approvals\.channels/);
  // Never wider than the list: another channel still has nobody to say yes.
  assert.equal(await policy.approve(call(read, 'C0OTHER')), false);
});

test('slack:* covers every channel, public or private, and never a DM or group DM', async () => {
  const { policy } = headless(destinations(() => ['slack:*']));
  assert.equal(await policy.approve(call(send, 'C0OTHER')), true);
  assert.equal(await policy.approve(call(read, 'G0PRIVATE')), true);
  assert.equal(await policy.approve(call(send, 'D0DIRECT')), false);
  // A G… id is a group DM here: the kind is the app's answer, not the prefix.
  assert.equal(await policy.approve(call(send, 'G0GROUPDM')), false);
  assert.equal(await policy.approve(call(read, 'G0GROUPDM')), false);
});

test('a DM named outright in the config still asks', async () => {
  const requests: ApprovalRequest[] = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      requests.push(request);
      return { answer: 'deny' };
    },
    destinations: destinations(() => ['slack:D0DIRECT']),
  });
  assert.equal(await policy.approve(call(send, 'D0DIRECT')), false);
  assert.equal(requests.length, 1, 'the approver was asked, as before');
});

test('a conversation the app cannot describe asks, and so does a host that cannot ask the app', async () => {
  const unknown = headless(destinations(() => ['slack:*'], () => undefined));
  assert.equal(await unknown.policy.approve(call(send, 'C0C1YV12SLC')), false);

  const asyncUnknown = headless(destinations(() => ['slack:*'], async () => undefined));
  assert.equal(await asyncUnknown.policy.approve(call(read, 'C0C1YV12SLC')), false);

  const noLookup = headless({ isPreauthorized: () => false, standingChannelsFor: () => ['slack:*'] });
  assert.equal(await noLookup.policy.approve(call(read, 'C0C1YV12SLC')), false);
});

test('removing the entry revokes it on the next call', async () => {
  let channels: string[] = ['slack:C0C1YV12SLC'];
  const { policy } = headless(destinations(() => channels));
  assert.equal(await policy.approve(call(send, 'C0C1YV12SLC')), true);
  channels = [];
  assert.equal(await policy.approve(call(send, 'C0C1YV12SLC')), false);
});

test('only the kernel message tools: another tool, or a plugin tool of the same name, asks', async () => {
  const notify = messageTool('notify.send');
  const { policy } = headless(destinations(() => ['slack:*']));
  assert.equal(await policy.approve(call(notify, 'C0C1YV12SLC')), false);

  const plugin = headless(destinations(() => ['slack:*']), {
    grants: { contributorOf: () => '@someone/fake-message' },
  });
  assert.equal(await plugin.policy.approve(call(send, 'C0C1YV12SLC')), false);
});

test('a dangerous call is never covered', async () => {
  const { policy } = headless(destinations(() => ['slack:*']));
  assert.equal(await policy.approve(call(send, 'C0C1YV12SLC', { risk: 'dangerous' })), false);
});

test('withdrawn under the external-content gate, like every standing yes', async () => {
  const gated = headless(destinations(() => ['slack:*']), { gateExternalContent: () => true });
  assert.equal(await gated.policy.approve(call(send, 'C0C1YV12SLC', { trust: 'external' })), false);
  // The same agent's clean conversation, or a host without the gate, is unaffected.
  assert.equal(await gated.policy.approve(call(send, 'C0C1YV12SLC')), true);
  const ungated = headless(destinations(() => ['slack:*']));
  assert.equal(await ungated.policy.approve(call(send, 'C0C1YV12SLC', { trust: 'external' })), true);
});

test('matchesStandingChannel: exact id or the kind wildcard, nothing looser', () => {
  assert.equal(matchesStandingChannel('slack:C1', ['slack:C1']), true);
  assert.equal(matchesStandingChannel('slack:C1', ['slack:*']), true);
  assert.equal(matchesStandingChannel('slack:C1', ['slack:C2', 'discord:*']), false);
  assert.equal(matchesStandingChannel('slack:C1', ['*']), false);
  assert.equal(matchesStandingChannel('slack:C1', ['slack:c1']), false);
  assert.equal(matchesStandingChannel('slack', ['slack:*']), false);
  assert.equal(matchesStandingChannel('slack:', ['slack:*']), false);
});
