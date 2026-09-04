import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseCommandScope, sameScope, type CommandScope } from './commands.ts';
import { parseOriginScope, sameOriginScope, type OriginScope } from './origins.ts';

/**
 * What one agent may run unattended, beyond the built-in safe list.
 *
 * Per agent, because "always allow" is an answer about one identity's work
 * — a scope somebody granted Ava in a repository of theirs is not a scope
 * Juno inherits, and neither is a site.
 */
export interface CommandWhitelistStore {
  scopesFor(agentId: string): Promise<CommandScope[]>;
  remember(agentId: string, scope: CommandScope): Promise<void>;
}

/**
 * Which origins one agent may act on unattended — `commandFor`'s half of
 * the same file, for `originFor`.
 *
 * A separate interface rather than two more methods on the one above,
 * because they are separate answers: a host that judges commands need not
 * judge browser actions, and `createFileCommandWhitelist` returns one
 * object satisfying both because there is one file and an operator should
 * have one place to look.
 */
export interface OriginWhitelistStore {
  originsFor(agentId: string): Promise<OriginScope[]>;
  rememberOrigin(agentId: string, scope: OriginScope): Promise<void>;
}

interface WhitelistFile {
  version: number;
  scopes: CommandScope[];
  /**
   * Optional, and the version stays 1 deliberately: a daemon that predates
   * origin scopes reads a file carrying them as a file of command scopes,
   * which is exactly right — it has no `browser.act` to judge with them.
   */
  origins?: OriginScope[];
}

const WHITELIST_VERSION = 1;

/** What one agent's file grants, as this store holds it in memory. */
interface Grants {
  scopes: CommandScope[];
  origins: OriginScope[];
}

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
 * The persistent tier of the scope resolution, on disk — both kinds of
 * grant, in one file per agent.
 *
 * Written `0600` with an explicit `chmod`, like every other file in
 * `~/.stratus` that decides something: this one lists commands that run,
 * and sites that get clicked on, with nobody watching — so another account
 * on the machine appending a line to it is the whole permission engine
 * defeated. `writeFile`'s mode only applies when it creates the file, so
 * an upgrade over a looser install would otherwise keep the old
 * permissions.
 *
 * Scopes are cached in memory once read. A daemon therefore does not notice
 * a hand-edited file until it restarts — which is the right way round for a
 * file whose edits grant permissions, and the same bargain the credential
 * store makes.
 */
export const createFileCommandWhitelist = (options: {
  directory: string;
  /**
   * Where to say that a whitelist exists but could not be read. Once per
   * agent per process; a host that omits it gets the same behavior with
   * no line about it.
   */
  warn?: (line: string) => void;
}): CommandWhitelistStore & OriginWhitelistStore => {
  /**
   * One read per agent per process, shared by everyone who asks — as a
   * promise, so two sessions asking for the same agent at once share the
   * read in flight rather than each missing an empty cache, each failing,
   * and each warning.
   *
   * Both grant lists come out of one read, because they come out of one
   * file: reading it twice would give a shell call and a browser call
   * different views of a file somebody edited between them.
   */
  const cache = new Map<string, Promise<Grants>>();
  /** Files that exist and could not be read, by agent — never written over. */
  const unreadable = new Map<string, string>();

  const read = (agentId: string): Promise<Grants> => {
    const cached = cache.get(agentId);
    if (cached) {
      return cached;
    }
    const reading = readFresh(agentId);
    cache.set(agentId, reading);
    return reading;
  };

  const readFresh = async (agentId: string): Promise<Grants> => {
    let scopes: CommandScope[] = [];
    let origins: OriginScope[] = [];
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
      origins = Array.isArray(parsed.origins)
        ? parsed.origins.map(parseOriginScope).filter((scope): scope is OriginScope => scope !== undefined)
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
      origins = [];
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const reason = error instanceof Error ? error.message : String(error);
        unreadable.set(agentId, reason);
        options.warn?.(
          `${file} could not be read (${reason}); its scopes are ignored and "always" answers for ${agentId} `
            + 'are not saved over it until it is fixed and the daemon restarted.',
        );
      }
    }
    return { scopes, origins };
  };

  /**
   * Both lists, always — a write of one carries the other through
   * untouched. Persisting only the half that changed would drop the other
   * half of a file this daemon had read and understood, which is the same
   * data loss the unreadable-file guard above exists to prevent.
   */
  const save = async (agentId: string, grants: Grants): Promise<void> => {
    cache.set(agentId, Promise.resolve(grants));
    await mkdir(options.directory, { recursive: true });
    const file: WhitelistFile = {
      version: WHITELIST_VERSION,
      scopes: grants.scopes,
      ...(grants.origins.length > 0 ? { origins: grants.origins } : {}),
    };
    const target = whitelistPathFor(options.directory, agentId);
    await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(target, 0o600);
  };

  /**
   * Read-modify-write runs one at a time per agent.
   *
   * Every grant is "read what is there, add one, write it all back", and
   * the read yields — so two answers settling together both saw the file
   * before either changed it, and the second write drops the first grant.
   * It bites hardest across the two kinds now that one file holds both: a
   * shell "always" and a browser "always" resolved in the same moment, and
   * whichever landed second silently deleted the other agent's site grant.
   * Serializing also means only one `writeFile` is ever open on the file,
   * so two overlapping writes cannot leave a mixed one behind.
   *
   * A queue, like the browser pool's admission: the work is short, and the
   * alternative (reserving and unwinding) is the same serialization with
   * more ways to leak a reservation. The tail swallows failures, so one
   * grant that throws does not reject every grant queued behind it — the
   * caller still sees its own rejection, because that is `queued`.
   */
  const writes = new Map<string, Promise<unknown>>();

  const serialized = <T>(agentId: string, work: () => Promise<T>): Promise<T> => {
    const queued = (writes.get(agentId) ?? Promise.resolve()).then(work, work);
    writes.set(agentId, queued.then(() => undefined, () => undefined));
    return queued;
  };

  /** Nothing is written over a grant list nobody could read. */
  const refuseIfUnreadable = (agentId: string): void => {
    const reason = unreadable.get(agentId);
    if (reason !== undefined) {
      throw new WhitelistUnreadableError(whitelistPathFor(options.directory, agentId), reason);
    }
  };

  return {
    async scopesFor(agentId) {
      return [...(await read(agentId)).scopes];
    },
    async remember(agentId, scope) {
      // The read is inside the queue, not before it: a grant that started
      // from a snapshot taken before the one ahead of it saved would write
      // that one back out of existence, which is the whole race.
      return serialized(agentId, async () => {
        const grants = await read(agentId);
        refuseIfUnreadable(agentId);
        if (grants.scopes.some((existing) => sameScope(existing, scope))) {
          return;
        }
        await save(agentId, { ...grants, scopes: [...grants.scopes, scope] });
      });
    },
    async originsFor(agentId) {
      return [...(await read(agentId)).origins];
    },
    async rememberOrigin(agentId, scope) {
      return serialized(agentId, async () => {
        const grants = await read(agentId);
        refuseIfUnreadable(agentId);
        if (grants.origins.some((existing) => sameOriginScope(existing, scope))) {
          return;
        }
        await save(agentId, { ...grants, origins: [...grants.origins, scope] });
      });
    },
  };
};
