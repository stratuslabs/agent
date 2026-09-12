import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentsDirPath,
  defaultApiKeyEnvName,
  DEFAULT_STRATUS_AGENT,
  globalConfigPath,
  loadChannelCredentials,
  loadCredentials,
  loadRosterSouls,
  loadSoulFile,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  resolveRuntimeConfig as resolveStateRuntimeConfig,
  CREDENTIAL_PROVIDER_NAMES,
  type CredentialProviderName,
  type RosterEntry,
  type RuntimeConfig,
  type StratusConfigFile,
} from '@stratusagent/state';
import { readServiceCommand } from '../service.ts';
import { serviceEnvFor } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine, pathExists } from '../io.ts';
import { loadSlackAdapter } from '../loaders.ts';
import type { ParsedDoctorCommand } from '../parse.ts';

/** One resolved setting, with the thing that decided it. */
interface DoctorSetting {
  value: string;
  source: string;
}

export interface DoctorReport {
  configInUse?: string;
  /** Config files that exist but lost to `configInUse`, nearest first. */
  configShadowed: string[];
  provider: DoctorSetting;
  model?: DoctorSetting;
  soul?: DoctorSetting;
  agent?: string;
  /** The model a failing run retries on, when one is configured. */
  fallback?: { provider: string; model: string };
  signIns: Array<{ provider: CredentialProviderName; status: string }>;
  slackAgents: string[];
  slackPackageInstalled: boolean;
  rosterCount: number;
  problems: string[];
}

/**
 * `stratus doctor` — what a run would resolve to right now, and which file
 * or variable decided each part. Every "why is it using X" question needs
 * the precedence chain, and reading it out of the source is not something
 * anyone should have to do.
 */
export const collectDoctorReport = async (
  command: ParsedDoctorCommand,
  warn: (message: string) => void,
  env: CliEnvironment = {},
): Promise<DoctorReport> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const problems: string[] = [];

  // Config discovery, spelled out rather than delegated: doctor has to
  // report the files that LOST as well as the one in use, which is the
  // whole point when a stray project config is the answer.
  // Which of the two named it, not just that one did: telling someone to
  // fix STRATUS_CONFIG when --config is what is set leaves the real
  // override in place — the same mistake as provider and key attribution,
  // in the one place a typo is most likely.
  const explicitSource = command.configPath !== undefined
    ? { name: '--config', value: command.configPath }
    : readNonEmptyString(processEnv.STRATUS_CONFIG)
      ? { name: 'STRATUS_CONFIG', value: String(processEnv.STRATUS_CONFIG) }
      : undefined;
  const explicit = explicitSource?.value;
  const candidates = explicitSource
    ? [{ path: path.resolve(cwd, explicitSource.value), label: explicitSource.name }]
    : [
        { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), label: 'project' },
        { path: globalConfigPath(env), label: 'global' },
      ];
  const present: Array<{ path: string; label: string }> = [];
  let unreadable: { path: string; label: string } | undefined;
  for (const candidate of candidates) {
    try {
      await readFile(candidate.path, 'utf8');
      present.push(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // resolveConfigLocation throws here rather than trying the next
        // candidate, so discovery stops: a lower-priority file that a real
        // run never reaches must not be reported as the config in use.
        unreadable = candidate;
        problems.push(`${candidate.path} exists but cannot be read (${(error as Error).message}). Every run fails here — discovery never reaches a lower-priority config.`);
        break;
      }
      if (explicit) {
        // Discovery treats a missing candidate as "try the next one", but
        // an explicitly named config has no next one: a real run calls
        // loadConfigFile on it and fails. Reporting built-in defaults here
        // would describe a run that cannot happen, and hide the typo.
        problems.push(
          `${candidate.path} does not exist, but ${candidate.label} names it — every run with this setting fails. `
          + 'Fix the path, or drop the setting to fall back to config discovery.',
        );
      }
    }
  }
  const winner = unreadable ?? present[0];
  const shadowed = unreadable ? [] : present.slice(1);
  if (winner && shadowed.length > 0 && winner.label.startsWith('project')) {
    problems.push(
      `${winner.path} outranks ${shadowed.map((entry) => entry.path).join(' and ')} for runs started in this directory. `
      + 'Run from elsewhere, or pass --config to pick one explicitly.',
    );
  }

  let fileConfig: StratusConfigFile = {};
  let configFatal = unreadable !== undefined;
  if (winner && !unreadable) {
    try {
      fileConfig = await loadConfigFile(winner.path);
    } catch (error) {
      // resolveRuntimeConfig propagates this — no run reaches provider or
      // credential resolution, so presenting defaults as resolved settings
      // would describe a run that cannot happen.
      configFatal = true;
      problems.push(`${winner.path} could not be parsed (${(error as Error).message}). Every run fails until it is fixed or removed.`);
      warn(`ignoring unreadable config ${winner.path}`);
    }
  }

  // Which variable supplied a value, not just the value: naming the wrong
  // one sends the reader to unset something that was never the cause,
  // leaving the real override in place.
  const envPick = (name: string): { name: string; value: string } | undefined => {
    const value = readNonEmptyString(processEnv[name]);
    return typeof value === 'string' ? { name, value } : undefined;
  };

  /**
   * The verdict comes from the resolver, not from a second copy of its
   * rules. Everything below only *attributes* values to the file or
   * variable that supplied them — which the resolver does not report —
   * while whether a run works at all, and what it bills, is whatever
   * resolveRuntimeConfig actually returns or throws.
   */
  const envSoul = envPick('STRATUS_SOUL');
  const soulValue = envSoul?.value ?? fileConfig.soul;
  const soulSource = envSoul ? envSoul.name : (winner ? winner.path : '');
  const soulPath = typeof soulValue === 'string' ? path.resolve(cwd, soulValue) : undefined;
  // Loaded here for ATTRIBUTION only — the soul's frontmatter is what
  // explains a provider nobody wrote in a config file. Whether a run works
  // is still the resolver's verdict below.
  const soul = soulPath ? await loadSoulFile(soulPath).catch(() => undefined) : undefined;

  let resolved: RuntimeConfig | undefined;
  if (!configFatal) {
    try {
      resolved = await resolveStateRuntimeConfig(
        command.configPath ? { configPath: command.configPath } : {},
        env,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`No run can start: ${message}`);
      if (soulPath && /soul/i.test(message)) {
        // Worth saying explicitly: a soul that fails to load is fatal, not
        // a quiet downgrade to the built-in agent.
        problems.push(
          `Every run fails until ${soulPath} is fixed or the soul setting is removed — the built-in agent is not substituted.`,
        );
      }
    }
  }

  const envProviderPick = envPick('STRATUS_PROVIDER');
  const providerSource = envProviderPick
    ? envProviderPick.name
    : soul?.provider
      ? `${soulPath} (soul frontmatter)`
      : fileConfig.provider
        ? (winner?.path ?? 'config')
        : 'built-in default — nothing set a provider';
  // When resolution fails the intended provider is still worth reporting:
  // "why is it anthropic" is exactly the question, and the problems below
  // already say no run can start.
  const intendedProvider = envProviderPick?.value ?? soul?.provider ?? fileConfig.provider ?? 'demo';
  const provider: DoctorSetting = resolved
    ? { value: resolved.provider, source: providerSource }
    : { value: `${intendedProvider} (unreachable)`, source: providerSource };

  if (provider.value === 'demo') {
    // Setup writes the config file, which is the LOWEST precedence of the
    // three — so when an env var or a soul chose demo, "run setup" is
    // advice that changes nothing and leaves every run on demo.
    const fix = envProviderPick
      ? `Unset ${envProviderPick.name}; it outranks both your config and any soul.`
      : soul?.provider === 'demo'
        ? `Change or remove the provider pin in ${soulPath}; a soul outranks the config file.`
        : fileConfig.provider === 'demo'
          ? `Change "provider" in ${winner?.path}, or run \`stratus setup\` → Providers.`
          : 'Run `stratus setup` → Providers and sign in, then Save & finish.';
    problems.push(`Provider is the offline demo model, so replies are canned. ${fix}`);
  }

  let model: DoctorSetting | undefined;
  if (resolved && resolved.provider !== 'demo') {
    const envModel = envPick('STRATUS_MODEL');
    // A soul's model belongs to the soul's provider, and the config's model
    // to the config's provider — either can be stranded by an override.
    const soulModelApplies = soul?.provider === undefined || soul.provider === resolved.provider;
    const configModelApplies = (fileConfig.provider ?? 'openai') === resolved.provider;
    model = {
      value: resolved.model,
      source: envModel
        ? envModel.name
        : soulModelApplies && soul?.model === resolved.model
          ? `${soulPath} (soul frontmatter)`
          : configModelApplies && fileConfig.model === resolved.model
            ? (winner?.path ?? 'config')
            : 'built-in default for this provider',
    };
  }

  const credentials = await loadCredentials(env);
  const signIns: DoctorReport['signIns'] = [];
  const usedKeyEnvVar = resolved && resolved.provider !== 'demo' ? resolved.apiKeyEnvVar : undefined;
  const usesAuthToken = resolved?.provider === 'anthropic' && resolved.authToken !== undefined;
  const fallback = resolved && resolved.provider !== 'demo' ? resolved.fallback : undefined;

  for (const target of CREDENTIAL_PROVIDER_NAMES) {
    const stored = credentials[target];
    const label = stored?.type === 'oauth_token'
      ? (target === 'codex' ? 'ChatGPT sign-in (codex login)' : 'Claude subscription (Pro/Max)')
      : 'API key';
    const isDefault = resolved?.provider === target;
    const isFallback = fallback?.provider === target;

    // A provider no resolved run consults is reported, never diagnosed:
    // flagging an override on a credential nothing reads is a false alarm.
    if (!isDefault && !isFallback) {
      signIns.push({
        provider: target,
        status: stored
          ? `${label} (unused — ${resolved ? resolved.provider : 'nothing'} serves your runs)`
          : 'not signed in',
      });
      continue;
    }

    const envVar = isDefault ? usedKeyEnvVar : defaultApiKeyEnvName(target);
    const viaEnv = isDefault
      ? usedKeyEnvVar !== undefined
      : fallback?.apiKey !== undefined && fallback.apiKey === readNonEmptyString(processEnv[String(envVar)]);
    const where = isDefault ? 'runs are' : 'fallback runs are';

    if (stored && viaEnv) {
      signIns.push({ provider: target, status: `${label}, overridden by ${envVar} in your environment` });
      // The costly case: an env key silently demotes a subscription to
      // per-token billing, and nothing in a normal run says so.
      problems.push(stored.type === 'oauth_token'
        ? `${envVar} in your environment outranks your saved ${target} subscription sign-in, so ${where} billed per token instead of through your plan. Unset it (check your shell profile) to use the subscription.`
        : `${envVar} in your environment outranks your saved ${target} sign-in. Unset it to use the one \`stratus setup\` stored.`);
      continue;
    }
    if (viaEnv) {
      signIns.push({ provider: target, status: `using ${envVar} from your environment` });
      continue;
    }
    if (stored) {
      signIns.push({ provider: target, status: isDefault && usesAuthToken ? `${label} — runs go through the Claude Code runtime` : label });
      continue;
    }
    signIns.push({ provider: target, status: 'not signed in' });
  }

  // A fallback the resolver dropped is the quiet failure: the config still
  // names one, but a failing primary has nothing to retry on.
  if (fileConfig.fallbackModel !== undefined && resolved && resolved.provider !== 'demo' && !fallback) {
    problems.push(
      `A fallback model (${fileConfig.fallbackModel}) is configured but could not be resolved — usually no sign-in for its provider, or an endpoint its saved key is not sent to. `
      + 'A failing primary model has nothing to retry on.',
    );
  }

  const channels = await loadChannelCredentials(env);
  const slackAgents = Object.keys(channels.slack ?? {}).sort();
  const slackPackageInstalled = (await loadSlackAdapter()) !== undefined;
  if (slackAgents.length > 0 && !slackPackageInstalled) {
    problems.push(
      `Slack tokens are stored for ${slackAgents.length} agent(s) but @stratusagent/channel-slack is not installed, so \`stratus serve\` skips them. `
      + 'Install it with: npm install -g @stratusagent/channel-slack',
    );
  }

  let rosterCount = 0;
  try {
    rosterCount = (await readdir(agentsDirPath(env))).filter((file) => file.endsWith('.md')).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  // Tokens keyed to an agent the roster no longer has are loaded and
  // skipped on every start, silently.
  let rosterEntries: RosterEntry[] = [];
  let rosterLoaded = true;
  try {
    rosterEntries = await loadRosterSouls(env, warn);
  } catch (error) {
    // Doctor exists to name problems, so a roster it cannot load is a
    // finding to report — not an exception that replaces the report.
    rosterLoaded = false;
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const rosterIds = new Set(rosterEntries.map((entry) => entry.soul.agent.id));
  rosterIds.add(DEFAULT_STRATUS_AGENT.id);
  if (soul) {
    rosterIds.add(soul.agent.id);
  }
  // Only against a roster that actually loaded. "No agent has this id" is
  // a claim about the roster, and a refused one cannot support it — every
  // stored token would be reported as orphaned, and this advises clearing
  // them. Advice is not deletion, but an operator who follows it loses the
  // same credentials by hand.
  const orphans = rosterLoaded ? slackAgents.filter((id) => !rosterIds.has(id)) : [];
  if (orphans.length > 0) {
    problems.push(
      `Slack tokens are stored for ${orphans.join(', ')}, which no agent matches — \`stratus serve\` skips them. `
      + 'Clear them from `stratus setup` → Channels.',
    );
  }

  // The invisible failure doctor exists to surface: the service unit embeds
  // absolute node and entrypoint paths, and upgrading node (an nvm version
  // directory, say) leaves the unit pointing at an interpreter that no
  // longer exists. The service stops working and nothing else says so.
  const unitCommand = await readServiceCommand(serviceEnvFor(env));
  if (unitCommand?.execPath !== undefined && !(await pathExists(unitCommand.execPath))) {
    problems.push(
      `The service unit points at a node interpreter that no longer exists (${unitCommand.execPath}), so stratusd cannot start. `
      + 'Run `stratus update` (or `stratus service install`) to rewrite it with current paths.',
    );
  }
  if (unitCommand?.scriptPath !== undefined && !(await pathExists(unitCommand.scriptPath))) {
    problems.push(
      `The service unit points at a CLI entrypoint that no longer exists (${unitCommand.scriptPath}), so stratusd cannot start. `
      + 'Run `stratus update` (or `stratus service install`) to rewrite it with current paths.',
    );
  }

  return {
    ...(winner ? { configInUse: winner.path } : {}),
    configShadowed: shadowed.map((entry) => entry.path),
    provider,
    ...(model ? { model } : {}),
    ...(soulPath ? { soul: { value: soulPath, source: soulSource } } : {}),
    ...(soul ? { agent: `${soul.agent.name} (${soul.agent.id})` } : {}),
    ...(fallback ? { fallback: { provider: fallback.provider, model: fallback.model } } : {}),
    signIns,
    slackAgents,
    slackPackageInstalled,
    rosterCount,
    problems,
  };
};

export const runDoctor = async (
  command: ParsedDoctorCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const report = await collectDoctorReport(command, (message) => {
    writeLine(streams.stderr, `Warning: ${message}.`);
  }, env);

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify(report, null, 2));
    return report.problems.length > 0 ? 1 : 0;
  }

  const field = (label: string, setting?: DoctorSetting): void => {
    if (!setting) {
      return;
    }
    writeLine(streams.stdout, `  ${label.padEnd(10)}${setting.value}`);
    writeLine(streams.stdout, `  ${''.padEnd(10)}from ${setting.source}`);
  };

  writeLine(streams.stdout, 'Stratus Agent — what a run would use right now');
  writeLine(streams.stdout);
  field('provider', report.provider);
  field('model', report.model);
  field('soul', report.soul);
  if (report.agent) {
    writeLine(streams.stdout, `  ${'agent'.padEnd(10)}${report.agent}`);
  } else if (report.soul) {
    // A soul is configured but did not load — saying "built-in" here would
    // describe a run that cannot happen.
    writeLine(streams.stdout, `  ${'agent'.padEnd(10)}unresolved — the configured soul could not be read`);
  } else {
    writeLine(streams.stdout, `  ${'agent'.padEnd(10)}${DEFAULT_STRATUS_AGENT.name} (built-in — no soul configured)`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Files');
  writeLine(streams.stdout, `  config    ${report.configInUse ?? 'none found — built-in defaults apply'}`);
  for (const shadowedPath of report.configShadowed) {
    writeLine(streams.stdout, `            (${shadowedPath} exists but is outranked)`);
  }
  writeLine(streams.stdout, `  agents    ${report.rosterCount} soul file${report.rosterCount === 1 ? '' : 's'}`);

  if (report.fallback) {
    writeLine(streams.stdout, `  ${'fallback'.padEnd(10)}${report.fallback.provider} · ${report.fallback.model}`);
    writeLine(streams.stdout, `  ${''.padEnd(10)}used when the default model errors mid-run`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Sign-ins');
  for (const entry of report.signIns) {
    writeLine(streams.stdout, `  ${entry.provider.padEnd(10)}${entry.status}`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Channels');
  writeLine(streams.stdout, `  slack     ${report.slackAgents.length === 0
    ? 'no agents connected'
    : `${report.slackAgents.length} connected (${report.slackAgents.join(', ')})`}`);
  writeLine(streams.stdout, `            @stratusagent/channel-slack ${report.slackPackageInstalled ? 'installed' : 'not installed'}`);

  writeLine(streams.stdout);
  if (report.problems.length === 0) {
    writeLine(streams.stdout, 'No problems found.');
    return 0;
  }
  writeLine(streams.stdout, `${report.problems.length} problem${report.problems.length === 1 ? '' : 's'} found:`);
  for (const problem of report.problems) {
    writeLine(streams.stdout, `  ! ${problem}`);
  }
  return 1;
};
