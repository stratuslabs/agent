import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HELP_TEXT, runCli } from '../src/index.ts';

// A usage error prints the error and one line pointing at the help for the
// command that was typed, and `stratus <command> --help` prints only that
// command's part of the help. The whole help, four hundred lines, is what
// `stratus --help` is for.

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

const run = async (argv: string[]) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-help-'));
  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv, streams, env: { homeDir: home, cwd: home, processEnv: {} } });
  return { exitCode, stdout: output.stdout, stderr: output.stderr };
};

/**
 * The left-column names of one section of a help: a name starts at column
 * 2, and its description at column 19, or on the next line when the name
 * is too long for the column.
 */
const sectionNames = (help: string, title: string): string[] => {
  const section = help.split(`\n${title}\n`)[1]?.split(/\n\n[A-Z]/)[0] ?? '';
  return section.split('\n')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => (line.length > 19 && line[18] === ' ' ? line.slice(2, 18) : line).trim());
};

test('stratus --help, -h, help and no command still print the whole help', async () => {
  for (const argv of [['--help'], ['-h'], ['help'], []]) {
    const result = await run(argv);
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.equal(result.stdout, `${HELP_TEXT}\n`, argv.join(' '));
    assert.equal(result.stderr, '');
  }
});

test('stratus doctor --help, -h and stratus help doctor print only the doctor part', async () => {
  const outputs = [];
  for (const argv of [['doctor', '--help'], ['doctor', '-h'], ['help', 'doctor']]) {
    const result = await run(argv);
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.equal(result.stderr, '', argv.join(' '));
    outputs.push(result.stdout);
  }
  assert.equal(new Set(outputs).size, 1, 'all three spellings print the same help');
  const [help = ''] = outputs;
  assert.match(help, /^Usage:\n {2}stratus doctor\n/);
  assert.match(help, /^ {2}doctor {11}Show what a run would use right now/m);
  assert.match(help, /^ {2}--format {9}Output format/m, 'the options doctor takes');
  assert.doesNotMatch(help, /^ {2}setup /m, 'no other command');
  assert.doesNotMatch(help, /^ {2}--api-port/m, "no option doctor doesn't take");
  assert.doesNotMatch(help, /Config file:/);
  assert.ok(help.split('\n').length < 30, `${help.split('\n').length} lines`);
});

test('a family name or an also-form finds the help it means', async () => {
  const memory = (await run(['memory', '--help'])).stdout;
  assert.match(memory, /^ {2}memory list /m);
  assert.match(memory, /^ {2}memory undo-pass /m);
  assert.match(memory, /^ {2}--preserve-trust memory import/m);
  assert.doesNotMatch(memory, /^ {2}sessions /m);

  // `schedule list` is what the schedules entry calls itself "also".
  assert.equal((await run(['schedule', 'list', '--help'])).stdout, (await run(['schedules', '--help'])).stdout);
  // `skill list` is `skills`, not the three `skill …` commands.
  const skillList = (await run(['skill', 'list', '--help'])).stdout;
  assert.match(skillList, /^ {2}skills /m);
  assert.doesNotMatch(skillList, /^ {2}skill add /m);
  // A second word that is an action, not a command, falls back to the command.
  assert.equal((await run(['tasks', 'cancel', '--help'])).stdout, (await run(['tasks', '--help'])).stdout);
  // A prompt is not a command.
  assert.equal((await run(['run', 'Say hello', '--help'])).stdout, (await run(['run', '--help'])).stdout);
});

test('every command in the help has a help of its own, and every option is in one', async () => {
  const commands = sectionNames(HELP_TEXT, 'Commands:');
  assert.ok(commands.length > 40, `read the Commands section (${commands.length})`);
  const listed = new Set<string>();
  for (const name of commands) {
    if (name === 'help' || name === 'version') {
      continue;
    }
    const argv = [...name.split(' '), '--help'];
    const result = await run(argv);
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.equal(result.stderr, '', argv.join(' '));
    assert.ok(result.stdout.includes(`\n  ${name}`), `${argv.join(' ')} shows the ${name} entry`);
    assert.ok(result.stdout.length < HELP_TEXT.length / 4, `${argv.join(' ')} is that command's part, not the whole help`);
    for (const option of [...sectionNames(result.stdout, 'Options:'), ...sectionNames(result.stdout, 'Agent options:')]) {
      listed.add(option);
    }
  }
  const options = [...sectionNames(HELP_TEXT, 'Options:'), ...sectionNames(HELP_TEXT, 'Agent options:')];
  assert.ok(options.length > 30, `read the Options sections (${options.length})`);
  assert.deepEqual(
    options.filter((option) => !listed.has(option) && option !== '--help, -h' && option !== '--version, -v'),
    [],
    'an option no command help lists is one nobody reading `stratus <command> --help` learns about',
  );
});

test('a usage error prints the error and one line pointing at that command\'s help', async () => {
  for (const [argv, error, pointer] of [
    [['doctor', '--bogus'], 'Unknown option: --bogus', 'stratus doctor --help'],
    [['run', '--bogus'], 'Unknown option: --bogus', 'stratus run --help'],
    [['run'], 'A prompt is required. Pass it with --prompt, --stdin, or as a positional argument.', 'stratus run --help'],
    [['agents', '--gateway'], 'Missing value for --gateway', 'stratus agents --help'],
    [['memory', 'list', '--trust', 'nope'], 'Unsupported trust level: nope. Use one of user, agent, unknown, external.', 'stratus memory list --help'],
    [['agent', 'delete'], 'Unknown agent subcommand: delete. Try: stratus agent new, stratus agent list', 'stratus agent --help'],
    [['schedule', 'list', '--bogus'], 'Unknown option: --bogus', 'stratus schedule list --help'],
  ] as const) {
    const result = await run([...argv]);
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.equal(result.stdout, '', argv.join(' '));
    assert.equal(result.stderr, `Error: ${error}\nRun \`${pointer}\` for its usage.\n`, argv.join(' '));
    const followed = await run(pointer.split(' ').slice(1));
    assert.equal(followed.exitCode, 0, `${pointer} works`);
    assert.ok(followed.stdout.length < HELP_TEXT.length / 4, `${pointer} is that command's part`);
  }
});

test('an unknown command, or help for one, points at the whole list', async () => {
  for (const [argv, error] of [
    [['frob'], 'Unknown command: frob'],
    [['help', 'frob'], 'Unknown command: frob'],
    // Only `schedule list` and `schedule cancel` exist; `schedule --help`
    // would be the same error, so the pointer must not name it.
    [['schedule', 'bogus'], 'Unknown command: schedule'],
    [['plugin', 'bogus'], 'Unknown command: plugin'],
  ] as const) {
    const result = await run([...argv]);
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Error: ${error}\nRun \`stratus --help\` for the list of commands.\n`, argv.join(' '));
  }
});
