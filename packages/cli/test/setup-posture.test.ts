import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { runCli } from '../src/index.ts';
import { createApprovalSetup } from '../src/commands/setup/approvals.ts';
import type { SetupBase, SetupState } from '../src/commands/setup/context.ts';
import type { SharedSetup } from '../src/commands/setup/shared.ts';

// The posture question only runs at a terminal. `setupInput` drives setup
// down the piped, non-interactive path, so the question is tested two ways
// here: through the menu factory with a prompter that says it is
// interactive, and through `runCli` with process.stdin standing in for a
// terminal (the tests at the bottom). The piped run that must not ask is in
// cli.test.ts.

type Answer = { kind: 'index'; index: number } | { kind: 'back' };

interface Asked {
  heading: string;
  options: string[];
  defaultIndex: number | undefined;
  footnote: string | undefined;
}

const harness = (options: {
  interactive?: boolean;
  closed?: boolean;
  answer?: (asked: Asked) => Answer;
  approvals?: SetupState['approvals'];
} = {}) => {
  const asked: Asked[] = [];
  let stdout = '';
  const state = {
    provider: 'anthropic',
    ...(options.approvals !== undefined ? { approvals: options.approvals } : {}),
  } as SetupState;
  const prompter = {
    isInteractive: () => options.interactive ?? true,
    isClosed: () => options.closed ?? false,
    async select(heading: string, rows: string[], opts: { defaultIndex?: number; footnote?: string } = {}) {
      const entry = { heading, options: rows, defaultIndex: opts.defaultIndex, footnote: opts.footnote };
      asked.push(entry);
      // Enter on a real terminal picks the preselected row.
      return options.answer ? options.answer(entry) : { kind: 'index' as const, index: opts.defaultIndex ?? 0 };
    },
    async ask() {
      throw new Error('the posture question asks nothing else');
    },
    async askSecret() {
      throw new Error('the posture question asks nothing else');
    },
    close() {},
  } as unknown as SetupBase['prompter'];
  const setup = createApprovalSetup({
    state,
    env: {},
    serveCommand: () => 'stratus serve',
    prompter,
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write() { return true; } },
    },
    channelRoster: (async () => ({ entries: [], loaded: true })) as SharedSetup['channelRoster'],
    fitMenuRow: (text: string) => text,
  });
  return { setup, state, asked, stdout: () => stdout };
};

test('a new install at a terminal is asked for a posture, with open preselected, and Enter keeps open', async () => {
  const { setup, state, asked, stdout } = harness();

  await setup.offerPosture(true);

  assert.equal(asked.length, 1);
  const question = asked[0]!;
  assert.equal(question.defaultIndex ?? 0, 0);
  assert.equal(question.options.length, 3);
  assert.match(question.options[0]!, /^Open \(default\) +run them without asking$/);
  assert.match(question.options[1]!, /^Guarded +ask you first, or refuse when nobody can answer$/);
  assert.match(question.options[2]!, /^Review +a model checks them after an agent reads outside content$/);
  assert.equal(question.footnote, 'Dangerous tools always ask. Change it later with approvals.posture.');
  // Written, not left implicit: an answered question is a choice, and it
  // must not change under the operator if a later release moves the default.
  assert.deepEqual(state.approvals, { posture: 'open' });
  // Open needs no warning about headless: nothing it runs would ask.
  assert.equal(stdout(), 'Posture open. Change it later with approvals.posture in the config file.\n');
});

for (const [index, posture] of [[1, 'guarded'], [2, 'review']] as const) {
  test(`a new install that picks ${posture} gets it in the approvals block, next to what is already there`, async () => {
    const { setup, state, stdout } = harness({
      answer: () => ({ kind: 'index', index }),
      approvals: { mode: 'headless' },
    });

    await setup.offerPosture(true);

    assert.deepEqual(state.approvals, { mode: 'headless', posture });
    // Asked before the main menu, where Approvals is still headless: say
    // what that does to the calls this posture holds back.
    assert.equal(stdout(), [
      `Posture ${posture}. Change it later with approvals.posture in the config file.`,
      'Approvals is headless, so the daemon refuses what it would ask about.',
      'Choose Ask in Slack under Approvals to be asked there instead.',
      '',
    ].join('\n'));
  });
}

test('backing out of the posture question writes nothing, so the built-in default stays in force', async () => {
  const { setup, state, asked, stdout } = harness({ answer: () => ({ kind: 'back' }) });

  await setup.offerPosture(true);

  assert.equal(asked.length, 1);
  assert.equal(state.approvals, undefined);
  assert.equal(stdout(), '');
});

test('the posture question is not asked of an existing config', async () => {
  const { setup, state, asked } = harness({ approvals: { mode: 'remote' } });

  await setup.offerPosture(false);

  assert.equal(asked.length, 0);
  assert.deepEqual(state.approvals, { mode: 'remote' });
});

test('the posture question is not asked without a terminal', async () => {
  const { setup, state, asked } = harness({ interactive: false });

  await setup.offerPosture(true);

  assert.equal(asked.length, 0);
  assert.equal(state.approvals, undefined);
});

test('the posture question is not asked once input has ended', async () => {
  const { setup, asked } = harness({ closed: true });

  await setup.offerPosture(true);

  assert.equal(asked.length, 0);
});

test('the posture question does not override a posture already chosen', async () => {
  const { setup, state, asked } = harness({ approvals: { posture: 'guarded' } });

  await setup.offerPosture(true);

  assert.equal(asked.length, 0);
  assert.deepEqual(state.approvals, { posture: 'guarded' });
});

/**
 * Runs `stratus setup` through `runCli` down its interactive path: setup
 * sees a TTY on process.stdin (raw mode included) and reads the keys this
 * test sends. No pty is needed, so it runs the same on CI as anywhere. The
 * service step and npm installs are stubbed out, as in cli.test.ts.
 */
const setupAtTerminal = async (
  home: string,
  drive: (screen: { waitFor: (text: string) => Promise<void>; key: (bytes: string) => void }) => Promise<void>,
): Promise<{ exitCode: number; output: string }> => {
  const terminal = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(on: boolean) { terminal.isRaw = on; return terminal; },
  });
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: terminal, configurable: true });
  let output = '';
  const waiting: { text: string; from: number; done: () => void }[] = [];
  const stream = {
    write(chunk: string) {
      output += chunk;
      for (const entry of [...waiting]) {
        if (output.includes(entry.text, entry.from)) {
          waiting.splice(waiting.indexOf(entry), 1);
          entry.done();
        }
      }
      return true;
    },
  };
  try {
    const run = runCli({
      argv: ['setup'],
      streams: { stdout: stream, stderr: stream },
      env: {
        homeDir: home,
        cwd: home,
        processEnv: {},
        servicePlatform: 'aix',
        serviceRunner: async () => ({ code: 1, stdout: '', stderr: 'no service manager in this test' }),
        serviceSleep: async () => {},
        packageResolver: () => true,
      },
    });
    let mark = 0;
    await drive({
      waitFor: (text) => new Promise<void>((resolve) => {
        const from = mark;
        const done = () => { mark = output.length; resolve(); };
        if (output.includes(text, from)) {
          done();
        } else {
          waiting.push({ text, from, done });
        }
      }),
      key: (bytes) => { terminal.write(bytes); },
    });
    return { exitCode: await run, output };
  } finally {
    Object.defineProperty(process, 'stdin', realStdin);
  }
};

const readConfig = async (home: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8')) as Record<string, unknown>;

test('stratus setup at a terminal asks a new install first, and a pick lands in config', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-posture-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });

  const { exitCode, output } = await setupAtTerminal(home, async ({ waitFor, key }) => {
    await waitFor('should your agents ask');
    key('\u001b[B'); // down to Guarded
    key('\r');
    await waitFor('Save & finish');
    key('9');
  });

  assert.equal(exitCode, 0, output);
  // Asked before the menu was ever drawn.
  assert.ok(output.indexOf('should your agents ask') < output.indexOf('Save & finish'));
  assert.deepEqual((await readConfig(home)).approvals, { posture: 'guarded' });
});

test('stratus setup at a terminal goes straight to the menu for an existing config, and leaves its approvals alone', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-posture-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const { exitCode, output } = await setupAtTerminal(home, async ({ waitFor, key }) => {
    await waitFor('Save & finish');
    key('9');
  });

  assert.equal(exitCode, 0, output);
  assert.doesNotMatch(output, /should your agents ask/);
  assert.equal((await readConfig(home)).approvals, undefined);
});
