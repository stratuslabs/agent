import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUNDLED_PLUGIN_INDEX,
  checkPluginReleases,
  currentPlatformHost,
  installSpecifier,
  parseNpmView,
  parsePluginIndex,
  readPluginIndex,
  releaseVerdict,
  type PluginRelease,
} from '../src/plugin-index.ts';
import { FIRST_PARTY_CAPABILITY_PACKAGES, FIRST_PARTY_CONTRIBUTION_PACKAGES } from '../src/plugin-catalog.ts';

const published = (stratus: unknown, extra: Record<string, unknown> = {}): PluginRelease => ({
  status: 'published',
  version: '0.1.0',
  stratus,
  ...extra,
});

const toolManifest = { pluginVersion: 1, contributes: { tools: [{ name: 'agent.spawn' }] } };

/** A host as npm's platform check sees it. */
const linux = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;
const host = (os: NodeJS.Platform, extra: { cpu?: string; libc?: string | null } = {}) =>
  ({ os, cpu: extra.cpu ?? 'x64', libc: extra.libc === undefined ? (os === 'linux' ? 'glibc' : null) : extra.libc });

test('the index reads entries with a package name and a description', () => {
  const entries = parsePluginIndex({
    schemaVersion: 1,
    plugins: [
      { name: '@stratusagent/plugin-spawn', description: 'Run tasks in sub-agents' },
      { name: 'stratus-plugin-weather', description: 'Weather lookups' },
    ],
  });
  assert.deepEqual(entries, [
    { name: '@stratusagent/plugin-spawn', description: 'Run tasks in sub-agents' },
    { name: 'stratus-plugin-weather', description: 'Weather lookups' },
  ]);
});

test('an index of another schema version, or not an index at all, is not read', () => {
  assert.equal(parsePluginIndex({ schemaVersion: 2, plugins: [] }), undefined);
  assert.equal(parsePluginIndex({ plugins: [] }), undefined);
  assert.equal(parsePluginIndex({ schemaVersion: 1, plugins: 'all of them' }), undefined);
  assert.equal(parsePluginIndex('{"schemaVersion":1}'), undefined);
  assert.equal(parsePluginIndex(undefined), undefined);
});

test('the index drops entries npm could not be handed, and repeats', () => {
  // These names go to `npm view` and then `npm install -g`, which runs
  // through a shell on Windows. The index is data fetched from a registry,
  // so it gets the same fence as a config key.
  const entries = parsePluginIndex({
    schemaVersion: 1,
    plugins: [
      { name: '@stratusagent/plugin-spawn && calc', description: 'no' },
      { name: '@stratusagent/plugin-spawn@latest', description: 'a version is not a name' },
      { name: '@stratusagent/plugin-peer' },
      { name: '@stratusagent/plugin-peer', description: '   ' },
      'plugin-fleet',
      { name: '@stratusagent/plugin-fleet', description: 'Fleet metadata' },
      { name: '@stratusagent/plugin-fleet', description: 'Twice' },
    ],
  });
  assert.deepEqual(entries, [{ name: '@stratusagent/plugin-fleet', description: 'Fleet metadata' }]);
});

test('the index drops a description that would reach the terminal as more than one plain line', () => {
  // Setup prints descriptions straight into its menu. A line break breaks
  // the row, and an escape sequence is something the terminal would run.
  const entries = parsePluginIndex({
    schemaVersion: 1,
    plugins: [
      { name: 'stratus-plugin-a', description: 'Two\nlines' },
      { name: 'stratus-plugin-b', description: 'Red \u001b[31mtext' },
      { name: 'stratus-plugin-c', description: 'Carriage\rreturn' },
      { name: 'stratus-plugin-d', description: 'C1 \u009b control' },
      { name: 'stratus-plugin-e', description: 'Line\u2028separator' },
      { name: 'stratus-plugin-f', description: 'Fine — with a dash' },
    ],
  });
  assert.deepEqual(entries, [{ name: 'stratus-plugin-f', description: 'Fine — with a dash' }]);
});

test('the bundled index is a valid index of packages that ship apart from the CLI', () => {
  const entries = parsePluginIndex({ schemaVersion: 1, plugins: BUNDLED_PLUGIN_INDEX });
  assert.deepEqual(entries, [...BUNDLED_PLUGIN_INDEX]);
  assert.ok(BUNDLED_PLUGIN_INDEX.length > 0);
  // Packages released with the CLI are listed by plugin-catalog.ts and are
  // always in the menu already; the index is for everything else.
  for (const entry of BUNDLED_PLUGIN_INDEX) {
    assert.ok(!FIRST_PARTY_CAPABILITY_PACKAGES.includes(entry.name), entry.name);
    assert.ok(!FIRST_PARTY_CONTRIBUTION_PACKAGES.includes(entry.name), entry.name);
  }
});

test('the index comes from npm when npm has one, and from the bundled copy otherwise', async () => {
  const fromNpm = await readPluginIndex({
    pluginIndexReader: async () => ({ schemaVersion: 1, plugins: [{ name: 'stratus-plugin-x', description: 'X' }] }),
  });
  assert.deepEqual(fromNpm, { source: 'npm', entries: [{ name: 'stratus-plugin-x', description: 'X' }] });

  const unpublished = await readPluginIndex({ pluginIndexReader: async () => undefined });
  assert.deepEqual(unpublished, { source: 'bundled', entries: [...BUNDLED_PLUGIN_INDEX] });

  // A published index this CLI cannot read is no better than none: the
  // menu falls back rather than showing nothing.
  const unreadable = await readPluginIndex({ pluginIndexReader: async () => ({ schemaVersion: 9 }) });
  assert.equal(unreadable.source, 'bundled');

  const throwing = await readPluginIndex({
    pluginIndexReader: async () => {
      throw new Error('spawn npm ENOENT');
    },
  });
  assert.equal(throwing.source, 'bundled');
});

test('a published plugin release with tools this CLI understands is offered', () => {
  assert.deepEqual(releaseVerdict('p', published(toolManifest), linux), { offer: true, version: '0.1.0' });
  assert.deepEqual(
    releaseVerdict('p', published({ pluginVersion: 1, contributes: { toolsDiscovered: [{ namespace: 'mcp.*' }] } }), linux),
    { offer: true, version: '0.1.0' },
  );
});

test('a release that is not published, not a plugin, or for another host is not offered, with the reason', () => {
  const reason = (release: PluginRelease, platform: NodeJS.Platform = 'linux'): string | undefined => {
    const verdict = releaseVerdict('p', release, host(platform));
    return verdict.offer ? undefined : verdict.reason;
  };
  assert.equal(reason({ status: 'unpublished' }), 'not on npm yet');
  assert.equal(reason({ status: 'unknown' }), 'npm did not answer');
  assert.equal(reason(published(undefined)), 'its latest release (0.1.0) is not a Stratus plugin');
  assert.equal(
    reason(published({ ...toolManifest, pluginVersion: 2 })),
    'its latest release (0.1.0) is plugin version 2, and this CLI loads version 1',
  );
  assert.equal(reason(published({ pluginVersion: 1, contributes: {} })), 'it adds no tools');
  assert.equal(reason(published(toolManifest, { os: ['darwin'] }), 'linux'), 'it does not run on linux');
  assert.equal(reason(published(toolManifest, { os: ['darwin'] }), 'darwin'), undefined);
});

test('a release whose manifest the loader would refuse is not offered', () => {
  // Non-empty is not the same as loadable: the loader's own manifest parser
  // decides, so setup never installs and enables a plugin that registers
  // nothing at the next start.
  const reason = (stratus: unknown): string | undefined => {
    const verdict = releaseVerdict('@stratusagent/plugin-x', published(stratus), linux);
    return verdict.offer ? undefined : verdict.reason;
  };
  const refused = /^its latest release \(0\.1\.0\) has a manifest this CLI would refuse: Plugin @stratusagent\/plugin-x: /;
  assert.match(reason({ pluginVersion: 1, contributes: { tools: [{}] } }) ?? '', refused);
  assert.match(reason({ pluginVersion: 1, contributes: { toolsDiscovered: [null] } }) ?? '', refused);
  assert.match(reason({ pluginVersion: 1, contributes: { toolsDiscovered: [{ namespace: 'mcp' }] } }) ?? '', refused);
  assert.match(reason({ pluginVersion: 1, contributes: { tools: [{ name: 'skill.read' }] } }) ?? '', /would refuse/);
  // Whatever the registry put in a name reaches the reason only escaped.
  assert.doesNotMatch(reason({ pluginVersion: 1, contributes: { tools: [{ name: 'x\u001b[2J' }] } }) ?? '', /\u001b/);
});

test('the os field is read the way npm reads it', () => {
  const offered = (os: unknown, platform: NodeJS.Platform): boolean =>
    releaseVerdict('p', published(toolManifest, { os }), host(platform)).offer;
  assert.equal(offered('darwin', 'darwin'), true);
  assert.equal(offered('darwin', 'linux'), false);
  assert.equal(offered(['!win32'], 'linux'), true);
  assert.equal(offered(['!win32'], 'win32'), false);
  assert.equal(offered(['any'], 'win32'), true);
  assert.equal(offered(['darwin', 'linux'], 'linux'), true);
  assert.equal(offered(undefined, 'win32'), true);
});

test('cpu and libc are checked the way npm checks them, so npm will not refuse what setup offers', () => {
  const reason = (extra: Record<string, unknown>, on: ReturnType<typeof host>): string | undefined => {
    const verdict = releaseVerdict('p', published(toolManifest, extra), on);
    return verdict.offer ? undefined : verdict.reason;
  };
  assert.equal(reason({ cpu: ['arm64'] }, host('darwin', { cpu: 'x64' })), 'it does not run on x64');
  assert.equal(reason({ cpu: ['arm64'] }, host('darwin', { cpu: 'arm64' })), undefined);
  assert.equal(reason({ cpu: '!ia32' }, host('linux', { cpu: 'ia32' })), 'it does not run on ia32');
  assert.equal(reason({ libc: ['musl'] }, host('linux', { libc: 'glibc' })), 'it does not run with glibc');
  assert.equal(reason({ libc: ['glibc'] }, host('linux', { libc: 'glibc' })), undefined);
  // npm refuses a package that names a libc wherever it can't tell one,
  // which is every host that isn't Linux.
  assert.equal(reason({ libc: ['glibc'] }, host('darwin')), 'it needs a libc this host does not report');
});

test('this host is read the way npm reads it', () => {
  const here = currentPlatformHost();
  assert.equal(here.os, process.platform);
  assert.equal(here.cpu, process.arch);
  // CI runs this on Linux too, where npm reports a libc family.
  if (process.platform === 'linux') {
    assert.ok(here.libc === 'glibc' || here.libc === 'musl', `libc ${here.libc}`);
  } else {
    assert.equal(here.libc, null);
  }
});

test('the install is pinned to the version that was checked', () => {
  assert.equal(installSpecifier('@stratusagent/plugin-x', '0.2.0'), '@stratusagent/plugin-x@0.2.0');
});

test('a release is offered only if the installer will take its pinned specifier', () => {
  // Valid SemVer, but the installer's shell fence takes only lowercase
  // letters, digits, dots and dashes in a version. Offering one would end in
  // "not a package name npm can install" after the operator picked it.
  for (const version of ['1.0.0+build.5', '1.0.0-RC.1']) {
    const verdict = releaseVerdict('@stratusagent/plugin-x', published(toolManifest, { version }), linux);
    assert.deepEqual(verdict, {
      offer: false,
      reason: `setup can't pass its latest release (${version}) to npm; run npm install -g @stratusagent/plugin-x@${version} yourself`,
    });
  }
  assert.equal(releaseVerdict('@stratusagent/plugin-x', published(toolManifest, { version: '1.0.0-rc.1' }), linux).offer, true);
});

test('npm view output is read whether npm printed one field or several', () => {
  // `npm view pkg@latest version stratus os --json` prints an object when
  // more than one of the fields exists and the bare value when only one
  // does — `version` always exists, so a bare string is a package with no
  // manifest and no os field.
  assert.deepEqual(parseNpmView({ code: 0, stdout: '"1.3.0"\n', stderr: '' }), {
    status: 'published',
    version: '1.3.0',
  });
  assert.deepEqual(
    parseNpmView({ code: 0, stdout: JSON.stringify({ version: '0.1.0', stratus: toolManifest, os: ['darwin'], cpu: ['arm64'], libc: ['glibc'] }), stderr: '' }),
    { status: 'published', version: '0.1.0', stratus: toolManifest, os: ['darwin'], cpu: ['arm64'], libc: ['glibc'] },
  );
  const notFound = JSON.stringify({ error: { code: 'E404', summary: 'Not Found - GET https://registry.npmjs.org/x' } });
  assert.deepEqual(parseNpmView({ code: 1, stdout: notFound, stderr: 'npm error code E404' }), { status: 'unpublished' });
  assert.deepEqual(parseNpmView({ code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }), { status: 'unknown' });
  assert.deepEqual(parseNpmView({ code: 0, stdout: '', stderr: '' }), { status: 'unknown' });
  assert.deepEqual(parseNpmView({ code: 0, stdout: 'not json', stderr: '' }), { status: 'unknown' });
  assert.deepEqual(parseNpmView(undefined), { status: 'unknown' });
  // The version is printed in a reason line, and the registry is whatever
  // the operator's npm points at: anything but a plain version is unknown.
  assert.deepEqual(parseNpmView({ code: 0, stdout: JSON.stringify('1.0.0\u001b[2J'), stderr: '' }), { status: 'unknown' });
  assert.deepEqual(
    parseNpmView({ code: 0, stdout: JSON.stringify({ version: '1.0.0\nnext', stratus: toolManifest }), stderr: '' }),
    { status: 'unknown' },
  );
  assert.deepEqual(parseNpmView({ code: 0, stdout: '"1.0.0-beta.1+build.5"', stderr: '' }), {
    status: 'published',
    version: '1.0.0-beta.1+build.5',
  });
});

test('release checks ask about each name once, a few at a time', async () => {
  let running = 0;
  let peak = 0;
  const asked: string[] = [];
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'a'];
  const releases = await checkPluginReleases(names, {
    pluginReleaseReader: async (name) => {
      asked.push(name);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (name === 'c') {
        throw new Error('spawn npm ENOENT');
      }
      return { status: 'published', version: '1.0.0', stratus: toolManifest };
    },
  });
  assert.deepEqual([...asked].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.ok(peak <= 4, `at most 4 npm processes at once, saw ${peak}`);
  assert.equal(releases.size, 9);
  assert.deepEqual(releases.get('c'), { status: 'unknown' });
  assert.equal(releases.get('a')?.status, 'published');
});
