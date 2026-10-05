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
 * Elements with no content and no end tag: pairing one of these with a
 * later end tag of the same name would drop everything in between.
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr',
]);

/**
 * Whitespace as HTML and CSS both define it: five ASCII characters. Not
 * JavaScript's `\s` or `trim()`, which also take U+00A0 and the rest of
 * Unicode's spaces — `x=a\u00A0hidden` is one unquoted value to a
 * browser, and `none\u00A0` is not the keyword `none`.
 */
const isAsciiWhitespace = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';
const trimAscii = (value: string): string => value.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');

/**
 * Lowercase as CSS compares keywords: ASCII only. `toLowerCase()` also
 * folds U+212A KELVIN SIGN to `k`, which would read `bloc\u212A` as the
 * `block` a browser does not see.
 */
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

type CssTokenType =
  | 'ident' | 'function' | 'url' | 'string' | 'hash' | 'at' | 'number' | 'delim'
  | 'space' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}';

interface CssToken {
  type: CssTokenType;
  /** Escapes decoded: an ident's or a function's name, a string's text, a delim's character. */
  value: string;
}

const isNameStart = (char: string): boolean => /^[a-zA-Z_\u0080-\uffff]$/.test(char);
const isNameChar = (char: string): boolean => isNameStart(char) || /^[0-9-]$/.test(char);
const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const CSS_NUMBER = /[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;

/**
 * An inline style's tokens, as CSS Syntax tokenizes it. Every question
 * below is asked of these, because each shortcut that read the characters
 * instead was a page the browser read one way and this another:
 * - a comment separates tokens and is otherwise nothing, so `n`, a
 *   comment, and `one` are two words, not `none`;
 * - escapes are decoded, so `n\6f ne` is `none`, `v\61r(` is a `var()`,
 *   and `none\20` is one word with a space in it;
 * - a string, or an unquoted `url(...)`, is one token whatever it spells —
 *   `"var("` calls nothing, and a `;` inside either ends no declaration;
 * - `1var` is a dimension and `#var` a hash, so neither starts a function;
 * - a string left open ends at the newline, and what follows is read again.
 * One pass, linear in the attribute. A hex escape past U+10FFFF, a
 * surrogate, or NUL reads as U+FFFD, as for HTML.
 */
const cssTokens = (input: string): CssToken[] => {
  const css = input.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD');
  const tokens: CssToken[] = [];
  let index = 0;
  const validEscape = (at: number): boolean => css[at] === '\\' && css[at + 1] !== '\n';
  /** The character the escape at `index` stands for, consuming it. */
  const escape = (): string => {
    index += 1;
    const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(index, index + 6))?.[0];
    if (hex !== undefined) {
      index += hex.length;
      if (isAsciiWhitespace(css[index] ?? '')) index += 1;
      return codePointText(Number.parseInt(hex, 16));
    }
    const char = css[index];
    if (char === undefined) return '\uFFFD';
    index += 1;
    return char;
  };
  const name = (): string => {
    let text = '';
    while (index < css.length) {
      const char = css[index] ?? '';
      if (isNameChar(char)) {
        text += char;
        index += 1;
      } else if (validEscape(index)) {
        text += escape();
      } else {
        break;
      }
    }
    return text;
  };
  const startsIdent = (at: number): boolean => {
    const first = css[at] ?? '';
    if (first === '-') return isNameStart(css[at + 1] ?? '') || css[at + 1] === '-' || validEscape(at + 1);
    return isNameStart(first) || validEscape(at);
  };
  const startsNumber = (at: number): boolean => {
    const first = css[at] ?? '';
    const next = css[at + 1] ?? '';
    if (first === '+' || first === '-') return isDigit(next) || (next === '.' && isDigit(css[at + 2] ?? ''));
    return isDigit(first) || (first === '.' && isDigit(next));
  };

  while (index < css.length) {
    const char = css[index] ?? '';
    if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      index = close === -1 ? css.length : close + 2;
    } else if (isAsciiWhitespace(char)) {
      while (isAsciiWhitespace(css[index] ?? '')) index += 1;
      tokens.push({ type: 'space', value: ' ' });
    } else if (char === '"' || char === "'") {
      index += 1;
      let text = '';
      while (index < css.length && css[index] !== char && css[index] !== '\n') {
        if (css[index] !== '\\') {
          text += css[index];
          index += 1;
        } else if (css[index + 1] === '\n') {
          index += 2;
        } else {
          text += escape();
        }
      }
      if (css[index] === char) index += 1;
      tokens.push({ type: 'string', value: text });
    } else if (startsNumber(index)) {
      CSS_NUMBER.lastIndex = index;
      CSS_NUMBER.exec(css);
      index = CSS_NUMBER.lastIndex;
      if (startsIdent(index)) name();
      else if (css[index] === '%') index += 1;
      tokens.push({ type: 'number', value: '' });
    } else if (startsIdent(index)) {
      const text = name();
      if (css[index] !== '(') {
        tokens.push({ type: 'ident', value: text });
        continue;
      }
      index += 1;
      let body = index;
      while (isAsciiWhitespace(css[body] ?? '')) body += 1;
      if (asciiLower(text) === 'url' && css[body] !== '"' && css[body] !== "'") {
        // A URL token, or a bad one, runs to its first unescaped `)`.
        index = body;
        while (index < css.length && css[index] !== ')') index += validEscape(index) ? 2 : 1;
        index += 1;
        tokens.push({ type: 'url', value: '' });
      } else {
        tokens.push({ type: 'function', value: asciiLower(text) });
      }
    } else if (char === '#' && (isNameChar(css[index + 1] ?? '') || validEscape(index + 1))) {
      index += 1;
      tokens.push({ type: 'hash', value: name() });
    } else if (char === '@' && startsIdent(index + 1)) {
      index += 1;
      tokens.push({ type: 'at', value: name() });
    } else {
      index += 1;
      const punctuation = ['(', ')', '[', ']', '{', '}', ';', ':'] as const;
      const type = punctuation.find((candidate) => candidate === char);
      tokens.push({ type: type ?? 'delim', value: char });
    }
  }
  return tokens;
};

interface CssDeclaration {
  property: string;
  /** The value's tokens, whitespace and `!important` removed, nested blocks included. */
  value: CssToken[];
  important: boolean;
}

/** The token that closes each opening one. A function token opens a `(` block. */
const CSS_CLOSERS: Partial<Record<CssTokenType, CssTokenType>> = { function: ')', '(': ')', '[': ']', '{': '}' };

/**
 * A style attribute's declarations: split on a `;` outside every block —
 * `--x:{;display:none;}` is one declaration — and kept only where they are
 * `name: value`, as a browser keeps them. `!important` is the last two
 * tokens, `!` and the ident, whatever whitespace or comments sit between.
 */
const cssDeclarations = (style: string): CssDeclaration[] => {
  const runs: CssToken[][] = [[]];
  const blocks: CssTokenType[] = [];
  for (const token of cssTokens(style)) {
    if (token.type === ';' && blocks.length === 0) {
      runs.push([]);
      continue;
    }
    const closer = CSS_CLOSERS[token.type];
    if (closer !== undefined) blocks.push(closer);
    else if (token.type === blocks.at(-1)) blocks.pop();
    if (token.type !== 'space') runs.at(-1)?.push(token);
  }
  const declarations: CssDeclaration[] = [];
  for (const [name, colon, ...value] of runs) {
    if (name?.type !== 'ident' || colon?.type !== ':') continue;
    const bang = value.at(-2);
    const last = value.at(-1);
    const important = bang?.type === 'delim' && bang.value === '!'
      && last?.type === 'ident' && asciiLower(last.value) === 'important';
    declarations.push({ property: asciiLower(name.value), value: important ? value.slice(0, -2) : value, important });
  }
  return declarations;
};

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

/** A value's words, if it is nothing but identifiers — the only values `display` and `visibility` take. */
const wordsOf = (value: readonly CssToken[]): string[] | undefined =>
  value.every((token) => token.type === 'ident') ? value.map((token) => asciiLower(token.value)) : undefined;

/**
 * Whether a value is one a browser would accept for the property. A
 * declaration it would not is dropped from the cascade rather than
 * overriding the one before it: `display:none;display:bogus` is hidden.
 * A `var()` is accepted, as a browser accepts it until computed time, and
 * reads as not hiding — the direction that keeps text.
 */
const validFor = (property: string, value: readonly CssToken[]): boolean => {
  if (value.some((token) => token.type === 'function' && token.value === 'var')) return true;
  const words = wordsOf(value);
  if (words === undefined) return false;
  if (words.length === 1 && CSS_WIDE_KEYWORDS.has(words[0] ?? '')) return true;
  if (property === 'visibility') return words.length === 1 && ['visible', 'hidden', 'collapse'].includes(words[0] ?? '');
  return validDisplay(words);
};

/**
 * Whether an inline `style` declares the element away. The last
 * declaration of a property wins unless an earlier one was `!important`,
 * which is the cascade inside one attribute — `display:none;display:block`
 * is a visible element, and dropping it would delete text the page shows.
 */
const styleHides = (style: string): boolean => {
  const declared = new Map<string, { word: string | undefined; important: boolean }>();
  for (const { property, value, important } of cssDeclarations(style)) {
    if (property !== 'display' && property !== 'visibility') continue;
    if (!validFor(property, value)) continue;
    if (declared.get(property)?.important === true && !important) continue;
    const words = wordsOf(value);
    declared.set(property, { word: words?.length === 1 ? words[0] : undefined, important });
  }
  const visibility = declared.get('visibility')?.word;
  return declared.get('display')?.word === 'none' || visibility === 'hidden' || visibility === 'collapse';
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

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/** Where a search for an open element stops: the tree builder's default scope. */
const SCOPE_BOUNDARIES = ['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template'];

/** Where a search for an open table part stops: the tree builder's table scope. */
const TABLE_SCOPE = ['html', 'table', 'template'];
const TABLE_PARTS = new Set(['table', 'caption', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);

/** Start tags that end an open sibling of their own kind, and the list element the search stops at. */
const IMPLIED_SIBLING_ENDS: Readonly<Record<string, { closes: string[]; stopAt: string[] }>> = {
  option: { closes: ['option'], stopAt: [...SCOPE_BOUNDARIES, 'select', 'datalist', 'optgroup'] },
  optgroup: { closes: ['option', 'optgroup'], stopAt: [...SCOPE_BOUNDARIES, 'select', 'datalist'] },
  button: { closes: ['button'], stopAt: SCOPE_BOUNDARIES },
};

/**
 * A table part's start tag, and the parts it belongs directly inside:
 * everything open above the nearest of them closes first, as the tree
 * builder clears the stack back to that context. So a cell ends the open
 * cell, a row the open row, and a caption or row group everything back to
 * the table. With none of them open the tag is outside any table, where
 * the tree builder ignores it — and its `hidden` with it.
 */
const TABLE_PART_CONTEXT: Readonly<Record<string, readonly string[]>> = {
  caption: ['table'],
  colgroup: ['table'],
  col: ['colgroup', 'table'],
  tbody: ['table'],
  thead: ['table'],
  tfoot: ['table'],
  tr: ['tbody', 'thead', 'tfoot', 'table'],
  td: ['tr', 'tbody', 'thead', 'tfoot', 'table'],
  th: ['tr', 'tbody', 'thead', 'tfoot', 'table'],
};

/** The document's own elements, which this pass neither hides nor closes. */
const DOCUMENT_ELEMENTS = new Set(['html', 'head', 'body']);

/**
 * End tags that close the element they name only when it is in scope.
 * Any other non-formatting end tag stops at the nearest special element.
 */
const SCOPED_END_TAGS = new Set([
  'address', 'applet', 'article', 'aside', 'blockquote', 'button', 'center', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'hgroup', 'listing', 'main',
  'marquee', 'menu', 'nav', 'object', 'ol', 'pre', 'search', 'section', 'select', 'summary', 'template', 'ul',
]);

/**
 * Start tags that end an open list item of these names. The search stops
 * at any special element but `address`, `div`, and `p`: an `li` inside a
 * `ul` inside an `li` is the inner list's, and leaves the outer one open.
 */
const LIST_ITEM_ENDS: Readonly<Record<string, readonly string[]>> = {
  li: ['li'],
  dd: ['dd', 'dt'],
  dt: ['dd', 'dt'],
};

/** The parts a table part's start tag implies, by the element it is opened in. */
const IMPLIED_TABLE_PARTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  td: { table: ['tbody', 'tr'], tbody: ['tr'], thead: ['tr'], tfoot: ['tr'] },
  th: { table: ['tbody', 'tr'], tbody: ['tr'], thead: ['tr'], tfoot: ['tr'] },
  tr: { table: ['tbody'] },
  col: { table: ['colgroup'] },
};

/** What the tree builder's "generate implied end tags" closes, while one is the current element. */
const IMPLIED_END_ELEMENTS = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);

/**
 * Elements that put a marker in the list of active formatting elements:
 * formatting opened outside one is not rebuilt inside it.
 */
const MARKER_ELEMENTS = new Set(['applet', 'marquee', 'object', 'td', 'th', 'caption', 'template']);

/**
 * The marker elements whose closing always clears the list back to their
 * marker. The other three clear it only at their own end tag: an `object`
 * popped by a table part leaves its marker, and with it, formatting
 * opened after it out of reach of a later end tag and of the rebuild.
 */
const CLEARED_ON_CLOSE = new Set(['td', 'th', 'caption', 'template']);

/**
 * Start tags the tree builder inserts without first rebuilding the
 * formatting a closed block left open — blocks, headings, lists, table
 * parts, and what it handles as head content. Every other start tag, and
 * every run of text, rebuilds it first.
 */
const INSERTED_WITHOUT_REBUILDING = new Set([
  ...CLOSES_PARAGRAPH, 'base', 'basefont', 'bgsound', 'body', 'caption', 'col', 'colgroup', 'frame', 'head',
  'html', 'iframe', 'link', 'meta', 'noembed', 'noframes', 'noscript', 'rb', 'rp', 'rt', 'rtc', 'script',
  'style', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr',
].filter((name) => name !== 'xmp'));

/**
 * How many formatting elements the rebuild list holds past its last
 * marker. The tree builder bounds only identical ones (three, below);
 * without this, a page of `<p><b id=N>x</p>` makes every paragraph rebuild
 * every earlier `b`, which is quadratic. The oldest past the bound is
 * forgotten, so its text is kept — the direction this pass falls back to.
 */
const MAX_ACTIVE_FORMATTING = 16;

/**
 * How deep the stack goes. Chromium's parser stops nesting at 512 too,
 * and the bound is what keeps this pass linear: every end tag searches the
 * stack, and an unbounded one let 80,000 nested `<div>`s and as many stray
 * end tags cost their product. An element past it is not tracked, so its
 * text is kept — the direction this pass falls back to throughout.
 */
const MAX_OPEN_ELEMENTS = 512;

/**
 * The tree builder's "special" elements: a formatting end tag that finds
 * one of these opened inside it moves it out (the adoption agency's
 * furthest block); one that finds none simply closes everything inside.
 */
const SPECIAL_ELEMENTS = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br',
  'button', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu',
  'meta', 'nav', 'noembed', 'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script',
  'search', 'section', 'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea',
  'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr', 'xmp',
]);

/**
 * As much of a node of the tree the tree builder would build as says
 * whether it is shown. The parent is mutable because the adoption agency
 * moves a block — and everything already in it — to a new parent, so
 * whether a run of text is hidden is only known at the end of the page.
 */
interface TreeNode {
  id: number;
  hidden: boolean;
  parent: TreeNode | undefined;
}

interface OpenElement {
  id: number;
  name: string;
  hidden: boolean;
  /** Where content inserted into this element goes. */
  node: TreeNode;
}

/**
 * Elements whose own content model is table structure, where other content
 * is placed before the table. A `colgroup` holds only columns: anything
 * else closes it and is placed the same way.
 */
const TABLE_CONTEXT = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'colgroup']);

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
 * Where text lands is the HTML tree builder's "in body" and table rules,
 * as far as they decide that: implied ends (`<li hidden>a<li>b` hides `a`
 * and shows `b`), scopes, foster parenting, implied table parts, the list
 * of active formatting elements and its rebuilding, and the adoption
 * agency. Each rule here was checked against Chromium, page by page and by
 * comparing random malformed pages; foreign content (`svg`, `math`) and
 * `select`'s own rendering are not modelled. An element still open at the
 * end of the page keeps its text: a closing rule this pass does not model
 * must not erase the article behind it, and keeping is what this extractor
 * did before it read visibility at all.
 */
const dropHiddenElements = (html: string, tail: string): { text: string; tail: string } => {
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
  const onStack = new Set<OpenElement>();
  const confirmed = new Set<number>();
  const segments: { start: number; end: number; node: TreeNode | undefined }[] = [];
  let nextId = 0;
  // The list of active formatting elements: formatting a block closed
  // around is still in force, and the tree builder rebuilds it, `hidden`
  // and all, before the next content. So in `<p><b hidden>gone</p><p>also`
  // the second paragraph's text is in a copy of the hidden `b`.
  type Formatting = { element: OpenElement; key: string };
  const active: (Formatting | 'marker')[] = [];
  // The form element pointer: while a form is open, another form start tag
  // is ignored, and `</form>` removes that form alone.
  let form: OpenElement | undefined;

  const nearest = (names: readonly string[], stopAt: readonly string[]): number => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const name = stack[index]?.name ?? '';
      if (names.includes(name)) return index;
      if (stopAt.includes(name)) return -1;
    }
    return -1;
  };
  const inScope = (index: number): boolean =>
    !stack.slice(index + 1).some((inside) => SCOPE_BOUNDARIES.includes(inside.name));
  const push = (element: OpenElement): boolean => {
    if (stack.length >= MAX_OPEN_ELEMENTS) return false;
    stack.push(element);
    onStack.add(element);
    return true;
  };
  const clearToMarker = (): void => {
    while (active.length > 0 && active.pop() !== 'marker') {
      // Everything after the last marker goes with it.
    }
  };
  const removed = (element: OpenElement): void => {
    onStack.delete(element);
    if (element.hidden) confirmed.add(element.id);
    if (CLEARED_ON_CLOSE.has(element.name)) clearToMarker();
  };
  const closeFrom = (index: number): void => {
    // Innermost first, so a cell's marker is cleared after what it holds.
    for (const element of stack.splice(index).reverse()) removed(element);
  };
  /** The last entry past the last marker that `matches`, as an index into the list. */
  const lastActive = (matches: (entry: Formatting) => boolean): number => {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const entry = active[index];
      if (entry === 'marker' || entry === undefined) return -1;
      if (matches(entry)) return index;
    }
    return -1;
  };
  const forget = (element: OpenElement): void => {
    const index = lastActive((entry) => entry.element === element);
    if (index !== -1) active.splice(index, 1);
  };
  /**
   * Where foster-parented content goes: into the last open table's parent
   * in the tree, before the table — which is not always the element below
   * it on the stack. `<a hidden><table><a>` takes the hidden link off the
   * stack and leaves the table in it, so what is fostered is hidden too.
   */
  const fosterParent = (): TreeNode | undefined => stack[nearest(['table'], [])]?.node.parent;
  /** Where new content goes: the top, or a table's parent for what a table cannot hold. */
  const parentFor = (fostered: boolean): TreeNode | undefined => {
    const top = stack.at(-1);
    return top !== undefined && fostered && TABLE_CONTEXT.has(top.name) ? fosterParent() : top?.node;
  };
  const element = (name: string, hidden: boolean, parent: TreeNode | undefined, id = nextId++): OpenElement =>
    ({ id, name, hidden, node: { id, hidden, parent } });
  /**
   * The tree builder's reconstruction: reopen, in order, the formatting a
   * block closed around. A copy keeps its original's id, so a copy of a
   * hidden element hides as the original did — which was closed, or it
   * would not need rebuilding.
   */
  const rebuild = (fostered: boolean): void => {
    // In a table, only what is foster-parented rebuilds — before the table.
    if (TABLE_CONTEXT.has(stack.at(-1)?.name ?? '') && !fostered) return;
    let first = active.length;
    while (first > 0) {
      const entry = active[first - 1];
      if (entry === 'marker' || entry === undefined || onStack.has(entry.element)) break;
      first -= 1;
    }
    for (let index = first; index < active.length; index += 1) {
      const entry = active[index];
      if (entry === 'marker' || entry === undefined) continue;
      const original = entry.element;
      const copy = element(original.name, original.hidden, parentFor(true), original.id);
      if (!push(copy)) return;
      active[index] = { element: copy, key: entry.key };
    }
  };
  /**
   * Formatting enters the list, at most three identical — same name, same
   * attributes — past the last marker, as the tree builder's "Noah's Ark"
   * clause keeps it, and at most MAX_ACTIVE_FORMATTING in all.
   */
  const remember = (opened: OpenElement, attributes: ReadonlyMap<string, string>): void => {
    const key = [opened.name, ...[...attributes].map(([name, value]) => `${name}=${value}`).sort()].join('\u0000');
    let since = active.length;
    while (since > 0 && active[since - 1] !== 'marker') since -= 1;
    const same = active.slice(since).filter((entry) => entry !== 'marker' && entry.key === key);
    if (same.length >= 3 && same[0] !== undefined) active.splice(active.indexOf(same[0]), 1);
    if (active.length - since >= MAX_ACTIVE_FORMATTING) active.splice(since, 1);
    active.push({ element: opened, key });
  };
  /**
   * The end tag the tree builder calls "any other": it closes the nearest
   * open element of its name unless a special element is opened inside
   * that, in which case it is ignored — `</span>` does not reach out of a
   * `div` opened in the span.
   */
  const anyOtherEnd = (name: string): number => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const open = stack[index];
      if (open?.name === name) return index;
      if (SPECIAL_ELEMENTS.has(open?.name ?? '')) return -1;
    }
    return -1;
  };
  /**
   * The adoption agency, for an end tag naming formatting, in the terms
   * this pass keeps: each element's ancestry. The element is the last of
   * its name in the formatting list, not the stack — so after
   * `<em hidden><p><em>x</p>`, `</em>` names the inner `em`, already
   * closed, and the hidden one stays open. Content already read stays
   * where it is, under copies of the element; what moves is the block that
   * was opened inside it, which leaves it, so in `<b hidden>x<p>y</b>z`
   * the `z` is in the paragraph and shown.
   */
  const adopt = (name: string): void => {
    for (let round = 0; round < 8; round += 1) {
      const entryIndex = lastActive((entry) => entry.element.name === name);
      const formatting = active[entryIndex];
      if (formatting === undefined || formatting === 'marker') {
        const index = anyOtherEnd(name);
        if (index !== -1) closeFrom(index);
        return;
      }
      const index = stack.lastIndexOf(formatting.element);
      if (index === -1) {
        active.splice(entryIndex, 1);
        return;
      }
      if (!inScope(index)) return;
      const block = stack.findIndex((open, at) => at > index && SPECIAL_ELEMENTS.has(open.name));
      if (block === -1) {
        active.splice(entryIndex, 1);
        closeFrom(index);
        return;
      }
      // The block is moved under the element's parent — or, when that is a
      // table part, foster-parented before the table, as anything is — and
      // into copies of the formatting between them within three of the
      // block. Anything else between is closed, and the block leaves it:
      // in `<b><span hidden><p>x</b>` the `p` and its `x` are not hidden.
      const common = stack[index - 1];
      let ancestry = common !== undefined && TABLE_CONTEXT.has(common.name) ? fosterParent() : common?.node;
      const between: OpenElement[] = [];
      for (let at = index + 1; at < block; at += 1) {
        const open = stack[at];
        if (open === undefined) continue;
        const entry = lastActive((candidate) => candidate.element === open);
        const found = active[entry];
        if (found !== undefined && found !== 'marker' && block - at <= 3) {
          const copy = element(open.name, open.hidden, ancestry, open.id);
          ancestry = copy.node;
          active[entry] = { element: copy, key: found.key };
          between.push(copy);
        } else if (entry !== -1) {
          active.splice(entry, 1);
        }
        removed(open);
      }
      const blockElement = stack[block];
      if (blockElement === undefined) return;
      onStack.delete(blockElement);
      // What the block held so far moves into a copy of the formatting
      // element inside it, which the next round closes. The block's node
      // becomes that copy, keeping everything already in it, and the
      // block takes a new node in its new place.
      const holder = blockElement.node;
      const moved: OpenElement = { ...blockElement, node: { id: blockElement.id, hidden: blockElement.hidden, parent: ancestry } };
      holder.id = formatting.element.id;
      holder.hidden = formatting.element.hidden;
      holder.parent = moved.node;
      const copy: OpenElement = { ...formatting.element, node: holder };
      active[entryIndex] = { element: copy, key: formatting.key };
      removed(formatting.element);
      const inside = stack.slice(block + 1);
      stack.splice(index);
      for (const open of [...between, moved, copy, ...inside]) {
        stack.push(open);
        onStack.add(open);
      }
    }
  };
  /** The tree builder's "generate implied end tags", optionally sparing one name. */
  const impliedEnds = (except?: string): void => {
    for (let top = stack.at(-1); top !== undefined && IMPLIED_END_ELEMENTS.has(top.name) && top.name !== except; top = stack.at(-1)) {
      closeFrom(stack.length - 1);
    }
  };

  let cursor = 0;
  for (const tag of scanTags(html)) {
    if (tag.start > cursor) {
      const fostered = /[^ \t\n\f\r]/.test(html.slice(cursor, tag.start));
      rebuild(fostered);
      segments.push({ start: cursor, end: tag.start, node: parentFor(fostered) });
    }
    cursor = tag.end;
    const ignore = (): void => {
      segments.push({ start: tag.start, end: tag.end, node: parentFor(false) });
    };
    // The document's own elements are never hidden or closed here: a body
    // hidden until a script reveals it is the whole page, not part of it,
    // and `</body>` ends nothing — content after it is the body's again.
    if (DOCUMENT_ELEMENTS.has(tag.name)) {
      ignore();
      continue;
    }
    if (!tag.closing) {
      // Before the void check, because `hr` both closes a paragraph and
      // holds nothing.
      if (CLOSES_PARAGRAPH.has(tag.name)) {
        const paragraph = nearest(['p'], [...SCOPE_BOUNDARIES, 'button']);
        if (paragraph !== -1) closeFrom(paragraph);
      }
      const items = LIST_ITEM_ENDS[tag.name];
      if (items !== undefined) {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          const name = stack[index]?.name ?? '';
          if (items.includes(name)) {
            closeFrom(index);
            break;
          }
          if (SPECIAL_ELEMENTS.has(name) && name !== 'address' && name !== 'div' && name !== 'p') break;
        }
      }
      const sibling = IMPLIED_SIBLING_ENDS[tag.name];
      if (sibling !== undefined) {
        const found = nearest(sibling.closes, sibling.stopAt);
        if (found !== -1) closeFrom(found);
      }
      const context = TABLE_PART_CONTEXT[tag.name];
      if (context !== undefined) {
        const found = nearest(context, ['template']);
        if (found === -1) {
          ignore();
          continue;
        }
        closeFrom(found + 1);
        // The parts the tree builder implies: a cell in a table or a row
        // group gets a row, a row in a table a row group, a column a column
        // group — so a later `</tr>` has a row to close, as it does there.
        const holder = stack[found]?.name ?? '';
        for (const implied of IMPLIED_TABLE_PARTS[tag.name]?.[holder] ?? []) push(element(implied, false, parentFor(false)));
      }
      // A table directly in a table — not in one of its cells or its
      // caption, where it nests — ends the first; the second is its sibling.
      if (tag.name === 'table') {
        const found = nearest(['table', 'caption', 'td', 'th'], ['template']);
        if (stack[found]?.name === 'table') closeFrom(found);
      }
      // A heading never holds another: `<h1 hidden>gone<h2>shown` ends the
      // h1 at the h2 — but only when the h1 is the current element.
      if (HEADINGS.includes(tag.name) && HEADINGS.includes(stack.at(-1)?.name ?? '')) closeFrom(stack.length - 1);
      // Ruby annotations are siblings: each closes the open `rb`, `rp`,
      // `rt` (and, for `rb` and `rtc`, `rtc`) before it.
      if (['rb', 'rtc', 'rp', 'rt'].includes(tag.name) && nearest(['ruby'], SCOPE_BOUNDARIES) !== -1) {
        impliedEnds(tag.name === 'rp' || tag.name === 'rt' ? 'rtc' : undefined);
      }
      // A select never holds a select: the second closes the first and is
      // itself dropped. An input closes it too, and is inserted after.
      if (tag.name === 'select' || tag.name === 'input') {
        const found = nearest(['select'], SCOPE_BOUNDARIES);
        if (found !== -1) {
          closeFrom(found);
          if (tag.name === 'select') {
            ignore();
            continue;
          }
        }
      }
      if (tag.name === 'form' && form !== undefined && nearest(['template'], []) === -1) {
        ignore();
        continue;
      }
      // Nor does a link hold a link, and a second `nobr` ends the first:
      // the tree builder runs the end tag for the open one first.
      if (tag.name === 'a' && lastActive((entry) => entry.element.name === 'a') !== -1) {
        const link = active[lastActive((entry) => entry.element.name === 'a')];
        adopt('a');
        if (link !== undefined && link !== 'marker') {
          forget(link.element);
          const index = stack.lastIndexOf(link.element);
          if (index !== -1) {
            const [left] = stack.splice(index, 1);
            if (left !== undefined) removed(left);
          }
        }
      }
      const fostered = !TABLE_CONTENT.has(tag.name);
      if (tag.name === 'nobr') {
        rebuild(fostered);
        if (nearest(['nobr'], SCOPE_BOUNDARIES) !== -1) adopt('nobr');
      }
      if (!INSERTED_WITHOUT_REBUILDING.has(tag.name)) rebuild(fostered);
      const opened = element(tag.name, attributesHide(tag.attributes), parentFor(fostered));
      segments.push({ start: tag.start, end: tag.end, node: opened.node });
      // A void element holds no text, but a hidden one still has an
      // effect to withhold — `one<br hidden>two` is one line — so its tag
      // is dropped, and it is closed the moment it opens.
      if (VOID_ELEMENTS.has(tag.name)) {
        if (opened.hidden) confirmed.add(opened.id);
        continue;
      }
      if (!push(opened)) continue;
      if (FORMATTING_ELEMENTS.has(tag.name)) remember(opened, tag.attributes);
      if (MARKER_ELEMENTS.has(tag.name)) active.push('marker');
      if (tag.name === 'form') form = opened;
      continue;
    }

    if (FORMATTING_ELEMENTS.has(tag.name)) {
      ignore();
      adopt(tag.name);
      continue;
    }
    // `</form>` removes the form it opened and nothing inside it: in
    // `<form hidden><div>a</form>b</div>` the `b` is still in the form.
    if (tag.name === 'form') {
      const pointer = form;
      form = undefined;
      const index = pointer === undefined ? -1 : stack.lastIndexOf(pointer);
      segments.push({ start: tag.start, end: tag.end, node: pointer?.node ?? parentFor(false) });
      if (pointer !== undefined && index !== -1 && inScope(index)) {
        impliedEnds();
        const [left] = stack.splice(stack.lastIndexOf(pointer), 1);
        if (left !== undefined) removed(left);
      }
      continue;
    }
    // Where each end tag looks for its element: a table part in table
    // scope, past an open cell — `</table>` from inside a `td` closes the
    // cell and the table; any heading for any heading; `</p>` and `</li>`
    // in their own scopes; a block in the default scope; and anything else
    // only up to the nearest special element.
    let index: number;
    if (TABLE_PARTS.has(tag.name)) index = nearest([tag.name], TABLE_SCOPE.filter((name) => name !== tag.name));
    else if (HEADINGS.includes(tag.name)) index = nearest(HEADINGS, SCOPE_BOUNDARIES);
    else if (tag.name === 'p') index = nearest(['p'], [...SCOPE_BOUNDARIES, 'button']);
    else if (tag.name === 'li') index = nearest(['li'], [...SCOPE_BOUNDARIES, 'ol', 'ul']);
    else if (SCOPED_END_TAGS.has(tag.name)) index = nearest([tag.name], SCOPE_BOUNDARIES.filter((name) => name !== tag.name));
    else index = anyOtherEnd(tag.name);
    // An end tag with nothing of its name open is a stray, and closes nothing.
    if (index === -1) {
      ignore();
      continue;
    }
    segments.push({ start: tag.start, end: tag.end, node: stack[index]?.node });
    closeFrom(index);
    if (MARKER_ELEMENTS.has(tag.name) && !CLEARED_ON_CLOSE.has(tag.name)) clearToMarker();
  }
  if (cursor < html.length) {
    const fostered = /[^ \t\n\f\r]/.test(html.slice(cursor));
    rebuild(fostered);
    segments.push({ start: cursor, end: html.length, node: parentFor(fostered) });
  }
  // The text after the page's last `>`, which the caller keeps apart from
  // its patterns, is still read into the tree: formatting a block closed
  // around is rebuilt for it, so `<div><b hidden>x</div>tail` hides it.
  const tailFostered = /[^ \t\n\f\r]/.test(tail);
  if (tail !== '') rebuild(tailFostered);
  const tailNode = parentFor(tailFostered);
  if (confirmed.size === 0) return { text: html, tail };

  // Whether a node is dropped: it, or a node it is in, is hidden and was
  // closed. Read once the page is done, since nodes move until then;
  // remembered per node, so a page costs its nodes once.
  const dropped = new Map<TreeNode, boolean>();
  const isDropped = (node: TreeNode | undefined): boolean => {
    const chain: TreeNode[] = [];
    let result = false;
    for (let at = node; at !== undefined; at = at.parent) {
      const known = dropped.get(at);
      if (known !== undefined) {
        result = known;
        break;
      }
      chain.push(at);
    }
    for (const at of chain.reverse()) {
      result = result || (at.hidden && confirmed.has(at.id));
      dropped.set(at, result);
    }
    return result;
  };

  // A dropped stretch, however many segments, becomes one space.
  let text = '';
  let dropping = false;
  for (const segment of segments) {
    if (isDropped(segment.node)) {
      if (!dropping) text += ' ';
      dropping = true;
    } else {
      text += html.slice(segment.start, segment.end);
      dropping = false;
    }
  }
  return { text, tail: tail !== '' && isDropped(tailNode) ? ' ' : tail };
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
  const visible = dropHiddenElements(text, tail);
  text = visible.text;

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

  text = decodeEntities(text + visible.tail);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (lines[index - 1] ?? '').length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
