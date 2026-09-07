import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DREAM_WINDOW,
  dreamNightOf,
  dreamPrompt,
  formatDreamWindow,
  formatSoul,
  nextDreamWindowStart,
  parseDreams,
  parseDreamWindow,
  parseSoul,
} from '../src/index.ts';

const DREAM_FILE = `---
window: 23:30-04:00
maxPerNight: 2
---

Nobody is awake. Write what you learn to memory; leave nothing running.

## Triage this week's flaky tests

Read the CI log and group the failures.

## Read up on SQLite WAL

Then say what it would change here.
`;

test('a dream file parses into a window, a cap, a preamble, and its dreams', () => {
  const file = parseDreams(DREAM_FILE);

  assert.deepEqual(file.window, { startMinutes: 23 * 60 + 30, endMinutes: 4 * 60 });
  assert.equal(file.maxPerNight, 2);
  assert.equal(file.preamble, 'Nobody is awake. Write what you learn to memory; leave nothing running.');
  assert.deepEqual(file.dreams.map((dream) => dream.title), [
    "Triage this week's flaky tests",
    'Read up on SQLite WAL',
  ]);
  assert.equal(file.dreams[1]?.body, 'Then say what it would change here.');
});

test('a dream file with no frontmatter dreams in the default window', () => {
  const file = parseDreams('## Build the docs site\n\nSee whether it still builds.\n');

  assert.deepEqual(file.window, DEFAULT_DREAM_WINDOW);
  assert.equal(formatDreamWindow(file.window), '01:00-05:00');
  assert.equal(file.maxPerNight, undefined);
  assert.equal(file.preamble, undefined);
  assert.equal(file.dreams.length, 1);
});

test('a heading inside a fenced block is part of the dream, not another one', () => {
  const file = parseDreams([
    '## Try the new parser',
    '',
    'Run it, then paste the report under a heading:',
    '',
    '```markdown',
    '## Findings',
    'one per line',
    '```',
    '',
    '## Second dream',
    'and its body',
    '',
  ].join('\n'));

  assert.deepEqual(file.dreams.map((dream) => dream.title), ['Try the new parser', 'Second dream']);
  assert.match(file.dreams[0]?.body ?? '', /## Findings/);
});

test('a dream file refuses what it cannot act on', () => {
  assert.throws(() => parseDreams('---\nwindow: midnight to five\n---\n'), /two 24-hour local times/);
  assert.throws(() => parseDreams('---\nwindow: 25:00-04:00\n---\n'), /24-hour local time/);
  assert.throws(() => parseDreams('---\nwindow: 01:00-01:00\n---\n'), /never opens/);
  assert.throws(() => parseDreams('---\nmaxPerNight: 0\n---\n'), /at least 1/);
  // Strict, like a soul: an unknown key here is a misspelling that would
  // silently leave a default deciding when unattended work runs.
  assert.throws(() => parseDreams('---\nwindwo: 01:00-05:00\n---\n'), /Unknown dream frontmatter key/);
});

test('a window that crosses midnight is one night, named for the evening it opened', () => {
  const window = parseDreamWindow('23:00-03:00');

  // 23:30 on the 7th and 01:30 on the 8th are the same night.
  assert.equal(dreamNightOf(window, new Date(2026, 8, 7, 23, 30)), '2026-09-07');
  assert.equal(dreamNightOf(window, new Date(2026, 8, 8, 1, 30)), '2026-09-07');
  // The 1st's small hours belong to the night that opened in August.
  assert.equal(dreamNightOf(window, new Date(2026, 8, 1, 0, 30)), '2026-08-31');
  // Outside it, nobody is dreaming.
  assert.equal(dreamNightOf(window, new Date(2026, 8, 8, 3, 0)), undefined);
  assert.equal(dreamNightOf(window, new Date(2026, 8, 8, 14, 0)), undefined);
});

test('a window inside one day is that day, and shut either side of it', () => {
  const window = parseDreamWindow('01:00-05:00');

  assert.equal(dreamNightOf(window, new Date(2026, 8, 7, 0, 59)), undefined);
  assert.equal(dreamNightOf(window, new Date(2026, 8, 7, 1, 0)), '2026-09-07');
  assert.equal(dreamNightOf(window, new Date(2026, 8, 7, 4, 59)), '2026-09-07');
  assert.equal(dreamNightOf(window, new Date(2026, 8, 7, 5, 0)), undefined);
});

test('the next window start is the coming one, never the one just passed', () => {
  const window = parseDreamWindow('01:00-05:00');

  assert.deepEqual(nextDreamWindowStart(window, new Date(2026, 8, 7, 0, 30)), new Date(2026, 8, 7, 1, 0));
  // Inside the window, the next one is tomorrow's: tonight's has opened.
  assert.deepEqual(nextDreamWindowStart(window, new Date(2026, 8, 7, 2, 0)), new Date(2026, 8, 8, 1, 0));
  assert.deepEqual(nextDreamWindowStart(window, new Date(2026, 8, 30, 22, 0)), new Date(2026, 9, 1, 1, 0));
});

test('a dream is dispatched as the file preamble plus that dream', () => {
  const file = parseDreams(DREAM_FILE);
  const dream = file.dreams[0];
  assert.ok(dream);

  assert.equal(
    dreamPrompt(file, dream),
    'Nobody is awake. Write what you learn to memory; leave nothing running.\n\n'
      + "## Triage this week's flaky tests\n\n"
      + 'Read the CI log and group the failures.',
  );
  // A file with no preamble sends the dream alone, with no blank framing.
  const bare = parseDreams('## Just this\n');
  const only = bare.dreams[0];
  assert.ok(only);
  assert.equal(dreamPrompt(bare, only), '## Just this');
});

test('a soul enables dreaming by naming its file, and round-trips it', () => {
  const soul = parseSoul('---\nname: Ava\ndreams: ./ava.dreams.md\n---\n\nA researcher.\n');

  assert.equal(soul.dreams, './ava.dreams.md');
  assert.match(formatSoul(soul), /^dreams: \.\/ava\.dreams\.md$/m);
  assert.equal(parseSoul(formatSoul(soul)).dreams, './ava.dreams.md');
  // An agent that names no file does not dream.
  assert.equal(parseSoul('---\nname: Ava\n---\n\nA researcher.\n').dreams, undefined);
});
