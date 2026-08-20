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
export const createFileCommandWhitelist = (options: { directory: string }): CommandWhitelistStore => {
  const cache = new Map<string, CommandScope[]>();

  const read = async (agentId: string): Promise<CommandScope[]> => {
    const cached = cache.get(agentId);
    if (cached) {
      return cached;
    }
    let scopes: CommandScope[] = [];
    try {
      // The agent id is a validated invariant by the time it reaches any
      // path join (see 03) — it is a single path segment or it was refused
      // at the parse boundary, so this does not re-check it.
      const raw = await readFile(whitelistPathFor(options.directory, agentId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<WhitelistFile>;
      scopes = Array.isArray(parsed.scopes)
        ? parsed.scopes.map(parseCommandScope).filter((scope): scope is CommandScope => scope !== undefined)
        : [];
    } catch {
      // No whitelist, or one that will not parse. Both mean the same thing
      // to a caller — no stored scopes — and neither is worth failing a
      // turn over: the fallback is asking a human, which is where an agent
      // with no whitelist starts anyway.
      scopes = [];
    }
    cache.set(agentId, scopes);
    return scopes;
  };

  return {
    async scopesFor(agentId) {
      return [...(await read(agentId))];
    },
    async remember(agentId, scope) {
      const scopes = await read(agentId);
      if (scopes.some((existing) => sameScope(existing, scope))) {
        return;
      }
      const updated = [...scopes, scope];
      cache.set(agentId, updated);
      await mkdir(options.directory, { recursive: true });
      const file: WhitelistFile = { version: WHITELIST_VERSION, scopes: updated };
      const target = whitelistPathFor(options.directory, agentId);
      await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await chmod(target, 0o600);
    },
  };
};
