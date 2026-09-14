/**
 * Markdown as a model writes it, in the spelling Slack actually renders.
 *
 * Slack's mrkdwn is not Markdown, and the gap is not cosmetic: `**bold**`
 * reaches a reader as four literal asterisks, and `## Heading` as a line
 * that starts with two hashes. Models write Markdown because that is what
 * every other surface here renders, and a soul should not have to know
 * which channel is carrying it, so the translation happens at the edge that
 * does know.
 *
 * This reads the reply once into tokens and renders from those. It replaced
 * a chain of regexes over the text, which was correct in the end and got
 * there the hard way: nine rounds of review, four of them the same defect —
 * a character disappearing from inside a code span — reached from four
 * unrelated directions. Nothing in a chain of rewrites holds a model of
 * what is code, so every rule had to rediscover it, and each could be wrong
 * on its own; one pair of rules in one commit turned out to disagree about
 * whether Slack pairs backticks across a newline. Deciding that once, here,
 * is the whole point of the shape.
 *
 * Three properties fall out of it rather than being enforced by a rule
 * each, and they are the ones every one of those defects violated:
 *
 * - **A code run is one token.** Nothing below can see inside it, rewrite
 *   part of it, or cut a line out of it — the newlines in a fence are not
 *   line breaks in this stream, so a `#` on a line of somebody's shell
 *   script is not a heading to be found.
 * - **A delimiter is matched to its partner, not to a pattern.** An
 *   emphasis run pairs across whatever sits between it and its closer, code
 *   included, so ``**the `fs.read` tool**`` is one bold run rather than two
 *   halves that never meet.
 * - **A wrapper is emitted only when its own character is not already loose
 *   in what it wraps.** Slack has one delimiter per style and no way to
 *   nest it, so `*a *b* c*` renders as neither bold nor text. One rule
 *   covers the heading that already contains bold, the bold run with a
 *   stray asterisk in it, and every pairing of the two.
 *
 * Only what differs is touched. Lists, block quotes, and inline code
 * already mean in mrkdwn what they mean in Markdown; rewriting them would
 * add ways to be wrong and fix nothing.
 */

/**
 * The delimiters worth reading, and the shortest run of each that means
 * anything here.
 *
 * Two of them start at two. A single `_` is already italic to Slack, and a
 * single `~` is not a delimiter to either dialect, so a run of one is text
 * in both cases — converting it could only change what a reader sees. A
 * single `*` is the one that has to move: Markdown reads it as italic and
 * Slack as bold, so leaving it alone is the one thing that is certainly
 * wrong.
 */
const DELIMITERS: Readonly<Record<string, number>> = { '*': 1, _: 2, '~': 2 };

/** Where a link's two halves begin and end. Nothing else reads brackets. */
const BRACKETS = new Set(['[', ']', '(', ')']);

/**
 * A destination Slack will make a link of: a scheme it follows, and no
 * whitespace or parenthesis to end it early. A bare `[1](2)` in prose is
 * not a link anybody meant to follow.
 */
const LINK_DESTINATION = /^(?:https?:\/\/|mailto:)[^\s()]+$/;

/**
 * A heading's opening syntax: up to three spaces, its hashes, then air.
 *
 * What follows the air is deliberately not this pattern's business. The
 * text token holding the hashes ends wherever the first marker or snippet
 * begins, so `## **Title**` has nothing after the space to look at, and a
 * pattern that demanded some would read that line as prose. Whether a
 * heading has any content is asked later, of the rendered line, where the
 * answer does not depend on which token the content landed in.
 */
const HEADING_OPENER = /^ {0,3}#{1,6}[ \t]+/;

/**
 * A heading's closing hashes, which Markdown allows and mrkdwn has no use
 * for. They only count as syntax when spaced off the text — without that,
 * `# C#` is a heading whose name loses its last character.
 */
const HEADING_CLOSER = /(?:[ \t]+#+)?\s*$/;

type Token =
  | { readonly kind: 'text'; readonly text: string }
  /** A backtick run and everything it holds, verbatim. `closed` is false for one still open at the end of the reply. */
  | { readonly kind: 'code'; readonly text: string; readonly closed: boolean }
  | { readonly kind: 'run'; readonly char: string; readonly length: number; readonly opens: boolean; readonly closes: boolean }
  | { readonly kind: 'punct'; readonly text: string }
  | { readonly kind: 'break' };

/** The characters a token was written with, whatever it came to mean. */
const sourceOf = (token: Token): string => {
  switch (token.kind) {
    case 'run':
      return token.char.repeat(token.length);
    case 'break':
      return '\n';
    default:
      return token.text;
  }
};

/**
 * Where the run of exactly `length` backticks that closes an open one
 * begins, or -1. Exactly: a longer run is not a closer, which is the whole
 * point of writing a span as ``code with a ` in it`` and a fence as ````
 * when the block itself contains ```.
 */
const closingBacktickRun = (text: string, from: number, length: number): number => {
  const run = '`'.repeat(length);
  for (let at = text.indexOf(run, from); at !== -1; at = text.indexOf(run, at + 1)) {
    if (text[at - 1] !== '`' && text[at + length] !== '`') {
      return at;
    }
  }
  return -1;
};

/**
 * The reply as tokens.
 *
 * A code run may close on a later line and is one token the whole way.
 * That looks wasteful — two stray backticks paragraphs apart become one
 * long "span" whose contents go unconverted — and it was once changed to
 * end a span at its line for exactly that reason. That was wrong, and the
 * reason is the rule this file answers to: what Slack does with the message
 * decides, not what Markdown says. Slack pairs those backticks too, so the
 * text between them is what it renders as code, and rewriting a `**bold**`
 * in there would alter the contents of somebody's snippet. Prose left
 * unconverted is a cosmetic loss; code whose contents change is not, so the
 * doubt resolves toward protecting more.
 *
 * A run of three or more with no closer takes the rest of the reply, which
 * is what a fence still being streamed looks like on every edit before its
 * last. One or two unmatched backticks are the opposite case — text, since
 * "use the ` character" must not swallow what follows.
 */
const scan = (text: string): Token[] => {
  const tokens: Token[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain.length > 0) {
      tokens.push({ kind: 'text', text: plain });
      plain = '';
    }
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';

    if (char === '`') {
      let length = 1;
      while (text[at + length] === '`') {
        length += 1;
      }
      const close = closingBacktickRun(text, at + length, length);
      if (close === -1 && length < 3) {
        plain += '`'.repeat(length);
        at += length;
        continue;
      }
      flush();
      if (close === -1) {
        tokens.push({ kind: 'code', text: text.slice(at), closed: false });
        return tokens;
      }
      tokens.push({ kind: 'code', text: text.slice(at, close + length), closed: true });
      at = close + length;
      continue;
    }

    if (char === '\n') {
      flush();
      tokens.push({ kind: 'break' });
      at += 1;
      continue;
    }

    const minimum = DELIMITERS[char];
    if (minimum !== undefined) {
      let length = 1;
      while (text[at + length] === char) {
        length += 1;
      }
      const before = text[at - 1];
      const after = text[at + length];
      // A delimiter has to hug what it marks: `3 * 4 * 5` is arithmetic.
      // An underscore has to stand clear of a word as well, so that
      // `snake_case_name` is a name — which is why the two are separate
      // questions rather than one, since `a**b**c` is bold in Markdown and
      // reads that way in Slack too.
      const tight = length >= minimum;
      const inWord = (side: string | undefined): boolean => side !== undefined && /[\p{L}\p{N}]/u.test(side);
      flush();
      tokens.push({
        kind: 'run',
        char,
        length,
        opens: tight && after !== undefined && !/\s/.test(after) && (char !== '_' || !inWord(before)),
        closes: tight && before !== undefined && !/\s/.test(before) && (char !== '_' || !inWord(after)),
      });
      at += length;
      continue;
    }

    if (BRACKETS.has(char)) {
      flush();
      tokens.push({ kind: 'punct', text: char });
      at += 1;
      continue;
    }

    plain += char;
    at += 1;
  }
  flush();
  return tokens;
};

interface Pair {
  readonly open: number;
  readonly close: number;
  /** How many of each run's characters the pair consumed: 1 italic, 2 bold, 3 both. */
  readonly use: number;
}

/**
 * Each closing run matched to the nearest opener still standing.
 *
 * A break clears the openers because emphasis does not cross a line in
 * either dialect — one stray marker at the end of a paragraph must not
 * italicize the next one. Nothing else clears them, and code in particular
 * does not: a run reaches its partner across a snippet, which is the
 * difference between ``**the `fs.read` tool**`` arriving as bold and
 * arriving as four asterisks.
 *
 * `inert` holds the characters of a link's destination, which are no more
 * markup than a snippet's are. A URL is written to be followed, and a `*`
 * in a path is part of the path: left pairable, the one in
 * `**[files](https://host/files/*.txt)**` closed the bold run that opened
 * before the link, and the address arrived as `/files/_.txt` — a URL
 * altered, which is the same defect as a snippet altered and was missed in
 * the same place, by not asking whether anything else in a reply is as
 * literal as code.
 */
const pairEmphasis = (tokens: readonly Token[], inert: ReadonlySet<number>): Map<number, Pair> => {
  const pairs = new Map<number, Pair>();
  let openers: number[] = [];

  tokens.forEach((token, index) => {
    if (token.kind === 'break') {
      openers = [];
      return;
    }
    if (token.kind !== 'run' || inert.has(index)) {
      return;
    }
    if (token.closes) {
      for (let slot = openers.length - 1; slot >= 0; slot -= 1) {
        const candidate = openers[slot];
        const opener = candidate === undefined ? undefined : tokens[candidate];
        if (candidate !== undefined && opener?.kind === 'run' && opener.char === token.char) {
          const pair: Pair = { open: candidate, close: index, use: Math.min(opener.length, token.length, 3) };
          pairs.set(candidate, pair);
          pairs.set(index, pair);
          // Everything opened inside this pair and never closed is text.
          openers = openers.slice(0, slot);
          return;
        }
      }
    }
    if (token.opens) {
      openers.push(index);
    }
  });
  return pairs;
};

interface Link {
  readonly label: readonly [number, number];
  readonly destination: string;
  /** Every token the link's own syntax accounts for, so rendering skips them. */
  readonly through: number;
}

/**
 * `[label](destination)`, the one construct Slack spells backwards.
 *
 * The destination is read as the characters it was written with, so a
 * snippet inside one is judged by what it says: `https://host/`a b`` has a
 * space in it and is not a destination, while `https://host/`b`` is. The
 * old rewrite could not see either — it matched a masked stand-in and had
 * to be told separately whether the thing behind it held whitespace.
 *
 * `<url|label>` is one line's worth of markup, so a link is one line. A
 * break between the brackets already ends the search, and a snippet with a
 * newline inside it has to as well: the newline is hidden in a single
 * token there, which is exactly what makes it easy to miss.
 */
const findLinks = (tokens: readonly Token[]): Map<number, Link> => {
  const links = new Map<number, Link>();
  let opener = -1;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token?.kind === 'break') {
      opener = -1;
      continue;
    }
    if (token?.kind !== 'punct') {
      continue;
    }
    if (token.text === '[') {
      opener = at;
      continue;
    }
    const after = tokens[at + 1];
    if (token.text !== ']' || opener === -1 || after?.kind !== 'punct' || after.text !== '(') {
      continue;
    }
    let close = -1;
    for (let scan = at + 2; scan < tokens.length; scan += 1) {
      const inner = tokens[scan];
      if (inner?.kind === 'break') {
        break;
      }
      if (inner?.kind === 'punct' && inner.text === ')') {
        close = scan;
        break;
      }
    }
    if (close === -1) {
      continue;
    }
    const spans = tokens.slice(opener + 1, close);
    if (spans.some((inner) => inner.kind === 'code' && inner.text.includes('\n'))) {
      continue;
    }
    const destination = tokens.slice(at + 2, close).map(sourceOf).join('');
    if (!LINK_DESTINATION.test(destination)) {
      continue;
    }
    links.set(opener, { label: [opener + 1, at], destination, through: close });
    opener = -1;
    at = close;
  }
  return links;
};

/**
 * A rendered fragment, and the three things a wrapper around it has to ask.
 *
 * `loose` is the set of delimiter characters standing in this text outside
 * any code — the ones Slack would try to pair. A wrapper whose own
 * character is in there cannot be emitted: Slack has one delimiter per
 * style and no way to nest it, so `*a *b* c*` renders as neither bold nor
 * plain text. It counts wrappers this pass emitted as well as markers it
 * left alone, which is why a heading that already contains bold is not
 * bolded again.
 */
interface Rendered {
  readonly text: string;
  readonly loose: ReadonlySet<string>;
  /** Holds a code run with no closer: nothing after it is prose to Slack. */
  readonly unclosed: boolean;
  /** Holds a code run with a newline in it, so this fragment is not one line. */
  readonly wraps: boolean;
}

const EMPTY: Rendered = { text: '', loose: new Set(), unclosed: false, wraps: false };

const joined = (parts: readonly Rendered[]): Rendered => ({
  text: parts.map((part) => part.text).join(''),
  loose: new Set(parts.flatMap((part) => [...part.loose])),
  unclosed: parts.some((part) => part.unclosed),
  wraps: parts.some((part) => part.wraps),
});

const literal = (text: string): Rendered => ({
  text,
  loose: new Set([...text].filter((char) => char in DELIMITERS)),
  unclosed: false,
  wraps: false,
});

/** What each style is spelled with once it is Slack's. */
const wrapperFor = (char: string, use: number): readonly [string, string] => {
  if (char === '~') {
    return ['~', '~'];
  }
  if (char === '_' || use === 2) {
    return ['*', '*'];
  }
  return use >= 3 ? ['*_', '_*'] : ['_', '_'];
};

interface Context {
  readonly tokens: readonly Token[];
  readonly pairs: ReadonlyMap<number, Pair>;
  readonly links: ReadonlyMap<number, Link>;
  /** Text to use in place of a token's own — how a heading sheds its hashes. */
  readonly edits: ReadonlyMap<number, string>;
}

const renderRange = (context: Context, from: number, to: number): Rendered => {
  const parts: Rendered[] = [];
  let at = from;

  while (at < to) {
    const token = context.tokens[at];
    if (token === undefined) {
      break;
    }

    const link = context.links.get(at);
    if (link !== undefined && link.through < to) {
      const label = renderRange(context, link.label[0], link.label[1]);
      parts.push({
        text: `<${link.destination}|${label.text}>`,
        loose: new Set([...label.loose, ...[...link.destination].filter((char) => char in DELIMITERS)]),
        unclosed: label.unclosed,
        wraps: label.wraps,
      });
      at = link.through + 1;
      continue;
    }

    if (token.kind === 'run') {
      const pair = context.pairs.get(at);
      const closer = pair === undefined ? undefined : context.tokens[pair.close];
      if (pair?.open === at && pair.close < to && closer?.kind === 'run') {
        const inner = renderRange(context, at + 1, pair.close);
        const [open, close] = wrapperFor(token.char, pair.use);
        // The characters of each run the pair did not consume are text, and
        // stay on the outside of it where they were written.
        const before = token.char.repeat(token.length - pair.use);
        const after = token.char.repeat(closer.length - pair.use);
        // Every character the wrapper is spelled with, not just its first:
        // `***both***` is written `*_…_*`, and an underscore already loose
        // inside it would break the italic half exactly as a stray asterisk
        // breaks the bold one.
        const nests = [...open].some((char) => inner.loose.has(char)) || inner.unclosed;
        parts.push(nests
          ? joined([literal(sourceOf(token)), inner, literal(sourceOf(closer))])
          : joined([literal(before), literal(open), inner, literal(close), literal(after)]));
        at = pair.close + 1;
        continue;
      }
      parts.push(literal(sourceOf(token)));
      at += 1;
      continue;
    }

    if (token.kind === 'code') {
      parts.push({
        text: token.text,
        loose: new Set(),
        unclosed: !token.closed,
        wraps: token.text.includes('\n'),
      });
      at += 1;
      continue;
    }

    parts.push(literal(context.edits.get(at) ?? sourceOf(token)));
    at += 1;
  }

  return parts.length > 0 ? joined(parts) : EMPTY;
};

/**
 * One line, as a heading if it is one.
 *
 * A line here is what a reader sees, which is why the hashes inside a fence
 * were never a question: the fence is a single token and its newlines are
 * not breaks, so those lines do not exist to be mistaken for headings.
 *
 * The syntax is shed from the text tokens that actually hold it — the
 * opening hashes from the first, the closing ones from the last. When the
 * line ends inside a code run there is no last text token to take them
 * from, and nothing is taken: the `#` at the end of `` # show `value # ``
 * belongs to whoever wrote the snippet, and so does the whitespace beside
 * it. That is a property of where the characters are rather than a rule
 * about which of them are safe, which is what the rewrite it replaced kept
 * getting wrong — it measured the strip with a pattern that knew `[ \t]`
 * while the trim it guarded took a no-break space too.
 *
 * Bolding is the wrapper rule and two refusals of its own: a line that runs
 * past its own end, through a snippet with a newline in it, is no longer
 * the one line a heading is; and a line holding a fence nobody closed has
 * no prose left at its end to put the closing marker in.
 */
const renderLine = (context: Context, from: number, to: number): string => {
  const first = context.tokens[from];
  if (first?.kind !== 'text') {
    return renderRange(context, from, to).text;
  }
  const opener = HEADING_OPENER.exec(first.text);
  if (opener === null) {
    return renderRange(context, from, to).text;
  }

  const edits = new Map(context.edits);
  edits.set(from, first.text.slice(opener[0].length));
  const last = to - 1;
  const tail = last > from ? context.tokens[last] : undefined;
  if (last === from) {
    edits.set(from, (edits.get(from) ?? '').replace(HEADING_CLOSER, ''));
  } else if (tail?.kind === 'text') {
    edits.set(last, tail.text.replace(HEADING_CLOSER, ''));
  }

  const heading = renderRange({ ...context, edits }, from, to);
  if (heading.text.length === 0) {
    return renderRange(context, from, to).text;
  }
  const plain = !heading.loose.has('*') && !heading.unclosed && !heading.wraps;
  return plain ? `*${heading.text}*` : heading.text;
};

export const toSlackMrkdwn = (text: string): string => {
  const tokens = scan(text);
  // Links are found before emphasis is paired, because what they turn out
  // to cover decides what is left for a delimiter to pair with: the
  // characters of a destination are the address, not markup.
  const links = findLinks(tokens);
  const inert = new Set<number>();
  for (const link of links.values()) {
    for (let at = link.label[1] + 2; at < link.through; at += 1) {
      inert.add(at);
    }
  }
  const context: Context = { tokens, pairs: pairEmphasis(tokens, inert), links, edits: new Map() };

  const lines: string[] = [];
  let start = 0;
  for (let at = 0; at <= tokens.length; at += 1) {
    if (at === tokens.length || tokens[at]?.kind === 'break') {
      lines.push(renderLine(context, start, at));
      start = at + 1;
    }
  }
  return lines.join('\n');
};
