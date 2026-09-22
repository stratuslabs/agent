import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILTIN_EXECUTOR_NAME,
  BUILTIN_MEMORY_STORE_NAME,
  type JsonObject,
} from '@stratusagent/core';
import {
  type AgentApprovalConfig,
  MAX_APPROVAL_TIMEOUT_MS,
  type ApprovalsConfig,
  type AgentPrincipalsConfig,
  type PrincipalsConfig,
  type ApiConfig,
  type PluginConfigBlock,
  type PluginsConfig,
  type StratusConfigFile,
} from './config.ts';
import { REGISTERED_PROVIDER_NAME_PATTERN, parseProviderName } from './provider-names.ts';

/**
 * A config file that exists but cannot be read, parsed, or validated —
 * distinguishable from credential and provider errors so long-running
 * callers can degrade (resolve without the file) instead of failing every
 * dispatch while an operator mid-edit has the file in a broken state.
 */
export class ConfigFileError extends Error {
  readonly configPath: string;
  /** The underlying fs error code (e.g. ENOENT, EACCES), when there is one. */
  readonly code: string | undefined;

  constructor(configPath: string, cause: unknown) {
    super(`Could not use config ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ConfigFileError';
    this.configPath = configPath;
    this.cause = cause;
    // Callers distinguishing a missing config from a broken one keep
    // working on `error.code` exactly as with the raw fs error.
    this.code = typeof (cause as NodeJS.ErrnoException)?.code === 'string'
      ? (cause as NodeJS.ErrnoException).code
      : undefined;
  }
}

export const loadConfigFile = async (configPath: string): Promise<StratusConfigFile> => {
  try {
    return await loadConfigFileInner(configPath);
  } catch (error) {
    throw error instanceof ConfigFileError ? error : new ConfigFileError(configPath, error);
  }
};

const loadConfigFileInner = async (configPath: string): Promise<StratusConfigFile> => {
  const raw = await readFile(configPath, 'utf8');
  return validateConfigFile(JSON.parse(raw) as unknown, configPath);
};

/**
 * Validate and normalize a config document, without reading a file.
 *
 * Exported because anything that *writes* a config has to answer the same
 * question the loader answers, and answering it any other way means writing
 * a file the loader will later reject — a save that reports success and then
 * breaks the next read. The nested `approvals` and `api` blocks are the ones
 * this matters for: their own parsers are the only thing that knows an
 * `enabled` of `"false"` is not a boolean.
 */
export const validateConfigFile = (parsed: unknown, label: string): StratusConfigFile => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${label}`);
  }

  const configPath = label;
  const config = parsed as Record<string, unknown>;
  const resolved: StratusConfigFile = {};

  if (typeof config.provider === 'string') {
    resolved.provider = parseProviderName(config.provider, `config ${configPath}`);
  }
  if (typeof config.model === 'string' && config.model.length > 0) {
    resolved.model = config.model;
  }
  if (typeof config.baseUrl === 'string' && config.baseUrl.length > 0) {
    resolved.baseUrl = config.baseUrl;
  }
  if (typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0) {
    resolved.apiKeyEnv = config.apiKeyEnv;
  }
  if (typeof config.systemPrompt === 'string' && config.systemPrompt.length > 0) {
    resolved.systemPrompt = config.systemPrompt;
  }
  if (typeof config.soul === 'string' && config.soul.length > 0) {
    resolved.soul = config.soul;
  }
  if (typeof config.fallbackModel === 'string' && config.fallbackModel.length > 0) {
    resolved.fallbackModel = config.fallbackModel;
  }
  if (typeof config.fallbackProvider === 'string') {
    resolved.fallbackProvider = parseProviderName(config.fallbackProvider, `config ${configPath}`);
  }
  if (typeof config.fallbackBaseUrl === 'string' && config.fallbackBaseUrl.length > 0) {
    resolved.fallbackBaseUrl = config.fallbackBaseUrl;
  }
  for (const key of ['executor', 'memoryStore'] as const) {
    const value = config[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || !REGISTERED_PROVIDER_NAME_PATTERN.test(value)) {
      throw new Error(
        `Invalid ${key} in config ${configPath}: ${JSON.stringify(value)}. Name the built-in (${key === 'executor' ? BUILTIN_EXECUTOR_NAME : BUILTIN_MEMORY_STORE_NAME}) or one a plugin registers (lowercase, hyphens).`,
      );
    }
    resolved[key] = value;
  }
  // Checked against `false` rather than truthiness: this key's whole purpose
  // is turning a default-on behavior off.
  if (typeof config.promptCache === 'boolean') {
    resolved.promptCache = config.promptCache;
  }
  if (config.promptCacheTtl === '5m' || config.promptCacheTtl === '1h') {
    resolved.promptCacheTtl = config.promptCacheTtl;
  }
  // `false` is the whole point of this key too.
  if (typeof config.vision === 'boolean') {
    resolved.vision = config.vision;
  }
  if (config.maxTurns !== undefined) {
    // Refused rather than clamped, like `approvals.timeoutMs`: every value
    // this rejects breaks the daemon in a way nothing downstream reports.
    // The ceiling is tested as `turn > maxTurns` before the provider call,
    // so 0 or a negative fails turn 1 of every dispatch — an install where
    // no agent can answer anything, with "exceeded the maximum of 0
    // provider turns" as the only clue.
    if (
      typeof config.maxTurns !== 'number'
      || !Number.isInteger(config.maxTurns)
      || config.maxTurns < 1
    ) {
      throw new Error(
        `Invalid maxTurns in config ${configPath}: ${JSON.stringify(config.maxTurns)}. `
        + 'Use a whole number of provider turns, 1 or more.',
      );
    }
    resolved.maxTurns = config.maxTurns;
  }
  const approvals = parseApprovalsConfig(config.approvals, configPath);
  if (approvals) {
    resolved.approvals = approvals;
  }
  const principals = parsePrincipalsConfig(config.principals, configPath);
  if (principals) {
    resolved.principals = principals;
  }
  const api = parseApiConfig(config.api, configPath);
  if (api) {
    resolved.api = api;
  }
  const plugins = parsePluginsConfig(config.plugins, configPath);
  if (plugins) {
    resolved.plugins = plugins;
  }

  return resolved;
};

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Shape-check the `plugins` block, and no more than that.
 *
 * What a plugin's own keys mean is the manifest's business, and this loader
 * has not read one — it cannot, without importing the package, which is the
 * thing the manifest exists to avoid. So the line drawn here is exactly the
 * host's half: a package name maps to an object, `enabled` is a boolean,
 * and `agents` maps agent ids to objects. A wrong `roots` is caught at load
 * time by the plugin host, with the manifest in hand and the plugin's name
 * in the message.
 *
 * Refused rather than dropped, unlike most of this file: a plugin block
 * silently ignored for being misshapen is a capability an operator believes
 * they granted and an agent does not have, discovered as a tool that is
 * mysteriously absent mid-turn.
 */
const parsePluginsConfig = (raw: unknown, configPath: string): PluginsConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid plugins in config ${configPath}: expected an object keyed by package name.`);
  }

  const plugins: PluginsConfig = {};
  for (const [packageName, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) {
      throw new Error(
        `Invalid plugins["${packageName}"] in config ${configPath}: expected an object of settings.`,
      );
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(
        `Invalid plugins["${packageName}"].enabled in config ${configPath}: ${String(entry.enabled)}. Use true or false.`,
      );
    }
    if (entry.agents !== undefined) {
      if (!isPlainObject(entry.agents)) {
        throw new Error(
          `Invalid plugins["${packageName}"].agents in config ${configPath}: expected an object keyed by agent id.`,
        );
      }
      for (const [agentId, agentEntry] of Object.entries(entry.agents)) {
        if (!isPlainObject(agentEntry)) {
          throw new Error(
            `Invalid plugins["${packageName}"].agents.${agentId} in config ${configPath}: expected an object of settings.`,
          );
        }
      }
    }
    plugins[packageName] = entry as PluginConfigBlock;
  }
  return plugins;
};

const parseApiConfig = (raw: unknown, configPath: string): ApiConfig | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const api: ApiConfig = {};

  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') {
      throw new Error(`Invalid api.enabled in config ${configPath}: ${String(source.enabled)}. Use true or false.`);
    }
    api.enabled = source.enabled;
  }
  if (source.host !== undefined) {
    if (typeof source.host !== 'string' || source.host.trim().length === 0) {
      throw new Error(`Invalid api.host in config ${configPath}: ${String(source.host)}. Use a hostname or address.`);
    }
    api.host = source.host.trim();
  }
  if (source.port !== undefined) {
    // Refused rather than coerced: a port that is not a port would fail at
    // bind time, deep inside a daemon start, with an error naming a value
    // nobody wrote.
    if (
      typeof source.port !== 'number'
      || !Number.isInteger(source.port)
      || source.port < 0
      || source.port > 65_535
    ) {
      throw new Error(
        `Invalid api.port in config ${configPath}: ${String(source.port)}. Use a whole number between 0 and 65535.`,
      );
    }
    api.port = source.port;
  }
  return api;
};

const parseApprovalRoute = (raw: unknown): AgentApprovalConfig | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const route: AgentApprovalConfig = {};
  if (Array.isArray(source.slackApprovers)) {
    // Kept even when it filters down to nothing. An agent entry saying
    // `"slackApprovers": []` is an operator excluding that agent from a
    // global approver list, and dropping it would fall back to exactly the
    // list they were excluding — turning a deliberate "nobody may approve
    // for Ava" into "everyone on the default list may". The empty array
    // survives; the fallback is for a key that was never written.
    route.slackApprovers = source.slackApprovers.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
  }
  if (typeof source.slackChannel === 'string' && source.slackChannel.length > 0) {
    route.slackChannel = source.slackChannel;
  }
  return route;
};

const parseApprovalsConfig = (raw: unknown, configPath: string): ApprovalsConfig | undefined => {
  const route = parseApprovalRoute(raw);
  if (!route) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const approvals: ApprovalsConfig = { ...route };

  if (source.mode !== undefined) {
    // A misspelled mode fails loudly rather than falling back to headless:
    // someone who wrote `remote` and got `headless` would discover it as an
    // agent that mysteriously refuses everything, with the config in front
    // of them saying otherwise.
    if (source.mode !== 'headless' && source.mode !== 'remote') {
      throw new Error(
        `Unsupported approvals.mode in config ${configPath}: ${String(source.mode)}. Use headless or remote.`,
      );
    }
    approvals.mode = source.mode;
  }
  if (source.timeoutMs !== undefined) {
    if (typeof source.timeoutMs !== 'number' || !Number.isFinite(source.timeoutMs) || source.timeoutMs < 0) {
      throw new Error(
        `Invalid approvals.timeoutMs in config ${configPath}: ${String(source.timeoutMs)}. Use a non-negative number of milliseconds.`,
      );
    }
    // Refused rather than clamped: a value past Node's timer range does not
    // become a long wait, it becomes a 1ms one — so a config asking for a
    // 30-day window would expire every approval almost immediately, which
    // is the exact opposite of what it asked for and impossible to diagnose
    // from the outside. Someone who wrote a number this large has to be
    // told, not quietly given a different one.
    if (source.timeoutMs > MAX_APPROVAL_TIMEOUT_MS) {
      throw new Error(
        `Invalid approvals.timeoutMs in config ${configPath}: ${source.timeoutMs} is longer than the maximum `
        + `${MAX_APPROVAL_TIMEOUT_MS}ms (~24.8 days). A larger value would expire every approval immediately.`,
      );
    }
    approvals.timeoutMs = source.timeoutMs;
  }
  if (typeof source.agents === 'object' && source.agents !== null && !Array.isArray(source.agents)) {
    const agents: Record<string, AgentApprovalConfig> = {};
    for (const [agentId, entry] of Object.entries(source.agents as Record<string, unknown>)) {
      const parsed = parseApprovalRoute(entry);
      if (parsed) {
        agents[agentId] = parsed;
      }
    }
    if (Object.keys(agents).length > 0) {
      approvals.agents = agents;
    }
  }

  return approvals;
};

/**
 * What one agent's approval route resolves to: its own entry where it has
 * one, the top-level defaults otherwise. Per-key, not per-block — an agent
 * that only names its own approvers still asks in the default conversation.
 *
 * Exported so nothing re-derives it. A second copy of this precedence is
 * the difference between "these three people can approve" and "everyone
 * can", and it would drift the first time the shape grows a key.
 */
export const resolveAgentApprovals = (
  approvals: ApprovalsConfig | undefined,
  agentId: string,
): AgentApprovalConfig => {
  const agent = approvals?.agents?.[agentId];
  const slackApprovers = agent?.slackApprovers ?? approvals?.slackApprovers;
  const slackChannel = agent?.slackChannel ?? approvals?.slackChannel;
  return {
    ...(slackApprovers ? { slackApprovers } : {}),
    ...(slackChannel ? { slackChannel } : {}),
  };
};

const parsePrincipalsEntry = (raw: unknown, configPath: string, where: string): AgentPrincipalsConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  // A block or override in the wrong shape is refused, never dropped: under
  // admit: "principals" this block is an authorization boundary, and a
  // dropped override inherits the shared answer — or, for the block itself,
  // the default `anyone` — which is the door opened by a typo.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid ${where} in config ${configPath}: expected an object, received ${JSON.stringify(raw)}.`);
  }
  const source = raw as Record<string, unknown>;
  const entry: AgentPrincipalsConfig = {};
  if (source.slackUsers !== undefined) {
    // A list in the wrong shape is refused rather than dropped: under
    // admit: "principals" this list is the door, and a per-agent override
    // that was silently dropped would fall back to the shared list — the
    // broader one it existed to narrow. An entry that is not an id is
    // dropped from the list, which only ever narrows it; an empty array
    // survives, as `slackApprovers: []` does, because it is how an agent
    // is excluded from a shared list.
    if (!Array.isArray(source.slackUsers)) {
      throw new Error(
        `Invalid ${where}.slackUsers in config ${configPath}: expected a list of Slack user ids, received ${JSON.stringify(source.slackUsers)}.`,
      );
    }
    entry.slackUsers = source.slackUsers.filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
  }
  if (source.admit !== undefined) {
    // Refused rather than defaulted: a misspelt `admit` that quietly meant
    // `anyone` would be the one setting here whose failure opens the door.
    if (source.admit !== 'anyone' && source.admit !== 'principals') {
      throw new Error(
        `Invalid ${where}.admit in config ${configPath}: expected "anyone" or "principals", received ${JSON.stringify(source.admit)}.`,
      );
    }
    entry.admit = source.admit;
  }
  return entry;
};

const parsePrincipalsConfig = (raw: unknown, configPath: string): PrincipalsConfig | undefined => {
  const shared = parsePrincipalsEntry(raw, configPath, 'principals');
  if (!shared) {
    return undefined;
  }
  const principals: PrincipalsConfig = { ...shared };
  const source = raw as Record<string, unknown>;
  if (source.agents !== undefined && (typeof source.agents !== 'object' || source.agents === null || Array.isArray(source.agents))) {
    throw new Error(
      `Invalid principals.agents in config ${configPath}: expected an object keyed by agent id, received ${JSON.stringify(source.agents)}.`,
    );
  }
  if (typeof source.agents === 'object' && source.agents !== null && !Array.isArray(source.agents)) {
    const agents: Record<string, AgentPrincipalsConfig> = {};
    for (const [agentId, entry] of Object.entries(source.agents as Record<string, unknown>)) {
      const parsed = parsePrincipalsEntry(entry, configPath, `principals.agents.${agentId}`);
      if (parsed) {
        agents[agentId] = parsed;
      }
    }
    if (Object.keys(agents).length > 0) {
      principals.agents = agents;
    }
  }
  return principals;
};

/**
 * Who one agent's operators are: its own entry where it has one, the
 * top-level list otherwise — the same per-key precedence as
 * `resolveAgentApprovals`, exported for the same reason. Nobody at all is
 * a real answer, and the default: every sender is then `unknown`.
 */
export const resolveAgentPrincipals = (
  principals: PrincipalsConfig | undefined,
  agentId: string,
): AgentPrincipalsConfig => {
  const agent = principals?.agents?.[agentId];
  const slackUsers = agent?.slackUsers ?? principals?.slackUsers;
  const admit = agent?.admit ?? principals?.admit;
  return { ...(slackUsers ? { slackUsers } : {}), ...(admit ? { admit } : {}) };
};

// ---------------------------------------------------------------------------
// Writing the config file
// ---------------------------------------------------------------------------

/**
 * Persist settings, creating the directory if it is not there yet.
 *
 * Deliberately NOT 0600: `config.json` holds no secrets (those live in
 * `credentials.json`, which has its own posture), and tightening it here
 * would be a security theatre that also breaks a shared-machine setup where
 * the daemon runs as another user.
 */
export const saveConfigFile = async (
  configPath: string,
  config: StratusConfigFile,
): Promise<void> => {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
};
