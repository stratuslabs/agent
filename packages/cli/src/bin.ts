#!/usr/bin/env node
import { filterSqliteExperimentalWarning, runCli, unsupportedNodeMessage } from './index.ts';

// Before anything else imports: the point is to explain the floor rather
// than to fail somewhere further in with a builtin-module error.
const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported) {
  process.stderr.write(`${unsupported}\n`);
  process.exitCode = 1;
} else {
  // Before the first command imports the session store, since the warning
  // fires on that import.
  filterSqliteExperimentalWarning();
  const exitCode = await runCli({ argv: process.argv.slice(2) });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
