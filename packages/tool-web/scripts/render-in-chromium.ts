/**
 * Records what Chromium shows of every page in `rendered-pages.ts`, into
 * `test/rendered-in-chromium.json`, which `test/rendered-text.test.ts`
 * holds `htmlToText` to. The test needs no browser, so CI never launches
 * one; this is the step that does, run by hand when the pages change or to
 * check the record against a newer Chromium:
 *
 *   pnpm --filter @stratusagent/tool-web render-in-chromium
 *
 * It finds Chromium the way Playwright does, then whatever revision a
 * Playwright install left in its browser cache (PLAYWRIGHT_BROWSERS_PATH, or
 * the platform's default), then an installed Google Chrome. CHROMIUM_PATH
 * names a binary outright.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { markersOf, renderedPages } from './rendered-pages.ts';

const OUTPUT = new URL('../test/rendered-in-chromium.json', import.meta.url);

// Where each platform's Playwright download keeps its binary, current
// layouts (Chrome for Testing) and the older Chromium ones alike.
const CACHED_EXECUTABLES = [
  ['chrome-linux64', 'chrome'],
  ['chrome-linux', 'chrome'],
  ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win', 'chrome.exe'],
];

/** Every Chromium a Playwright install left on this machine, newest revision first. */
const cachedChromiums = (): string[] => {
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(cache, 'ms-playwright');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)))
    .flatMap((entry) => CACHED_EXECUTABLES.map((parts) => join(root, entry, ...parts)))
    .filter((path) => existsSync(path));
};

const launch = async (): Promise<Browser> => {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit !== undefined) return chromium.launch({ executablePath: explicit });
  const tried: string[] = [];
  try {
    return await chromium.launch();
  } catch (error) {
    tried.push(error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
  }
  // A Playwright install of another version leaves a revision this one does
  // not ask for by name; any recent Chromium answers these pages the same.
  for (const executablePath of cachedChromiums()) {
    try {
      return await chromium.launch({ executablePath });
    } catch (error) {
      tried.push(error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
    }
  }
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (error) {
    tried.push(error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
  }
  throw new Error(`No Chromium could be launched. Set CHROMIUM_PATH to a Chromium or Chrome binary.\n  ${tried.join('\n  ')}`);
};

// Which of these words the extractor keeps because what hides them is still
// open at the end of the page. That is a question about identity, not
// ancestry: the tree builder rebuilds a closed formatting element as a copy,
// and the extractor counts the copy as closed with its original, so in
// `<p><b hidden>gone</p><div>also` the copy around `also` is open in the DOM
// but its text is dropped. Every start tag is marked with its own `data-k`
// for this pass, which the parser copies onto every clone; a hiding element
// is open at the end only when each element sharing its mark holds the
// sentinel.
//
// An element hides by its own computed style, not its attributes — a
// `hidden` that an inline display undoes hides nothing — through each
// property the extractor reads: display, content-visibility, and a
// visibility the element sets rather than inherits. That last is not "one
// its parent does not share": a closed span inside an open div can both say
// visibility:hidden. A string, as tool-browser's scripts are, because this
// package's types describe Node and not the page.
const OPEN_AT_END = `(words) => {
  const hides = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.contentVisibility === 'hidden') return true;
    if (style.visibility === 'visible') return false;
    const parent = el.parentElement;
    if (parent === null || getComputedStyle(parent).visibility === 'visible') return true;
    // Inherited or declared again? Show the parent and ask once more.
    const before = parent.getAttribute('style');
    parent.style.setProperty('visibility', 'visible', 'important');
    const own = getComputedStyle(el).visibility !== 'visible';
    if (before === null) parent.removeAttribute('style'); else parent.setAttribute('style', before);
    return own;
  };
  const open = (mark) => [...document.querySelectorAll('[data-k="' + mark + '"]')]
    .every((el) => el.querySelector('#sentinelq') !== null);
  return words.filter((word) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!node.textContent.includes(word)) continue;
      const hiding = [];
      for (let el = node.parentElement; el !== null; el = el.parentElement) {
        if (hides(el) && el.hasAttribute('data-k')) hiding.push(el.getAttribute('data-k'));
      }
      return hiding.length > 0 && hiding.every(open);
    }
    return false;
  });
}`;

/**
 * The page with every start tag given its own `data-k`. Distinct attributes
 * stop the tree builder treating two formatting elements as identical, which
 * only its cap on identical rebuilt elements reads, so the caller checks
 * that the marks changed nothing Chromium hides.
 */
const markStartTags = (html: string): string => {
  let mark = 0;
  return html.replace(/<([a-zA-Z][^\s/>]*)/g, (_, name: string) => `<${name} data-k="${mark++}"`);
};

const browser = await launch();
const page = await browser.newPage();
const record: Record<string, { sha: string; hidden: string[]; openAtEnd?: string[] }> = {};
for (const { id, html } of renderedPages()) {
  const markers = markersOf(html);
  await page.setContent(html);
  const shown = await page.evaluate('document.body?.innerText ?? ""') as string;
  const hidden = markers.filter((marker) => !shown.includes(marker));
  // The extractor keeps the text of an element still open at the end of the
  // page, hidden or not (see htmlToText). Which hidden markers that covers is
  // a fact about the tree, so it is Chromium's to answer too: a sentinel
  // appended to the page lands inside every element still open there.
  let openAtEnd: string[] = [];
  if (hidden.length > 0) {
    await page.setContent(`${markStartTags(html)}<s id=sentinelq></s>`);
    const marked = await page.evaluate('document.body?.innerText ?? ""') as string;
    const hiddenMarked = markers.filter((marker) => !marked.includes(marker));
    if (hiddenMarked.join(' ') !== hidden.join(' ')) {
      throw new Error(`Marking ${id}'s start tags changed what Chromium hides (${hidden.join(' ')} became ${hiddenMarked.join(' ')}), so which elements stay open cannot be read from it. Change the page.`);
    }
    openAtEnd = await page.evaluate(`(${OPEN_AT_END})(${JSON.stringify(hidden)})`) as string[];
  }
  record[id] = {
    sha: createHash('sha256').update(html).digest('hex').slice(0, 16),
    hidden,
    ...(openAtEnd.length > 0 ? { openAtEnd } : {}),
  };
}
const version = browser.version();
await browser.close();

// One page per line, so a regenerated record diffs page by page.
const lines = Object.entries(record).map(([id, entry]) => `    ${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
writeFileSync(OUTPUT, `{\n  "chromium": ${JSON.stringify(version)},\n  "pages": {\n${lines.join(',\n')}\n  }\n}\n`);
console.log(`Recorded ${lines.length} pages from Chromium ${version}. pnpm test checks htmlToText against them.`);
