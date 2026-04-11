# @stratusclaw/providers

Reusable provider-side utilities for StratusClaw.

This package stays outside `@stratusclaw/core` and focuses on small helpers for building, testing, and composing provider implementations without pulling vendor SDKs into the kernel.

## Included

- response builders and normalization helpers
- a lightweight provider registry
- deterministic static providers for local development
- deterministic scripted providers for tests and scenario playback

## Example

```ts
import {
  createProviderRegistry,
  defineScriptedProvider,
  defineStaticProvider,
} from '@stratusclaw/providers';

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

const registry = createProviderRegistry([fallback, scripted]);
const provider = registry.require('scripted');
```
