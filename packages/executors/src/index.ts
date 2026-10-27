/**
 * Deprecated: the executor helpers now ship in `@stratusagent/core`.
 * Import these names from there; this package re-exports them for one more
 * release so an executor built against it keeps working while it moves.
 */
export {
  createDirectExecutor,
  defineExecutor,
  DirectExecutor,
  failureResult,
  normalizeExecutorError,
  successResult,
  type DirectExecutorErrorContext,
  type DirectExecutorOptions,
  type ExecutorDefinition,
  type ExecutorResultCallRef,
} from '@stratusagent/core';
