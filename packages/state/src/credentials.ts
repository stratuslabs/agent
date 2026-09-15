import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ChannelTransportSecrets,
  type CredentialResolver,
  assertCredentialAllowed,
} from '@stratusagent/core';
import { type StateEnvironment, readProcessEnv } from './environment.ts';
import { credentialsPath } from './paths.ts';
import {
  REGISTERED_PROVIDER_NAME_PATTERN,
  CREDENTIAL_PROVIDER_NAMES,
  type CredentialProviderName,
} from './provider-names.ts';

/**
 * A stored sign-in for a provider, kept in ~/.stratus/credentials.json.
 *
 * An `oauth_token` means subscription billing, and what the value holds
 * differs by provider: for anthropic it is a real Claude Code setup token,
 * sent into the harness on every run. For codex it is only a marker that
 * this machine uses its own `codex login` (ChatGPT) sign-in — the actual
 * tokens live in codex's auth store under ~/.codex, and the stored value
 * is never read or sent anywhere.
 */
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

export type CredentialsFile = Partial<Record<CredentialProviderName, StoredCredential>>;

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
  for (const provider of CREDENTIAL_PROVIDER_NAMES) {
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

// Written beside the destination and renamed over it, never truncated and
// rewritten in place.
//
// `writeFile` opens with O_TRUNC, so between the truncate and the write the
// file on disk is empty — and this file now has a *concurrent reader*, since
// a named credential is resolved per tool call so that a rotated key needs
// no restart. In place, a rotation makes every search in that window fail
// with "Unexpected end of JSON input"; measured, that was 62 failures in
// 983 reads. A rename is atomic, so a reader sees the old document or the
// new one and never half of either — and a crash mid-write leaves the old
// credentials rather than none.
//
// What this does not buy: two processes each doing a read-modify-write can
// still lose one another's update, which is why the control API serializes
// its own writes. Atomicity is about what a *reader* can observe.
const writeRawCredentialsFile = async (env: StateEnvironment, contents: Record<string, unknown>): Promise<void> => {
  const filePath = credentialsPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  // Unique per write, so two writers never share a temporary file.
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    // Before the rename rather than after: the destination must never exist
    // at a looser mode, even briefly. `writeFile`'s mode applies only when
    // it creates the file, so the explicit chmod stays.
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    // A failed write must not leave a file holding credentials behind.
    await rm(temporary, { force: true });
    throw error;
  }
};

// Credentials never live in a project directory or a shell profile — they
// are written once by `stratus setup` and read on every run, 0600 so only
// the owner can read them. Provider entries merge over the existing file,
// so channel tokens (and anything else stored alongside) survive a
// re-run of setup.
export const saveCredentials = async (env: StateEnvironment, credentials: CredentialsFile): Promise<void> => {
  const existing = await loadRawCredentialsFile(env);
  for (const provider of CREDENTIAL_PROVIDER_NAMES) {
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
  // Authoritative for the kinds it describes, and only those: the file
  // also holds `channels.<kind>.<agentId>` for every channel a plugin
  // contributes, and a Slack save that replaced the whole namespace would
  // erase a Discord bot's tokens on the next `stratus setup`.
  const current = isPlainRecord(existing.channels) ? { ...existing.channels } : {};
  if (channels.slack !== undefined) {
    current.slack = channels.slack;
  } else {
    delete current.slack;
  }
  existing.channels = current;
  await writeRawCredentialsFile(env, existing);
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The host-owned path a contributed channel receives its transport
 * secrets through: everything under `channels.<kind>.<agentId>`, by agent,
 * string-valued entries only. The same namespace Slack's tokens live in,
 * read generically — and, like them, never through the agent-scoped
 * resolver: an agent must not read the tokens of the transport carrying
 * it. Re-read per call, like the named credentials, so a token stored
 * while the daemon runs is there at the next start without an edit.
 */
export const loadChannelTransportSecrets = async (
  env: StateEnvironment,
  kind: string,
): Promise<ChannelTransportSecrets> => {
  const raw = await loadRawCredentialsFile(env);
  const secrets: ChannelTransportSecrets = {};
  if (!isPlainRecord(raw.channels) || !isPlainRecord(raw.channels[kind])) {
    return secrets;
  }
  for (const [agentId, entry] of Object.entries(raw.channels[kind])) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry)) {
      if (typeof value === 'string') {
        values[name] = value;
      }
    }
    secrets[agentId] = values;
  }
  return secrets;
};

/** Every channel kind with something stored under `channels.<kind>`, Slack included. */
export const listChannelKinds = async (env: StateEnvironment): Promise<string[]> => {
  const raw = await loadRawCredentialsFile(env);
  return isPlainRecord(raw.channels) ? Object.keys(raw.channels) : [];
};

/**
 * Store one agent's transport secrets for a channel kind, merging over the
 * rest of the namespace. The write side of `loadChannelTransportSecrets`;
 * the control API's channel-credentials route is its caller.
 */
export const saveChannelTransportSecrets = async (
  env: StateEnvironment,
  kind: string,
  agentId: string,
  secrets: Record<string, string>,
): Promise<void> => {
  // The kind is a contribution name and the agent id a real one; keys
  // that are neither (`__proto__` among them) never reach the object below.
  if (!REGISTERED_PROVIDER_NAME_PATTERN.test(kind)) {
    throw new Error(`${JSON.stringify(kind)} is not a channel kind. Use the kind a channel plugin declares (lowercase, hyphens).`);
  }
  if (agentId.length === 0 || agentId === '__proto__') {
    throw new Error(`${JSON.stringify(agentId)} is not an agent id.`);
  }
  const existing = await loadRawCredentialsFile(env);
  const channels = isPlainRecord(existing.channels) ? { ...existing.channels } : {};
  const byAgent = isPlainRecord(channels[kind]) ? { ...channels[kind] } : {};
  byAgent[agentId] = secrets;
  channels[kind] = byAgent;
  existing.channels = channels;
  await writeRawCredentialsFile(env, existing);
};

/**
 * Credentials an agent resolves by name — the `search.apiKey` a search
 * backend asks for, and whatever the ecosystem asks for next.
 *
 * A separate namespace from the provider sign-ins above, because these are
 * a different kind of thing: a sign-in is the daemon's own, selected by
 * config resolution and bound to an endpoint, while a named credential is
 * an *agent capability* gated by that agent's `credentials:` allowlist.
 *
 * `shared` is the fleet's; `agents` holds one map per agent, consulted
 * first. That ordering is what lets two agents search the one installed
 * backend on their own accounts. The `agents` key can never collide with a
 * credential name because the two live at different depths.
 *
 * Channel tokens stay out of this path. They are gateway infrastructure
 * secrets living under `channels.slack.<agentId>` precisely so an agent
 * cannot read the tokens of the transport carrying it, and a named
 * namespace next door must not become a way in.
 */
export interface NamedCredentials {
  /** Fleet-wide, by credential name. */
  shared: Record<string, string>;
  /** Per agent, by agent id then credential name. Consulted before `shared`. */
  agents: Record<string, Record<string, string>>;
}

/**
 * A map keyed by names that come from outside, with no prototype behind it.
 *
 * Credential names and agent ids are user-controlled keys, and on an
 * ordinary object that makes two things go wrong at once: writing
 * `__proto__` assigns through the inherited setter instead of creating an
 * entry (so a store reports success and `JSON.stringify` drops the key),
 * and reading `toString` returns a **function** off `Object.prototype`
 * rather than the `string | undefined` this resolver promises. A
 * null-prototype map has neither hazard, whatever ends up in the file — and
 * that matters more than any name rule a writer applies, because the file
 * can be hand-edited and the next writer of it may not be this CLI.
 */
const emptyNameMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const readNameMap = (value: unknown): Record<string, string> => {
  const entries = emptyNameMap<string>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries;
  }
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      entries[name] = entry;
    }
  }
  return entries;
};

export const loadNamedCredentials = async (env: StateEnvironment): Promise<NamedCredentials> => {
  const raw = await loadRawCredentialsFile(env);
  const named = raw.named;
  if (typeof named !== 'object' || named === null || Array.isArray(named)) {
    return { shared: emptyNameMap<string>(), agents: emptyNameMap<Record<string, string>>() };
  }
  const block = named as Record<string, unknown>;
  const agents = emptyNameMap<Record<string, string>>();
  if (typeof block.agents === 'object' && block.agents !== null && !Array.isArray(block.agents)) {
    for (const [agentId, entry] of Object.entries(block.agents as Record<string, unknown>)) {
      const names = readNameMap(entry);
      if (Object.keys(names).length > 0) {
        agents[agentId] = names;
      }
    }
  }
  return { shared: readNameMap(block.shared), agents };
};

export const saveNamedCredentials = async (
  env: StateEnvironment,
  named: NamedCredentials,
): Promise<void> => {
  const existing = await loadRawCredentialsFile(env);
  existing.named = { shared: named.shared, agents: named.agents };
  await writeRawCredentialsFile(env, existing);
};

/**
 * The resolver a daemon actually installs: the credentials file first, the
 * environment behind it.
 *
 * It keeps `EnvCredentialResolver`'s allowlist check exactly — through the
 * kernel's own `assertCredentialAllowed`, so there is one implementation of
 * what an agent's `credentials:` list means — and falls back to the
 * environment so setups that export a name today keep working.
 *
 * The file is read **per resolve** rather than captured at construction.
 * That is deliberate on both counts: a key rotated at three in the morning
 * takes effect on the next call instead of the next restart, and the read
 * is one small file per tool call that wanted a credential, which is not a
 * hot path. Per-agent keys are a lookup order rather than an interface
 * change, because `CredentialResolver.resolve` already takes the agent.
 */
export const createFileCredentialResolver = (
  env: StateEnvironment,
  processEnv: Record<string, string | undefined> = readProcessEnv(env),
): CredentialResolver => ({
  async resolve(agent, name) {
    assertCredentialAllowed(agent, name);
    const named = await loadNamedCredentials(env);
    const value = named.agents[agent.id]?.[name] ?? named.shared[name] ?? processEnv[name];
    // `process.env` is somebody else's object and does have a prototype, so
    // this is the one lookup above that could still answer with a function.
    // A resolver promises a string or nothing.
    return typeof value === 'string' ? value : undefined;
  },
});
