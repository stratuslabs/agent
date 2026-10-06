import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/index.ts';
import { markersOf, renderedPages } from '../scripts/rendered-pages.ts';

// What Chromium showed of each page, recorded by scripts/render-in-chromium.ts.
// No browser runs here: the record is the browser's answer, checked in.
interface Recorded {
  sha: string;
  hidden: string[];
  openAtEnd?: string[];
}
const recorded = JSON.parse(readFileSync(new URL('./rendered-in-chromium.json', import.meta.url), 'utf8')) as {
  chromium: string;
  pages: Record<string, Recorded>;
};
const pages = renderedPages();
const REGENERATE = 'Regenerate the record with pnpm --filter @stratusagent/tool-web render-in-chromium.';

test('the Chromium record covers exactly the pages the generator builds', () => {
  const stale = pages
    .filter((page) => recorded.pages[page.id]?.sha !== createHash('sha256').update(page.html).digest('hex').slice(0, 16))
    .map((page) => page.id);
  assert.deepEqual(stale, [], `These pages changed since Chromium was asked about them. ${REGENERATE}`);
  const built = new Set(pages.map((page) => page.id));
  const orphaned = Object.keys(recorded.pages).filter((id) => !built.has(id));
  assert.deepEqual(orphaned, [], `The record has pages the generator no longer builds. ${REGENERATE}`);
});

test('htmlToText shows the text Chromium shows and hides the text it hides', () => {
  const failures: string[] = [];
  for (const page of pages) {
    const entry = recorded.pages[page.id];
    if (entry === undefined) continue;
    const text = htmlToText(page.html);
    for (const marker of markersOf(page.html)) {
      // An element still open at the end of the page keeps its text on
      // purpose, so what Chromium hides inside one is not held either way.
      if (entry.openAtEnd?.includes(marker) === true) continue;
      const hidden = entry.hidden.includes(marker);
      if (text.includes(marker) === hidden) {
        failures.push(`${page.id}: ${marker} is ${hidden ? 'hidden in Chromium but kept' : 'shown in Chromium but dropped'} — ${JSON.stringify(page.html)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `htmlToText disagrees with Chromium ${recorded.chromium}.`);
});
