import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ContributionRegistry,
  EventBus,
  ToolRegistry,
  type AgentDefinition,
  type CredentialResolver,
  type JsonObject,
  type ProviderContribution,
  type Session,
} from '@stratusagent/core';
import { loadPlugins } from '@stratusagent/plugins';
import { createRuntimeProvider } from '@stratusagent/state';

import { createOpenAiProviderPlugin, OPENAI_COMPATIBLE_PROVIDER_NAME } from '../src/index.ts';

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A transport that records what it was sent and answers with the model's name. */
const fakeFetch = () => {
  const calls: Array<{ url: string; authorization: string | undefined; model: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get('authorization') ?? undefined, model: body.model });
    return openAiText(`answered by ${body.model}`);
  };
  return { calls, fetchImpl };
};

const agent = (id: string, credentials: string[] = ['openai.apiKey']): AgentDefinition => ({
  id,
  name: id,
  instructions: `You are ${id}.`,
  credentials,
});

const sessionFor = (definition: AgentDefinition): Session => ({
  id: `${definition.id}-1`,
  agent: definition,
  status: 'running',
  messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** A resolver with one key per agent, and the kernel's allowlist rule. */
const fakeCredentials = (keys: Record<string, string>): CredentialResolver => ({
  async resolve(definition, name) {
    if (!definition.credentials?.includes(name)) {
      throw new Error(`Agent ${definition.id} is not allowed to access credential: ${name}`);
    }
    return name === 'openai.apiKey' ? keys[definition.id] : undefined;
  },
});

/** Register through a hand-written handle, the way the loader's view would. */
const registered = async (
  config: JsonObject,
  fetchImpl: typeof fetch,
  credentials?: CredentialResolver,
): Promise<ProviderContribution> => {
  let contribution: ProviderContribution | undefined;
  await createOpenAiProviderPlugin(config, { fetch: fetchImpl }).setup({
    bus: new EventBus(),
    tools: new ToolRegistry(),
    providers: { register: (entry) => { contribution = entry; } },
    ...(credentials ? { credentials } : {}),
  });
  assert.ok(contribution);
  return contribution;
};

test('the provider registers under its name, takes the soul\'s model, and sends the calling agent\'s own key', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const contribution = await registered(
    { baseUrl: 'http://127.0.0.1:11434/v1/' },
    fetchImpl,
    fakeCredentials({ ava: 'sk-ava', juno: 'sk-juno' }),
  );
  assert.equal(contribution.name, OPENAI_COMPATIBLE_PROVIDER_NAME);
  assert.equal(contribution.streams, false);

  const provider = contribution.create({ model: 'llama3' });
  const ava = await provider.generate({ session: sessionFor(agent('ava')) });
  const juno = await provider.generate({ session: sessionFor(agent('juno')) });
  assert.deepEqual(ava.parts, [{ type: 'text', text: 'answered by llama3' }]);
  assert.deepEqual(juno.parts, [{ type: 'text', text: 'answered by llama3' }]);
  // Per calling agent, on the configured endpoint, with the trailing slash gone.
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer sk-ava', 'Bearer sk-juno']);
  assert.ok(calls.every((call) => call.url === 'http://127.0.0.1:11434/v1/chat/completions'));
});

test('an agent whose soul does not list the credential, or has none stored, is refused naming the remedy', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const contribution = await registered({ model: 'gpt-4.1-mini' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  const provider = contribution.create({});

  await assert.rejects(
    provider.generate({ session: sessionFor(agent('juno')) }),
    /No openai\.apiKey credential resolves for agent juno.*stratus credential set openai\.apiKey/,
  );
  await assert.rejects(
    provider.generate({ session: sessionFor(agent('bea', [])) }),
    /Agent bea is not allowed to access credential: openai\.apiKey/,
  );
  assert.equal(calls.length, 0);
});

test('with no model anywhere the selection is refused, and with none in the soul the config\'s serves', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const bare = await registered({}, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  assert.throws(() => bare.create({}), /No model for provider openai-compatible/);

  const configured = await registered({ model: 'from-config' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  await configured.create({}).generate({ session: sessionFor(agent('ava')) });
  await configured.create({ model: 'from-soul' }).generate({ session: sessionFor(agent('ava')) });
  assert.deepEqual(calls.map((call) => call.model), ['from-config', 'from-soul']);
});

test('a host with no credential resolver is told so, rather than the plugin reading the environment', async () => {
  const { fetchImpl } = fakeFetch();
  const contribution = await registered({ model: 'm' }, fetchImpl);
  await assert.rejects(
    contribution.create({}).generate({ session: sessionFor(agent('ava')) }),
    /hands plugins no credential resolver/,
  );
});

test('it serves as a fallback target behind a failing built-in primary', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const contribution = await registered({ baseUrl: 'http://127.0.0.1:11434/v1' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  const registry = new ContributionRegistry<ProviderContribution>();
  registry.register(contribution.name, contribution);

  const fellBack: unknown[] = [];
  const wrapped = createRuntimeProvider(
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-primary',
      fetch: async () => { throw new Error('primary down'); },
      fallback: { provider: 'plugin:openai-compatible', model: 'llama3' },
    },
    (error) => fellBack.push(error),
    undefined,
    undefined,
    undefined,
    registry,
  );
  const response = await wrapped.generate({ session: sessionFor(agent('ava')) });
  assert.equal(fellBack.length, 1);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'answered by llama3' }]);
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer sk-ava']);
});

test('the real manifest and the real module load through the loader, and setup registers only what the manifest declares', async () => {
  const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const providers = new ContributionRegistry<ProviderContribution>();
  const result = await loadPlugins({
    config: { '@stratusagent/provider-openai': { model: 'llama3' } },
    host: {
      resolve: () => pathToFileURL(path.join(packageDirectory, 'dist', 'index.js')).href,
      import: () => import('../src/index.ts'),
    },
    tools: new ToolRegistry(),
    bus: new EventBus(),
    providers,
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.loaded[0]?.contributions.providers, ['openai-compatible']);
  assert.deepEqual(result.loaded[0]?.manifest.credentials, ['openai.apiKey']);
  assert.ok(providers.get('openai-compatible'));
});
