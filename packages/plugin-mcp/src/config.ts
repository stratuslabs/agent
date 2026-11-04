/*
 * Reading one server's block of the plugin's config into an `McpServerSpec`:
 * command or URL, args, cwd, env and headers, timeouts, result cap and
 * output trust. It runs once per server, when the plugin is constructed, and
 * a block that does not parse throws `McpConfigError` saying which key is
 * wrong.
 */
import { DEFAULT_SUBPROCESS_PASS_ENV, type TrustLevel } from '@stratusagent/core';

import { SERVER_NAME_PATTERN } from './descriptors.ts';
import { boundedResultLimit, BRIDGED_RESULT_MAX_LENGTH } from './result-budget.ts';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** What one configured server looks like once its block has been read. */
export interface McpServerSpec {
  /** The config key — a name segment, so `mcp.<name>.*` is what a soul writes. */
  name: string;
  /** stdio: the executable to spawn. Exactly one of `command` and `url`. */
  command?: string;
  args: string[];
  cwd?: string;
  /**
   * The subprocess environment, already resolved: the scrubbed default
   * inheritance plus whatever the operator granted by name or set
   * outright. This is the whole environment — the daemon's is not there
   * to read.
   */
  env: Record<string, string>;
  /** HTTP: the Streamable HTTP endpoint. */
  url?: string;
  /** HTTP: headers sent with every request — where a bearer token goes. */
  headers: Record<string, string>;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  /**
   * The cap on one result's text, in characters — see
   * `BRIDGED_RESULT_MAX_LENGTH` in `./result-budget.ts` for the number and the
   * reason. Per server because that is where the operator already tunes a
   * server's behavior, and because one verbose server should not force the
   * cap up for the rest.
   */
  maxResultChars: number;
  /**
   * The label this server's results carry: `servers.<name>.outputTrust`,
   * `external` by default. See `resolveOutputTrust`.
   */
  outputTrust: TrustLevel;
}

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asStringRecord = (value: unknown, where: string): Record<string, string> => {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new McpConfigError(`${where} must be an object of string values.`);
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new McpConfigError(`${where}.${key} must be a string.`);
    }
    record[key] = entry;
  }
  return record;
};

/**
 * A positive number from a config block, or the default. Shared by the two
 * timeouts and by `maxResultChars`: all three mean "a bound the operator
 * may move", and for all three a `0`, a negative, or a non-number is a
 * value that would remove the bound rather than set it — which is never
 * what a config key on somebody else's server should be able to say.
 */
const asPositiveNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * The same, for a bound that is counted rather than measured. A fractional
 * millisecond is a harmless way to say a timeout, but a fractional
 * character is not a number of characters — and it reaches code that
 * counts up to it one character at a time, where "400.5" is a target no
 * integer ever hits.
 */
const asPositiveInteger = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

const asStringArray = (value: unknown, where: string): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new McpConfigError(`${where} must be an array of strings.`);
  }
  return value as string[];
};

/**
 * Resolve one server block into a spec, or refuse it. Refusals here are
 * configuration errors and fail the plugin at load — a mistyped block is
 * the operator's to fix, unlike a server that is merely down.
 */
/**
 * The granted search path, looked up the way the *platform* spells it.
 *
 * Case-insensitive on Windows only, because that is where it is true.
 * Windows environment names are case-insensitive and `Path` is the spelling
 * it actually uses, so a check keyed to `PATH` alone would refuse a Windows
 * config that granted the variable perfectly well.
 *
 * POSIX names are case-sensitive, and only `PATH` controls executable
 * lookup. Accepting `Path` there would pass a grant that does nothing: the
 * child is handed `Path`, `PATH` is sealed away as ungranted, and a bare
 * command has no search path at all — which is precisely the state the
 * refusal below exists to prevent. A generous read of the spelling would
 * have defeated the check it guards.
 *
 * `platform` is a parameter so the Windows branch can be tested from
 * anywhere; nothing passes it in production.
 */
export const grantedEntry = (
  granted: Record<string, string>,
  name: string,
  platform: NodeJS.Platform,
): [string, string] | undefined => (platform === 'win32'
  ? Object.entries(granted).find(([key]) => key.toLowerCase() === name.toLowerCase())
  : (name in granted ? [name, granted[name] as string] : undefined));

/**
 * The granted search path, or undefined when there is not a usable one.
 *
 * Empty counts as absent. `which` takes a falsy `path` as no path and falls
 * back to `process.env.PATH` — the daemon's own — so an empty grant would
 * resolve a bare command against exactly the environment this config
 * declined to grant, which is the leak the seal exists to close.
 */
export const pathGrant = (
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const value = grantedEntry(env, 'PATH', platform)?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
};

/**
 * What an operator may say about a server's output, read from
 * `servers.<name>.outputTrust`.
 *
 * Every bridged result was `external` unconditionally, and memory written
 * after one is capped at the session's lowest label — so an agent doing
 * real work through an operator's own internal server labelled every fact
 * it remembered afterwards as a stranger's, and the label stopped telling
 * anything apart (#224). The operator can now vouch for a server they
 * run: `agent` for one whose output is as good as the agent's own work,
 * `unknown` for one that is theirs but relays text from elsewhere.
 *
 * Never `user`: that label means a person said it, which no server's
 * output is. And it is the operator's word only — the `plugins` block is
 * read from a trusted config alone, so neither a cloned repository nor
 * the server itself can raise it.
 */
const resolveOutputTrust = (value: unknown, where: string): TrustLevel => {
  if (value === undefined) {
    return 'external';
  }
  if (value === 'agent' || value === 'unknown' || value === 'external') {
    return value;
  }
  if (value === 'user') {
    throw new McpConfigError(
      `${where}.outputTrust cannot be "user": that label means a person said it, and a server's output never is. `
      + 'Use "agent" for a server whose output you trust as much as the agent\'s own work.',
    );
  }
  throw new McpConfigError(`${where}.outputTrust must be "agent", "unknown", or "external" (the default).`);
};

export const resolveServerSpec = (
  name: string,
  block: unknown,
  processEnv: NodeJS.ProcessEnv,
): McpServerSpec => {
  const where = `servers.${name}`;
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new McpConfigError(
      `Server name ${JSON.stringify(name)} is not usable: it becomes a tool-name segment (mcp.${name}.*), so it must be lowercase [a-z0-9_-] starting with a letter or digit.`,
    );
  }
  if (!isObject(block)) {
    throw new McpConfigError(`${where} must be an object.`);
  }
  const command = typeof block.command === 'string' && block.command.length > 0 ? block.command : undefined;
  const url = typeof block.url === 'string' && block.url.length > 0 ? block.url : undefined;
  if ((command === undefined) === (url === undefined)) {
    throw new McpConfigError(`${where} must set exactly one of "command" (stdio) or "url" (HTTP).`);
  }
  if (url !== undefined) {
    try {
      void new URL(url);
    } catch {
      throw new McpConfigError(`${where}.url is not a URL: ${url}`);
    }
  }

  // A setting on the wrong transport kind is refused, not quietly unused:
  // an operator who wrote `headers` for a server that turned out to be
  // stdio believes a bearer token is being sent, and the mistyped grant
  // that silently does nothing is the failure mode the toolRisks parser
  // already refuses by design.
  for (const key of ['args', 'cwd', 'env', 'passEnv'] as const) {
    if (url !== undefined && block[key] !== undefined) {
      throw new McpConfigError(`${where}.${key} only applies to a stdio server ("command"); this server sets "url".`);
    }
  }
  if (command !== undefined && block.headers !== undefined) {
    throw new McpConfigError(`${where}.headers only applies to an HTTP server ("url"); this server sets "command".`);
  }

  // The replacement-environment treatment: the child gets exactly what was
  // granted — the harmless default inheritance, names the operator
  // forwarded, values the operator set — and nothing else. The daemon's
  // environment holds every key an operator exported, and a subprocess MCP
  // server is a subprocess: ANTHROPIC_API_KEY must not be there to read.
  const env: Record<string, string> = {};
  const passEnv = asStringArray(block.passEnv, `${where}.passEnv`) ?? [...DEFAULT_SUBPROCESS_PASS_ENV];
  for (const key of passEnv) {
    const value = processEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, asStringRecord(block.env, `${where}.env`));

  // A bare command is resolved against the child's PATH, and the child's
  // PATH is now only what this config granted — so without one there is no
  // search path to find it in, and the failure would arrive at connect time
  // as a bare ENOENT that reads like a missing binary.
  //
  // Refused here rather than diagnosed there, because the runtime signal
  // cannot be trusted to mean what it says: on Windows the SDK spawns
  // through cross-spawn, whose resolver hands an absent PATH to `which`,
  // and `which` falls back to `process.env.PATH` — the daemon's own. So a
  // bare command would still resolve against exactly the environment this
  // config declined to grant. Same rule as a malformed `passEnv`: a grant
  // an operator believes is in effect must never quietly be nothing.
  if (command !== undefined && !/[/\\]/.test(command) && pathGrant(env) === undefined) {
    throw new McpConfigError(
      `${where}.command is "${command}", which has to be found on PATH, but ${where}.passEnv does not grant PATH. `
        + 'Grant PATH, or give the command as an absolute path.',
    );
  }

  return {
    name,
    ...(command !== undefined ? { command } : {}),
    args: asStringArray(block.args, `${where}.args`) ?? [],
    ...(typeof block.cwd === 'string' && block.cwd.length > 0 ? { cwd: block.cwd } : {}),
    env,
    ...(url !== undefined ? { url } : {}),
    headers: asStringRecord(block.headers, `${where}.headers`),
    connectTimeoutMs: asPositiveNumber(block.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    callTimeoutMs: asPositiveNumber(block.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS),
    // A `0`, a negative, or a fraction is not "no cap" — see
    // `asPositiveInteger`. The one thing this must not be is switchable off
    // from a config key, since a server that wanted the cap gone is the
    // server it exists for.
    // Through `boundedResultLimit` so the floor reaches everything this
    // spec feeds, the protocol-error path included — that one bounds its
    // message directly and never passes through `normalizeCallResult`.
    maxResultChars: boundedResultLimit(asPositiveInteger(block.maxResultChars, BRIDGED_RESULT_MAX_LENGTH)),
    outputTrust: resolveOutputTrust(block.outputTrust, where),
  };
};
