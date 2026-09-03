import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openContained, PathOutsideRootError, resolveWithinRoots } from '../src/index.ts';

test('a file replaced between the containment check and the open is refused, not read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-swap-'));
  await writeFile(path.join(root, 'checked.txt'), 'what was checked\n');
  await writeFile(path.join(root, 'other.txt'), 'what is there now\n');
  const resolved = await resolveWithinRoots([root], 'checked.txt');
  assert.ok(resolved.identity, 'an existing file carries its identity');

  // The swap: the same name, a different inode. `O_NOFOLLOW` alone would
  // open it — it is a real file, not a symlink.
  await rename(path.join(root, 'other.txt'), path.join(root, 'checked.txt'));
  await assert.rejects(
    () => openContained(resolved, constants.O_RDONLY),
    (error: unknown) => error instanceof PathOutsideRootError && /changed between the containment check and the open/.test(error.message),
  );

  // Checked afresh, the name opens.
  const handle = await openContained(await resolveWithinRoots([root], 'checked.txt'), constants.O_RDONLY);
  try {
    assert.equal((await handle.readFile('utf8')), 'what is there now\n');
  } finally {
    await handle.close();
  }
});
