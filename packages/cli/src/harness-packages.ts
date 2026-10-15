import { HARNESS_PACKAGE_NAMES, harnessesUsedBy, readProcessEnv, servedRuntimes } from '@stratusagent/state';
import type { CliEnvironment, CliStreams } from './environment.ts';
import { writeLine } from './io.ts';
import { packageInstalled } from './loaders.ts';
import { CLI_VERSION, defaultPackageInstaller } from './npm.ts';

/**
 * The harness provider packages (claude-code, codex) that the agents this
 * config serves run on and that are not installed here.
 *
 * Neither ships with the CLI: each brings a native binary of a few hundred
 * MB, and most machines use one or neither. So whatever decides a provider
 * (setup) or replaces the CLI (update) has to put the one in use beside it.
 * Read through `servedRuntimes`, the same resolution the daemon and doctor
 * use, so a soul that pins its own provider counts; a runtime that does not
 * resolve is left to the checks that report that.
 */
export const missingHarnessPackages = async (
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
  // harness this shell's view would skip. Installing one a shell override
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
  const used = new Set(runtimes.flatMap(({ runtime }) => harnessesUsedBy(runtime)));
  return [...used]
    .map((harness) => HARNESS_PACKAGE_NAMES[harness])
    .filter((name) => !packageInstalled(name, env));
};

/**
 * Installs `packages` at this CLI's own version (they ship in lockstep) and
 * says so. Returns whether npm succeeded. Never throws: the caller has
 * already saved what it saved, and a missing harness fails only the turns
 * that need it, with the install command.
 */
export const installHarnessPackages = async (
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
 * What doctor and serve say when an agent's harness is not installed: a
 * plain `npm install -g @stratusagent/cli` upgrade from a build that carried
 * both drops them, and every turn on that provider then fails.
 */
export const harnessesMissingMessage = (packages: readonly string[]): string => {
  const one = packages.length === 1;
  return `${packages.join(' and ')} ${one ? 'is' : 'are'} not installed, and ${one ? 'an agent runs on it' : 'agents run on them'}, so ${one ? 'its' : 'their'} turns fail. `
    + `Run \`stratus update\` or \`npm install -g ${packages.map((name) => `${name}@${CLI_VERSION}`).join(' ')}\`, then restart the daemon.`;
};
