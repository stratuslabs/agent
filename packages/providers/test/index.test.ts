import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderRequest } from '@stratusclaw/core';
import { createProviderResponseBuilder, defineProvider } from '../src/index.ts';

test('provider helpers build core-compatible responses', async () => {
  const provider = defineProvider({
    name: 'fixture-provider',
    async generate(_request: ProviderRequest) {
      return createProviderResponseBuilder()
        .addText('Planning')
        .addToolCall({
          id: 'call-1',
          toolName: 'echo',
          input: { value: 'hello' },
        })
        .addText('Complete')
        .done();
    },
  });

  const response = await provider.generate({
    session: {
      id: 'session-1',
      agent: { id: 'agent-1', name: 'Kernel' },
      status: 'running',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  assert.equal(provider.name, 'fixture-provider');
  assert.equal(response.parts[0]?.type, 'text');
  assert.equal(response.parts[1]?.type, 'tool-call');
  assert.deepEqual(response.parts[1], {
    type: 'tool-call',
    call: {
      id: 'call-1',
      toolName: 'echo',
      input: { value: 'hello' },
    },
  });
  assert.equal(response.parts[2]?.type, 'text');
});
