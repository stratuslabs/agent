import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentMemoryStore,
  JsonObject,
  JsonValue,
  MemoryEntry,
  ModelProvider,
} from '@stratusagent/core';
import { parseSoul, type ParsedSoul } from '@stratusagent/agents';
import { defineLocalCommandTool } from '@stratusagent/executor-local';
import {
  createOpenAICompatibleProvider,
  createProviderResponseBuilder,
  defineProvider,
} from '@stratusagent/providers';
import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
} from '@stratusagent/provider-anthropic';
import {
  createClaudeCodeProvider,
  hasHostedToolSideEffects,
  type ClaudeCodeToolExecutor,
} from '@stratusagent/provider-claude-code';

/**
 * Where Stratus state lives and how the process environment is read. Every
 * function in this package takes one of these instead of touching process
 * globals directly, so the CLI, the gateway, and tests can each pin their
 * own home directory and environment.
 */
export interface StateEnvironment {
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Home directory override (tests). Defaults to os.homedir(). */
  homeDir?: string;
  fetch?: typeof fetch;
}

export type StratusProviderName = 'demo' | 'openai' | 'anthropic';

export interface StratusConfigFile {
  provider?: StratusProviderName;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  /** Path to a soul file, resolved relative to the working directory. */
  soul?: string;
  /** Model to retry with when the default model errors mid-run. */
  fallbackModel?: string;
  /** Provider serving the fallback model. Defaults to the main provider. */
  fallbackProvider?: StratusProviderName;
  /** Base URL for an openai-compatible fallback (e.g. a local model). */
  fallbackBaseUrl?: string;
}

/** A resolved, ready-to-run fallback model (always a real provider). */
export interface FallbackRuntime {
  provider: 'anthropic' | 'openai';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
}

export type RuntimeConfig =
  | { provider: 'demo'; soul?: ParsedSoul }
  | {
      provider: 'openai';
      model: string;
      baseUrl: string;
      apiKey: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
      soul?: ParsedSoul;
      fallback?: FallbackRuntime;
    }
  | {
      provider: 'anthropic';
      model: string;
      baseUrl?: string;
      apiKey?: string;
      /** Claude subscription auth (Claude Code setup token). */
      authToken?: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
      soul?: ParsedSoul;
      fallback?: FallbackRuntime;
    };

/** A stored sign-in for a provider, kept in ~/.stratus/credentials.json. */
export interface StoredCredential {
  type: 'api_key' | 'oauth_token';
  value: string;
  /**
   * The endpoint this credential belongs to (openai-compatible services).
   * Kept with the credential so a key for a local model or proxy is never
   * sent to a different service, whatever the current default provider is.
   */
  baseUrl?: string;
}

export type CredentialProviderName = 'anthropic' | 'openai';
export type CredentialsFile = Partial<Record<CredentialProviderName, StoredCredential>>;

/**
 * The provider/model/config selection for one run — the subset of a CLI
 * command (or a gateway dispatch) that config resolution cares about.
 */
export interface RuntimeSelection {
  provider?: StratusProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to run as. */
  soul?: string;
}

// The agent every run uses when no soul is configured. A Stratus agent is
// a Stratus agent — never "the model" — whichever provider serves it.
export const DEFAULT_STRATUS_AGENT = {
  id: 'stratus',
  name: 'Stratus',
  instructions: 'You are Stratus, a personal agent on the Stratus Agent platform. Be warm, direct, and concise. When asked who or what you are, you are Stratus — a Stratus agent — regardless of which model is serving the conversation.',
};

// Unsouled runs used to remember facts under a per-provider default agent.
// Stratus inherits all of them: reads for the built-in agent also return
// entries stored under the legacy ids, while new facts land under 'stratus'.
const LEGACY_DEFAULT_AGENT_IDS = ['demo-agent', 'anthropic-agent', 'openai-agent'];

export const withLegacyDefaultMemories = (store: AgentMemoryStore): AgentMemoryStore => ({
  append: (agentId, content, metadata) => store.append(agentId, content, metadata),
  async list(agentId) {
    if (agentId !== DEFAULT_STRATUS_AGENT.id) {
      return store.list(agentId);
    }
    const batches = await Promise.all(
      [DEFAULT_STRATUS_AGENT.id, ...LEGACY_DEFAULT_AGENT_IDS].map((id) => store.list(id)),
    );
    return batches.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

export const DEFAULT_CONFIG_FILENAME = 'stratus.config.json';
export const LEGACY_CONFIG_FILENAME = 'stratusclaw.config.json';
const STRATUS_HOME_DIRNAME = '.stratus';
const GLOBAL_CONFIG_FILENAME = 'config.json';
const CREDENTIALS_FILENAME = 'credentials.json';
const AGENTS_DIRNAME = 'agents';
const MEMORY_FILENAME = 'memory.jsonl';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

export const readProcessEnv = (env: StateEnvironment): NodeJS.ProcessEnv => env.processEnv ?? process.env;
export const readWorkingDirectory = (env: StateEnvironment): string => env.cwd ?? process.cwd();
export const readHomeDirectory = (env: StateEnvironment): string => env.homeDir ?? os.homedir();

export const stratusHomePath = (env: StateEnvironment): string =>
  path.join(readHomeDirectory(env), STRATUS_HOME_DIRNAME);
export const globalConfigPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), GLOBAL_CONFIG_FILENAME);
export const credentialsPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), CREDENTIALS_FILENAME);
export const agentsDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), AGENTS_DIRNAME);
export const memoryFilePath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), MEMORY_FILENAME);

export const loadCredentials = async (env: StateEnvironment): Promise<CredentialsFile> => {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credentials file must contain a JSON object: ${credentialsPath(env)}`);
  }

  const credentials: CredentialsFile = {};
  for (const provider of ['anthropic', 'openai'] as const) {
    const entry = (parsed as Record<string, unknown>)[provider];
    if (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
      ((entry as StoredCredential).type === 'api_key' || (entry as StoredCredential).type === 'oauth_token') &&
      typeof (entry as StoredCredential).value === 'string'
    ) {
      credentials[provider] = entry as StoredCredential;
    }
  }
  return credentials;
};

// Credentials never live in a project directory or a shell profile — they
// are written once by `stratus setup` and read on every run, 0600 so only
// the owner can read them.
export const saveCredentials = async (env: StateEnvironment, credentials: CredentialsFile): Promise<void> => {
  const filePath = credentialsPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
};

// Memory used to live under the working directory. Fold any such file into
// the global store the first time a run happens from that directory, then
// archive it — an upgrade must never look like the agent forgot.
//
// Every import first takes exclusive ownership by atomically renaming its
// source to a unique claim file: of any competing processes, exactly one
// wins the rename and the rest see ENOENT. A crash mid-import leaves the
// claim file behind; later runs re-claim it the same way and finish the
// job, with entries deduped against the global store by id. Only records
// that parse as real memory entries are imported — malformed lines stay in
// the archive instead of poisoning the global store for every agent.
const isMemoryEntryLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as Partial<MemoryEntry> | null;
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.id === 'string'
      && typeof parsed.agentId === 'string'
      && typeof parsed.content === 'string';
  } catch {
    return false;
  }
};

export const migrateLegacyMemory = async (env: StateEnvironment): Promise<void> => {
  const legacyPath = path.join(readWorkingDirectory(env), '.stratus', MEMORY_FILENAME);
  const globalPath = memoryFilePath(env);
  if (legacyPath === globalPath) {
    return;
  }
  const legacyDir = path.dirname(legacyPath);
  const archivePath = `${legacyPath}.migrated`;

  const claimAndImport = async (sourcePath: string): Promise<void> => {
    const claimPath = path.join(legacyDir, `${MEMORY_FILENAME}.migrating-${randomUUID()}`);
    try {
      await rename(sourcePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // another process owns it, or there is nothing to migrate
      }
      throw error;
    }

    const claimed = await readFile(claimPath, 'utf8');

    let existingIds: Set<string>;
    try {
      existingIds = new Set(
        (await readFile(globalPath, 'utf8'))
          .split('\n')
          .filter(isMemoryEntryLine)
          .map((line) => (JSON.parse(line) as MemoryEntry).id),
      );
    } catch {
      existingIds = new Set();
    }

    const entries = claimed
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter(isMemoryEntryLine)
      .filter((line) => !existingIds.has((JSON.parse(line) as MemoryEntry).id));
    if (entries.length > 0) {
      await mkdir(path.dirname(globalPath), { recursive: true });
      await appendFile(globalPath, `${entries.join('\n')}\n`);
    }

    // Archive by appending (never overwriting an earlier archive), then
    // drop the claim — its content is fully preserved in the archive.
    if (claimed.length > 0) {
      await appendFile(archivePath, claimed.endsWith('\n') || claimed.length === 0 ? claimed : `${claimed}\n`);
    }
    await unlink(claimPath);
  };

  await claimAndImport(legacyPath);

  // Finish any claims a crashed run left behind (both the current unique
  // names and the fixed .migrating name from earlier versions).
  let leftovers: string[];
  try {
    leftovers = await readdir(legacyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const name of leftovers) {
    if (name.startsWith(`${MEMORY_FILENAME}.migrating`)) {
      await claimAndImport(path.join(legacyDir, name));
    }
  }
};

// Agents keep the same memory across runs: every remembered fact lands in
// ~/.stratus/memory.jsonl (keyed by agent id), so the Ava you talk to
// tomorrow — from any directory or process — is the Ava you talked to
// today. One JSON entry per line, written with O_APPEND: concurrent runs
// each add their own line instead of re-writing the file, so no run can
// clobber another's remembered fact.
export const createFileMemoryStore = (filePath: string): AgentMemoryStore => {
  const readEntries = async (): Promise<MemoryEntry[]> => {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEntry;
        } catch {
          throw new Error(`Memory file has an invalid line: ${filePath}`);
        }
      });
  };

  return {
    async append(agentId: string, content: string, metadata?: JsonObject) {
      const entry: MemoryEntry = {
        id: `${agentId}:memory:${randomUUID()}`,
        agentId,
        content,
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      };
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`);
      return entry;
    },
    async list(agentId: string) {
      // Dedupe by id at read time: even if a rare race double-imported a
      // fact, the agent only ever sees it once.
      const seen = new Set<string>();
      return (await readEntries()).filter((entry) => {
        if (entry.agentId !== agentId || seen.has(entry.id)) {
          return false;
        }
        seen.add(entry.id);
        return true;
      });
    },
  };
};

export const parseProviderName = (value: string, label: string): StratusProviderName => {
  if (value === 'demo' || value === 'openai' || value === 'anthropic') {
    return value;
  }

  throw new Error(`Unsupported provider in ${label}: ${value}`);
};

export const readNonEmptyString = <T = string>(
  value: string | undefined,
  map?: (resolved: string) => T,
): T | string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return map ? map(trimmed) : trimmed;
};

export const loadConfigFile = async (configPath: string): Promise<StratusConfigFile> => {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${configPath}`);
  }

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

  return resolved;
};

export interface ResolvedConfigLocation {
  path: string;
  /**
   * Whether the config came from something the user chose themselves
   * (--config, STRATUS_CONFIG, or the global ~/.stratus/config.json written
   * by setup). Auto-discovered project-local files are untrusted: a cloned
   * repository can ship one, so stored credentials are never combined with
   * a custom endpoint it selects.
   */
  trusted: boolean;
}

export const resolveConfigLocation = async (
  selection: Pick<RuntimeSelection, 'configPath'>,
  env: StateEnvironment,
): Promise<ResolvedConfigLocation | undefined> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const explicit = selection.configPath ?? processEnv.STRATUS_CONFIG ?? processEnv.STRATUSCLAW_CONFIG;

  if (explicit) {
    return { path: path.resolve(cwd, explicit), trusted: true };
  }

  // Project-local configs win; the global ~/.stratus/config.json written by
  // `stratus setup` is the fallback that makes the CLI work from anywhere.
  const candidates: ResolvedConfigLocation[] = [
    { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), trusted: false },
    { path: path.join(cwd, LEGACY_CONFIG_FILENAME), trusted: false },
    { path: globalConfigPath(env), trusted: true },
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate.path, 'utf8');
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return undefined;
};

// Tolerant config discovery for callers that only need the config as a
// hint (listing, agent creation): a config that exists but cannot be read
// or parsed degrades to a warning instead of blocking the command.
export const discoverActiveConfig = async (
  env: StateEnvironment,
  warn: (message: string) => void,
): Promise<{ location?: ResolvedConfigLocation; config: StratusConfigFile }> => {
  let location: ResolvedConfigLocation | undefined;
  try {
    location = await resolveConfigLocation({}, env);
  } catch (error) {
    warn(`ignoring unreadable config (${error instanceof Error ? error.message : String(error)})`);
    return { config: {} };
  }
  if (!location) {
    return { config: {} };
  }
  try {
    return { location, config: await loadConfigFile(location.path) };
  } catch (error) {
    warn(`ignoring unreadable config ${location.path} (${error instanceof Error ? error.message : String(error)})`);
    return { location, config: {} };
  }
};

// A soul travels with the run: an explicit soul path outranks STRATUS_SOUL,
// which outranks the config file's "soul" key.
export const resolveSoul = async (
  selection: RuntimeSelection,
  env: StateEnvironment,
  fileConfig: StratusConfigFile,
): Promise<ParsedSoul | undefined> => {
  const processEnv = readProcessEnv(env);
  const soulPath = selection.soul
    ?? readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_SOUL)
    ?? fileConfig.soul;

  if (!soulPath) {
    return undefined;
  }

  const resolvedPath = path.resolve(readWorkingDirectory(env), String(soulPath));
  return loadSoulFile(resolvedPath);
};

/** Reads and parses one soul file, with identity seeded by its path. */
export const loadSoulFile = async (resolvedPath: string): Promise<ParsedSoul> => {
  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Soul file not found: ${resolvedPath}`);
    }
    throw error;
  }

  try {
    // Seeding with the resolved path keeps an unnamed soul's generated
    // identity (name, id, avatar) stable across runs — persisted memory is
    // keyed by that id, so it must not change between invocations.
    return parseSoul(raw, { seed: resolvedPath });
  } catch (error) {
    throw new Error(
      `Could not parse soul file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface RosterEntry {
  soul: ParsedSoul;
  /** Absolute path of the soul file this entry came from. */
  path: string;
}

/**
 * Loads the soul roster from ~/.stratus/agents. Unreadable files degrade
 * to a warning: one broken soul must never take the rest of the team down.
 */
export const loadRosterSouls = async (
  env: StateEnvironment,
  warn: (message: string) => void = () => {},
): Promise<RosterEntry[]> => {
  let rosterFiles: string[] = [];
  try {
    rosterFiles = (await readdir(agentsDirPath(env)))
      .filter((file) => file.endsWith('.md'))
      .sort()
      .map((file) => path.join(agentsDirPath(env), file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const entries: RosterEntry[] = [];
  for (const soulPath of rosterFiles) {
    try {
      entries.push({ soul: await loadSoulFile(soulPath), path: soulPath });
    } catch (error) {
      warn(`skipping ${soulPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries;
};

export const resolveRuntimeConfig = async (
  selection: RuntimeSelection,
  env: StateEnvironment = {},
): Promise<RuntimeConfig> => {
  const processEnv = readProcessEnv(env);
  const configLocation = await resolveConfigLocation(selection, env);
  const fileConfig = configLocation ? await loadConfigFile(configLocation.path) : {};
  const soul = await resolveSoul(selection, env, fileConfig);

  // Explicit flags and env vars outrank the soul's own provider/model hints,
  // which outrank the config file's defaults.
  const provider = selection.provider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'))
    ?? readNonEmptyString(soul?.provider, (value) => parseProviderName(value, 'soul file'))
    ?? fileConfig.provider
    ?? 'demo';

  if (provider === 'demo') {
    return { provider: 'demo', ...(soul ? { soul } : {}) };
  }

  // A config file's model/baseUrl/apiKeyEnv were written for the provider
  // named in that file. When a flag, env var, or soul selects a different
  // provider, those values would point at the wrong API (e.g. an OpenAI
  // base URL handed to the Anthropic SDK), so they are ignored. A file with
  // no provider key predates the anthropic option, so its settings are
  // treated as openai-specific.
  const fileConfigApplies = (fileConfig.provider ?? 'openai') === provider;

  // A soul's model was chosen for the soul's own provider. If a flag or env
  // var overrides that provider, the model hint would target the wrong API
  // (e.g. a Claude model sent to OpenAI), so it only applies when the soul
  // names no provider or names the selected one.
  const soulModelApplies = soul?.provider === undefined || soul.provider === provider;

  const model = selection.model
    ?? readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_MODEL)
    ?? (soulModelApplies ? readNonEmptyString(soul?.model) : undefined)
    ?? (fileConfigApplies ? fileConfig.model : undefined)
    ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);

  const apiKeyEnvName = readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
    ?? (fileConfigApplies ? fileConfig.apiKeyEnv : undefined)
    ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');

  const credentials = await loadCredentials(env);

  // A custom endpoint chosen by an auto-discovered project config is not a
  // place the stored sign-in ever gets sent — a cloned repository could
  // point it anywhere. Flags and env vars are the user's own choice, and
  // the provider's default endpoint is harmless.
  const defaultEndpointFor = (target: string): string =>
    target === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  const untrustedCustomBaseUrl = configLocation?.trusted === false
    && selection.baseUrl === undefined
    && readNonEmptyString(processEnv.STRATUS_BASE_URL) === undefined
    && readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL) === undefined
    && fileConfigApplies
    && fileConfig.baseUrl !== undefined
    && fileConfig.baseUrl.replace(/\/+$/, '') !== defaultEndpointFor(String(provider));

  // Env vars outrank the stored sign-in from `stratus setup`.
  const envApiKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY)
    ?? readNonEmptyString(processEnv[String(apiKeyEnvName)]);
  const candidateCredential = credentials[provider as CredentialProviderName];
  // A bound credential ignores config URLs entirely, so an untrusted
  // project URL cannot redirect it — only unbound stored keys are blocked.
  const credentialIsBound = candidateCredential?.type === 'api_key' && candidateCredential.baseUrl !== undefined;
  const storedCredential = envApiKey || (untrustedCustomBaseUrl && !credentialIsBound)
    ? undefined
    : candidateCredential;

  const apiKey = envApiKey
    ?? (storedCredential?.type === 'api_key' ? storedCredential.value : undefined);
  const authToken = provider === 'anthropic' && storedCredential?.type === 'oauth_token'
    ? storedCredential.value
    : undefined;

  // A stored key bound to an endpoint is used ONLY with that endpoint — a
  // config file can never redirect it, not even to the official default
  // URL (a project config could otherwise reroute a local-service key to
  // the official API). An explicit flag or env URL that disagrees refuses
  // the stored key instead of leaking it. This applies to both providers.
  const boundBaseUrl = !envApiKey && storedCredential?.type === 'api_key'
    ? storedCredential.baseUrl
    : undefined;
  const explicitBaseUrl = selection.baseUrl
    ?? readNonEmptyString(processEnv.STRATUS_BASE_URL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL);
  if (boundBaseUrl && explicitBaseUrl
    && String(explicitBaseUrl).replace(/\/+$/, '') !== boundBaseUrl.replace(/\/+$/, '')) {
    throw new Error(
      `Your saved ${provider} sign-in is bound to ${boundBaseUrl} and is not sent to ${explicitBaseUrl}. Set ${apiKeyEnvName} or STRATUS_API_KEY to use that endpoint.`,
    );
  }

  const baseUrl = boundBaseUrl
    ?? explicitBaseUrl
    ?? (fileConfigApplies ? fileConfig.baseUrl : undefined)
    // The Anthropic SDK knows its own endpoint; only openai needs a default.
    ?? (provider === 'anthropic' ? undefined : DEFAULT_OPENAI_BASE_URL);

  if (!apiKey && !authToken) {
    if (untrustedCustomBaseUrl && credentials[provider as CredentialProviderName]) {
      throw new Error(
        `The project config at ${configLocation?.path} sets a custom base URL (${fileConfig.baseUrl}), so your saved sign-in is not sent to it. Set ${apiKeyEnvName} or STRATUS_API_KEY to use this endpoint, or run with --config to trust the file explicitly.`,
      );
    }
    throw new Error(
      `Missing API key for provider=${provider}. Run \`stratus setup\` to sign in, or set STRATUS_API_KEY or ${apiKeyEnvName}.`,
    );
  }

  const resolved: RuntimeConfig = provider === 'anthropic'
    ? {
        provider: 'anthropic',
        model: String(model),
        ...(baseUrl ? { baseUrl: String(baseUrl) } : {}),
        ...(apiKey ? { apiKey: String(apiKey) } : {}),
        ...(authToken ? { authToken } : {}),
      }
    : {
        provider: 'openai',
        model: String(model),
        baseUrl: String(baseUrl),
        apiKey: String(apiKey),
      };

  const systemPrompt = readNonEmptyString(processEnv.STRATUS_SYSTEM_PROMPT)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_SYSTEM_PROMPT)
    ?? fileConfig.systemPrompt;

  if (systemPrompt) {
    resolved.systemPrompt = String(systemPrompt);
  }

  if (env.fetch) {
    resolved.fetch = env.fetch;
  }

  if (soul) {
    resolved.soul = soul;
  }

  // A configured fallback model kicks in when the default model errors
  // mid-run. It needs its own working sign-in; without one the fallback is
  // quietly skipped rather than failing the run it exists to rescue.
  // An implicit fallback (no fallbackProvider key) was written for the
  // config's own provider — when a flag, env var, or soul overrides that
  // provider, the fallback model would target the wrong API, so it is
  // ignored. An explicit fallbackProvider stays valid regardless.
  if (fileConfig.fallbackModel && (fileConfig.fallbackProvider !== undefined || fileConfigApplies)) {
    const fallbackProvider = fileConfig.fallbackProvider ?? (provider as StratusProviderName);
    if (fallbackProvider !== 'demo') {
      // Same precedence as the primary sign-in: environment keys outrank
      // the stored credential. And the same endpoint rule: an untrusted
      // project config's custom fallback URL never receives a stored key —
      // including the primary's stored key when both share a provider.
      // Only env-supplied keys follow such a URL.
      const fallbackUntrustedUrl = fallbackProvider === 'openai'
        && configLocation?.trusted === false
        && fileConfig.fallbackBaseUrl !== undefined
        && fileConfig.fallbackBaseUrl.replace(/\/+$/, '') !== DEFAULT_OPENAI_BASE_URL;
      const fallbackEnvKey = readNonEmptyString(processEnv[fallbackProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']);
      const fallbackCredential = fallbackEnvKey || fallbackUntrustedUrl ? undefined : credentials[fallbackProvider];
      const primaryReusable = fallbackProvider === provider
        && (envApiKey !== undefined || !fallbackUntrustedUrl);
      const fallbackApiKey = (primaryReusable ? apiKey : undefined)
        ?? fallbackEnvKey
        ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.value : undefined);
      const fallbackAuthToken = fallbackProvider !== provider && fallbackProvider === 'anthropic' && fallbackCredential?.type === 'oauth_token'
        ? fallbackCredential.value
        : (primaryReusable ? authToken : undefined);

      if (fallbackApiKey || fallbackAuthToken) {
        // When the fallback key comes out of the credential store (its own
        // entry, or the primary's reused stored key), its bound endpoint is
        // authoritative — config URLs cannot redirect it.
        const fallbackBoundUrl = fallbackCredential?.type === 'api_key'
          ? fallbackCredential.baseUrl
          : (primaryReusable && !envApiKey ? boundBaseUrl : undefined);
        // An anthropic fallback on the same provider keeps the primary's
        // configured endpoint — retrying the same credential against the
        // official endpoint instead of the configured service would leak
        // it and likely fail.
        const fallbackAnthropicBaseUrl = fallbackProvider === 'anthropic'
          ? (fallbackProvider === provider && baseUrl ? String(baseUrl) : undefined)
            ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.baseUrl : undefined)
          : undefined;
        resolved.fallback = {
          provider: fallbackProvider,
          model: fileConfig.fallbackModel,
          ...(fallbackProvider === 'openai'
            ? {
                baseUrl: fallbackBoundUrl
                  ?? fileConfig.fallbackBaseUrl
                  ?? (fallbackProvider === provider ? String(baseUrl) : undefined)
                  ?? DEFAULT_OPENAI_BASE_URL,
              }
            : (fallbackAnthropicBaseUrl ? { baseUrl: fallbackAnthropicBaseUrl } : {})),
          ...(fallbackApiKey ? { apiKey: String(fallbackApiKey) } : {}),
          ...(fallbackAuthToken ? { authToken: fallbackAuthToken } : {}),
        };
      }
    }
  }

  return resolved;
};

export const createDemoTool = () =>
  defineLocalCommandTool({
    name: 'demo.echo',
    description: 'Return a tiny transformed summary for CLI demos through a real local process.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back through the local process.' },
      },
      required: ['text'],
    },
    async createCommand(input) {
      const text = typeof input.text === 'string' ? input.text : '';
      const normalized = text.trim() || 'empty input';
      const script = `const text = ${JSON.stringify(normalized)}; console.log(JSON.stringify({ received: text, uppercase: text.toUpperCase(), length: text.length }));`;

      return {
        command: process.execPath,
        args: ['-e', script],
      };
    },
    parseResult(result) {
      return JSON.parse(result.stdout) as JsonValue;
    },
  });

export const createDemoProvider = (): ModelProvider =>
  defineProvider({
    name: 'demo',
    async generate({ session }) {
      const builder = createProviderResponseBuilder();
      const lastMessage = session.messages.at(-1);

      if (lastMessage?.role === 'tool') {
        const result = lastMessage.toolResult;
        if (result?.ok) {
          builder.addText(`The demo.echo tool finished with: ${JSON.stringify(result.output)}`);
        } else {
          builder.addText(`The demo.echo tool did not run (${result?.error ?? 'unknown error'}), so this run ends here.`);
        }
        return builder.done();
      }

      const prompt = [...session.messages].reverse().find((message) => message.role === 'user')?.content?.trim() ?? '';
      const wantsTool = /\b(tool|echo|uppercase|inspect)\b/i.test(prompt);

      builder.addText(`Demo provider ready. Prompt received: ${prompt || '(empty)'}`);

      if (wantsTool) {
        builder.addToolCall({
          id: `${session.id}:call:demo-echo`,
          toolName: 'demo.echo',
          input: { text: prompt },
        });
      } else {
        builder.addText('No tool call was needed, so this run stays text-only. Mention “tool” or “echo” to trigger the demo tool.');
      }

      return builder.done();
    },
  });

/**
 * Session metadata flag marking a conversation as switched to its fallback
 * model. Lives on the session (persisted by the runner's saves) so the
 * documented session-sticky behavior survives daemon restarts and runner
 * rebuilds — a conversation never silently returns to the primary provider.
 */
export const FALLBACK_ACTIVE_METADATA_KEY = 'fallbackActive';

// Wraps the fallback runtime as a provider: the primary model serves every
// turn until it throws, then that session switches to the fallback for
// good. Stickiness is per session, never per provider instance — a pooled
// provider serves many sessions (the gateway), and one session's transient
// failure must not silently reroute every other conversation. The switch
// is recorded in session metadata so it is as durable as the session; the
// in-memory set only covers the window before the next save.
export const createFallbackWrappedProvider = (
  primary: ModelProvider,
  fallback: ModelProvider,
  onFallback: (error: unknown) => void,
): ModelProvider => {
  const fallbackSessions = new Set<string>();

  return {
    name: primary.name,
    async generate(request) {
      const switched = request.session.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true
        || fallbackSessions.has(request.session.id);
      if (!switched) {
        // Track whether the primary streamed anything: a partial attempt
        // must be explicitly reset before the fallback streams, or a
        // consumer would fuse both attempts into one garbled message.
        let primaryStreamed = false;
        const onDelta = request.onDelta;
        const primaryRequest = onDelta
          ? {
              ...request,
              onDelta: async (delta: Parameters<typeof onDelta>[0]) => {
                primaryStreamed = true;
                await onDelta(delta);
              },
            }
          : request;
        try {
          return await primary.generate(primaryRequest);
        } catch (error) {
          // A turn that already executed tools must not be replayed on
          // another provider — the side effects (a remembered fact, a
          // command) would happen twice.
          if (hasHostedToolSideEffects(error)) {
            throw error;
          }
          // A cancelled turn is not a provider failure: the abort error
          // must surface as-is, and the session must not be routed to the
          // fallback model for every later conversation turn.
          if (request.signal?.aborted) {
            throw error;
          }
          fallbackSessions.add(request.session.id);
          (request.session.metadata ??= {})[FALLBACK_ACTIVE_METADATA_KEY] = true;
          onFallback(error);
          if (primaryStreamed && request.onDelta) {
            await request.onDelta({ type: 'reset' });
          }
        }
      }
      return fallback.generate(request);
    },
  };
};

export const createRuntimeProvider = (
  config: RuntimeConfig,
  onFallback?: (error: unknown) => void,
  executeTool?: ClaudeCodeToolExecutor,
  maxTurns?: number,
): ModelProvider => {
  if (config.provider === 'demo') {
    return createDemoProvider();
  }

  if (config.fallback) {
    const { fallback, ...primaryConfig } = config;
    const primary = createRuntimeProvider(primaryConfig, undefined, executeTool, maxTurns);
    const fallbackProvider = createRuntimeProvider({
      ...fallback,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    } as RuntimeConfig, undefined, executeTool, maxTurns);
    return createFallbackWrappedProvider(primary, fallbackProvider, onFallback ?? (() => {}));
  }

  if (config.provider === 'anthropic') {
    // Subscription setup tokens are only honored inside the Claude Code
    // harness, so they route through the Agent SDK runtime; API keys use
    // the raw Messages API.
    if (config.authToken && !config.apiKey) {
      return createClaudeCodeProvider({
        authToken: config.authToken,
        model: config.model,
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
        // Kernel tools run through the host loop (approvals, events,
        // allowlists intact), so the subscription runtime is the same
        // agent as the API-key provider — memory.remember included.
        ...(executeTool ? { executeTool } : {}),
        // An explicit max-turns governs the Claude Code inner loop too;
        // this provider consumes all tool calls inside one generate, so
        // the outer runner never sees them.
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      });
    }
    return createAnthropicProvider({
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  return createOpenAICompatibleProvider({
    name: 'openai',
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
};
