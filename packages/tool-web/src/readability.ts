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
      } else if (char === '\n' || char === '\r' || char === '\f') {
        // An unescaped newline ends a string as a bad one, and the
        // declarations after it are read again: in `x:'\n;display:block`
        // the `display` is real.
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
/**
 * Whitespace as HTML and CSS both define it: five ASCII characters. Not
 * JavaScript's `\s` or `trim()`, which also take U+00A0 and the rest of
 * Unicode's spaces — `x=a\u00A0hidden` is one unquoted value to a
 * browser, and `none\u00A0` is not the keyword `none`.
 */
const isAsciiWhitespace = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';
const trimAscii = (value: string): string => value.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');

/** `var(` as a function of its own, not the tail of `xvar(`. */
const CSS_VAR_FUNCTION = /(?:^|[^a-z0-9_\-\u0080-\uffff\\])var\(/;

const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/** `display` values that stand alone. */
const DISPLAY_SINGLE = new Set([
  'none', 'contents', 'block', 'inline', 'run-in', 'flow', 'flow-root', 'table', 'flex', 'grid', 'ruby',
  'list-item', 'math', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
  'table-row-group', 'table-header-group', 'table-footer-group', 'table-row', 'table-cell',
  'table-column-group', 'table-column', 'table-caption', 'ruby-base', 'ruby-text', 'ruby-base-container',
  'ruby-text-container', '-webkit-box', '-webkit-inline-box',
]);
const DISPLAY_OUTSIDE = new Set(['block', 'inline', 'run-in']);
const DISPLAY_INSIDE = new Set(['flow', 'flow-root', 'table', 'flex', 'grid', 'ruby', 'math']);

/**
 * The words of a CSS value, escapes decoded and lowercased, split on
 * unescaped ASCII whitespace — the identifiers a browser compares, not the
 * characters written. `n\6f ne` is `none`; `none\20` is one word,
 * `none ` with a space in it, and not `none` at all. A hex escape takes up
 * to six digits and one whitespace after them; anything past U+10FFFF, a
 * surrogate, or NUL reads as U+FFFD, as for HTML.
 */
const cssWords = (value: string): string[] => {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (char === '\\') {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(index + 1, index + 7))?.[0];
      if (hex !== undefined) {
        word += codePointText(Number.parseInt(hex, 16));
        index += hex.length;
        if (isAsciiWhitespace(value[index + 1] ?? '')) index += 1;
      } else {
        word += value[index + 1] ?? '\uFFFD';
        index += 1;
      }
      inWord = true;
      continue;
    }
    if (isAsciiWhitespace(char)) {
      if (inWord) words.push(word.toLowerCase());
      word = '';
      inWord = false;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (inWord) words.push(word.toLowerCase());
  return words;
};

/**
 * Whether `display` accepts these words: one keyword that stands alone,
 * an outside and an inside keyword in either order, or `list-item` with at
 * most one outside keyword and one of `flow` and `flow-root`. A run of
 * valid keywords is not a valid value — `block none` is rejected, and the
 * `none` before it stands.
 */
const validDisplay = (words: readonly string[]): boolean => {
  if (words.length === 1) return DISPLAY_SINGLE.has(words[0] ?? '');
  if (new Set(words).size !== words.length) return false;
  const outside = words.filter((word) => DISPLAY_OUTSIDE.has(word)).length;
  if (words.includes('list-item')) {
    const flows = words.filter((word) => word === 'flow' || word === 'flow-root').length;
    return words.length <= 3 && outside <= 1 && flows <= 1 && outside + flows + 1 === words.length;
  }
  const inside = words.filter((word) => DISPLAY_INSIDE.has(word)).length;
  return words.length === 2 && outside === 1 && inside === 1;
};

/**
 * Whether a value is one a browser would accept for the property. A
 * declaration it would not is dropped from the cascade rather than
 * overriding the one before it: `display:none;display:bogus` is hidden.
 * A `var()` is accepted, as a browser accepts it until computed time, and
 * reads as not hiding — the direction that keeps text.
 */
const validFor = (property: string, raw: string, words: readonly string[]): boolean => {
  if (CSS_VAR_FUNCTION.test(raw)) return true;
  if (words.length === 1 && CSS_WIDE_KEYWORDS.has(words[0] ?? '')) return true;
  if (property === 'visibility') return words.length === 1 && ['visible', 'hidden', 'collapse'].includes(words[0] ?? '');
  if (property === 'display') return validDisplay(words);
  return true;
};

/** The first `:` that is not escaped — `dis\:play` is one name. */
const colonOf = (declaration: string): number => {
  for (let index = 0; index < declaration.length; index += 1) {
    if (declaration[index] === '\\') index += 1;
    else if (declaration[index] === ':') return index;
  }
  return -1;
};

const styleHides = (style: string): boolean => {
  const declared = new Map<string, { words: string[]; important: boolean }>();
  for (const declaration of declarationsOf(style)) {
    const colon = colonOf(declaration);
    if (colon === -1) continue;
    const name = cssWords(declaration.slice(0, colon));
    if (name.length !== 1) continue;
    const property = name[0] ?? '';
    const raw = trimAscii(declaration.slice(colon + 1)).toLowerCase();
    // `!important` read as CSS reads it: the last `!` and the words after
    // it, escapes decoded — `!\69mportant` is still `!important`.
    const bang = raw.lastIndexOf('!');
    const important = bang !== -1 && cssWords(raw.slice(bang + 1)).join(' ') === 'important';
    const value = important ? trimAscii(raw.slice(0, bang)) : raw;
    const words = cssWords(value);
    if (!validFor(property, value, words)) continue;
    if (declared.get(property)?.important === true && !important) continue;
    declared.set(property, { words, important });
  }
  const only = (property: string): string | undefined => {
    const words = declared.get(property)?.words;
    return words?.length === 1 ? words[0] : undefined;
  };
  const visibility = only('visibility');
  return only('display') === 'none' || visibility === 'hidden' || visibility === 'collapse';
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
    || trimAscii(decodeEntities(attributes.get('aria-hidden') ?? '')).toLowerCase() === 'true'
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

/** Elements whose end tag removes only themselves: the tree builder's adoption agency, which leaves blocks open. */
const FORMATTING_ELEMENTS = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);

/** Where a search for an open element stops: the tree builder's default scope. */
const SCOPE_BOUNDARIES = ['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template'];

/** Start tags that end an open sibling of their own kind, and the list element the search stops at. */
const IMPLIED_SIBLING_ENDS: Readonly<Record<string, { closes: string[]; stopAt: string[] }>> = {
  li: { closes: ['li'], stopAt: [...SCOPE_BOUNDARIES, 'ul', 'ol', 'menu'] },
  dd: { closes: ['dd', 'dt'], stopAt: [...SCOPE_BOUNDARIES, 'dl'] },
  dt: { closes: ['dd', 'dt'], stopAt: [...SCOPE_BOUNDARIES, 'dl'] },
};

/**
 * How deep the stack goes. Chromium's parser stops nesting at 512 too,
 * and the bound is what keeps this pass linear: every end tag searches the
 * stack, and an unbounded one let 80,000 nested `<div>`s and as many stray
 * end tags cost their product. An element past it is not tracked, so its
 * text is kept — the direction this pass falls back to throughout.
 */
const MAX_OPEN_ELEMENTS = 512;

interface OpenElement {
  id: number;
  name: string;
  hidden: boolean;
  /** Ids of the hidden elements on this element's DOM ancestry, itself included. */
  governing: readonly number[];
}

/** Elements whose own content model is table structure, where other content is placed before the table. */
const TABLE_CONTEXT = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);

/** Start tags a table context holds itself; any other is placed before the table. */
const TABLE_CONTENT = new Set([
  'caption', 'colgroup', 'col', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'script', 'style', 'template', 'form',
  'input', 'table',
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
    while (cursor < html.length && !isAsciiWhitespace(html[cursor] ?? '') && html[cursor] !== '/' && html[cursor] !== '>') {
      cursor += 1;
    }
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
      const space = isAsciiWhitespace(char);
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
      const endTag = new RegExp(`</${name}[ \\t\\n\\f\\r/>]`, 'gi');
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
 * Each element is paired with its own end tag on one stack of open
 * elements, so `<div hidden><div>a</div>b</div>` drops through the outer
 * end tag rather than the first `</div>` — one pass, linear in the page,
 * where a search for each element's end would rescan the rest of the page
 * for every one.
 *
 * The implied ends that keep ordinary markup apart are modelled — `p`
 * before a block, `li` at the next `li`, `dd`/`dt` at the next of either —
 * so `<li hidden>a<li>b` hides `a` and shows `b`. An element still open at
 * the end of the page keeps its text: a closing rule this pass does not
 * model must not erase the article behind it, and keeping is what this
 * extractor did before it read visibility at all.
 */
const dropHiddenElements = (html: string): string => {
  // One stack of open elements, as the tree builder keeps, rather than one
  // per tag name: an end tag closes everything opened inside the element
  // it names, so in `<div><span hidden>gone</div>shown</span>` the span
  // ends at `</div>` and `shown` is visible.
  //
  // And text is judged where the tree builder puts it, not where it sits
  // in the source. Each run between tags belongs to the element that would
  // receive it — usually the top of the stack, but text or a tag a table
  // cannot hold is placed before the table, so in `<table hidden>visible`
  // the text is the table's parent's, and shown. A run is dropped when a
  // hidden element on its ancestry was closed; one still open at the end
  // of the page confirms nothing, and its text is kept.
  const stack: OpenElement[] = [];
  const confirmed = new Set<number>();
  const segments: { start: number; end: number; governing: readonly number[] }[] = [];
  let nextId = 0;
  const nearest = (names: readonly string[], stopAt: readonly string[]): number => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const name = stack[index]?.name ?? '';
      if (names.includes(name)) return index;
      if (stopAt.includes(name)) return -1;
    }
    return -1;
  };
  const closeFrom = (index: number): void => {
    for (const element of stack.splice(index)) {
      if (element.hidden) confirmed.add(element.id);
    }
  };
  /** Whose ancestry new content takes: the top, or a table's parent for what a table cannot hold. */
  const parentFor = (fostered: boolean): readonly number[] => {
    const top = stack.at(-1);
    if (top === undefined) return [];
    if (!fostered || !TABLE_CONTEXT.has(top.name)) return top.governing;
    const table = nearest(['table'], []);
    return table > 0 ? (stack[table - 1]?.governing ?? []) : [];
  };

  let cursor = 0;
  for (const tag of scanTags(html)) {
    if (tag.start > cursor) {
      const run = html.slice(cursor, tag.start);
      segments.push({ start: cursor, end: tag.start, governing: parentFor(/[^ \t\n\f\r]/.test(run)) });
    }
    cursor = tag.end;
    if (!tag.closing) {
      // Before the void check, because `hr` both closes a paragraph and
      // holds nothing.
      if (CLOSES_PARAGRAPH.has(tag.name)) {
        const paragraph = nearest(['p'], [...SCOPE_BOUNDARIES, 'button']);
        if (paragraph !== -1) closeFrom(paragraph);
      }
      const sibling = IMPLIED_SIBLING_ENDS[tag.name];
      if (sibling !== undefined) {
        const open = nearest(sibling.closes, sibling.stopAt);
        if (open !== -1) closeFrom(open);
      }
      const parent = parentFor(!TABLE_CONTENT.has(tag.name));
      const hidden = attributesHide(tag.attributes);
      const id = nextId;
      nextId += 1;
      // A void element holds no text, so there is nothing of it to hide;
      // its tag is left to the passes after this one, as any other is.
      if (VOID_ELEMENTS.has(tag.name)) {
        segments.push({ start: tag.start, end: tag.end, governing: parent });
        continue;
      }
      const governing = hidden ? [...parent, id] : parent;
      segments.push({ start: tag.start, end: tag.end, governing });
      if (stack.length < MAX_OPEN_ELEMENTS) stack.push({ id, name: tag.name, hidden, governing });
      continue;
    }
    const index = nearest([tag.name], SCOPE_BOUNDARIES.filter((name) => name !== tag.name));
    // An end tag with nothing of its name open is a stray, and closes nothing.
    if (index === -1) {
      segments.push({ start: tag.start, end: tag.end, governing: parentFor(false) });
      continue;
    }
    const element = stack[index];
    segments.push({ start: tag.start, end: tag.end, governing: element?.governing ?? [] });
    if (FORMATTING_ELEMENTS.has(tag.name)) {
      stack.splice(index, 1);
    } else {
      closeFrom(index + 1);
      stack.splice(index, 1);
    }
    if (element?.hidden === true) confirmed.add(element.id);
  }
  if (cursor < html.length) segments.push({ start: cursor, end: html.length, governing: parentFor(false) });
  if (confirmed.size === 0) return html;

  // A dropped stretch, however many segments, becomes one space.
  let text = '';
  let dropping = false;
  for (const segment of segments) {
    if (segment.governing.some((id) => confirmed.has(id))) {
      if (!dropping) text += ' ';
      dropping = true;
    } else {
      text += html.slice(segment.start, segment.end);
      dropping = false;
    }
  }
  return text;
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

/**
 * The named references this extractor decodes — a small part of HTML's
 * table, and case-sensitive as that table is (`&Colon;` is `∷`, not `:`).
 * The punctuation names are here because a browser decodes an attribute
 * before CSS reads it, so `display&colon;none` hides; one not listed stays
 * as written.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  colon: ':',
  semi: ';',
  excl: '!',
  num: '#',
  period: '.',
  comma: ',',
  sol: '/',
  bsol: '\\',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrace: '{',
  rbrace: '}',
  lowbar: '_',
  hyphen: '\u2010',
  dash: '\u2010',
  plus: '+',
  equals: '=',
  ast: '*',
  commat: '@',
  verbar: '|',
  vert: '|',
  grave: '`',
  Hat: '^',
  dollar: '$',
  percnt: '%',
  Tab: '\t',
  NewLine: '\n',
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

/**
 * Numeric references decode with or without their semicolon, as a browser
 * decodes them — `display&#58none` hides — and a named one only with it.
 */
export const decodeEntities = (value: string): string =>
  value.replace(/&#[xX]([0-9a-fA-F]+);?|&#([0-9]+);?|&([a-zA-Z][a-zA-Z0-9]*);/g, (match, hex?: string, decimal?: string, name?: string) => {
    if (hex !== undefined || decimal !== undefined) {
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal ?? '', 10);
      return Number.isFinite(code) ? codePointText(code) : '\uFFFD';
    }
    return NAMED_ENTITIES[name ?? ''] ?? match;
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
