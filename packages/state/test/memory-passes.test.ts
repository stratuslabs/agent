import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MemoryEntry } from '@stratusagent/core';

import {
  agentMemoryPassesFileIn,
  agentMemoryShadowFileIn,
  createFileMemoryStore,
  createMemoryPassLedger,
  memoryPassActivations,
  memoryPassEntries,
  memoryPassMessageCounts,
  memoryPassOpenClaims,
  memoryPassSettleRecord,
  memoryPassWatermark,
  undoMemoryPass,
  type MemoryPassRecord,
} from '../src/index.ts';

const start = (at: string, run: string, mode: 'write' | 'shadow' = 'write'): MemoryPassRecord =>
  ({ type: 'start', at, run, mode });
const stop = (at: string, run: string, mode: 'write' | 'shadow' = 'write'): MemoryPassRecord =>
  ({ type: 'stop', at, run, mode });
const claim = (
  at: string,
  run: string,
  passId: string,
  sessionId: string,
  from: string,
  to: string,
  mode: 'write' | 'shadow' = 'write',
): MemoryPassRecord => ({
  type: 'claim', at, run, passId, kind: 'save', mode, model: 'm', sessionId, slice: { from, to, count: 1 },
});
const end = (at: string, run: string, passId: string, released: boolean): MemoryPassRecord => ({
  type: 'end', at, run, passId, status: released ? 'failed' : 'done', saved: released ? 0 : 1, superseded: 0, released,
});

test('an activation runs from its start to its stop, and the current run stays open', () => {
  const records = [
    start('2026-11-01T01:00:00.000Z', 'r1'),
    stop('2026-11-01T02:00:00.000Z', 'r1'),
    start('2026-11-01T03:00:00.000Z', 'r2'),
  ];
  assert.deepEqual(memoryPassActivations(records, 'write', 'r2'), [
    { mode: 'write', run: 'r1', from: '2026-11-01T01:00:00.000Z', to: '2026-11-01T02:00:00.000Z' },
    { mode: 'write', run: 'r2', from: '2026-11-01T03:00:00.000Z' },
  ]);
});

test('a crashed run ends at its last ledger record, and a settle written by the next run does not stretch it', () => {
  const records = [
    start('2026-11-01T01:00:00.000Z', 'r1'),
    start('2026-11-01T01:00:01.000Z', 'r1', 'shadow'),
    claim('2026-11-01T01:30:00.000Z', 'r1', 'p1', 's1', 'a', 'b', 'shadow'),
    // r1 crashed here: no end for p1, no stop records.
    start('2026-11-01T05:00:00.000Z', 'r2'),
    end('2026-11-01T05:00:01.000Z', 'r2', 'p1', true),
  ];
  // Any record of the run proves the daemon was up then, so the write
  // activation ends at the shadow claim too.
  assert.deepEqual(memoryPassActivations(records, 'write', 'r2'), [
    { mode: 'write', run: 'r1', from: '2026-11-01T01:00:00.000Z', to: '2026-11-01T01:30:00.000Z' },
    { mode: 'write', run: 'r2', from: '2026-11-01T05:00:00.000Z' },
  ]);
  // Asked with no current run (the CLI), every run is closed.
  assert.equal(memoryPassActivations(records, 'write').at(-1)?.to, '2026-11-01T05:00:01.000Z');
});

test('the modes keep separate activations', () => {
  const records = [start('2026-11-01T01:00:00.000Z', 'r1', 'shadow'), stop('2026-11-01T02:00:00.000Z', 'r1', 'shadow')];
  assert.deepEqual(memoryPassActivations(records, 'write', 'r1'), []);
  assert.equal(memoryPassActivations(records, 'shadow', 'r1').length, 1);
});

test('a message counts only when its createdAt falls inside an activation', () => {
  const activations = memoryPassActivations([
    start('2026-11-01T01:00:00.000Z', 'r1'),
    stop('2026-11-01T02:00:00.000Z', 'r1'),
    start('2026-11-01T03:00:00.000Z', 'r2'),
  ], 'write', 'r2');
  const counts = memoryPassMessageCounts(activations);
  assert.equal(counts('2026-11-01T00:59:59.999Z'), false, 'before upkeep started');
  assert.equal(counts('2026-11-01T01:00:00.000Z'), true);
  assert.equal(counts('2026-11-01T02:00:00.000Z'), true);
  assert.equal(counts('2026-11-01T02:30:00.000Z'), false, 'in the gap while it was off');
  assert.equal(counts('2026-11-01T09:00:00.000Z'), true, 'the open activation');
  assert.equal(counts('not a date'), false, 'an unparseable time is outside every activation');
});

test('the watermark is where the newest kept claim ended; a released claim moves nothing', () => {
  const records = [
    start('2026-11-01T01:00:00.000Z', 'r1'),
    claim('2026-11-01T01:10:00.000Z', 'r1', 'p1', 's1', 'm1', 'm4'),
    end('2026-11-01T01:11:00.000Z', 'r1', 'p1', false),
    claim('2026-11-01T01:20:00.000Z', 'r1', 'p2', 's1', 'm5', 'm9'),
    end('2026-11-01T01:21:00.000Z', 'r1', 'p2', true),
    claim('2026-11-01T01:30:00.000Z', 'r1', 'p3', 's2', 'x1', 'x2'),
    claim('2026-11-01T01:40:00.000Z', 'r1', 'p4', 's1', 'm5', 'm6', 'shadow'),
  ];
  assert.equal(memoryPassWatermark(records, 'write', 's1'), 'm4');
  // An open claim (a pass running, or one a crash left) holds its slice.
  assert.equal(memoryPassWatermark(records, 'write', 's2'), 'x2');
  // Shadow passes keep their own watermarks.
  assert.equal(memoryPassWatermark(records, 'shadow', 's1'), 'm6');
  assert.equal(memoryPassWatermark(records, 'write', 's3'), undefined);
});

test('open claims are the ones with no end, by mode', () => {
  const records = [
    claim('2026-11-01T01:10:00.000Z', 'r1', 'p1', 's1', 'm1', 'm4'),
    end('2026-11-01T01:11:00.000Z', 'r1', 'p1', false),
    claim('2026-11-01T01:20:00.000Z', 'r1', 'p2', 's1', 'm5', 'm9'),
    claim('2026-11-01T01:30:00.000Z', 'r1', 'p3', 's1', 'm5', 'm9', 'shadow'),
  ];
  assert.deepEqual(memoryPassOpenClaims(records, 'write').map((record) => record.passId), ['p2']);
  assert.deepEqual(memoryPassOpenClaims(records, 'shadow').map((record) => record.passId), ['p3']);
});

test('a settle keeps a claim whose pass wrote something and releases one that wrote nothing', () => {
  const open = claim('2026-11-01T01:20:00.000Z', 'r1', 'p2', 's1', 'm5', 'm9');
  if (open.type !== 'claim') throw new Error('fixture');
  const wrote = memoryPassSettleRecord(open, [
    { id: 'e1', agentId: 'a', content: 'x', createdAt: 'z' },
    { id: 'e2', agentId: 'a', content: 'y', createdAt: 'z', supersedes: 'e0' },
  ], { at: '2026-11-01T05:00:00.000Z', run: 'r2' });
  assert.deepEqual(wrote, {
    type: 'end', at: '2026-11-01T05:00:00.000Z', run: 'r2', passId: 'p2',
    status: 'interrupted', saved: 2, superseded: 1, released: false,
  });
  const none = memoryPassSettleRecord(open, [], { at: '2026-11-01T05:00:00.000Z', run: 'r2' });
  assert.equal(none.released, true);
  assert.equal(none.saved, 0);
  // Released, the slice goes back: the watermark is as if p2 never ran.
  assert.equal(memoryPassWatermark([open, none], 'write', 's1'), undefined);
  assert.equal(memoryPassWatermark([open, wrote], 'write', 's1'), 'm9');
});

test('the ledger appends one line per record, owner-only, and reads past a torn line', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-passes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = agentMemoryPassesFileIn(home, 'ava');
  assert.equal(file, path.join(home, 'agents', 'ava', 'memory-passes.jsonl'));
  assert.equal(agentMemoryShadowFileIn(home, 'ava'), path.join(home, 'agents', 'ava', 'memory-shadow.jsonl'));
  const ledger = createMemoryPassLedger(file, { stateHome: home });
  assert.deepEqual(await ledger.read(), [], 'no file reads as nothing run');
  await ledger.append(start('2026-11-01T01:00:00.000Z', 'r1'));
  // A process killed mid-append leaves a line with no newline.
  await writeFile(file, `${await readFile(file, 'utf8')}{"type":"claim","passId":"p`, { flag: 'w' });
  await ledger.append(stop('2026-11-01T02:00:00.000Z', 'r1'));
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 3);
  assert.deepEqual((await ledger.read()).map((record) => record.type), ['start', 'stop']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

test('a ledger line that is JSON but not a record is skipped, never trusted', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-passes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = agentMemoryPassesFileIn(home, 'ava');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    JSON.stringify({ type: 'claim', passId: 'p1' }),
    JSON.stringify({ type: 'start', at: '2026-11-01T01:00:00.000Z', run: 'r1', mode: 'sideways' }),
    JSON.stringify(start('2026-11-01T01:00:00.000Z', 'r1')),
    '',
  ].join('\n'));
  assert.deepEqual(await createMemoryPassLedger(file).read(), [start('2026-11-01T01:00:00.000Z', 'r1')]);
});

test('undo forgets every live entry a pass wrote, and what it superseded is back', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-passes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = createFileMemoryStore(path.join(home, 'memory.jsonl'));
  const old = await store.append('ava', 'Ava prefers short replies.');
  const pass = { memoryPass: { id: 'p1', kind: 'save' } };
  const merged = await store.append('ava', 'Ava prefers short replies, with the answer first.', {
    supersedes: old.id,
    metadata: pass,
  });
  const second = await store.append('ava', 'Deploys go out on Tuesdays.', { metadata: pass });
  const other = await store.append('ava', 'Unrelated.', { metadata: { memoryPass: { id: 'p2', kind: 'save' } } });
  await store.forget('ava', second.id);

  assert.deepEqual((await memoryPassEntries(store, 'ava', 'p1')).map((entry: MemoryEntry) => entry.id).sort(), [merged.id, second.id].sort(),
    'entries carrying the pass id, forgotten ones included');
  assert.deepEqual(await undoMemoryPass(store, 'ava', 'p1'), { forgotten: [merged.id] });
  const live = (await store.list('ava')).entries.map((entry) => entry.id);
  assert.deepEqual(live.sort(), [old.id, other.id].sort());
  assert.deepEqual(await undoMemoryPass(store, 'ava', 'p1'), { forgotten: [] }, 'a second undo changes nothing');
});
