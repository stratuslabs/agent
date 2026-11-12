/**
 * Records what Chromium shows of every page in `rendered-pages.ts`, into
 * `test/rendered-in-chromium.json`, which `test/rendered-text.test.ts`
 * holds `htmlToText` to. The test needs no browser, so CI never launches
 * one; this is the step that does, run by hand when the pages change or to
 * check the record against a newer Chromium:
 *
 *   pnpm --filter @stratusagent/tool-web render-in-chromium
 *
 * CHROMIUM_PATH names the browser outright; otherwise it is the one
 * playwright-core finds, then an installed Google Chrome. It does not hunt
 * through Playwright's cache for another revision: where that cache is and
 * how it is laid out is Playwright's to know, and any recent Chromium answers
 * these pages the same, so pointing CHROMIUM_PATH at one is the whole fix.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { markersOf, renderedPages } from './rendered-pages.ts';

const OUTPUT = new URL('../test/rendered-in-chromium.json', import.meta.url);

const launch = async (): Promise<Browser> => {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit !== undefined) return chromium.launch({ executablePath: explicit });
  const tried: string[] = [];
  try {
    return await chromium.launch();
  } catch (error) {
    tried.push(error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
  }
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (error) {
    tried.push(error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
  }
  throw new Error(`No Chromium could be launched. Install the one this playwright-core expects with pnpm --filter @stratusagent/tool-web exec playwright-core install chromium, or set CHROMIUM_PATH to any Chromium or Chrome binary.\n  ${tried.join('\n  ')}`);
};

const browser = await launch();
const page = await browser.newPage();
const record: Record<string, { sha: string; hidden: string[] }> = {};
for (const { id, html } of renderedPages()) {
  const markers = markersOf(html);
  await page.setContent(html);
  const shown = await page.evaluate('document.body?.innerText ?? ""') as string;
  const hidden = markers.filter((marker) => !shown.includes(marker));
  record[id] = { sha: createHash('sha256').update(html).digest('hex').slice(0, 16), hidden };
}
const version = browser.version();
await browser.close();

// One page per line, so a regenerated record diffs page by page.
const lines = Object.entries(record).map(([id, entry]) => `    ${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
writeFileSync(OUTPUT, `{\n  "chromium": ${JSON.stringify(version)},\n  "pages": {\n${lines.join(',\n')}\n  }\n}\n`);
console.log(`Recorded ${lines.length} pages from Chromium ${version}. pnpm test checks htmlToText against them.`);
