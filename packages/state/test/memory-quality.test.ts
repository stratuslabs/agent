import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildMemoryInjection,
  InMemoryAgentMemoryStore,
  MEMORY_PINNED_MAX_BYTES,
  MEMORY_READ_MAX_BYTES,
  memoryContentByteLength,
  memoryValidityAt,
  renderMemorySection,
  type AgentMemoryStore,
  type MemoryEntry,
} from '@stratusagent/core';

import { createFileMemoryStore, DEFAULT_STRATUS_AGENT, withLegacyDefaultMemories } from '../src/index.ts';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'stratus-memory-quality-'));
const newFile = async (): Promise<string> => path.join(await tempDir(), 'memory.jsonl');

const AT = new Date('2026-06-01T00:00:00.000Z');
const frozen = (at: Date = AT) => ({ now: () => at });

/** The prompt an agent would actually get, as one string. */
const injectedPrompt = async (store: AgentMemoryStore, agentId: string): Promise<string> =>
  renderMemorySection(await buildMemoryInjection(store, agentId)) ?? '';

const lines = async (filePath: string): Promise<string[]> =>
  (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim().length > 0);

test('a line carrying only the four required fields loads, recalls, and reaches the injected prompt', async () => {
  const filePath = await newFile();
  // Written by hand, beside entries that use every field the wider shape
  // added — the case a richer schema is most likely to break.
  await writeFile(filePath, `${JSON.stringify({
    id: 'ava:memory:bare',
    agentId: 'ava',
    content: 'the staging cluster is named tortoise',
    createdAt: '2026-01-01T00:00:00.000Z',
  })}\n`);
  const store = createFileMemoryStore(filePath, frozen());
  await store.append('ava', 'the prod cluster is named hare', {
    kind: 'semantic',
    about: ['clusters'],
    validFrom: '2026-02-01T00:00:00.000Z',
    provenance: { trust: 'agent', origin: { sessionId: 's1' } },
  });

  assert.equal((await store.search('ava', 'tortoise')).entries.length, 1);
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id).includes('ava:memory:bare'), true);
  assert.match(await injectedPrompt(store, 'ava'), /tortoise/);
  // The bare line reads `unknown` and comes back with nothing invented on it.
  const bare = (await store.list('ava')).entries.find((entry) => entry.id === 'ava:memory:bare');
  assert.deepEqual(bare, {
    id: 'ava:memory:bare',
    agentId: 'ava',
    content: 'the staging cluster is named tortoise',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

test('a query matching only an about key finds the entry, in the FTS store as in the in-memory one', async () => {
  const filePath = await newFile();
  const file = createFileMemoryStore(filePath, frozen());
  const reference = new InMemoryAgentMemoryStore(frozen());
  for (const store of [file, reference]) {
    await store.append('ava', 'it now uses Postgres', { about: ['deploy pipeline', 'Hermes'] });
    await store.append('ava', 'nothing to do with any of that', {});
  }
  for (const [label, store] of [['file', file], ['in-memory', reference]] as const) {
    const found = await store.search('ava', 'deploy pipeline');
    assert.equal(found.entries.length, 1, `${label} store missed the alias`);
    assert.equal(found.entries[0]?.content, 'it now uses Postgres');
    assert.deepEqual(found.entries[0]?.about, ['deploy pipeline', 'Hermes']);
    // And the about key survives the round trip through the index.
    assert.equal((await store.search('ava', 'Hermes postgres')).entries.length, 1);
  }
});

test('an out-of-window entry leaves what is true now, stays in search, and comes back marked', async () => {
  const store = createFileMemoryStore(await newFile(), frozen());
  const expired = await store.append('ava', 'Ada works at Northwind', { validUntil: '2026-02-01T00:00:00.000Z' });
  const future = await store.append('ava', 'Ada works at Contoso', { validFrom: '2026-09-01T00:00:00.000Z' });
  const current = await store.append('ava', 'Ada lives in Leeds');

  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [current.id]);
  assert.equal((await injectedPrompt(store, 'ava')).includes('Northwind'), false);
  assert.equal((await injectedPrompt(store, 'ava')).includes('Contoso'), false);

  const found = await store.search('ava', 'Ada');
  assert.equal(found.entries.length, 3);
  const statuses = Object.fromEntries(found.entries.map((entry) => [entry.id, memoryValidityAt(entry, AT)]));
  assert.deepEqual(statuses, { [expired.id]: 'expired', [future.id]: 'not-yet-valid', [current.id]: 'current' });
  // The operator's read shows them; the default one does not.
  assert.equal((await store.list('ava', { validity: 'all' })).entries.length, 3);
});

test('a superseded entry leaves list, search, and the prompt; audit shows both and which replaced which', async () => {
  const filePath = await newFile();
  // Ticking, so the audit read's order is chronology rather than the
  // tie-break on two ids a uuid decides.
  let tick = AT.getTime();
  const store = createFileMemoryStore(filePath, { now: () => new Date((tick += 1000)) });
  const old = await store.append('ava', 'the deploy runs on MySQL', { about: ['deploy'] });
  const next = await store.append('ava', 'the deploy runs on Postgres', { about: ['deploy'], supersedes: old.id });

  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [next.id]);
  assert.deepEqual((await store.search('ava', 'deploy')).entries.map((entry) => entry.id), [next.id]);
  const prompt = await injectedPrompt(store, 'ava');
  assert.match(prompt, /Postgres/);
  assert.doesNotMatch(prompt, /MySQL/);
  // The topic index counts the live fact once, not the retired one too.
  assert.deepEqual((await store.topics!('ava')).map((topic) => `${topic.name}:${topic.count}`), ['deploy:1']);

  const audit = await store.audit('ava');
  assert.deepEqual(audit.map((entry) => entry.id), [old.id, next.id]);
  assert.equal(audit[1]?.supersedes, old.id);
  // One record, so there is no state where the entry is retired with its
  // replacement missing: the revision is exactly one appended line.
  assert.equal((await lines(filePath)).length, 2);
});

test('a crash during a supersession leaves either the whole revision or none of it', async () => {
  const filePath = await newFile();
  let tick = AT.getTime();
  const store = createFileMemoryStore(filePath, { now: () => new Date((tick += 1000)) });
  const old = await store.append('ava', 'the deploy runs on MySQL');
  await store.append('ava', 'the deploy runs on Postgres', { supersedes: old.id });

  // A two-append implementation has a state between its writes: the
  // tombstone landed and the replacement did not, which loses a fact on a
  // crash. One record has no such state, and this is what that means —
  // truncate the file at every line boundary and the old fact is retired
  // only in the prefixes that also carry the entry that retired it.
  const written = await lines(filePath);
  assert.equal(written.length, 2);
  for (let kept = 0; kept <= written.length; kept += 1) {
    const partial = path.join(await tempDir(), 'memory.jsonl');
    await writeFile(partial, written.slice(0, kept).map((line) => `${line}\n`).join(''));
    const crashed = createFileMemoryStore(partial, frozen());
    const live = (await crashed.list('ava', { validity: 'all' })).entries.map((entry) => entry.content);
    const retired = kept > 0 && !live.includes('the deploy runs on MySQL');
    assert.equal(
      retired,
      live.includes('the deploy runs on Postgres'),
      `after ${kept} of ${written.length} lines the record retired a fact without its replacement`,
    );
  }
});

test('a supersession the store refuses appends nothing at all', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const victim = await store.append('juno', 'Juno knows where the runbook lives');
  const before = await lines(filePath);

  await assert.rejects(
    () => store.append('ava', 'that moved last week', { supersedes: victim.id }),
    /No live memory entry with id .* belongs to this agent/,
  );
  // Asserted against the victim's reads rather than the attacker's error —
  // a refusal that still appended the record would pass an error test.
  assert.deepEqual(await lines(filePath), before);
  assert.deepEqual((await store.list('juno')).entries.map((entry) => entry.id), [victim.id]);
  assert.equal((await store.search('juno', 'runbook')).entries.length, 1);
  assert.match(await injectedPrompt(store, 'juno'), /runbook/);
  assert.deepEqual((await store.audit('ava')).map((entry) => entry.id), []);
});

test('a supersession dated from next week leaves the old fact live until then, and an expired one displaces nothing', async () => {
  const filePath = await newFile();
  const before = createFileMemoryStore(filePath, frozen(new Date('2026-06-01T00:00:00.000Z')));
  const old = await before.append('ava', 'Ada works at Northwind');
  await before.append('ava', 'Ada works at Contoso', { supersedes: old.id, validFrom: '2026-06-08T00:00:00.000Z' });

  // Before Monday the old fact stands and the new one is not true yet — the
  // failure this catches is both vanishing from the prompt at once.
  assert.deepEqual((await before.list('ava')).entries.map((entry) => entry.content), ['Ada works at Northwind']);
  assert.match(await injectedPrompt(before, 'ava'), /Northwind/);

  const after = createFileMemoryStore(filePath, frozen(new Date('2026-06-09T00:00:00.000Z')));
  assert.deepEqual((await after.list('ava')).entries.map((entry) => entry.content), ['Ada works at Contoso']);
  assert.match(await injectedPrompt(after, 'ava'), /Contoso/);
  assert.doesNotMatch(await injectedPrompt(after, 'ava'), /Northwind/);

  // An already-expired successor displaces nothing at all.
  const expiredPath = await newFile();
  const store = createFileMemoryStore(expiredPath, frozen());
  const standing = await store.append('ava', 'the rota is weekly');
  await store.append('ava', 'the rota was daily in May', { supersedes: standing.id, validUntil: '2026-05-31T00:00:00.000Z' });
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [standing.id]);
});

test('two processes superseding the same entry retire it once and leave both successors live', async () => {
  const filePath = await newFile();
  const seed = createFileMemoryStore(filePath, frozen());
  const old = await seed.append('ava', 'the deploy runs on MySQL');

  // Separate stores over one file is the concurrency model: `O_APPEND` and
  // nothing else. Both read the same live set and both append.
  const first = createFileMemoryStore(filePath, frozen());
  const second = createFileMemoryStore(filePath, frozen());
  const [a, b] = await Promise.all([
    first.append('ava', 'the deploy runs on Postgres', { supersedes: old.id }),
    second.append('ava', 'the deploy runs on CockroachDB', { supersedes: old.id }),
  ]);

  for (const store of [first, second, createFileMemoryStore(filePath, frozen())]) {
    const live = (await store.list('ava')).entries.map((entry) => entry.id).sort();
    // The invariant is the retirement, not a unique replacement: a test
    // expecting one successor would assert a guarantee this design
    // deliberately does not make.
    assert.deepEqual(live, [a.id, b.id].sort());
  }
});

test('pinning and unpinning leave the entry’s own line byte-identical', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const entry = await store.append('ava', 'the release train leaves on Thursdays');
  const [originalLine] = await lines(filePath);

  assert.equal((await store.pin!('ava', entry.id)).pinned, true);
  assert.equal(await store.unpin!('ava', entry.id), true);
  assert.equal((await lines(filePath))[0], originalLine, 'the entry line was rewritten — pinning must be a record');
  // Three lines: the entry, the pin, the unpin. Nothing was rewritten.
  assert.equal((await lines(filePath)).length, 3);
  assert.deepEqual(await store.pinned!('ava'), []);

  // And the pin survives a fresh store over the same file, which is the
  // daemon reading what the CLI wrote.
  assert.equal((await store.pin!('ava', entry.id)).pinned, true);
  const reopened = createFileMemoryStore(filePath, frozen());
  assert.deepEqual((await reopened.pinned!('ava')).map((pinned) => pinned.id), [entry.id]);
  assert.match(await injectedPrompt(reopened, 'ava'), /Kept in front of you on purpose/);
});

test('a pin past the cap is refused naming the cap, and no existing pin is dropped', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const held = await store.append('ava', 'a'.repeat(MEMORY_PINNED_MAX_BYTES - 100));
  const extra = await store.append('ava', 'b'.repeat(200));
  assert.equal((await store.pin!('ava', held.id)).pinned, true);

  const refused = await store.pin!('ava', extra.id);
  assert.equal(refused.pinned, false);
  assert.match(refused.reason ?? '', new RegExp(`capped at ${MEMORY_PINNED_MAX_BYTES} UTF-8 bytes`));
  assert.deepEqual((await store.pinned!('ava')).map((pinned) => pinned.id), [held.id]);
  // The refusal wrote nothing: two entry lines and one pin.
  assert.equal((await lines(filePath)).length, 3);
});

test('two processes pinning at the cap produce one effective set, with the overflow recorded and inert', async () => {
  const filePath = await newFile();
  const seed = createFileMemoryStore(filePath, frozen());
  // Two entries that fit one at a time and not together.
  const first = await seed.append('ava', 'a'.repeat(1400));
  const second = await seed.append('ava', 'b'.repeat(1400));

  const left = createFileMemoryStore(filePath, frozen());
  const right = createFileMemoryStore(filePath, frozen());
  // Started together, so both read the same total before either appends:
  // the race the write-path check cannot see, since `O_APPEND` is the only
  // coordination between two processes over one file.
  const outcomes = await Promise.all([left.pin!('ava', first.id), right.pin!('ava', second.id)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.pinned), [true, true], 'the race did not happen');

  // Which of the two won is whatever order the appends landed in, and that
  // is the point: replay reads the file, so every reader agrees, and the
  // winner is the record that arrived first rather than whoever read last.
  const pinRecords = (await lines(filePath))
    .map((line) => JSON.parse(line) as { pins?: string })
    .filter((record): record is { pins: string } => typeof record.pins === 'string');
  assert.deepEqual(pinRecords.map((record) => record.pins).sort(), [first.id, second.id].sort());
  const winner = pinRecords[0]!.pins;

  const effective = await Promise.all(
    [left, right, createFileMemoryStore(filePath, frozen())].map(async (store) =>
      (await store.pinned!('ava')).map((pinned) => pinned.id)),
  );
  assert.deepEqual(effective, [[winner], [winner], [winner]]);
  // The overflow is recorded, not lost: its record is in the file and
  // unpinning it is a real operation.
  assert.equal((await lines(filePath)).length, 4);
  assert.equal(await right.unpin!('ava', pinRecords[1]!.pins), true);
});

test('a pin appended later with an earlier or tied timestamp does not displace an already-effective pin', async () => {
  const filePath = await newFile();
  const seed = createFileMemoryStore(filePath, frozen());
  const first = await seed.append('ava', 'a'.repeat(1400));
  const second = await seed.append('ava', 'b'.repeat(1400));
  const third = await seed.append('ava', 'c'.repeat(1400));

  // The records are appended directly, because that is the only way to
  // reach the case: the write-path check refuses the second and third pins
  // when it can see the first, so the losing writes only exist when two
  // processes raced — and a race with a chosen interleaving is a file with
  // a chosen line order.
  const pinRecord = (id: string, createdAt: string): string =>
    `${JSON.stringify({ pins: id, agentId: 'ava', pinned: true, createdAt })}\n`;
  await appendFile(filePath, pinRecord(first.id, '2026-06-01T00:00:00.000Z'));
  // A peer whose clock runs an hour slow, and a peer in the same
  // millisecond. A `(createdAt, id)` key would sort either ahead of the pin
  // already in force and make it inert after the fact, turning the cap's
  // promised refusal into a silent eviction.
  await appendFile(filePath, pinRecord(second.id, '2026-05-31T23:00:00.000Z'));
  await appendFile(filePath, pinRecord(third.id, '2026-06-01T00:00:00.000Z'));

  const store = createFileMemoryStore(filePath, frozen());
  assert.deepEqual((await store.pinned!('ava')).map((pinned) => pinned.id), [first.id]);
  assert.match(await injectedPrompt(store, 'ava'), /a{1400}/);
});

test('an agent cannot pin another agent’s entry, and that entry stays live for its owner', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const victim = await store.append('juno', 'Juno pinned the on-call rota here');
  const before = await lines(filePath);

  await assert.rejects(() => store.pin!('ava', victim.id), /belongs to this agent/);
  assert.deepEqual(await lines(filePath), before);
  assert.deepEqual((await store.list('juno')).entries.map((entry) => entry.id), [victim.id]);
  assert.equal((await store.search('juno', 'rota')).entries.length, 1);
  assert.match(await injectedPrompt(store, 'juno'), /on-call rota/);

  // And a hand-written tombstone naming a stranger's entry is inert: the
  // per-agent boundary is structural, not a rule each writer remembers.
  await appendFile(filePath, `${JSON.stringify({ forgets: victim.id, agentId: 'ava', createdAt: AT.toISOString() })}\n`);
  const reread = createFileMemoryStore(filePath, frozen());
  assert.deepEqual((await reread.list('juno')).entries.map((entry) => entry.id), [victim.id]);
  assert.equal((await reread.search('juno', 'rota')).entries.length, 1);

  // The same for a revision: a stranger's tombstone naming Juno's successor
  // must not bring back the fact that successor retired. The two reads
  // answer from different places — the record and the FTS index — and this
  // is where they would quietly disagree.
  const replaced = await reread.append('juno', 'Juno moved the rota to the wiki', { supersedes: victim.id });
  assert.deepEqual((await reread.search('juno', 'rota')).entries.map((entry) => entry.id), [replaced.id]);
  await appendFile(filePath, `${JSON.stringify({ forgets: replaced.id, agentId: 'ava', createdAt: AT.toISOString() })}\n`);
  const after = createFileMemoryStore(filePath, frozen());
  assert.deepEqual((await after.list('juno')).entries.map((entry) => entry.id), [replaced.id]);
  assert.deepEqual((await after.search('juno', 'rota')).entries.map((entry) => entry.id), [replaced.id]);
});

test('agent A cannot read agent B’s entries with every new field in play', async () => {
  const store = createFileMemoryStore(await newFile(), frozen());
  const junos = await store.append('juno', 'the vault code rotates on Fridays', {
    kind: 'procedural',
    about: ['vault', 'rotation'],
    validUntil: '2027-01-01T00:00:00.000Z',
  });
  await store.pin!('juno', junos.id);
  const avas = await store.append('ava', 'Ava reads the rota', { about: ['rotation'] });

  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [avas.id]);
  assert.deepEqual((await store.search('ava', 'vault')).entries, []);
  assert.deepEqual((await store.search('ava', 'rotation')).entries.map((entry) => entry.id), [avas.id]);
  assert.deepEqual(await store.pinned!('ava'), []);
  assert.deepEqual((await store.topics!('ava')).map((topic) => topic.name), ['rotation']);
  assert.deepEqual((await store.topics!('juno')).map((topic) => topic.name).sort(), ['rotation', 'vault']);
  assert.deepEqual((await store.audit('ava')).map((entry) => entry.id), [avas.id]);
});

test('export then import into an empty store returns the same entries in the same order, re-labelled', async () => {
  let tick = AT.getTime();
  const source = createFileMemoryStore(await newFile(), { now: () => new Date((tick += 1000)) });
  const first = await source.append('ava', 'the rookery survey is quarterly', {
    kind: 'procedural',
    about: ['rookery'],
    provenance: { trust: 'user', origin: { sessionId: 's1' } },
  });
  await source.append('ava', 'the survey moved to monthly', {
    about: ['rookery'],
    supersedes: first.id,
    provenance: { trust: 'agent' },
  });
  await source.append('ava', 'the hide needs repainting', { provenance: { trust: 'user' } });
  const dropped = await source.append('ava', 'a fact the agent took back');
  await source.forget('ava', dropped.id);

  // What `stratus memory export` writes: everything the agent still holds,
  // superseded entries included — the successor carries its own retirement,
  // so the revision travels with it. A forgotten entry cannot: its
  // tombstone is a record, and a file of entries has nowhere to put one.
  const exported = (await source.audit('ava')).filter((entry) => entry.forgottenAt === undefined);
  assert.deepEqual(exported.map((entry) => entry.content), [
    'the rookery survey is quarterly',
    'the survey moved to monthly',
    'the hide needs repainting',
  ]);

  const target = createFileMemoryStore(await newFile(), frozen());
  // The default trip: an imported entry lands `external`, because a file
  // from elsewhere may repeat what a stranger wrote.
  const relabelled = exported.map((entry) => ({ ...entry, trust: 'external' as const }));
  assert.deepEqual(await target.importEntries!('ava', relabelled), { imported: 3, skipped: [] });
  const back = (await target.list('ava', { validity: 'all' })).entries;
  // Entries and order, not labels — expecting provenance to survive would
  // be asserting that the import safety rule does not work.
  assert.deepEqual(back.map((entry) => entry.id), exported.filter((entry) => entry.id !== first.id).map((entry) => entry.id));
  assert.deepEqual(back.map((entry) => entry.trust), ['external', 'external']);
  assert.deepEqual((await target.audit('ava')).map((entry) => entry.content), exported.map((entry) => entry.content));
  assert.deepEqual((await target.audit('ava')).map((entry) => entry.about), exported.map((entry) => entry.about));
  // The revision came with the successor, so the imported corpus is live in
  // exactly the shape it left: the superseded fact is retired here too.
  assert.equal((await target.list('ava')).entries.length, 2);
  // And the entry the agent took back stayed behind.
  assert.equal((await target.search('ava', 'took back')).entries.length, 0);

  // Under the operator's preserving flag, trust survives — the migration
  // path, and the half a default-only test never reaches.
  const migrated = createFileMemoryStore(await newFile(), frozen());
  await migrated.importEntries!('ava', exported);
  assert.deepEqual((await migrated.audit('ava')).map((entry) => entry.trust), exported.map((entry) => entry.trust));
  // Re-running an import is a no-op rather than a second copy.
  assert.deepEqual((await migrated.importEntries!('ava', exported)).imported, 0);
  assert.equal((await migrated.audit('ava')).length, 3);
});

test('both stores answer a recency read identically, ties included, with every new field in play', async () => {
  // A clock that ticks, so the ordering under test is `createdAt` and not
  // the tie-break — the two stores mint different ids by design, so a tie
  // between them has no shared answer and is asserted per store below.
  const ticking = (): { now: () => Date } => {
    let tick = AT.getTime();
    return { now: () => new Date((tick += 1000)) };
  };
  const file = createFileMemoryStore(await newFile(), ticking());
  const reference = new InMemoryAgentMemoryStore(ticking());
  const seed = async (store: AgentMemoryStore): Promise<void> => {
    const first = await store.append('ava', 'the survey is quarterly', { kind: 'procedural', about: ['rookery'] });
    await store.append('ava', 'the survey is monthly', { about: ['rookery'], supersedes: first.id });
    await store.append('ava', 'the hide is closed in winter', { about: ['hide'], validUntil: '2026-03-01T00:00:00.000Z' });
    await store.append('ava', 'the path floods in spring', { about: ['path'] });
  };
  await seed(file);
  await seed(reference);

  const shape = (entries: readonly MemoryEntry[]): string[] => entries.map((entry) => entry.content);
  assert.deepEqual(shape((await file.list('ava', { limit: 10 })).entries), shape((await reference.list('ava', { limit: 10 })).entries));
  assert.deepEqual(shape((await file.list('ava', { limit: 10, validity: 'all' })).entries), shape((await reference.list('ava', { limit: 10, validity: 'all' })).entries));
  assert.deepEqual(shape((await file.search('ava', 'the')).entries), shape((await reference.search('ava', 'the')).entries));
  assert.deepEqual(shape((await file.search('ava', 'rookery')).entries), shape((await reference.search('ava', 'rookery')).entries));
  assert.deepEqual(await file.topics!('ava'), await reference.topics!('ava'));
  assert.equal((await file.search('ava', 'the')).strategy, (await reference.search('ava', 'the')).strategy);
  assert.equal(
    renderMemorySection(await buildMemoryInjection(file, 'ava')),
    renderMemorySection(await buildMemoryInjection(reference, 'ava')),
  );

  // The tie itself: equal `createdAt` orders by ascending id, which is the
  // rule each store has to apply to whatever ids it mints.
  for (const tied of [createFileMemoryStore(await newFile(), frozen()), new InMemoryAgentMemoryStore(frozen())]) {
    for (let index = 0; index < 6; index += 1) {
      await tied.append('ava', `tied fact ${index}`);
    }
    const recalled = (await tied.search('ava', 'tied fact')).entries;
    assert.deepEqual(recalled.map((entry) => entry.id), [...recalled].map((entry) => entry.id).sort());
  }
});

test('one corpus imported for two agents keeps each agent’s revision, in list and in search alike', async () => {
  // Import preserves entry ids while re-keying entries to the importing
  // agent, so the same successor id legitimately exists twice. The FTS
  // index computes supersession from its own table, and a row keyed by the
  // successor alone would let the second import overwrite the first
  // agent's revision — visible only in `search`, since `list` answers from
  // the record.
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const corpus: MemoryEntry[] = [
    { id: 'shared:1', agentId: 'somewhere', content: 'the deploy runs on MySQL', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'shared:2', agentId: 'somewhere', content: 'the deploy runs on Postgres', createdAt: '2026-01-02T00:00:00.000Z', supersedes: 'shared:1' },
  ];
  await store.importEntries!('ava', corpus);
  await store.importEntries!('juno', corpus);

  for (const agentId of ['ava', 'juno']) {
    assert.deepEqual((await store.list(agentId)).entries.map((entry) => entry.id), ['shared:2'], agentId);
    assert.deepEqual((await store.search(agentId, 'deploy')).entries.map((entry) => entry.id), ['shared:2'], agentId);
  }
});

test('the pinned core is one budget for an agent’s legacy aliases, not one each', async () => {
  const filePath = await newFile();
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));
  // The default agent inherits entries written under the ids older builds
  // used. Each of those is a separate key in the record, so each would
  // otherwise accept its own 2 KiB of pins — and the merged set would then
  // be trimmed by recency in the injected slice, which is the silent
  // eviction the cap promises never happens.
  const current = await store.append(DEFAULT_STRATUS_AGENT.id, 'a'.repeat(1400));
  await appendFile(filePath, `${JSON.stringify({
    id: 'demo-agent:memory:legacy',
    agentId: 'demo-agent',
    content: 'b'.repeat(1400),
    createdAt: '2026-01-01T00:00:00.000Z',
  })}\n`);

  assert.equal((await store.pin!(DEFAULT_STRATUS_AGENT.id, current.id)).pinned, true);
  // The alias store would accept this one against its own empty budget, so
  // the wrapper has to refuse on the merged total — telling the caller it
  // was pinned when the merged replay makes it inert is the eviction the
  // cap promises never happens, wearing a different hat.
  const refused = await store.pin!(DEFAULT_STRATUS_AGENT.id, 'demo-agent:memory:legacy');
  assert.equal(refused.pinned, false);
  assert.match(refused.reason ?? '', new RegExp(`capped at ${MEMORY_PINNED_MAX_BYTES} UTF-8 bytes`));

  const pinned = await store.pinned!(DEFAULT_STRATUS_AGENT.id);
  const bytes = pinned.reduce((sum, entry) => sum + memoryContentByteLength(entry.content), 0);
  assert.ok(bytes <= MEMORY_PINNED_MAX_BYTES, `the merged pinned core held ${bytes} bytes`);
  assert.deepEqual(pinned.map((entry) => entry.id), [current.id]);
  // And the slice takes it as given rather than trimming it, which is what
  // "refuses rather than evicts" has to mean once the merge is in play.
  const injection = await buildMemoryInjection(store, DEFAULT_STRATUS_AGENT.id);
  assert.deepEqual(injection.pinned.map((entry) => entry.id), [current.id]);
});

test('the file store’s usage counters are keyed by agent, and an older index is rebuilt for it', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const shared: MemoryEntry = {
    id: 'shared:1',
    agentId: 'somewhere',
    content: 'the survey is quarterly',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await store.importEntries!('ava', [shared]);
  await store.importEntries!('juno', [shared]);

  assert.equal((await store.search('juno', 'survey')).entries[0]?.usage?.recallCount, 1);
  assert.equal((await store.search('juno', 'survey')).entries[0]?.usage?.recallCount, 2);
  assert.equal((await store.search('ava', 'survey')).entries[0]?.usage?.recallCount, 1);

  // An index whose `usage` is keyed by id alone attributes one agent's
  // reads to the other, so it is dropped rather than carried forward —
  // losing statistics is the stated cost of a derived file, and a counter
  // on the wrong agent is worse than no counter.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${filePath}.index`);
  db.exec('DROP TABLE usage');
  db.exec('CREATE TABLE usage (id TEXT PRIMARY KEY, recall_count INTEGER NOT NULL, last_recalled_at TEXT NOT NULL)');
  db.exec("INSERT INTO usage (id, recall_count, last_recalled_at) VALUES ('shared:1', 99, '2026-01-01T00:00:00.000Z')");
  db.close();

  const reopened = createFileMemoryStore(filePath, frozen());
  assert.equal((await reopened.search('ava', 'survey')).entries[0]?.usage?.recallCount, 1);
  assert.deepEqual((await reopened.search('ava', 'survey')).entries.map((entry) => entry.content), ['the survey is quarterly']);
});

test('a pin keeps its budget while superseded, so a later pin cannot be accepted and then dropped', async () => {
  const filePath = await newFile();
  let tick = AT.getTime();
  const store = createFileMemoryStore(filePath, { now: () => new Date((tick += 1000)) });
  const held = await store.append('ava', 'a'.repeat(1500));
  assert.equal((await store.pin!('ava', held.id)).pinned, true);

  // Superseded, so it leaves the prompt — but its bytes are a property of
  // the record, not of the clock, and must not be handed to the next pin.
  const successor = await store.append('ava', 'the replacement', { supersedes: held.id });
  assert.deepEqual(await store.pinned!('ava'), []);
  const later = await store.append('ava', 'b'.repeat(1000));
  const refused = await store.pin!('ava', later.id);
  assert.equal(refused.pinned, false, 'the superseded pin gave up its budget');

  // Because it was refused, forgetting the successor brings the original
  // back with nothing displaced. Had the later pin been accepted, this is
  // where it would have gone silently inert.
  assert.equal(await store.forget('ava', successor.id), true);
  assert.deepEqual((await store.pinned!('ava')).map((entry) => entry.id), [held.id]);
});

test('a pin outside its validity window holds budget and is visible to an operator', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, frozen());
  const future = await store.append('ava', 'a'.repeat(1500), { validFrom: '2027-01-01T00:00:00.000Z' });
  assert.equal((await store.pin!('ava', future.id)).pinned, true);

  // Not in the prompt — one rule, both bounds — but still holding the
  // budget, which is what makes the next pin refuse.
  assert.deepEqual(await store.pinned!('ava'), []);
  const later = await store.append('ava', 'b'.repeat(1000));
  assert.equal((await store.pin!('ava', later.id)).pinned, false);
  // And the operator's view can see the one holding the space, or the
  // refusal reads as arithmetic that does not add up.
  assert.deepEqual((await store.pinned!('ava', { include: 'allocated' })).map((entry) => entry.id), [future.id]);
});

test('two agents holding one imported id keep their own re-assertions, in list and in search alike', async () => {
  const filePath = await newFile();
  const entry = (agentId: string): string => JSON.stringify({
    id: 'shared:1',
    agentId,
    content: 'the survey is quarterly',
    createdAt: '2026-01-01T00:00:00.000Z',
    trust: 'external',
  });
  const reassertion = (agentId: string, trust: string): string => JSON.stringify({
    reasserts: 'shared:1',
    agentId,
    trust,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  // Both re-assertions ahead of both entries: a hand-edited or reordered
  // file, which the record read is order-independent about on purpose. The
  // index has to be too — and an index keyed by entry alone lets the
  // second re-assertion overwrite the first, so one agent's `search`
  // reports the other's label while its `list` reports the right one.
  await writeFile(filePath, [
    reassertion('ava', 'user'),
    reassertion('juno', 'agent'),
    entry('ava'),
    entry('juno'),
    '',
  ].join('\n'));

  const store = createFileMemoryStore(filePath, frozen());
  assert.equal((await store.list('ava')).entries[0]?.trust, 'user');
  assert.equal((await store.list('juno')).entries[0]?.trust, 'agent');
  assert.equal((await store.search('ava', 'survey')).entries[0]?.trust, 'user');
  assert.equal((await store.search('juno', 'survey')).entries[0]?.trust, 'agent');
});

test('the merged alias budget counts a superseded pin, which the aliases still reserve', async () => {
  const filePath = await newFile();
  let tick = AT.getTime();
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, { now: () => new Date((tick += 1000)) }));
  // A pinned fact under the current id, then superseded: each store keeps
  // reserving its bytes, so the wrapper must see them too — a merged budget
  // that asked only for what renders would hand the space to a legacy pin
  // and drop it again the moment the successor was forgotten.
  const held = await store.append(DEFAULT_STRATUS_AGENT.id, 'a'.repeat(1500));
  assert.equal((await store.pin!(DEFAULT_STRATUS_AGENT.id, held.id)).pinned, true);
  const successor = await store.append(DEFAULT_STRATUS_AGENT.id, 'the replacement', { supersedes: held.id });
  await appendFile(filePath, `${JSON.stringify({
    id: 'demo-agent:memory:legacy',
    agentId: 'demo-agent',
    content: 'b'.repeat(1000),
    createdAt: '2026-01-01T00:00:00.000Z',
  })}\n`);

  assert.deepEqual(await store.pinned!(DEFAULT_STRATUS_AGENT.id), []);
  assert.equal((await store.pin!(DEFAULT_STRATUS_AGENT.id, 'demo-agent:memory:legacy')).pinned, false);
  // And the reserved one is visible to an operator under `allocated`.
  assert.deepEqual(
    (await store.pinned!(DEFAULT_STRATUS_AGENT.id, { include: 'allocated' })).map((entry) => entry.id),
    [held.id],
  );
  // Forgetting the successor brings it back with nothing displaced.
  assert.equal(await store.forget(DEFAULT_STRATUS_AGENT.id, successor.id), true);
  assert.deepEqual((await store.pinned!(DEFAULT_STRATUS_AGENT.id)).map((entry) => entry.id), [held.id]);
});

test('an inherited legacy memory can be superseded, by the id recall handed out', async () => {
  const filePath = await newFile();
  let tick = AT.getTime();
  await writeFile(filePath, `${JSON.stringify({
    id: 'demo-agent:memory:1',
    agentId: 'demo-agent',
    content: 'the deploy runs on MySQL',
    createdAt: '2026-01-01T00:00:00.000Z',
  })}\n`);
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, { now: () => new Date((tick += 1000)) }));

  // `recall` surfaces the inherited entry under its legacy id, and the tool
  // tells the model to supersede by recalled id — so the revision has to be
  // filed where the fact it retires lives, or every inherited fact is
  // unrevisable.
  const recalled = (await store.search(DEFAULT_STRATUS_AGENT.id, 'deploy')).entries[0]!;
  assert.equal(recalled.id, 'demo-agent:memory:1');
  const revision = await store.append(DEFAULT_STRATUS_AGENT.id, 'the deploy runs on Postgres', { supersedes: recalled.id });

  assert.deepEqual((await store.list(DEFAULT_STRATUS_AGENT.id)).entries.map((entry) => entry.content), ['the deploy runs on Postgres']);
  assert.deepEqual((await store.search(DEFAULT_STRATUS_AGENT.id, 'deploy')).entries.map((entry) => entry.id), [revision.id]);
  // An id belonging to nobody still refuses, in the store's own words.
  await assert.rejects(
    () => store.append(DEFAULT_STRATUS_AGENT.id, 'not mine', { supersedes: 'someone:else:1' }),
    /belongs to this agent/,
  );
});

test('an oversized match never starves the admissible ones behind it', async () => {
  const filePath = await newFile();
  let tick = AT.getTime();
  const store = createFileMemoryStore(filePath, { now: () => new Date((tick += 1000)) });
  // Hand-written, from before the per-entry cap: each is larger than any
  // bounded read could admit. `boundMemoryRead` skips such an entry rather
  // than letting it starve the read — but it can only skip what it was
  // handed, and a limit filled with these would hand it nothing else.
  for (let index = 0; index < 5; index += 1) {
    await appendFile(filePath, `${JSON.stringify({
      id: `ava:memory:huge-${index}`,
      agentId: 'ava',
      content: `rookery ${'x'.repeat(MEMORY_READ_MAX_BYTES + 10)}`,
      createdAt: `2026-03-0${index + 1}T00:00:00.000Z`,
    })}\n`);
  }
  await appendFile(filePath, `${JSON.stringify({
    id: 'ava:memory:small',
    agentId: 'ava',
    content: 'the rookery survey is quarterly',
    createdAt: '2026-01-01T00:00:00.000Z',
  })}\n`);

  const found = await store.search('ava', 'rookery', { limit: 3 });
  assert.deepEqual(found.entries.map((entry) => entry.id), ['ava:memory:small']);
  // The skipped ones are still live entries beyond what came back.
  assert.equal(found.truncated, true);
});

test('one id under two aliases resolves to one entry, the earlier alias winning', async () => {
  const filePath = await newFile();
  // A hand-edited file can put one id under the default agent and under a
  // legacy alias it inherits. Returning both hands the model two entries it
  // cannot tell apart, and every mutator takes an id and resolves it
  // through the aliases in this same order — so only the first was ever
  // addressable, and showing the second promised something the wrapper
  // could not keep.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'the inherited copy of the rota', createdAt: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the current copy of the rota', createdAt: '2026-01-02T00:00:00.000Z' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  const listed = (await store.list(DEFAULT_STRATUS_AGENT.id)).entries;
  assert.deepEqual(listed.map((entry) => entry.content), ['the current copy of the rota']);
  assert.deepEqual((await store.search(DEFAULT_STRATUS_AGENT.id, 'rota')).entries.map((entry) => entry.id), ['shared:1']);
  // Precedence belongs to the id, not to the query: a query that matches
  // only the inherited copy must not recall it, or the model would revise
  // a fact it never read — every id-based mutation resolves to the current
  // copy, which is the one `list` showed.
  assert.deepEqual((await store.search(DEFAULT_STRATUS_AGENT.id, 'inherited')).entries, []);
  assert.deepEqual(
    (await store.search(DEFAULT_STRATUS_AGENT.id, 'current')).entries.map((entry) => entry.content),
    ['the current copy of the rota'],
  );
  // The audit read keeps both, because saying what the record holds is the
  // one job it has.
  assert.equal((await store.audit(DEFAULT_STRATUS_AGENT.id)).filter((entry) => entry.id === 'shared:1').length, 2);
  // And the mutators reach the one the reads showed. Unpinning is the
  // exception that proves the rule: it clears every alias, because the
  // merged view says the id is one entry and a pin left under the other
  // would go on holding budget with nothing admitting it.
  assert.equal((await store.pin!(DEFAULT_STRATUS_AGENT.id, 'shared:1')).pinned, true);
  assert.deepEqual((await store.pinned!(DEFAULT_STRATUS_AGENT.id)).map((entry) => entry.content), ['the current copy of the rota']);
  assert.equal(await store.unpin!(DEFAULT_STRATUS_AGENT.id, 'shared:1'), true);
  assert.deepEqual(await store.pinned!(DEFAULT_STRATUS_AGENT.id, { include: 'allocated' }), []);

  assert.equal(await store.forget(DEFAULT_STRATUS_AGENT.id, 'shared:1'), true);
  assert.deepEqual((await store.list(DEFAULT_STRATUS_AGENT.id)).entries.map((entry) => entry.content), ['the inherited copy of the rota']);
});

test('the current owner of an id wins a bounded list even when its own window dropped it', async () => {
  const filePath = await newFile();
  // The current alias holds `shared:1`, but as its *oldest* entry, so its
  // own bounded batch never returns it — while the inherited copy carries a
  // newer timestamp and sorts straight into the merged window. Picking the
  // first alias that *returned* an id is not the same rule as picking the
  // first alias that *holds* it, and the difference here injects content
  // that forget, pin, and supersession all resolve somewhere else.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the current copy of the rota', createdAt: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'stratus:memory:2', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the rookery survey is quarterly', createdAt: '2026-02-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'stratus:memory:3', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the deploy runs on Postgres', createdAt: '2026-03-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'the inherited copy of the rota', createdAt: '2026-05-01T00:00:00.000Z' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  const listed = await store.list(DEFAULT_STRATUS_AGENT.id, { limit: 2 });
  assert.deepEqual(listed.entries.map((entry) => entry.id), ['stratus:memory:2', 'stratus:memory:3']);
  assert.equal(listed.truncated, true);
  // And the prompt the agent actually gets carries the same answer.
  const prompt = await injectedPrompt(store, DEFAULT_STRATUS_AGENT.id);
  assert.ok(prompt.includes('the current copy of the rota'));
  assert.ok(!prompt.includes('the inherited copy of the rota'));
});

test('a bounded search refills an alias whose whole batch the current owner shadowed', async () => {
  const filePath = await newFile();
  // Both of the legacy alias's newest matches are ids the current alias
  // owns, and the current alias's copies do not match the query — so the
  // ownership filter is right to discard the whole batch. What it must not
  // do is stop there: the unshadowed match sat one row past the bound the
  // alias was asked for, and reporting `truncated` over an empty page hides
  // a fact the single-alias path would have returned.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the rota is on Tuesdays', createdAt: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:2', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the deploy runs on Postgres', createdAt: '2026-01-02T00:00:00.000Z' }),
    JSON.stringify({ id: 'demo-agent:memory:3', agentId: 'demo-agent', content: 'the rookery survey is quarterly', createdAt: '2026-02-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'the rookery gate code changed', createdAt: '2026-03-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:2', agentId: 'demo-agent', content: 'the rookery path floods', createdAt: '2026-04-01T00:00:00.000Z' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  const found = await store.search(DEFAULT_STRATUS_AGENT.id, 'rookery', { limit: 2 });
  assert.deepEqual(found.entries.map((entry) => entry.id), ['demo-agent:memory:3']);
  assert.equal(found.truncated, false);
});

test('the topic index follows the same id precedence every other read does', async () => {
  const filePath = await newFile();
  // Per-alias topic lists are already aggregated, so merging them has no
  // way left to apply precedence: the copy `list` and `search` hide counts
  // again, contributes its own `about` spelling, and — the part that
  // reaches past the block — drags the topic's trust down to `external`,
  // which the runner folds into the taint of the whole session.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the rota is on Tuesdays', createdAt: '2026-01-01T00:00:00.000Z', about: ['rota'], trust: 'agent' }),
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'a page said the rota moved', createdAt: '2026-02-01T00:00:00.000Z', about: ['rota', 'scraped-page'], trust: 'external' }),
    JSON.stringify({ id: 'demo-agent:memory:2', agentId: 'demo-agent', content: 'the rookery survey is quarterly', createdAt: '2026-03-01T00:00:00.000Z', about: ['rookery'], trust: 'agent' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  const topics = await store.topics!(DEFAULT_STRATUS_AGENT.id);
  assert.deepEqual(topics.map((topic) => [topic.name, topic.count, topic.trust]), [
    ['rookery', 1, 'agent'],
    ['rota', 1, 'agent'],
  ]);
  assert.ok(!(await injectedPrompt(store, DEFAULT_STRATUS_AGENT.id)).includes('scraped-page'));
});

test('a pin refuses while an inert pin stands in front of it, however small it is', async () => {
  const filePath = await newFile();
  // Written as records rather than through `pin`, because the write path
  // refuses an over-cap pin: an inert one only arises from the two-process
  // race the budget resolves on replay, and the file store is the one whose
  // record lane can represent that race deterministically. The guard the
  // test covers is the same three lines in all three stores.
  await writeFile(filePath, [
    JSON.stringify({ id: 'ava:memory:1', agentId: 'ava', content: 'a'.repeat(1500), createdAt: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'ava:memory:2', agentId: 'ava', content: 'b'.repeat(1000), createdAt: '2026-01-02T00:00:00.000Z' }),
    JSON.stringify({ id: 'ava:memory:3', agentId: 'ava', content: 'the rota is on Tuesdays', createdAt: '2026-01-03T00:00:00.000Z' }),
    // Both accepted by their own process against a total that did not yet
    // include the other; replay puts the second behind the cap.
    JSON.stringify({ pins: 'ava:memory:1', agentId: 'ava', pinned: true, createdAt: '2026-01-04T00:00:00.000Z' }),
    JSON.stringify({ pins: 'ava:memory:2', agentId: 'ava', pinned: true, createdAt: '2026-01-04T00:00:00.000Z' }),
    '',
  ].join('\n'));
  const store = createFileMemoryStore(filePath, frozen());
  assert.deepEqual((await store.pinned!('ava')).map((entry) => entry.id), ['ava:memory:1']);

  // The effective set holds 1500 of 2048, so a 23-byte fact clears the byte
  // total — and lands behind the inert pin, where the prefix rule makes it
  // inert too. Reporting success here is the eviction the cap promises
  // never happens, wearing the refusal's clothes.
  const outcome = await store.pin!('ava', 'ava:memory:3');
  assert.equal(outcome.pinned, false);
  assert.match(outcome.reason ?? '', /ava:memory:2/);
  assert.deepEqual((await store.pinned!('ava')).map((entry) => entry.id), ['ava:memory:1']);
  // And nothing was written: the refusal is the whole of it.
  assert.equal((await lines(filePath)).filter((line) => line.includes('"pins"')).length, 2);
});

test('the pinned core follows id precedence even though a pin read cannot see the owner', async () => {
  const filePath = await newFile();
  // The current alias owns `shared:1` and has not pinned it, so it is absent
  // from every pin-only batch — there is nothing there to out-rank the
  // legacy copy, and de-duplicating the batches alone would put inherited
  // content into the one block the agent always reads.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the current copy of the rota', createdAt: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'the inherited copy of the rota', createdAt: '2026-02-01T00:00:00.000Z' }),
    JSON.stringify({ pins: 'shared:1', agentId: 'demo-agent', pinned: true, createdAt: '2026-03-01T00:00:00.000Z' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  assert.deepEqual(await store.pinned!(DEFAULT_STRATUS_AGENT.id), []);
  assert.deepEqual(await store.pinned!(DEFAULT_STRATUS_AGENT.id, { include: 'allocated' }), []);
  const prompt = await injectedPrompt(store, DEFAULT_STRATUS_AGENT.id);
  assert.ok(prompt.includes('the current copy of the rota'));
  assert.ok(!prompt.includes('the inherited copy of the rota'));
});

test('a legacy alias alone in the topic index is not evidence that it owns the id', async () => {
  const filePath = await newFile();
  // The current alias owns `shared:1` and its copy carries no `about`, so it
  // contributes no topics at all. A shortcut that asked "did only one alias
  // contribute?" therefore saw one list and took it — handing the prompt a
  // topic from the copy every other read hides, at the hidden copy's trust.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the rota is on Tuesdays', createdAt: '2026-01-01T00:00:00.000Z', trust: 'agent' }),
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'a page said the rota moved', createdAt: '2026-02-01T00:00:00.000Z', about: ['scraped-page'], trust: 'external' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  assert.deepEqual(await store.topics!(DEFAULT_STRATUS_AGENT.id), []);
  assert.ok(!(await injectedPrompt(store, DEFAULT_STRATUS_AGENT.id)).includes('scraped-page'));
});

test('a pin is current by its owning copy, not by whichever alias holds one', async () => {
  const filePath = await newFile();
  // `merged` correctly picks the `stratus` copy of `shared:1`, which is
  // expired. The question "is this pin current" is then asked of an id-only
  // set pooled across the aliases — so the legacy copy, which is current,
  // answered for it and the expired content reached the pinned core.
  await writeFile(filePath, [
    JSON.stringify({ id: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the current copy of the rota', createdAt: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'shared:1', agentId: 'demo-agent', content: 'the inherited copy of the rota', createdAt: '2026-01-02T00:00:00.000Z' }),
    JSON.stringify({ pins: 'shared:1', agentId: DEFAULT_STRATUS_AGENT.id, pinned: true, createdAt: '2026-01-03T00:00:00.000Z' }),
    JSON.stringify({ pins: 'shared:1', agentId: 'demo-agent', pinned: true, createdAt: '2026-01-04T00:00:00.000Z' }),
    '',
  ].join('\n'));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, frozen()));

  // Expired on the copy that owns the id, so nothing renders — one rule,
  // both bounds, the pinned core included.
  assert.deepEqual(await store.pinned!(DEFAULT_STRATUS_AGENT.id), []);
  // It still holds its budget, which is a property of the record.
  assert.deepEqual(
    (await store.pinned!(DEFAULT_STRATUS_AGENT.id, { include: 'allocated' })).map((entry) => entry.content),
    ['the current copy of the rota'],
  );
  assert.ok(!(await injectedPrompt(store, DEFAULT_STRATUS_AGENT.id)).includes('inherited copy'));
});
