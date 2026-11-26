import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP_TEXT, parseCommand, runCli } from '../src/index.ts';

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

  // A family's help includes the entry its `list` form belongs to.
  for (const [family, entry] of [['agent', 'agents'], ['credential', 'credentials'], ['skill', 'skills'], ['session', 'sessions'], ['schedule', 'schedules'], ['plugin', 'plugins']] as const) {
    const help = (await run([family, '--help'])).stdout;
    assert.match(help, new RegExp(`^ {2}${entry} `, 'm'), `${family} --help shows ${entry}`);
  }
});

test('every word the help resolves runs as --help', async () => {
  // A form the help answers for and the CLI rejects would send someone
  // from a usage error to a second one.
  // `help --help` is the whole help, the one form that is meant to be.
  const commands = sectionNames(HELP_TEXT, 'Commands:').filter((name) => name !== 'help');
  const forms = new Set([
    ...commands.map((name) => name.split(' ')[0] ?? ''),
    'agent list', 'schedule', 'schedule list', 'schedule cancel', 'plugin', 'plugin list',
    'skill list', 'session list', 'credential list', 'signins', 'channels', 'memory unpin',
  ]);
  for (const form of forms) {
    const argv = [...form.split(' '), '--help'];
    const result = await run(argv);
    assert.equal(result.exitCode, 0, `${argv.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.length > 0 && result.stdout.length < HELP_TEXT.length / 4, `${argv.join(' ')} is one command's part`);
    assert.equal((await run(['help', ...form.split(' ')])).stdout, result.stdout, `help ${form}`);
  }
});

test('every command in the help has a help of its own, and every option is in one', async () => {
  const commands = sectionNames(HELP_TEXT, 'Commands:');
  assert.ok(commands.length > 40, `read the Commands section (${commands.length})`);
  const listed = new Set<string>();
  for (const name of commands) {
    if (name === 'help') {
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
    // Only `schedule list` and `schedule cancel` run, but `schedule --help` does too.
    [['schedule', 'bogus'], 'Unknown command: schedule', 'stratus schedule --help'],
    [['plugin', 'bogus'], 'Unknown command: plugin', 'stratus plugin --help'],
    // Options a command used to take and then ignore, where the help
    // never offered them: refused, so nobody thinks they filtered.
    [['memory', 'search', 'ava', 'deploy', '--trust', 'user'], 'Unknown option: --trust', 'stratus memory search --help'],
    [['memory', 'audit', 'ava', '--trust', 'user'], 'Unknown option: --trust', 'stratus memory audit --help'],
    [['memory', 'export', 'ava', '--format', 'json'], 'Unknown option: --format', 'stratus memory export --help'],
    [['credentials', '--agent', 'ava'], 'Unknown option: --agent', 'stratus credentials --help'],
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
  ] as const) {
    const result = await run([...argv]);
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Error: ${error}\nRun \`stratus --help\` for the list of commands.\n`, argv.join(' '));
  }
});

/*
 * Each command in the help, by its entry's name, and the forms of it a
 * flag is tried on: every action the entry covers, since an action can
 * take a flag of its own (`grants revoke --destination`), each with the
 * words it needs to parse, or to parse once one more option is added.
 */
const COMMAND_FORMS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  setup: [['setup']],
  chat: [['chat']],
  run: [['run', 'hello']],
  serve: [['serve']],
  service: [['service', 'install'], ['service', 'status']],
  logs: [['logs']],
  'template add': [['template', 'add', './template']],
  'skill add': [['skill', 'add', './skill']],
  'skill validate': [['skill', 'validate', './skill']],
  skills: [['skills'], ['skill', 'list']],
  plugins: [['plugins'], ['plugin', 'list']],
  'skill reload': [['skill', 'reload']],
  restart: [['restart']],
  health: [['health']],
  events: [['events']],
  sessions: [['sessions'], ['session', 'list']],
  tasks: [['tasks'], ['tasks', 'cancel', 'task-1']],
  'credential set': [['credential', 'set', 'search.apiKey'], ['credential', 'set', 'search.apiKey', '--agent', 'ava']],
  'credential env': [['credential', 'env', 'search.apiKey', 'SEARCH_API_KEY', '--agent', 'ava']],
  credentials: [['credentials'], ['credential', 'list']],
  'credential remove': [['credential', 'remove', 'search.apiKey']],
  'signin set': [['signin', 'set', 'anthropic', '--agent', 'ava']],
  'signin list': [['signin', 'list'], ['signins']],
  'signin remove': [['signin', 'remove', 'anthropic', '--agent', 'ava']],
  'channel set': [['channel', 'set', 'slack', '--agent', 'ava']],
  'channel list': [['channel', 'list'], ['channels']],
  'channel remove': [['channel', 'remove', 'slack', '--agent', 'ava']],
  schedules: [['schedules'], ['schedule', 'list'], ['schedules', 'cancel', 'schedule-1'], ['schedule', 'cancel', 'schedule-1']],
  grants: [['grants', 'ava'], ['grants', 'revoke', 'ava'], ['grants', 'revoke', 'ava', '--tool', 'web.fetch']],
  people: [['people'], ['people', 'add', 'U0123ABCD'], ['people', 'remove', 'U0123ABCD']],
  'memory list': [['memory', 'list', 'ava']],
  'memory search': [['memory', 'search', 'ava', 'deploy']],
  'memory forget': [['memory', 'forget', 'ava', 'ava:memory:1']],
  'memory audit': [['memory', 'audit', 'ava']],
  'memory pin': [['memory', 'pin', 'ava', 'ava:memory:1'], ['memory', 'unpin', 'ava', 'ava:memory:1']],
  'memory export': [['memory', 'export', 'ava']],
  'memory import': [['memory', 'import', 'ava', '--file', 'ava.jsonl']],
  'memory reassert': [['memory', 'reassert', 'ava', '--trust', 'user', 'ava:memory:1']],
  'memory passes': [['memory', 'passes', 'ava']],
  'memory undo-pass': [['memory', 'undo-pass', 'ava', 'pass-1']],
  'session rollover': [['session', 'rollover', 'slack:ava:T1:D1']],
  'agent new': [['agent', 'new']],
  agents: [['agents'], ['agent', 'list']],
  doctor: [['doctor']],
  update: [['update']],
  dashboard: [['dashboard']],
  version: [['version']],
};

/** Every flag spelled out in the parsers, accepted by some command or not. */
const parserFlags = async (): Promise<string[]> => {
  const directory = fileURLToPath(new URL('../src/parse/', import.meta.url));
  const files = [
    ...(await readdir(directory)).filter((name) => name.endsWith('.ts')).map((name) => path.join(directory, name)),
    fileURLToPath(new URL('../src/parse.ts', import.meta.url)),
  ];
  const flags = new Set<string>();
  for (const file of files) {
    for (const [, flag = ''] of (await readFile(file, 'utf8')).matchAll(/'(-{1,2}[A-Za-z][\w-]*)'/g)) {
      flags.add(flag);
    }
  }
  return [...flags].sort();
};

/** A value for each kind of option that takes one, so a form can be tried with it. */
const VALUES = ['json', 'user', '1', 'never', 'headless', 'failed', 'demo', 'SEARCH_API_KEY'];

/** What a form parses to with these words added, the first left out, or undefined when it does not parse. */
const parsed = (form: readonly string[], words: readonly string[]): string | undefined => {
  try {
    const [word = ''] = words;
    return JSON.stringify(parseCommand([...form, ...words])).replace(new RegExp(`(?<![\\w-])${word}(?![\\w-])`, 'g'), '<word>');
  } catch {
    return undefined;
  }
};

/**
 * Whether a form takes a flag: with it, alone or followed by a value, the
 * form still parses, to something it does not parse to with a flag nobody
 * defined in its place. Some parsers refuse such a flag and some take it
 * as a positional word; either way it is not the flag's own meaning.
 */
const accepts = (form: readonly string[], flag: string): boolean => {
  const stranger = flag.startsWith('--') ? '--not-a-flag' : '-Z';
  return [[], ...VALUES.map((value) => [value])].some((tail) => {
    const outcome = parsed(form, [flag, ...tail]);
    return outcome !== undefined && outcome !== parsed(form, [stranger, ...tail]);
  });
};

test('every flag a command accepts is an option in that command\'s help', async () => {
  const commands = sectionNames(HELP_TEXT, 'Commands:').filter((name) => name !== 'help');
  assert.deepEqual(Object.keys(COMMAND_FORMS).sort(), [...commands].sort(), 'a form to try flags on for every command in the help');
  // Every command takes these, and the whole help says so once.
  const global = new Set(['--help', '-h', '--version', '-v']);
  const flags = (await parserFlags()).filter((flag) => !global.has(flag));
  assert.ok(flags.length > 50, `read the parsers' flags (${flags.length})`);
  for (const forms of Object.values(COMMAND_FORMS)) {
    for (const form of forms) {
      // A form that neither parses nor takes a flag would hide its command's flags.
      assert.ok(parsed(form, []) !== undefined || flags.some((flag) => accepts(form, flag)), `${form.join(' ')} parses`);
    }
  }
  const taken = flags.filter((flag) => Object.values(COMMAND_FORMS).some((forms) => forms.some((form) => accepts(form, flag))));
  assert.deepEqual(flags.filter((flag) => !taken.includes(flag)), [], 'a flag no form takes: give COMMAND_FORMS a form it parses on, or VALUES a value it accepts');
  const missing: string[] = [];
  for (const [name, forms] of Object.entries(COMMAND_FORMS)) {
    const help = (await run([...name.split(' '), '--help'])).stdout;
    const listed = new Set([...sectionNames(help, 'Options:'), ...sectionNames(help, 'Agent options:')].flatMap((option) => option.split(', ')));
    for (const flag of flags) {
      if (!listed.has(flag) && forms.some((form) => accepts(form, flag))) {
        missing.push(`${name} ${flag}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'a flag the command takes that `stratus <command> --help` does not list as an option');
});
