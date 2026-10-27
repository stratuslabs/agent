import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SESSION_TAINTED_BY_METADATA_KEY,
  SESSION_TRUST_METADATA_KEY,
  type ApprovalContext,
  type JsonObject,
  type Session,
  type Tool,
  type ToolRisk,
} from '@stratusagent/core';

import {
  createPermissionPolicy,
  type DecisionLayer,
  type PermissionDecision,
  type PermissionPolicyOptions,
} from '../src/index.ts';

// Every decision names the check that made it, so an operator reading a
// refusal knows which knob to turn. One case per layer, each reached with
// the smallest setup that gets there, and refusals for every layer that
// can refuse.

const session = (external = false): Session => ({
  id: 'sess-1',
  agent: { id: 'ava', name: 'Ava' },
  status: 'running',
  messages: [],
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
  ...(external
    ? { metadata: { [SESSION_TRUST_METADATA_KEY]: 'external', [SESSION_TAINTED_BY_METADATA_KEY]: 'web.fetch' } }
    : {}),
}) as unknown as Session;

const plainTool = (name: string, risk: ToolRisk): Tool => ({ name, risk, async execute() { return null; } });

const shellTool = (cwd?: string): Tool => ({
  name: 'shell.run',
  risk: 'gated',
  commandFor: (input: JsonObject) => (typeof input.command === 'string' ? input.command : undefined),
  ...(cwd === undefined ? {} : { cwdFor: () => cwd }),
  async execute() { return null; },
});

const sendTool: Tool = {
  name: 'message.send',
  risk: 'gated',
  destinationFor: (input: JsonObject) => (typeof input.destination === 'string' ? input.destination : undefined),
  async execute() { return null; },
};

const browserTool: Tool = {
  name: 'browser.act',
  risk: 'gated',
  originFor: () => 'https://app.example.com',
  async execute() { return null; },
};

const contextFor = (tool: Tool, input: JsonObject = {}, extra: Partial<ApprovalContext> = {}): ApprovalContext => ({
  session: session(),
  call: { id: 'call-1', toolName: tool.name, input },
  tool,
  risk: tool.risk ?? 'gated',
  ...extra,
});

/** The one decision a single approve() reports, with its layer and outcome. */
const decide = async (
  options: Omit<PermissionPolicyOptions, 'onDecision'>,
  context: ApprovalContext,
): Promise<PermissionDecision> => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({ ...options, onDecision: (decision) => decisions.push(decision) } as PermissionPolicyOptions);
  const allowed = await policy.approve(context);
  assert.equal(decisions.length, 1, 'one decision per call');
  assert.equal(decisions[0]!.allowed, allowed);
  return decisions[0]!;
};

const expectLayer = (decision: PermissionDecision, layer: DecisionLayer, allowed: boolean): void => {
  assert.equal(decision.layer, layer, decision.reason);
  assert.equal(decision.allowed, allowed, decision.reason);
};

test('risk: a safe tool, an open posture, and a dangerous tool nobody can approve', async () => {
  expectLayer(await decide({ mode: 'headless' }, contextFor(plainTool('memory.remember', 'safe'))), 'risk', true);
  expectLayer(
    await decide({ mode: 'headless', openFor: () => true }, contextFor(plainTool('notes.write', 'gated'))),
    'risk',
    true,
  );
  expectLayer(await decide({ mode: 'headless' }, contextFor(plainTool('fs.delete', 'dangerous'))), 'risk', false);
});

test('scope: a command inside an approved or built-in scope runs, and one outside every scope is refused', async () => {
  const approved = { whitelist: { scopesFor: async () => [{ command: 'git', args: ['status'] }], remember: async () => {} } };
  expectLayer(await decide({ mode: 'headless', commands: approved }, contextFor(shellTool(), { command: 'git status' })), 'scope', true);
  expectLayer(await decide({ mode: 'headless', commands: {} }, contextFor(shellTool(), { command: 'grep fix' })), 'scope', true);
  const refused = await decide({ mode: 'headless', commands: approved }, contextFor(shellTool(), { command: 'git push' }));
  expectLayer(refused, 'scope', false);
  assert.match(refused.reason, /outside every approved scope/);
});

test('parse: a command that cannot be reduced to a scope is refused unattended', async () => {
  const refused = await decide({ mode: 'headless', commands: {} }, contextFor(shellTool(), { command: 'echo "unterminated' }));
  expectLayer(refused, 'parse', false);
  assert.match(refused.reason, /cannot run unattended/);
});

test('autonomy: a read inside the workspace, alone and as a compound line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-layers-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'main.ts'), 'export const x = 1;\n');
  const options = {
    mode: 'headless' as const,
    commands: { workspace: { directoryFor: () => workspace }, grantRootFor: () => workspace },
  };
  expectLayer(await decide(options, contextFor(shellTool(workspace), { command: 'cat src/main.ts' })), 'autonomy', true);
  const compound = await decide(options, contextFor(shellTool(workspace), { command: 'cat src/main.ts && ls src' }));
  expectLayer(compound, 'autonomy', true);
  assert.match(compound.reason, /may run unattended/);
});

test('grant: standing tool, session, destination, channel, site, trusted domain and schedule grants', async () => {
  const toolGrant = { tool: 'notes.write', grantedAt: '2026-10-27T00:00:00.000Z' };
  expectLayer(
    await decide(
      { mode: 'headless', grants: { store: { toolGrantsFor: async () => [toolGrant], remember: async () => {} } } } as never,
      contextFor(plainTool('notes.write', 'gated')),
    ),
    'grant',
    true,
  );

  // The session "always": answered once, then remembered for the session.
  const decisions: PermissionDecision[] = [];
  const interactive = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => 'always',
    onDecision: (decision) => decisions.push(decision),
  });
  // A send whose input names no destination the tool can parse: the one
  // shape whose "always" still means this session.
  const unnamed = contextFor(sendTool, {});
  assert.equal(await interactive.approve(unnamed), true);
  assert.equal(await interactive.approve(unnamed), true);
  assert.deepEqual(decisions.map((decision) => decision.layer), ['approver', 'grant']);
  assert.match(decisions[1]!.reason, /approved for the rest of this session/);

  const send = contextFor(sendTool, { destination: 'slack:C1' });

  const destinationGrant = { tool: 'message.send', destination: 'slack:C1', grantedAt: '2026-10-27T00:00:00.000Z' };
  expectLayer(
    await decide(
      {
        mode: 'headless',
        destinations: {
          isPreauthorized: () => false,
          whitelist: { destinationsFor: async () => [destinationGrant], remember: async () => {} },
        },
      } as never,
      send,
    ),
    'grant',
    true,
  );
  expectLayer(
    await decide(
      {
        mode: 'headless',
        destinations: {
          isPreauthorized: () => false,
          standingChannelsFor: () => ['slack:*'],
          conversationKindFor: async () => 'channel',
        },
      } as never,
      send,
    ),
    'grant',
    true,
  );
  expectLayer(
    await decide(
      { mode: 'headless', destinations: { isPreauthorized: async () => true } } as never,
      send,
    ),
    'grant',
    true,
  );
  const siteGrant = { origin: 'https://app.example.com', tool: 'browser.act' };
  expectLayer(
    await decide(
      { mode: 'headless', origins: { whitelist: { originsFor: async () => [siteGrant], remember: async () => {} } } } as never,
      contextFor(browserTool),
    ),
    'grant',
    true,
  );
  const reader: Tool = { ...browserTool, name: 'web.fetch' };
  expectLayer(
    await decide({ mode: 'headless', origins: { trustedDomainsFor: () => ['example.com'] } } as never, contextFor(reader)),
    'grant',
    true,
  );
});

test('grant: a gated call no grant covers is refused under the grant layer, site or not', async () => {
  expectLayer(await decide({ mode: 'headless' }, contextFor(plainTool('notes.write', 'gated'))), 'grant', false);
  expectLayer(await decide({ mode: 'headless' }, contextFor(sendTool, { destination: 'slack:C1' })), 'grant', false);
  const site = await decide({ mode: 'headless' }, contextFor(browserTool));
  expectLayer(site, 'grant', false);
  assert.match(site.reason, /no approved site covers/);
  const nowhere: Tool = { ...browserTool, originFor: () => undefined };
  expectLayer(await decide({ mode: 'headless' }, contextFor(nowhere)), 'grant', false);
});

test('gate: external content set the grants aside, so the refusal names the gate', async () => {
  const toolGrant = { tool: 'notes.write', grantedAt: '2026-10-27T00:00:00.000Z' };
  const refused = await decide(
    {
      mode: 'headless',
      gateExternalContent: () => true,
      grants: { store: { toolGrantsFor: async () => [toolGrant], remember: async () => {} } },
    } as never,
    contextFor(plainTool('notes.write', 'gated'), {}, { session: session(true) }),
  );
  expectLayer(refused, 'gate', false);
  // The gate is named over the scope a command missed, since it is the cause.
  const command = await decide(
    { mode: 'headless', commands: {}, gateExternalContent: () => true },
    contextFor(shellTool(), { command: 'git push' }, { session: session(true) }),
  );
  expectLayer(command, 'gate', false);
});

test('approver: a person said yes, said no, or approved a page that has since moved', async () => {
  const yes = await decide({ mode: 'interactive', ask: async () => 'yes' }, contextFor(plainTool('notes.write', 'gated')));
  expectLayer(yes, 'approver', true);
  const no = await decide({ mode: 'interactive', ask: async () => 'no' }, contextFor(plainTool('notes.write', 'gated')));
  expectLayer(no, 'approver', false);

  let open = true;
  const moving: Tool = { ...browserTool, originFor: () => (open ? 'https://app.example.com' : undefined) };
  const moved = await decide(
    { mode: 'interactive', ask: async () => { open = false; return 'yes'; } },
    contextFor(moving),
  );
  expectLayer(moved, 'approver', false);
  assert.match(moved.reason, /no longer open/);
});

test('cancelled: before the prompt and while waiting on it', async () => {
  const before = new AbortController();
  before.abort();
  expectLayer(
    await decide(
      { mode: 'interactive', ask: async () => 'yes' },
      contextFor(plainTool('notes.write', 'gated'), {}, { signal: before.signal }),
    ),
    'cancelled',
    false,
  );
  const during = new AbortController();
  expectLayer(
    await decide(
      { mode: 'interactive', ask: () => { during.abort(); return new Promise(() => {}); } },
      contextFor(plainTool('notes.write', 'gated'), {}, { signal: during.signal }),
    ),
    'cancelled',
    false,
  );
});
