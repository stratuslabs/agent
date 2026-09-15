import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildMemoryInjection,
  InMemoryAgentMemoryStore,
  MEMORY_PINNED_MAX_BYTES,
  memoryValidityAt,
  renderMemorySection,
  type AgentMemoryStore,
  type MemoryEntry,
} from '@stratusagent/core';

import { createFileMemoryStore } from '../src/index.ts';

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
  await Promise.all([left.pin!('ava', first.id), right.pin!('ava', second.id)]);

  const effective = await Promise.all(
    [left, right, createFileMemoryStore(filePath, frozen())].map(async (store) =>
      (await store.pinned!('ava')).map((pinned) => pinned.id)),
  );
  // One effective set, identical in all of them — replay decides, in file
  // order, rather than whichever process happened to read last.
  assert.deepEqual(effective, [[first.id], [first.id], [first.id]]);
  // The overflow is recorded, not lost: its record is in the file and
  // unpinning it is a real operation.
  assert.equal((await lines(filePath)).length, 4);
  assert.equal(await right.unpin!('ava', second.id), true);
});

test('a pin appended later with an earlier or tied timestamp does not displace an already-effective pin', async () => {
  const filePath = await newFile();
  const seed = createFileMemoryStore(filePath, frozen());
  const first = await seed.append('ava', 'a'.repeat(1400));
  const second = await seed.append('ava', 'b'.repeat(1400));
  const third = await seed.append('ava', 'c'.repeat(1400));

  // The accepted pin, on the clock everyone else agrees about.
  await createFileMemoryStore(filePath, frozen(new Date('2026-06-01T00:00:00.000Z'))).pin!('ava', first.id);
  // A peer whose clock runs an hour slow, and a peer in the same
  // millisecond. A `(createdAt, id)` key would sort either ahead of the pin
  // already in force and make it inert after the fact.
  await createFileMemoryStore(filePath, frozen(new Date('2026-05-31T23:00:00.000Z'))).pin!('ava', second.id);
  await createFileMemoryStore(filePath, frozen(new Date('2026-06-01T00:00:00.000Z'))).pin!('ava', third.id);

  const store = createFileMemoryStore(filePath, frozen());
  assert.deepEqual((await store.pinned!('ava')).map((pinned) => pinned.id), [first.id]);
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
