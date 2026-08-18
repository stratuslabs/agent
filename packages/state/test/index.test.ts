import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentsDirPath,
  createFileMemoryStore,
  loadConfigFile,
  loadRosterSouls,
  loadSoulFile,
  MAX_APPROVAL_TIMEOUT_MS,
  memoryFilePath,
  resolveAgentApprovals,
  resolveRuntimeConfig,
  saveCredentials,
} from '../src/index.ts';

const tempHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-state-'));

test('file memory store appends and lists per agent with read-time dedupe', async () => {
  const store = createFileMemoryStore(memoryFilePath({ homeDir: tempHome }));
  await store.append('ava', 'likes short answers');
  await store.append('scout', 'reads everything');
  const entries = await store.list('ava');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, 'likes short answers');
});

test('roster loading returns parsed souls and skips unreadable files with a warning', async () => {
  const env = { homeDir: tempHome };
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');
  // A directory with a .md name is unreadable as a soul file and must be
  // skipped without taking the rest of the roster down.
  await mkdir(path.join(agentsDirPath(env), 'broken.md'), { recursive: true });

  const warnings: string[] = [];
  const roster = await loadRosterSouls(env, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /broken\.md/);
  const ava = roster.find((entry) => entry.soul.agent.name === 'Ava');
  assert.ok(ava);
  assert.equal(ava.soul.agent.instructions, 'You are Ava.');
});

test('soul identity is seeded by path so ids stay stable across loads', async () => {
  const env = { homeDir: tempHome };
  const soulPath = path.join(agentsDirPath(env), 'anon.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(soulPath, 'Just a persona, no frontmatter.\n');
  const first = await loadSoulFile(soulPath);
  const second = await loadSoulFile(soulPath);
  assert.equal(first.agent.id, second.agent.id);
});

test('credentials file is written owner-read-only', async () => {
  const env = { homeDir: tempHome };
  await saveCredentials(env, { anthropic: { type: 'api_key', value: 'sk-test' } });
  const filePath = path.join(tempHome, '.stratus', 'credentials.json');
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('runtime config defaults to the demo provider with no configuration', async () => {
  const config = await resolveRuntimeConfig({}, {
    homeDir: tempHome,
    cwd: tempHome,
    processEnv: {},
  });
  assert.equal(config.provider, 'demo');
});

test('fallback stickiness is per session, never per pooled provider', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const makeSession = (id: string) => ({
    id,
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  });

  const primary = {
    name: 'primary',
    async generate({ session }: { session: { id: string } }) {
      if (session.id === 'flaky') {
        throw new Error('primary down for flaky');
      }
      return { parts: [{ type: 'text' as const, text: 'primary' }] };
    },
  };
  const fallback = {
    name: 'fallback',
    async generate() {
      return { parts: [{ type: 'text' as const, text: 'fallback' }] };
    },
  };

  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});

  const flaky = await wrapped.generate({ session: makeSession('flaky') } as never);
  assert.equal((flaky.parts[0] as { text: string }).text, 'fallback');
  // A different session on the same pooled provider stays on the primary.
  const healthy = await wrapped.generate({ session: makeSession('healthy') } as never);
  assert.equal((healthy.parts[0] as { text: string }).text, 'primary');
  // The flaky session itself stays switched for good.
  const flakyAgain = await wrapped.generate({ session: makeSession('flaky') } as never);
  assert.equal((flakyAgain.parts[0] as { text: string }).text, 'fallback');
});

test('fallback stickiness survives a wrapper rebuild via session metadata', async () => {
  const { createFallbackWrappedProvider, FALLBACK_ACTIVE_METADATA_KEY } = await import('../src/index.ts');
  const session = {
    id: 'restarted',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
    metadata: { [FALLBACK_ACTIVE_METADATA_KEY]: true },
  };

  let primaryCalls = 0;
  const primary = {
    name: 'primary',
    async generate() {
      primaryCalls += 1;
      return { parts: [{ type: 'text' as const, text: 'primary' }] };
    },
  };
  const fallback = {
    name: 'fallback',
    async generate() {
      return { parts: [{ type: 'text' as const, text: 'fallback' }] };
    },
  };

  // A fresh wrapper (restarted daemon / rebuilt runner) still honors the
  // durable switch recorded on the session.
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  const result = await wrapped.generate({ session } as never);
  assert.equal((result.parts[0] as { text: string }).text, 'fallback');
  assert.equal(primaryCalls, 0);
});

test('a fallback switch records itself in session metadata', async () => {
  const { createFallbackWrappedProvider, FALLBACK_ACTIVE_METADATA_KEY } = await import('../src/index.ts');
  const session = {
    id: 'switching',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  } as { id: string; metadata?: Record<string, unknown> };

  const primary = { name: 'p', async generate() { throw new Error('down'); } };
  const fallback = { name: 'f', async generate() { return { parts: [{ type: 'text' as const, text: 'ok' }] }; } };

  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  await wrapped.generate({ session } as never);
  assert.equal(session.metadata?.[FALLBACK_ACTIVE_METADATA_KEY], true);
});

test('channel credentials live in their own namespace and survive setup re-saves', async () => {
  const { loadChannelCredentials, saveChannelCredentials, loadCredentials } = await import('../src/index.ts');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-chan-'));
  const env = { homeDir: home };

  await saveCredentials(env, { anthropic: { type: 'oauth_token', value: 'tok-1' } });
  await saveChannelCredentials(env, {
    slack: { ava: { appToken: 'xapp-1', botToken: 'xoxb-1' } },
  });
  // A later provider re-save (what `stratus setup` does) must not clobber
  // the channel tokens — and vice versa.
  await saveCredentials(env, { anthropic: { type: 'oauth_token', value: 'tok-2' } });

  const channels = await loadChannelCredentials(env);
  assert.deepEqual(channels, { slack: { ava: { appToken: 'xapp-1', botToken: 'xoxb-1' } } });
  const providers = await loadCredentials(env);
  assert.equal(providers.anthropic?.value, 'tok-2');

  const filePath = path.join(home, '.stratus', 'credentials.json');
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a mid-stream primary failure emits a reset delta before the fallback streams', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const session = {
    id: 'garbled',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  const primary = {
    name: 'p',
    async generate({ onDelta }: { onDelta?: (d: { type: string; text?: string }) => Promise<void> | void }) {
      await onDelta?.({ type: 'text', text: 'partial pri' });
      throw new Error('primary died mid-stream');
    },
  };
  const fallback = {
    name: 'f',
    async generate({ onDelta }: { onDelta?: (d: { type: string; text?: string }) => Promise<void> | void }) {
      await onDelta?.({ type: 'text', text: 'fallback says hi' });
      return { parts: [{ type: 'text' as const, text: 'fallback says hi' }] };
    },
  };

  const seen: string[] = [];
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  await wrapped.generate({
    session,
    onDelta: async (delta: { type: string; text?: string }) => {
      seen.push(delta.type === 'text' ? `text:${delta.text}` : delta.type);
    },
  } as never);

  // Consumers see: partial primary → reset (discard it) → clean fallback.
  assert.deepEqual(seen, ['text:partial pri', 'reset', 'text:fallback says hi']);
});

test('a primary that dies before its first delta still emits the reset', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const session = {
    id: 'silent-switch',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  const primary = {
    name: 'p',
    async generate() {
      throw new Error('down before streaming anything');
    },
  };
  const fallback = {
    name: 'f',
    async generate() {
      return { parts: [{ type: 'text' as const, text: 'quiet fallback' }] };
    },
  };

  const seen: string[] = [];
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  await wrapped.generate({
    session,
    onDelta: async (delta: { type: string }) => {
      seen.push(delta.type);
    },
  } as never);

  // The reset is the one in-band signal that the turn switched providers —
  // watchers (the gateway's idle watchdog) need it even when there was no
  // partial output to discard.
  assert.deepEqual(seen, ['reset']);
});

test('config file errors are typed and preserve the underlying fs code', async () => {
  const { loadConfigFile, resolveConfigLocation, ConfigFileError } = await import('../src/index.ts');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-cfg-'));

  // Missing file: callers that branch on ENOENT (first-run setup, agent
  // creation) keep working on error.code.
  await assert.rejects(
    () => loadConfigFile(path.join(home, 'nope.json')),
    (error: Error & { code?: string }) => error instanceof ConfigFileError && error.code === 'ENOENT',
  );

  // Malformed JSON: typed, so a daemon can degrade on exactly this class.
  await writeFile(path.join(home, 'bad.json'), '{ "soul": ');
  await assert.rejects(
    () => loadConfigFile(path.join(home, 'bad.json')),
    (error: unknown) => error instanceof ConfigFileError,
  );

  // Auto-discovery over a candidate that exists but cannot be read (here:
  // a directory wearing the config filename) fails typed as well — the
  // same degradation path as a parse failure.
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-cfg-proj-'));
  await mkdir(path.join(project, 'stratus.config.json'));
  await assert.rejects(
    () => resolveConfigLocation({}, { homeDir: home, cwd: project }),
    (error: unknown) => error instanceof ConfigFileError,
  );
});

test('the fallback switch persists before the fallback attempt begins', async () => {
  const { createFallbackWrappedProvider, FALLBACK_ACTIVE_METADATA_KEY } = await import('../src/index.ts');
  const session = {
    id: 'durable-switch',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  } as { id: string; metadata?: Record<string, unknown> };

  const order: string[] = [];
  const primary = { name: 'p', async generate() { throw new Error('down'); } };
  const fallback = {
    name: 'f',
    async generate() {
      order.push('fallback');
      return { parts: [{ type: 'text' as const, text: 'ok' }] };
    },
  };

  // A daemon killed while the fallback is in flight must find the switch
  // already durable on restart — persistence cannot wait for the turn's
  // next save.
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {}, async (persisted) => {
    order.push('persist');
    assert.equal((persisted as { metadata?: Record<string, unknown> }).metadata?.[FALLBACK_ACTIVE_METADATA_KEY], true);
  });
  await wrapped.generate({ session } as never);

  assert.deepEqual(order, ['persist', 'fallback']);
});

test('the memory file is owner-only, pre-existing files included', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-mem-'));
  const filePath = memoryFilePath({ homeDir: home });

  // Simulate a file created earlier under a loose umask.
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '', { mode: 0o644 });

  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'remembers privately');

  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

const writeConfig = async (name: string, body: unknown): Promise<string> => {
  const configPath = path.join(tempHome, name);
  await writeFile(configPath, JSON.stringify(body));
  return configPath;
};

test('the approvals block parses, and a misspelled mode fails loudly', async () => {
  const configPath = await writeConfig('approvals.json', {
    approvals: {
      mode: 'remote',
      timeoutMs: 60000,
      slackApprovers: ['U-OPS', ''],
      slackChannel: 'C-OPS',
      agents: { ava: { slackApprovers: ['U-DYLAN'] }, bea: { slackChannel: 'C-BEA' } },
    },
  });

  const config = await loadConfigFile(configPath);
  assert.equal(config.approvals?.mode, 'remote');
  assert.equal(config.approvals?.timeoutMs, 60000);
  // Empty ids are dropped rather than carried into an approver set, where
  // they would sit next to real ids looking like coverage.
  assert.deepEqual(config.approvals?.slackApprovers, ['U-OPS']);

  // A mode that silently fell back to headless would be discovered as an
  // agent that mysteriously refuses everything, with the config in front of
  // you saying otherwise.
  const badMode = await writeConfig('bad-mode.json', { approvals: { mode: 'ask' } });
  await assert.rejects(loadConfigFile(badMode), /Unsupported approvals\.mode/);
  const badTimeout = await writeConfig('bad-timeout.json', { approvals: { timeoutMs: -1 } });
  await assert.rejects(loadConfigFile(badTimeout), /Invalid approvals\.timeoutMs/);

  // 30 days looks like a perfectly reasonable approval window and is not:
  // setTimeout turns anything past ~24.8 days into a 1ms delay, so this
  // would expire every approval immediately rather than waiting a month.
  // Refused, not clamped — the number someone wrote has to be the number
  // they are told about.
  const hugeTimeout = await writeConfig('huge-timeout.json', { approvals: { timeoutMs: 2_592_000_000 } });
  await assert.rejects(loadConfigFile(hugeTimeout), /longer than the maximum/);
  // The boundary itself is fine.
  const maxTimeout = await writeConfig('max-timeout.json', { approvals: { timeoutMs: MAX_APPROVAL_TIMEOUT_MS } });
  assert.equal((await loadConfigFile(maxTimeout)).approvals?.timeoutMs, MAX_APPROVAL_TIMEOUT_MS);
});

test('an agent inherits the default approval route key by key', async () => {
  const approvals = {
    slackApprovers: ['U-OPS'],
    slackChannel: 'C-OPS',
    agents: { ava: { slackApprovers: ['U-DYLAN'] }, bea: { slackChannel: 'C-BEA' } },
  };

  // Ava names her own approvers but not her own channel, so she asks the
  // people she listed in the default conversation. Per-key inheritance, not
  // per-block: overriding one must not silently clear the other.
  assert.deepEqual(resolveAgentApprovals(approvals, 'ava'), {
    slackApprovers: ['U-DYLAN'],
    slackChannel: 'C-OPS',
  });
  assert.deepEqual(resolveAgentApprovals(approvals, 'bea'), {
    slackApprovers: ['U-OPS'],
    slackChannel: 'C-BEA',
  });
  assert.deepEqual(resolveAgentApprovals(approvals, 'unlisted'), {
    slackApprovers: ['U-OPS'],
    slackChannel: 'C-OPS',
  });
  // Nothing configured means nobody may approve — never everybody.
  assert.deepEqual(resolveAgentApprovals(undefined, 'ava'), {});
});

test('an explicitly empty approver list excludes an agent instead of inheriting', async () => {
  const approvals = {
    slackApprovers: ['U-OPS'],
    agents: { ava: { slackApprovers: [] }, bea: {} },
  };

  // Writing `[]` for one agent is how an operator takes that agent out of a
  // global approver list. Treating it as "unset" would fall back to exactly
  // the list they were excluding — turning "nobody may approve for Ava"
  // into "everyone on the default list may".
  assert.deepEqual(resolveAgentApprovals(approvals, 'ava'), { slackApprovers: [] });
  // An absent key still inherits: that is what the fallback is for.
  assert.deepEqual(resolveAgentApprovals(approvals, 'bea'), { slackApprovers: ['U-OPS'] });

  // And it survives config parsing, which is where it was being dropped.
  const configPath = await writeConfig('empty-approvers.json', {
    approvals: { slackApprovers: ['U-OPS'], agents: { ava: { slackApprovers: [] } } },
  });
  const parsed = (await loadConfigFile(configPath)).approvals;
  assert.deepEqual(resolveAgentApprovals(parsed, 'ava'), { slackApprovers: [] });
  // A list of nothing but junk is the same statement as an empty one.
  const junkPath = await writeConfig('junk-approvers.json', {
    approvals: { slackApprovers: ['U-OPS'], agents: { ava: { slackApprovers: ['', ''] } } },
  });
  const junk = (await loadConfigFile(junkPath)).approvals;
  assert.deepEqual(resolveAgentApprovals(junk, 'ava'), { slackApprovers: [] });
});
