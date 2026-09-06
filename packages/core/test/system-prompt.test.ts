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

  assert.deepEqual(parts.map((part) => part.kind), ['preamble', 'persona', 'memory', 'skills']);
  assert.equal(parts[0]?.text, 'House rules.');
  assert.match(parts[1]?.text ?? '', /^You are Ava\./);
  assert.match(parts[2]?.text ?? '', /prefers short answers/);
  assert.match(parts[3]?.text ?? '', /triage \(Triage\)/);
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
    'You are Ava. Be warm and concise.',
    'Things you remember from previous conversations (your own long-term memory):\n- The user prefers short answers.',
    renderSystemPromptParts(input, options)[3]?.text,
  ]);
});

test('empty sections are omitted rather than labelled', () => {
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
  // persona asked for: nothing to say and nothing rendered.
  assert.deepEqual(bare, []);
});
