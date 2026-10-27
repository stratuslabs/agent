import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@stratusagent/core';
// The adapter is imported here only to hold state's copies equal to it.
import {
  DEFAULT_ANTHROPIC_MODEL as ADAPTER_DEFAULT_MODEL,
  RAW_TURNS_METADATA_KEY,
  redactAnthropicRawTurns,
} from '@stratusagent/provider-anthropic';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/providers';
import {
  DEFAULT_OPENAI_MODEL,
  PROVIDER_STATE_METADATA_KEYS,
  defaultModelFor,
  redactProviderReplayState,
} from '../src/index.ts';
// Internal on purpose: callers use `defaultModelFor` and
// `redactProviderReplayState`, not the names behind them.
import { DEFAULT_ANTHROPIC_MODEL } from '../src/provider-names.ts';
import { ANTHROPIC_RAW_TURNS_METADATA_KEY } from '../src/provider-runtime.ts';

const session = (metadata?: Session['metadata']): Session => ({
  id: 'neutral-1',
  agent: { id: 'ava', name: 'Ava' },
  messages: [{ role: 'user', content: 'hi' }],
  ...(metadata !== undefined ? { metadata } : {}),
} as Session);

test('the Anthropic names state keeps are the adapter\'s own', () => {
  // State restates them so the CLI and the control API can name a default
  // model and hide replay state without loading the adapter. A drift here
  // would run a different model than a library user gets, or leak thinking.
  assert.equal(DEFAULT_ANTHROPIC_MODEL, ADAPTER_DEFAULT_MODEL);
  assert.equal(ANTHROPIC_RAW_TURNS_METADATA_KEY, RAW_TURNS_METADATA_KEY);
  assert.ok(PROVIDER_STATE_METADATA_KEYS.includes(RAW_TURNS_METADATA_KEY));
});

test('defaultModelFor names each built-in provider\'s default model', () => {
  assert.equal(defaultModelFor('anthropic'), DEFAULT_ANTHROPIC_MODEL);
  assert.equal(defaultModelFor('codex'), DEFAULT_CODEX_MODEL);
  assert.equal(defaultModelFor('openai'), DEFAULT_OPENAI_MODEL);
});

test('redactProviderReplayState drops raw model turns and keeps everything else', () => {
  const stored = session({
    [ANTHROPIC_RAW_TURNS_METADATA_KEY]: { 'call-1': [{ type: 'thinking', thinking: 'internal' }] },
    channel: 'slack',
    codexThreadId: 'thread-1',
  });
  const shown = redactProviderReplayState(stored);
  assert.deepEqual(shown.metadata, { channel: 'slack', codexThreadId: 'thread-1' });
  assert.deepEqual(shown.messages, stored.messages);
  // The stored session keeps it: replay needs it.
  assert.ok(stored.metadata && ANTHROPIC_RAW_TURNS_METADATA_KEY in stored.metadata);
});

test('redactProviderReplayState leaves a session without replay state as it is', () => {
  const plain = session({ channel: 'slack' });
  assert.equal(redactProviderReplayState(plain), plain);
  const bare = session();
  assert.equal(redactProviderReplayState(bare), bare);
});

test('redactProviderReplayState matches the adapter\'s redaction for every shape', () => {
  const shapes = [
    session(),
    session({}),
    session({ channel: 'slack' }),
    session({ [ANTHROPIC_RAW_TURNS_METADATA_KEY]: {} }),
    session({ [ANTHROPIC_RAW_TURNS_METADATA_KEY]: { a: [] }, fallbackActive: true }),
  ];
  for (const shape of shapes) {
    assert.deepEqual(redactProviderReplayState(shape), redactAnthropicRawTurns(shape));
  }
});
