import type { ParsedSoul } from '@stratusagent/agents';
import { discoverActiveConfig } from './config-location.ts';
import type { RuntimeConfig, RuntimeSelection } from './config.ts';
import { type StateEnvironment, readNonEmptyString } from './environment.ts';
import { parseProviderName } from './provider-names.ts';
import { resolveRuntimeConfig } from './runtime.ts';
import { resolveConfiguredSoul, loadRosterSouls } from './souls.ts';

// ---------------------------------------------------------------------------
// What a served agent actually resolves to
//
// Everything from here down used to live as private helpers inside the CLI's
// `runSetup` / `runAgents` / `runServe`, or — for `applySoulPins` — inside the
// gateway. The control API answers the same questions those commands answer,
// and this repository's most repeated defect is a second hand-rolled copy of a
// rule that already has exactly one implementation. So they moved here, beside
// `resolveRuntimeConfig`, and their old homes import them.
// ---------------------------------------------------------------------------

/** Where the daemon-wide provider default could have come from. */
export interface SoulPinContext {
  /** A provider fixed by the caller (the gateway's own selection). */
  selectionProvider?: string;
  /** The provider named by the active config file. */
  configProvider?: string;
  /** Whether a config file was found at all. */
  configPresent: boolean;
}

/**
 * Apply a soul's provider/model pins to a selection, demoting the
 * daemon-wide defaults the pins outrank.
 *
 * Exported because this is not only dispatch logic: anything that wants to
 * know what a served agent will actually resolve to — a startup billing
 * check, a diagnostic, the control API's health report — has to normalize
 * the same way, and a second copy of these rules drifts from this one.
 *
 * Lives here rather than in the gateway (which re-exports it, so the
 * documented import path still works) because it has no gateway dependency
 * at all: it is a rule about selections, environments, and souls, and it
 * belongs beside the resolver whose precedence it is manipulating.
 */
/**
 * Whether two provider selections name one provider, whatever form each
 * was written in: a soul's `ollama` and a config's `plugin:ollama` are the
 * same selection. A value that is not a provider name at all is compared
 * as written, so this never throws where the resolver would.
 */
const sameProviderName = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    try {
      return parseProviderName(value, 'provider');
    } catch {
      return value;
    }
  };
  return normalize(left) === normalize(right);
};

export const applySoulPins = (
  pins: ParsedSoul,
  selection: RuntimeSelection,
  env: StateEnvironment,
  context: SoulPinContext,
): { selection: RuntimeSelection; env: StateEnvironment } => {
  selection.presetSoul = pins;
  if (!pins.provider && !pins.model) {
    return { selection, env };
  }
  const processEnv = { ...(env.processEnv ?? process.env) };
  // The daemon-wide default can come from the selection, the environment,
  // or the config file. A config with no provider key predates the
  // anthropic option and is openai-specific (the resolver treats it that
  // way), so a real file without the key still names openai as the
  // default. Env values normalize exactly as the resolver normalizes
  // them: an empty or whitespace-padded STRATUS_PROVIDER is no default at
  // all, not a mismatching one.
  const defaultProvider: string | undefined = context.selectionProvider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER)
    ?? context.configProvider
    ?? (context.configPresent ? 'openai' : undefined);
  if (pins.provider) {
    delete selection.provider;
    delete processEnv.STRATUS_PROVIDER;
    if (defaultProvider !== undefined && defaultProvider !== 'demo' && !sameProviderName(pins.provider, defaultProvider)) {
      // The default model, endpoint, and generic credentials were all
      // chosen for the default provider — none may ride along to the
      // soul's: a base URL would point the pinned provider at the wrong
      // service, and a generic API key would be sent to it. With NO
      // default selected anywhere — or the credential-less demo provider
      // as the default — there is nothing those values could have been
      // chosen for except whatever provider the soul selects — exactly
      // the resolver's own reading of a generic credential — so they stay.
      delete selection.model;
      delete processEnv.STRATUS_MODEL;
      delete selection.baseUrl;
      delete processEnv.STRATUS_BASE_URL;
      delete processEnv.STRATUS_API_KEY;
      delete processEnv.STRATUS_API_KEY_ENV;
    }
  }
  if (pins.model) {
    delete selection.model;
    delete processEnv.STRATUS_MODEL;
  }
  return { selection, env: { ...env, processEnv } };
};

/** One resolved runtime, with the environment it resolved under. */
export interface ServedRuntime {
  runtime: RuntimeConfig;
  env: StateEnvironment;
}

/**
 * Every runtime the daemon would resolve: the config-wide default plus one
 * per roster soul, normalized the way a dispatch normalizes it. A soul that
 * pins its own provider resolves to different credentials entirely, so any
 * check that looks only at the default misses exactly the agent that is
 * misconfigured.
 */
export const servedRuntimes = async (
  env: StateEnvironment,
  configPath?: string,
  /**
   * The roster to resolve, for a caller that knows it better than the disk
   * does — one entry per served agent, its parsed soul when it has one and
   * `undefined` for the built-in (which pins nothing, so it resolves the
   * daemon-wide default).
   *
   * A running gateway is that caller: it keeps dispatching from the soul it
   * loaded when the file is deleted or momentarily unparseable, and it has
   * not seen a soul added since the last reload — so a directory scan
   * describes runtimes it does not serve and omits ones it does. Before
   * start, and for the CLI's preflight, there is no roster but the disk's,
   * which is why scanning stays the default rather than moving to the caller.
   */
  roster?: Array<ParsedSoul | undefined>,
): Promise<ServedRuntime[]> => {
  // The pinned file, not whatever the working directory holds. What this
  // discovers decides which daemon-wide model, endpoint, and credentials
  // `applySoulPins` demotes, so resolving against `configPath` while deriving
  // the pin context from a different file describes a runtime the gateway
  // never builds.
  const { config: activeConfig, location } = await discoverActiveConfig(env, () => {}, configPath);
  const context: SoulPinContext = {
    ...(activeConfig.provider !== undefined ? { configProvider: activeConfig.provider } : {}),
    configPresent: location !== undefined,
  };
  // The daemon-wide default pass, carrying the configured default soul's
  // pins when there is one.
  //
  // `loadRosterSouls` scans only the agents directory, so a `soul` named by
  // the config from anywhere else is seen by this pass alone — and
  // `resolveRuntimeConfig` ranks the environment *above* a soul's provider,
  // while dispatch runs `applySoulPins` first and demotes it. Without this
  // the default agent's runtime is reported as whatever `STRATUS_PROVIDER`
  // says while its turns run somewhere else, and the startup credential
  // check looks for the wrong provider's key.
  const passes: Array<{ selection: RuntimeSelection; env: StateEnvironment }> = [];
  if (roster) {
    // No separate default pass: a supplied roster already contains whatever
    // answers an agentId-less dispatch — the configured default soul with its
    // pins, or the unpinned built-in, which resolves the daemon-wide default
    // exactly as the base pass below does. Adding one anyway would report a
    // runtime for a default that a soul had taken over and nothing serves.
    for (const soul of roster) {
      passes.push(soul ? applySoulPins(soul, {}, env, context) : { selection: {} as RuntimeSelection, env });
    }
  } else {
    const configuredSoul = await resolveConfiguredSoul(configPath ? { configPath } : {}, env)
      .catch(() => undefined);
    passes.push(configuredSoul
      ? applySoulPins(configuredSoul.soul, {}, env, context)
      : { selection: {} as RuntimeSelection, env });
    // A roster that will not load is the gateway's to refuse, with a better
    // message than this preflight could give — so it checks what it can and
    // leaves the failing to start().
    const rosterForRuntimes = await loadRosterSouls(env, () => {}).catch(() => []);
    for (const entry of rosterForRuntimes) {
      passes.push(applySoulPins(entry.soul, {}, env, context));
    }
  }

  const resolved: ServedRuntime[] = [];
  for (const pass of passes) {
    // A runtime that cannot resolve is the gateway's to report, per
    // dispatch and with far better context than a startup pass has.
    const runtime = await resolveRuntimeConfig(
      { ...pass.selection, ...(configPath ? { configPath } : {}) },
      pass.env,
    ).catch(() => undefined);
    if (runtime) {
      resolved.push({ runtime, env: pass.env });
    }
  }
  return resolved;
};
