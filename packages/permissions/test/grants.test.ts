import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ApprovalContext, JsonObject, Session, Tool, ToolRisk } from '@stratusagent/core';

import {
  createFileCommandWhitelist,
  createPermissionPolicy,
  describeToolGrant,
  findMatchingToolGrant,
  parseToolGrant,
  whitelistPathFor,
  WhitelistUnreadableError,
  type PermissionDecision,
  type ToolGrant,
} from '../src/index.ts';

const session = (agentId = 'ava', id = `sess-${agentId}`): Session => ({
  id,
  agent: { id: agentId, name: agentId === 'ava' ? 'Ava' : 'Juno', instructions: 'be useful' },
  status: 'running',
  messages: [],
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
}) as unknown as Session;

const plainTool = (name: string, risk: ToolRisk): Tool => ({
  name,
  risk,
  async execute() {
    return null;
  },
});

const shellTool = (): Tool => ({
  name: 'shell.run',
  risk: 'gated',
  commandFor: (input: JsonObject) => (typeof input.command === 'string' ? input.command : undefined),
  async execute() {
    return null;
  },
});

const contextFor = (tool: Tool, agentId = 'ava', input: JsonObject = {}): ApprovalContext => ({
  session: session(agentId),
  call: { id: 'call-1', toolName: tool.name, input },
  tool,
  risk: tool.risk ?? 'gated',
});

const newDirectory = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-grants-'));

/**
 * A grant file written by hand, the way an operator edits one. The agent's
 * own directory is where it lives now, and an operator creating it is
 * creating that directory too.
 */
const writeByHand = async (file: string, contents: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
};

test('always allow on a gated tool is a standing grant: per agent, past a restart, and never for allow once', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  const granted: ToolGrant[] = [];
  const answers = ['y', 'always'];
  let asks = 0;
  const first = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return answers.shift() ?? 'n';
    },
    grants: { store, onGranted: (event) => granted.push(event.grant) },
  });

  // "Allow once" runs the call and writes nothing.
  assert.equal(await first.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(asks, 1);
  assert.deepEqual(await store.toolGrantsFor('ava'), []);

  // "Always allow" is the grant — and the same conversation, the next one,
  // and a restarted daemon all read it back.
  assert.equal(await first.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(asks, 2);
  assert.equal(await first.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(asks, 2, 'covered by the grant, so it did not ask');
  assert.equal(granted.length, 1);
  assert.equal(granted[0]?.tool, 'web.fetch');

  const stored = JSON.parse(await readFile(whitelistPathFor(directory, 'ava'), 'utf8')) as { tools?: ToolGrant[] };
  assert.equal(stored.tools?.[0]?.tool, 'web.fetch');
  assert.match(stored.tools?.[0]?.grantedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

  // A fresh policy over a fresh store is a restarted daemon, in the mode
  // every installed service runs in — where a gated tool with no grant has
  // no other path to running at all.
  const decisions: PermissionDecision[] = [];
  const restarted = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    grants: { store: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }) },
  });
  assert.equal(await restarted.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(await restarted.approve(contextFor(plainTool('fs.write', 'gated'))), false, 'an ungranted gated tool is still refused');
  // The grant is Ava's: her teammate answering the same tool asks for itself.
  assert.equal(await restarted.approve(contextFor(plainTool('web.fetch', 'gated'), 'juno')), false);

  // The log can tell a call that ran under a grant from one that ran
  // because it was safe — the decision carries the grant itself.
  assert.match(decisions[0]!.reason, /ran under a standing grant for ava/);
  assert.equal(decisions[0]!.grant?.tool, 'web.fetch');
  assert.equal(await restarted.approve(contextFor(plainTool('memory.recall', 'safe'))), true);
  assert.equal(decisions[3]!.grant, undefined);
  assert.match(decisions[3]!.reason, /is safe/);
});

test('a grant file is read inside the host\'s serializer, so a revoke holding it is never read halfway', async () => {
  // The store caches what it reads for the life of the process. A daemon
  // that read the file while `stratus grants revoke` was rewriting it cached
  // the revoked grant and honoured it until restart (#184). The daemon's
  // serializer is the lock the revoke holds; here it stands in for a revoke
  // that finishes while the read waits on it, and the read must see the
  // result.
  const directory = await newDirectory();
  const writer = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  await writer.rememberTool('ava', { tool: 'web.fetch', package: 'stratus-plugin-web', grantedAt: '2026-09-07T01:00:00.000Z' });
  const file = whitelistPathFor(directory, 'ava');

  let held = 0;
  const reader = createFileCommandWhitelist({
    directory,
    stateHome: path.dirname(directory),
    serializeRead: (read) => {
      held += 1;
      writeFileSync(file, `${JSON.stringify({ version: 1, scopes: [] })}\n`);
      return read();
    },
  });

  assert.deepEqual((await reader.grantsFor('ava')).tools, []);
  assert.ok(held > 0, 'the read went through the serializer');
});

test('a grant change under the host\'s write serializer starts from the file, not the cache', async () => {
  // The daemon caches each agent's grants. When `stratus grants revoke`
  // rewrote the file behind it, the daemon's next "always" wrote its cache
  // back: the revoked grant returned, and anything the revoke's write held
  // was lost (#184).
  const directory = await newDirectory();
  const daemon = createFileCommandWhitelist({
    directory,
    stateHome: path.dirname(directory),
    serializeWrite: (write) => write(),
  });
  await daemon.rememberTool('ava', { tool: 'web.fetch', package: 'p', grantedAt: '2026-09-07T01:00:00.000Z' });
  assert.deepEqual((await daemon.grantsFor('ava')).tools.map((grant) => grant.tool), ['web.fetch']);

  // A revoke elsewhere: web.fetch gone, another grant there instead.
  const elsewhere = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  assert.equal(await elsewhere.forgetTool('ava', 'web.fetch'), true);
  await elsewhere.rememberTool('ava', { tool: 'web.search', package: 'p', grantedAt: '2026-09-07T02:00:00.000Z' });

  await daemon.rememberTool('ava', { tool: 'shell.run', package: 'p', grantedAt: '2026-09-07T03:00:00.000Z' });

  const onDisk = await createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }).grantsFor('ava');
  assert.deepEqual(onDisk.tools.map((grant) => grant.tool).sort(), ['shell.run', 'web.search']);
  // And the daemon's view caught up with the file it just wrote.
  assert.deepEqual((await daemon.grantsFor('ava')).tools.map((grant) => grant.tool).sort(), ['shell.run', 'web.search']);
});

test('a grant read the host could not serialize is no grants this once, and is not cached', async () => {
  // Reading through a lock still held is the race the lock exists to close.
  // No grants is the safe answer — the call asks a human — and caching it
  // would strip the agent's grants until a restart over one slow revoke.
  const directory = await newDirectory();
  const writer = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  await writer.rememberTool('ava', { tool: 'web.fetch', package: 'p', grantedAt: '2026-09-07T01:00:00.000Z' });

  let busy = true;
  const warnings: string[] = [];
  const reader = createFileCommandWhitelist({
    directory,
    stateHome: path.dirname(directory),
    warn: (line) => warnings.push(line),
    serializeRead: (read) => {
      if (busy) {
        throw new Error('grants.lock is held by another process.');
      }
      return read();
    },
  });

  assert.deepEqual((await reader.grantsFor('ava')).tools, []);
  assert.match(warnings.join('\n'), /was not read \(grants\.lock is held by another process\.\)/);
  busy = false;
  assert.deepEqual((await reader.grantsFor('ava')).tools.map((grant) => grant.tool), ['web.fetch']);
});

test('a grant change the host could not serialize is refused as unsaved, and writes nothing', async () => {
  // Writing through is the other half of the race. The refusal is a
  // WhitelistUnreadableError because every caller already handles that one
  // right: an "always" holds for the process, a revoke reports a conflict.
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({
    directory,
    stateHome: path.dirname(directory),
    serializeWrite: () => Promise.reject(new Error('grants.lock is held by another process.')),
  });

  await assert.rejects(
    store.rememberTool('ava', { tool: 'web.fetch', package: 'p', grantedAt: '2026-09-07T01:00:00.000Z' }),
    (error: unknown) => error instanceof WhitelistUnreadableError
      && /ava's grants were not changed: grants\.lock is held by another process\. Try again/.test(error.message),
  );
  await assert.rejects(readFile(whitelistPathFor(directory, 'ava'), 'utf8'), { code: 'ENOENT' });
});

test('a revoked grant stops working on the next call, with no restart', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
    grants: { store },
  });

  assert.equal(await policy.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(await policy.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(asks, 1);

  assert.equal(await store.forgetTool('ava', 'web.fetch'), true);
  assert.equal(await store.forgetTool('ava', 'web.fetch'), false, 'nothing left to revoke');
  assert.deepEqual((await store.grantsFor('ava')).tools, []);

  // The same policy instance, the same process: the next call asks again.
  // The process tier is cleared by the revoke too, or a revoke through the
  // API would be a promise the daemon kept only until its next restart.
  assert.equal(await policy.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(asks, 2);
});

test('a tool that names a command scope can never receive a tool grant, even by hand', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => 'always',
    commands: { whitelist: store },
    grants: { store },
  });

  // "Always" on a shell command persists the command's scope, and only that:
  // the tools list stays empty, because a grant on the whole shell is the
  // standing yes to every command this engine exists to prevent.
  assert.equal(await policy.approve(contextFor(shellTool(), 'ava', { command: 'git push origin main' })), true);
  const grants = await store.grantsFor('ava');
  assert.equal(grants.scopes.length, 1);
  assert.deepEqual(grants.tools, []);

  // And a grant written into the file by hand does not apply either — the
  // exclusion is structural, resolved before the grant tier is consulted.
  await writeByHand(
    whitelistPathFor(directory, 'ava'),
    JSON.stringify({ version: 1, scopes: [], tools: [{ tool: 'shell.run', grantedAt: '2026-09-07T00:00:00.000Z' }] }),
  );
  const decisions: PermissionDecision[] = [];
  const headless = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    commands: { whitelist: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }) },
    grants: { store: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }) },
  });
  assert.equal(await headless.approve(contextFor(shellTool(), 'ava', { command: 'rm -rf build' })), false);
  assert.match(decisions[0]!.reason, /nobody is available to approve it/);
});

test('a dangerous tool cannot receive a standing grant', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
    grants: { store },
  });

  assert.equal(await policy.approve(contextFor(plainTool('fs.delete', 'dangerous'))), true);
  assert.equal(await policy.approve(contextFor(plainTool('fs.delete', 'dangerous'))), true);
  assert.equal(asks, 2, 'asked every time');
  assert.deepEqual(await store.toolGrantsFor('ava'), []);

  // Nor by hand: a `tools` row for a dangerous tool is not consulted.
  await writeByHand(
    whitelistPathFor(directory, 'ava'),
    JSON.stringify({ version: 1, scopes: [], tools: [{ tool: 'fs.delete', grantedAt: '2026-09-07T00:00:00.000Z' }] }),
  );
  const headless = createPermissionPolicy({ mode: 'headless', grants: { store: createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }) } });
  assert.equal(await headless.approve(contextFor(plainTool('fs.delete', 'dangerous'))), false);
});

test('a grant follows the tool as contributed when granted, not a later tool of the same name', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  let contributor: string | undefined = 'stratus-plugin-github';
  let asks = 0;
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
    onDecision: (decision) => decisions.push(decision),
    grants: { store, contributorOf: () => contributor },
  });

  assert.equal(await policy.approve(contextFor(plainTool('github.comment', 'gated'))), true);
  const [grant] = await store.toolGrantsFor('ava');
  assert.equal(grant?.package, 'stratus-plugin-github');
  assert.equal(describeToolGrant(grant!), 'github.comment (stratus-plugin-github)');
  assert.equal(await policy.approve(contextFor(plainTool('github.comment', 'gated'))), true);
  assert.equal(asks, 1);

  // The same name from a different package is a different tool: the
  // realistic case is a plugin update, and the operator said yes to what
  // the tool did then. It asks again, and the new answer replaces the row.
  contributor = 'someone-elses-github';
  assert.equal(await policy.approve(contextFor(plainTool('github.comment', 'gated'))), true);
  assert.equal(asks, 2);
  const after = await store.toolGrantsFor('ava');
  assert.equal(after.length, 1, 'one grant per tool per agent');
  assert.equal(after[0]?.package, 'someone-elses-github');

  // A kernel tool (no package) matches only a grant recorded with none.
  assert.equal(findMatchingToolGrant('github.comment', undefined, after), undefined);
});

test('a remote always records who answered, and the request says what always would grant', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  const seen: Array<{ tool: string; always: string | undefined; oneShot: boolean | undefined }> = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      seen.push({ tool: request.call.toolName, always: request.always, oneShot: request.oneShot });
      return { answer: 'always', actor: 'U0APPROVER' };
    },
    grants: { store },
  });

  assert.equal(await policy.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(await policy.approve(contextFor(plainTool('fs.delete', 'dangerous'))), true);
  assert.deepEqual(seen, [
    { tool: 'web.fetch', always: 'tool', oneShot: undefined },
    { tool: 'fs.delete', always: undefined, oneShot: true },
  ]);
  const [grant] = await store.toolGrantsFor('ava');
  assert.equal(grant?.grantedBy, 'U0APPROVER');
});

test('the interactive prompt names the agent and the lifetime for a standing grant', async () => {
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asked.push(question);
      return 'n';
    },
  });
  await policy.approve(contextFor(plainTool('web.fetch', 'gated')));
  assert.match(asked[0]!, /\[a\]lways \(always for Ava, until revoked\)/);
});

test('without a store, a standing grant still holds for the process and for the agent alone', async () => {
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
  });
  assert.equal(await policy.approve(contextFor(plainTool('web.fetch', 'gated'))), true);
  assert.equal(await policy.approve({ ...contextFor(plainTool('web.fetch', 'gated')), session: session('ava', 'sess-2') }), true);
  assert.equal(asks, 1, 'another session of the same agent is covered');
  assert.equal(await policy.approve(contextFor(plainTool('web.fetch', 'gated'), 'juno')), true);
  assert.equal(asks, 2, 'another agent is not');
});

test('a revoke whose write fails leaves the grant standing, rather than dropping it until the next restart', async () => {
  const directory = await newDirectory();
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  await store.rememberTool('ava', { tool: 'web.fetch', grantedAt: '2026-09-07T00:00:00.000Z' });

  // The grant is readable and cached; the *write* is what fails — a
  // read-only mount, a full disk. Staged by putting a directory where the
  // file goes, which `writeFile` refuses for any user, root included: a
  // mode-only trick passes as root and would make this test prove nothing.
  const file = whitelistPathFor(directory, 'ava');
  const saved = await readFile(file, 'utf8');
  await rm(file);
  await mkdir(file);

  await assert.rejects(store.forgetTool('ava', 'web.fetch'), 'the revoke reported its failure');

  // The direction that matters: the caller was told the revoke failed, so
  // the grant must still be honoured. Updating the cache before the write
  // landed meant the daemon stopped honouring it anyway and then handed it
  // back at the next restart — a grant returning from the dead.
  assert.deepEqual(
    (await store.toolGrantsFor('ava')).map((grant) => grant.tool),
    ['web.fetch'],
    'the live view still holds the grant the file still holds',
  );

  // And the file was never touched, so a restarted daemon agrees with both.
  await rm(file, { recursive: true });
  await writeFile(file, saved);
  assert.deepEqual(
    (await createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) }).toolGrantsFor('ava')).map((grant) => grant.tool),
    ['web.fetch'],
  );
});

test('grant rows are read leniently and written back whole, beside the scopes they sit with', async () => {
  const directory = await newDirectory();
  await writeByHand(
    whitelistPathFor(directory, 'ava'),
    JSON.stringify({
      version: 1,
      scopes: [{ command: 'git', args: ['push'] }],
      origins: [{ origin: 'https://app.example.com' }],
      tools: [{ tool: 'web.fetch' }, { tool: '' }, 'nonsense', { tool: 'fs.write', package: 'x', grantedAt: 't', grantedBy: 'U1' }],
    }),
  );
  const store = createFileCommandWhitelist({ directory, stateHome: path.dirname(directory) });
  const grants = await store.grantsFor('ava');
  assert.equal(grants.scopes.length, 1);
  assert.equal(grants.origins.length, 1);
  assert.deepEqual(grants.tools.map((grant) => grant.tool), ['web.fetch', 'fs.write']);
  assert.equal(grants.tools[0]?.grantedAt, '1970-01-01T00:00:00.000Z', 'a hand-written row is dated to the epoch, not invented');

  // Revoking any one kind carries the other two through untouched.
  assert.equal(await store.forgetScope('ava', 'git push'), true);
  assert.equal(await store.forgetOrigin('ava', 'https://nowhere.example'), false);
  const stored = JSON.parse(await readFile(whitelistPathFor(directory, 'ava'), 'utf8')) as Record<string, unknown[]>;
  assert.deepEqual(stored.scopes, []);
  assert.equal(stored.origins?.length, 1);
  assert.equal(stored.tools?.length, 2);

  assert.equal(parseToolGrant({ tool: 'a.b', package: '', grantedAt: 'x' })?.package, undefined);
});

test('a grant is never written through a symlinked agent directory', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-grants-link-'));
  const agents = path.join(home, 'agents');
  await mkdir(agents, { recursive: true });
  // Pointed at another agent's directory, which is the worst version: both
  // identities would resolve the same `whitelist.json`, so each inherits
  // what the other was granted unattended and one revocation covers both.
  const bea = path.join(agents, 'bea');
  await mkdir(bea, { recursive: true });
  await symlink(bea, path.join(agents, 'ava'));

  // Bea has grants of her own, which are what Ava would inherit.
  await createFileCommandWhitelist({ directory: agents, stateHome: path.dirname(agents) }).rememberTool('bea', {
    tool: 'web.fetch',
    grantedAt: '2026-03-01T00:00:00.000Z',
  });

  const store = createFileCommandWhitelist({ directory: agents, stateHome: path.dirname(agents) });
  await assert.rejects(
    () => store.rememberTool('ava', { tool: 'shell.run', grantedAt: '2026-03-01T00:00:00.000Z' }),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  // And the read refuses too, which is the half that matters: resolving
  // through the link would report Bea's standing permissions as Ava's.
  await assert.rejects(
    () => store.grantsFor('ava'),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  assert.deepEqual((await createFileCommandWhitelist({ directory: agents, stateHome: path.dirname(agents) }).grantsFor('bea')).tools.map((grant) => grant.tool), ['web.fetch']);
  await rm(home, { recursive: true, force: true });
});

test('a whitelist.json that is a symlink is refused, even inside a real directory', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-grants-file-link-'));
  const agents = path.join(home, 'agents');
  await mkdir(path.join(agents, 'ava'), { recursive: true });
  await mkdir(path.join(agents, 'bea'), { recursive: true });
  const beas = whitelistPathFor(agents, 'bea');
  await createFileCommandWhitelist({ directory: agents, stateHome: path.dirname(agents) }).rememberTool('bea', {
    tool: 'web.fetch',
    grantedAt: '2026-03-01T00:00:00.000Z',
  });
  // The directory is real; only the file is a link. Followed, it makes Bea's
  // list authoritative for Ava — and the migration would read the
  // destination as populated and archive Ava's real legacy grants.
  await symlink(beas, whitelistPathFor(agents, 'ava'));

  const store = createFileCommandWhitelist({ directory: agents, stateHome: path.dirname(agents) });
  await assert.rejects(
    () => store.grantsFor('ava'),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  await assert.rejects(
    () => store.rememberTool('ava', { tool: 'shell.run', grantedAt: '2026-03-01T00:00:00.000Z' }),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  assert.deepEqual(
    (await createFileCommandWhitelist({ directory: agents, stateHome: path.dirname(agents) }).grantsFor('bea')).tools.map((grant) => grant.tool),
    ['web.fetch'],
  );
  await rm(home, { recursive: true, force: true });
});
