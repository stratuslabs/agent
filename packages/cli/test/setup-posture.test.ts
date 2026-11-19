import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalSetup } from '../src/commands/setup/approvals.ts';
import type { SetupBase, SetupState } from '../src/commands/setup/context.ts';
import type { SharedSetup } from '../src/commands/setup/shared.ts';

// The posture question only runs at a real terminal, and `runCli` can only
// drive setup through piped input (`setupInput`), which is the
// non-interactive path. So the question is tested here, through the menu
// factory, with a prompter that says it is interactive; the piped run that
// must not ask is tested in cli.test.ts.

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
  const [question] = asked;
  assert.equal(question.defaultIndex ?? 0, 0);
  assert.equal(question.options.length, 3);
  assert.match(question.options[0]!, /^Open \(default\) +run them without asking$/);
  assert.match(question.options[1]!, /^Guarded +ask you first, or refuse when nobody can answer$/);
  assert.match(question.options[2]!, /^Review +a model checks them after an agent reads outside content$/);
  assert.match(question.footnote ?? '', /dangerous tool asks under every posture/);
  // Written, not left implicit: an answered question is a choice, and it
  // must not change under the operator if a later release moves the default.
  assert.deepEqual(state.approvals, { posture: 'open' });
  assert.match(stdout(), /Posture open: tools run without asking\. Change it later with approvals\.posture in the config file\./);
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
    assert.match(
      stdout(),
      new RegExp(`Posture ${posture}\\. Until Approvals below asks in Slack, the daemon refuses what it would ask about; stratus chat and run ask you at the terminal\\.`),
    );
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
