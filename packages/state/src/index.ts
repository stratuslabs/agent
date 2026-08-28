import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentDefinition,
  AgentMemoryStore,
  AvatarTheme,
  JsonObject,
  JsonValue,
  MemoryEntry,
  ModelProvider,
  Session,
} from '@stratusagent/core';
import {
  agentIdWithSuffix,
  defineAgent,
  parseSoul,
  type ParsedSoul,
} from '@stratusagent/agents';
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

/**
 * The `api` block of ~/.stratus/config.json — whether `stratus serve` also
 * serves the control API, and where.
 *
 * Read only from a **trusted** config, for the same reason the approvals
 * block is: an auto-discovered project-local `stratus.config.json` can be
 * checked into any repository, and a cloned repo must not be able to decide
 * which interface a daemon binds.
 */
export interface ApiConfig {
  /** Default true when @stratusagent/control-api is installed. */
  enabled?: boolean;
  /** Interface to bind. Default 127.0.0.1 — loopback is the posture. */
  host?: string;
  /** Port to bind. Default 4123. */
  port?: number;
}

/**
 * One plugin's settings: whether it runs, its own configuration, and the
 * per-agent overrides beneath it.
 *
 * Typed as an open object because the keys belong to the plugin, not to
 * this file — the daemon validates them against the manifest's own schema
 * at load time, which is the only place that knows what `roots` means.
 * What this package owns is the two keys the *host* reads.
 */
export interface PluginConfigBlock extends JsonObject {
  /** Default true: a listed plugin runs unless it says otherwise. */
  enabled?: boolean;
  /**
   * Per-agent settings, keyed by agent id, over the defaults above them.
   * The same shape `approvals` already carries — and it matters more here,
   * because for a plugin like `tool-fs` these values are an access boundary
   * between agents rather than a preference.
   */
  agents?: JsonObject;
}

/**
 * The `plugins` block of ~/.stratus/config.json, keyed by **package name**.
 *
 * By package because a plugin's identity is its package, and because a
 * plugin may contribute more than tools — a block keyed by toolset has
 * nowhere to put one that adds a channel and a memory store.
 *
 * Read only from a **trusted** config, and this is the sharpest case of
 * that rule rather than another instance of it: a plugin runs in-process
 * with the daemon, so a list an auto-discovered project-local
 * `stratus.config.json` could write is a list of code a cloned repository
 * gets to execute.
 */
export type PluginsConfig = Record<string, PluginConfigBlock>;

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
  /** Control API binding for `stratus serve`. */
  api?: ApiConfig;
  /** Plugins to load, keyed by package name. Trusted configs only. */
  plugins?: PluginsConfig;
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
const STRATUS_HOME_DIRNAME = '.stratus';
const WORKSPACES_DIRNAME = 'workspaces';
const GLOBAL_CONFIG_FILENAME = 'config.json';
const CREDENTIALS_FILENAME = 'credentials.json';
const AGENTS_DIRNAME = 'agents';
const MEMORY_FILENAME = 'memory.jsonl';
const LOGS_DIRNAME = 'logs';
const GATEWAY_TOKEN_FILENAME = 'gateway-token';
const GATEWAY_INFO_FILENAME = 'gateway.json';
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
/**
 * Where tools put files they produce — a screenshot a channel then uploads,
 * a report an agent wrote. One directory per agent, for the same reason
 * sessions, memory, and credentials are keyed that way: an agent's output
 * is that agent's, and a shared scratch directory is two agents reading
 * each other's work.
 *
 * The layout lives here because this package owns `~/.stratus`. Plugins do
 * not derive it — the host passes the resolved path in, so a plugin has no
 * copy of this repository's directory conventions to drift from.
 */
export const workspacesDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), WORKSPACES_DIRNAME);
export const agentWorkspacePath = (env: StateEnvironment, agentId: string): string =>
  path.join(workspacesDirPath(env), agentId);
/**
 * The control API's bearer token (0600). Programmatic clients — the CLI's
 * `--gateway` mode, the macOS app — read it from here rather than being told
 * it, so there is nothing to copy, paste, or leak into a shell history.
 */
export const gatewayTokenPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), GATEWAY_TOKEN_FILENAME);
/**
 * Where a running daemon says it can be reached (0600). Written when the
 * control API binds and removed when it stops, so a client discovers the
 * host and port instead of guessing at a default the operator may have
 * changed.
 */
export const gatewayInfoPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), GATEWAY_INFO_FILENAME);

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
  const approvals = parseApprovalsConfig(config.approvals, configPath);
  if (approvals) {
    resolved.approvals = approvals;
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
  const explicit = selection.configPath ?? processEnv.STRATUS_CONFIG;

  if (explicit) {
    return { path: path.resolve(cwd, explicit), trusted: true };
  }

  // Project-local configs win; the global ~/.stratus/config.json written by
  // `stratus setup` is the fallback that makes the CLI work from anywhere.
  const candidates: ResolvedConfigLocation[] = [
    { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), trusted: false },
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
  /**
   * The file the caller was pinned to, if any. Without it a daemon started
   * with `--config custom.json` would have its roster, health, and model
   * catalog answered from the cwd or global config instead — describing a
   * configuration it is not running on.
   */
  configPath?: string,
): Promise<{ location?: ResolvedConfigLocation; config: StratusConfigFile }> => {
  let location: ResolvedConfigLocation | undefined;
  try {
    location = await resolveConfigLocation(configPath ? { configPath } : {}, env);
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

/**
 * What reading a trusted-config-only block found. Four outcomes because
 * they mean four different things to an operator, and collapsing any two
 * of them loses the one thing they need to know: nothing was configured, it
 * was configured somewhere that may not decide this, it could not be read,
 * or here it is.
 */
export type TrustedConfigBlock<T> =
  | { status: 'absent' }
  | { status: 'present'; value: T; path: string }
  | { status: 'untrusted'; path: string }
  | { status: 'unreadable'; error: unknown };

/**
 * Read one block of the daemon's own config, honouring the trust boundary.
 *
 * `api`, `approvals`, and `plugins` are all read this way: which interface
 * a daemon binds, who may approve its tool calls, and whose code runs
 * in-process with it are not decisions an auto-discovered project-local
 * `stratus.config.json` gets to make, because that file ships in any
 * repository somebody clones.
 *
 * The precedence is `resolveConfigLocation`'s, not a second copy of it —
 * `--config` and STRATUS_CONFIG both move the file, and a caller reading
 * `~/.stratus/config.json` directly would answer from a config the daemon
 * is not running on. Callers phrase their own warning: an ignored approver
 * list and an ignored plugin list are the same rule and very different
 * sentences.
 */
export const readTrustedConfigBlock = async <K extends keyof StratusConfigFile>(
  key: K,
  env: StateEnvironment,
  configPath?: string,
): Promise<TrustedConfigBlock<NonNullable<StratusConfigFile[K]>>> => {
  let location: ResolvedConfigLocation | undefined;
  try {
    location = await resolveConfigLocation(configPath ? { configPath } : {}, env);
    if (!location) {
      return { status: 'absent' };
    }
    const value = (await loadConfigFile(location.path))[key];
    if (value === undefined) {
      return { status: 'absent' };
    }
    if (!location.trusted) {
      return { status: 'untrusted', path: location.path };
    }
    return { status: 'present', value: value as NonNullable<StratusConfigFile[K]>, path: location.path };
  } catch (error) {
    return { status: 'unreadable', error };
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
  for (const name of ['STRATUS_API_KEY', apiKeyEnvName]) {
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
    ?? readNonEmptyString(processEnv.STRATUS_BASE_URL);
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
            await request.onDelta({ type: 'reset', reason: 'fallback' });
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
    if (defaultProvider !== undefined && defaultProvider !== 'demo' && pins.provider !== defaultProvider) {
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

// ---------------------------------------------------------------------------
// Provider catalogs and key verification
// ---------------------------------------------------------------------------

/**
 * The provider-specific variable a key is read from when nothing else names
 * one. `apiKeyEnvNameFor` is the full rule — config file and generic
 * overrides included; this is only the last term of it, which callers
 * enumerating providers (a catalog sweep, a sign-in status line) need on its
 * own for a provider that is *not* the configured default.
 */
export const defaultApiKeyEnvName = (provider: CredentialProviderName): string =>
  provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

/**
 * Shown when live model listing is unavailable: a Claude subscription token
 * cannot call the models endpoint, and neither can an offline machine.
 */
export const KNOWN_CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];

// Model ids that cannot serve /chat/completions and must not become the
// default: embeddings, audio, images, moderation, and legacy completions.
const NON_CHAT_MODEL_PATTERN = /embed|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|davinci|babbage|curie|(^|[-_])ada([-_]|$)/i;

/**
 * What a live key check concluded. `unreachable` is deliberately distinct
 * from `rejected`: only an explicit auth failure condemns a key.
 */
export interface ProviderKeyVerdict {
  status: 'ok' | 'rejected' | 'unreachable';
  detail?: string;
}

/**
 * Live check that a key actually works, so the user finds out while they are
 * entering it instead of on their first run.
 */
export const verifyProviderKey = async (
  provider: CredentialProviderName,
  key: string,
  baseUrl: string | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<ProviderKeyVerdict> => {
  if (typeof fetchImpl !== 'function') {
    return { status: 'unreachable', detail: 'fetch is unavailable' };
  }

  const root = (baseUrl ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL)).replace(/\/+$/, '');
  const url = provider === 'anthropic' ? `${root}/v1/models` : `${root}/models`;
  const headers = provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };

  try {
    const response = await fetchImpl(url, { headers });
    if (response.ok) {
      return { status: 'ok' };
    }
    // Only an explicit auth failure condemns the key. Compatible endpoints
    // (local models, proxies) often lack GET /models entirely — a 404/405
    // there says nothing about the key, so it stays saveable.
    if (response.status === 401 || response.status === 403) {
      return { status: 'rejected', detail: `HTTP ${response.status}` };
    }
    return { status: 'unreachable', detail: `the endpoint did not support a key check (HTTP ${response.status})` };
  } catch (error) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
};

/** One model a stored sign-in can actually reach. */
export interface CatalogModel {
  provider: CredentialProviderName;
  id: string;
}

/**
 * The current default selection, as far as model discovery cares. Passed
 * explicitly rather than re-resolved because the caller may be holding an
 * unsaved edit — setup's in-progress state, or a config body being validated
 * before it is written.
 */
export interface ModelCatalogSelection {
  /**
   * The default provider. Only it may use the generic `STRATUS_API_KEY` and
   * the configured `apiKeyEnv`; a secondary provider relies on its own
   * variable or stored sign-in, never the default provider's secret.
   */
  provider?: StratusProviderName;
  baseUrl?: string;
  apiKeyEnv?: string;
  credentials: CredentialsFile;
}

/**
 * Every model the current sign-ins can actually reach, fetched live where
 * possible. Subscription tokens cannot call the models endpoint, so those
 * fall back to the known Claude lineup.
 */
export const collectAvailableModels = async (
  selection: ModelCatalogSelection,
  env: StateEnvironment = {},
): Promise<CatalogModel[]> => {
  const processEnv = readProcessEnv(env);
  const fetchImpl = env.fetch ?? globalThis.fetch;
  const models: CatalogModel[] = [];

  for (const provider of ['anthropic', 'openai'] as const) {
    // Discovery uses the credential a real run would use. STRATUS_API_KEY
    // and a configured apiKeyEnv authenticate the DEFAULT provider only —
    // a secondary provider relies on its own env var or stored sign-in,
    // never the default provider's secret.
    const envKey = (provider === selection.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY)
        ?? (selection.apiKeyEnv ? readNonEmptyString(processEnv[selection.apiKeyEnv]) : undefined)
      : undefined)
      ?? readNonEmptyString(processEnv[defaultApiKeyEnvName(provider)]);
    const credential = envKey ? undefined : selection.credentials[provider];
    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    if (!apiKey && !credential) {
      continue;
    }

    if (provider === 'anthropic') {
      if (!apiKey || typeof fetchImpl !== 'function') {
        // Subscription tokens cannot call the models endpoint.
        models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
        continue;
      }
      // The same endpoint a real run uses: the stored key's bound URL is
      // authoritative, then a configured anthropic base URL (a proxy) —
      // never the official endpoint by accident.
      const anthropicRoot = ((credential?.type === 'api_key' ? credential.baseUrl : undefined)
        ?? (selection.provider === 'anthropic' ? selection.baseUrl : undefined)
        ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
      try {
        const response = await fetchImpl(`${anthropicRoot}/v1/models?limit=100`, {
          headers: { 'x-api-key': String(apiKey), 'anthropic-version': '2023-06-01' },
        });
        // An explicit auth failure is the one answer that condemns the key —
        // the same rule `verifyProviderKey` applies. Falling back here would
        // offer a menu of Claude models to a revoked or mistyped key, every
        // one of which fails the moment it is used. Any other unhappy status
        // says the listing endpoint is unavailable, not that the key is bad,
        // so the known lineup still stands in for it.
        if (response.status === 401 || response.status === 403) {
          continue;
        }
        const payload = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
        models.push(...(ids.length > 0 ? ids : KNOWN_CLAUDE_MODELS).map((id) => ({ provider, id })));
      } catch {
        models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
      }
      continue;
    }

    if (!apiKey || typeof fetchImpl !== 'function') {
      continue;
    }
    try {
      // A stored key's bound endpoint is authoritative, exactly as at run
      // time; only env-supplied keys follow the default provider's URL.
      const root = ((credential?.type === 'api_key' ? credential.baseUrl : undefined)
        ?? (selection.provider === 'openai' ? selection.baseUrl : undefined)
        ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
      const response = await fetchImpl(`${root}/models`, {
        headers: { authorization: `Bearer ${String(apiKey)}` },
      });
      // Same rule on this side: a rejected key offers nothing.
      if (response.status === 401 || response.status === 403) {
        continue;
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      const allIds = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');
      // Runs always call /chat/completions, so embedding, audio, image,
      // moderation, and legacy completion models would save a default
      // that cannot execute. If filtering leaves nothing (an exotic local
      // service), show everything rather than an empty menu.
      const chatIds = allIds.filter((id) => !NON_CHAT_MODEL_PATTERN.test(id));
      const ids = (chatIds.length > 0 ? chatIds : allIds).sort((a, b) => {
        const rank = (id: string): number => (/^gpt/i.test(id) ? 0 : /^o\d/i.test(id) ? 1 : 2);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      models.push(...ids.map((id) => ({ provider, id })));
    } catch {
      // No reachable model list for this provider; skip it.
    }
  }

  return models;
};

// ---------------------------------------------------------------------------
// Creating a soul under an id nothing else holds
// ---------------------------------------------------------------------------

/**
 * The ids a newly created soul must not claim: every id the served roster
 * holds, which is three things and not one directory.
 *
 * - **What the roster files declare.** A filename is not an id: a soul at
 *   `renamed.md` may declare `id: ava`, so `ava.md` being free proves
 *   nothing — and since a duplicate refuses the whole roster, writing one
 *   would hand back an agent whose daemon cannot start.
 * - **The configured default soul**, which the daemon registers whether or
 *   not its file lives in the agents directory. It wins a same-id contest
 *   with a roster file — `defaultAgentId` replaces the source when the
 *   path differs — so a new agent sharing its id is not refused, it is
 *   shadowed: created, then undispatchable by id or from Slack, with
 *   nothing saying so.
 * - **The reserved `stratus`**, since a roster soul claiming it is skipped
 *   at load, so writing one creates an agent that silently never appears.
 *
 * The two readable sources fail **independently**, and what they return is
 * what they know rather than all-or-nothing. A configured soul that is
 * missing or mid-edit does not stop the daemon serving the roster, so it
 * must not discard the roster's claims either: collapsing both to unknown
 * would let a caller write the very duplicate that refuses the roster it
 * could have read. `unread` names what could not be answered, so the
 * caller can say which check did not run instead of implying none did.
 */
export const declaredAgentIds = async (
  env: StateEnvironment,
  configPath?: string,
): Promise<{ ids: Set<string>; unread: string[] }> => {
  const [roster, configured] = await Promise.allSettled([
    loadRosterSouls(env, () => {}),
    // The soul a run started here would resolve, by the same precedence the
    // daemon uses — never a second reading of it. Pinned when the caller has
    // a pinned config: a daemon on `--config custom.json` may name a default
    // soul the working directory's config does not, and an id claimed without
    // seeing it is claimed against the wrong set. The write then succeeds and
    // the roster reload hands that id to the configured soul instead, so the
    // agent just created is reported 201 and never served.
    resolveConfiguredSoul(configPath ? { configPath } : {}, env),
  ]);

  const ids = new Set([DEFAULT_STRATUS_AGENT.id]);
  const unread: string[] = [];
  if (roster.status === 'fulfilled') {
    for (const entry of roster.value) {
      ids.add(entry.soul.agent.id);
    }
  } else {
    unread.push('the roster');
  }
  if (configured.status === 'fulfilled') {
    if (configured.value) {
      ids.add(configured.value.soul.agent.id);
    }
  } else {
    unread.push('the configured default soul');
  }
  return { ids, unread };
};

/**
 * Write a new soul under an id nothing else holds, and return the agent
 * that got written.
 *
 * The name stays theirs, but the id — the soul filename, the memory key,
 * the credential scope — must be unique: the suggestion pool is small, so
 * a repeat name would otherwise share an earlier agent's memory. Two
 * claims have to fail here, and only one of them is a filename:
 *
 * - An id another soul declares, whatever that soul is called on disk.
 *   Since a duplicate refuses the whole roster, writing one would leave a
 *   daemon that will not start — created by the command meant to help.
 * - The path itself, via `wx`, which makes the claim atomic against a
 *   concurrent writer that the roster read above cannot see.
 *
 * On either, the id takes a fresh suffix and we try again — through the
 * shared bound, since appending a suffix to a maxed-out base would build
 * an id the validator refuses, turning a collision into a crash.
 */
export const claimSoulFile = async (
  env: StateEnvironment,
  input: { name?: string; instructions: string },
  render: (agent: AgentDefinition) => string,
  note: (message: string) => void,
  configPath?: string,
): Promise<{ agent: AgentDefinition; soulPath: string }> => {
  const { ids: taken, unread } = await declaredAgentIds(env, configPath);
  if (unread.length > 0) {
    note(`Note: could not read ${unread.join(' or ')}, so this id was not checked against the ids it declares.`);
  }
  await mkdir(agentsDirPath(env), { recursive: true });
  let agent = defineAgent({ ...(input.name ? { name: input.name } : {}), instructions: input.instructions });
  const baseId = agent.id;
  for (;;) {
    const soulPath = path.join(agentsDirPath(env), `${agent.id}.md`);
    if (!taken.has(agent.id)) {
      try {
        await writeFile(soulPath, render(agent), { flag: 'wx' });
        return { agent, soulPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    agent = defineAgent({
      id: agentIdWithSuffix(baseId, randomUUID().slice(0, 4)),
      ...(input.name ? { name: input.name } : { name: agent.name }),
      instructions: input.instructions,
    });
  }
};

// ---------------------------------------------------------------------------
// The roster as data
// ---------------------------------------------------------------------------

/** The first non-empty line of a persona, trimmed to fit one terminal row. */
export const personaSnippet = (instructions: string | undefined): string | undefined => {
  const firstLine = instructions?.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > 78 ? `${firstLine.slice(0, 77)}…` : firstLine;
};

/** One agent as `stratus agents` and `GET /api/v1/agents` both describe it. */
export interface AgentSummary {
  id: string;
  name: string;
  /** The agent an agentId-less run or dispatch answers as. */
  default: boolean;
  /** The built-in Stratus persona, which has no soul file. */
  builtIn: boolean;
  soulPath?: string;
  /** The soul's own frontmatter pin, verbatim. Absent when it pins nothing. */
  provider?: string;
  model?: string;
  /** What a run as this agent resolves to right now. */
  runsOn: { provider: string; model?: string };
  memories: number;
  persona?: string;
  /**
   * The deterministic palette the kernel computed for this agent. Carried
   * structurally rather than as prose so every surface — a terminal line, a
   * web avatar, a macOS view — renders it its own way from one source.
   */
  avatar?: AvatarTheme;
}

/**
 * The whole roster, resolved: who the agents are, where their souls live,
 * what each would run on right now, and what each remembers.
 *
 * Reads the agents directory directly rather than through `loadRosterSouls`,
 * and the difference is deliberate: listing must survive a roster the daemon
 * would refuse. A duplicate id or an unparseable file degrades to a warning
 * and one missing row, because a person running this is usually running it
 * *because* something is wrong.
 */
export const listAgentSummaries = async (
  env: StateEnvironment,
  warn: (message: string) => void = () => {},
  /** The config the caller is pinned to; see `discoverActiveConfig`. */
  configPath?: string,
): Promise<AgentSummary[]> => {
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(env)));
  const processEnv = readProcessEnv(env);
  // Listing must never be blocked by a broken config — it only feeds the
  // default marker and the "runs on" lines.
  const { config: activeConfig, location: activeConfigLocation } = await discoverActiveConfig(env, warn, configPath);

  const pinContext: SoulPinContext = {
    ...(activeConfig.provider !== undefined ? { configProvider: activeConfig.provider } : {}),
    // Whether a file was actually found, not whether one was asked for: a
    // config with no provider key predates the anthropic option and names
    // openai as the default, while no config at all names nothing — and the
    // difference decides whether a soul's pin demotes anything.
    configPresent: activeConfigLocation !== undefined,
  };

  /**
   * What a run as this soul would actually use right now.
   *
   * The soul's pins are normalized through `applySoulPins` first — the same
   * call dispatch makes — rather than by ranking the environment above them
   * here. That ordering was wrong in exactly the case the pins exist for: a
   * daemon started with `STRATUS_PROVIDER=openai` serving a soul pinned to
   * anthropic dispatches anthropic, because the pin demotes the daemon-wide
   * default, while a listing that read the raw environment reported openai.
   * Two surfaces disagreeing about which provider is being billed.
   *
   * What is left afterwards still follows `resolveRuntimeConfig`'s precedence
   * — env, soul, config, demo — because a listing must answer even when no
   * credential resolves, which is precisely when someone is looking at it.
   */
  const runsOnFor = (soul?: ParsedSoul): { provider: string; model?: string } => {
    const normalized = soul
      ? applySoulPins(soul, {}, env, pinContext).env
      : env;
    const soulEnv = readProcessEnv(normalized);
    const envProvider = readNonEmptyString(soulEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'));
    const envModel = readNonEmptyString(soulEnv.STRATUS_MODEL);

    const soulProvider = soul?.provider;
    const soulModel = soul?.model;
    const provider = envProvider ?? soulProvider ?? activeConfig.provider ?? 'demo';
    if (provider === 'demo') {
      return { provider };
    }
    const soulModelApplies = soulProvider === undefined || soulProvider === provider;
    const configModelApplies = (activeConfig.provider ?? 'openai') === provider;
    const model = envModel
      ?? (soulModelApplies ? soulModel : undefined)
      ?? (configModelApplies ? activeConfig.model : undefined)
      ?? (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL);
    return { provider, model };
  };

  const defaultSoulPath = readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? activeConfig.soul;
  const resolvedDefaultSoul = defaultSoulPath
    ? path.resolve(readWorkingDirectory(env), defaultSoulPath)
    : undefined;

  const summaries: AgentSummary[] = [];

  const addSoul = async (soulPath: string): Promise<void> => {
    let parsed: ParsedSoul;
    try {
      parsed = parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath });
    } catch (error) {
      warn(`skipping ${soulPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const { agent } = parsed;
    const persona = personaSnippet(agent.instructions);
    summaries.push({
      id: agent.id,
      name: agent.name,
      default: soulPath === resolvedDefaultSoul,
      builtIn: false,
      soulPath,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      runsOn: runsOnFor(parsed),
      memories: (await memory.list(agent.id)).length,
      ...(persona ? { persona } : {}),
      ...(agent.avatar ? { avatar: agent.avatar } : {}),
    });
  };

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
  for (const soulPath of rosterFiles) {
    await addSoul(soulPath);
  }
  // A default soul can live outside ~/.stratus/agents (a project soul, a
  // hand-written file) — the roster would be lying without it.
  if (resolvedDefaultSoul && !rosterFiles.includes(resolvedDefaultSoul)) {
    await addSoul(resolvedDefaultSoul);
  }

  // The built-in Stratus persona serves every run that has no soul.
  const builtInPersona = personaSnippet(DEFAULT_STRATUS_AGENT.instructions);
  summaries.push({
    id: DEFAULT_STRATUS_AGENT.id,
    name: DEFAULT_STRATUS_AGENT.name,
    default: resolvedDefaultSoul === undefined,
    builtIn: true,
    runsOn: runsOnFor(),
    memories: (await memory.list(DEFAULT_STRATUS_AGENT.id)).length,
    ...(builtInPersona ? { persona: builtInPersona } : {}),
  });

  summaries.sort((a, b) => {
    if (a.default !== b.default) {
      return a.default ? -1 : 1;
    }
    if (a.builtIn !== b.builtIn) {
      return a.builtIn ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  return summaries;
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
