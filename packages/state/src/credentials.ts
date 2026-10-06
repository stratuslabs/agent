import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidAgentId } from '@stratusagent/agents';
import {
  type ChannelTransportSecrets,
  type CredentialResolver,
  assertCredentialAllowed,
} from '@stratusagent/core';
import { type StateEnvironment, readProcessEnv } from './environment.ts';
import { credentialsPath } from './paths.ts';
import { quoteShellArg } from './shell.ts';
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
// still lose one another's update, which is why the daemon's writers
// serialize through `withCredentialsFileLock`. Atomicity is about what a
// *reader* can observe.
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

/**
 * The shape a channel kind takes: a plugin manifest's contribution name,
 * lowercase with hyphens. The rule every surface that stores channel
 * secrets checks a kind against — the control API's route and `stratus
 * channel` — so a kind one accepts the other cannot refuse.
 */
export const CHANNEL_KIND_PATTERN = REGISTERED_PROVIDER_NAME_PATTERN;

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
  if (!CHANNEL_KIND_PATTERN.test(kind)) {
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
 * Drop one agent's transport secrets for a channel kind, and the kind's
 * entry with them when it was the last. Resolves whether there was
 * anything to remove, so a caller can say so rather than report success
 * for a binding that never existed.
 */
export const removeChannelTransportSecrets = async (
  env: StateEnvironment,
  kind: string,
  agentId: string,
): Promise<boolean> => {
  const existing = await loadRawCredentialsFile(env);
  if (!isPlainRecord(existing.channels) || !isPlainRecord(existing.channels[kind])
    || !Object.hasOwn(existing.channels[kind], agentId)) {
    return false;
  }
  const channels = { ...existing.channels };
  const byAgent = { ...(existing.channels[kind] as Record<string, unknown>) };
  delete byAgent[agentId];
  if (Object.keys(byAgent).length > 0) {
    channels[kind] = byAgent;
  } else {
    delete channels[kind];
  }
  existing.channels = channels;
  await writeRawCredentialsFile(env, existing);
  return true;
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
 * What a credential name may be: the two conventions in use, and nothing
 * that would be awkward in a soul's `credentials:` list — `search.apiKey`
 * and environment-style `SLACK_TOKEN`. Leading letter required, which also
 * happens to exclude `__proto__`; the store does not *rely* on that (it
 * keys prototype-free maps), because a credentials file can be written by
 * something other than this package.
 *
 * Here rather than in the CLI's parser, which re-exports it, because the
 * control API validates the same names now.
 */
export const CREDENTIAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

/**
 * Serializes every read-modify-write of the credentials file within one
 * process.
 *
 * A promise chain rather than a lock file: this guards one daemon's own
 * concurrent writers, which is the race a daemon reachable from several
 * surfaces at once introduces. It moved here from the control API when a
 * second writer inside the daemon needed the same chain; two chains over
 * one file would each serialize only half the writes. Two processes
 * sharing a home — the CLI writing while a daemon runs — are not covered,
 * and would need a different mechanism than this one.
 */
let credentialsFileWrites: Promise<unknown> = Promise.resolve();
export const withCredentialsFileLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const next = credentialsFileWrites.then(work, work);
  // Swallowed for the chain only: the caller still sees the rejection, but a
  // failed write must not poison every write after it.
  credentialsFileWrites = next.catch(() => undefined);
  return next;
};

/**
 * A named credential that is already stored where an add would put it.
 *
 * Typed so a caller can answer it as a conflict rather than a failure: the
 * surfaces that add credentials away from the machine may only add, and
 * replacing one is `stratus credential set` on the machine itself.
 */
export class NamedCredentialExistsError extends Error {
  readonly credentialName: string;
  readonly agentId: string | undefined;

  constructor(credentialName: string, agentId: string | undefined, message: string) {
    super(message);
    this.name = 'NamedCredentialExistsError';
    this.credentialName = credentialName;
    this.agentId = agentId;
  }
}

/**
 * Store a named credential that does not exist yet, for one agent or the
 * whole fleet, and refuse anything that would replace one.
 *
 * Add-only on purpose. It is the write path for surfaces reachable from
 * away from the machine, a Slack form or a browser, where the person
 * submitting is further from the operator than someone at the shell.
 * Replacing a shared key would move every agent that uses it onto whatever
 * account the new value belongs to, so replacing and removing stay with
 * `stratus credential set` and `remove`.
 *
 * An agent's own entry is refused over a shared one of the same name too:
 * the agent's entry is consulted first, so adding it would replace the key
 * that agent's calls use, which is an overwrite whatever the file says.
 *
 * The check and the write share one lock, so two adds of one name racing
 * inside the daemon cannot both find it absent.
 */
export const addNamedCredential = async (
  env: StateEnvironment,
  entry: { name: string; value: string; agentId?: string },
): Promise<void> => {
  const { name, value, agentId } = entry;
  if (!CREDENTIAL_NAME_PATTERN.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a credential name. Use letters, digits, dots, dashes, or underscores, `
      + 'starting with a letter: search.apiKey, or an environment-style SLACK_TOKEN.',
    );
  }
  if (agentId !== undefined && !isValidAgentId(agentId)) {
    throw new Error(`${JSON.stringify(agentId)} cannot be an agent id, so a credential stored under it could never be resolved.`);
  }
  if (value.trim().length === 0) {
    throw new Error(`The value for ${name} is empty, so nothing was stored.`);
  }
  await withCredentialsFileLock(async () => {
    const named = await loadNamedCredentials(env);
    const replace = agentId === undefined
      ? `printf %s "$KEY" | stratus credential set ${name}`
      : `printf %s "$KEY" | stratus credential set ${name} --agent ${quoteShellArg(agentId)}`;
    if (named.shared[name] !== undefined) {
      throw new NamedCredentialExistsError(
        name,
        agentId,
        agentId === undefined
          ? `A shared credential named ${name} is already stored. Replacing one is done on the machine: ${replace}.`
          : `A shared credential named ${name} is already stored, and ${agentId}'s own would replace it for ${agentId}. `
            + `Replacing one is done on the machine: ${replace}.`,
      );
    }
    // The environment is read last but still counts: any stored entry
    // outranks it, so adding one where the daemon's environment supplies
    // the name would replace the key every agent resolves, which is the
    // one thing this path may not do.
    if (typeof readProcessEnv(env)[name] === 'string') {
      throw new NamedCredentialExistsError(
        name,
        agentId,
        `${name} is supplied by the daemon's environment, and a stored one would replace it`
        + `${agentId === undefined ? '' : ` for ${agentId}`}. Change it where the environment is set, `
        + `or on the machine: ${replace}.`,
      );
    }
    if (agentId !== undefined && named.agents[agentId]?.[name] !== undefined) {
      throw new NamedCredentialExistsError(
        name,
        agentId,
        `${agentId} already has its own credential named ${name}. Replacing one is done on the machine: ${replace}.`,
      );
    }
    if (agentId === undefined) {
      named.shared[name] = value;
    } else {
      const own = named.agents[agentId] ?? Object.create(null) as Record<string, string>;
      own[name] = value;
      named.agents[agentId] = own;
    }
    await saveNamedCredentials(env, named);
  });
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
/** Where a named credential an agent would resolve comes from. */
export type NamedCredentialSource = 'agent' | 'shared' | 'environment';

/**
 * The resolution order, once: the agent's own entry, then the fleet's
 * shared one, then the environment. The resolver reads the value through
 * it and `namedCredentialSource` the answer to "does this agent already
 * have one", so the two cannot disagree about what counts.
 */
const lookupNamedCredential = (
  named: NamedCredentials,
  processEnv: Record<string, string | undefined>,
  agentId: string,
  name: string,
): { value: string; source: NamedCredentialSource } | undefined => {
  const own = named.agents[agentId]?.[name];
  if (own !== undefined) {
    return { value: own, source: 'agent' };
  }
  const shared = named.shared[name];
  if (shared !== undefined) {
    return { value: shared, source: 'shared' };
  }
  // `process.env` is somebody else's object and does have a prototype, so
  // this is the one lookup that could still answer with a function. A
  // resolver promises a string or nothing.
  const fromEnv = processEnv[name];
  return typeof fromEnv === 'string' ? { value: fromEnv, source: 'environment' } : undefined;
};

/**
 * Where `agentId` would resolve `name` from, or undefined when nothing
 * supplies it. Presence only; the allowlist is the resolver's question.
 */
export const namedCredentialSource = async (
  env: StateEnvironment,
  agentId: string,
  name: string,
): Promise<NamedCredentialSource | undefined> =>
  lookupNamedCredential(await loadNamedCredentials(env), readProcessEnv(env), agentId, name)?.source;

export const createFileCredentialResolver = (
  env: StateEnvironment,
  processEnv: Record<string, string | undefined> = readProcessEnv(env),
): CredentialResolver => ({
  async resolve(agent, name) {
    assertCredentialAllowed(agent, name);
    return lookupNamedCredential(await loadNamedCredentials(env), processEnv, agent.id, name)?.value;
  },
});
