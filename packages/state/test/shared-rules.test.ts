import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { formatSoul } from '@stratusagent/agents';
import {
  agentsDirPath,
  applySoulPins,
  claimSoulFile,
  collectAvailableModels,
  globalConfigPath,
  KNOWN_CLAUDE_MODELS,
  listAgentSummaries,
  memoryFilePath,
  saveConfigFile,
  servedRuntimes,
  verifyProviderKey,
  type StateEnvironment,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-shared-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = agentsDirPath({ homeDir: home });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('listAgentSummaries carries the structured avatar palette, not a rendered line', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: anthropic\nmodel: claude-opus-5\n---\n\nYou are Ava.\n');

  const summaries = await listAgentSummaries({ homeDir: home, cwd: home, processEnv: {} });
  const ava = summaries.find((entry) => entry.id === 'ava');

  assert.ok(ava, 'the roster soul should be listed');
  // The whole reason this moved out of the CLI: a web or macOS surface has to
  // draw the palette, and it cannot recover one from "stratus theme, hue 214".
  assert.equal(typeof ava.avatar?.hue, 'number');
  assert.ok(Array.isArray(ava.avatar?.palette) && ava.avatar.palette.length > 0);
  assert.deepEqual(ava.runsOn, { provider: 'anthropic', model: 'claude-opus-5' });
  assert.equal(ava.provider, 'anthropic');
  assert.equal(ava.builtIn, false);

  // The built-in is always present, and is the default while no soul is configured.
  const builtIn = summaries.find((entry) => entry.builtIn);
  assert.equal(builtIn?.default, true);
});

test('listAgentSummaries degrades on a soul it cannot parse instead of failing the listing', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  // A directory named like a soul file cannot be read as one.
  await mkdir(path.join(agentsDirPath({ homeDir: home }), 'broken.md'), { recursive: true });

  const warnings: string[] = [];
  const summaries = await listAgentSummaries(
    { homeDir: home, cwd: home, processEnv: {} },
    (message) => warnings.push(message),
  );

  assert.ok(summaries.some((entry) => entry.id === 'ava'), 'the readable soul still lists');
  assert.ok(warnings.some((line) => line.includes('broken.md')), 'the unreadable one is reported');
});

test('claimSoulFile creates the agents directory it writes into', async () => {
  const home = await newHome();
  // No setup has run here: ~/.stratus/agents does not exist. The control API
  // reaches this function without the CLI's mkdir in front of it, so the
  // function has to be sufficient on its own.
  const claimed = await claimSoulFile(
    { homeDir: home, cwd: home, processEnv: {} },
    { name: 'Ava', instructions: 'You are Ava.' },
    (agent) => formatSoul({ agent }),
    () => {},
  );

  assert.equal(path.dirname(claimed.soulPath), agentsDirPath({ homeDir: home }));
  assert.match(await readFile(claimed.soulPath, 'utf8'), /Ava/);
});

test('claimSoulFile refuses an id the roster already declares and takes a suffix', async () => {
  const home = await newHome();
  // The declared id, not the filename: a soul at renamed.md claiming `ava`
  // must still block a new agent that would resolve to `ava`.
  await writeSoul(home, 'renamed.md', '---\nname: Ava\nid: ava\n---\n\nThe first Ava.\n');

  const claimed = await claimSoulFile(
    { homeDir: home, cwd: home, processEnv: {} },
    { name: 'Ava', instructions: 'The second Ava.' },
    (agent) => formatSoul({ agent }),
    () => {},
  );

  assert.notEqual(claimed.agent.id, 'ava');
  assert.match(claimed.agent.id, /^ava-/);
});

test('verifyProviderKey condemns a key only on an explicit auth failure', async () => {
  const rejected = await verifyProviderKey('openai', 'sk-bad', undefined, async () =>
    new Response('nope', { status: 401 }));
  assert.equal(rejected.status, 'rejected');

  // A compatible endpoint without GET /models says nothing about the key.
  const unsupported = await verifyProviderKey('openai', 'sk-good', 'http://localhost:1234/v1', async () =>
    new Response('no such route', { status: 404 }));
  assert.equal(unsupported.status, 'unreachable');

  const ok = await verifyProviderKey('anthropic', 'sk-ant', undefined, async () => jsonResponse({ data: [] }));
  assert.equal(ok.status, 'ok');
});

test('collectAvailableModels never sends the default provider secret to a second provider', async () => {
  const asked: Array<{ url: string; auth: string }> = [];
  const env: StateEnvironment = {
    homeDir: await newHome(),
    // STRATUS_API_KEY authenticates the DEFAULT provider only. OpenAI here is
    // the default; anthropic has its own stored sign-in and must be listed
    // from that, never from the generic variable.
    processEnv: { STRATUS_API_KEY: 'default-provider-secret' },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      asked.push({
        url: String(input),
        auth: headers.get('authorization') ?? headers.get('x-api-key') ?? '',
      });
      // Provider-appropriate bodies: the chat-model filter is an OpenAI rule
      // (Anthropic's listing has no non-chat models to strip), so a shared
      // body would prove nothing about it. Keyed off the version header
      // rather than the path — the OpenAI default endpoint is also /v1/models.
      return headers.get('anthropic-version')
        ? jsonResponse({ data: [{ id: 'claude-opus-5' }] })
        : jsonResponse({ data: [{ id: 'gpt-4.1-mini' }, { id: 'text-embedding-3-small' }] });
    }) as typeof fetch,
  };

  const models = await collectAvailableModels(
    {
      provider: 'openai',
      credentials: { anthropic: { type: 'api_key', value: 'anthropic-own-key' } },
    },
    env,
  );

  const anthropicCall = asked.find((call) => call.url.startsWith('https://api.anthropic.com'));
  assert.ok(anthropicCall, 'anthropic was listed');
  assert.equal(anthropicCall.auth, 'anthropic-own-key');
  assert.ok(
    !asked.some((call) => call.auth.includes('default-provider-secret') && call.url.includes('api.anthropic.com')),
    'the default provider secret never reaches the other provider',
  );

  // Embeddings cannot serve /chat/completions and must not be offered.
  assert.ok(models.some((model) => model.id === 'gpt-4.1-mini'));
  assert.ok(!models.some((model) => model.id === 'text-embedding-3-small'));
});

test('collectAvailableModels falls back to the known lineup for a subscription token', async () => {
  const models = await collectAvailableModels(
    {
      provider: 'anthropic',
      credentials: { anthropic: { type: 'oauth_token', value: 'sub-token' } },
    },
    {
      homeDir: await newHome(),
      processEnv: {},
      // A subscription token cannot call the models endpoint at all.
      fetch: (async () => { throw new Error('should not be called'); }) as typeof fetch,
    },
  );

  assert.deepEqual(models.map((model) => model.id), KNOWN_CLAUDE_MODELS);
});

test('servedRuntimes resolves one runtime per pinned soul, not just the daemon default', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: anthropic\nmodel: claude-opus-5\n---\n\nYou are Ava.\n');
  await saveConfigFile(globalConfigPath({ homeDir: home }), { provider: 'demo' });

  const runtimes = await servedRuntimes({
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });

  // The daemon default (demo) plus Ava's own pinned anthropic runtime — the
  // agent a default-only check would miss entirely.
  assert.ok(runtimes.some((served) => served.runtime.provider === 'demo'));
  const pinned = runtimes.find((served) => served.runtime.provider === 'anthropic');
  assert.ok(pinned, 'the pinned soul resolves its own runtime');
  assert.equal(pinned.runtime.provider === 'anthropic' ? pinned.runtime.model : undefined, 'claude-opus-5');
});

test('applySoulPins drops a default model chosen for a different provider', async () => {
  const soul = {
    agent: { id: 'ava', name: 'Ava', instructions: 'You are Ava.' },
    provider: 'anthropic',
  };

  const { selection, env } = applySoulPins(
    soul,
    { provider: 'openai', model: 'gpt-4.1-mini', baseUrl: 'http://proxy.local/v1' },
    { processEnv: { STRATUS_API_KEY: 'openai-secret' } },
    { selectionProvider: 'openai', configPresent: true },
  );

  assert.equal(selection.provider, undefined, 'the demoted default provider is gone');
  assert.equal(selection.model, undefined, "openai's model must not ride along to anthropic");
  assert.equal(selection.baseUrl, undefined, "openai's endpoint must not ride along either");
  assert.equal(env.processEnv?.STRATUS_API_KEY, undefined, 'nor the generic key chosen for it');
  assert.equal(selection.presetSoul, soul);
});

test('saveConfigFile creates the directory and round-trips through loadAgentSummaries', async () => {
  const home = await newHome();
  const configPath = globalConfigPath({ homeDir: home });
  await saveConfigFile(configPath, { provider: 'anthropic', model: 'claude-opus-5' });

  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).model, 'claude-opus-5');
  // Trailing newline, as every config this repo writes has.
  assert.ok((await readFile(configPath, 'utf8')).endsWith('\n'));

  const summaries = await listAgentSummaries({ homeDir: home, cwd: home, processEnv: {} });
  assert.deepEqual(summaries[0]?.runsOn, { provider: 'anthropic', model: 'claude-opus-5' });
  // Nothing has remembered anything yet.
  assert.equal(summaries[0]?.memories, 0);
  assert.equal(memoryFilePath({ homeDir: home }).endsWith('memory.jsonl'), true);
});
