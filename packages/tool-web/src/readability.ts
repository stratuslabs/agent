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
  'em', 'font', 'i', 'ins', 'kbd', 'mark', 'nobr', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var', 'wbr',
]);

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

export const extractTitle = (html: string): string | undefined => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() : undefined;
};

export const htmlToText = (html: string): string => {
  // Comments first, then the doctype and any processing instruction. These
  // are removed by name rather than by a blanket `<[^>]*>` sweep, because
  // that sweep reads `5 < 10 and 20 > 15` as a tag and deletes the middle
  // of the sentence — prose about arbitrary subjects is exactly what a
  // fetched page is.
  let text = html.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<[!?][^>]*>/g, ' ');

  for (const element of DROPPED_ELEMENTS) {
    text = text.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}>`, 'gi'), ' ');
    // Unclosed or self-closing forms of the same elements.
    text = text.replace(new RegExp(`<${element}\\b[^>]*/?>`, 'gi'), ' ');
  }
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');

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
  text = text.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g,
    (_tag, name: string) => (INLINE_ELEMENTS.has(name.toLowerCase()) ? '' : ' '),
  );

  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (lines[index - 1] ?? '').length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
