import { isPackageName, PLUGIN_MANIFEST_VERSION } from '@stratusagent/plugins';
import type { CliEnvironment } from './environment.ts';
import { runNpm, type NpmResult } from './npm.ts';

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
 * The entries of an index this CLI can read, or `undefined` for anything
 * else. An entry without a package name npm could be handed, or without a
 * description, is dropped: the names reach `npm view` and `npm install -g`,
 * and on Windows those run through a shell.
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
    if (!isPackageName(entry.name) || description.length === 0 || seen.has(entry.name)) {
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
  | { status: 'published'; version: string; stratus?: unknown; os?: unknown }
  | { status: 'unpublished' }
  | { status: 'unknown' };

export type PluginReleaseReader = (name: string) => Promise<PluginRelease>;

/**
 * Reads `npm view <name>@latest version stratus os --json`.
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
  if (typeof printed === 'string' && printed.length > 0) {
    return { status: 'published', version: printed };
  }
  if (!isObject(printed) || typeof printed.version !== 'string') {
    return { status: 'unknown' };
  }
  return {
    status: 'published',
    version: printed.version,
    ...('stratus' in printed ? { stratus: printed.stratus } : {}),
    ...('os' in printed ? { os: printed.os } : {}),
  };
};

export const defaultPluginReleaseReader: PluginReleaseReader = async (name) => {
  if (!isPackageName(name)) {
    return { status: 'unknown' };
  }
  return parseNpmView(await runNpm(['view', `${name}@latest`, 'version', 'stratus', 'os', '--json']));
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

/**
 * npm's own reading of an `os` field (npm-install-checks `checkList`): a
 * `!name` entry excludes that platform, any plain entry makes the list an
 * allowlist, and `any` alone allows everything. A field that is neither a
 * string nor a list of strings is one npm would not enforce either.
 */
const osAllows = (os: unknown, platform: NodeJS.Platform): boolean => {
  const list = typeof os === 'string' ? [os] : Array.isArray(os) && os.every((entry) => typeof entry === 'string') ? os as string[] : undefined;
  if (list === undefined || list.length === 0 || (list.length === 1 && list[0] === 'any')) {
    return true;
  }
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (entry.startsWith('!')) {
      negated += 1;
      if (entry.slice(1) === platform) {
        return false;
      }
    } else if (entry === platform) {
      match = true;
    }
  }
  return match || negated === list.length;
};

const nonEmptyList = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/**
 * Whether setup offers a release, read from the release itself rather than
 * the index: published, a plugin this CLI loads, able to run here, and
 * adding tools, since setup's Plugins menu is a tools menu. Only the latest
 * release is asked about; one that fails is not offered, so a publisher's
 * incompatible release can't break an older CLI's setup.
 */
export const releaseVerdict = (
  release: PluginRelease,
  platform: NodeJS.Platform,
): { offer: true; version: string } | { offer: false; reason: string } => {
  if (release.status === 'unpublished') {
    return { offer: false, reason: 'not on npm yet' };
  }
  if (release.status === 'unknown') {
    return { offer: false, reason: 'npm did not answer' };
  }
  const { version, stratus } = release;
  if (!isObject(stratus)) {
    return { offer: false, reason: `its latest release (${version}) is not a Stratus plugin` };
  }
  if (stratus.pluginVersion !== PLUGIN_MANIFEST_VERSION) {
    return {
      offer: false,
      reason: `its latest release (${version}) is plugin version ${JSON.stringify(stratus.pluginVersion)}, and this CLI loads version ${PLUGIN_MANIFEST_VERSION}`,
    };
  }
  if (!osAllows(release.os, platform)) {
    return { offer: false, reason: `it does not run on ${platform}` };
  }
  const contributes = isObject(stratus.contributes) ? stratus.contributes : {};
  if (!nonEmptyList(contributes.tools) && !nonEmptyList(contributes.toolsDiscovered)) {
    return { offer: false, reason: 'it adds no tools' };
  }
  return { offer: true, version };
};
