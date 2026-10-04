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
 * Elements with no content and no end tag. Only an element that can hold
 * text can hide any, and pairing one of these with a later end tag of the
 * same name would drop everything in between.
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr',
]);

/**
 * Whether an inline `style` declares the element away. The last
 * declaration of a property wins unless an earlier one was `!important`,
 * which is the cascade inside one attribute — `display:none;display:block`
 * is a visible element, and dropping it would delete text the page shows.
 */
const styleHides = (style: string): boolean => {
  const declared = new Map<string, { value: string; important: boolean }>();
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const raw = declaration.slice(colon + 1).trim().toLowerCase();
    const important = /!\s*important$/.test(raw);
    const value = important ? raw.replace(/!\s*important$/, '').trim() : raw;
    if (declared.get(property)?.important === true && !important) continue;
    declared.set(property, { value, important });
  }
  return declared.get('display')?.value === 'none' || declared.get('visibility')?.value === 'hidden';
};

/**
 * Attributes are read one by one rather than searched for, because a
 * search for `hidden` also finds `data-hidden`, `aria-hidden="false"`, and
 * `title="hidden gem"`. The first of a repeated attribute is the one a
 * browser keeps.
 */
const attributesHide = (source: string): boolean => {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
    }
  }
  const style = attributes.get('style');
  return attributes.has('hidden')
    || attributes.get('aria-hidden')?.trim().toLowerCase() === 'true'
    || (style !== undefined && styleHides(style));
};

/**
 * Drops the elements a browser would not show: the `hidden` attribute, an
 * inline `display: none` or `visibility: hidden`, and `aria-hidden="true"`.
 * The last is still drawn on screen; it is here because it is what the
 * page withholds from a reader who cannot see it, and a model reading this
 * extraction is that reader.
 *
 * This is the extraction matching what a browser renders, not a
 * prompt-injection filter, and must not be read as one. Text hidden by a
 * stylesheet or a class is kept, because without a browser there is no
 * cascade to evaluate, and neither are opacity, a zero font size, or
 * off-screen positioning chased: a filter that mostly works is worse than
 * the `external` label that always does, because it invites trust
 * (docs/roadmap/30-provenance.md). `raw: true` exists for a page this gets
 * wrong, including the one case where it drops text a browser shows: a
 * descendant of a `visibility: hidden` element that sets `visible` again.
 *
 * Each element is paired with its own end tag by a stack per tag name, so
 * `<div hidden><div>a</div>b</div>` drops through the outer end tag rather
 * than the first `</div>` — one pass, linear in the page, where a search
 * for each element's end would rescan the rest of the page for every one.
 *
 * An element left unclosed keeps its text. `p` and `li` close implicitly,
 * so `<li hidden>a<li>b` is ordinary markup, and dropping to the end of the
 * document would erase the article behind one sloppy tag. Keeping is what
 * this extractor did before it read visibility at all, which is the right
 * place for a rendering approximation to fall back to.
 */
const dropHiddenElements = (html: string): string => {
  // Tags are only read up to the last `>`: past it, every `<` would be a
  // tag that never closes, and each would scan the rest of the page to
  // find that out.
  const scanned = html.slice(0, html.lastIndexOf('>') + 1);
  const open = new Map<string, { start: number; hidden: boolean }[]>();
  const dropped: [number, number][] = [];
  for (const match of scanned.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
    const [tag, slash, rawName = '', attributes = ''] = match;
    const name = rawName.toLowerCase();
    if (VOID_ELEMENTS.has(name)) continue;
    const stack = open.get(name) ?? [];
    open.set(name, stack);
    if (slash === '') {
      stack.push({ start: match.index, hidden: attributesHide(attributes) });
      continue;
    }
    const opener = stack.pop();
    if (opener?.hidden === true) dropped.push([opener.start, match.index + tag.length]);
  }
  if (dropped.length === 0) return html;

  // Pairs of different names can nest or cross, so they are merged by start.
  dropped.sort((a, b) => a[0] - b[0]);
  let text = '';
  let cursor = 0;
  for (const [start, end] of dropped) {
    if (start >= cursor) text += `${html.slice(cursor, start)} `;
    cursor = Math.max(cursor, end);
  }
  return text + html.slice(cursor);
};

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
  // After the dropped elements, so a `</div>` inside a script's string
  // cannot close a hidden element early.
  text = dropHiddenElements(text);

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

  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (lines[index - 1] ?? '').length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
