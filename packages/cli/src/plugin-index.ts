import { readFileSync } from 'node:fs';
import { isPackageName, parsePluginManifest, PLUGIN_MANIFEST_VERSION, type PluginContributions } from '@stratusagent/plugins';
import type { CliEnvironment } from './environment.ts';
import { isInstallableSpecifier, runNpm, type NpmResult } from './npm.ts';

/**
 * The curated plugin index: the plugins that release on their own, apart
 * from this CLI, which setup's Plugins menu can offer under "More plugins".
 *
 * The packages released with the CLI are not in it. They are listed in
 * `plugin-catalog.ts`, always match this CLI, and are already rows of the
 * menu. The index is for everything else: `stratuslabs/plugins` and,
 * once there are some, third-party plugins someone has reviewed.
 *
 * It is data in `stratuslabs/plugins`, published to npm as
 * `@stratusagent/plugin-index`, with the list in a `stratusPluginIndex`
 * field of that package's package.json. npm because the repository is
 * private and npm is already the registry setup installs from, so no new
 * host is involved; and a field rather than a file because `npm view`
 * returns package.json fields without downloading anything.
 *
 * The index decides what setup *suggests*, never what it trusts or what a
 * plugin contributes: that is read from the plugin's own release, and
 * setup still asks before enabling anything.
 */
export const PLUGIN_INDEX_PACKAGE = '@stratusagent/plugin-index';
export const PLUGIN_INDEX_FIELD = 'stratusPluginIndex';
export const PLUGIN_INDEX_SCHEMA_VERSION = 1;

export interface PluginIndexEntry {
  /** The npm package name, which is also the `plugins` key it is enabled under. */
  name: string;
  /** One line on what it adds. Display text, never a claim setup relies on. */
  description: string;
}

/**
 * The index as it was when this CLI was released: what setup shows when npm
 * has no index or cannot be reached. Keep it equal to `index/package.json`
 * in `stratuslabs/plugins` at release time.
 */
export const BUNDLED_PLUGIN_INDEX: readonly PluginIndexEntry[] = [
  { name: '@stratusagent/plugin-spawn', description: 'Run several tasks at once in short-lived sub-agents' },
  { name: '@stratusagent/plugin-peer', description: 'Hand a task to an agent on another Stratus daemon' },
  { name: '@stratusagent/plugin-fleet', description: 'Read-only fleet metadata for an agent that reports what needs a person' },
  { name: '@stratusagent/plugin-a2ui', description: 'Show a native screen as A2UI, checked against your catalogs' },
  { name: '@stratusagent/plugin-dreams', description: 'Overnight experiment runs and a morning report (macOS)' },
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Line breaks and control characters (C0, DEL, C1, and the Unicode line and
 * paragraph separators). Index text and registry versions are printed
 * straight into setup's menu: a line break breaks the row, and an escape
 * sequence is something the terminal would act on.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A version as npm publishes one: semver's characters and nothing else. */
const PLAIN_VERSION = /^[0-9A-Za-z.+-]+$/;

/**
 * The entries of an index this CLI can read, or `undefined` for anything
 * else. An entry without a package name npm could be handed is dropped,
 * since the names reach `npm view` and `npm install -g`, and on Windows
 * those run through a shell. So is one whose description is empty or has a
 * line break or control character.
 */
export const parsePluginIndex = (value: unknown): PluginIndexEntry[] | undefined => {
  if (!isObject(value) || value.schemaVersion !== PLUGIN_INDEX_SCHEMA_VERSION || !Array.isArray(value.plugins)) {
    return undefined;
  }
  const entries: PluginIndexEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.plugins) {
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.description !== 'string') {
      continue;
    }
    const description = entry.description.trim();
    if (!isPackageName(entry.name) || description.length === 0 || UNPRINTABLE.test(description) || seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    entries.push({ name: entry.name, description });
  }
  return entries;
};

/** Reads the published index field, or `undefined` when npm has none. */
export type PluginIndexReader = () => Promise<unknown>;

export const defaultPluginIndexReader: PluginIndexReader = async () => {
  const result = await runNpm(['view', `${PLUGIN_INDEX_PACKAGE}@latest`, PLUGIN_INDEX_FIELD, '--json']);
  if (result === undefined || result.code !== 0 || result.stdout.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
};

/** The index to show, and whether it came from npm or this CLI's own copy. */
export const readPluginIndex = async (
  env: Pick<CliEnvironment, 'pluginIndexReader'>,
): Promise<{ source: 'npm' | 'bundled'; entries: PluginIndexEntry[] }> => {
  const published = await (env.pluginIndexReader ?? defaultPluginIndexReader)().catch(() => undefined);
  const entries = parsePluginIndex(published);
  return entries === undefined
    ? { source: 'bundled', entries: [...BUNDLED_PLUGIN_INDEX] }
    : { source: 'npm', entries };
};

/** What npm says about a package's latest release. */
export type PluginRelease =
  | { status: 'published'; version: string; stratus?: unknown; os?: unknown; cpu?: unknown; libc?: unknown }
  | { status: 'unpublished' }
  | { status: 'unknown' };

export type PluginReleaseReader = (name: string) => Promise<PluginRelease>;

/**
 * Reads `npm view <name>@latest version stratus os cpu libc --json`.
 *
 * npm prints an object when more than one requested field exists and the
 * bare value when only one does. `version` always exists, so a bare string
 * is a release with neither a manifest nor an os field.
 */
export const parseNpmView = (result: NpmResult | undefined): PluginRelease => {
  if (result === undefined) {
    return { status: 'unknown' };
  }
  let printed: unknown;
  try {
    printed = result.stdout.trim().length > 0 ? JSON.parse(result.stdout) as unknown : undefined;
  } catch {
    printed = undefined;
  }
  if (result.code !== 0) {
    const code = isObject(printed) && isObject(printed.error) ? printed.error.code : undefined;
    return code === 'E404' || /\bE404\b/.test(result.stderr) ? { status: 'unpublished' } : { status: 'unknown' };
  }
  // The version is printed in setup's reason lines, and the registry is
  // whichever one the operator's npm points at.
  if (typeof printed === 'string') {
    return PLAIN_VERSION.test(printed) ? { status: 'published', version: printed } : { status: 'unknown' };
  }
  if (!isObject(printed) || typeof printed.version !== 'string' || !PLAIN_VERSION.test(printed.version)) {
    return { status: 'unknown' };
  }
  return {
    status: 'published',
    version: printed.version,
    ...('stratus' in printed ? { stratus: printed.stratus } : {}),
    ...('os' in printed ? { os: printed.os } : {}),
    ...('cpu' in printed ? { cpu: printed.cpu } : {}),
    ...('libc' in printed ? { libc: printed.libc } : {}),
  };
};

export const defaultPluginReleaseReader: PluginReleaseReader = async (name) => {
  if (!isPackageName(name)) {
    return { status: 'unknown' };
  }
  return parseNpmView(await runNpm(['view', `${name}@latest`, 'version', 'stratus', 'os', 'cpu', 'libc', '--json']));
};

/** How many `npm view` processes run at once. Each is a Node process. */
const RELEASE_CHECK_CONCURRENCY = 4;

/** Asks npm about each name once, a few at a time. A reader that throws is an unknown answer. */
export const checkPluginReleases = async (
  names: readonly string[],
  env: Pick<CliEnvironment, 'pluginReleaseReader'>,
): Promise<Map<string, PluginRelease>> => {
  const read = env.pluginReleaseReader ?? defaultPluginReleaseReader;
  const queue = [...new Set(names)];
  const releases = new Map<string, PluginRelease>();
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      releases.set(name, await read(name).catch((): PluginRelease => ({ status: 'unknown' })));
    }
  };
  await Promise.all(Array.from({ length: Math.min(RELEASE_CHECK_CONCURRENCY, queue.length) }, worker));
  return releases;
};

/** The host as npm's platform check sees it (npm-install-checks `current-env`). */
export interface PlatformHost {
  os: NodeJS.Platform;
  cpu: string;
  /** `glibc` or `musl` on Linux; `null` where it can't be told, and everywhere else. */
  libc: string | null;
}

let libcFamily: string | null | undefined;

/**
 * This machine, read the way npm reads it before an install: libc only on
 * Linux, from `/usr/bin/ldd` and then the process report.
 */
export const currentPlatformHost = (): PlatformHost => {
  if (process.platform === 'linux' && libcFamily === undefined) {
    try {
      const ldd = readFileSync('/usr/bin/ldd', 'utf8');
      libcFamily = ldd.includes('musl') ? 'musl' : ldd.includes('GNU C Library') ? 'glibc' : null;
    } catch {
      const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | undefined;
      libcFamily = report?.header?.glibcVersionRuntime
        ? 'glibc'
        : report?.sharedObjects?.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-')) ? 'musl' : null;
    }
  }
  return { os: process.platform, cpu: process.arch, libc: process.platform === 'linux' ? libcFamily ?? null : null };
};

/**
 * npm's own reading of an `os`, `cpu` or `libc` field (npm-install-checks
 * `checkList`): a `!name` entry excludes that value, any plain entry makes
 * the list an allowlist, and `any` alone allows everything. A field that is
 * neither a string nor a list of strings is one npm would not enforce
 * either.
 */
const listAllows = (field: unknown, value: string): boolean => {
  const list = typeof field === 'string' ? [field] : Array.isArray(field) && field.every((entry) => typeof entry === 'string') ? field as string[] : undefined;
  if (list === undefined || list.length === 0 || (list.length === 1 && list[0] === 'any')) {
    return true;
  }
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (entry.startsWith('!')) {
      negated += 1;
      if (entry.slice(1) === value) {
        return false;
      }
    } else if (entry === value) {
      match = true;
    }
  }
  return match || negated === list.length;
};

/**
 * Whether a release would install and load here, read from the release
 * itself rather than the index. Each check defers to the code that would
 * refuse it later: the loader's own manifest parser, npm's platform checks,
 * and the installer's fence on what reaches npm. Only the latest release is
 * asked about, and whoever installs it pins exactly that version. One that
 * fails is never installed, so a publisher's incompatible release can't
 * break an older CLI.
 *
 * `stratus update` uses this as it is. Setup's More plugins adds one more
 * condition on top (`releaseVerdict`).
 */
export const loadableRelease = (
  name: string,
  release: PluginRelease,
  host: PlatformHost,
): { ok: true; version: string; contributes: PluginContributions } | { ok: false; reason: string } => {
  if (release.status === 'unpublished') {
    return { ok: false, reason: 'not on npm yet' };
  }
  if (release.status === 'unknown') {
    return { ok: false, reason: 'npm did not answer' };
  }
  const { version, stratus } = release;
  if (!isObject(stratus)) {
    return { ok: false, reason: `its latest release (${version}) is not a Stratus plugin` };
  }
  if (stratus.pluginVersion !== PLUGIN_MANIFEST_VERSION) {
    return {
      ok: false,
      reason: `its latest release (${version}) is plugin version ${JSON.stringify(stratus.pluginVersion)}, and this CLI loads version ${PLUGIN_MANIFEST_VERSION}`,
    };
  }
  let contributes: PluginContributions;
  try {
    ({ contributes } = parsePluginManifest({ name, stratus }, name));
  } catch (error) {
    // The loader quotes what it refuses with JSON.stringify, and anything
    // that still is not printable goes, since this is printed to a terminal.
    const message = (error instanceof Error ? error.message : String(error)).replace(new RegExp(UNPRINTABLE.source, 'g'), '');
    return { ok: false, reason: `its latest release (${version}) has a manifest this CLI would refuse: ${message}` };
  }
  // The checks npm makes before it installs (checkPlatform), so npm does
  // not refuse with EBADPLATFORM what was just judged installable.
  if (!listAllows(release.os, host.os)) {
    return { ok: false, reason: `it does not run on ${host.os}` };
  }
  if (!listAllows(release.cpu, host.cpu)) {
    return { ok: false, reason: `it does not run on ${host.cpu}` };
  }
  if (release.libc !== undefined && release.libc !== null && host.libc === null) {
    return { ok: false, reason: 'it needs a libc this host does not report' };
  }
  if (host.libc !== null && !listAllows(release.libc, host.libc)) {
    return { ok: false, reason: `it does not run with ${host.libc}` };
  }
  // Last, the installer's own fence on what reaches npm (a shell on
  // Windows): a release the installer then refuses is a dead end.
  if (!isInstallableSpecifier(installSpecifier(name, version))) {
    return {
      ok: false,
      reason: `this CLI can't pass its latest release (${version}) to npm; run npm install -g ${installSpecifier(name, version)} yourself`,
    };
  }
  return { ok: true, version, contributes };
};

/**
 * Whether setup's More plugins offers a release: it has to be loadable
 * (`loadableRelease`), and it has to add tools, since setup's Plugins menu
 * is a tools menu.
 *
 * A package that is already installed but not configured goes to the
 * normal enable path, which checks the installed copy's manifest with the
 * loader's preflight before writing anything. Setup doesn't replace a copy
 * the operator installed; keeping it current is `stratus update`'s job.
 */
export const releaseVerdict = (
  name: string,
  release: PluginRelease,
  host: PlatformHost,
): { offer: true; version: string } | { offer: false; reason: string } => {
  const loadable = loadableRelease(name, release, host);
  if (!loadable.ok) {
    return { offer: false, reason: loadable.reason };
  }
  const { contributes } = loadable;
  if (contributes.tools.length === 0 && contributes.toolsDiscovered.length === 0) {
    return { offer: false, reason: 'it adds no tools' };
  }
  return { offer: true, version: loadable.version };
};

/**
 * What setup hands `npm install -g` for a release it checked: that exact
 * version. A bare name installs whatever npm's configured `tag` points at,
 * which need not be the `latest` release the checks above passed. The
 * `plugins` key stays the bare name, since that is what the loader imports.
 */
export const installSpecifier = (name: string, version: string): string => `${name}@${version}`;
