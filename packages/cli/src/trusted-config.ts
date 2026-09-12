import {
  readTrustedConfigBlock,
  type ApiConfig,
  type ApprovalsConfig,
  type PrincipalsConfig,
  type PluginsConfig,
} from '@stratusagent/state';
import type { CliEnvironment } from './environment.ts';

/**
 * A credential that exists only in this shell cannot reach the daemon: a
 * service manager starts with its own environment and never sources a
 * profile, so the unit would come up unauthenticated while setup had just
 * reported everything ready. Returns the variable to name, if so.
 */
/**
 * The daemon's `approvals` block, from the config file the daemon itself
 * would load. Discovery goes through the shared resolver rather than
 * reading ~/.stratus/config.json directly: `--config` and STRATUS_CONFIG
 * both move it, and a second copy of that precedence would resolve the
 * approver set from a file the gateway is not running on.
 *
 * **Only from a trusted location.** An auto-discovered project-local
 * `stratus.config.json` outranks the global one and can be checked into any
 * repository — which is why stored credentials are already never combined
 * with an endpoint it selects. This block is the same kind of boundary and
 * a sharper one: it names the people who may authorize an agent's gated
 * tool calls, and it would do so through Slack tokens the user configured
 * globally. A cloned repo must not be able to appoint its own approver, so
 * an untrusted config's approvals are ignored — loudly, since silently
 * dropping the block someone is looking at is its own kind of wrong.
 *
 * An unreadable config degrades to headless with a warning, matching how
 * every other consumer treats one: refusing to start would take the whole
 * fleet down over a policy block that may not even be present.
 */
export const loadServeApprovals = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<ApprovalsConfig> => {
  const block = await readTrustedConfigBlock('approvals', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the approvals config in ${block.path}: a project-local config cannot decide who may approve `
      + 'this daemon\'s tool calls. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the approvals config (${block.error instanceof Error ? block.error.message : String(block.error)}); refusing gated calls`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};

/**
 * One line naming who can actually answer, so a remote daemon does not look
 * configured when it is not. Two ways it can be hollow, and they fail
 * differently, so they read differently:
 *
 * - No channel running at all (no Slack tokens, or the optional package is
 *   not installed) — nothing renders the request, so the turn waits out the
 *   whole timeout before being denied. That is the bad one, and the only
 *   place it is visible is here, at startup.
 * - A channel is running but an agent has no approvers — the adapter denies
 *   that agent's requests on arrival, which is at least prompt.
 *
 * `agentIds` is therefore the agents that can actually be *asked*, not
 * every agent with tokens on disk.
 */
/**
 * The `principals` block, read under the same trust rule as `approvals` and
 * for a sharper reason: it names the people whose messages an agent takes
 * as its operator's, which is the trust root everything downstream lowers
 * from. A cloned repo appointing itself the principal would arrive as
 * `user` in every Slack thread the daemon serves.
 */
export const loadServePrincipals = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<PrincipalsConfig> => {
  const block = await readTrustedConfigBlock('principals', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the principals config in ${block.path}: a project-local config cannot decide whose messages `
      + 'this daemon\'s agents treat as their operator\'s. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the principals config (${block.error instanceof Error ? block.error.message : String(block.error)}); every Slack sender is unknown`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};

/**
 * The daemon's `api` block, from the config file the daemon itself would
 * load — and only from a trusted location.
 *
 * An auto-discovered project-local `stratus.config.json` outranks the global
 * one and can be checked into any repository. Which interface a daemon binds
 * is exactly the kind of decision a cloned repo must not get to make, so an
 * untrusted config's block is ignored loudly rather than obeyed.
 */
export const loadServeApi = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<ApiConfig> => {
  const block = await readTrustedConfigBlock('api', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the api config in ${block.path}: a project-local config cannot decide which interface this `
      + 'daemon binds. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the api config (${block.error instanceof Error ? block.error.message : String(block.error)}); using the defaults`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};

/**
 * The daemon's `plugins` block — the same trust boundary as the three above,
 * and the one it was written for. A plugin runs in-process with the daemon,
 * so a list of them is a list of code; a `stratus.config.json` that ships
 * in a cloned repository must not be able to write it.
 */
export const loadServePlugins = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<PluginsConfig> => {
  const block = await readTrustedConfigBlock('plugins', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the plugins config in ${block.path}: a project-local config cannot decide which code runs inside `
      + 'this daemon. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the plugins config (${block.error instanceof Error ? block.error.message : String(block.error)}); loading no plugins`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};
