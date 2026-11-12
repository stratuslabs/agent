import test from 'node:test';
import assert from 'node:assert/strict';

import { shortId, summariseTool, transcriptItems } from '../ui/lib/transcript.js';

test('a short session id is shown whole, a long one keeps both ends', () => {
  assert.equal(shortId('web:ava:1234'), 'web:ava:1234');
  const long = 'slack:C0C1YV12SLC:1793046557.547839:atlas';
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

test('the transcript skips system messages and text-less assistant turns, then adds live lines and the streaming reply', () => {
  const messages = [
    { role: 'system', content: 'You are Ava.' },
    { role: 'user', content: 'list my files' },
    { role: 'assistant', content: '' },
    { role: 'tool', content: JSON.stringify({ callId: 'c1', toolName: 'fs.list', ok: true, output: 'a.txt' }) },
    { role: 'assistant', content: 'One file.' },
    { role: 'user', content: 'and now?' },
  ];
  const decided = { text: 'running fs.list…', callId: 'c1', toolName: 'fs.list', decides: true };
  const live = { text: 'running shell.run…', callId: 'c2', toolName: 'shell.run', decides: true };
  const items = transcriptItems({
    messages,
    toolLines: [live],
    streaming: 'Look',
    settled: new Map([[3, decided]]),
  });
  assert.deepEqual(items, [
    { kind: 'user', text: 'list my files' },
    { kind: 'tool', text: 'fs.list → a.txt', line: decided },
    { kind: 'assistant', text: 'One file.' },
    { kind: 'user', text: 'and now?' },
    { kind: 'tool', text: 'running shell.run…', line: live },
    { kind: 'assistant streaming', text: 'Look' },
  ]);
});

test('a stored tool result with no kept line has none, and nothing streaming adds nothing', () => {
  const messages = [{ role: 'tool', content: 'plain' }];
  assert.deepEqual(transcriptItems({ messages, toolLines: [], streaming: '', settled: new Map() }), [
    { kind: 'tool', text: 'plain', line: undefined },
  ]);
});
