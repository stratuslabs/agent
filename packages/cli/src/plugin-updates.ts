import { isPackageName } from '@stratusagent/plugins';
import type { CliEnvironment } from './environment.ts';
import { CLI_PACKAGE_NAME, compareVersions, defaultInstalledVersionReader, isInstallableSpecifier } from './npm.ts';
import {
  FIRST_PARTY_CAPABILITY_PACKAGES,
  FIRST_PARTY_COMPANION_PACKAGES,
  FIRST_PARTY_SEPARATE_PACKAGES,
} from './plugin-catalog.ts';
import { checkPluginReleases, currentPlatformHost, installSpecifier, loadableRelease, type PluginRelease } from './plugin-index.ts';
import { loadServePlugins } from './trusted-config.ts';

/** One configured plugin that releases apart from the CLI, and what `stratus update` can do about it. */
export type PluginUpdate =
  | { name: string; installed: string; state: 'current' }
  /** Its latest release is newer and would load here: install exactly `version`. */
  | { name: string; installed: string; state: 'behind'; version: string }
  /** Its latest release is newer, and this CLI would refuse it. */
  | { name: string; installed: string; state: 'held'; version: string; reason: string }
  /** npm gave no answer about it. */
  | { name: string; installed: string; state: 'unchecked'; reason: string };

/**
 * The packages released with the CLI. `readCompanions` holds them to the
 * CLI's own version, so they are never part of this sweep.
 */
const RELEASED_WITH_THE_CLI: ReadonlySet<string> = new Set([
  CLI_PACKAGE_NAME,
  ...FIRST_PARTY_COMPANION_PACKAGES,
  ...FIRST_PARTY_CAPABILITY_PACKAGES,
]);

const NOT_PLUGINS: ReadonlySet<string> = new Set(FIRST_PARTY_SEPARATE_PACKAGES);

/**
 * Whether a release of a package that is not a plugin can be installed
 * here. There is no manifest to judge, so only the installer's own fence
 * applies: a release it then refuses is a dead end.
 */
const installableRelease = (
  name: string,
  release: Extract<PluginRelease, { status: 'published' }>,
): { ok: true; version: string } | { ok: false; reason: string } => {
  const specifier = installSpecifier(name, release.version);
  return isInstallableSpecifier(specifier)
    ? { ok: true, version: release.version }
    : { ok: false, reason: `this CLI can't pass its latest release (${release.version}) to npm; run npm install -g ${specifier} yourself` };
};

/**
 * The plugins this machine runs that release on their own (everything from
 * `stratuslabs/plugins`, and anyone else's), and whether each lags its
 * latest release.
 *
 * The inventory is the trusted config's `plugins` block, read the way the
 * daemon reads it, narrowed to packages that are installed here: that is
 * what the daemon loads. Plus the first-party packages that are not
 * plugins (`FIRST_PARTY_SEPARATE_PACKAGES`) wherever they are installed,
 * since no config names them. Not the curated index, so a plugin installed by
 * hand, or later dropped from the index, is still kept current, and a
 * package that moves out of the monorepo keeps upgrading where it is
 * configured. A plugin installed but never configured is not loaded, and
 * setup's enable path checks its installed copy before using it.
 *
 * A newer release counts only if this build would load it, judged as
 * setup's More plugins judges one (`loadableRelease`), so an update never
 * moves a plugin to a release the loader would then refuse. Only the
 * latest release is asked about; one that fails is reported as held and
 * the installed copy stays.
 *
 * A config that can't be read gives no inventory rather than an error:
 * the daemon would load no plugins from it either, and `doctor` is the
 * command that reports why.
 */
export const readPluginUpdates = async (
  env: CliEnvironment,
  configPath: string | undefined,
): Promise<PluginUpdate[]> => {
  const configured = Object.keys(await loadServePlugins(env, configPath, () => {}).catch(() => ({})))
    .filter((name) => isPackageName(name) && !RELEASED_WITH_THE_CLI.has(name));
  const read = env.installedVersionReader ?? defaultInstalledVersionReader;
  const installed: Array<{ name: string; version: string }> = [];
  for (const name of new Set([...configured, ...FIRST_PARTY_SEPARATE_PACKAGES])) {
    const version = await read(name).catch(() => undefined);
    if (version !== undefined) {
      installed.push({ name, version });
    }
  }
  if (installed.length === 0) {
    return [];
  }
  const releases = await checkPluginReleases(installed.map((entry) => entry.name), env);
  const host = currentPlatformHost();
  return installed.map(({ name, version }): PluginUpdate => {
    const release = releases.get(name) ?? { status: 'unknown' };
    if (release.status !== 'published') {
      return { name, installed: version, state: 'unchecked', reason: release.status === 'unknown' ? 'npm did not answer' : 'not on npm' };
    }
    if (compareVersions(release.version, version) <= 0) {
      return { name, installed: version, state: 'current' };
    }
    const loadable = NOT_PLUGINS.has(name) ? installableRelease(name, release) : loadableRelease(name, release, host);
    return loadable.ok
      ? { name, installed: version, state: 'behind', version: loadable.version }
      : { name, installed: version, state: 'held', version: release.version, reason: loadable.reason };
  });
};
