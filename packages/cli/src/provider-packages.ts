import { PROVIDER_PACKAGE_NAMES, providerPackagesUsedBy, readProcessEnv, servedRuntimes, type RuntimeConfig } from '@stratusagent/state';
import type { CliEnvironment, CliStreams } from './environment.ts';
import { writeLine } from './io.ts';
import { packageInstalled } from './loaders.ts';
import { CLI_VERSION, defaultPackageInstaller } from './npm.ts';

/**
 * The provider packages (anthropic, claude-code, codex) that the agents
 * this config serves run on and that are not installed here.
 *
 * None ships with the CLI: the harnesses each bring a native binary of a
 * few hundred MB, and a fresh install carries no provider at all, so most
 * machines have only the one they picked. Whatever decides a provider
 * (setup) or replaces the CLI (update) has to put the one in use beside it.
 * Read through `servedRuntimes`, the same resolution the daemon and doctor
 * use, so a soul that pins its own provider counts; a runtime that does not
 * resolve is left to the checks that report that.
 */
export const missingProviderPackages = async (
  env: CliEnvironment,
  configPath?: string,
  /** Setup and update, which install what a service started later runs on. */
  options: { asService?: boolean } = {},
): Promise<string[]> => {
  // With asService, resolved twice: as this shell would run it, and as the
  // service would.
  // The unit carries only PATH, so a provider key or STRATUS_* override
  // exported here (ANTHROPIC_API_KEY beside a stored Claude sign-in, say)
  // reaches a foreground run but never the daemon, which then needs the
  // package this shell's view would skip. Installing one a shell override
  // happens to avoid costs disk; missing one fails every turn.
  const shellEnv = readProcessEnv(env);
  const serviceEnv: CliEnvironment = {
    ...env,
    processEnv: {
      ...(shellEnv.PATH !== undefined ? { PATH: shellEnv.PATH } : {}),
      ...(shellEnv.HOME !== undefined ? { HOME: shellEnv.HOME } : {}),
    },
  };
  const runtimes = (await Promise.all((options.asService ? [env, serviceEnv] : [env]).map(
    (view) => servedRuntimes(view, configPath).catch(() => []),
  ))).flat();
  return uninstalledProviderPackages(runtimes.map(({ runtime }) => runtime), env);
};

/**
 * The provider packages `runtimes` load on their turns (a fallback's
 * included) that are not installed here. The rule both of setup's
 * installs go through: Save's, for the saved files, and the Test run's,
 * for the selection setup is still holding.
 */
export const uninstalledProviderPackages = (
  runtimes: readonly RuntimeConfig[],
  env: CliEnvironment,
): string[] => {
  const used = new Set(runtimes.flatMap((runtime) => providerPackagesUsedBy(runtime)));
  return [...used]
    .map((pkg) => PROVIDER_PACKAGE_NAMES[pkg])
    .filter((name) => !packageInstalled(name, env));
};

/**
 * Installs `packages` at this CLI's own version (they ship in lockstep) and
 * says so. Returns whether npm succeeded. Never throws: the caller has
 * already saved what it saved, and a missing provider fails only the turns
 * that need it, with the install command.
 */
export const installProviderPackages = async (
  packages: readonly string[],
  streams: CliStreams,
  env: CliEnvironment,
): Promise<boolean> => {
  if (packages.length === 0) {
    return true;
  }
  const specifiers = packages.map((name) => `${name}@${CLI_VERSION}`);
  writeLine(streams.stdout, `Your agents run on ${packages.length === 1 ? 'a provider' : 'providers'} that ${packages.length === 1 ? 'needs' : 'need'} ${packages.join(' and ')}.`);
  writeLine(streams.stdout, `Running: npm install -g ${specifiers.join(' ')}`);
  const result = await (env.packageInstaller ?? defaultPackageInstaller)(specifiers)
    .catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  if (result.ok) {
    writeLine(streams.stdout, `Installed ${packages.join(' and ')}.`);
    return true;
  }
  writeLine(streams.stderr, `Could not install: ${result.message || 'unknown error'}`);
  writeLine(streams.stderr, `Turns on that provider fail until it is installed. Run \`npm install -g ${specifiers.join(' ')}\` yourself.`);
  return false;
};

/**
 * What doctor and serve say when an agent's provider package is not
 * installed: a plain `npm install -g @stratusagent/cli` upgrade from a build
 * that carried it drops it (the Anthropic adapter and, earlier, the
 * harnesses were CLI dependencies), and every turn on that provider then
 * fails.
 */
export const providerPackagesMissingMessage = (packages: readonly string[]): string => {
  const one = packages.length === 1;
  return `${packages.join(' and ')} ${one ? 'is' : 'are'} not installed, and ${one ? 'an agent runs on it' : 'agents run on them'}, so ${one ? 'its' : 'their'} turns fail. `
    + `Run \`stratus update\` or \`npm install -g ${packages.map((name) => `${name}@${CLI_VERSION}`).join(' ')}\`, then restart the daemon.`;
};
