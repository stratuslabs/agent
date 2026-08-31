import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentsDirPath,
  createFileMemoryStore,
  DuplicateAgentIdError,
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
  const { entries } = await store.list('ava');
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

test('two souls claiming one id refuse the roster, naming both files', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-roster-dup-'));
  const dir = agentsDirPath({ homeDir: home });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'a-first.md'), '---\nname: First\nid: twin\n---\n\nYou are First.\n');
  await writeFile(path.join(dir, 'b-second.md'), '---\nname: Second\nid: twin\n---\n\nYou are Second.\n');

  // Not a degraded load. Skipping an unreadable soul loses one agent and
  // it is obvious which; picking a winner here makes one agent inherit the
  // other's sessions, memory, and credentials, decided by sort order.
  const failure = await loadRosterSouls({ homeDir: home }, () => {}).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DuplicateAgentIdError, `expected a typed refusal, got ${String(failure)}`);
  assert.equal(failure.agentId, 'twin');
  // Both files, so the collision can actually be fixed.
  assert.match(failure.message, /a-first\.md/);
  assert.match(failure.message, /b-second\.md/);
});

test('an unreadable soul still degrades to a warning, unlike a duplicate', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-roster-broken-'));
  const dir = agentsDirPath({ homeDir: home });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'good.md'), '---\nname: Good\nid: good\n---\n\nYou are Good.\n');
  // Frontmatter opened and never closed, plus a path-capable id in another
  // file: both are one-file problems, and one broken soul must never take
  // the rest of the team down.
  await writeFile(path.join(dir, 'broken.md'), '---\nname: Broken\n\nno closing fence\n');
  await writeFile(path.join(dir, 'escaping.md'), '---\nname: Escape\nid: ../../escape\n---\n\nYou escape.\n');

  const warnings: string[] = [];
  const entries = await loadRosterSouls({ homeDir: home }, (line) => warnings.push(line));

  assert.deepEqual(entries.map((entry) => entry.soul.agent.id), ['good']);
  assert.equal(warnings.length, 2, `expected both bad files skipped, got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((line) => line.includes('Invalid agent id')), JSON.stringify(warnings));
});

test('two souls claiming the reserved id are skipped, not treated as a collision', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-roster-reserved-'));
  const dir = agentsDirPath({ homeDir: home });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'a.md'), '---\nname: One\nid: stratus\n---\n\nYou are one.\n');
  await writeFile(path.join(dir, 'b.md'), '---\nname: Two\nid: stratus\n---\n\nYou are two.\n');
  await writeFile(path.join(dir, 'ava.md'), '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');

  // Neither was going to get the id — it is reserved — so their agreeing
  // on it is not an ambiguity worth refusing over. Left after the
  // collision check, a repository could take a daemon down just by
  // shipping two souls named `stratus`, turning a guard against hijacking
  // the built-in into a way to deny service.
  const warnings: string[] = [];
  const entries = await loadRosterSouls({ homeDir: home }, (line) => warnings.push(line));

  assert.deepEqual(entries.map((entry) => entry.soul.agent.id), ['ava']);
  assert.equal(warnings.filter((line) => line.includes('reserved')).length, 2);
});

test('an injected query transport reaches a subscription fallback behind any primary', async () => {
  // The pair is supported and the failure is silent: an OpenAI primary
  // carries no queryFn of its own, so a fallback that does not receive one
  // reaches the real Agent SDK the moment the primary fails — launching
  // Claude Code out of a test, or out from under an embedder that pinned
  // its transport on purpose.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-openai' },
      anthropic: { type: 'oauth_token', value: 'sk-ant-oat' },
    }),
  );
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'openai', model: 'gpt-4o', fallbackProvider: 'anthropic', fallbackModel: 'claude-opus-5' }),
  );

  const queryFn = (() => (async function* () {})()) as never;
  const resolved = await resolveRuntimeConfig({}, {
    homeDir: home,
    cwd: home,
    processEnv: {},
    queryFn,
  });

  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.fallback?.provider, 'anthropic');
  assert.equal(resolved.fallback?.queryFn, queryFn, 'the fallback must carry the injected transport');
});

test('a codex runtime resolves from a stored API key, and CODEX_API_KEY outranks it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ codex: { type: 'api_key', value: 'sk-stored' } }),
  );
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'codex' }),
  );

  const stored = await resolveRuntimeConfig({}, { homeDir: home, cwd: home, processEnv: {} });
  assert.equal(stored.provider, 'codex');
  assert.equal(stored.provider === 'codex' && stored.apiKey, 'sk-stored');
  // The codex harness serves its own model lineup; the default is its own.
  assert.equal(stored.model, 'gpt-5.5');

  const env = await resolveRuntimeConfig({}, {
    homeDir: home,
    cwd: home,
    processEnv: { CODEX_API_KEY: 'sk-env' },
  });
  assert.equal(env.provider === 'codex' && env.apiKey, 'sk-env');
  assert.equal(env.provider === 'codex' && env.apiKeyEnvVar, 'CODEX_API_KEY');
});

test('a codex ChatGPT marker resolves keyless, and its value never reaches the config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ codex: { type: 'oauth_token', value: 'chatgpt' } }),
  );
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'codex' }));

  const resolved = await resolveRuntimeConfig({}, { homeDir: home, cwd: home, processEnv: {} });
  assert.equal(resolved.provider, 'codex');
  // Keyless on purpose: the machine's own `codex login` sign-in serves the
  // run, and the marker's value is not a secret to carry anywhere.
  assert.equal(resolved.provider === 'codex' && resolved.apiKey, undefined);
  assert.ok(!JSON.stringify(resolved).includes('chatgpt'), 'the marker value must not ride into the runtime config');
});

test('provider codex with no sign-in at all refuses with codex guidance', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'codex' }));

  await assert.rejects(
    () => resolveRuntimeConfig({}, { homeDir: home, cwd: home, processEnv: {} }),
    /codex login.*CODEX_API_KEY|CODEX_API_KEY/s,
  );
});

test('an injected codex transport reaches the codex runtime and a codex fallback', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-openai' },
      codex: { type: 'oauth_token', value: 'chatgpt' },
    }),
  );
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'openai', model: 'gpt-4o', fallbackProvider: 'codex', fallbackModel: 'gpt-5.5' }),
  );

  const codexRunTurn = (() => (async function* () {})()) as never;
  const resolved = await resolveRuntimeConfig({}, {
    homeDir: home,
    cwd: home,
    processEnv: {},
    codexRunTurn,
  });

  assert.equal(resolved.provider, 'openai');
  // A keyless codex fallback stands only because the subscription marker
  // says the machine has a sign-in — and it carries the injected transport,
  // or the first primary failure launches the real codex binary.
  assert.equal(resolved.fallback?.provider, 'codex');
  assert.equal(resolved.fallback?.codexSubscription, true);
  assert.equal(resolved.fallback?.codexRunTurn, codexRunTurn, 'the fallback must carry the injected transport');
});

test('a codex key never follows a configured endpoint — a named base URL refuses the run', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'codex' }));

  // A stored key bound to an endpoint: codex consumes no URL, so honoring
  // the binding is impossible and dropping it would send the key to the
  // harness's own endpoint instead — the exact redirect bindings exist to
  // prevent. The run is refused.
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ codex: { type: 'api_key', value: 'sk-proxy-key', baseUrl: 'https://proxy.local/v1' } }),
  );
  await assert.rejects(
    () => resolveRuntimeConfig({}, { homeDir: home, cwd: home, processEnv: {} }),
    /codex does not use a custom base URL/,
  );

  // The same for an explicit URL beside an environment key.
  await assert.rejects(
    () => resolveRuntimeConfig({}, {
      homeDir: home,
      cwd: home,
      processEnv: { CODEX_API_KEY: 'sk-env', STRATUS_BASE_URL: 'https://proxy.local/v1' },
    }),
    /codex does not use a custom base URL/,
  );
});

test('a codex fallback with an endpoint-bound key is quietly skipped, never unbound', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      openai: { type: 'api_key', value: 'sk-openai' },
      codex: { type: 'api_key', value: 'sk-proxy-key', baseUrl: 'https://proxy.local/v1' },
    }),
  );
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'openai', model: 'gpt-4o', fallbackProvider: 'codex', fallbackModel: 'gpt-5.5' }),
  );

  const resolved = await resolveRuntimeConfig({}, { homeDir: home, cwd: home, processEnv: {} });
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.fallback, undefined, 'a bound codex key must not serve a fallback that cannot honor the binding');
});

test('the fallback wrapper names the fallback on usage that arrived unnamed', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const session = {
    id: 'unnamed',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  const primary = {
    name: 'primary',
    async generate() {
      throw new Error('primary down');
    },
  };
  // An adapter that does not name itself. The wrapper answers to the
  // primary's name for the life of the session, so without this the kernel
  // would file the fallback model's tokens under the model that failed —
  // in the one case attribution exists for.
  const fallback = {
    name: 'fallback',
    async generate({ onUsage }: { onUsage?: (usage: { inputTokens?: number; provider?: string }) => void }) {
      onUsage?.({ inputTokens: 5 });
      return { parts: [{ type: 'text' as const, text: 'rescued' }], usage: { outputTokens: 7 } };
    },
  };

  const reported: Array<{ provider?: string }> = [];
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  const response = await wrapped.generate({
    session,
    onUsage: (usage: { provider?: string }) => reported.push(usage),
  } as never);

  assert.deepEqual(reported, [{ inputTokens: 5, provider: 'fallback' }]);
  assert.deepEqual(response.usage, { outputTokens: 7, provider: 'fallback' });
});

test('the fallback wrapper leaves usage that named itself alone', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const session = {
    id: 'named',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  const primary = {
    name: 'primary',
    async generate() {
      throw new Error('primary down');
    },
  };
  const fallback = {
    name: 'fallback',
    async generate() {
      // A harness fallback reporting per-model calls of its own: the name it
      // supplies is the one that has to survive.
      return { parts: [{ type: 'text' as const, text: 'ok' }], usage: { provider: 'inner', model: 'm' } };
    },
  };

  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  const response = await wrapped.generate({ session } as never);

  assert.deepEqual(response.usage, { provider: 'inner', model: 'm' });
});

test('a fallback that answers on its response is still counted after the primary used the sink', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const session = {
    id: 'rescued',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  // A harness primary: reports the attempt it paid for, then fails.
  const primary = {
    name: 'primary',
    async generate({ onUsage }: { onUsage?: (usage: { provider?: string; inputTokens?: number }) => void }) {
      onUsage?.({ provider: 'primary', inputTokens: 5 });
      throw new Error('primary down');
    },
  };
  // A single-call fallback: answers on the response, the way an API adapter
  // does. Sink exclusivity is per generate and both providers share this
  // one, so without the wrapper forwarding it the turn that actually
  // succeeded would go uncounted while the attempt that failed did not.
  const fallback = {
    name: 'fallback',
    async generate() {
      return {
        parts: [{ type: 'text' as const, text: 'rescued' }],
        usage: { provider: 'fallback', model: 'fallback-1', outputTokens: 9 },
      };
    },
  };

  const reported: Array<{ provider?: string }> = [];
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  await wrapped.generate({ session, onUsage: (usage: { provider?: string }) => reported.push(usage) } as never);

  assert.deepEqual(reported, [
    { provider: 'primary', inputTokens: 5 },
    { provider: 'fallback', model: 'fallback-1', outputTokens: 9 },
  ]);
});

test('a fallback that uses the sink itself is not also counted from its response', async () => {
  const { createFallbackWrappedProvider } = await import('../src/index.ts');
  const session = {
    id: 'no-double',
    agent: { id: 'a', name: 'A' },
    status: 'running' as const,
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  const primary = {
    name: 'primary',
    async generate() {
      throw new Error('primary down');
    },
  };
  // An adapter using both channels for the same call. Forwarding is scoped
  // by whether the fallback used the sink, so its last call is recorded
  // once — the same rule the kernel applies one level up.
  const fallback = {
    name: 'fallback',
    async generate({ onUsage }: { onUsage?: (usage: { provider?: string; inputTokens?: number }) => void }) {
      onUsage?.({ provider: 'fallback', inputTokens: 3 });
      return {
        parts: [{ type: 'text' as const, text: 'ok' }],
        usage: { provider: 'fallback', inputTokens: 3 },
      };
    },
  };

  const reported: Array<{ provider?: string }> = [];
  const wrapped = createFallbackWrappedProvider(primary as never, fallback as never, () => {});
  await wrapped.generate({ session, onUsage: (usage: { provider?: string }) => reported.push(usage) } as never);

  assert.deepEqual(reported, [{ provider: 'fallback', inputTokens: 3 }]);
});

test('promptCache settings reach the anthropic runtime, and only it', async () => {
  const { validateConfigFile } = await import('../src/index.ts');

  const parsed = validateConfigFile(
    { provider: 'anthropic', model: 'claude-opus-5', promptCache: false, promptCacheTtl: '1h' },
    'test config',
  );
  // `false` is the whole point of the key, so it must survive a truthiness
  // check that would drop it.
  assert.equal(parsed.promptCache, false);
  assert.equal(parsed.promptCacheTtl, '1h');

  // A nonsense TTL is ignored rather than passed to the wire, like every
  // other wrong-shaped value this validator sees.
  assert.equal(
    validateConfigFile({ promptCacheTtl: '30m' }, 'test config').promptCacheTtl,
    undefined,
  );
  assert.equal(
    validateConfigFile({ promptCache: 'yes' }, 'test config').promptCache,
    undefined,
  );
});

test('an anthropic fallback inherits the primary\'s cache settings', async () => {
  const { resolveRuntimeConfig } = await import('../src/index.ts');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-cachefb-'));
  const configPath = path.join(home, 'stratus.config.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    model: 'claude-opus-5',
    fallbackModel: 'claude-sonnet-5',
    promptCache: false,
    promptCacheTtl: '1h',
  }));

  const config = await resolveRuntimeConfig({ configPath }, {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'test-key' },
  });

  assert.equal(config.provider, 'anthropic');
  assert.equal((config as { promptCache?: boolean }).promptCache, false);
  // Without this the operator who turned caching off still pays the write
  // surcharge on every rescued turn — the one thing the setting exists to
  // prevent.
  assert.equal(config.fallback?.promptCache, false);
  assert.equal(config.fallback?.promptCacheTtl, '1h');
});
