import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { lookup as lookupHost } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import {
  BUILTIN_EXECUTOR_NAME,
  BUILTIN_MEMORY_STORE_NAME,
  isLanguageTag,
  type JsonObject,
} from '@stratusagent/core';
import {
  type AgentApprovalConfig,
  MAX_APPROVAL_TIMEOUT_MS,
  type ApprovalsConfig,
  type AgentPrincipalsConfig,
  type AgentSlackConfig,
  type PrincipalsConfig,
  type SlackConfig,
  type ApiConfig,
  type EventsConfig,
  type EventSourceConfig,
  type PluginConfigBlock,
  type PluginsConfig,
  type StratusConfigFile,
} from './config.ts';
import { normalizeTrustedDomain, trustedDomainProblem } from '@stratusagent/permissions';

import { REGISTERED_PROVIDER_NAME_PATTERN, parseProviderName } from './provider-names.ts';
import { CREDENTIAL_NAME_PATTERN } from './credentials.ts';

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
  if (config.maxTokens !== undefined) {
    // Refused rather than clamped, like every other bound here: the API
    // rejects a request whose cap is not a positive integer, so a bad value
    // does not degrade, it fails every turn before generating.
    if (
      typeof config.maxTokens !== 'number'
      || !Number.isInteger(config.maxTokens)
      || config.maxTokens < 1
    ) {
      throw new Error(
        `Invalid maxTokens in config ${configPath}: ${JSON.stringify(config.maxTokens)}. `
        + 'Use a whole number of output tokens, 1 or more.',
      );
    }
    resolved.maxTokens = config.maxTokens;
  }
  // `false` is the whole point of this key too.
  if (typeof config.vision === 'boolean') {
    resolved.vision = config.vision;
  }
  if (config.language !== undefined) {
    // Refused rather than ignored: a typo would otherwise leave every agent
    // on the default while the file says otherwise, and the tag is
    // interpolated into every prompt, so it may only be a tag.
    if (!isLanguageTag(config.language)) {
      throw new Error(
        `Invalid language in config ${configPath}: ${JSON.stringify(config.language)}. Use a language tag like en-US or en-GB.`,
      );
    }
    resolved.language = config.language;
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
  if (config.agentMaxTurns !== undefined) {
    // Refused, not dropped, for the reason `maxTurns` is: an operator who
    // raised one agent's budget and silently got the default would find out
    // as that agent stopping short with nothing in the config to explain it.
    const budgets = config.agentMaxTurns as unknown;
    if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) {
      throw new Error(
        `Invalid agentMaxTurns in config ${configPath}: expected agent ids mapped to step budgets, like { "atlas": 300 }.`,
      );
    }
    for (const [agentId, turns] of Object.entries(budgets as Record<string, unknown>)) {
      if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1) {
        throw new Error(
          `Invalid agentMaxTurns.${agentId} in config ${configPath}: ${JSON.stringify(turns)}. Use a whole number of provider turns, 1 or more.`,
        );
      }
    }
    resolved.agentMaxTurns = { ...(budgets as Record<string, number>) };
  }
  if (config.autoContinue !== undefined) {
    // Refused, not dropped, for the reason `agentMaxTurns` is.
    const entries = config.autoContinue as unknown;
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      throw new Error(
        `Invalid autoContinue in config ${configPath}: expected agent ids mapped to true or a cap, like { "nova": true }.`,
      );
    }
    for (const [agentId, setting] of Object.entries(entries as Record<string, unknown>)) {
      if (setting !== true && (typeof setting !== 'number' || !Number.isInteger(setting) || setting < 1)) {
        throw new Error(
          `Invalid autoContinue.${agentId} in config ${configPath}: ${JSON.stringify(setting)}. Use true for no cap, or a whole number of extra allowances, 1 or more.`,
        );
      }
    }
    resolved.autoContinue = { ...(entries as Record<string, true | number>) };
  }
  const approvals = parseApprovalsConfig(config.approvals, configPath);
  if (approvals) {
    resolved.approvals = approvals;
  }
  const principals = parsePrincipalsConfig(config.principals, configPath);
  if (principals) {
    resolved.principals = principals;
  }
  const slack = parseSlackConfig(config.slack, configPath);
  if (slack) {
    resolved.slack = slack;
  }
  const api = parseApiConfig(config.api, configPath);
  if (api) {
    resolved.api = api;
  }
  const events = parseEventsConfig(config.events, configPath);
  if (events) {
    resolved.events = events;
  }
  const plugins = parsePluginsConfig(config.plugins, configPath);
  if (plugins) {
    resolved.plugins = plugins;
  }

  return resolved;
};

/** A top-level config key that loading leaves unused. */
export type IgnoredConfigKey =
  | { key: string; reason: 'unknown' }
  | { key: string; reason: 'dropped'; valueType: 'object' | 'array' | 'number' | 'string' | 'empty string' | 'boolean' | 'null' };

/**
 * The top-level keys of a config that loads but leaves them unused: a key
 * the loader never reads (a typo, or a key from another version), and a key
 * it reads but drops because of its value's type, the way `provider` is
 * dropped when it is an object rather than a name.
 *
 * Both are worked out by running `validateConfigFile` itself and watching
 * which keys it reads and which it keeps, so there is no second list of keys
 * to fall out of step when the loader learns a new one. Loading does not
 * change: these are for doctor to name, not errors, because refusing them
 * would stop a daemon whose config runs today over a key that does nothing.
 *
 * A config that does not load reports nothing here. Its load error already
 * says what is wrong, and the keys after the failing one were never read.
 */
export const ignoredConfigKeys = (parsed: unknown, label: string): IgnoredConfigKey[] => {
  if (!isPlainObject(parsed)) {
    return [];
  }
  const read = new Set<string | symbol>();
  const watched = new Proxy(parsed, {
    get: (target, key, receiver) => {
      read.add(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  let resolved: StratusConfigFile;
  try {
    resolved = validateConfigFile(watched, label);
  } catch {
    return [];
  }
  const ignored: IgnoredConfigKey[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!read.has(key)) {
      ignored.push({ key, reason: 'unknown' });
    } else if (!Object.hasOwn(resolved, key)) {
      ignored.push({ key, reason: 'dropped', valueType: jsonTypeOf(value) });
    }
  }
  return ignored;
};

const jsonTypeOf = (value: unknown): Extract<IgnoredConfigKey, { reason: 'dropped' }>['valueType'] => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === '') {
    return 'empty string';
  }
  const type = typeof value;
  return type === 'number' || type === 'string' || type === 'boolean' ? type : 'object';
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

/**
 * `api.publicUrl` as credential links are built on it, or a plain Error
 * saying what is wrong with it. The one rule for that address: the config
 * loader applies it, and so does `createControlApi` for a host passing the
 * option directly, since either way every link is handed to an agent.
 *
 * No message repeats the value: it may carry a proxy sign-in, and these
 * messages reach the daemon's log.
 */
export const normalizePublicUrl = (value: unknown): string => {
  const parsed = typeof value === 'string' ? URL.parse(value.trim()) : null;
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new Error('use the http(s) address this daemon is reached on from elsewhere, like https://mac-mini.example.ts.net.');
  }
  // Every link is built on this and handed to the agent, so a password in
  // it would reach the model and the conversation.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('it carries a username or password, and every credential link is built on it and shown to the agent. '
      + 'Use the bare address, and put any proxy sign-in in the proxy itself.');
  }
  // The serialized form, not `search`/`hash`: those read empty for a bare
  // trailing `?` or `#`, which would still put every link's path after it.
  if (parsed.href.includes('?') || parsed.href.includes('#')) {
    throw new Error('links are built by appending a path to it, so it can carry no query or fragment, not even an empty one.');
  }
  return parsed.href.replace(/\/+$/, '');
};

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * Whether an IP address, as `server.address()` or `dns.lookup` reports it, is
 * on this machine only: 127.0.0.0/8 or `::1`, IPv4-mapped forms included. A
 * wildcard (`0.0.0.0`, `::`) is not: it is every interface. A name is not an
 * address and is never loopback here; `bindsLoopback` resolves one.
 */
export const isLoopbackAddress = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

/** Resolves a host the way `net.Server.listen` does; a parameter so tests can stand in for /etc/hosts. */
export type HostLookup = (host: string) => Promise<{ address: string }>;

/**
 * Whether listening on `host` keeps the listener on this machine. The one
 * rule for "is this exposed", shared by `serve`'s warning and `doctor`, so
 * they cannot disagree about an address. (The control API decides from the
 * address it actually bound, with `isLoopbackAddress`.)
 *
 * Decided by resolving the host the way `listen` does, not by reading its
 * spelling: `127.1`, `localhost.` and an /etc/hosts alias such as
 * `ip6-localhost` all bind loopback, and no spelling rule knows the aliases.
 * A host that does not resolve cannot be bound either, so it is not loopback.
 */
export const bindsLoopback = async (host: string, lookup: HostLookup = lookupHost): Promise<boolean> => {
  try {
    return isLoopbackAddress((await lookup(host)).address);
  } catch {
    return false;
  }
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
  if (source.publicUrl !== undefined) {
    // Checked here, not when the first link is built: a link to an address
    // that is not one would reach the person asked for a key and fail there.
    try {
      api.publicUrl = normalizePublicUrl(source.publicUrl);
    } catch (error) {
      throw new Error(`Invalid api.publicUrl in config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return api;
};

/** A source id is a URL path segment, so it is kept to what needs no escaping. */
const EVENT_SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The largest `events.maxBodyBytes` accepted: the body is held in memory while it is verified. */
const MAX_EVENT_BODY_BYTES = 16 * 1_048_576;

/**
 * Prefixes of secret values, not names. A value pasted where a name goes is
 * a valid credential name by shape (`whsec_…` is letters and underscores),
 * so the shape check alone would store it in config.json in plain text.
 */
const SECRET_VALUE_PREFIXES = ['whsec_', 'whsk_', 'ghp_', 'gho_', 'github_pat_', 'sk-', 'xoxb-', 'xapp-'];

const parseEventSource = (raw: unknown, configPath: string, id: string): EventSourceConfig => {
  const where = `events.sources.${id}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid ${where} in config ${configPath}: expected { "verify": "github", "secrets": ["events.${id}"] }.`);
  }
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== 'verify' && key !== 'secrets') {
      throw new Error(`Invalid ${where}: unknown key "${key}" in config ${configPath}. A source has "verify" and "secrets".`);
    }
  }
  if (source.verify !== 'standard-webhooks' && source.verify !== 'github') {
    throw new Error(`Invalid ${where}.verify in config ${configPath}: ${JSON.stringify(source.verify)}. Use "standard-webhooks" or "github".`);
  }
  const secrets = source.secrets;
  if (!Array.isArray(secrets) || secrets.length === 0
    || !secrets.every((name): name is string => typeof name === 'string' && CREDENTIAL_NAME_PATTERN.test(name))) {
    throw new Error(
      `Invalid ${where}.secrets in config ${configPath}: expected a list of one or more credential names, `
      + `like ["events.${id}"], each stored with \`stratus credential set\`.`,
    );
  }
  for (const name of secrets) {
    if (SECRET_VALUE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      // The value is not repeated: it may be a real secret.
      throw new Error(
        `Invalid ${where}.secrets in config ${configPath}: an entry looks like a secret value, not a name. `
        + `Store the value with \`stratus credential set events.${id}\` and list "events.${id}" here.`,
      );
    }
  }
  return { verify: source.verify, secrets: [...secrets] };
};

const parseEventsConfig = (raw: unknown, configPath: string): EventsConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  // Refused, not skipped: a block that parsed as nothing would leave the
  // operator expecting deliveries that never arrive.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid events in config ${configPath}: expected an object with "listen", "maxBodyBytes" and "sources".`);
  }
  const source = raw as Record<string, unknown>;
  const events: EventsConfig = {};
  if (source.listen !== undefined) {
    if (typeof source.listen !== 'object' || source.listen === null || Array.isArray(source.listen)) {
      throw new Error(`Invalid events.listen in config ${configPath}: expected { "host": "127.0.0.1", "port": 4124 }.`);
    }
    const listen = source.listen as Record<string, unknown>;
    const parsed: NonNullable<EventsConfig['listen']> = {};
    if (listen.host !== undefined) {
      if (typeof listen.host !== 'string' || listen.host.trim().length === 0) {
        throw new Error(`Invalid events.listen.host in config ${configPath}: ${String(listen.host)}. Use a hostname or address.`);
      }
      parsed.host = listen.host.trim();
    }
    if (listen.port !== undefined) {
      if (typeof listen.port !== 'number' || !Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65_535) {
        throw new Error(`Invalid events.listen.port in config ${configPath}: ${String(listen.port)}. Use a whole number between 0 and 65535.`);
      }
      parsed.port = listen.port;
    }
    events.listen = parsed;
  }
  if (source.maxBodyBytes !== undefined) {
    const max = source.maxBodyBytes;
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_EVENT_BODY_BYTES) {
      throw new Error(
        `Invalid events.maxBodyBytes in config ${configPath}: ${String(max)}. Use a whole number of bytes from 1 to ${MAX_EVENT_BODY_BYTES}.`,
      );
    }
    events.maxBodyBytes = max;
  }
  if (source.sources !== undefined) {
    if (typeof source.sources !== 'object' || source.sources === null || Array.isArray(source.sources)) {
      throw new Error(`Invalid events.sources in config ${configPath}: expected sources by id, like { "github": { "verify": "github", "secrets": ["events.github"] } }.`);
    }
    // No prototype: ids come from the file, and `__proto__` must be a refused key, not a setter.
    const sources = Object.create(null) as Record<string, EventSourceConfig>;
    for (const [id, entry] of Object.entries(source.sources as Record<string, unknown>)) {
      if (!EVENT_SOURCE_ID.test(id)) {
        throw new Error(
          `Invalid events.sources key "${id}" in config ${configPath}: a source id is its URL path, /events/<id>. `
          + 'Use lowercase letters, digits, dashes and underscores, starting with a letter or digit.',
        );
      }
      sources[id] = parseEventSource(entry, configPath, id);
    }
    events.sources = { ...sources };
  }
  return events;
};

const parseApprovalRoute = (raw: unknown, configPath: string, where: string): AgentApprovalConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  // Refused, not skipped: with posture open by default, a block that
  // parsed as nothing (`"approvals": "guarded"`) would run every gated
  // call unasked while the config in front of the operator says guarded.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid ${where} in config ${configPath}: expected an object like { "posture": "guarded" }, got ${JSON.stringify(raw)}.`);
  }
  const source = raw as Record<string, unknown>;
  const route: AgentApprovalConfig = {};
  if (source.externalContent !== undefined) {
    // Refused when misspelled, like `mode`: dropping it would leave the
    // grants an operator meant to withdraw quietly in force, and the
    // config in front of them saying otherwise.
    if (source.externalContent !== 'label' && source.externalContent !== 'gate') {
      throw new Error(
        `Unsupported ${where}.externalContent in config ${configPath}: ${String(source.externalContent)}. Use label or gate.`,
      );
    }
    route.externalContent = source.externalContent;
  }
  if (source.posture !== undefined) {
    // Refused when misspelled: a typo that silently meant `open` would run
    // everything unasked, and one that meant `guarded` would look like the
    // setting did nothing.
    if (source.posture !== 'open' && source.posture !== 'guarded') {
      throw new Error(
        `Unsupported ${where}.posture in config ${configPath}: ${String(source.posture)}. Use open or guarded.`,
      );
    }
    route.posture = source.posture;
  }
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
  if (source.autonomy !== undefined) {
    // Refused when misspelled: an operator who wrote `workspaces` and got
    // `off` would see an agent asking for everything, with the config in
    // front of them saying otherwise.
    if (source.autonomy !== 'off' && source.autonomy !== 'workspace') {
      throw new Error(
        `Unsupported ${where}.autonomy in config ${configPath}: ${String(source.autonomy)}. Use off or workspace.`,
      );
    }
    route.autonomy = source.autonomy;
  }
  if (source.commands !== undefined) {
    // Refused when it is not a list of strings, rather than dropped: an
    // operator who wrote it expects those commands to stop asking, and a
    // silent drop reads as a daemon that ignores its config.
    if (!Array.isArray(source.commands) || source.commands.some((entry) => typeof entry !== 'string')) {
      throw new Error(
        `Invalid ${where}.commands in config ${configPath}: expected a list of commands like ["agentboard", "pnpm test"].`,
      );
    }
    route.commands = (source.commands as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  if (source.branchPrefixes !== undefined) {
    if (!Array.isArray(source.branchPrefixes) || source.branchPrefixes.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      throw new Error(
        `Invalid ${where}.branchPrefixes in config ${configPath}: expected a list of branch-name prefixes like ["nova/", "fix/"].`,
      );
    }
    route.branchPrefixes = (source.branchPrefixes as string[]).map((entry) => entry.trim());
  }
  if (source.trustedDomains !== undefined) {
    // Refused rather than dropped, entry by entry: `https://openai.com/docs`
    // or `openai.com:8443` is someone who meant a domain and would get a
    // daemon quietly asking anyway.
    const domains = Array.isArray(source.trustedDomains) ? source.trustedDomains : undefined;
    // A shared suffix (`github.io`) is spelled like a domain, so it gets
    // its own message: the generic one would read as a typo.
    const shared = domains
      ?.map((entry) => (typeof entry === 'string' ? trustedDomainProblem(entry) : undefined))
      .find((problem) => problem !== undefined && problem !== 'not a domain');
    if (shared !== undefined) {
      throw new Error(`Invalid ${where}.trustedDomains in config ${configPath}: ${shared}.`);
    }
    const normalized = domains?.map((entry) => (typeof entry === 'string' ? normalizeTrustedDomain(entry) : undefined));
    if (normalized === undefined || normalized.some((entry) => entry === undefined)) {
      throw new Error(
        `Invalid ${where}.trustedDomains in config ${configPath}: expected a list of domains like ["openai.com", "developer.apple.com"], with no scheme, path, or port.`,
      );
    }
    route.trustedDomains = [...new Set(normalized as string[])];
  }
  if (source.channels !== undefined) {
    // Refused rather than dropped, like the lists above: an operator who
    // wrote a channel name or a bare id expects it to stop asking.
    const entries = Array.isArray(source.channels) ? source.channels : undefined;
    const valid = entries?.every((entry) => typeof entry === 'string' && standingChannelEntryValid(entry.trim()));
    if (!entries || !valid) {
      throw new Error(
        `Invalid ${where}.channels in config ${configPath}: expected a list like ["slack:T0123ABCD/C0123ABCD"] or ["slack:*"]: `
        + 'a channel kind, the workspace id and a conversation id (not a name), or * for every channel the agent\'s app is in. '
        + 'For Slack, the workspace id starts with T (on Enterprise Grid, the workspace\'s T… id, not the organization\'s E… id) '
        + 'and the channel id with C or G, in capitals; DMs (D…) are never covered.',
      );
    }
    route.channels = [...new Set((entries as string[]).map((entry) => entry.trim()))];
  }
  return route;
};

/**
 * `slack:T0123ABCD/C0123ABCD`, `slack:T0123ABCD/*`, or `slack:*`. A bare
 * `slack:C0123ABCD` still loads, so a config written for the first form of
 * this setting never stops the daemon, but it names no workspace and covers
 * nothing; the daemon says so at startup.
 */
const STANDING_CHANNEL_ENTRY = /^[a-z][a-z0-9-]*:(\*|[A-Za-z0-9][A-Za-z0-9._-]*(\/(\*|[A-Za-z0-9][A-Za-z0-9._-]*))?)$/;

/**
 * Slack's own id shapes, so a channel name that happens to fit the generic
 * pattern (`slack:T0123/general`) is refused at startup instead of loading
 * and never matching: `conversations.info` takes ids only. A workspace is
 * `T…`: what the adapter matches against is `auth.test`'s `team_id`, and an
 * Enterprise Grid organization's `E…` id is never that, so it would load and
 * never match. A channel is `C…` or `G…`. `D…` is refused because a DM is
 * never covered.
 */
const SLACK_STANDING_CHANNEL_ENTRY = /^slack:(\*|(T[A-Z0-9]+\/)?[CG][A-Z0-9]+|T[A-Z0-9]+\/\*)$/;

const standingChannelEntryValid = (entry: string): boolean =>
  STANDING_CHANNEL_ENTRY.test(entry)
  && (!entry.startsWith('slack:') || SLACK_STANDING_CHANNEL_ENTRY.test(entry));

const parseApprovalsConfig = (raw: unknown, configPath: string): ApprovalsConfig | undefined => {
  const route = parseApprovalRoute(raw, configPath, 'approvals');
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
  if (source.agents !== undefined && (typeof source.agents !== 'object' || source.agents === null || Array.isArray(source.agents))) {
    throw new Error(`Invalid approvals.agents in config ${configPath}: expected an object keyed by agent id.`);
  }
  if (source.agents !== undefined) {
    const agents: Record<string, AgentApprovalConfig> = {};
    for (const [agentId, entry] of Object.entries(source.agents as Record<string, unknown>)) {
      const parsed = parseApprovalRoute(entry, configPath, `approvals.agents.${agentId}`);
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
  const externalContent = agent?.externalContent ?? approvals?.externalContent;
  // Open by default: resolved here, the one place, so serve, doctor and the
  // startup line read the same answer.
  const posture = agent?.posture ?? approvals?.posture ?? 'open';
  const autonomy = agent?.autonomy ?? approvals?.autonomy;
  // Added together rather than overridden: see `AgentApprovalConfig.commands`.
  const commands = [...new Set([...(approvals?.commands ?? []), ...(agent?.commands ?? [])])];
  const branchPrefixes = agent?.branchPrefixes ?? approvals?.branchPrefixes;
  const trustedDomains = [...new Set([...(approvals?.trustedDomains ?? []), ...(agent?.trustedDomains ?? [])])];
  const channels = [...new Set([...(approvals?.channels ?? []), ...(agent?.channels ?? [])])];
  return {
    posture,
    ...(autonomy !== undefined ? { autonomy } : {}),
    ...(branchPrefixes !== undefined ? { branchPrefixes } : {}),
    ...(slackApprovers ? { slackApprovers } : {}),
    ...(slackChannel ? { slackChannel } : {}),
    ...(externalContent !== undefined ? { externalContent } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(trustedDomains.length > 0 ? { trustedDomains } : {}),
    ...(channels.length > 0 ? { channels } : {}),
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
  // Closed by default: only listed principals get a turn. `anyone` is the
  // explicit opt-in. Resolved here, the one place, like resolveAgentSlack.
  const admit = agent?.admit ?? principals?.admit ?? 'principals';
  return { ...(slackUsers ? { slackUsers } : {}), admit };
};

const parseSlackEntry = (
  raw: unknown,
  configPath: string,
  where: string,
  perAgent: boolean,
): AgentSlackConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid ${where} in config ${configPath}: expected an object, received ${JSON.stringify(raw)}.`);
  }
  const source = raw as Record<string, unknown>;
  const entry: AgentSlackConfig = {};
  if (source.replies !== undefined) {
    // Refused rather than defaulted: a misspelt "streem" that quietly meant
    // `final` would look like the setting did nothing.
    if (source.replies !== 'final' && source.replies !== 'stream' && source.replies !== 'texts') {
      throw new Error(
        `Invalid ${where}.replies in config ${configPath}: expected "final", "stream" or "texts", received ${JSON.stringify(source.replies)}.`,
      );
    }
    entry.replies = source.replies;
  }
  if (source.linkPreviews !== undefined) {
    // Refused rather than coerced: "false" as a string would read as on.
    if (typeof source.linkPreviews !== 'boolean') {
      throw new Error(
        `Invalid ${where}.linkPreviews in config ${configPath}: expected true or false, received ${JSON.stringify(source.linkPreviews)}.`,
      );
    }
    entry.linkPreviews = source.linkPreviews;
  }
  if (source.homeChannels !== undefined) {
    // A home channel shared by every agent would have each of them answer
    // every message there; the per-agent entry is the only place it means
    // one thing.
    if (!perAgent) {
      throw new Error(
        `Invalid ${where}.homeChannels in config ${configPath}: homeChannels is per-agent; set it under slack.agents.<agentId>.homeChannels.`,
      );
    }
    if (
      !Array.isArray(source.homeChannels)
      || !source.homeChannels.every((id) => typeof id === 'string' && /^[CG][A-Z0-9]+$/.test(id))
    ) {
      throw new Error(
        `Invalid ${where}.homeChannels in config ${configPath}: expected an array of Slack channel ids like "C0123ABCD", received ${JSON.stringify(source.homeChannels)}.`,
      );
    }
    entry.homeChannels = [...new Set(source.homeChannels as string[])];
  }
  if (source.agentMentions !== undefined) {
    // Refused rather than coerced, as linkPreviews is: "false" would read as on.
    if (typeof source.agentMentions !== 'boolean') {
      throw new Error(
        `Invalid ${where}.agentMentions in config ${configPath}: expected true or false, received ${JSON.stringify(source.agentMentions)}.`,
      );
    }
    entry.agentMentions = source.agentMentions;
  }
  if (source.agentMentionsFrom !== undefined) {
    if (!perAgent) {
      throw new Error(
        `Invalid ${where}.agentMentionsFrom in config ${configPath}: agentMentionsFrom is per-agent; set it under slack.agents.<agentId>.agentMentionsFrom.`,
      );
    }
    if (!Array.isArray(source.agentMentionsFrom) || !source.agentMentionsFrom.every((name) => typeof name === 'string' && name.length > 0)) {
      throw new Error(
        `Invalid ${where}.agentMentionsFrom in config ${configPath}: expected an array of team agent names, received ${JSON.stringify(source.agentMentionsFrom)}.`,
      );
    }
    entry.agentMentionsFrom = [...new Set(source.agentMentionsFrom as string[])];
  }
  return entry;
};

const parseSlackConfig = (raw: unknown, configPath: string): SlackConfig | undefined => {
  const shared = parseSlackEntry(raw, configPath, 'slack', false);
  if (!shared) {
    return undefined;
  }
  const slack: SlackConfig = { ...shared };
  const source = raw as Record<string, unknown>;
  if (source.team !== undefined) {
    if (
      typeof source.team !== 'object' || source.team === null || Array.isArray(source.team)
      || !Object.values(source.team as Record<string, unknown>).every((id) => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id))
    ) {
      throw new Error(
        `Invalid slack.team in config ${configPath}: expected an object of agent name to Slack bot user id like {"blair": "U0123ABCD"}, received ${JSON.stringify(source.team)}.`,
      );
    }
    slack.team = { ...(source.team as Record<string, string>) };
  }
  if (source.agents !== undefined) {
    if (typeof source.agents !== 'object' || source.agents === null || Array.isArray(source.agents)) {
      throw new Error(
        `Invalid slack.agents in config ${configPath}: expected an object keyed by agent id, received ${JSON.stringify(source.agents)}.`,
      );
    }
    const agents: Record<string, AgentSlackConfig> = {};
    for (const [agentId, entry] of Object.entries(source.agents as Record<string, unknown>)) {
      const parsed = parseSlackEntry(entry, configPath, `slack.agents.${agentId}`, true);
      if (parsed) {
        agents[agentId] = parsed;
      }
    }
    if (Object.keys(agents).length > 0) {
      slack.agents = agents;
    }
  }
  return slack;
};

/**
 * One agent's Slack presentation: its own entry where it has one, the
 * top-level block otherwise — per key, the precedence `resolveAgentPrincipals`
 * uses. `replies` defaults to `final` and `linkPreviews` to `true` here,
 * the one place, so nothing
 * downstream has to know what an absent key means.
 */
export const resolveAgentSlack = (
  slack: SlackConfig | undefined,
  agentId: string,
): Required<Omit<AgentSlackConfig, 'agentMentionsFrom'>> & Pick<AgentSlackConfig, 'agentMentionsFrom'> => {
  const agentMentionsFrom = slack?.agents?.[agentId]?.agentMentionsFrom;
  return {
    replies: slack?.agents?.[agentId]?.replies ?? slack?.replies ?? 'final',
    linkPreviews: slack?.agents?.[agentId]?.linkPreviews ?? slack?.linkPreviews ?? true,
    homeChannels: slack?.agents?.[agentId]?.homeChannels ?? [],
    // Off unless someone turned it on (card 513).
    agentMentions: slack?.agents?.[agentId]?.agentMentions ?? slack?.agentMentions ?? false,
    ...(agentMentionsFrom !== undefined ? { agentMentionsFrom } : {}),
  };
};

// ---------------------------------------------------------------------------
// Writing the config file
// ---------------------------------------------------------------------------

/**
 * Persist settings, owner-read-only, creating the directory if it is not
 * there yet.
 *
 * 0600 for the reason `credentials.json` is: this file holds secrets. It was
 * once left readable on the grounds that it held none, but tool-shell's `env`
 * block is the documented way to hand a command a token, and it lives here —
 * so a real install had a third-party API token in a world-readable file
 * (#204). The other argument, a daemon running as another user, never held
 * either: that daemon reads the 0600 `credentials.json` beside this file.
 *
 * Tightened before the write as well as after it. `writeFile`'s mode applies
 * only when it creates the file, so a file an older build left loose would
 * otherwise take the new contents at the old mode, if only until the chmod.
 * In place rather than through a rename, unlike the credentials file: a
 * `config.json` symlinked from a dotfiles checkout must stay a link.
 */
export const saveConfigFile = async (
  configPath: string,
  config: StratusConfigFile,
): Promise<void> => {
  await mkdir(path.dirname(configPath), { recursive: true });
  // Only a file is tightened ahead of the write. A directory where the
  // config belongs (setup reads past an unreadable config and saves anyway)
  // would lose its search bit to the chmod and then fail the write with
  // EISDIR, left worse than it was found; the write alone fails cleanly.
  let existing: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    existing = await stat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (existing?.isFile()) {
    await chmod(configPath, 0o600);
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
};
