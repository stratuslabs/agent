import { decoyHome } from './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/index.ts';

const testDir = import.meta.dirname;

test('every cli test file imports the home guard before anything else', () => {
  const unguarded = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => {
      const firstImport = readFileSync(path.join(testDir, name), 'utf8')
        .split('\n')
        .find((line) => line.startsWith('import '));
      return firstImport !== "import './home-guard.ts';" && firstImport !== "import { decoyHome } from './home-guard.ts';";
    });
  assert.deepEqual(unguarded, []);
});

test('the home a cli test sees is the decoy, whose .stratus is a file', () => {
  assert.equal(os.homedir(), decoyHome);
  assert.ok(statSync(path.join(os.homedir(), '.stratus')).isFile());
});

test('a cli run with no home of its own fails instead of reaching the real one', async () => {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli({
    argv: ['run', '--provider', 'demo', '--prompt', 'please use the echo tool'],
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    env: { processEnv: {} },
  });

  assert.equal(exitCode, 1);
  assert.ok(
    stderr.includes(`${path.join(decoyHome, '.stratus')} is not a directory`),
    `expected the run to refuse the decoy home, got: ${stderr}`,
  );
  assert.doesNotMatch(stdout, /tool\.called/);
});
