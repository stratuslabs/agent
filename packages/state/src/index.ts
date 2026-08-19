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
  Session,
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
  type ClaudeCodeQueryFn,
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
  /**
   * The Agent SDK transport, for the same reason `fetch` is here: an
   * environment can pin how a run reaches the outside world. Without it
   * the subscription path is the one runtime nothing can drive except by
   * launching Claude Code for real.
   */
  queryFn?: ClaudeCodeQueryFn;
}

export type StratusProviderName = 'demo' | 'openai' | 'anthropic';

/**
 * Who may approve one agent's gated calls, and where they are asked.
 * Approver ids are channel-native (Slack user ids) because that is where
 * the click comes from — mapping them through a Stratus identity would add
 * a lookup that can only ever be wrong.
 */
export interface AgentApprovalConfig {
  /**
   * Slack user ids allowed to decide. Nobody listed means nobody may — an
   * explicit empty array is how an agent is excluded from a global approver
   * list, and is kept distinct from the key being absent, which inherits.
   */
  slackApprovers?: string[];
  /**
   * Conversation to ask in when the turn is not itself in Slack. A turn
   * that arrived through Slack is answered in its own thread regardless.
   */
  slackChannel?: string;
}

/**
 * The longest an approval may wait: Node's maximum `setTimeout` delay.
 * Above it a timer does not wait longer, it fires almost immediately.
 */
export const MAX_APPROVAL_TIMEOUT_MS = 2_147_483_647;

/** The `approvals` block of ~/.stratus/config.json. */
export interface ApprovalsConfig extends AgentApprovalConfig {
  /**
   * How the daemon reaches a person. `headless` refuses every gated call;
   * `remote` parks the turn and asks through a channel. Default `headless`
   * — an unconfigured daemon must not start waiting on humans who were
   * never told they were on the hook.
   */
  mode?: 'headless' | 'remote';
  /** How long a parked call waits before denying itself, in milliseconds. */
  timeoutMs?: number;
  /** Per-agent overrides, keyed by agent id. */
  agents?: Record<string, AgentApprovalConfig>;
}

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
  /** Unattended-approval policy for `stratus serve`. */
  approvals?: ApprovalsConfig;
}

/** A resolved, ready-to-run fallback model (always a real provider). */
export interface FallbackRuntime {
  provider: 'anthropic' | 'openai';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  /**
   * The Agent SDK transport for a *subscription* fallback, which a primary
   * cannot always supply. A fallback inherits `fetch` from its primary
   * because both provider variants carry one — but `queryFn` exists only
   * on the Anthropic variant, so an OpenAI primary with a subscription
   * fallback has nothing to inherit and no other way to say it. Without
   * this, that configuration reaches the real Agent SDK the moment the
   * primary fails.
   */
  queryFn?: ClaudeCodeQueryFn;
}

export type RuntimeConfig =
  | { provider: 'demo'; soul?: ParsedSoul; soulPath?: string }
  | {
      provider: 'openai';
      model: string;
      baseUrl: string;
      apiKey: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
      soul?: ParsedSoul;
      /** Absolute path the soul was loaded from, for callers that re-read it. */
      soulPath?: string;
      /**
       * The environment variable the API key came from, when it came from
       * the environment rather than the credential store. Callers report
       * it verbatim — guessing the name gets it wrong whenever a custom
       * variable or the legacy prefix supplied the key.
       */
      apiKeyEnvVar?: string;
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
      /**
       * The subscription path's transport seam, and the counterpart to
       * `fetch` above: this variant serves both Anthropic modes, and an
       * API key reaches the wire through `fetch` while a subscription
       * token reaches it through the Agent SDK's `query`. Without both,
       * only half of what this config can select is reachable from a
       * test.
       */
      queryFn?: ClaudeCodeQueryFn;
      soul?: ParsedSoul;
      /** Absolute path the soul was loaded from, for callers that re-read it. */
      soulPath?: string;
      /** See the openai variant — the variable that supplied the key. */
      apiKeyEnvVar?: string;
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
  /**
   * An already-parsed soul used verbatim instead of loading any file —
   * for callers serving from a cache while the backing file is
   * unreadable. Outranks soul paths and the config file's default soul,
   * so no other agent's soul can substitute its pins. Pass null to
   * resolve with no soul at all (a soul-less agent must not inherit the
   * config file's default soul either).
   */
  presetSoul?: ParsedSoul | null;
  /**
   * An already-loaded config snapshot used instead of reading any file —
   * for long-running callers serving the last known-good config while
   * the file on disk is temporarily broken. Carries the trust flag (and
   * path, for messages) the snapshot was loaded with; an empty config
   * ({ config: {}, trusted: true }) resolves as if no file existed.
   */
  presetConfig?: { config: StratusConfigFile; trusted: boolean; path?: string };
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
const LOGS_DIRNAME = 'logs';
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
/** Where `stratus serve` keeps its structured log, and `stratus logs` reads it. */
export const logsDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), LOGS_DIRNAME);
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

// The raw credentials file, whatever it holds. Writers merge into this so
// one namespace (provider sign-ins, channel tokens) never clobbers another.
const loadRawCredentialsFile = async (env: StateEnvironment): Promise<Record<string, unknown>> => {
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
  return parsed as Record<string, unknown>;
};

const writeRawCredentialsFile = async (env: StateEnvironment, contents: Record<string, unknown>): Promise<void> => {
  const filePath = credentialsPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
};

// Credentials never live in a project directory or a shell profile — they
// are written once by `stratus setup` and read on every run, 0600 so only
// the owner can read them. Provider entries merge over the existing file,
// so channel tokens (and anything else stored alongside) survive a
// re-run of setup.
export const saveCredentials = async (env: StateEnvironment, credentials: CredentialsFile): Promise<void> => {
  const existing = await loadRawCredentialsFile(env);
  for (const provider of ['anthropic', 'openai'] as const) {
    if (credentials[provider]) {
      existing[provider] = credentials[provider];
    } else {
      delete existing[provider];
    }
  }
  await writeRawCredentialsFile(env, existing);
};

/**
 * A Slack app/bot token pair for one agent. Channel tokens are gateway
 * infrastructure secrets, not agent capabilities: they live in their own
 * `channels` namespace of the credentials file and are NEVER resolved
 * through the agent-scoped CredentialResolver — an agent's credential
 * allowlist neither needs nor grants access to its own transport tokens.
 */
export interface SlackChannelCredential {
  appToken: string;
  botToken: string;
}

export interface ChannelCredentials {
  /** Keyed by agent id — one Slack app (one bot identity) per agent. */
  slack?: Record<string, SlackChannelCredential>;
}

export const loadChannelCredentials = async (env: StateEnvironment): Promise<ChannelCredentials> => {
  const raw = await loadRawCredentialsFile(env);
  const channels = raw.channels;
  if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
    return {};
  }
  const slackRaw = (channels as Record<string, unknown>).slack;
  if (typeof slackRaw !== 'object' || slackRaw === null || Array.isArray(slackRaw)) {
    return {};
  }
  const slack: Record<string, SlackChannelCredential> = {};
  for (const [agentId, entry] of Object.entries(slackRaw as Record<string, unknown>)) {
    if (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
      typeof (entry as SlackChannelCredential).appToken === 'string' &&
      typeof (entry as SlackChannelCredential).botToken === 'string'
    ) {
      slack[agentId] = {
        appToken: (entry as SlackChannelCredential).appToken,
        botToken: (entry as SlackChannelCredential).botToken,
      };
    }
  }
  return Object.keys(slack).length > 0 ? { slack } : {};
};

export const saveChannelCredentials = async (
  env: StateEnvironment,
  channels: ChannelCredentials,
): Promise<void> => {
  const existing = await loadRawCredentialsFile(env);
  existing.channels = channels;
  await writeRawCredentialsFile(env, existing);
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
      // Long-term memory is conversation content — owner-only, like the
      // credentials and session files. A file created earlier under a
      // looser umask is tightened BEFORE the new fact lands in it; the
      // mode option covers fresh creation.
      try {
        await chmod(filePath, 0o600);
      } catch (error) {
        // Only a missing file is fine (the append below creates it
        // owner-only). Any other failure means the file EXISTS but cannot
        // be tightened — never write conversation content into a file
        // that stays readable by others.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
  const approvals = parseApprovalsConfig(config.approvals, configPath);
  if (approvals) {
    resolved.approvals = approvals;
  }

  return resolved;
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
        // A config that exists but cannot be read is the same class of
        // failure as one that cannot be parsed — typed, so long-running
        // callers can degrade instead of failing every dispatch.
        throw new ConfigFileError(candidate.path, error);
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
export const resolveSoulPath = (
  selection: RuntimeSelection,
  env: StateEnvironment,
  fileConfig: StratusConfigFile,
): string | undefined => {
  const processEnv = readProcessEnv(env);
  const soulPath = selection.soul
    ?? readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_SOUL)
    ?? fileConfig.soul;

  if (!soulPath) {
    return undefined;
  }

  return path.resolve(readWorkingDirectory(env), String(soulPath));
};

export const resolveSoul = async (
  selection: RuntimeSelection,
  env: StateEnvironment,
  fileConfig: StratusConfigFile,
): Promise<ParsedSoul | undefined> => {
  const resolvedPath = resolveSoulPath(selection, env, fileConfig);
  if (!resolvedPath) {
    return undefined;
  }
  return loadSoulFile(resolvedPath);
};

/**
 * Resolves and loads just the soul a selection points at (explicit path,
 * env var, or the config file's default) WITHOUT resolving providers or
 * credentials — for callers that need the agent's identity even when full
 * runtime resolution would fail validation (e.g. a daemon default
 * provider whose credentials are absent while the soul pins another).
 */
export const resolveConfiguredSoul = async (
  selection: RuntimeSelection,
  env: StateEnvironment = {},
): Promise<{ soul: ParsedSoul; path: string } | undefined> => {
  const configLocation = await resolveConfigLocation(selection, env);
  const fileConfig = configLocation ? await loadConfigFile(configLocation.path) : {};
  const soulPath = resolveSoulPath(selection, env, fileConfig);
  if (!soulPath) {
    return undefined;
  }
  return { soul: await loadSoulFile(soulPath), path: soulPath };
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
 * Two soul files claiming the same agent id.
 *
 * Typed so diagnostic callers can report it as a finding rather than
 * surfacing a stack trace, while the daemon lets it stop a start.
 */
export class DuplicateAgentIdError extends Error {
  readonly agentId: string;
  readonly paths: [string, string];

  constructor(agentId: string, paths: [string, string]) {
    super(
      `Two soul files declare the agent id ${agentId}: ${paths[0]} and ${paths[1]}. `
      + 'Ids key sessions, memory, and credentials, so one of them has to change.',
    );
    this.name = 'DuplicateAgentIdError';
    this.agentId = agentId;
    this.paths = paths;
  }
}

/**
 * Loads the soul roster from ~/.stratus/agents. Unreadable files degrade
 * to a warning: one broken soul must never take the rest of the team down.
 *
 * A duplicate id does NOT degrade, and the difference is the point.
 * Skipping an unreadable file loses one agent, and which one is obvious.
 * Picking a winner between two files claiming one id makes an agent
 * silently inherit another's sessions, memory, and credentials, with the
 * winner decided by filename sort order — there is no degraded behaviour
 * that is right, so this refuses instead of guessing.
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
  const byId = new Map<string, string>();
  for (const soulPath of rosterFiles) {
    let entry: RosterEntry;
    try {
      entry = { soul: await loadSoulFile(soulPath), path: soulPath };
    } catch (error) {
      warn(`skipping ${soulPath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Reserved ids are dropped BEFORE collision detection, and the order
    // matters. A soul claiming the built-in id is skipped either way — it
    // may not take the documented fallback over — so two of them are not
    // an ambiguity to refuse over: neither was going to get the id. Left
    // after the check, a repository could take a daemon down simply by
    // shipping two souls named `stratus`, turning a guard against hijack
    // into a way to deny service.
    if (entry.soul.agent.id === DEFAULT_STRATUS_AGENT.id) {
      warn(`agent id ${entry.soul.agent.id} is reserved for the built-in agent; ignoring ${soulPath}`);
      continue;
    }

    const claimed = byId.get(entry.soul.agent.id);
    if (claimed !== undefined) {
      throw new DuplicateAgentIdError(entry.soul.agent.id, [claimed, soulPath]);
    }
    byId.set(entry.soul.agent.id, soulPath);
    entries.push(entry);
  }
  return entries;
};

/**
 * The environment variable that supplies this provider's API key, before
 * the two generic ones are considered. A config file's `apiKeyEnv` was
 * written for the provider named in that file, so it only counts when the
 * file still describes the provider being resolved.
 *
 * Exported because diagnostics have to name the variable that actually
 * won: re-deriving this rule elsewhere drifts, and a warning that blames
 * the wrong variable leaves the real override — and its billing — in place.
 */
export const apiKeyEnvNameFor = (
  provider: CredentialProviderName,
  fileConfig: StratusConfigFile,
  fileConfigApplies: boolean,
  env: StateEnvironment = {},
): string => {
  const processEnv = readProcessEnv(env);
  return String(
    readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
      ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
      ?? (fileConfigApplies ? fileConfig.apiKeyEnv : undefined)
      ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'),
  );
};

/**
 * The environment key a run would use, and the variable it came from.
 * Order matches the resolver: the generic variables outrank the
 * provider-specific one.
 */
export const resolveEnvApiKey = (
  apiKeyEnvName: string,
  env: StateEnvironment = {},
): { name: string; value: string } | undefined => {
  const processEnv = readProcessEnv(env);
  for (const name of ['STRATUS_API_KEY', 'STRATUSCLAW_API_KEY', apiKeyEnvName]) {
    const value = readNonEmptyString(processEnv[name]);
    if (typeof value === 'string') {
      return { name, value };
    }
  }
  return undefined;
};

export const resolveRuntimeConfig = async (
  selection: RuntimeSelection,
  env: StateEnvironment = {},
): Promise<RuntimeConfig> => {
  const processEnv = readProcessEnv(env);
  const configLocation = selection.presetConfig !== undefined ? undefined : await resolveConfigLocation(selection, env);
  const fileConfig = selection.presetConfig?.config ?? (configLocation ? await loadConfigFile(configLocation.path) : {});
  // Trust (and the path shown in messages) follows the snapshot when one
  // is preset, the discovered location otherwise.
  const configTrusted = selection.presetConfig !== undefined ? selection.presetConfig.trusted : configLocation?.trusted;
  const configPathShown = selection.presetConfig !== undefined ? selection.presetConfig.path : configLocation?.path;
  const soulPath = selection.presetSoul !== undefined ? undefined : resolveSoulPath(selection, env, fileConfig);
  const soul = selection.presetSoul ?? (soulPath ? await loadSoulFile(soulPath) : undefined);

  // Explicit flags and env vars outrank the soul's own provider/model hints,
  // which outrank the config file's defaults.
  const provider = selection.provider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'))
    ?? readNonEmptyString(soul?.provider, (value) => parseProviderName(value, 'soul file'))
    ?? fileConfig.provider
    ?? 'demo';

  if (provider === 'demo') {
    return { provider: 'demo', ...(soul ? { soul } : {}), ...(soulPath ? { soulPath } : {}) };
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

  const apiKeyEnvName = apiKeyEnvNameFor(provider as CredentialProviderName, fileConfig, fileConfigApplies, env);

  const credentials = await loadCredentials(env);

  // A custom endpoint chosen by an auto-discovered project config is not a
  // place the stored sign-in ever gets sent — a cloned repository could
  // point it anywhere. Flags and env vars are the user's own choice, and
  // the provider's default endpoint is harmless.
  const defaultEndpointFor = (target: string): string =>
    target === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  const untrustedCustomBaseUrl = configTrusted === false
    && selection.baseUrl === undefined
    && readNonEmptyString(processEnv.STRATUS_BASE_URL) === undefined
    && readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL) === undefined
    && fileConfigApplies
    && fileConfig.baseUrl !== undefined
    && fileConfig.baseUrl.replace(/\/+$/, '') !== defaultEndpointFor(String(provider));

  // Env vars outrank the stored sign-in from `stratus setup`.
  const envApiKeyEntry = resolveEnvApiKey(apiKeyEnvName, env);
  const envApiKey = envApiKeyEntry?.value;
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
        `The project config at ${configPathShown} sets a custom base URL (${fileConfig.baseUrl}), so your saved sign-in is not sent to it. Set ${apiKeyEnvName} or STRATUS_API_KEY to use this endpoint, or run with --config to trust the file explicitly.`,
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
        ...(envApiKeyEntry ? { apiKeyEnvVar: envApiKeyEntry.name } : {}),
      }
    : {
        provider: 'openai',
        model: String(model),
        baseUrl: String(baseUrl),
        apiKey: String(apiKey),
        ...(envApiKeyEntry ? { apiKeyEnvVar: envApiKeyEntry.name } : {}),
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

  if (env.queryFn && resolved.provider === 'anthropic') {
    resolved.queryFn = env.queryFn;
  }

  if (soul) {
    resolved.soul = soul;
  }
  if (soulPath) {
    resolved.soulPath = soulPath;
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
        && configTrusted === false
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
          // Here rather than with the primary's transport above, because
          // the fallback does not exist yet at that point. A subscription
          // fallback behind an OpenAI primary has no transport to inherit,
          // so without this it reaches the real Agent SDK the moment the
          // primary fails.
          ...(env.queryFn && fallbackProvider === 'anthropic' ? { queryFn: env.queryFn } : {}),
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
    // It does spawn a process, but a fixed one: `node -e` over a script this
    // tool builds, with the model's text placed as a JSON string literal and
    // no shell involved. Nothing the model says becomes a command.
    risk: 'safe',
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
  persistSession?: (session: Session) => Promise<void>,
): ModelProvider => {
  const fallbackSessions = new Set<string>();

  return {
    name: primary.name,
    async generate(request) {
      const switched = request.session.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true
        || fallbackSessions.has(request.session.id);
      if (!switched) {
        try {
          return await primary.generate(request);
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
          // The switch is durable BEFORE the fallback attempt begins: a
          // daemon killed while the fallback is in flight must not retry
          // the primary on restart — stickiness is the contract.
          // Best-effort: if the save itself fails, the in-memory
          // stickiness still covers this process's lifetime.
          if (persistSession) {
            try {
              await persistSession(request.session);
            } catch {
              // Served anyway; the next runner save retries persistence.
            }
          }
          // A reset always precedes the fallback attempt when a sink is
          // attached: it discards whatever partial primary output the
          // consumer buffered, and it is the one in-band signal that this
          // turn switched providers — watchers (the gateway's idle
          // watchdog) rely on it even when the primary died before its
          // first delta.
          if (request.onDelta) {
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
  persistSession?: (session: Session) => Promise<void>,
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
      // Both transports travel, not just the HTTP one. A fallback that
      // inherits `fetch` but not `queryFn` reaches the real Agent SDK the
      // moment the primary fails — launching Claude Code out of a test, or
      // out from under an embedder that supplied its own transport for a
      // reason. The two are one seam and have to be carried together.
      ...(config.fetch ? { fetch: config.fetch } : {}),
      // Inherited from an Anthropic primary, but a fallback naming its own
      // wins — it is the only way a cross-provider pair can say it.
      ...(config.provider === 'anthropic' && config.queryFn ? { queryFn: config.queryFn } : {}),
      ...(fallback.queryFn ? { queryFn: fallback.queryFn } : {}),
    } as RuntimeConfig, undefined, executeTool, maxTurns);
    return createFallbackWrappedProvider(primary, fallbackProvider, onFallback ?? (() => {}), persistSession);
  }

  if (config.provider === 'anthropic') {
    // Subscription setup tokens are only honored inside the Claude Code
    // harness, so they route through the Agent SDK runtime; API keys use
    // the raw Messages API.
    if (config.authToken && !config.apiKey) {
      return createClaudeCodeProvider({
        authToken: config.authToken,
        model: config.model,
        ...(config.queryFn ? { queryFn: config.queryFn } : {}),
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
