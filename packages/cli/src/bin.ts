#!/usr/bin/env node
import { runCli } from './index.ts';

const exitCode = await runCli({ argv: process.argv.slice(2) });
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
