# @stratusagent/providers

Reusable provider-side utilities for Stratus Agent.

This package stays outside `@stratusagent/core` and focuses on small helpers for building, testing, and composing provider implementations without pulling vendor SDKs into the kernel.

## Included

- response builders and normalization helpers
- a lightweight provider registry
- deterministic static providers for local development
- deterministic scripted providers for tests and scenario playback
- an OpenAI-compatible chat-completions adapter for real provider wiring

## Example

```ts
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  defineScriptedProvider,
  defineStaticProvider,
} from '@stratusagent/providers';

const fallback = defineStaticProvider({
  name: 'fallback',
  response: 'Hello from a fixture provider.',
});

const scripted = defineScriptedProvider({
  name: 'scripted',
  steps: [
    'Need tool output',
    [
      {
        type: 'tool-call',
        call: { id: 'call-1', toolName: 'echo', input: { value: 'hi' } },
      },
      'Done',
    ],
  ],
});

const realProvider = createOpenAICompatibleProvider({
  model: 'gpt-4.1-mini',
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

const registry = createProviderRegistry([fallback, scripted, realProvider]);
const provider = registry.require('scripted');
```
