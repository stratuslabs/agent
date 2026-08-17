import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentsDirPath,
  createFileMemoryStore,
  loadRosterSouls,
  loadSoulFile,
  memoryFilePath,
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
