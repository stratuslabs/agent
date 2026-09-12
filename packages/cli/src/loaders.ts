import type { CliEnvironment, PackageResolver } from './environment.ts';

/**
 * Resolution and loading are separate questions, and only the first one
 * means "not installed". Inspecting an import's error message cannot tell
 * them apart: a package that IS installed but is missing one of its own
 * dependencies throws ERR_MODULE_NOT_FOUND naming that dependency and the
 * importer — so a broken install would read as an absent one, silently
 * disabling a channel whose stored tokens say it should be running, or
 * leaving a daemon without the API an operator installed it to have.
 */
const defaultPackageResolver: PackageResolver = (specifier) => {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether an optional package is installed. The resolver is injectable
 * because what is installed is a property of the machine: a test asserting
 * on the real one would be asserting on its own node_modules, which is why
 * every optional package is a devDependency here in the first place.
 */
export const packageInstalled = (specifier: string, env: CliEnvironment = {}): boolean =>
  (env.packageResolver ?? defaultPackageResolver)(specifier);

type SlackAdapterFactory = typeof import('@stratusagent/channel-slack').createSlackChannelAdapter;

/**
 * Loads the optional Slack channel package, or undefined when it is not
 * installed. Only that package being absent is tolerated: an adapter that
 * fails to load for any other reason (a broken install, a bad transitive
 * dependency) surfaces rather than silently disabling Slack for a daemon
 * whose stored tokens say it should be running.
 */
export const loadSlackAdapter = async (): Promise<SlackAdapterFactory | undefined> => {
  if (!packageInstalled('@stratusagent/channel-slack')) {
    return undefined;
  }
  // Resolvable: any failure from here is a real problem with the
  // installed package, and surfaces.
  return (await import('@stratusagent/channel-slack')).createSlackChannelAdapter;
};

type ControlApiFactory = typeof import('@stratusagent/control-api').createControlApi;

export type GatewayFactory = typeof import('@stratusagent/gateway').createGateway;

/**
 * Loads the optional control-API package, or undefined when it is not
 * installed. Same two-step as the Slack adapter, and for the same reason:
 * only the package being absent means "not installed". A package that IS
 * installed but is missing one of its own dependencies throws
 * ERR_MODULE_NOT_FOUND naming that dependency, so inspecting the message
 * would read a broken install as an absent one — silently leaving a daemon
 * without the API an operator installed it to have.
 */
export const loadControlApi = async (): Promise<ControlApiFactory | undefined> => {
  if (!packageInstalled('@stratusagent/control-api')) {
    return undefined;
  }
  return (await import('@stratusagent/control-api')).createControlApi;
};
