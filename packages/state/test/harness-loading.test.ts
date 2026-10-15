import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const stateEntry = pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href;

// The harness packages are installed in this workspace, so "not installed"
// is staged in a child process with a resolve hook that refuses them while
// a marker file exists, the way Node refuses a package that is absent.
// Removing the marker is the operator installing it.
const HOOKS = `
import { existsSync } from 'node:fs';
const marker = process.env.STRATUS_TEST_BLOCK_MARKER;
export async function resolve(specifier, context, next) {
  if (marker && existsSync(marker) && /^@stratusagent\\/provider-(claude-code|codex)(\\/|$)/.test(specifier)) {
    const error = new Error(\`Cannot find package '\${specifier}' imported from \${context.parentURL}\`);
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return next(specifier, context);
}
`;

const CHILD = `
import { register } from 'node:module';
import { rm } from 'node:fs/promises';
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(HOOKS)}`)});

const state = await import(${JSON.stringify(stateEntry)});
const out = { imported: true };

const query = () => (async function* () {
  yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
  yield { type: 'result', subtype: 'success', is_error: false, result: 'hello from claude-code', session_id: 'sdk-1' };
})();
const now = new Date().toISOString();
const request = () => ({
  session: {
    id: 's1',
    agent: { id: 'a1', name: 'A1', instructions: 'Be brief.' },
    status: 'running',
    messages: [{ role: 'user', content: 'hi' }],
    createdAt: now,
    updatedAt: now,
  },
});

const subscription = state.createRuntimeProvider({
  provider: 'anthropic', model: 'claude-opus-5', authToken: 'sk-ant-oat-test', queryFn: query,
});
const codex = state.createRuntimeProvider({ provider: 'codex', model: 'gpt-5.5' });
out.names = [subscription.name, codex.name];

const attempt = async (provider) => {
  try {
    const response = await provider.generate(request());
    return { ok: true, text: response.parts.map((part) => part.text ?? '').join('') };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};
out.subscriptionMissing = await attempt(subscription);
out.codexMissing = await attempt(codex);
await rm(process.env.STRATUS_TEST_BLOCK_MARKER);
out.subscriptionInstalled = await attempt(subscription);
process.stdout.write(JSON.stringify(out));
`;

test('a host loads the harness providers only when a turn runs on one, and says how to install a missing one', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stratus-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'child.mjs');
  const marker = path.join(dir, 'blocked');
  await writeFile(script, CHILD);
  await writeFile(marker, '');

  const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
    env: { ...process.env, STRATUS_TEST_BLOCK_MARKER: marker },
  });
  const out = JSON.parse(stdout) as {
    imported: boolean;
    names: string[];
    subscriptionMissing: { ok: boolean; error?: string };
    codexMissing: { ok: boolean; error?: string };
    subscriptionInstalled: { ok: boolean; text?: string; error?: string };
  };

  // `state` imports, and both providers build, with neither package resolvable.
  assert.equal(out.imported, true);
  assert.deepEqual(out.names, ['claude-code', 'codex']);

  // The turn that needs one fails with the package and the fix, not a stack.
  assert.equal(out.subscriptionMissing.ok, false);
  assert.match(out.subscriptionMissing.error ?? '', /the Claude subscription runtime, and @stratusagent\/provider-claude-code is not installed/);
  assert.match(out.subscriptionMissing.error ?? '', /npm install -g @stratusagent\/provider-claude-code/);
  assert.equal(out.codexMissing.ok, false);
  assert.match(out.codexMissing.error ?? '', /the Codex runtime, and @stratusagent\/provider-codex is not installed/);

  // A failed load is not remembered: once installed, the same provider
  // object serves the next turn with no restart.
  assert.deepEqual(out.subscriptionInstalled, { ok: true, text: 'hello from claude-code' });
});

test('a harness that is installed but missing one of its own dependencies keeps its real error', async () => {
  const { harnessNotInstalledError } = await import('../src/provider-runtime.ts');
  const missing = (message: string) => Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });

  const absent = harnessNotInstalledError('codex', missing("Cannot find package '@stratusagent/provider-codex' imported from /usr/lib/node_modules/@stratusagent/state/dist/provider-runtime.js"));
  assert.match(absent?.message ?? '', /@stratusagent\/provider-codex is not installed/);

  // The importer's path names the harness, but the package missing is its dependency.
  const broken = missing("Cannot find package 'missing-child' imported from /usr/lib/node_modules/@stratusagent/provider-codex/dist/index.js");
  assert.equal(harnessNotInstalledError('codex', broken), undefined);
  // Same for a file missing inside an installed harness.
  const truncated = missing("Cannot find module '/usr/lib/node_modules/@stratusagent/provider-claude-code/dist/index.js' imported from /usr/lib/node_modules/@stratusagent/state/dist/provider-runtime.js");
  assert.equal(harnessNotInstalledError('claude-code', truncated), undefined);
});

test('harnessesUsedBy names the harness a runtime and its fallback load, and nothing for API runtimes', async () => {
  const { harnessesUsedBy, HARNESS_PACKAGE_NAMES } = await import('../src/index.ts');
  assert.deepEqual(harnessesUsedBy({ provider: 'anthropic', model: 'm', authToken: 'sk-ant-oat' }), ['claude-code']);
  // An API key wins over a token, as createRuntimeProvider decides.
  assert.deepEqual(harnessesUsedBy({ provider: 'anthropic', model: 'm', apiKey: 'k', authToken: 't' }), []);
  assert.deepEqual(harnessesUsedBy({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://x' }), []);
  assert.deepEqual(harnessesUsedBy({ provider: 'demo' }), []);
  assert.deepEqual(
    harnessesUsedBy({ provider: 'anthropic', model: 'm', apiKey: 'k', fallback: { provider: 'codex', model: 'gpt' } }),
    ['codex'],
  );
  assert.deepEqual(
    harnessesUsedBy({ provider: 'codex', model: 'gpt', fallback: { provider: 'anthropic', model: 'm', authToken: 't' } }),
    ['codex', 'claude-code'],
  );
  assert.deepEqual(HARNESS_PACKAGE_NAMES, {
    'claude-code': '@stratusagent/provider-claude-code',
    codex: '@stratusagent/provider-codex',
  });
});
