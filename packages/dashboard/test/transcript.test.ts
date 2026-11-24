import test from 'node:test';
import assert from 'node:assert/strict';

import { shortId, summariseTool, transcriptItems } from '../ui/lib/transcript.js';

test('a short session id is shown whole, a long one keeps both ends', () => {
  assert.equal(shortId('web:ava:1234'), 'web:ava:1234');
  const long = 'slack:C0EXAMPLE01:1793046557.547839:atlas';
  assert.equal(shortId(long), `${long.slice(0, 12)}…${long.slice(-8)}`);
  assert.equal(shortId('x'.repeat(28)), 'x'.repeat(28), '28 characters still fit');
});

test('a tool result envelope reads as the tool and its output, not as JSON', () => {
  const ok = JSON.stringify({ callId: 'tool-call-1', toolName: 'shell.run', ok: true, output: 'ran' });
  assert.equal(summariseTool(ok), 'shell.run → ran');
  const structured = JSON.stringify({ callId: 'c', toolName: 'fs.list', ok: true, output: { entries: 2 } });
  assert.equal(summariseTool(structured), 'fs.list → {"entries":2}');
  const failed = JSON.stringify({ callId: 'c', toolName: 'web.fetch', ok: false, error: 'timed out' });
  assert.equal(summariseTool(failed), 'web.fetch → failed — timed out');
  const silent = JSON.stringify({ callId: 'c', toolName: 'web.fetch', ok: false });
  assert.equal(summariseTool(silent), 'web.fetch → failed — no reason given');
});

test('a long tool output is cut at 260 characters, whatever shape it came in', () => {
  const long = 'a'.repeat(300);
  assert.equal(summariseTool(long), `${'a'.repeat(260)}…`, 'plain text');
  assert.equal(summariseTool(JSON.stringify({ toolName: 'shell.run', ok: true, output: long })), `shell.run → ${'a'.repeat(260)}…`);
  assert.equal(summariseTool(JSON.stringify({ note: long })).length, 261, 'JSON that is not a tool envelope');
  assert.equal(summariseTool(undefined), '');
});

test('the transcript skips system messages and text-less assistant turns, pairs each result with its call, then adds live calls and the streaming reply', () => {
  const messages = [
    { role: 'system', content: 'You are Ava.' },
    { role: 'user', content: 'list my files' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', toolName: 'fs.list', input: { path: '.' } }] },
    { role: 'tool', content: 'ignored', toolResult: { callId: 'c1', toolName: 'fs.list', ok: true, output: 'a.txt' } },
    { role: 'assistant', content: 'One file.' },
    { role: 'user', content: 'and now?' },
  ];
  const decided = { text: 'running fs.list…', callId: 'c1', toolName: 'fs.list', decides: true };
  const live = { text: 'running shell.run…', callId: 'c2', toolName: 'shell.run', decides: true, phase: 'running' };
  const items = transcriptItems({
    messages,
    toolLines: [live],
    streaming: 'Look',
    settled: new Map([[3, decided]]),
  });
  assert.deepEqual(items, [
    { kind: 'user', text: 'list my files' },
    { kind: 'tool', toolName: 'fs.list', input: { path: '.' }, phase: 'done', output: 'a.txt', line: decided },
    { kind: 'assistant', text: 'One file.' },
    { kind: 'user', text: 'and now?' },
    { kind: 'tool', toolName: 'shell.run', phase: 'running', line: live },
    { kind: 'assistant', text: 'Look', streaming: true },
  ]);
});

test('a failed result says why, and a result stored as JSON text still reads', () => {
  const messages = [
    { role: 'tool', content: JSON.stringify({ callId: 'c', toolName: 'web.fetch', ok: false, error: 'timed out' }) },
  ];
  assert.deepEqual(transcriptItems({ messages, toolLines: [], streaming: '', settled: new Map() }), [
    { kind: 'tool', toolName: 'web.fetch', phase: 'failed', error: 'timed out', line: undefined },
  ]);
});

test('a stored tool result with no kept line has none, and nothing streaming adds nothing', () => {
  const messages = [{ role: 'tool', content: 'plain' }];
  assert.deepEqual(transcriptItems({ messages, toolLines: [], streaming: '', settled: new Map() }), [
    { kind: 'tool', toolName: 'tool', phase: 'done', output: 'plain', line: undefined },
  ]);
});

test("a live call's lines fold into one row that shows its latest phase and keeps the decision", () => {
  const decision = { allowed: true, layer: 'grant', reason: 'a standing grant' };
  const lines = [
    { text: 'running shell.run…', callId: 'c9', toolName: 'shell.run', decides: true, phase: 'running', decision },
    { text: 'shell.run is waiting for approval', callId: 'c9', toolName: 'shell.run', decides: false, phase: 'waiting' },
    { text: 'shell.run finished', callId: 'c9', toolName: 'shell.run', decides: false, phase: 'done' },
  ];
  const items = transcriptItems({ messages: [], toolLines: lines, streaming: '', settled: new Map() });
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row?.phase, 'done');
  assert.equal(row?.line, lines[0]);
});

test('a call input is found only within its own turn', () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', toolName: 'fs.list', input: { path: 'old' } }] },
    { role: 'tool', content: '', toolResult: { callId: 'c1', toolName: 'fs.list', ok: true, output: 'x' } },
    { role: 'user', content: 'again' },
    { role: 'tool', content: '', toolResult: { callId: 'c1', toolName: 'fs.list', ok: true, output: 'y' } },
  ];
  const items = transcriptItems({ messages, toolLines: [], streaming: '', settled: new Map() });
  assert.deepEqual(items[0]?.input, { path: 'old' });
  assert.equal(items[2]?.input, undefined, 'a reused id in a later turn does not borrow the earlier input');
});
