/**
 * Points this test process's home directory at a decoy, so no cli test can
 * reach the real `~/.stratus` of whoever runs the suite. `stratus run` applies
 * state migrations before it runs, so a test that fell back to `os.homedir()`
 * migrated a contributor's own home with an unreleased build.
 *
 * The decoy's `.stratus` is a regular file, so a test that reaches it fails
 * instead of quietly working there: reading state under it fails with ENOTDIR,
 * and a migration refuses a home that is not a directory. That holds when the
 * suite runs as root too, which a read-only directory would not. Give such a
 * test a home of its own: `env.homeDir` for `runCli`, `HOME` for a spawned bin.
 *
 * Every test file here imports this before anything else, so it runs before
 * any module that might read the home; home-guard.test.ts checks they all do.
 * Child processes inherit the decoy through `process.env`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const decoyHome = mkdtempSync(path.join(os.tmpdir(), 'stratus-cli-decoy-home-'));

writeFileSync(
  path.join(decoyHome, '.stratus'),
  'Not a Stratus home. A cli test reached the home directory: give it its own (env.homeDir, or HOME for a spawned bin).\n',
);

process.env.HOME = decoyHome;
// What os.homedir() reads on Windows.
process.env.USERPROFILE = decoyHome;

process.on('exit', () => {
  rmSync(decoyHome, { recursive: true, force: true });
});
