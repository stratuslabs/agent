import type { CliEnvironment } from './environment.ts';
import { compareVersions, defaultInstalledVersionReader, CLI_VERSION } from './npm.ts';
import {
  FIRST_PARTY_CAPABILITY_PACKAGES,
  FIRST_PARTY_CONTRIBUTION_PACKAGES,
  FIRST_PARTY_COMPANION_PACKAGES,
} from './plugin-catalog.ts';

/** One first-party package this machine has, and how it compares to a target version. */
export interface CompanionPackage {
  name: string;
  version: string;
  stale: boolean;
}

/**
 * The first-party packages installed beside the CLI, and whether each one
 * lags `target`.
 *
 * The gap this closes: the CLI and its companions are separate global
 * installs, so upgrading `@stratusagent/cli` left every one of them at
 * whatever version was installed the day setup first ran. A Slack adapter
 * two releases behind the daemon loading it is not a configuration anyone
 * chose, and nothing reported it — `doctor` said "installed", which was
 * true of the stale one too.
 *
 * Read from each package's own manifest rather than asked of npm: the
 * question is what this machine has, one registry round trip per package
 * would answer a different one, and they ship in lockstep so the CLI's
 * version is theirs.
 */
export const readCompanions = async (
  target: string,
  env: CliEnvironment,
): Promise<CompanionPackage[]> => {
  const read = env.installedVersionReader ?? defaultInstalledVersionReader;
  const found: CompanionPackage[] = [];
  for (const name of [...FIRST_PARTY_COMPANION_PACKAGES, ...FIRST_PARTY_CAPABILITY_PACKAGES, ...FIRST_PARTY_CONTRIBUTION_PACKAGES]) {
    const version = await read(name);
    if (version !== undefined) {
      found.push({ name, version, stale: compareVersions(target, version) > 0 });
    }
  }
  return found;
};

/**
 * The sentence `doctor` and `serve` both say about companions this build
 * has outgrown. `stratus update` is the only upgrade path that brings them
 * along, and one that predates it — an update run by a CLI older than
 * 0.11.3, or a plain `npm install -g @stratusagent/cli` — left a Slack
 * adapter at 0.6.0 under a 0.11.4 daemon, missing every thread feature
 * shipped in between while `doctor` reported it installed.
 */
export const companionsBehindMessage = (stale: readonly CompanionPackage[]): string => {
  const names = stale.map((entry) => `${entry.name} ${entry.version}`).join(', ');
  const one = stale.length === 1;
  return `${names} ${one ? 'is' : 'are'} older than this CLI (${CLI_VERSION}). `
    + `They ship as one release, and the daemon runs whatever version is installed, so features and fixes after ${one ? 'that version are' : 'those versions are'} missing. `
    + `Run \`stratus update\` to bring ${one ? 'it' : 'them'} level.`;
};
