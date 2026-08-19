/**
 * The welcome banner. Almost every case here is about it *not* appearing —
 * that is where a first-run flourish turns into an annoyance, and the gating
 * is more of the work than the art.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bannerFacts,
  parseCommand,
  renderBanner,
  shouldShowBanner,
  STRATUS_ART,
  CLI_VERSION,
} from '../src/index.ts';

const FACTS = [
  { label: 'cli', value: 'stratus 0.3.0' },
  { label: 'node', value: '22.13.0' },
];

// Ragged on purpose: the last row is shorter than the widest and is the one
// with no fact beside it, which is the only combination that exposes padding
// applied where there is nothing to align against.
const ART = ['##  ##', '######', '## ##'];

test('a bare invocation is distinguishable from an explicit help', () => {
  // Both print the same help. They are different questions, and only one of
  // them gets a picture.
  assert.deepEqual(parseCommand([]), { command: 'help', bare: true });

  for (const argv of [['help'], ['--help'], ['-h']]) {
    assert.deepEqual(parseCommand(argv), { command: 'help' }, argv.join(' '));
  }
});

test('a terminal gets the banner', () => {
  assert.equal(shouldShowBanner({ stdoutIsTty: true, processEnv: {} }), true);
});

test('a pipe or a redirect does not', () => {
  // Gated on stdout, not stdin. `stratus > file` has a terminal on stdin and a
  // file on stdout, and the rest of this CLI gets that wrong.
  assert.equal(shouldShowBanner({ stdoutIsTty: false, processEnv: {} }), false);
});

test('CI does not', () => {
  for (const name of ['CI', 'GITHUB_ACTIONS', 'BUILDKITE']) {
    assert.equal(
      shouldShowBanner({ stdoutIsTty: true, processEnv: { [name]: 'true' } }),
      false,
      name,
    );
  }

  // An unset-looking value is not CI. Some runners export CI="" or CI=0.
  for (const value of ['', '0', 'false']) {
    assert.equal(
      shouldShowBanner({ stdoutIsTty: true, processEnv: { CI: value } }),
      true,
      `CI=${JSON.stringify(value)}`,
    );
  }
});

test('NO_COLOR and TERM=dumb do not', () => {
  assert.equal(shouldShowBanner({ stdoutIsTty: true, processEnv: { NO_COLOR: '1' } }), false);
  // NO_COLOR is honoured when set at all, including to the empty string.
  assert.equal(shouldShowBanner({ stdoutIsTty: true, processEnv: { NO_COLOR: '' } }), false);
  assert.equal(shouldShowBanner({ stdoutIsTty: true, processEnv: { TERM: 'dumb' } }), false);
});

test('colour does not move anything', () => {
  // The failure mode is measuring a painted string with String.length, which
  // counts escape sequences a human cannot see and lands every row at a
  // different visual column.
  const coloured = renderBanner(ART, FACTS, { columns: 80, colour: true });
  const plain = renderBanner(ART, FACTS, { columns: 80, colour: false });

  const strip = (line: string): string => line.replace(/\[[0-9;]*m/g, '');
  assert.deepEqual(coloured.map(strip), plain);

  const columns = FACTS.map((fact, index) => (plain[index] ?? '').indexOf(fact.value));
  assert.ok(
    columns.every((column) => column > 0 && column === columns[0]),
    `values start at different columns: ${columns.join(', ')}`,
  );
});

test('a narrow terminal stacks instead of overflowing', () => {
  // Side-by-side that does not fit wraps into interleaved nonsense, which is
  // far worse than two blocks.
  const lines = renderBanner(ART, FACTS, { columns: 20, colour: false });

  assert.equal(lines.length, ART.length + 1 + FACTS.length);
  assert.deepEqual(lines.slice(0, ART.length), ART);
  assert.equal(lines[ART.length], '');
  for (const line of lines) {
    assert.ok(line.length <= 20, `"${line}" overflows 20 columns`);
  }
});

test('a reported width of zero falls back to 80 rather than stacking', () => {
  // Some pty wrappers report 0 before the first resize. Treated literally it
  // is narrower than everything and every banner stacks.
  const lines = renderBanner(ART, FACTS, { columns: 0, colour: false });
  assert.equal(lines.length, ART.length);
});

test('no line ends in whitespace', () => {
  // Invisible until the output lands in a diff or a commit message, where it
  // is a lint failure with no obvious cause.
  for (const columns of [80, 20]) {
    for (const line of renderBanner(ART, FACTS, { columns, colour: false })) {
      assert.doesNotMatch(line, /\s$/, `"${line}" ends in whitespace`);
    }
  }
});

test('the real art and facts fit an 80-column terminal side by side', () => {
  const lines = renderBanner(STRATUS_ART, bannerFacts(CLI_VERSION, 'darwin'), {
    columns: 80,
    colour: false,
  });

  assert.equal(lines.length, STRATUS_ART.length, 'expected side by side, not stacked');
  for (const line of lines) {
    assert.ok(line.length <= 80, `"${line}" overflows 80 columns`);
  }
});

test('the facts are local — nothing that can hang or fail', () => {
  // This renders before the user has asked the CLI to do anything. A welcome
  // screen that reads a config file or the network is a support ticket.
  const facts = bannerFacts('9.9.9', 'linux');
  assert.deepEqual(
    facts.map((fact) => fact.label),
    ['cli', 'node', 'platform'],
  );
  assert.equal(facts[0]?.value, 'stratus 9.9.9');
  assert.equal(facts[2]?.value, 'linux');
});
