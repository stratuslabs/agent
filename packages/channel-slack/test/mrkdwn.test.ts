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

test('a run with characters to spare answers more than one opener', () => {
  // A run is not one marker but a purse. `**bold and *italic***` ends on
  // three asterisks with two jobs — one closes the italic, two close the
  // bold — and a closer that answered only its nearest opener left the
  // outer `**` unanswered, with its asterisks on the line for the reader.
  converts([
    ['**bold and *italic***', '*bold and _italic_*'],
    ['**a *b***', '*a _b_*'],
    // The same the other way about: one opening run, two closers, spent
    // from the end nearest what it marks so the styles nest as written.
    ['***a** b*', '_*a* b_'],
    // Strictly inside has always worked, and still does.
    ['**a *b* c**', '*a _b_ c*'],
    // A pair lies wholly inside a link's label or wholly outside it. One
    // that straddles the boundary cannot be written at all — the label
    // becomes `<url|label>`, so a wrapper cannot start outside it and end
    // inside — and each of these was an attempt to render one: the first
    // came out as text with no link in it, the second two asterisks short.
    ['*a [**b***](https://x)', '*a <https://x|*b**>'],
    ['*a [**b](https://x)***', '_a <https://x|**b>_**'],
    ['[***a**](https://x) b*', '<https://x|**a*> b*'],
    // Which also settles one that was broken before any of this: a single
    // pair reaching across the boundary turned the whole link into text.
    ['*a [*b**](https://x)', '*a <https://x|*b**>'],
  ]);
  // Each opener answers a given closer once, so a run cannot buy the same
  // style twice over with characters the first pairing could not spend.
  converts([
    ['****quad****', '**_quad_**'],
    ['~~~obsolete~~~', '~~obsolete~~'],
  ]);
  // Those two pass either way, and it took the mutation sweep to say so:
  // let an opener answer twice and the second wrapper is refused anyway,
  // because the first one's markup is by then a loose asterisk inside it.
  // That rule and this one agree nearly everywhere — 300 000 generated
  // replies of asterisks and letters found no shape where they disagree.
  // This is one, because the tildes break up what would otherwise be
  // loose, so the second pairing goes through and rewrites the line.
  converts([['*****~~*~~****', '*****~*~****']]);
});

test('a run that has been answered is not there to answer a second closer', () => {
  // The same rule as the bracket that spends its opener, and for the same
  // reason. Left standing, the `*` that had already closed `*a*` was still
  // the nearest opener when the stray one at the end arrived, and the
  // italic landed on `a* b` — a span the reply does not contain.
  converts([
    ['*a* b*', '_a_ b*'],
    ['~~a~~ b~~', '~a~ b~~'],
    ['**a** b* c*', '*a* b* c*'],
  ]);
});

test('runs whose lengths add to three do not pair, so arithmetic stays arithmetic', () => {
  // Markdown's rule of three: where either half of a would-be pair could
  // face both ways, lengths adding to a multiple of three do not pair —
  // unless both are multiples of three. Without it the `*` in
  // `**cost 2*3**` answered the `**` before it, italicising `cost 2`, text
  // the reply never marked at all, and leaving the closing `**` with
  // nothing to pair with.
  converts([
    ['**cost 2*3**', '**cost 2*3**'],
    ['**a*b**', '**a*b**'],
    // A closer the rule turns away is still an opener for what follows it,
    // which is the whole of why the second `*` here finds the first.
    ['2*3 and 4*5', '2_3 and 4_5'],
    ['**x*y*z**', '*x_y_z*'],
    // Both lengths multiples of three is the exception the rule carves out,
    // and it needs a run that faces both ways to be exercised at all.
    ['a***b***c', 'a*_b_*c'],
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
    // Markdown allows a label with nothing in it; Slack's spelling has
    // nowhere to put one, and `<url|>` is a link a reader can neither see
    // nor click. The line keeps the address where it is visible instead.
    ['[](https://example.com)', '[](https://example.com)'],
    ['![](https://example.com)', '![](https://example.com)'],
    ['see [](https://h/x) here', 'see [](https://h/x) here'],
    // A label with something in it is still a label, whitespace included.
    ['[ ](https://h/x)', '<https://h/x| >'],
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
    // The line above stopped proving anything when the rule of three
    // arrived: `**` and the path's lone `*` add to three, so that pairing
    // is refused for a second reason now and the case passes either way.
    // These do not — each is a length the rule allows, so the destination
    // being inert is the only thing holding the address together.
    ['*[f](https://h/a*b)*', '_<https://h/a*b|f>_'],
    ['**[f](https://h/a**b)**', '**<https://h/a**b|f>**'],
    ['~~[f](https://h/a~~b)~~', '~~<https://h/a~~b|f>~~'],
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

test('a pipe table becomes a code block whose columns line up', () => {
  const table = [
    '| Tool | Status | Runs |',
    '| :--- | :----: | ---: |',
    '| fs.read | **ok** | 12 |',
    '| `web.fetch` | failing | 3 |',
  ].join('\n');

  // Slack has no table syntax: this used to arrive as literal pipes.
  assert.equal(toSlackMrkdwn(table), [
    '```',
    'Tool      │ Status  │ Runs',
    '──────────┼─────────┼─────',
    'fs.read   │   ok    │   12',
    'web.fetch │ failing │    3',
    '```',
  ].join('\n'));
});

test('an escaped pipe in a cell is a character, not a column', () => {
  const table = ['| Pattern | Means |', '| --- | --- |', '| a\\|b | either |'].join('\n');
  assert.equal(toSlackMrkdwn(table), ['```', 'Pattern │ Means', '────────┼───────', 'a|b     │ either', '```'].join('\n'));
});

test('a table inside a code fence is left as written', () => {
  const fenced = ['```', '| a | b |', '| - | - |', '| 1 | 2 |', '```'].join('\n');
  assert.equal(toSlackMrkdwn(fenced), fenced);
});

test('prose after a table is converted as prose', () => {
  const reply = ['| a | b |', '| - | - |', '| 1 | 2 |', '', 'That is **all**.'].join('\n');
  assert.equal(toSlackMrkdwn(reply), ['```', 'a │ b', '──┼──', '1 │ 2', '```', '', 'That is *all*.'].join('\n'));
});

test('a table too wide for a phone becomes one line per row, each value named by its header', () => {
  const long = 'a description long enough to push the grid past sixty columns';
  const reply = ['| **Name** | Description |', '| --- | --- |', `| alpha | ${long} |`, '| beta | |'].join('\n');
  assert.equal(toSlackMrkdwn(reply), [`*Name*: alpha · *Description*: ${long}`, '*Name*: beta'].join('\n'));
});

test('pipes without a delimiter row are not a table', () => {
  const reply = 'Run `a | b` and then c | d.';
  assert.equal(toSlackMrkdwn(reply), reply);
});

test('a wide table with no rows keeps its header', () => {
  const label = 'A column heading long enough to push the grid well past sixty';
  const reply = [`| ${label} | B |`, '| --- | --- |'].join('\n');
  // The list form had no row to name a value in, and returned nothing at all.
  assert.equal(toSlackMrkdwn(reply), `*${label}* · *B*`);
});

test('a pipe after an escaped backslash still separates columns', () => {
  // The two backslashes escape each other, so the pipe is a separator.
  const table = ['| Path | Kind |', '| --- | --- |', '| C:\\\\| drive |'].join('\n');
  assert.equal(toSlackMrkdwn(table), ['```', 'Path │ Kind', '─────┼──────', 'C:\\\\ │ drive', '```'].join('\n'));
});

test('a code span in a cell loses its whole delimiter, however many backticks', () => {
  const table = ['| One | Two | Three |', '| --- | --- | --- |', '| `a` | ``b`` | ```c``` |'].join('\n');
  // Only one tick came off each side, leaving `b` and ``c`` showing.
  assert.equal(toSlackMrkdwn(table), ['```', 'One │ Two │ Three', '────┼─────┼──────', 'a   │ b   │ c', '```'].join('\n'));
});

test('double markers that are not emphasis stay in a cell', () => {
  const table = ['| Expr | Name |', '| --- | --- |', '| 2 ** 3 ** 4 | snake__case__name |', '| **bold** | __under__ |'].join('\n');
  // Unconditional stripping turned these into `2  3  4` and `snakecasename`.
  assert.equal(toSlackMrkdwn(table), [
    '```',
    'Expr        │ Name',
    '────────────┼──────────────────',
    '2 ** 3 ** 4 │ snake__case__name',
    'bold        │ under',
    '```',
  ].join('\n'));
});

test('prose whose only pipe is escaped is not a table, underline or not', () => {
  const reply = 'Set the regex to a\\|b\n---';
  assert.equal(toSlackMrkdwn(reply), reply);
});

test('a one-column table is a list under its header', () => {
  const table = ['| Steps |', '| --- |', '| **build** |', '| test |'].join('\n');
  assert.equal(toSlackMrkdwn(table), ['*Steps*', '• *build*', '• test'].join('\n'));
});

test('a cell sheds every emphasis marker the converter reads, italics included', () => {
  const table = ['| State | Note |', '| --- | --- |', '| *pending* | _soon_ |', '| ***both*** | 2 * 3 |'].join('\n');
  // Only bold was stripped before, so single markers showed inside the code block.
  assert.equal(toSlackMrkdwn(table), ['```', 'State   │ Note', '────────┼──────', 'pending │ soon', 'both    │ 2 * 3', '```'].join('\n'));
});

test('wide characters are padded by the columns they take', () => {
  const table = ['| Word | Count |', '| --- | --- |', '| 漢字 | 1 |', '| abcd | 2 |'].join('\n');
  // 漢字 is two characters wide on screen each; counted as two units, the
  // separator after it drew two columns late.
  assert.equal(toSlackMrkdwn(table), ['```', 'Word │ Count', '─────┼──────', '漢字 │ 1', 'abcd │ 2', '```'].join('\n'));
});
