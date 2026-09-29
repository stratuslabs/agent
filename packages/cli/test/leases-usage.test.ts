import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteUsageLedger } from '@stratusagent/gateway';
import { fleetDbPath } from '@stratusagent/state';
import { parseCommand, runCli } from '../src/index.ts';

const createStreams = () => {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    output: {
      get stdout() { return stdout; },
      get stderr() { return stderr; },
    },
  };
};

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-lease-cli-'));

const run = async (home: string, argv: string[]) => {
  const { streams, output } = createStreams();
  const code = await runCli({ argv, streams, env: { homeDir: home, cwd: home, processEnv: {} } });
  return { code, stdout: output.stdout, stderr: output.stderr };
};

test('parseCommand reads lease and usage commands, and refuses a lease with no end or no reason', () => {
  assert.deepEqual(parseCommand(['lease', 'grant', 'ava', 'github.token', '--for', '2h', '--uses', '5', '--reason', 'incident 3']), {
    command: 'lease',
    action: 'grant',
    agentId: 'ava',
    credential: 'github.token',
    duration: '2h',
    reason: 'incident 3',
    maxUses: 5,
    format: 'text',
  });
  assert.deepEqual(parseCommand(['leases', '--all']), { command: 'lease', action: 'list', all: true, format: 'text' });
  assert.deepEqual(parseCommand(['lease', 'revoke', 'lease_1']), { command: 'lease', action: 'revoke', leaseId: 'lease_1', format: 'text' });
  assert.throws(() => parseCommand(['lease', 'grant', 'ava', 'github.token', '--reason', 'r']), /A lease has to end/);
  assert.throws(() => parseCommand(['lease', 'grant', 'ava', 'github.token', '--for', '1h']), /needs --reason/);
  assert.throws(() => parseCommand(['lease', 'extend', 'x']), /Unknown lease action: extend/);
  assert.deepEqual(parseCommand(['usage', '--since', '2026-09-01', '--agent', 'ava', '--format', 'json']), {
    command: 'usage',
    format: 'json',
    since: '2026-09-01',
    agentId: 'ava',
  });
  assert.throws(() => parseCommand(['usage', '--since', 'last week']), /Invalid --since/);
});

test('stratus lease grants, lists, and revokes on fleet.db with no daemon running', async () => {
  const home = await newHome();
  const granted = await run(home, ['lease', 'grant', 'ava', 'github.token', '--for', '30m', '--uses', '2', '--reason', 'deploy fix']);
  assert.equal(granted.code, 0, granted.stderr);
  const id = /Granted (lease_[0-9a-f]+)/.exec(granted.stdout)?.[1];
  assert.ok(id, granted.stdout);

  const listed = await run(home, ['lease', 'list', '--format', 'json']);
  const leases = (JSON.parse(listed.stdout) as { leases: Array<{ id: string; state: string; maxUses: number; grantedBy: string }> }).leases;
  assert.deepEqual(leases.map(({ id: leaseId, state, maxUses, grantedBy }) => ({ leaseId, state, maxUses, grantedBy })), [
    { leaseId: id, state: 'active', maxUses: 2, grantedBy: 'cli' },
  ]);

  assert.equal((await run(home, ['lease', 'revoke', id])).code, 0);
  assert.match((await run(home, ['lease', 'list'])).stdout, /No active leases/);
  assert.match((await run(home, ['lease', 'list', '--all'])).stdout, new RegExp(`${id}  ava  github\\.token  revoked .* by cli`));
  const twice = await run(home, ['lease', 'revoke', id]);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /No active lease has id/);

  const tooLong = await run(home, ['lease', 'grant', 'ava', 'github.token', '--for', '120d', '--reason', 'r']);
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /at most 90 days/);
});

test('stratus usage sums the ledger and says where the budget stands', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ budget: { daily: 100 } }));
  const ledger = new SqliteUsageLedger(fleetDbPath({ homeDir: home }));
  ledger.record({
    id: 'e-1',
    at: new Date().toISOString(),
    agentId: 'ava',
    sessionId: 's-1',
    record: { turnId: 's-1:turn:1', provider: 'anthropic', model: 'claude-x', inputTokens: 90, outputTokens: 15 },
  });
  ledger.close();

  const text = await run(home, ['usage']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /ava {2}anthropic\/claude-x {2}1 call\(s\) {2}in 90 {2}out 15/);
  assert.match(text.stdout, /this install {2}daily {2}105 of 100 .* — reached/);

  const json = JSON.parse((await run(home, ['usage', '--format', 'json'])).stdout) as { usage: Array<{ inputTokens: number }> };
  assert.equal(json.usage[0]?.inputTokens, 90);
});

test('stratus run spends a lease on a fenced sign-in, and is refused without one', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ leases: { credentials: ['provider:openai'] } }));
  const oneShot = async (events = false) => {
    const { streams, output } = createStreams();
    const code = await runCli({
      argv: ['run', '--prompt', 'hello', '--provider', 'openai', ...(events ? [] : ['--no-events'])],
      streams,
      env: {
        homeDir: home,
        cwd: home,
        processEnv: { OPENAI_API_KEY: 'test-key' },
        fetch: (async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi there' } }] }),
        })) as unknown as typeof fetch,
      },
    });
    return { code, stdout: output.stdout, stderr: output.stderr };
  };

  const refused = await oneShot();
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /provider:openai may only be used under a lease, and agent \S+ holds none/);

  const granted = await run(home, ['lease', 'grant', 'stratus', 'provider:openai', '--for', '1h', '--uses', '2', '--reason', 'try it']);
  assert.equal(granted.code, 0, granted.stderr);
  const answered = await oneShot();
  assert.equal(answered.code, 0, answered.stderr);
  assert.match(answered.stdout, /hi there/);
  // The use is on the run's own event stream, as the daemon's are on its.
  const audited = await oneShot(true);
  assert.equal(audited.code, 0, audited.stderr);
  assert.match(audited.stdout, /credential\.leased provider:openai for stratus allowed \(lease_[0-9a-f]+\)/);
  const listed = JSON.parse((await run(home, ['lease', 'list', '--all', '--format', 'json'])).stdout) as { leases: Array<{ uses: number }> };
  assert.equal(listed.leases[0]?.uses, 2);
});

test('stratus usage reads the budget from the config the daemon was given, not the one discovery finds', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ budget: { daily: 100 } }));
  const selected = path.join(home, 'daemon.json');
  await writeFile(selected, JSON.stringify({ budget: { monthly: 7_000 } }));
  assert.deepEqual(parseCommand(['usage', '--config', selected]), { command: 'usage', format: 'text', configPath: selected });
  const text = await run(home, ['usage', '--config', selected]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /this install {2}monthly {2}0 of 7,000/);
  assert.doesNotMatch(text.stdout, /daily/);
});

test('stratus usage says a budget with no limit in it caps nothing', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ budget: { weights: { outputTokens: 5 } } }));
  const text = await run(home, ['usage']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /sets no daily or monthly limit, so nothing is capped/);
});

test('stratus usage reports an unreadable budget as unknown, never as no budget', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), '{ "budget": ');
  const text = await run(home, ['usage']);
  assert.equal(text.code, 1);
  assert.match(text.stderr, /The budget could not be read .*whether spend is capped is unknown/);
  assert.doesNotMatch(text.stdout, /No budget is set/);
  const json = await run(home, ['usage', '--format', 'json']);
  assert.equal(json.code, 1);
  assert.equal(typeof (JSON.parse(json.stdout) as { budgetUnreadable?: string }).budgetUnreadable, 'string');
});

test('stratus usage says when spend is held outside the ledger, and exits non-zero', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'usage-held.jsonl'),
    `${JSON.stringify({ id: 'e-1', at: new Date().toISOString(), agentId: 'ava', sessionId: 's', record: { turnId: 's:turn:1', provider: 'openai', inputTokens: 9 } })}\n`,
  );
  const text = await run(home, ['usage']);
  assert.equal(text.code, 1);
  assert.match(text.stderr, /1 call\(s\) of spend are held in usage-held\.jsonl, not yet in the ledger/);
  const json = await run(home, ['usage', '--format', 'json']);
  assert.equal(json.code, 1);
  assert.deepEqual((JSON.parse(json.stdout) as { unrecorded?: unknown }).unrecorded, { calls: 1 });
});

test('stratus usage fails, rather than reporting nothing spent, when the ledger cannot be read', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A link to itself: stat fails with ELOOP, not "no such file".
  await symlink('fleet.db', path.join(home, '.stratus', 'fleet.db'));
  const result = await run(home, ['usage']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the usage ledger at .* could not be read/);
  assert.doesNotMatch(result.stdout, /nothing recorded/);
});
