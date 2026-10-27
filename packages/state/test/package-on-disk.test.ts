import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageOnDisk } from '../src/index.ts';

const helperUrl = new URL('../src/package-on-disk.ts', import.meta.url).href;

const writePackage = async (dir: string, name: string): Promise<void> => {
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './dist/index.js' }));
  await writeFile(path.join(dir, 'dist', 'index.js'), 'export const ok = 1;\n');
};

test('a package installed after a miss loads in the same process, with no restart', async (t) => {
  // Node 24 and later remember a package that failed to resolve for the
  // rest of the process: once asked, a package installed afterwards fails
  // to import ("Cannot find package '<dir>/index.js'"). Setup asks whether
  // the provider is installed, installs it, then runs the test turn in the
  // same process; a daemon whose turn failed on a missing provider is told
  // to install it and send the message again. Both need the miss never to
  // reach Node's resolver. A unique directory, so the process this test
  // runs in can't be affected by what it leaves cached.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-late-package-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // node_modules already there, as in a global prefix that holds the CLI.
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'app'), { recursive: true });
  const probe = path.join(root, 'app', 'probe.mjs');
  await writeFile(probe, [
    `import { packageResolvable } from ${JSON.stringify(helperUrl)};`,
    'export const installed = (specifier) => packageResolvable(specifier, import.meta.url, import.meta.resolve);',
    'export const load = (specifier) => import(specifier);',
    '',
  ].join('\n'));
  const { installed, load } = await import(pathToFileURL(probe).href) as {
    installed: (specifier: string) => boolean;
    load: (specifier: string) => Promise<{ ok: number }>;
  };

  assert.equal(installed('late-plain'), false);
  assert.equal(installed('@late-scope/pkg'), false);
  await writePackage(path.join(root, 'node_modules', 'late-plain'), 'late-plain');
  await writePackage(path.join(root, 'node_modules', '@late-scope', 'pkg'), '@late-scope/pkg');

  assert.equal(installed('late-plain'), true);
  assert.equal(installed('@late-scope/pkg'), true);
  assert.equal((await load('late-plain')).ok, 1);
  assert.equal((await load('@late-scope/pkg')).ok, 1);
});

test('packageOnDisk looks where Node looks: node_modules beside every ancestor of the importer', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-package-on-disk-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const importer = path.join(root, 'a', 'b', 'c', 'mod.mjs');
  await mkdir(path.dirname(importer), { recursive: true });
  await writeFile(importer, '');
  await writePackage(path.join(root, 'a', 'node_modules', 'near'), 'near');
  await writePackage(path.join(root, 'node_modules', '@scope', 'far'), '@scope/far');
  // A directory that npm has not finished filling in, or left behind, is
  // not a package: Node needs its package.json.
  await mkdir(path.join(root, 'a', 'b', 'node_modules', 'empty'), { recursive: true });
  // A file where a package directory would be is not one either.
  await mkdir(path.join(root, 'node_modules', 'flat'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'flat', 'package.json'), { recursive: true });

  const from = pathToFileURL(importer);
  assert.equal(packageOnDisk('near', from), true);
  assert.equal(packageOnDisk('near', from.href), true);
  assert.equal(packageOnDisk('near', importer), true);
  assert.equal(packageOnDisk('near/sub/path.js', from), true);
  assert.equal(packageOnDisk('@scope/far', from), true);
  assert.equal(packageOnDisk('@scope/far/sub', from), true);

  assert.equal(packageOnDisk('missing', from), false);
  assert.equal(packageOnDisk('@scope/missing', from), false);
  assert.equal(packageOnDisk('empty', from), false);
  assert.equal(packageOnDisk('flat', from), false);
  // Only ancestors: a package beside a sibling directory is out of reach.
  await writePackage(path.join(root, 'a', 'x', 'node_modules', 'sibling'), 'sibling');
  assert.equal(packageOnDisk('sibling', from), false);
});

test('packageOnDisk leaves anything that is not a bare package name to Node', () => {
  const from = pathToFileURL(path.join(os.tmpdir(), 'nowhere', 'mod.mjs'));
  for (const specifier of ['./x.js', '../x.js', '/abs/x.js', 'node:fs', 'file:///x.js', 'data:text/javascript,', '#internal', '@scope', '@scope/', '']) {
    assert.equal(packageOnDisk(specifier, from), true, specifier);
  }
});
