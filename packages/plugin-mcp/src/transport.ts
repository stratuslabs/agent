/*
 * The transport to one server, and what its failures mean. A stdio server
 * is spawned from a resolved command path with only the environment it was
 * granted; an HTTP server gets a Streamable HTTP client. Errors are cut to a
 * length that cannot carry a payload before they reach the log, and a failed
 * call is classified as a lost connection or a live one.
 */
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { accessSync, constants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { grantedEntry, type McpServerSpec, pathGrant } from './config.ts';

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
/**
 * An error's text, cut to a length that cannot be a payload. Every error
 * this plugin forwards to the host's log goes through here, because the
 * SDK's messages carry bodies: a Streamable HTTP POST that fails quotes the
 * whole response text, and the log this now reaches is `stratusd.jsonl`,
 * which rotates at 8 MB and is what people paste into issues.
 */
const ERROR_TEXT_MAX_CHARS = 200;

export const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > ERROR_TEXT_MAX_CHARS ? `${message.slice(0, ERROR_TEXT_MAX_CHARS)}…` : message;
};

/**
 * The transport's error text, with the two the operator needs translated.
 * The SDK's stdio reader refuses a single JSON-RPC message over its buffer
 * limit (10 MB unless the transport is built with another) and closes the
 * connection; its wording names the buffer, not the reply that overflowed
 * it, and nothing about it says the server has to change. A reply that is
 * not JSON fails to parse with the text quoted in the error — for a stdio
 * server that is its stray logging on stdout, for an HTTP server a body
 * that was not JSON-RPC — and neither belongs in the daemon log or an
 * agent's error text.
 */
/**
 * The limit a stdio reader overflow names, or undefined for any other
 * error. Only a stdio server has the reader; an HTTP error quoting a body
 * that happens to contain the phrase is a body, and is bounded like one.
 * The digits are bounded too, so a match can never carry more than a
 * number. This is the one transport error the SDK follows with a close of
 * its own — see `ServerState.closeCause`.
 */
export const stdioOverflowBytes = (error: unknown, spec: McpServerSpec): string | undefined => {
  if (spec.command === undefined) {
    return undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^ReadBuffer exceeded maximum size of (\d{1,15}) bytes$/.exec(message)?.[1];
};

/**
 * An endpoint as the log may carry it: the origin and nothing else. A
 * credential can sit in the userinfo, in a query value, or in a path
 * segment (`https://host/mcp/<token>` is a common shape), and the log is
 * what people paste into issues. The origin is enough to tell one server
 * from another, and the line names the config block for the rest.
 */
export const describeEndpoint = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '<unparseable url>';
  }
};

/**
 * Whole log lines are bounded, not only the error text inside them — a
 * remote server chooses its tool names, and one name can be as long as
 * the server likes.
 */
const LOG_LINE_MAX_CHARS = 1000;

export const boundedSink = (sink: (message: string) => void) => (message: string): void => {
  sink(message.length > LOG_LINE_MAX_CHARS ? `${message.slice(0, LOG_LINE_MAX_CHARS)}…` : message);
};

export const describeTransportError = (error: unknown, spec: McpServerSpec): string => {
  const overflow = stdioOverflowBytes(error, spec);
  if (overflow !== undefined) {
    return `the server sent a single message larger than the ${overflow}-byte stdio limit, and the connection was closed. `
      + 'A result that large has to come back smaller — paged, summarized, or written to a file.';
  }
  if (error instanceof SyntaxError) {
    return spec.command !== undefined
      ? 'the server wrote a line to stdout that is not JSON-RPC — its own logging belongs on stderr.'
      : 'the server answered with a body that is not valid JSON-RPC.';
  }
  return describeError(error);
};

export const isConnectionFailure = (error: unknown): boolean =>
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
export const sealedStdioEnv = (
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
export const resolveCommandPath = (
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

export const buildTransport = (spec: McpServerSpec): Transport => {
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
