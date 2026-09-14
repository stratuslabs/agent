import test from 'node:test';
import assert from 'node:assert/strict';

import { toSlackMrkdwn } from '../src/mrkdwn.ts';

/**
 * Reads code runs out of a reply without asking the module under test.
 *
 * The invariant these guard is the one nine rounds of review kept finding
 * broken from a new direction, so the check has to be able to disagree with
 * the thing it is checking.
 */
const codeRuns = (text: string): string[] => {
  const runs: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] !== '`') {
      at += 1;
      continue;
    }
    let length = 1;
    while (text[at + length] === '`') {
      length += 1;
    }
    const mark = '`'.repeat(length);
    let close = -1;
    for (let scan = text.indexOf(mark, at + length); scan !== -1; scan = text.indexOf(mark, scan + 1)) {
      if (text[scan - 1] !== '`' && text[scan + length] !== '`') {
        close = scan;
        break;
      }
    }
    if (close === -1) {
      if (length >= 3) {
        runs.push(text.slice(at));
        return runs;
      }
      at += length;
      continue;
    }
    runs.push(text.slice(at, close + length));
    at = close + length;
  }
  return runs;
};

const converts = (cases: ReadonlyArray<readonly [string, string]>): void => {
  for (const [input, expected] of cases) {
    assert.equal(toSlackMrkdwn(input), expected, `converting ${JSON.stringify(input)}`);
  }
};

test('the spellings Slack renders differently are the ones that change', () => {
  converts([
    ['**bold**', '*bold*'],
    ['*italic*', '_italic_'],
    ['***both***', '*_both_*'],
    ['__bold__', '*bold*'],
    ['~~struck~~', '~struck~'],
    ['___important___', '*_important_*'],
    ['[the docs](https://example.com/a_b)', '<https://example.com/a_b|the docs>'],
    ['## Four things', '*Four things*'],
    // Already the same in both dialects, so touching them could only be wrong.
    ['- a list item', '- a list item'],
    ['> a quote', '> a quote'],
    ['`inline code`', '`inline code`'],
    ['_italic_', '_italic_'],
  ]);
});

test('a run spends only what its style has, and the rest stays text', () => {
  // Three asterisks or underscores are two styles at once; three tildes are
  // a style that does not exist. Charged for one anyway, the third tilde on
  // each side of `~~~obsolete~~~` was spent on nothing and disappeared —
  // which is the same fault as a character taken out of a snippet, arriving
  // through the arithmetic rather than through the text.
  converts([
    ['~~~obsolete~~~', '~~obsolete~~'],
    ['___important___', '*_important_*'],
    ['***both***', '*_both_*'],
    ['~~ok~~', '~ok~'],
    ['__bold__', '*bold*'],
  ]);
  // Past three there is nothing left to buy, so the surplus stays written
  // where it was. These read oddly, and they read oddly in Markdown too —
  // what matters is that no character is charged for a style and lost.
  converts([
    ['****quad****', '**_quad_**'],
    ['____quad____', '_*_quad_*_'],
    ['~~~~four~~~~', '~~~four~~~'],
  ]);
});

test('a delimiter has to hug what it marks, or it is arithmetic and names', () => {
  converts([
    ['3 * 4 * 5', '3 * 4 * 5'],
    ['a lone * star', 'a lone * star'],
    ['snake_case_name', 'snake_case_name'],
    ['trailing ** unmatched', 'trailing ** unmatched'],
    // Intraword is emphasis in Markdown for asterisks, and reads that way
    // in Slack too — which is why the underscore rule is separate.
    ['a**b**c', 'a*b*c'],
    // Emphasis does not cross a line in either dialect: one stray marker at
    // the end of a paragraph must not reach into the next.
    ['multi\n**line\nbold**', 'multi\n**line\nbold**'],
  ]);
});

test('a code run is one token, so nothing reads or rewrites inside it', () => {
  converts([
    ['inline `**code**` vs **real**', 'inline `**code**` vs *real*'],
    ['x\n```js\nconst a = **not bold**;\n# not a heading\n```\ny **yes**', 'x\n```js\nconst a = **not bold**;\n# not a heading\n```\ny *yes*'],
    // A longer delimiter carries a shorter one: the run that closes has to
    // be exactly as long as the one that opened.
    ['a ``span with a ` inside`` stays', 'a ``span with a ` inside`` stays'],
    ['````\n```\n**x**\n```\n````', '````\n```\n**x**\n```\n````'],
    // A fence nobody closed takes the rest of the reply, which is what
    // every edit before a streamed block's last one looks like.
    ['x\n```\n**stays literal**\n### stays', 'x\n```\n**stays literal**\n### stays'],
    // One or two unmatched backticks are text, so "use the ` character"
    // does not swallow what follows.
    ['use the ` character, then **bold**', 'use the ` character, then *bold*'],
    // But a pair of them is a span however far apart, because Slack pairs
    // them too — what is between them is what it renders as code.
    ['`first\n**second**`', '`first\n**second**`'],
  ]);
});

test('an emphasis run reaches its closer across a snippet', () => {
  // Rewriting one prose fragment at a time could not do this: the `**` that
  // opened the run and the `**` that closed it landed in different
  // fragments whenever a snippet sat between them, and neither found its
  // partner. Every one of these arrived as literal asterisks.
  converts([
    ['**the `fs.read` tool**', '*the `fs.read` tool*'],
    ['*the `fs.read` tool*', '_the `fs.read` tool_'],
    ['~~the `fs.read` tool~~', '~the `fs.read` tool~'],
    ['**a `x` b `y` c**', '*a `x` b `y` c*'],
    // Including a snippet with a newline in it. The run is not crossing a
    // line — the newline is inside the span, so the prose around it never
    // breaks — and Slack pairs its own delimiters across newlines, which
    // is the same thing that makes a fence one code run to it. The old
    // converter left these as literal asterisks, for the fragment reason
    // above rather than a decision about what Slack does.
    ['**before `a\nb` after**', '*before `a\nb` after*'],
    ['~~gone `p\nq` now~~', '~gone `p\nq` now~'],
  ]);
});

test('a reply nested past the call stack converts instead of taking the process down', () => {
  // A few thousand pairs one inside the next is a runaway model or a pasted
  // file rather than a person, and the throw lands in the edit timer, which
  // evaluates the conversion synchronously outside anything catching it —
  // so the reply took the adapter with it. Depth belongs in an array.
  const depth = 10_000;
  const reply = `${'*a '.repeat(depth)}z${' a*'.repeat(depth)}`;
  const converted = toSlackMrkdwn(reply);
  assert.equal(converted.includes('z'), true);
  assert.equal([...converted].filter((char) => char === 'a').length, depth * 2);
});

test('a wrapper is not emitted when its own character is loose in what it wraps', () => {
  // Slack has one delimiter per style and no way to nest it, so `*a *b* c*`
  // renders as neither bold nor plain text. One rule covers the heading
  // that already holds bold, the bold run with a stray asterisk in it, and
  // every pairing of the two.
  converts([
    ['**a * b**', '**a * b**'],
    ['# glob *.ts', 'glob *.ts'],
    ['# Calculate 2 * 3', 'Calculate 2 * 3'],
    ['# Some **bold** word', 'Some *bold* word'],
    ['## **Run** `npm test` now', '*Run* `npm test` now'],
    // Nested styles are fine when the characters differ.
    ['**_nested_**', '*_nested_*'],
    ['*_odd_*', '*_odd_*'],
    // Both at once is written `*_…_*`, so a loose underscore inside blocks
    // it as surely as a loose asterisk would — every character a wrapper is
    // spelled with has to be clear, not just the one it starts with.
    ['***both***', '*_both_*'],
    ['***a _ b***', '***a _ b***'],
    // An asterisk inside a snippet is not loose — Slack reads no markup
    // there, so it cannot pair with the wrapper.
    ['## Match `*.ts` files', '*Match `*.ts` files*'],
    ['## Match `*.ts` and `*.js` files', '*Match `*.ts` and `*.js` files*'],
    ['## Match `*.ts` **now**', 'Match `*.ts` *now*'],
  ]);
});

test('a heading is a line the reader sees, not a line of somebody\'s script', () => {
  converts([
    // The newlines in a fence are not breaks in the token stream, so these
    // lines do not exist to be mistaken for headings.
    ['x\n```sh\n# a real comment\n```\ny', 'x\n```sh\n# a real comment\n```\ny'],
    ['```\n## not a heading\n```', '```\n## not a heading\n```'],
    // And a line that merely starts after a snippet is not a new line.
    ['`status` # not a heading', '`status` # not a heading'],
    // A heading that contains a snippet is still one heading.
    ['## Run `npm test` now', '*Run `npm test` now*'],
    ['## Run `npm test`', '*Run `npm test`*'],
    ['   # indented', '*indented*'],
    // Four spaces is a code block in Markdown, not a heading.
    ['    # four spaces', '    # four spaces'],
    ['#', '#'],
    ['#  ', '#  '],
  ]);
});

test('a heading sheds the syntax that is in prose, and only that', () => {
  converts([
    ['## Notes ###', '*Notes*'],
    ['## Four things   ', '*Four things*'],
    ['## Four things ', '*Four things*'],
    // A closing run only counts when it is spaced off the text, or `# C#`
    // is a heading whose name loses its last character.
    ['# C#', '*C#*'],
    // These end inside a span, so there is no last text token to take a
    // closing run from — the hash and the space beside it are the snippet's.
    ['# show `value #\nnext`', 'show `value #\nnext`'],
    ['# show `value  \nnext`', 'show `value  \nnext`'],
    ['# show `value \nnext`', 'show `value \nnext`'],
    ['# show `value　\nnext`', 'show `value　\nnext`'],
  ]);
});

test('a heading whose closing marker would land in code is not bolded', () => {
  converts([
    // A snippet with a newline in it means the line runs past its own end,
    // so it is no longer the one line a heading is.
    ['# Inspect `first\nsecond`', 'Inspect `first\nsecond`'],
    ['# Inspect ```third\nfourth```', 'Inspect ```third\nfourth```'],
    // A fence nobody closed leaves no prose at the end to put it in. This
    // is the mid-stream state, seen on every edit until the block closes.
    ['# Inspect ```first', 'Inspect ```first'],
    // And what the line ends with is the snippet's, not a closing marker:
    // the hash and the spaces here are inside the fence, so a heading that
    // takes its tail from wherever the line happens to end takes them.
    ['# Inspect ```first #', 'Inspect ```first #'],
    ['# Inspect ```first  ', 'Inspect ```first  '],
  ]);
});

test('a link is read from the characters its destination was written with', () => {
  converts([
    ['[use `a`](https://host/b)', '<https://host/b|use `a`>'],
    ['[use `a`](https://host/`b`)', '<https://host/`b`|use `a`>'],
    // A space in the destination means it was never a destination. The
    // rewrite this replaced could not see one: it matched a stand-in for
    // the snippet and had to be told separately what shape it hid.
    ['[label](https://host/`a b`)', '[label](https://host/`a b`)'],
    ['[text](notaurl)', '[text](notaurl)'],
    ['[mail](mailto:a@b.c)', '<mailto:a@b.c|mail>'],
    ['[**bold** label](https://h/x)', '<https://h/x|*bold* label>'],
    // `<url|label>` is one line's worth of markup, so a link is one line.
    // A break between the brackets ends the search on its own; a newline
    // hidden inside a single code token has to end it too.
    ['[label `a\nb`](https://x)', '[label `a\nb`](https://x)'],
    // A closing bracket spends its opener whether or not a destination
    // follows it, the way Markdown's own does. Kept, the opener let a
    // `](…)` further along reach back past the bracket that had already
    // answered it, and the text in between disappeared into a label.
    ['[not a link] text](https://example.com)', '[not a link] text](https://example.com)'],
    ['[a] and [b](https://h/x)', '[a] and <https://h/x|b>'],
    ['see [1] and the [docs](https://h/d)', 'see [1] and the <https://h/d|docs>'],
    // The nearest opener is the one a bracket answers.
    ['[outer [inner](https://h/x)', '[outer <https://h/x|inner>'],
  ]);
});

test('a destination is an address, and its characters are not markup', () => {
  // A `*` in a path is part of the path. Left pairable it closed the bold
  // run that opened before the link, and the address went out as
  // `/files/_.txt` — a URL altered, which is the same defect as a snippet
  // altered, in the one place the question had not been asked.
  converts([
    ['[files](https://host/files/*.txt)', '<https://host/files/*.txt|files>'],
    ['**[files](https://host/files/*.txt)**', '**<https://host/files/*.txt|files>**'],
    // An underscore in a path does not block a bold wrapper, because only
    // a wrapper's own character can pair with what is inside it.
    ['**[f](https://host/a_b_c)**', '*<https://host/a_b_c|f>*'],
  ]);
  // The second line above is the conservative half of a trade worth naming.
  // The address survives either way now, since a destination's delimiters
  // are inert here and can never be consumed as markup. What is not known
  // is whether Slack pairs them when it renders `<url|label>`, and the two
  // answers differ: bolded, a reader sees bold or a broken run; left alone,
  // a reader sees two asterisks. Asterisks are the lesser fault, and this
  // file has been wrong before about what Slack does with a character it
  // was only assumed to ignore.
});

test('a marker still being written stays literal until its closing half arrives', () => {
  // An edit is what a reader is looking at, not a draft nobody sees, so
  // nothing may be rewritten on the guess that a partner is coming.
  converts([
    ['**Almost', '**Almost'],
    ['**Almost there**', '*Almost there*'],
    ['~~half', '~~half'],
  ]);
});

test('conversion never changes whether a marker pairs up', () => {
  // The property behind the streamed cases: a half-written `**` is the
  // writer's own loose marker and stays one, but the conversion must never
  // leave one behind that the reply had paired, or pair one it had not.
  const reply = [
    '## Four things',
    '',
    '1. **Name mismatch.** The persona says `memory.remember`.',
    '2. ~~Dropped~~ — see [the guide](https://example.com/docs).',
    '3. ***Both***, and **the `fs.read` tool** spans a snippet.',
    '',
    '```js',
    'const bold = "**not bold**"; // # not a heading',
    '```',
  ].join('\n');

  const loose = (text: string, char: string): number => {
    const outside = codeRuns(text).reduce((rest, run) => rest.replace(run, ''), text);
    return [...outside].filter((one) => one === char).length;
  };

  for (let length = 1; length <= reply.length; length += 1) {
    const prefix = reply.slice(0, length);
    const converted = toSlackMrkdwn(prefix);
    for (const char of ['*', '_', '~']) {
      assert.equal(
        loose(converted, char) % 2,
        loose(prefix, char) % 2,
        `${char} pairing changed at ${length}: ${JSON.stringify(prefix)} -> ${JSON.stringify(converted)}`,
      );
    }
  }
});

test('a line converts the same alone as it does in place', () => {
  // Emphasis does not cross a line in either dialect, and the consequence
  // worth testing is not that a run fails to reach the next paragraph —
  // rendering is per line, so it could not — but that a marker left open on
  // one line cannot reach forward and take the partner of a pair on
  // another. Below, the `~~` on the first line is what the third line's
  // `~~~` matches when openers survive a break, and truncating the stack to
  // reach it throws away the `__` that the last `__` was going to close.
  // Both pairs on that line are lost to a marker two lines above them.
  const reply = '~~`c`__\n\n__~~~__';
  assert.equal(toSlackMrkdwn(reply), '~~`c`__\n\n*~~~*');
  assert.equal(
    toSlackMrkdwn(reply),
    reply.split('\n').map(toSlackMrkdwn).join('\n'),
    'a line should not depend on the lines around it',
  );

  // The same property over replies built at random. Code that spans a line
  // is left out of them, since splitting one by line would cut it in half
  // and the two sides would rightly convert differently.
  const pieces = ['*', '**', '_', '__', '~', '~~', 'a', 'bc', ' ', '`c`', '#', '# ', '.', '[l](https://h/x)'];
  let seed = 11;
  const next = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % bound;
  };

  for (let round = 0; round < 4000; round += 1) {
    const lines: string[] = [];
    for (let line = 2 + next(4); line > 0; line -= 1) {
      let built = '';
      for (let piece = next(6); piece > 0; piece -= 1) {
        built += pieces[next(pieces.length)] ?? '';
      }
      lines.push(built);
    }
    const whole = lines.join('\n');
    assert.equal(
      toSlackMrkdwn(whole),
      whole.split('\n').map(toSlackMrkdwn).join('\n'),
      `a line depended on another in ${JSON.stringify(whole)}`,
    );
  }
});

test('no reply, however written, has a character taken out of its code', () => {
  // The defect this whole design answers to, as a property rather than a
  // list: four of the nine review rounds on the rewrite it replaced were
  // one character disappearing from inside a snippet, each reached from a
  // direction the last fix had not covered.
  //
  // The pieces are the shapes those rounds needed — code ending in the very
  // characters a heading strips, code spanning a line, a fence left open —
  // because a random walk over bare punctuation never builds them.
  const pieces = [
    '*', '**', '***', '_', '__', '~', '~~', '`', '``', '```', '#', '##', ' ', '  ', '\n',
    'a', 'bc', '.', '[', ']', '(', ')', 'https://h/x', ' ', '　', '\t', 'C#', '*.ts',
    '`v #`', '`v  `', '`v `', '`a\nb`', '```f', '``s ` i``', '**b**', '*i*', '~~s~~',
    '[l](https://h/x)', '[l](https://h/a b)', '**a `c` b**', '# h', '\n# h `c #`\n',
    // Runs past what a style can spend. These were missing while the table
    // said every delimiter reached three, and `~~~x~~~` lost two tildes to a
    // style tildes do not have — a character gone, which is what this check
    // is for, arriving through the arithmetic rather than through the text.
    '~~~', '~~~~', '___', '____', '****', '***x***', '~~~x~~~', '___x___',
  ];
  // A fixed seed, so a failure is a case anybody can reproduce from this file.
  let seed = 20260913;
  const next = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % bound;
  };

  for (let round = 0; round < 20000; round += 1) {
    let reply = '';
    for (let piece = 1 + next(12); piece > 0; piece -= 1) {
      reply += pieces[next(pieces.length)] ?? '';
    }
    const converted = toSlackMrkdwn(reply);
    for (const run of codeRuns(reply)) {
      assert.ok(
        converted.includes(run),
        `code altered\n  in  ${JSON.stringify(reply)}\n  out ${JSON.stringify(converted)}\n  run ${JSON.stringify(run)}`,
      );
    }
  }
});
