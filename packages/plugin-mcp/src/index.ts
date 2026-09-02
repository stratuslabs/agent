import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { accessSync, constants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_SUBPROCESS_PASS_ENV,
  type ExecutionContext,
  type JsonObject,
  type JsonValue,
  type Plugin,
  type Session,
  type Tool,
  type ToolRegistry,
} from '@stratusagent/core';

import {
  bridgedToolName,
  normalizeCallResult,
  sanitizeToolSegment,
  SERVER_NAME_PATTERN,
} from './normalize.ts';

/**
 * What this client tells an MCP server it is. Moves with the package
 * manifests on a release, like CLI_VERSION and CONTROL_API_VERSION — a
 * server that logs or keys compatibility on clientInfo.version otherwise
 * goes on seeing the release this literal was last touched at.
 */
const PLUGIN_MCP_VERSION = '0.10.0';

export { bridgedToolName, normalizeCallResult, sanitizeToolSegment, SERVER_NAME_PATTERN } from './normalize.ts';
export { sealedStdioEnv, pathGrant, resolveCommandPath };

/**
 * The MCP bridge: mounts Model Context Protocol servers as Stratus tools.
 *
 * Each configured server's tools register as `mcp.<server>.<tool>`, so a
 * soul allowlists `mcp.linear.*` and an operator can see at a glance which
 * tools are somebody else's code. Risk is ours, not the server's: the
 * manifest declares the `mcp.*` namespace `gated`, the registration view
 * enforces it, and an operator who has read a server lowers a specific
 * tool through the host's `toolRisks` key — never through anything this
 * package could do on its own.
 *
 * Lifecycle: connect at startup, reconnect with backoff, and a server that
 * is down degrades to its tools being unavailable rather than failing the
 * daemon's start. Tool descriptors are built once per connect; a server
 * that changes its list mid-run is picked up on reconnect, and the change
 * is logged because an agent's allowlist may no longer mean what it meant.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/**
 * How many pages of `tools/list` discovery will follow. The per-request
 * timeout bounds each page, not the walk — a server that always answers
 * with a nextCursor would otherwise hold `setup()`, and with it the
 * daemon's start, forever. Which is exactly the kind of say-so this
 * package's trust model exists to not extend to a remote server.
 */
const MAX_TOOL_LIST_PAGES = 100;

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
}

export interface McpPluginOptions {
  /** The environment `passEnv` grants *from*. Defaults to the daemon's. */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Transport seam for tests: hand back a connected pair instead of
   * spawning or dialing. The default builds stdio or Streamable HTTP from
   * the spec.
   */
  transportFor?: (spec: McpServerSpec) => Transport | Promise<Transport>;
  /**
   * Reconnect pacing, attempt (0-based) to delay. The default doubles from
   * one second and caps at one minute; tests shrink it so a reconnect is
   * an event to await rather than a wall-clock to sleep through.
   */
  reconnectDelayMs?: (attempt: number) => number;
  /**
   * Called after a server (re)connects and its tools are registered — the
   * gate a test holds instead of guessing at timers, and a hook a host
   * could count connections with.
   */
  onConnected?: (server: string) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * Clock seam for the discovery deadline: the budget arithmetic only shows
   * itself when time passes mid-walk, which a real clock makes a race.
   */
  now?: () => number;
}

class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
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

const asTimeout = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

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
const grantedEntry = (
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
const pathGrant = (
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const value = grantedEntry(env, 'PATH', platform)?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
};

const resolveServerSpec = (
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
    connectTimeoutMs: asTimeout(block.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    callTimeoutMs: asTimeout(block.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS),
  };
};

/**
 * Whether a failed call means the *connection* failed, as opposed to the
 * tool. A stdio server dying fires `client.onclose`, but a Streamable HTTP
 * server that restarted or expired its session reports the loss only on
 * the request path — the stale `mcp-session-id` gets an HTTP error, and
 * nothing ever closes the transport — so without classifying rejections
 * here, every later call would keep reusing the dead session until the
 * daemon restarted.
 *
 * - `StreamableHTTPError` is the transport's own word for an HTTP-level
 *   failure (a 404 on a stale session, a 5xx).
 * - `ErrorCode.ConnectionClosed` is a request rejected because the
 *   transport went away under it.
 * - A `TypeError` is how `fetch` reports a network failure (the server is
 *   simply gone); no JSON-RPC error from a live server arrives as one.
 *
 * Everything else — the server answering with a tool error, invalid
 * params, a timeout on a slow tool — is a live connection and no reason
 * to tear it down.
 */
const isConnectionFailure = (error: unknown): boolean =>
  error instanceof StreamableHTTPError
  || (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)
  || error instanceof TypeError;

/**
 * The granted environment, plus an explicit refusal of every name the
 * transport would otherwise inherit on its own.
 *
 * `StdioClientTransport` spawns with `{ ...getDefaultEnvironment(), ...env }`
 * — the SDK's own idea of what a server needs (on POSIX: HOME, LOGNAME,
 * PATH, SHELL, TERM, USER). That spread is a floor a caller cannot lower by
 * passing a scrubbed `env`, so a server mounted with `passEnv: []` still
 * received all six: the operator was told they get a sealed environment and
 * did not. None of the six is a secret, but which of them a third-party
 * server learns is the operator's decision, and `tool-shell` — which spawns
 * directly and shares `DEFAULT_SUBPROCESS_PASS_ENV` so that "what does a
 * child see" has one answer — already honours it.
 *
 * A key mapped to `undefined` is dropped by `spawn` rather than set empty,
 * which is the difference between a server seeing no `USER` and seeing an
 * empty one. Read from the SDK's own list rather than a copy of it, so a
 * name it adds later is refused by the same code.
 */
const sealedStdioEnv = (
  granted: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> => {
  const sealed: Record<string, string | undefined> = {};
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    // Asked through the same rule the grant check uses. These two must agree
    // about what "granted" means: when they disagreed, a Windows config
    // granting `Path` passed the check and was then sealed against by an
    // uppercase `PATH: undefined` for the same variable — the seal
    // contradicting the grant it had just accepted.
    if (grantedEntry(granted, name, platform) === undefined) {
      sealed[name] = undefined;
    }
  }
  const merged: Record<string, string | undefined> = { ...sealed, ...granted };

  // The invariant this function exists for, stated once instead of patched
  // per symptom: **for every name the transport would inherit, exactly one
  // entry leaves here, spelled the way the transport spells it, holding the
  // granted value or nothing.**
  //
  // The transport merges `{ ...getDefaultEnvironment(), ...ours }` using the
  // spellings in its own list. So only that spelling can override the
  // daemon's copy or seal it away; any other casing is either a different
  // variable (POSIX, harmless) or a second spelling of the same one
  // (Windows), and a second spelling leaves the runtime to pick — which it
  // does by lexicographic order, handing the daemon's `USERPROFILE` back over
  // a granted `UserProfile`. Every way this has been wrong was a missing or
  // mis-spelled entry here: a refusal beside a grant, a grant with no refusal
  // to override, and the rule written for `PATH` alone when it holds for the
  // whole set.
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    if (platform === 'win32') {
      // A second casing of a name Windows treats as one variable.
      for (const key of Object.keys(merged)) {
        if (key !== name && key.toLowerCase() === name.toLowerCase()) {
          delete merged[key];
        }
      }
    }
    // PATH carries the extra rule that an empty grant is not a search path;
    // every other name is worth exactly what the operator wrote.
    merged[name] = name === 'PATH'
      ? pathGrant(granted, platform)
      : grantedEntry(granted, name, platform)?.[1];
  }

  // The cast is the SDK's types not describing the drop-on-undefined
  // behaviour its own spawn relies on; the values are deliberate.
  return merged as Record<string, string>;
};

/**
 * What counts as executable on Windows when `PATHEXT` was not granted.
 *
 * A constant rather than the daemon's own `PATHEXT`, for the same reason
 * `pathGrant` refuses an empty `PATH`: a value this config did not grant is
 * not part of the search it declared. And this constant specifically,
 * because it is the fallback `which` already uses — a wider one (Windows'
 * own default adds `.VBS`, `.JS`, `.WS`, `.MSC`) would make a bare command
 * resolve to file types that resolve to nothing today. Replacing a lookup
 * is not an occasion to widen what it will run.
 */
const WHICH_FALLBACK_PATHEXT = '.EXE;.CMD;.BAT;.COM';

/**
 * The granted search path as directories, in order.
 *
 * An empty entry is dropped rather than read as the working directory the
 * way a shell would. That is not the same call as dropping a relative entry,
 * which is honoured: `./node_modules/.bin` is a directory somebody chose,
 * while a zero-length entry is what a stray colon produces — and the default
 * grant is `passEnv: ['PATH']`, which copies the daemon's own PATH verbatim,
 * trailing colon included. Nobody decided that one, which makes it the same
 * shape of hole as Windows searching the cwd without being asked.
 */
const searchEntries = (search: string, platform: NodeJS.Platform): string[] => search
  .split(platform === 'win32' ? ';' : ':')
  // A *balanced* pair only, the way `which` does it (`/^".*"$/`). A lone
  // leading or trailing quote is a malformed entry, and stripping it would
  // silently search a directory the granted string does not name — which is
  // the same substitution this whole resolver exists to prevent, arrived at
  // from the other side.
  .map((entry) => (platform === 'win32' && /^".*"$/.test(entry) ? entry.slice(1, -1) : entry))
  .filter((entry) => entry.length > 0);

/**
 * The filenames a command could have inside one directory.
 *
 * On POSIX, itself. On Windows the extension is what makes a file runnable,
 * so every `PATHEXT` entry is a candidate — and a command that already
 * carries a dot is tried as written first, which is what `cmd.exe` and
 * `which` both do.
 */
const commandCandidates = (
  command: string,
  platform: NodeJS.Platform,
  pathext: string | undefined,
): string[] => {
  if (platform !== 'win32') {
    return [command];
  }
  const extensions = (pathext ?? WHICH_FALLBACK_PATHEXT).split(';').filter((ext) => ext.length > 0);
  const suffixed = extensions.map((ext) => `${command}${ext}`);
  // Tried as written first only when what it already carries is an extension
  // `PATHEXT` permits. `which` unshifts the unsuffixed candidate whenever the
  // command holds a dot, but `isexe` then checks that candidate's extension
  // against `PATHEXT` like any other — so a `srv.js` under `PATHEXT: ".EXE"`
  // is not runnable there either, and taking it here would let a file
  // Windows would refuse mask the `srv.js.EXE` beside it that it would run.
  //
  // One knowing divergence: `isexe` reads an empty entry *inside* `PATHEXT`
  // as "every extension is executable". Empty entries are dropped here, so
  // `PATHEXT: ".EXE;"` still permits only `.EXE`. A grant is not widened by
  // the punctuation that ends it.
  return extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()))
    ? [command, ...suffixed]
    : suffixed;
};

/** Whether a candidate is a file this platform would actually run. */
const isRunnableFile = (candidate: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    // Windows has no execute bit; the extension decided it, in the candidate
    // list above.
    if (platform === 'win32') {
      return true;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * A bare command resolved to a path against the granted search path, by us
 * rather than by the spawn.
 *
 * `StdioClientTransport` spawns through `cross-spawn`, whose Windows
 * resolver puts `process.cwd()` at the front of the search path ahead of
 * anything the operator granted — `which/which.js` says so in its own
 * comment, "windows always checks the cwd first". The daemon's working
 * directory is not a grant, and an `npx.cmd` dropped into it would run in
 * place of the one on the granted `PATH`.
 *
 * Handing the transport a path it does not have to search removes that. It
 * is done on every platform rather than behind a Windows branch, so that
 * the resolution Windows depends on is the one CI exercises, and so that
 * "what does this command resolve to" has one answer instead of two.
 */
const resolveCommandPath = (
  command: string,
  granted: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  base: string = process.cwd(),
): string | undefined => {
  const search = pathGrant(granted, platform);
  if (search === undefined) {
    return undefined;
  }
  const pathext = platform === 'win32' ? grantedEntry(granted, 'PATHEXT', platform)?.[1] : undefined;
  for (const entry of searchEntries(search, platform)) {
    for (const candidate of commandCandidates(command, platform, pathext)) {
      // Absolute out, resolved against the directory the child will actually
      // run in. Both halves matter and neither is optional: a relative entry
      // stat'd against the daemon's directory asks about a different file
      // than the one the spawn would find, and a relative path *returned*
      // gets re-read against the server's `cwd` — so the file checked here
      // and the file spawned there would be two different files.
      const full = join(resolve(base, entry), candidate);
      if (isRunnableFile(full, platform)) {
        return full;
      }
    }
  }
  return undefined;
};

/**
 * The executable to spawn: what the operator wrote when it names a path,
 * and otherwise whatever the granted search path resolves it to.
 *
 * A plain `Error` rather than `McpConfigError`, because the two mean
 * different things to `setup`: a config that cannot become correct fails
 * the plugin, while a binary that is not installed *yet* leaves the daemon
 * serving every other agent. This is the second kind — the reconnect loop
 * builds a fresh transport each attempt, so a server whose package finishes
 * installing is picked up without a daemon restart.
 */
const stdioCommand = (
  command: string,
  granted: Record<string, string>,
  cwd: string | undefined,
): string => {
  if (/[/\\]/.test(command)) {
    return command;
  }
  // The child's own working directory, which is what a relative search-path
  // entry is relative to. Undefined means the server inherits the daemon's,
  // so that is the base then — the same directory `spawn` would use.
  const resolved = resolveCommandPath(command, granted, process.platform, cwd ?? process.cwd());
  if (resolved === undefined) {
    throw new Error(
      `Command "${command}" was not found on the PATH this server was granted. `
        + 'Grant a PATH that contains it, or give the command as an absolute path.',
    );
  }
  return resolved;
};

const buildTransport = (spec: McpServerSpec): Transport => {
  if (spec.command !== undefined) {
    return new StdioClientTransport({
      command: stdioCommand(spec.command, spec.env, spec.cwd),
      args: spec.args,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: sealedStdioEnv(spec.env),
    });
  }
  // The assertion papers over the SDK's own optional-property types not
  // being written for exactOptionalPropertyTypes; the object is a Transport.
  return new StreamableHTTPClientTransport(new URL(spec.url as string), {
    requestInit: { headers: spec.headers },
  }) as unknown as Transport;
};

/** The slice of a `tools/list` entry the bridge reads. */
interface AdvertisedTool {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

/** What the bridge knows about one discovered tool, snapshotted at connect. */
interface DiscoveredTool {
  /** The name the server knows it by — what `tools/call` is sent. */
  mcpName: string;
  description?: string;
  parameters?: JsonObject;
}

interface ServerState {
  spec: McpServerSpec;
  client: Client | undefined;
  /**
   * The transport of a connect still in flight, from the moment it exists
   * until the connect settles. `dispose()` closes it directly: without
   * this, a dispose racing a handshake could only wait for the connect's
   * own `disposed` re-checks to run — for a stdio server, a spawned child
   * holding granted env would live on until the connect timeout expired.
   */
  pending: Transport | undefined;
  connected: boolean;
  connecting: boolean;
  attempt: number;
  timer: NodeJS.Timeout | undefined;
  /** Registered name → what it bridges to. The live descriptor cache. */
  tools: Map<string, DiscoveredTool>;
}

export const createMcpPlugin = (config: JsonObject = {}, options: McpPluginOptions = {}): Plugin => {
  const log = options.log ?? ((message: string) => console.error(`[plugin-mcp] ${message}`));
  const warn = options.warn ?? ((message: string) => console.error(`[plugin-mcp] ${message}`));
  const processEnv = options.processEnv ?? process.env;
  const delayFor = options.reconnectDelayMs
    ?? ((attempt: number) => Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS));
  const workspaceRoot = typeof config.workspaceRoot === 'string' ? config.workspaceRoot : undefined;

  if (!isObject(config.servers)) {
    throw new McpConfigError(
      'plugins["@stratusagent/plugin-mcp"] needs a "servers" object — one entry per MCP server, keyed by the name its tools mount under.',
    );
  }
  const states: ServerState[] = Object.entries(config.servers).map(([name, block]) => ({
    spec: resolveServerSpec(name, block, processEnv),
    client: undefined,
    pending: undefined,
    connected: false,
    connecting: false,
    attempt: 0,
    timer: undefined,
    tools: new Map(),
  }));

  let view: ToolRegistry | undefined;
  let disposed = false;

  const proxyTool = (state: ServerState, registeredName: string, info: DiscoveredTool): Tool => ({
    name: registeredName,
    description: info.description ?? `Tool ${info.mcpName} on the MCP server ${state.spec.name}.`,
    ...(info.parameters ? { parameters: info.parameters } : {}),
    // No risk claim, deliberately: what a bridged tool registers at is the
    // namespace's declared risk (and any operator override), applied by
    // the manifest-bound view — the server's opinion of itself never
    // enters, and neither does this package's.
    async execute(input: JsonObject, session: Session, context?: ExecutionContext): Promise<JsonValue> {
      const client = state.connected ? state.client : undefined;
      if (!client) {
        throw new Error(
          `MCP server ${state.spec.name} is not connected; ${registeredName} is unavailable until it comes back.`,
        );
      }
      // Identity, not equality, against the live map: syncTools keeps the
      // same descriptor object across a reconnect exactly when nothing
      // about the tool changed. A call can be held between issue and
      // execution — parked on a human's approval — and a reconnect that
      // swapped the definition underneath it must fail the call rather
      // than run the replacement with input approved for the original.
      if (state.tools.get(registeredName) !== info) {
        throw new Error(
          `${registeredName} changed on MCP server ${state.spec.name} after this call was issued — the server now advertises a different definition, or none. Call it again to run the updated tool.`,
        );
      }
      let result;
      try {
        result = await client.callTool({ name: info.mcpName, arguments: input }, undefined, {
          timeout: state.spec.callTimeoutMs,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        // A session-loss surfaces here, not on onclose — see
        // isConnectionFailure. Guarded on the client this call used, so a
        // reconnect that already replaced it is left alone.
        if (isConnectionFailure(error) && state.client === client) {
          dropConnection(state, error);
        }
        throw error;
      }
      return normalizeCallResult(result, {
        server: state.spec.name,
        tool: info.mcpName,
        agentId: session.agent.id,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      });
    },
  });

  /** Every page of `tools/list`, not just the first. */
  const listAllTools = async (
    client: Client,
    spec: McpServerSpec,
    remainingMs: () => number,
  ): Promise<AdvertisedTool[]> => {
    const tools: AdvertisedTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_TOOL_LIST_PAGES) {
        throw new Error(
          `MCP server ${spec.name} returned more than ${MAX_TOOL_LIST_PAGES} pages of tools/list; refusing discovery rather than following its cursors forever.`,
        );
      }
      // One budget for the whole walk, not one per page: a fresh timeout
      // for every request would let a slowly paginating server multiply
      // the advertised connect bound by its page count, holding setup —
      // and daemon start — for minutes on end.
      const budget = remainingMs();
      if (budget <= 0) {
        throw new Error(
          `MCP server ${spec.name} did not finish tool discovery within its ${spec.connectTimeoutMs}ms connect budget.`,
        );
      }
      // A cursor is the server's opaque string, the empty string included —
      // dropped on truthiness, an "" cursor would refetch the first page
      // until the page guard condemned a compliant server.
      const page = await client.listTools(cursor !== undefined ? { cursor } : undefined, { timeout: budget });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  };

  /**
   * Reconcile what a server advertises with what is registered — first
   * connect and reconnect run the identical path, through the identical
   * manifest-bound gate. Every difference is logged: a tool appearing,
   * disappearing, or changing shape changes what an agent's allowlist
   * selects.
   */
  const syncTools = (
    state: ServerState,
    advertised: AdvertisedTool[],
    firstConnect: boolean,
  ): void => {
    if (!view) {
      return;
    }
    const next = new Map<string, DiscoveredTool>();
    for (const tool of advertised) {
      const segment = sanitizeToolSegment(tool.name);
      if (segment === undefined) {
        throw new McpConfigError(
          `MCP server ${state.spec.name} advertises a tool named ${JSON.stringify(tool.name)}, which leaves nothing usable as a name segment.`,
        );
      }
      const registered = bridgedToolName(state.spec.name, segment);
      if (next.has(registered)) {
        // Folding two of the server's names into one registered name would
        // make the second silently answer calls meant for the first —
        // refused, the same reason any collision is.
        throw new McpConfigError(
          `MCP server ${state.spec.name} advertises two tools that both bridge to ${registered} (one of them ${JSON.stringify(tool.name)}). Rename one on the server.`,
        );
      }
      next.set(registered, {
        mcpName: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(isObject(tool.inputSchema) ? { parameters: tool.inputSchema as JsonObject } : {}),
      });
    }

    for (const registered of state.tools.keys()) {
      if (!next.has(registered)) {
        view.unregister(registered);
        log(`mcp server ${state.spec.name} no longer advertises ${registered} — unregistered; souls allowlisting it select nothing until it returns`);
      }
    }
    for (const [registered, info] of next) {
      const existing = state.tools.get(registered);
      const changed = existing !== undefined
        && (existing.mcpName !== info.mcpName
          || existing.description !== info.description
          || JSON.stringify(existing.parameters) !== JSON.stringify(info.parameters));
      if (existing !== undefined && !changed) {
        // The identical descriptor keeps its identity across the
        // reconnect, on purpose: the proxy's staleness check compares the
        // object it captured against this map, and only an actual change
        // may fail a call that was issued — or approved — before it.
        next.set(registered, existing);
        continue;
      }
      if (changed) {
        view.unregister(registered);
      }
      try {
        view.register(proxyTool(state, registered, info));
      } catch (error) {
        // On first connect this is a load-time refusal and propagates; on
        // reconnect there is no load to refuse, so the one colliding tool
        // is skipped, named, and everything else keeps working.
        if (firstConnect) {
          throw error;
        }
        next.delete(registered);
        warn(`mcp server ${state.spec.name}: ${registered} was not registered: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!firstConnect) {
        log(`mcp server ${state.spec.name} ${changed ? 'changed' : 'added'} ${registered}${changed ? '' : ' — an allowlist naming mcp.' + state.spec.name + '.* now grants it'}`);
      }
    }
    state.tools = next;
  };

  /**
   * Treat a server whose connection failed mid-call as down: further calls
   * refuse with "not connected" instead of re-sending into a dead session,
   * and the reconnect loop brings it back. The onclose handler is keyed to
   * `state.client`, already cleared here, so closing cannot schedule a
   * second reconnect.
   */
  const dropConnection = (state: ServerState, cause: unknown): void => {
    const client = state.client;
    if (!client || disposed) {
      return;
    }
    state.client = undefined;
    state.connected = false;
    warn(
      `mcp server ${state.spec.name} connection failed mid-call — its tools are unavailable until it reconnects: `
      + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    void client.close().catch(() => {});
    scheduleReconnect(state);
  };

  const scheduleReconnect = (state: ServerState): void => {
    if (disposed || state.timer !== undefined || state.connecting) {
      return;
    }
    const delay = delayFor(state.attempt);
    state.attempt += 1;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void connect(state, false).catch((error) => {
        warn(`mcp server ${state.spec.name} reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
        scheduleReconnect(state);
      });
    }, delay);
    // A daemon holds the process open anyway; a one-shot CLI run must not
    // be kept alive by a server that is never coming back.
    state.timer.unref?.();
  };

  const connect = async (state: ServerState, firstConnect: boolean): Promise<void> => {
    if (disposed || state.connecting) {
      return;
    }
    state.connecting = true;
    try {
      const transport = await (options.transportFor ?? buildTransport)(state.spec);
      // `disposed` is re-checked after every await from here on: dispose()
      // closes state.client, and a connect still in flight when it runs —
      // one server's load failing while another is mid-handshake — would
      // otherwise finish afterwards and strand a connected client, which
      // for a stdio server is an orphaned subprocess holding granted env.
      if (disposed) {
        await transport.close().catch(() => {});
        return;
      }
      // Tracked from here until the connect settles (the finally below),
      // so dispose() can cut a handshake short instead of waiting for
      // these awaits to notice `disposed` on their own.
      state.pending = transport;
      const client = new Client({ name: '@stratusagent/plugin-mcp', version: PLUGIN_MCP_VERSION });
      // A close that lands before this client is published cannot be
      // dropped: the identity guard below would discard it, and connect()
      // would then mark an already-closed client connected — leaving the
      // first tool call to fail for nothing and recovery to the call-path
      // classifier.
      let closedBeforePublish = false;
      client.onclose = () => {
        if (disposed) {
          return;
        }
        if (state.client !== client) {
          closedBeforePublish = true;
          return;
        }
        state.connected = false;
        state.client = undefined;
        warn(`mcp server ${state.spec.name} disconnected — its tools are unavailable until it comes back`);
        scheduleReconnect(state);
      };
      // One deadline for the handshake and the whole discovery walk — see
      // listAllTools for why the walk must not get a fresh budget per page.
      const clock = options.now ?? Date.now;
      const deadline = clock() + state.spec.connectTimeoutMs;
      await client.connect(transport, { timeout: state.spec.connectTimeoutMs });
      try {
        const advertised = await listAllTools(client, state.spec, () => deadline - clock());
        if (disposed) {
          throw new Error(`disposed while discovering ${state.spec.name}`);
        }
        if (closedBeforePublish) {
          throw new Error(`MCP server ${state.spec.name} closed the connection during discovery.`);
        }
        syncTools(state, advertised, firstConnect);
      } catch (error) {
        // The client is connected but not yet stored, so nothing else will
        // ever close it — for a stdio server that is a spawned subprocess
        // left running. Let go before reporting the failure.
        await client.close().catch(() => {});
        throw error;
      }
      state.client = client;
      state.connected = true;
      state.attempt = 0;
      log(`mcp server ${state.spec.name} connected — ${state.tools.size} tool${state.tools.size === 1 ? '' : 's'} under mcp.${state.spec.name}.*`);
      options.onConnected?.(state.spec.name);
    } finally {
      state.connecting = false;
      state.pending = undefined;
    }
  };

  return {
    name: '@stratusagent/plugin-mcp',

    async setup(context) {
      view = context.tools;
      await Promise.all(states.map(async (state) => {
        try {
          await connect(state, true);
        } catch (error) {
          // A configuration or trust refusal fails the plugin at load; a
          // server that is merely unreachable must not — the daemon goes
          // on serving every other agent, and this server's tools appear
          // when it does.
          if (error instanceof McpConfigError || (error as Error | undefined)?.name === 'PluginManifestError') {
            throw error;
          }
          warn(
            `mcp server ${state.spec.name} is unreachable — starting without its tools; they register when it comes back. `
            + `Check ${state.spec.command !== undefined ? `the command (${state.spec.command})` : `the endpoint (${state.spec.url})`} `
            + `under plugins["@stratusagent/plugin-mcp"].servers.${state.spec.name}. `
            + `(${error instanceof Error ? error.message : String(error)})`,
          );
          scheduleReconnect(state);
        }
      }));
    },

    async dispose() {
      disposed = true;
      await Promise.allSettled(states.map(async (state) => {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        // A connect still mid-handshake first: closing its transport kills
        // the child and rejects the in-flight awaits, so shutdown does not
        // wait out a connect timeout on a server that is never answering.
        const pending = state.pending;
        state.pending = undefined;
        await pending?.close().catch(() => {});
        const client = state.client;
        state.client = undefined;
        state.connected = false;
        await client?.close();
      }));
    },
  };
};

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = (config: JsonObject): Plugin => createMcpPlugin(config);
