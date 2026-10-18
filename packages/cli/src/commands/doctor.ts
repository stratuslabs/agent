import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  agentsDirPath,
  planAgentsHome,
  defaultApiKeyEnvName,
  DEFAULT_STRATUS_AGENT,
  globalConfigPath,
  loadChannelCredentials,
  loadCredentials,
  loadRosterSouls,
  loadSoulFile,
  isSignedInRuntime,
  parseProviderName,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  resolveAgentPrincipals,
  gatewayInfoPath,
  gatewayTokenPath,
  resolveRuntimeConfig as resolveStateRuntimeConfig,
  signedInProviders,
  CREDENTIAL_PROVIDER_NAMES,
  type CredentialProviderName,
  type RosterEntry,
  type RuntimeConfig,
  type StratusConfigFile,
  ignoredUntrustedConfigKeys,
  legacyWorkspacesDirPath,
  surveyLegacyWorkspaces,
  type LegacyWorkspaceState,
  quoteShellArg,
  verifyProviderKey,
  probeProviderModel,
} from '@stratusagent/state';
import { readServiceCommand } from '../service.ts';
import { callRunningGateway, gatewayErrorMessage, serviceEnvFor } from '../daemon.ts';
import { configDigest } from '../config-digest.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine, pathExists } from '../io.ts';
import { ignoredConfigRemedy } from '../runtime.ts';
import { loadSlackAdapter } from '../loaders.ts';
import { companionsBehindMessage, readCompanions } from '../companions.ts';
import { harnessesMissingMessage, missingHarnessPackages } from '../harness-packages.ts';
import { CLI_VERSION } from '../npm.ts';
import type { ParsedDoctorCommand } from '../parse.ts';

export interface DoctorKeyCheck {
  provider: CredentialProviderName;
  role: 'default' | 'fallback';
  status: 'accepted' | 'rejected' | 'unreachable' | 'not checked';
  detail?: string;
  /**
   * Once the key is accepted: what the run's model said to a one-token call.
   * `refused` is the provider declining it (unknown model, no credit);
   * `no answer` is offline, rate-limited or overloaded and judges nothing.
   */
  model?: { id: string; status: 'answered' | 'refused' | 'no answer' | 'not checked'; detail?: string };
}

/** The key and endpoint a run would send, or why there is none to check. */
const keyToCheck = (
  provider: CredentialProviderName,
  runtime: { apiKey?: string; authToken?: string; baseUrl?: string },
): { key: string; baseUrl?: string } | { skip: string } => {
  if (runtime.apiKey) {
    // codex verifies against OpenAI's default endpoint; its baseUrl is not a key endpoint.
    return { key: runtime.apiKey, ...(provider !== 'codex' && runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}) };
  }
  if (runtime.authToken || provider === 'codex') {
    return { skip: 'subscription sign-in, which has no key to check' };
  }
  return { skip: 'no key' };
};

/** A provider's models list or a one-token reply comes back in seconds; past this, doctor reports no answer instead of hanging. */
const KEY_CHECK_TIMEOUT_MS = 10_000;

/**
 * `fetchImpl` with a deadline. The signal stops a real request; the race
 * also covers a transport that ignores it, so doctor always finishes.
 */
const withDeadline = (fetchImpl: typeof fetch): typeof fetch => (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${KEY_CHECK_TIMEOUT_MS / 1000}s`));
    }, KEY_CHECK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }), expired]);
    // Read the body under the same deadline, so a reply that stalls
    // mid-body cannot hang doctor either.
    const body = await Promise.race([response.text(), expired]);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    clearTimeout(timer);
  }
}) as typeof fetch;

/**
 * `--live`: the one part of doctor that leaves the machine. Each provider a
 * run consults is asked whether it accepts the key that run would send —
 * the same free models-list call setup makes when the key is entered. An
 * accepted key is then used for a one-token call to the run's model, which
 * catches an unknown model or an account the provider will not bill. Only
 * a refusal is a problem: no answer says nothing about the key or model.
 */
const checkKeys = async (
  resolved: RuntimeConfig,
  env: CliEnvironment,
  problems: string[],
): Promise<DoctorKeyCheck[]> => {
  type Target = { provider: CredentialProviderName; role: DoctorKeyCheck['role']; model: string; runtime: { apiKey?: string; authToken?: string; baseUrl?: string } };
  const targets: Target[] = [];
  if (isSignedInRuntime(resolved)) {
    targets.push({ provider: resolved.provider, role: 'default', model: resolved.model, runtime: resolved as Target['runtime'] });
  }
  const fallback = resolved.provider !== 'demo' ? resolved.fallback : undefined;
  if (fallback && (CREDENTIAL_PROVIDER_NAMES as readonly string[]).includes(fallback.provider)) {
    targets.push({ provider: fallback.provider as CredentialProviderName, role: 'fallback', model: fallback.model, runtime: fallback });
  }
  const fetchImpl = withDeadline(env.fetch ?? globalThis.fetch);
  const checks: DoctorKeyCheck[] = [];
  for (const target of targets) {
    const plan = keyToCheck(target.provider, target.runtime);
    if ('skip' in plan) {
      checks.push({ provider: target.provider, role: target.role, status: 'not checked', detail: plan.skip });
      continue;
    }
    const verdict = await verifyProviderKey(target.provider, plan.key, plan.baseUrl, fetchImpl);
    const status = verdict.status === 'ok' ? 'accepted' : verdict.status;
    const check: DoctorKeyCheck = { provider: target.provider, role: target.role, status, ...(verdict.detail ? { detail: verdict.detail } : {}) };
    checks.push(check);
    if (status === 'accepted') {
      if (target.provider === 'codex') {
        check.model = { id: target.model, status: 'not checked', detail: 'codex runs it through its own harness' };
      } else {
        const reply = await probeProviderModel(target.provider, plan.key, target.model, plan.baseUrl, fetchImpl);
        check.model = { id: target.model, status: reply.status, ...(reply.detail ? { detail: reply.detail } : {}) };
        if (reply.status === 'refused') {
          problems.push(
            `${target.provider} accepted the key but would not run ${target.model} (${reply.detail ?? 'refused'}), so every such run fails. `
            + 'Choose a model the account can use with `stratus setup` → Model, or check the account\'s billing.',
          );
        }
      }
    }
    if (status === 'rejected') {
      problems.push(
        `${target.provider} refused the key ${target.role === 'default' ? 'your runs' : 'fallback runs'} send (${verdict.detail ?? 'auth failed'}), so every such run fails. `
        + 'Sign in again with `stratus setup` → Providers, or fix the environment variable that supplies it.',
      );
    }
  }
  return checks;
};

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
  /**
   * With `--live` only: what each provider a run uses said about its key.
   * `accepted`/`rejected` are the provider's answer; `unreachable` means no
   * answer (offline, or an endpoint with no key check); `not checked` is a
   * sign-in with no key to send, such as a subscription.
   */
  keyChecks?: DoctorKeyCheck[];
  slackAgents: string[];
  slackPackageInstalled: boolean;
  rosterCount: number;
  /**
   * The visible folder souls and workspaces live in (`~/Agents`, or
   * `~/Stratus` when `~/Agents` belongs to something else, or what
   * `STRATUS_AGENTS_DIR` names), as `planAgentsHome` decides it for `serve`
   * too. `claimed` is false for a folder the next start would create.
   * Absent when there is none, with the reason.
   */
  agentsFolder?: { path: string; claimed: boolean; pending: number } | { reason: string };
  /** The running daemon, as it reports itself. */
  daemon: DoctorDaemon;
  problems: string[];
}

/**
 * The daemon is asked rather than inferred: it read its config once, at
 * start, and runs on that until it restarts, so the file being healthy now
 * says nothing about the process. A real install had doctor report "No
 * problems found" while the daemon ran with no plugins and no soul.
 */
export type DoctorDaemon =
  | { state: 'no-api' }
  | { state: 'unreachable'; url: string }
  | { state: 'running'; url: string; version?: string; startedAt?: string; configPath?: string };

/** Long enough for a busy daemon on loopback, short enough that doctor never hangs on a wedged one. */
const DAEMON_TIMEOUT_MS = 3_000;

interface DaemonHealth {
  ok?: boolean;
  version?: string;
  startedAt?: string;
  startup?: { warnings?: unknown; configs?: unknown };
}

/** What a daemon's /health said about each config file at start, keeping only well-formed entries. */
const startedConfigs = (raw: unknown): Array<{ path: string; sha256: string | null }> =>
  Array.isArray(raw)
    ? raw.flatMap((entry) => {
        const { path: file, sha256 } = (entry ?? {}) as { path?: unknown; sha256?: unknown };
        return typeof file === 'string' && (typeof sha256 === 'string' || sha256 === null) ? [{ path: file, sha256 }] : [];
      })
    : [];

const inspectDaemon = async (env: CliEnvironment, problems: string[]): Promise<DoctorDaemon> => {
  // Read here rather than through readGatewayInfo, which folds a damaged
  // file into "none": only a missing file is the benign case.
  const infoPath = gatewayInfoPath(env);
  let raw: string;
  try {
    raw = await readFile(infoPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Information, not a problem: `stratus run` needs no daemon, and a
      // daemon started with its control API off publishes no file either.
      return { state: 'no-api' };
    }
    problems.push(`${infoPath} cannot be read (${(error as Error).message}), so doctor cannot find the running daemon. Check its permissions, or remove it and \`stratus restart\`.`);
    return { state: 'no-api' };
  }
  let url: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    url = typeof parsed.url === 'string' ? parsed.url : undefined;
  } catch {
    url = undefined;
  }
  if (url === undefined) {
    problems.push(`${infoPath} is damaged (no daemon address in it), so no command can find the running daemon. Run \`stratus restart\` to have it written again.`);
    return { state: 'no-api' };
  }
  url = url.replace(/\/+$/, '');

  let health: DaemonHealth;
  try {
    // The token this machine's daemon wrote, never STRATUS_GATEWAY_TOKEN:
    // that names a remote gateway, and the address here is the local one.
    const token = (await readFile(gatewayTokenPath(env), 'utf8')).trim();
    const response = await callRunningGateway(env, { token }, url, '/api/v1/health', undefined, 'GET', AbortSignal.timeout(DAEMON_TIMEOUT_MS));
    if (!response.ok) {
      throw new Error(await gatewayErrorMessage(response));
    }
    health = await response.json() as DaemonHealth;
    // Anything else answering 200 on a reused port is not this daemon.
    if (health?.ok !== true) {
      throw new Error('the answer was not a Stratus health response');
    }
  } catch (error) {
    problems.push(
      `A daemon published ${url} in ${infoPath} but did not answer /health `
      + `(${error instanceof Error ? error.message : String(error)}). If one is running, check \`stratus logs\`; `
      + 'if none is, the file is left over from one that did not stop cleanly.',
    );
    return { state: 'unreachable', url };
  }

  // A daemon from before `startup` existed reports none; nothing to compare.
  const startup = health.startup;
  const warnings = Array.isArray(startup?.warnings)
    ? startup.warnings.filter((line): line is string => typeof line === 'string')
    : [];
  for (const line of warnings) {
    problems.push(`The running daemon warned at start: ${line}. It runs on what it loaded until \`stratus restart\`.`);
  }
  const configs = startedConfigs(startup?.configs);
  const current = await Promise.all(configs.map(async (file) => (await configDigest(file.path)) ?? null));
  // The file each turn resolves its runtime from now: the first one there.
  // A file behind it (a global config behind a project one) feeds only the
  // daemon-level blocks, so a change to it never reaches a turn.
  const activeIndex = current.findIndex((digest) => digest !== null);
  // A turn that cannot load it keeps the daemon's last known-good config.
  const activeLoads = activeIndex >= 0
    ? await loadConfigFile(configs[activeIndex]!.path).then(() => true, () => false)
    : false;
  configs.forEach((file, index) => {
    const now = current[index];
    if (now === file.sha256) {
      return;
    }
    // Runtime settings are re-resolved on every turn, discovery included;
    // daemon-level ones only at start. Which of those a change touched is
    // not knowable from a digest, so the message says which part a restart
    // is for rather than guessing.
    const restart = 'Daemon-level settings (plugins, executor, memory store, Slack, approvals, principals, turn limits, control API) stay as they were until `stratus restart`.';
    const split = index !== activeIndex
      ? restart
      : activeLoads
        ? `Runtime settings (provider, model, system prompt and the rest of the runtime config) follow it from the next turn. ${restart}`
        : `It does not load, so turns keep the last config that did; fix it first. ${restart}`;
    if (file.sha256 === null) {
      problems.push(`${file.path} appeared after the daemon started. ${split}`);
    } else if (now === null) {
      problems.push(`${file.path}, which the running daemon read at start, is gone or unreadable. ${split}`);
    } else {
      problems.push(`${file.path} changed since the daemon started. ${split}`);
    }
  });
  const configPath = configs.find((file) => file.sha256 !== null)?.path;
  return {
    state: 'running',
    url,
    ...(typeof health.version === 'string' ? { version: health.version } : {}),
    ...(typeof health.startedAt === 'string' ? { startedAt: health.startedAt } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
  };
};

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

  // Readable by other users: the file holds whatever plugin config carries,
  // tool-shell's `env` tokens included, and the CLI writes it 0600 for that
  // reason (#204) — but only from the next write, so a file an older build
  // left at the umask's mode stays loose until something saves it. Only a
  // trusted config: a project-local one sits in a checkout at whatever mode
  // git gave it, and cannot set a plugin's config anyway. Every trusted one
  // that is there, not only the one in use: a global config a project file
  // shadows for this run still holds its secrets on disk. Asked of the
  // candidates themselves rather than of what discovery reached, since a
  // project file that cannot be read stops discovery before the global one.
  // The global one even when --config or STRATUS_CONFIG names another: the
  // selection decides what a run reads, not what sits on disk, so someone
  // who always runs doctor that way would otherwise never hear about it.
  // Once per file, so an explicit path that is the global one (or links to
  // it) is not reported twice. Windows has no mode bits to read.
  if (process.platform !== 'win32') {
    const audited = [
      ...candidates.filter((entry) => entry.label !== 'project'),
      ...(explicitSource ? [{ path: globalConfigPath(env), label: 'global' }] : []),
    ];
    const seen = new Set<string>();
    for (const candidate of audited) {
      let mode: number;
      try {
        const stats = await stat(candidate.path);
        // A directory where the file belongs is reported above as
        // unreadable; `chmod 600` on it would only take away its search bit.
        if (!stats.isFile()) {
          continue;
        }
        const identity = `${stats.dev}:${stats.ino}`;
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
        mode = stats.mode & 0o777;
      } catch {
        // Not there, or not something to stat: reported above if it matters.
        continue;
      }
      if ((mode & 0o077) !== 0) {
        problems.push(
          `${candidate.path} can be read by other users on this machine (mode ${mode.toString(8)}), and it holds `
          + "any secret in your plugin config, such as tool-shell's env block. "
          + `Run \`chmod 600 ${quoteShellArg(candidate.path)}\`; Stratus writes it that way from now on.`,
        );
      }
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
  // The file's soul under the resolver's trust rule: a project-local file
  // does not name one, so doctor must not attribute one to it.
  const soulValue = envSoul?.value ?? (winner?.label === 'project' ? undefined : fileConfig.soul);
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

  // A refused persona is a finding, not a silence: the file asks for a soul
  // or a preamble, no run started here will use it, and a doctor that said
  // "no soul configured" would be hiding the trust decision it exists to
  // explain. The resolver's own record is the verdict — it already leaves
  // out a key the environment outranked, which is not refused but beaten —
  // and only when no run could resolve at all is the same rule applied
  // here, so the finding still appears beside the failure that hid it.
  const refusedByTrust = resolved?.ignoredFromUntrustedConfig
    ?? ignoredUntrustedConfigKeys({}, fileConfig, winner ? { path: winner.path, trusted: winner.label !== 'project' } : undefined, env);
  if (refusedByTrust) {
    problems.push(
      `${refusedByTrust.path} sets ${refusedByTrust.keys.join(' and ')}, which an auto-discovered config does not get to choose — `
      + `every run started here ignores ${refusedByTrust.keys.length === 1 ? 'it' : 'them'}. `
      + ignoredConfigRemedy(refusedByTrust, false),
    );
  }

  const envProviderPick = envPick('STRATUS_PROVIDER');
  // Nothing named a provider: the resolver takes the only stored sign-in.
  // Worked out here too, so a run that picked it and then failed still
  // reports it rather than "none".
  const namedProvider = envProviderPick?.value ?? soul?.provider ?? fileConfig.provider;
  const soleSignIn = resolved?.inferredProvider
    ?? (!resolved && namedProvider === undefined
      ? await signedInProviders(env).then((names) => (names.length === 1 ? names[0] : undefined)).catch(() => undefined)
      : undefined);
  const providerSource = envProviderPick
    ? envProviderPick.name
    : soul?.provider
      ? `${soulPath} (soul frontmatter)`
      : fileConfig.provider
        ? (winner?.path ?? 'config')
        : soleSignIn !== undefined
          ? 'the only provider signed in — nothing set one'
          : 'nothing set a provider';
  // When resolution fails the intended provider is still worth reporting:
  // "why is it anthropic" is exactly the question, and the problems below
  // already say no run can start.
  const intendedProvider = namedProvider ?? soleSignIn ?? 'none';
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
    // The soul's pin in resolved form, so a soul saying `ollama` matches
    // the `plugin:ollama` the run resolved to.
    const soulModelApplies = soul?.provider === undefined || parseProviderName(soul.provider, 'soul file') === resolved.provider;
    const configModelApplies = (fileConfig.provider ?? 'openai') === resolved.provider;
    model = {
      value: resolved.model ?? 'the provider\'s own default',
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
  const usedKeyEnvVar = resolved && isSignedInRuntime(resolved) ? resolved.apiKeyEnvVar : undefined;
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

  // "Installed" is true of a Slack adapter releases behind the daemon
  // loading it, and that was the whole report — see companionsBehindMessage.
  const behind = (await readCompanions(CLI_VERSION, env)).filter((entry) => entry.stale);
  if (behind.length > 0) {
    problems.push(companionsBehindMessage(behind));
  }

  const missingHarnesses = await missingHarnessPackages(env, command.configPath);
  if (missingHarnesses.length > 0) {
    problems.push(harnessesMissingMessage(missingHarnesses));
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

  // Only listed principals get a turn unless an agent says `admit: "anyone"`,
  // so a connected agent with nobody listed ignores every Slack message.
  // Principals come from a trusted config only; a project config's are
  // ignored by the daemon, so they are ignored here too.
  const trustedPrincipals = winner?.label === 'project' ? undefined : fileConfig.principals;
  const unreachable = slackAgents.filter((id) => !orphans.includes(id)).filter((id) => {
    const resolved = resolveAgentPrincipals(trustedPrincipals, id);
    return resolved.admit === 'principals' && (resolved.slackUsers ?? []).length === 0;
  });
  if (unreachable.length > 0) {
    problems.push(
      `Nobody is listed who may talk to ${unreachable.join(', ')} in Slack, so ${unreachable.length === 1 ? 'it ignores' : 'they ignore'} every message. `
      + 'Add Slack member IDs to principals.slackUsers in ~/.stratus/config.json (or set principals.admit to "anyone"), then `stratus restart`.',
    );
  }

  // The same plan `serve` acts on: where the folder is (or why there is
  // none here), what the next start would move, and what is broken. A soul
  // or workspace link whose folder was deleted or renamed: the soul drops
  // out of the roster with a warning, and a missing workspace only comes
  // back empty on the next write, so say which. And a soul in the folder
  // nothing links to, which the roster never reads.
  let agentsFolder: DoctorReport['agentsFolder'];
  try {
    const plan = await planAgentsHome(env);
    agentsFolder = plan.agentsHome !== undefined
      ? { path: plan.agentsHome, claimed: plan.claimed, pending: plan.souls.length + plan.workspaces.length }
      : { reason: plan.reason ?? 'none available' };
    if (plan.dangling.length > 0) {
      problems.push(
        `These link into the agents folder, but what they point at is gone: ${plan.dangling.join(', ')}. `
        + 'Put the agent\'s folder back (or rename it back) to restore it; a missing workspace is recreated empty on the next write.',
      );
    }
    if (plan.unlinked.length > 0) {
      problems.push(
        `These souls are in the agents folder but no agent reads them: ${plan.unlinked.join(', ')}. `
        + 'Probably left by an `agent new` or `template add` that was stopped partway: run it again, or delete the folder if you don\'t want the agent.',
      );
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
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

  // Workspaces at the pre-schema-4 path. Their files are an agent's own
  // output and their ledger is what says which of them a model did not
  // write, so this is the state somebody stares at when a file has "gone
  // missing" — but only two of the three things that can be sitting there
  // are worth saying, and they need different sentences.
  //
  // Nothing is said about one the new path resolves to through a link: that
  // workspace is read on every call, and calling it unread would be false.
  const legacyName = path.basename(legacyWorkspacesDirPath(env));
  const survey = await surveyLegacyWorkspaces(env);
  const grouped = (state: LegacyWorkspaceState): string[] =>
    [...survey.entries].filter(([, value]) => value === state).map(([name]) => name).sort();
  const repairable = grouped('repairable');
  if (repairable.length > 0) {
    problems.push(
      `${repairable.join(', ')} still ${repairable.length === 1 ? 'has a workspace' : 'have workspaces'} at the `
      + `old ${legacyName}/ path, which this build does not read — most likely left by a command of an older `
      + 'build running during the upgrade. Start the daemon (`stratus serve`, or `stratus service start`) or run '
      + "`stratus update`, and the provenance labels are folded into the agent's live ledger. The files move too "
      + "unless the agent's own workspace already holds files of its own, in which case they stay where they are "
      + 'rather than overwriting newer ones, and the start says so.',
    );
  }
  // Said separately, and without a remedy that would not work: nothing a
  // restart does will move these. Reporting them with the advice above is
  // what would make this check red for good on an ordinary home.
  const retained = grouped('retained');
  if (retained.length > 0) {
    problems.push(
      `${legacyName}/ still holds ${retained.join(', ')}, left there on purpose — either the provenance records `
      + "were already folded into the agent's ledger and the files kept rather than overwriting newer ones, or "
      + 'the name is not an agent\'s. Nothing further will move them: read them where they are, and move or '
      + 'delete them yourself once you are done with them.',
    );
  }

  const daemon = await inspectDaemon(env, problems);
  const keyChecks = command.live && resolved ? await checkKeys(resolved, env, problems) : undefined;

  return {
    ...(winner ? { configInUse: winner.path } : {}),
    configShadowed: shadowed.map((entry) => entry.path),
    provider,
    ...(model ? { model } : {}),
    ...(soulPath ? { soul: { value: soulPath, source: soulSource } } : {}),
    ...(soul ? { agent: `${soul.agent.name} (${soul.agent.id})` } : {}),
    ...(fallback ? { fallback: { provider: fallback.provider, model: fallback.model } } : {}),
    signIns,
    ...(keyChecks ? { keyChecks } : {}),
    slackAgents,
    slackPackageInstalled,
    rosterCount,
    ...(agentsFolder !== undefined ? { agentsFolder } : {}),
    daemon,
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
  const folder = report.agentsFolder;
  writeLine(streams.stdout, `            ${folder === undefined
    ? 'agents folder unknown'
    : 'reason' in folder
      ? `no visible agents folder (${folder.reason}), so souls and workspaces stay in ~/.stratus/agents`
      : folder.claimed
        ? `in ${folder.path}${folder.pending > 0 ? ` (${folder.pending} more to move there on the next start)` : ''}`
        : `${folder.path} is created on the next start${folder.pending > 0 ? `, and ${folder.pending} soul(s) or workspace(s) move there` : ''}`}`);

  if (report.fallback) {
    writeLine(streams.stdout, `  ${'fallback'.padEnd(10)}${report.fallback.provider} · ${report.fallback.model}`);
    writeLine(streams.stdout, `  ${''.padEnd(10)}used when the default model errors mid-run`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Sign-ins');
  for (const entry of report.signIns) {
    writeLine(streams.stdout, `  ${entry.provider.padEnd(10)}${entry.status}`);
  }

  if (report.keyChecks) {
    writeLine(streams.stdout);
    writeLine(streams.stdout, 'Live check');
    if (report.keyChecks.length === 0) {
      writeLine(streams.stdout, '  no provider sign-in to check');
    }
    for (const check of report.keyChecks) {
      const what = check.status === 'accepted'
        ? 'key accepted'
        : check.status === 'rejected'
          ? `key refused (${check.detail ?? 'auth failed'})`
          : check.status === 'unreachable'
            ? `no answer (${check.detail ?? 'unreachable'}); the key was not judged`
            : `not checked: ${check.detail ?? ''}`;
      const model = check.model === undefined
        ? ''
        : check.model.status === 'answered'
          ? ` · ${check.model.id} answered`
          : check.model.status === 'refused'
            ? ` · ${check.model.id} refused (${check.model.detail ?? 'refused'})`
            : check.model.status === 'no answer'
              ? ` · ${check.model.id} did not answer (${check.model.detail ?? 'unreachable'}); the model was not judged`
              : ` · ${check.model.id} not checked: ${check.model.detail ?? ''}`;
      writeLine(streams.stdout, `  ${check.provider.padEnd(10)}${what}${model}${check.role === 'fallback' ? ' (fallback)' : ''}`);
    }
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Channels');
  writeLine(streams.stdout, `  slack     ${report.slackAgents.length === 0
    ? 'no agents connected'
    : `${report.slackAgents.length} connected (${report.slackAgents.join(', ')})`}`);
  writeLine(streams.stdout, `            @stratusagent/channel-slack ${report.slackPackageInstalled ? 'installed' : 'not installed'}`);

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Daemon');
  const daemon = report.daemon;
  if (daemon.state === 'no-api') {
    // No published control API: none running, or one started with the API
    // off. Doctor cannot tell those apart from here, so it does not guess.
    writeLine(streams.stdout, `  ${'daemon'.padEnd(10)}none found (no control API published)`);
  } else if (daemon.state === 'unreachable') {
    writeLine(streams.stdout, `  ${'daemon'.padEnd(10)}did not answer at ${daemon.url}`);
  } else {
    const facts = [
      ...(daemon.version !== undefined ? [daemon.version] : []),
      ...(daemon.startedAt !== undefined ? [`started ${daemon.startedAt}`] : []),
    ];
    writeLine(streams.stdout, `  ${'daemon'.padEnd(10)}running${facts.length > 0 ? ` ${facts.join(', ')}` : ''}`);
    if (daemon.configPath !== undefined) {
      writeLine(streams.stdout, `  ${''.padEnd(10)}loaded ${daemon.configPath}`);
    }
  }

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
