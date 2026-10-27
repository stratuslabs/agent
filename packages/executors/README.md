# @stratusagent/executors (deprecated)

The executor helpers for [Stratus Agent](https://github.com/stratuslabs/agent) (`successResult`, `failureResult`, `defineExecutor`, `createDirectExecutor` and the rest) now ship in `@stratusagent/core`. This release of `@stratusagent/executors` only re-exports the same names from there. No release after this one is planned.

Change your imports:

```ts
// before
import { failureResult, successResult } from '@stratusagent/executors';
// after
import { failureResult, successResult } from '@stratusagent/core';
```

Then drop `@stratusagent/executors` from your dependencies. Nothing else changes: the names, types, and behavior are the ones this package exported before.
