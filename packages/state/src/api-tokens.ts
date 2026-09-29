import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StateEnvironment } from './environment.ts';
import { apiTokensPath, stratusHomePath } from './paths.ts';

/**
 * What a control API token may do. `operator` is the gateway token file and
 * nothing else; this file only ever holds `member`s, the least-privileged
 * role — see the control API README for what each may reach.
 */
export type ApiTokenRole = 'operator' | 'member';

/** One member token as stored: enough to recognise it, never enough to be it. */
export interface ApiTokenRecord {
  /** `tok_` plus 12 hex characters: what `stratus token revoke` and an audit trail name. */
  id: string;
  /** Who holds it. Recorded on every approval it answers, as `api:<name>`. */
  name: string;
  role: 'member';
  /** sha256 of the token, hex. */
  hash: string;
  /** ISO 8601. */
  createdAt: string;
}

interface ApiTokensFile {
  version: 1;
  tokens: ApiTokenRecord[];
}

/**
 * Every member token starts with this, so one pasted into a log, a chat, or
 * a secret scanner's input is recognisable for what it is — and so it can
 * never be mistaken for the operator token, which has no prefix.
 */
export const API_TOKEN_PREFIX = 'stm_';

/**
 * Letters, digits, dots, dashes, and underscores, starting with a letter or
 * digit, at most 64. No colon: the name lands after one in an approval's
 * recorded actor (`api:<name>`), and a name holding its own would read as a
 * different source.
 */
export const API_TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const API_TOKEN_ID_PATTERN = /^tok_[0-9a-f]{12}$/;

/**
 * The only form a token is ever stored or compared in.
 *
 * A plain sha256, not a password hash: the input is 32 bytes from the
 * CSPRNG, so there is nothing for a slow hash to protect against a guess —
 * the search space is the token's own entropy either way.
 */
export const hashApiToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const isRecord = (value: unknown): value is ApiTokenRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && API_TOKEN_ID_PATTERN.test(entry.id)
    && typeof entry.name === 'string' && API_TOKEN_NAME_PATTERN.test(entry.name)
    // Only a member. A file entry claiming any other role is skipped rather
    // than honoured: the operator token is the gateway token file, and a
    // line in this one must never be a way to mint a second.
    && entry.role === 'member'
    && typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash)
    && typeof entry.createdAt === 'string';
};

/**
 * The member tokens this home accepts, or none when the file does not exist.
 *
 * Throws on a file that is not the documented shape, naming it: the daemon
 * reads that as "no member is authenticated" (the operator token does not
 * depend on this file, so nobody is locked out of fixing it), and a
 * `stratus token` command must not write over a file it could not read.
 * Entries that are individually malformed are dropped — each one fails
 * closed on its own.
 */
export const loadApiTokens = async (env: StateEnvironment): Promise<ApiTokenRecord[]> => {
  const filePath = apiTokensPath(env);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${filePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}). `
      + 'Fix or delete it; deleting it revokes every member token.',
    );
  }
  const document = parsed as Partial<ApiTokensFile> | null;
  if (typeof document !== 'object' || document === null || Array.isArray(document) || !Array.isArray(document.tokens)) {
    throw new Error(`${filePath} must hold { "version": 1, "tokens": [...] }. Fix or delete it; deleting it revokes every member token.`);
  }
  if (document.version !== 1) {
    throw new Error(
      `${filePath} is version ${JSON.stringify(document.version)}, which this build does not read. `
      + 'It was written by a newer stratus; upgrade this one with `stratus update`.',
    );
  }
  return document.tokens.filter(isRecord);
};

/**
 * Written beside the destination, tightened, then renamed over it — the
 * same sequence the credentials file uses and for the same two reasons: a
 * running daemon reads this file on every member request, and must see the
 * old list or the new one, never a truncated half; and the destination must
 * never exist at a looser mode, even briefly, which `writeFile`'s mode
 * (applied only on create) cannot promise alone.
 *
 * Not locked across processes. Two `stratus token` commands racing can
 * lose one another's write, as two `stratus credential` commands can; the
 * daemon never writes this file, so it is not one of the racers.
 */
const saveApiTokens = async (env: StateEnvironment, tokens: ApiTokenRecord[]): Promise<void> => {
  const filePath = apiTokensPath(env);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // The home holds every other secret too; an install that predates the
  // tightening must not leave this one reachable through a loose parent.
  await chmod(stratusHomePath(env), 0o700).catch(() => undefined);
  const temporary = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  const document: ApiTokensFile = { version: 1, tokens };
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/**
 * Mint a member token and store its hash. The token itself is returned
 * exactly once, here, and exists nowhere after the caller drops it.
 */
export const createApiToken = async (
  env: StateEnvironment,
  request: { name: string; role?: ApiTokenRole; now?: () => Date },
): Promise<{ token: string; record: ApiTokenRecord }> => {
  const { name } = request;
  if (request.role !== undefined && request.role !== 'member') {
    throw new Error(
      `A ${request.role} token cannot be created here. The operator token is ~/.stratus/gateway-token, and there is exactly one; `
      + 'api-tokens.json holds member tokens only.',
    );
  }
  if (!API_TOKEN_NAME_PATTERN.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a token name. Use letters, digits, dots, dashes, or underscores, `
      + 'starting with a letter or digit, at most 64 characters: alice, ci-bot, tenant.acme.',
    );
  }
  if (API_TOKEN_ID_PATTERN.test(name)) {
    // `revoke` takes an id or a name, and a name spelled like an id would
    // make which one it meant a guess.
    throw new Error(`${JSON.stringify(name)} is spelled like a token id. Pick a name that names who holds it.`);
  }
  const tokens = await loadApiTokens(env);
  const folded = name.toLowerCase();
  // Case-insensitively: the name is how an approval record says who
  // decided, and `Alice` and `alice` would read as one person.
  const taken = tokens.find((entry) => entry.name.toLowerCase() === folded);
  if (taken) {
    throw new Error(
      `A token named ${taken.name} already exists (${taken.id}). Pick another name, or revoke that one first: stratus token revoke ${taken.id}.`,
    );
  }
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const record: ApiTokenRecord = {
    id: `tok_${randomBytes(6).toString('hex')}`,
    name,
    role: 'member',
    hash: hashApiToken(token),
    createdAt: (request.now?.() ?? new Date()).toISOString(),
  };
  await saveApiTokens(env, [...tokens, record]);
  return { token, record };
};

/**
 * Remove a member token by id, or by name when no id matches. Returns what
 * was removed, or undefined when nothing matched. A running daemon refuses
 * the token, and every browser session opened with it, from its next
 * request — it reads this file per request rather than caching it.
 */
export const revokeApiToken = async (env: StateEnvironment, idOrName: string): Promise<ApiTokenRecord | undefined> => {
  const tokens = await loadApiTokens(env);
  const folded = idOrName.toLowerCase();
  const target = tokens.find((entry) => entry.id === idOrName)
    ?? tokens.find((entry) => entry.name.toLowerCase() === folded);
  if (!target) {
    return undefined;
  }
  await saveApiTokens(env, tokens.filter((entry) => entry.id !== target.id));
  return target;
};
