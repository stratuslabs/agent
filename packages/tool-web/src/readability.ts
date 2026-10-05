/**
 * HTML to the text a reader would keep.
 *
 * Not a parser and not trying to be one: an agent asked for a page's
 * content, and what it must not receive is fifty kilobytes of navigation,
 * script, and styling with three sentences somewhere inside. So the
 * elements that never carry the article are dropped whole, block
 * boundaries become newlines, and everything else collapses to text.
 *
 * A real DOM would do better on a hostile page. It would also be a
 * dependency, a parse of untrusted markup, and a second answer to what a
 * page "is" — for a fetcher whose output is fed to a model as prose, this
 * trade is the right one, and the failure mode is a worse extraction
 * rather than an incorrect one.
 */

const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
];

/**
 * Formatting that wraps text which was already adjacent, so removing it
 * joins nothing that was apart. Deliberately a closed set: everything not
 * named here becomes a space, which is the safe direction — see the
 * substitution below.
 */
const INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'font', 'i', 'ins', 'kbd', 'mark', 'nobr', 'ruby',
  's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var', 'wbr',
]);
// `rt` and `rp` are deliberately absent, though they are inline elements.
// They hold a ruby annotation — a pronunciation printed *above* the base
// text, not beside it — so joining them produces a token the page never
// shows: `<ruby>東京<rt>とうきょう</rt></ruby>` reads back as 東京とうきょう,
// fusing a word with its own furigana. Separating loses nothing and fuses
// nothing, which is the safer of the two ways to be wrong here; dropping
// the annotation outright would read better still and would be a guess
// about whether the pronunciation is content.
//
// `sub` and `sup` stay, and are the deliberate contrast: `H<sub>2</sub>O`
// is one token and joining it is the whole point.

/**
 * `q` renders a character of its own — a browser draws quotation marks
 * around it from the stylesheet — so neither answer above is right for it.
 * Removing it fuses `<q>yes</q><q>no</q>` into `yesno`; spacing it detaches
 * the comma in `<q>yes</q>, then left`. Emitting the mark a reader sees
 * avoids both and is the more faithful extraction.
 */
const QUOTE_ELEMENT = 'q';

const BLOCK_ELEMENTS = [
  'p', 'div', 'section', 'article', 'main', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'table', 'tr', 'blockquote', 'pre',
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });

/**
 * Every `open … close` span removed, as `/open[\s\S]*?close/gi` would, in
 * one pass. The regex is quadratic when the closer is missing: every
 * opener scans to the end of the page looking for it, and a page of
 * openers with no closer — `<script` ten thousand times — is a page that
 * holds the daemon's only thread for minutes. Here the closer is looked
 * for once per opener, from where that opener ended, and the first one
 * that has none ends the pass, since no later opener can have one either.
 *
 * Both are searched for in the text itself, case-insensitively, never in a
 * lowercased copy: lowercasing can change a string's length (`İ` becomes
 * two code units), and an index into the copy would then cut the original
 * in the wrong place — a page could pick which of its script survives.
 *
 * `opener` must be global and must only match text that ends in `>`, so
 * that run over the markup `htmlToText` hands it, its own scan always
 * finds an end.
 */
const removeSpans = (text: string, opener: RegExp, closer: RegExp, replacement: string): string => {
  let kept = '';
  let cursor = 0;
  opener.lastIndex = 0;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    closer.lastIndex = opener.lastIndex;
    const close = closer.exec(text);
    if (close === null) {
      break;
    }
    kept += text.slice(cursor, match.index) + replacement;
    cursor = close.index + close[0].length;
    opener.lastIndex = cursor;
  }
  return kept + text.slice(cursor);
};

export const extractTitle = (html: string): string | undefined => {
  // Two searches rather than one lazy regex, for the reason `removeSpans`
  // gives: a page of `<title>` with no `</title>` made the regex rescan the
  // rest of the page from every one of them. The opener is found only
  // before the last `>`, where its own `[^>]*` always ends.
  const open = /<title[^>]*>/i.exec(html.slice(0, html.lastIndexOf('>') + 1));
  if (open === null) {
    return undefined;
  }
  const close = /<\/title>/gi;
  close.lastIndex = open.index + open[0].length;
  const end = close.exec(html);
  const title = end === null ? undefined : html.slice(open.index + open[0].length, end.index);
  return title ? decodeEntities(title).trim() : undefined;
};

export const htmlToText = (html: string): string => {
  // Every pattern below ends in `>`, so nothing after the page's last `>`
  // can be part of one — and that tail is where they turned from linear to
  // worse. A `[^>]*` with no `>` ahead of it scans to the end of the page
  // and fails, from every `<` in turn, and the final sweep's two adjacent
  // quantifiers made each of those failures try every split as well:
  // fourteen kilobytes of `<script` took 104 seconds, on the one thread
  // every agent in the daemon shares. Cut there, every scan finds its `>`.
  // The tail is text, and joins the rest before entities are decoded.
  const end = html.lastIndexOf('>') + 1;
  const tail = html.slice(end);

  // Comments first, then the doctype and any processing instruction. These
  // are removed by name rather than by a blanket `<[^>]*>` sweep, because
  // that sweep reads `5 < 10 and 20 > 15` as a tag and deletes the middle
  // of the sentence — prose about arbitrary subjects is exactly what a
  // fetched page is.
  let text = removeSpans(html.slice(0, end), /<!--/g, /-->/g, '');
  text = text.replace(/<[!?][^>]*>/g, ' ');

  for (const element of DROPPED_ELEMENTS) {
    text = removeSpans(text, new RegExp(`<${element}\\b[^>]*>`, 'gi'), new RegExp(`</${element}>`, 'gi'), ' ');
    // Unclosed or self-closing forms of the same elements.
    text = text.replace(new RegExp(`<${element}\\b[^>]*/?>`, 'gi'), ' ');
  }
  text = removeSpans(text, /<head\b[^>]*>/gi, /<\/head>/gi, ' ');

  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  for (const element of BLOCK_ELEMENTS) {
    text = text.replace(new RegExp(`</?${element}\\b[^>]*>`, 'gi'), '\n');
  }
  // Inline formatting is removed; every other tag becomes a space.
  //
  // A space around formatting rewrites the page — `un<em>expected</em>`
  // becomes `un expected`, a word the page does not contain, and
  // `<strong>kettle</strong>.` becomes `kettle .` — and a model reading the
  // extraction cannot tell either from the real thing.
  //
  // The default runs the other way on purpose. Naming the *separators*
  // instead and deleting the rest looks equivalent and is not: the list is
  // never complete. `td`, `dd`, and `option` are all missing from the block
  // list above, and a custom element is missing from every list anybody
  // will write — so that spelling silently glued `AlphaBeta` out of two
  // table cells. Inline formatting is a closed set that has not grown in
  // twenty years, so listing it is the half that can be finished, and an
  // unrecognised tag falls to a space: a seam that was not needed is a
  // blemish, while one that was is a word nobody wrote.
  //
  // The name is captured whole, punctuation included. Stopping at the first
  // character outside `[a-zA-Z0-9-]` reads `<a:widget>` as the inline `a`
  // and deletes it — and a namespaced element is precisely the unknown tag
  // this default exists for.
  text = text.replace(
    /<\/?([a-zA-Z][^\s/>]*)[^>]*>/g,
    (_tag, rawName: string) => {
      const name = rawName.toLowerCase();
      if (name === QUOTE_ELEMENT) return '"';
      return INLINE_ELEMENTS.has(name) ? '' : ' ';
    },
  );

  text = decodeEntities(text + tail);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (lines[index - 1] ?? '').length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
