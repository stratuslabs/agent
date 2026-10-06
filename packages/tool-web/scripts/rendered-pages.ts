/**
 * The pages `htmlToText` is checked against, and the one place they are
 * built. `render-in-chromium.ts` records what Chromium shows of each one,
 * and `test/rendered-text.test.ts` holds the extractor to that record with
 * no browser, so both have to see byte-identical pages: everything random
 * here comes from a seeded generator, never `Math.random`.
 *
 * Each page's text is a set of uppercase marker words, and the record is
 * which of them Chromium leaves out of `innerText`. A marker that is a
 * substring of another on the same page would make that question
 * unanswerable, so `renderedPages` refuses one.
 */

export interface RenderedPage {
  id: string;
  html: string;
}

/**
 * Hand-written pages, one per rule the extractor models. Most started as a
 * misreading of the parser or of CSS that a reviewer or a fuzz run caught,
 * so each is the smallest page that told the two answers apart.
 */
const CORPUS: readonly string[] = [
  '<b hidden>XAA<p>YBB</b>ZCC</p><p>AFTER</p>',
  '<b hidden>GONE<i>ALSO</b>SHOWN</i><p>AFTER</p>',
  '<b hidden>GONE<span>ALSO</b>SHOWN</span>',
  '<p><b hidden>GONE</p><p>ALSO</p>',
  '<p><b hidden>GONE</p></b><p>SHOWN</p>',
  '<p><b hidden>GONE</p>\n<div>ALSO</div>',
  '<a hidden>GONE<a>SHOWN</a><p>AFTER</p>',
  '<nobr hidden>GONE<nobr>SHOWN</nobr>',
  '<h1 hidden>GONE<h2>SHOWN</h1><p>AFTER</p>',
  '<h2 hidden>GONE</h1><p>AFTER</p>',
  '<button hidden>GONE<button>SHOWN</button><p>AFTER</p></button>',
  '<table><tr><td hidden>GONE<td>SHOWN</tr></table><p>AFTER</p>',
  '<table><tr hidden><td>GONE<tr><td>SHOWN</table>',
  '<table><tbody hidden><tr><td>GONE<tbody><tr><td>SHOWN</table>',
  '<div hidden><table><tr><td>GONE</table></div><p>AFTER</p>',
  '<table><caption hidden>GONE<caption>SHOWN</table><p>AFTER</p>',
  '<table><caption hidden>GONE<tr><td>SHOWN</table>',
  '<table hidden><tr><td>GONE</td></tr><table><tr><td>SHOWN</table>',
  '<div><td hidden>SHOWN</td></div>',
  '<div><tr hidden><td hidden>SHOWN</div>',
  '<ruby>BASE<rt hidden>GONE<rt>SHOWN</ruby><p>AFTER</p>',
  '<ruby>BASE<rb hidden>GONE<rb>SHOWN</ruby>',
  '<ruby>BASE<rp hidden>GONE<rt>SHOWN</ruby>',
  '<form hidden>GONE<form>ALSO</form>SHOWN',
  '<form hidden><div>GONE</form>ALSO</div>SHOWN',
  '<div><form hidden></div>GONE<form>ALSO</form>SHOWN',
  '<select hidden><option>GONE<select></select><p>SHOWN</p>',
  '<li hidden>GONE<li>SHOWN',
  '<dl><dt hidden>GONE<dd>SHOWN</dl>',
  '<p hidden>GONE<div>SHOWN</div>',
  '<i hidden><p>GONE</p></i><p>AFTER</p>',
  '<b hidden><table><tr><td>INCELL</td></tr></table></b>AFTER',
  '<table><tr><td><b hidden>GONE</td><td>SHOWN</td></tr></table>',
  '<b hidden>GONE<table><tr><td>INCELL</table>AFTER</b>END',
  '<p><b hidden><i>GONE</p><p>ALSO</p>',
  '<p><b hidden>A1<b hidden>A2<b hidden>A3<b hidden>A4</p><p>REBUILT</p>',
  '<p><b class=x hidden><b class=x><b class=x><b class=x>DEEP</p><p>REBUILT</p>',
  '<object hidden><p>GONE</p></object><p>AFTER</p>',
  '<b hidden><object><p>INOBJ</p></object></b><p>AFTER</p>',
  '<table><tr><td>CELL<b hidden>GONE</td></tr></table><p>AFTER</p>',
  '<div hidden>GONE<p>ALSO</div><p>AFTER</p>',
  '<span style="display:none">GONE<div>ALSO</div></span>SHOWN',
  '<p>PARA<table hidden><tr><td>GONE</table>AFTER',
  '<table hidden>FOSTERED<tr><td>GONE</table>',
  '<table><tr><td>CELL</td></tr><b hidden>FOSTERB</b></table>AFTER',
  '<em hidden><p>GONE<em>ALSO</p></em><p>AFTER</p>',
  '<a hidden href=x><div>GONE</a>ALSO</div><p>AFTER</p>',
  '<p><a hidden href=x>GONE</p><p>ALSO</p>',
  '<marquee><b hidden>GONE</marquee>SHOWN',
  '<span hidden>GONE<div>ALSO</span>STILL</div>AFTER',
  '<b hidden>XAA<i>YBB<p>ZCC</b>WDD</p>EEE',
  '<b hidden>XAA<span>YBB<p>ZCC</b>WDD</p>EEE',
  '<b>XAA<i hidden>YBB<p>ZCC</b>WDD</p>EEE',
  '<b hidden>XAA<p>YBB<i>ZCC</b>WDD</i></p>EEE',
  '<b hidden>XAA<p>YBB<div>ZCC</b>WDD</div></p>EEE',
  '<div hidden>GONE</body>ALSO',
  '<body hidden><p>PAGE</p></body>',
  '<section hidden>OPENTOEND',
  '<p hidden>GONE<p>SHOWN',
  '<u hidden>GONE<table><tr><td>CELLX</td></tr></table>ALSO</u>END',
  '<b hidden>GONE</b><b>SHOWN</b>',
  '<span hidden>GONE</span><b>SHOWN<p>PARA</b>MORE</p>',
  '<div><b hidden>GONE</div>ALSO',
  '<li><b hidden>GONE<li>ALSO',
  '<h1><i hidden>GONE</h1>ALSO',
  '<pre><s hidden>GONE</pre>ALSO',
  '<table><tr><td><a hidden>GONE</td><td>SHOWN</td></tr></table>AFTER',
  '<p hidden style="display:block">MARK</p>',
  '<p hidden style="display:none">MARK</p>',
  '<p hidden style="display:var(--x)">MARK</p>',
  '<p hidden style="display:initial">MARK</p>',
  '<p hidden style="display:inherit">MARK</p>',
  '<p hidden style="display:unset">MARK</p>',
  '<p hidden style="display:revert">MARK</p>',
  '<p hidden style="display:revert-layer">MARK</p>',
  '<p hidden style="display:bogus">MARK</p>',
  '<p hidden style="visibility:visible">MARK</p>',
  '<p hidden="until-found" style="display:block">MARK</p>',
  '<p hidden="until-found">MARK</p>',
  '<p style="display:none;all:initial">MARK</p>',
  '<p style="display:none;all:unset">MARK</p>',
  '<p style="display:none;all:inherit">MARK</p>',
  '<p style="display:none;all:revert">MARK</p>',
  '<p style="all:initial;display:none">MARK</p>',
  '<p style="display:none !important;all:initial">MARK</p>',
  '<p style="visibility:hidden;all:initial">MARK</p>',
  '<p style="display:none;all:var(--x)">MARK</p>',
  '<p style="display:none;all:bogus">MARK</p>',
  '<p hidden style="all:initial">MARK</p>',
  '<p hidden style="all:revert">MARK</p>',
  '<p style="all:initial !important;display:none">MARK</p>',
  '<p style="visibility:hidden;all:revert">MARK</p>',
  '<p style="visibility:hidden;all:unset">MARK</p>',
  '<p hidden style="display:block;all:revert">MARK</p>',
  '<p style="display:none;display:var(--x)">MARK</p>',
  '<p style="display:none;display:var( --x )">MARK</p>',
  '<p style="display:none;display:var(--x,)">MARK</p>',
  '<p style="display:none;display:var(--x, red)">MARK</p>',
  '<p style="display:none;display:var(--x,var(--y))">MARK</p>',
  '<p style="display:none;display:var(--x,var(y))">MARK</p>',
  '<p style="display:none;display:var(--x">MARK</p>',
  '<p style="display:none;display:var(">MARK</p>',
  '<p style="display:none;display:var()">MARK</p>',
  '<p style="display:none;display:var(x)">MARK</p>',
  '<p style="display:none;display:var(--)">MARK</p>',
  '<p style="display:none;display:var(--x red)">MARK</p>',
  '<p style="display:none;display:var(--x)var(--y)">MARK</p>',
  '<p style="display:none;display:var(--x) )">MARK</p>',
  '<p style="display:none;display:var(--x,{a})">MARK</p>',
  '<p style="display:none;display:var(--x,;)">MARK</p>',
  '<p style="display:none;display:var(--x, !)">MARK</p>',
  '<p style="display:none;display:var(--x,!important)">MARK</p>',
  '<p style="display:none;display:var(-x)">MARK</p>',
  '<p style="display:none;display:VAR(--x)">MARK</p>',
  '<p style="display:none;display:v\\61r(--x)">MARK</p>',
  '<p style="display:none;display:var(--x,">MARK</p>',
  '<p style="display:none;display:var(--x,var(">MARK</p>',
  '<p style="display:none;display:var(--x/**/)">MARK</p>',
  '<p style="display:none;display:var(/**/--x)">MARK</p>',
  '<p style="display:none;display:var(--\\78)">MARK</p>',
  '<p style="display:none;display:var(--x,[)">MARK</p>',
  '<p style="display:none;display:var(--x, url(a b))">MARK</p>',
  '<p style="display:none;display:var(--x) !">MARK</p>',
  '<p style="display:none;display:var(--x) ! foo">MARK</p>',
  '<p style="display:none;display:var(--x,(!))">MARK</p>',
  '<p style="display:none;display:var(--x,[;])">MARK</p>',
  '<p style="display:none;display:foo(var(--x))">MARK</p>',
  '<p style="display:none;display:foo(var(x))">MARK</p>',
  '<p style="display:none;display:var(--x) var(y)">MARK</p>',
  '<p style="display:none;display:var(--x,(;))">MARK</p>',
  '<p style="display:none;display:-webkit-flex">MARK</p>',
  '<p style="display:none;display:-webkit-inline-box">MARK</p>',
  '<p style="display:none;display:run-in">MARK</p>',
  '<p style="display:none;display:ruby-base">MARK</p>',
  '<p style="display:none;display:ruby-text">MARK</p>',
  '<p style="display:none;display:contents">MARK</p>',
  '<p style="display:none;display:inline flow-root">MARK</p>',
  '<p style="display:none;display:flow-root inline">MARK</p>',
  '<p style="display:none;display:list-item inline flow">MARK</p>',
  '<p style="display:none;display:list-item list-item">MARK</p>',
  '<p style="display:none;display:block block">MARK</p>',
  '<p style="display:none;display:table-caption">MARK</p>',
  '<p style="display:none;display:math">MARK</p>',
  '<p>SHOWN<span style="visibility:hidden">OPENVIS',
  '<p>SHOWN<span style="visibility:collapse">OPENVIS',
  '<p>SHOWN</p><div style="content-visibility:hidden">OPENVIS',
  '<p>SHOWN</p><div hidden=until-found>OPENVIS',
  '<div hidden style="display:block"><p hidden>INNER</p>OUTER',
  '<p>SHOWN</p><div style="visibility:hidden"><span style="visibility:hidden">INNERVIS</span>OPENVIS',
  '<p>SHOWN</p><div style="visibility:hidden"><span style="visibility:inherit">INHERITS</span>OPENVIS',  '<span style="content-visibility:hidden">MARK</span>AFTER',
  '<span hidden=until-found>MARK</span>AFTER',
  '<b style="content-visibility:hidden">MARK</b>AFTER',
  '<a href=x hidden=until-found>MARK</a>AFTER',
  '<span style="display:inline-block;content-visibility:hidden">MARK</span>AFTER',
  '<span style="display:inline flow-root;content-visibility:hidden">MARK</span>AFTER',
  '<span hidden=until-found style="display:block">MARK</span>AFTER',
  '<div style="display:inline;content-visibility:hidden">MARK</div>AFTER',
  '<div style="display:initial;content-visibility:hidden">MARK</div>AFTER',
  '<div style="display:revert;content-visibility:hidden">MARK</div>AFTER',
  '<div style="display:var(--x);content-visibility:hidden">MARK</div>AFTER',
  '<div style="display:inline list-item;content-visibility:hidden">MARK</div>AFTER',
  '<div style="display:contents;content-visibility:hidden">MARK</div>AFTER',
  '<div><span style="display:inherit;content-visibility:hidden">MARK</span></div>AFTER',
  '<span><span style="display:inherit;content-visibility:hidden">MARK</span></span>AFTER',
  '<li style="content-visibility:hidden">MARK</li>AFTER',
  '<table hidden=until-found><tr><td>MARK</td></tr></table>AFTER',
  '<table><tr style="content-visibility:hidden"><td>MARK</td></tr></table>AFTER',
  '<table><tr><td style="content-visibility:hidden">MARK</td></tr></table>AFTER',
  '<table><caption hidden=until-found>MARK</caption></table>AFTER',
  '<button style="display:inline;content-visibility:hidden">MARK</button>AFTER',
  '<button style="display:contents;content-visibility:hidden">MARK</button>AFTER',
  '<select size=3><option style="content-visibility:hidden">MARK</option></select>AFTER',
  '<dialog open style="display:inline;content-visibility:hidden">MARK</dialog>AFTER',
  '<fieldset><legend style="display:inline;content-visibility:hidden">MARK</legend></fieldset>AFTER',
  '<ruby>BASE<rt style="content-visibility:hidden">MARK</rt></ruby>AFTER',
  '<ruby>BASE<rt style="display:list-item;content-visibility:hidden">MARK</rt></ruby>AFTER',
  '<ruby>BASE<rt style="display:block;content-visibility:hidden">MARK</rt></ruby>AFTER',
  '<marquee style="display:table;content-visibility:hidden">MARK</marquee>AFTER',
  '<marquee style="content-visibility:hidden">MARK</marquee>AFTER',  '<div style="display:flex"><span style="content-visibility:hidden">MARK</span></div>AFTER',
  '<div style="display:inline-grid"><span hidden=until-found>MARK</span></div>AFTER',
  '<div style="display:-webkit-box"><span style="content-visibility:hidden">MARK</span></div>AFTER',
  '<div style="display:flex"><div style="display:contents"><span style="content-visibility:hidden">MARK</span></div></div>AFTER',
  '<div style="display:flex"><span style="display:table;content-visibility:hidden">MARK</span></div>AFTER',
  '<div style="display:flex"><span style="display:table-row;content-visibility:hidden">MARK</span></div>AFTER',
  '<span style="float:left;content-visibility:hidden">MARK</span>AFTER',
  '<span style="float:none;content-visibility:hidden">MARK</span>AFTER',
  '<span style="position:absolute;content-visibility:hidden">MARK</span>AFTER',
  '<span style="position:relative;content-visibility:hidden">MARK</span>AFTER',
  '<span style="float:left;all:initial;content-visibility:hidden">MARK</span>AFTER',
  '<span hidden=until-found style="position:fixed">MARK</span>AFTER',
  '<span style="display:inline"><b style="display:inherit;content-visibility:hidden"><p>MARK</b>AFTER</p></span>',
  '<div style="display:flex"><p><b style="content-visibility:hidden">FIRST</p>MARK</div>AFTER',
  '<div style="display:flex"><b style="content-visibility:hidden"><p>MARK</b>AFTER</p></div>',
];

/** mulberry32: small, fast, and the same sequence on every platform. */
const createRandom = (seed: number): ((n: number) => number) => {
  let state = seed;
  return (n) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
};

// Every tag the soup draws from, closed in one run. Repeated after a run of
// table and caption ends because closing a table can reopen what the
// adoption agency reconstructed inside it.
const CLOSE_ALL = '</b></i></em></a></p></div></span></li></ul></td></tr></table></h1></h2></button></ruby></dl></nobr></section></object></pre></select></u></font></blockquote></caption></rt></rp></dt></dd></tbody></option></th></thead></tfoot></colgroup></marquee></strong></s></small></code></article></h3></center></rtc></rb></dir></menu></ol></address>';
const CLOSE_PAGE = CLOSE_ALL + '</td></tr></table></caption></object>'.repeat(6) + CLOSE_ALL;

// select, option, object, marquee, rp, and foreign content are left out:
// their rendering rules are ones the extractor does not model and says so.
// So are the elements it drops whole (form, nav, header, …), which would
// only hide the misnesting this exists to exercise.
const SOUP_TAGS = ['b', 'i', 'em', 'a', 'p', 'div', 'span', 'li', 'ul', 'table', 'tr', 'td', 'caption', 'tbody', 'h1', 'h2', 'button', 'ruby', 'rt', 'dl', 'dt', 'dd', 'nobr', 'section', 'pre', 'br', 'u', 'font', 'blockquote', 'th', 'thead', 'tfoot', 'col', 'colgroup', 'strong', 's', 'small', 'code', 'article', 'h3', 'center', 'rtc', 'rb', 'dir', 'menu', 'ol', 'address'];
// Mostly formatting elements and the blocks that interrupt them, so the
// adoption agency and reconstruction run on nearly every page.
const FORMATTING_TAGS = ['b', 'i', 'em', 'a', 'nobr', 'u', 'font', 's', 'p', 'div', 'table', 'td', 'tr', 'caption', 'li', 'h1', 'span', 'pre', 'address'];

/**
 * Random tag soup: start and end tags in any order, some hidden by the
 * attribute, some by an inline style, with a marker word between them. The
 * page closes everything at the end, because an element still open there
 * keeps its text on purpose and would otherwise excuse most of the page.
 */
const tagSoup = (tags: readonly string[], prefix: string, seed: number, count: number): RenderedPage[] => {
  const rand = createRandom(seed);
  const pages: RenderedPage[] = [];
  for (let n = 0; n < count; n += 1) {
    let marker = 0;
    let html = '';
    const length = 6 + rand(14);
    for (let k = 0; k < length; k += 1) {
      const r = rand(10);
      const tag = tags[rand(tags.length)] as string;
      const hide = rand(6);
      if (r < 4) html += `<${tag}${hide === 0 ? ' hidden' : hide === 1 ? ' style="display:none"' : hide === 2 ? ' style="color:red"' : ''}>`;
      else if (r === 9 && rand(2) === 0) html += rand(2) === 0 ? ' ' : '\n';
      else if (r < 7) html += `</${tag}>`;
      else {
        html += `W${String.fromCharCode(65 + (Math.floor(marker / 26) % 26))}${String.fromCharCode(65 + (marker % 26))}Q`;
        marker += 1;
      }
    }
    pages.push({ id: `${prefix}-${seed}-${n}`, html: html + CLOSE_PAGE + 'ENDQ' });
  }
  return pages;
};

const STYLE_FRAGMENTS = ['content-visibility', 'auto', 'all', 'all', 'revert', 'revert-layer', 'initial', 'unset', 'url(\\61 b)', '\\61 ', 'url(', '\\\\', 'display', 'visibility', ':', ':', ';', ';', 'none', 'none', 'block', 'hidden', 'visible', 'collapse', ' ', ' ', '\n', '"', "'", '(', ')', '[', ']', '{', '}', 'var(--x)', 'var(', 'url(', 'url(a)', '/*', '*/', '\\', '!important', '!', 'important', 'inherit', '-webkit-flex', 'inline', 'n\\6f ne', '\;', ',', 'flex', 'list-item', 'color', 'red', '--x', 'DISPLAY', 'NONE', '&quot;', '&#59;', '&colon;', '0', 'x', '\t'];

/**
 * Inline styles built from CSS's sharp edges — escapes, unclosed strings
 * and urls, `var()`, `!important`, `all`, comments — after a declaration
 * that hides the paragraph, so the question is whether the rest undoes it.
 */
const inlineStyles = (seed: number, count: number): RenderedPage[] => {
  const rand = createRandom(seed);
  const pages: RenderedPage[] = [];
  for (let n = 0; n < count; n += 1) {
    let style = rand(2) === 0 ? 'display:none;' : 'visibility:hidden;';
    const length = 2 + rand(10);
    for (let k = 0; k < length; k += 1) style += STYLE_FRAGMENTS[rand(STYLE_FRAGMENTS.length)];
    const attribute = ['', ' hidden', ' hidden=until-found'][rand(3)] as string;
    pages.push({ id: `style-${seed}-${n}`, html: `<p${attribute} style="${style.replace(/"/g, '&quot;')}">MARK</p>` });
  }
  return pages;
};

/**
 * The marker words a page's text holds, in order of first appearance. The
 * soup's `W..Q` markers often land with no space between them, so they are
 * matched one at a time before any longer run of capitals.
 */
export const markersOf = (html: string): string[] =>
  [...new Set(html.replace(/<[^>]*>/g, ' ').match(/W[A-Z]{2}Q|[A-Z][A-Z0-9_]+/g) ?? [])];

export const renderedPages = (): RenderedPage[] => {
  const pages = [
    ...CORPUS.map((html, n) => ({ id: `corpus-${n}`, html })),
    ...tagSoup(SOUP_TAGS, 'soup', 1, 300),
    ...tagSoup(FORMATTING_TAGS, 'formatting', 1, 300),
    ...inlineStyles(1, 1000),
  ].map((page) => ({ id: page.id, html: `<!doctype html>${page.html}` }));
  for (const page of pages) {
    const markers = markersOf(page.html);
    if (markers.length === 0) throw new Error(`Page ${page.id} has no marker word, so it checks nothing. Give its text an uppercase word.`);
    const nested = markers.find((a) => markers.some((b) => a !== b && b.includes(a)));
    if (nested !== undefined) throw new Error(`Page ${page.id} has the marker ${nested} inside another marker, so whether it is shown cannot be told apart. Rename one.`);
  }
  return pages;
};
