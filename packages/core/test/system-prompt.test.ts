import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSystemPromptParts,
  renderSystemPromptSections,
  type MemoryEntry,
  type ProviderRequest,
  type SkillDescriptor,
} from '../src/index.ts';

const memory: MemoryEntry[] = [
  { id: 'm1', agentId: 'ava', content: 'The user prefers short answers.', createdAt: '2026-01-01T00:00:00.000Z', trust: 'agent' },
];

const skills: SkillDescriptor[] = [
  { id: 'triage', name: 'Triage', description: 'Use when triaging an inbox.' },
];

const request = (): Pick<ProviderRequest, 'session' | 'memory' | 'skills'> => ({
  session: {
    id: 's1',
    agent: { id: 'ava', name: 'Ava', instructions: 'Be warm and concise.' },
    status: 'running',
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  memory,
  skills,
});

test('the tagged parts label every section and keep the declared order', () => {
  const parts = renderSystemPromptParts(request(), { preamble: 'House rules.' });

  assert.deepEqual(parts.map((part) => part.kind), ['preamble', 'replies', 'persona', 'memory', 'skills']);
  assert.equal(parts[0]?.text, 'House rules.');
  assert.match(parts[1]?.text ?? '', /^How long to make a reply/);
  assert.match(parts[2]?.text ?? '', /^You are Ava\./);
  assert.match(parts[3]?.text ?? '', /prefers short answers/);
  assert.match(parts[4]?.text ?? '', /triage \(Triage\)/);
});

test('the string view is exactly the tagged parts with the labels dropped', () => {
  // The guarantee the three providers that do not cache rely on: adding the
  // tagged view changed nothing about what they send. A reordering here would
  // silently edit their prompts for a benefit only one adapter collects.
  const input = request();
  const options = { preamble: 'House rules.' };

  assert.deepEqual(
    renderSystemPromptSections(input, options),
    renderSystemPromptParts(input, options).map((part) => part.text),
  );
  assert.deepEqual(renderSystemPromptSections(input, options), [
    'House rules.',
    renderSystemPromptParts(input, options)[1]?.text,
    'You are Ava. Be warm and concise.',
    'Things you remember from previous conversations (your own long-term memory):\n- The user prefers short answers.',
    renderSystemPromptParts(input, options)[4]?.text,
  ]);
});

test('empty sections are omitted, and every agent is still told how long to reply', () => {
  const bare = renderSystemPromptParts({
    session: {
      id: 's2',
      agent: { id: 'plain', name: 'Plain' },
      status: 'running',
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  // No instructions, no memory, no skills, no preamble, and no fallback
  // persona asked for: the reply-length section is all that renders.
  assert.deepEqual(bare.map((part) => part.kind), ['replies']);
});

test('the reply-length section keeps replies phone-sized and yields to the soul', () => {
  const parts = renderSystemPromptParts(request());
  const replies = parts.find((part) => part.kind === 'replies')?.text ?? '';

  assert.match(replies, /under six lines of plain prose, no headers, no bullet lists/);
  assert.match(replies, /at most one follow-up question/);
  // Ahead of the persona, and says the persona wins: a soul written for
  // long-form work must be able to ask for it.
  assert.ok(parts.findIndex((part) => part.kind === 'replies') < parts.findIndex((part) => part.kind === 'persona'));
  assert.match(replies, /Where your own instructions below say otherwise, they win\./);
});
