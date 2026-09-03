import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hostMatchesSite,
  normalizePublishedAt,
  normalizeSearchResults,
  normalizeSearchSite,
  parseFreshnessDuration,
  parseSearchCall,
  plainSnippet,
  SEARCH_COUNT_MAX,
} from '../src/index.ts';

const NOW = new Date('2026-09-03T12:00:00.000Z');

test('the query is literal text: operators, quotes, and minus signs come through as written', () => {
  for (const query of ['site:example.com', 'a OR b', '-foo', 'an "unbalanced quote', 'cats & dogs']) {
    assert.equal(parseSearchCall({ query }, NOW).query, query);
  }
  // Trimmed, but only at the edges — the characters an agent typed are what
  // a backend is asked to search for.
  assert.equal(parseSearchCall({ query: '  kettles  ' }, NOW).query, 'kettles');
});

test('a misspelled option is refused, not quietly dropped into an unfiltered search', () => {
  // The failure this prevents: `freshnes` read as "no freshness filter"
  // runs an unrestricted search that *succeeds*, and the agent then says
  // the answer is recent. A dropped option is a silently ignored one
  // arriving a step earlier.
  assert.throws(
    () => parseSearchCall({ query: 'k', freshnes: 'P7D' }, NOW),
    /freshnes is not a field of web\.search\. It takes query, count, site, freshness\./,
  );
  assert.throws(() => parseSearchCall({ query: 'k', domain: 'example.com' }, NOW), /domain is not a field/);
  assert.throws(() => parseSearchCall({ query: 'k', a: 1, b: 2 }, NOW), /a, b are not fields/);
  // The four it does take, together.
  assert.doesNotThrow(() => parseSearchCall({ query: 'k', count: 5, site: 'example.com', freshness: 'P7D' }, NOW));
});

test('an empty or missing query is refused rather than searched for', () => {
  assert.throws(() => parseSearchCall({ query: '   ' }, NOW), /query is required/);
  assert.throws(() => parseSearchCall({}, NOW), /query must be a string/);
  assert.throws(() => parseSearchCall({ query: 7 }, NOW), /query must be a string/);
});

test('count defaults to ten and is held between one and fifty, whole numbers only', () => {
  assert.equal(parseSearchCall({ query: 'k' }, NOW).options.count, 10);
  assert.equal(parseSearchCall({ query: 'k', count: 1 }, NOW).options.count, 1);
  assert.equal(parseSearchCall({ query: 'k', count: SEARCH_COUNT_MAX }, NOW).options.count, SEARCH_COUNT_MAX);
  assert.throws(() => parseSearchCall({ query: 'k', count: 0 }, NOW), /between 1 and 50/);
  assert.throws(() => parseSearchCall({ query: 'k', count: 51 }, NOW), /between 1 and 50/);
  assert.throws(() => parseSearchCall({ query: 'k', count: 2.5 }, NOW), /whole number/);
});

test('site is one bare hostname, normalized, with at least two labels', () => {
  assert.equal(normalizeSearchSite('EXAMPLE.com'), 'example.com');
  assert.equal(normalizeSearchSite('example.com.'), 'example.com');
  assert.equal(normalizeSearchSite('docs.example.com'), 'docs.example.com');
  // IDN in its A-label form, so two adapters compare the same string.
  assert.equal(normalizeSearchSite('bücher.de'), 'xn--bcher-kva.de');

  // The two-label minimum is what stops `site: com`.
  assert.throws(() => normalizeSearchSite('com'), /at least two labels/);
  assert.throws(() => normalizeSearchSite('https://example.com'), /bare hostname/);
  assert.throws(() => normalizeSearchSite('example.com:8080'), /bare hostname/);
  assert.throws(() => normalizeSearchSite('example.com/docs'), /bare hostname/);
  assert.throws(() => normalizeSearchSite(''), /empty/);
});

test('site matching is on label boundaries, so a lookalike parent domain never matches', () => {
  assert.ok(hostMatchesSite('example.com', 'example.com'));
  assert.ok(hostMatchesSite('docs.example.com', 'example.com'));
  assert.ok(hostMatchesSite('DOCS.EXAMPLE.COM', 'example.com'));
  // The whole rule: `notexample.com` ends with the same characters and is a
  // different company.
  assert.ok(!hostMatchesSite('notexample.com', 'example.com'));
  assert.ok(!hostMatchesSite('example.com.evil.test', 'example.com'));
  // A narrower site matches only itself and its own subdomains.
  assert.ok(!hostMatchesSite('example.com', 'docs.example.com'));
  assert.ok(hostMatchesSite('api.docs.example.com', 'docs.example.com'));
});

test('freshness accepts fixed lengths and refuses calendar ones, positionally', () => {
  assert.equal(parseFreshnessDuration('P7D'), 7 * 86_400_000);
  assert.equal(parseFreshnessDuration('P4W'), 28 * 86_400_000);
  assert.equal(parseFreshnessDuration('PT12H'), 12 * 3_600_000);
  assert.equal(parseFreshnessDuration('PT30M'), 30 * 60_000);
  assert.equal(parseFreshnessDuration('PT45S'), 45_000);
  assert.equal(parseFreshnessDuration('P1DT6H'), 86_400_000 + 6 * 3_600_000);
  // Case is not part of the meaning.
  assert.equal(parseFreshnessDuration('p7d'), 7 * 86_400_000);

  // `M` means two things and only one of them is rejected: months in the
  // date portion, minutes after the `T`.
  assert.throws(() => parseFreshnessDuration('P1M'), /calendar length/);
  assert.throws(() => parseFreshnessDuration('P1Y'), /calendar length/);
  assert.throws(() => parseFreshnessDuration('P12M'), /calendar length/);

  // Not a duration at all, or one of no length.
  for (const bad of ['7d', 'P', 'PT', 'P1DT', 'PT0S', 'P0D', 'last week', '']) {
    assert.throws(() => parseFreshnessDuration(bad), /positive ISO 8601 duration/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('freshness is measured back from the instant the request is made, in UTC', () => {
  const { options } = parseSearchCall({ query: 'k', freshness: 'P7D' }, NOW);
  assert.equal(options.freshness?.since, '2026-08-27T12:00:00.000Z');
  assert.equal(options.freshness?.duration, 'P7D');
  assert.equal(options.freshness?.ms, 7 * 86_400_000);
});

test('publishedAt becomes a UTC instant, and anything unparseable becomes nothing at all', () => {
  assert.equal(normalizePublishedAt('2026-09-01T09:00:00Z'), '2026-09-01T09:00:00.000Z');
  assert.equal(normalizePublishedAt('2026-09-01T11:00:00+02:00'), '2026-09-01T09:00:00.000Z');
  // The same offset spelled the other legal ISO way.
  assert.equal(normalizePublishedAt('2026-09-01T11:00:00+0200'), '2026-09-01T09:00:00.000Z');
  // A day with no time is read as UTC midnight, which is what ISO 8601 and
  // JavaScript both say it is. Refusing it would empty every freshness
  // search against a backend that only has days.
  assert.equal(normalizePublishedAt('2026-09-01'), '2026-09-01T00:00:00.000Z');
  assert.equal(normalizePublishedAt('yesterday'), undefined);
  assert.equal(normalizePublishedAt(''), undefined);
  assert.equal(normalizePublishedAt(undefined), undefined);
});

test('a lenient date parse invents dates, so the shape is checked before anything is parsed', () => {
  // `new Date` is not a validator. Each of these parses happily and answers
  // with a date the backend never gave — and under `freshness` that date
  // then decides whether the result is kept.
  assert.equal(new Date('03/04/2026').toISOString(), '2026-03-04T00:00:00.000Z');
  assert.equal(new Date('2026-02-30').toISOString(), '2026-03-02T00:00:00.000Z');

  // Locale-formatted: never said whether it meant March or April.
  assert.equal(normalizePublishedAt('03/04/2026'), undefined);
  // A day that does not exist, rolled forward rather than refused.
  assert.equal(normalizePublishedAt('2026-02-30'), undefined);
  assert.equal(normalizePublishedAt('2026-13-01'), undefined);
  assert.equal(normalizePublishedAt('2025-02-29'), undefined);
  // 2024 is a leap year, so this one is real.
  assert.equal(normalizePublishedAt('2024-02-29'), '2024-02-29T00:00:00.000Z');
  // No zone is local time, so the same string is two instants on two
  // daemons — the disagreement this package exists to remove.
  assert.equal(normalizePublishedAt('2026-09-01T10:00:00'), undefined);
  assert.equal(normalizePublishedAt('2026-09-01T25:00:00Z'), undefined);
});

test('an invented date cannot survive a freshness filter, because it is never a date at all', () => {
  const { options } = parseSearchCall({ query: 'k', freshness: 'P7D' }, NOW);
  const results = normalizeSearchResults(
    [
      { title: 'Locale-formatted', url: 'https://example.com/a', publishedAt: '03/04/2026' },
      { title: 'Real and fresh', url: 'https://example.com/b', publishedAt: '2026-09-02T18:00:00Z' },
    ],
    options,
  );
  // The first row read as 4 March under a lenient parse — six months stale,
  // so it would have been dropped for the wrong reason. Reversed dates would
  // have kept it for the wrong reason. Either way the answer was luck.
  assert.deepEqual(results.map((entry) => entry.title), ['Real and fresh']);
});

test('snippets arrive as plain text, whatever decoration the vendor sent', () => {
  assert.equal(plainSnippet('The <strong>kettle</strong>   guide.'), 'The kettle guide.');
  // Without the runs of spaces the original fixture happened to carry, which
  // is what hid the defect this pair now pins.
  assert.equal(plainSnippet('The <strong>kettle</strong> guide.'), 'The kettle guide.');
  assert.equal(plainSnippet('An <img src="x.png"> illustration'), 'An illustration');
  assert.equal(plainSnippet('line\n\nbreak'), 'line break');
  assert.equal(plainSnippet('  padded  '), 'padded');
});

test('a highlighted substring does not become two words, or a detached full stop', () => {
  // Vendors highlight the matched *substring*, so this is the shape a real
  // backend returns most often — and replacing the tag with a space invents
  // a word the page does not contain.
  assert.equal(plainSnippet('un<strong>expected</strong> results'), 'unexpected results');
  assert.equal(plainSnippet('The <strong>kettle</strong>.'), 'The kettle.');
  assert.equal(plainSnippet('the <em>API</em>, and more'), 'the API, and more');
  assert.equal(plainSnippet('a <b>bold</b><i>run</i>'), 'a boldrun');

  // Anything that is not inline formatting still separates. Removing these
  // would glue two values into one, which is the opposite mistake.
  assert.equal(plainSnippet('one<br>two'), 'one two');
  assert.equal(plainSnippet('<p>one</p><p>two</p>'), 'one two');
  assert.equal(plainSnippet('<li>one</li><li>two</li>'), 'one two');
  assert.equal(plainSnippet('<td>Alpha</td><td>Beta</td>'), 'Alpha Beta');
  // Including a tag no list will ever contain, which is why the default
  // runs this way: an unneeded space is a blemish, a missing one is a word
  // nobody wrote.
  assert.equal(plainSnippet('<my-widget>Alpha</my-widget><my-widget>Beta</my-widget>'), 'Alpha Beta');
  // A ruby annotation prints above its base text, so joining them fuses a
  // word with its own pronunciation into a token the page never shows.
  assert.equal(plainSnippet('<ruby>東京<rt>とうきょう</rt></ruby>へ行く'), '東京 とうきょう へ行く');
  // …while `sub`/`sup` stay joined, which is the contrast: `H2O` is one token.
  assert.equal(plainSnippet('H<sub>2</sub>O'), 'H2O');
});

test('a snippet that compares two numbers keeps the sentence between them', () => {
  // A blanket `<[^>]*>` reads everything between a less-than and the next
  // greater-than as a tag and deletes the prose in the middle. Snippets are
  // about arbitrary subjects, so this is not a hypothetical case.
  assert.equal(plainSnippet('5 < 10 and 20 > 15'), '5 < 10 and 20 > 15');
  assert.equal(plainSnippet('if x < y then <em>swap</em> them'), 'if x < y then swap them');
});

test('a result URL the address policy refuses is dropped, and the rest of the page stands', () => {
  const results = normalizeSearchResults(
    [
      { title: 'Fine', url: 'https://example.com/a' },
      { title: 'Metadata', url: 'http://169.254.169.254/latest/meta-data/' },
      { title: 'Intranet', url: 'http://127.0.0.1:8080/admin' },
      { title: 'A local file', url: 'file:///etc/passwd' },
      { title: 'Not a URL', url: 'kettles' },
      { title: 'Also fine', url: 'https://example.com/b' },
    ],
    { count: 10 },
  );
  // One bad row from a ranker is not a reason to fail a search — but it is
  // never a URL an agent is handed either.
  assert.deepEqual(results.map((entry) => entry.title), ['Fine', 'Also fine']);
});

test('count truncates a backend that returned more than it was asked for', () => {
  const rows = Array.from({ length: 12 }, (_unused, index) => ({
    title: `Row ${index}`,
    url: `https://example.com/${index}`,
  }));
  // Returning more is a contract violation, and this is what stops one
  // backend's misbehavior from being visible to a soul.
  assert.equal(normalizeSearchResults(rows, { count: 3 }).length, 3);
});

test('an empty snippet is left off rather than carried as an empty string', () => {
  const [result] = normalizeSearchResults([{ title: 'A', url: 'https://example.com/a', snippet: '   ' }], { count: 1 });
  assert.deepEqual(result, { title: 'A', url: 'https://example.com/a' });
});
