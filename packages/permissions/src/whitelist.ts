import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseCommandScope, sameScope, type CommandScope } from './commands.ts';

/**
 * What one agent may run unattended, beyond the built-in safe list.
 *
 * Per agent, because "always allow" is an answer about one identity's work
 * — a scope somebody granted Ava in a repository of theirs is not a scope
 * Juno inherits.
 */
export interface CommandWhitelistStore {
  scopesFor(agentId: string): Promise<CommandScope[]>;
  remember(agentId: string, scope: CommandScope): Promise<void>;
}

interface WhitelistFile {
  version: number;
  scopes: CommandScope[];
}

const WHITELIST_VERSION = 1;

/** `<id>.whitelist.json`, beside the agent's soul in ~/.stratus/agents. */
export const whitelistPathFor = (directory: string, agentId: string): string =>
  path.join(directory, `${agentId}.whitelist.json`);

/**
 * Thrown by `remember` for an agent whose whitelist exists but could not be
 * read. The policy catches it by type: the answer still holds for the
 * session, and the log says why it was not saved.
 */
export class WhitelistUnreadableError extends Error {
  constructor(file: string, reason: string) {
    super(`${file} could not be read (${reason}), so nothing is written over it. Fix the file and restart the daemon.`);
    this.name = 'WhitelistUnreadableError';
  }
}

/**
 * The persistent half of the three-tier resolution, on disk.
 *
 * Written `0600` with an explicit `chmod`, like every other file in
 * `~/.stratus` that decides something: this one lists commands that run
 * with nobody watching, so another account on the machine appending a line
 * to it is the whole permission engine defeated. `writeFile`'s mode only
 * applies when it creates the file, so an upgrade over a looser install
 * would otherwise keep the old permissions.
 *
 * Scopes are cached in memory once read. A daemon therefore does not notice
 * a hand-edited file until it restarts — which is the right way round for a
 * file whose edits grant permissions, and the same bargain the credential
 * store makes.
 */
/**
 * A read failure in words that carry none of the file. Node's JSON parser
 * quotes the offending excerpt in its message, and a whitelist argument
 * can be a URL with a credential in it — the daemon log is a trace, never
 * a second copy of what an agent was handed, and the decision line
 * carries this text too. The position survives; the bytes do not.
 */
const describeReadFailure = (error: unknown): string => {
  if (error instanceof SyntaxError) {
    const at = /position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(error.message);
    return at
      ? `not valid JSON at position ${at[1]}${at[2] ? ` (line ${at[2]} column ${at[3]})` : ''}`
      : 'not valid JSON';
  }
  return error instanceof Error ? error.message : String(error);
};

export const createFileCommandWhitelist = (options: {
  directory: string;
  /**
   * Where to say that a whitelist exists but could not be read. Once per
   * agent per process; a host that omits it gets the same behavior with
   * no line about it.
   */
  warn?: (line: string) => void;
}): CommandWhitelistStore => {
  /**
   * One read per agent per process, shared by everyone who asks — as a
   * promise, so two sessions asking for the same agent at once share the
   * read in flight rather than each missing an empty cache, each failing,
   * and each warning.
   */
  const cache = new Map<string, Promise<CommandScope[]>>();
  /** Files that exist and could not be read, by agent — never written over. */
  const unreadable = new Map<string, string>();

  const read = (agentId: string): Promise<CommandScope[]> => {
    const cached = cache.get(agentId);
    if (cached) {
      return cached;
    }
    const reading = readFresh(agentId);
    cache.set(agentId, reading);
    return reading;
  };

  const readFresh = async (agentId: string): Promise<CommandScope[]> => {
    let scopes: CommandScope[] = [];
    // The agent id is a validated invariant by the time it reaches any
    // path join (see 03) — it is a single path segment or it was refused
    // at the parse boundary, so this does not re-check it.
    const file = whitelistPathFor(options.directory, agentId);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WhitelistFile>;
      scopes = Array.isArray(parsed.scopes)
        ? parsed.scopes.map(parseCommandScope).filter((scope): scope is CommandScope => scope !== undefined)
        : [];
    } catch (error) {
      // No whitelist means no stored scopes, and is not worth failing a
      // turn over: the fallback is asking a human, which is where an agent
      // with no whitelist starts anyway. A whitelist that exists and will
      // not read is the same to this call and not the same to the file:
      // one hand-edited comma made a grant list read as empty with no line
      // about it, and the next "always" wrote a single new scope over
      // every grant it held. So it is said once, and `remember` refuses.
      scopes = [];
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const reason = describeReadFailure(error);
        unreadable.set(agentId, reason);
        options.warn?.(
          `${file} could not be read (${reason}); its scopes are ignored and "always" answers for ${agentId} `
            + 'are not saved over it until it is fixed and the daemon restarted.',
        );
      }
    }
    return scopes;
  };

  return {
    async scopesFor(agentId) {
      return [...(await read(agentId))];
    },
    async remember(agentId, scope) {
      const scopes = await read(agentId);
      const reason = unreadable.get(agentId);
      if (reason !== undefined) {
        throw new WhitelistUnreadableError(whitelistPathFor(options.directory, agentId), reason);
      }
      if (scopes.some((existing) => sameScope(existing, scope))) {
        return;
      }
      const updated = [...scopes, scope];
      cache.set(agentId, Promise.resolve(updated));
      await mkdir(options.directory, { recursive: true });
      const file: WhitelistFile = { version: WHITELIST_VERSION, scopes: updated };
      const target = whitelistPathFor(options.directory, agentId);
      await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await chmod(target, 0o600);
    },
  };
};
