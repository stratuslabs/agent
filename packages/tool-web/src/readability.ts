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
 * An inline style's declarations, split where a browser splits them: on a
 * `;` outside a string, outside any bracketed block, and with comments
 * removed.
 * Split on every `;`, `content:";display:none;"` invents a declaration the
 * browser never sees and drops text it shows; so does an escaped `\;`.
 * One pass, character by character; an unterminated string or comment
 * runs to the end, as CSS reads it.
 */
const declarationsOf = (style: string): string[] => {
  const declarations: string[] = [];
  let current = '';
  let quote = '';
  // Closers still owed, innermost last. Any CSS block — `()`, `[]`, `{}`
  // — holds its semicolons, so `--x:{;display:none;}` is one declaration.
  const blocks: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const char = style[index] ?? '';
    if (quote !== '') {
      current += char;
      if (char === '\\') {
        current += style[index + 1] ?? '';
        index += 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    // An escape outside a string too: `color:red\;display:none` is one
    // declaration whose value holds a semicolon, and no `display` at all.
    if (char === '\\') {
      current += char + (style[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '/' && style[index + 1] === '*') {
      const close = style.indexOf('*/', index + 2);
      index = close === -1 ? style.length : close + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      blocks.push(char === '(' ? ')' : char === '[' ? ']' : '}');
    } else if (char === blocks.at(-1)) {
      blocks.pop();
    } else if (char === ';' && blocks.length === 0) {
      declarations.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  declarations.push(current);
  return declarations;
};

/**
 * Whether an inline `style` declares the element away. The last
 * declaration of a property wins unless an earlier one was `!important`,
 * which is the cascade inside one attribute — `display:none;display:block`
 * is a visible element, and dropping it would delete text the page shows.
 */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/** Every keyword `display` takes, single or in its multi-keyword form. */
const DISPLAY_KEYWORDS = new Set([
  'none', 'contents', 'block', 'inline', 'run-in', 'flow', 'flow-root', 'table', 'flex', 'grid', 'ruby',
  'list-item', 'math', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'inline-list-item',
  'table-row-group', 'table-header-group', 'table-footer-group', 'table-row', 'table-cell',
  'table-column-group', 'table-column', 'table-caption', 'ruby-base', 'ruby-text', 'ruby-base-container',
  'ruby-text-container', '-webkit-box', '-webkit-inline-box',
]);

/**
 * Whether a value is one a browser would accept for the property. A
 * declaration it would not is dropped from the cascade rather than
 * overriding the one before it: `display:none;display:bogus` is hidden.
 * A `var()` is accepted, as a browser accepts it until computed time, and
 * reads as not hiding — the direction that keeps text.
 */
const validFor = (property: string, value: string): boolean => {
  if (CSS_WIDE_KEYWORDS.has(value) || value.includes('var(')) return true;
  if (property === 'visibility') return value === 'visible' || value === 'hidden' || value === 'collapse';
  if (property === 'display') return value.split(/\s+/).every((keyword) => DISPLAY_KEYWORDS.has(keyword));
  return true;
};

const styleHides = (style: string): boolean => {
  const declared = new Map<string, { value: string; important: boolean }>();
  for (const declaration of declarationsOf(style)) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const raw = declaration.slice(colon + 1).trim().toLowerCase();
    const important = /!\s*important$/.test(raw);
    const value = important ? raw.replace(/!\s*important$/, '').trim() : raw;
    if (!validFor(property, value)) continue;
    if (declared.get(property)?.important === true && !important) continue;
    declared.set(property, { value, important });
  }
  const visibility = declared.get('visibility')?.value;
  return declared.get('display')?.value === 'none' || visibility === 'hidden' || visibility === 'collapse';
};

/**
 * Whether an element's attributes hide it. They arrive parsed by
 * `scanTags`, never searched for in the tag's text: a search for `hidden`
 * also finds `data-hidden`, `aria-hidden="false"`, and `title="hidden
 * gem"`, and a second parser would disagree with the scanner about where
 * an attribute ends — `<div x=a"hidden>` has no `hidden` attribute.
 */
const attributesHide = (attributes: ReadonlyMap<string, string>): boolean => {
  const style = attributes.get('style');
  return attributes.has('hidden')
    || decodeEntities(attributes.get('aria-hidden') ?? '').trim().toLowerCase() === 'true'
    || (style !== undefined && styleHides(decodeEntities(style)));
};

/**
 * Elements whose content is text up to their own end tag, whatever it
 * looks like: `<textarea></div></textarea>` holds the characters `</div>`,
 * and pairing them as an end tag would close a hidden element early and
 * read out the rest of it.
 */
const RAW_TEXT_ELEMENTS = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript',
]);

/**
 * Start tags that close an open `p` before they open — the tree builder's
 * "close a p element" steps. Without them a hidden paragraph that a `div`
 * has already ended pairs with a literal `</p>` further on, and drops the
 * visible text between: `<p hidden>gone<div>shown</div></p>`.
 */
const CLOSES_PARAGRAPH = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section', 'summary',
  'table', 'ul', 'xmp',
]);

interface ScannedTag {
  start: number;
  end: number;
  closing: boolean;
  name: string;
  /** Lowercased name to raw value; the first of a repeated name, as a browser keeps it. */
  attributes: Map<string, string>;
}

type AttributeState = 'beforeName' | 'name' | 'afterName' | 'beforeValue' | 'unquoted';

/**
 * The page's tags, in one pass, read the way the HTML tokenizer reads them
 * rather than up to the first `>`. Attributes go through the tokenizer's
 * own states, because each shortcut is a page the browser reads one way
 * and this read another: a quote opens a value only where a value starts,
 * so `<div title="1>0" hidden>` is hidden; an `=` or a quote inside an
 * unquoted value is a character of it, so `<div x=a=">` ends at its `>`
 * rather than swallowing the page. A tag still open at the end of the page
 * is dropped, as a browser drops it, and nothing after it is a tag; nor is
 * anything after `<plaintext>`, which has no end tag at all. Every
 * character is visited a bounded number of times, so a hostile page costs
 * its length.
 */
const scanTags = (html: string): ScannedTag[] => {
  const tags: ScannedTag[] = [];
  let index = 0;
  for (;;) {
    const start = html.indexOf('<', index);
    if (start === -1) break;
    let cursor = start + 1;
    const closing = html[cursor] === '/';
    if (closing) cursor += 1;
    if (!/[a-zA-Z]/.test(html[cursor] ?? '')) {
      index = start + 1;
      continue;
    }
    const nameStart = cursor;
    while (cursor < html.length && !/[\s/>]/.test(html[cursor] ?? '')) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();

    const attributes = new Map<string, string>();
    const keep = (attribute: string, value: string): void => {
      if (!attributes.has(attribute)) attributes.set(attribute, value);
    };
    let state: AttributeState = 'beforeName';
    let attribute = '';
    let mark = cursor;
    let end = -1;
    while (cursor < html.length) {
      const char = html[cursor] ?? '';
      if (state === 'beforeValue' && (char === '"' || char === "'")) {
        const close = html.indexOf(char, cursor + 1);
        if (close === -1) {
          cursor = html.length;
          break;
        }
        keep(attribute, html.slice(cursor + 1, close));
        cursor = close + 1;
        state = 'beforeName';
        continue;
      }
      if (char === '>') {
        if (state === 'name') keep(html.slice(mark, cursor).toLowerCase(), '');
        else if (state === 'afterName' || state === 'beforeValue') keep(attribute, '');
        else if (state === 'unquoted') keep(attribute, html.slice(mark, cursor));
        end = cursor;
        break;
      }
      const space = /\s/.test(char);
      if (state === 'beforeName') {
        if (!space && char !== '/') {
          state = 'name';
          mark = cursor;
        }
      } else if (state === 'name') {
        if (space || char === '/' || char === '=') {
          attribute = html.slice(mark, cursor).toLowerCase();
          if (char === '=') {
            state = 'beforeValue';
          } else if (space) {
            state = 'afterName';
          } else {
            keep(attribute, '');
            state = 'beforeName';
          }
        }
      } else if (state === 'afterName') {
        if (char === '=') {
          state = 'beforeValue';
        } else if (char === '/') {
          keep(attribute, '');
          state = 'beforeName';
        } else if (!space) {
          keep(attribute, '');
          state = 'name';
          mark = cursor;
        }
      } else if (state === 'beforeValue') {
        if (!space) {
          state = 'unquoted';
          mark = cursor;
        }
      } else if (space) {
        keep(attribute, html.slice(mark, cursor));
        state = 'beforeName';
      }
      cursor += 1;
    }
    if (end === -1) break;
    tags.push({ start, end: end + 1, closing, name, attributes });
    index = end + 1;
    if (closing) continue;
    if (name === 'plaintext') break;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const endTag = new RegExp(`</${name}[\\s/>]`, 'gi');
      endTag.lastIndex = index;
      const found = endTag.exec(html);
      if (found === null) break;
      index = found.index;
    }
  }
  return tags;
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
  const open = new Map<string, { start: number; hidden: boolean }[]>();
  const dropped: [number, number][] = [];
  for (const tag of scanTags(html)) {
    if (!tag.closing && CLOSES_PARAGRAPH.has(tag.name)) {
      // The open paragraph ends where this tag starts, so a later `</p>`
      // finds none to close; a hidden one is dropped up to here. Before
      // the void check, because `hr` is both.
      for (const paragraph of (open.get('p') ?? []).splice(0)) {
        if (paragraph.hidden) dropped.push([paragraph.start, tag.start]);
      }
    }
    if (VOID_ELEMENTS.has(tag.name)) continue;
    const stack = open.get(tag.name) ?? [];
    open.set(tag.name, stack);
    if (!tag.closing) {
      stack.push({ start: tag.start, hidden: attributesHide(tag.attributes) });
      continue;
    }
    const opener = stack.pop();
    if (opener?.hidden === true) dropped.push([opener.start, tag.end]);
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

/**
 * A numeric reference as a browser reads it: nothing past U+10FFFF, no
 * surrogate, and no NUL is a character, so each becomes U+FFFD. Handed to
 * `String.fromCodePoint`, the first throws — and one `&#1114112;` anywhere
 * on a page, an attribute included, failed the whole fetch.
 */
const codePointText = (code: number): string =>
  code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);

export const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? codePointText(code) : '\uFFFD';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? codePointText(code) : '\uFFFD';
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

  text = decodeEntities(text + tail);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (lines[index - 1] ?? '').length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
