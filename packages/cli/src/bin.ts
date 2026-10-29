#!/usr/bin/env node
import { filterSqliteExperimentalWarning, runCli, unsupportedNodeMessage } from './index.ts';
import { watchOutputReader } from './io.ts';

// First, so even the Node-floor message below survives a reader that
// stopped early (`| head -1`, `| grep -q`). Only stdout's reader ends a
// follow: stderr can close on its own (`2> >(head -1)`) while stdout is
// still being read.
const outputClosed = watchOutputReader(process.stdout);
watchOutputReader(process.stderr);

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
  const exitCode = await runCli({ argv: process.argv.slice(2), env: { outputClosed } });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
