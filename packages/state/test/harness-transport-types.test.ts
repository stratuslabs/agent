import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeCodeQueryFn } from '@stratusagent/provider-claude-code';
import type { CodexRunTurn } from '@stratusagent/provider-codex';
import type { StateEnvironment } from '../src/environment.ts';

// Compile-time contract for the harness transports a host injects through
// StateEnvironment (and RuntimeConfig, which uses the same types). `pnpm
// typecheck` is the real check here; the runtime assertions only keep the
// file a test.

async function* none(): AsyncIterable<never> {}

test('the real harness transport types are accepted', () => {
  const queryFn: ClaudeCodeQueryFn = () => none();
  const codexRunTurn: CodexRunTurn = () => none();
  const env: Pick<StateEnvironment, 'queryFn' | 'codexRunTurn'> = { queryFn, codexRunTurn };
  assert.equal(typeof env.queryFn, 'function');
  assert.equal(typeof env.codexRunTurn, 'function');
});

test('an inline transport can read the fields the harness passes it', () => {
  const env: Pick<StateEnvironment, 'queryFn' | 'codexRunTurn'> = {
    queryFn: (params) => {
      const prompt: string | AsyncIterable<unknown> = params.prompt;
      void prompt;
      return none();
    },
    codexRunTurn: (params) => {
      const input: string = params.input;
      const signal: AbortSignal = params.signal;
      void input;
      void signal;
      return none();
    },
  };
  assert.equal(typeof env.queryFn, 'function');
});

test('a callback of an unrelated shape is rejected', () => {
  const env: Pick<StateEnvironment, 'queryFn' | 'codexRunTurn'> = {
    // @ts-expect-error a transport takes the harness's params object, not a number
    queryFn: (value: number) => {
      void value;
      return none();
    },
    // @ts-expect-error a transport takes the harness's params object, not a number
    codexRunTurn: (value: number) => {
      void value;
      return none();
    },
  };
  assert.ok(env);
});

test('a callback narrower than what the harness passes is rejected', () => {
  const stringOnly = (params: { prompt: string }) => {
    void params;
    return none();
  };
  const needsResume = (params: { input: string; resumeThreadId: string; clientOptions: object; threadOptions: object; signal: AbortSignal }) => {
    void params;
    return none();
  };
  const env: Pick<StateEnvironment, 'queryFn' | 'codexRunTurn'> = {
    // @ts-expect-error image turns pass an AsyncIterable prompt, not only a string
    queryFn: stringOnly,
    // @ts-expect-error a thread's first turn passes no resumeThreadId
    codexRunTurn: needsResume,
  };
  assert.ok(env);
});
