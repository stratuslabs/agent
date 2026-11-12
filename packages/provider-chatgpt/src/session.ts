// Keeping a ChatGPT sign-in usable during a run: hands out the access token,
// and refreshes it shortly before it expires. The refresh token rotates and
// a spent one can't be used again, so every refresh runs under the session
// lock, which also holds across processes (the daemon and a foreground
// `stratus run` share one sign-in), rereads the record inside it, and saves
// the replacement before handing it out. Where the record lives and how the
// lock works belong to the caller; this file owns only the order of
// operations.
import { ChatGPTAuthError } from './errors.ts';
import { CHATGPT_PLAN_SCOPE, refreshTokens, type ChatGPTEndpoints, type ChatGPTSignIn } from './protocol.ts';

/** One signed-in ChatGPT account, as saved. JSON-safe. */
export interface ChatGPTSession {
  /** The issued `oaiapp_…` client ID, kept through sign-out for the next sign-in. */
  readonly clientId: string;
  /** The validated ID-token subject. */
  readonly subject: string;
  readonly email?: string;
  /** The latest ID token: the `id_token_hint` for signing in again. Cleared at sign-out. */
  readonly idToken?: string;
  /** Absent once the sign-in has ended. */
  readonly accessToken?: string;
  /** Absent once the sign-in has ended. */
  readonly refreshToken?: string;
  /** When the access token expires, in milliseconds since the epoch. */
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
  /** Milliseconds since the epoch. */
  readonly savedAt: number;
}

/** Where the session is kept. `write` replaces the whole record. */
export interface ChatGPTSessionStore {
  read(): Promise<ChatGPTSession | undefined>;
  write(session: ChatGPTSession): Promise<void>;
}

export interface ChatGPTTokenSourceOptions {
  /**
   * OpenAI's sign-in endpoints, or a function that finds them, asked only
   * when a refresh is due. A function that fails counts as a refresh that
   * failed for a reason other than the sign-in: the tokens are kept, and an
   * access token that hasn't run out still serves.
   */
  readonly endpoints: ChatGPTEndpoints | (() => Promise<ChatGPTEndpoints>);
  readonly store: ChatGPTSessionStore;
  /**
   * Runs `work` while nothing else changes the saved session, in this
   * process or any other that shares the store. Every write of the record
   * takes this lock: a refresh here, and a sign-in or sign-out elsewhere.
   * A write outside it can be overwritten by a refresh that read the record
   * before it.
   */
  readonly withSessionLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Refresh when the access token has this long left. Default five minutes. */
  readonly refreshBeforeMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface ChatGPTTokenSource {
  /**
   * A current access token, only for a sign-in that allows using the ChatGPT
   * plan. Throws a `ChatGPTAuthError`: `signin_required` when there is no
   * usable sign-in, `plan_usage_not_granted` when it doesn't allow plan usage
   * (OpenAI: don't proceed to inference then), `temporary` when a refresh is due but
   * OpenAI can't be reached and the token has run out, `storage_failed` when
   * the store or the lock fails, `cancelled` when the signal fires first.
   */
  accessToken(signal: AbortSignal | undefined): Promise<string>;
}

export const DEFAULT_REFRESH_BEFORE_MS = 5 * 60_000;

/** The record to save for a sign-in that `completeSignIn` validated. */
export const sessionFromSignIn = (signIn: ChatGPTSignIn): ChatGPTSession => ({
  clientId: signIn.clientId,
  subject: signIn.subject,
  ...(signIn.email !== undefined ? { email: signIn.email } : {}),
  idToken: signIn.idToken,
  accessToken: signIn.tokens.accessToken,
  refreshToken: signIn.tokens.refreshToken,
  expiresAt: signIn.tokens.expiresAt,
  scopes: signIn.tokens.scopes ?? [],
  savedAt: signIn.tokens.receivedAt,
});

const signInRequired = (): ChatGPTAuthError =>
  new ChatGPTAuthError('signin_required', 'Stratus is not signed in with ChatGPT on this install. Sign in with ChatGPT in `stratus setup`.');

const planUsageNotGranted = (): ChatGPTAuthError =>
  new ChatGPTAuthError(
    'plan_usage_not_granted',
    "This ChatGPT sign-in doesn't allow Stratus Agent to use your ChatGPT plan. Sign in with ChatGPT again in `stratus setup` and allow it, or use an OpenAI API key.",
  );

/** OpenAI's rule: no inference on a sign-in without the plan permission. */
const grantsPlanUsage = (session: ChatGPTSession): boolean => session.scopes.includes(CHATGPT_PLAN_SCOPE);

/**
 * A store or lock failure as `storage_failed`, so callers can branch on
 * `code` alone. The original error is only the cause, never message text:
 * a store's error may quote the record, tokens included. Our own errors,
 * which the work inside the lock throws, come through as they are.
 */
const storageFailed = (what: string, error: unknown): ChatGPTAuthError =>
  error instanceof ChatGPTAuthError ? error : new ChatGPTAuthError('storage_failed', `Couldn't ${what}.`, { cause: error });

const local = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw storageFailed(what, error);
  }
};

const cancelled = (signal: AbortSignal): ChatGPTAuthError =>
  new ChatGPTAuthError('cancelled', 'Getting the ChatGPT access token was cancelled.', { cause: signal.reason });

/**
 * Runs `work` and waits for it unless the signal fires first. The work
 * itself goes on: it checks the signal before it sends a refresh, but a
 * refresh already sent may have spent the old refresh token at OpenAI, so it
 * finishes and saves the replacement whether or not anyone still waits.
 */
const unlessCancelled = <T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
  if (signal === undefined) {
    return work();
  }
  if (signal.aborted) {
    return Promise.reject(cancelled(signal));
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work(), aborted]).finally(() => signal.removeEventListener('abort', onAbort));
};

export const createChatGPTTokenSource = (options: ChatGPTTokenSourceOptions): ChatGPTTokenSource => {
  const now = options.now ?? Date.now;
  const refreshBeforeMs = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
  const read = () => local('read the saved ChatGPT sign-in', () => options.store.read());
  const save = (session: ChatGPTSession) => local('save the ChatGPT sign-in', () => options.store.write(session));

  const usable = (session: ChatGPTSession | undefined): session is ChatGPTSession & { accessToken: string; refreshToken: string } =>
    session?.accessToken !== undefined && session.refreshToken !== undefined;
  const fresh = (session: ChatGPTSession & { accessToken: string }): boolean =>
    session.expiresAt !== undefined && session.expiresAt - now() > refreshBeforeMs;
  const unexpired = (session: ChatGPTSession): boolean => session.expiresAt !== undefined && session.expiresAt > now();

  const refreshUnderLock = async (signal: AbortSignal | undefined): Promise<string> => {
    // Another caller, here or in another process, may have refreshed while
    // this one waited, and the token it read before is spent.
    const current = await read();
    if (!usable(current)) {
      throw signInRequired();
    }
    if (!grantsPlanUsage(current)) {
      throw planUsageNotGranted();
    }
    if (fresh(current)) {
      return current.accessToken;
    }
    if (signal?.aborted === true) {
      throw cancelled(signal);
    }
    let tokens;
    try {
      // No signal once it's sent: see unlessCancelled.
      tokens = await refreshTokens({
        endpoints: typeof options.endpoints === 'function' ? await options.endpoints() : options.endpoints,
        clientId: current.clientId,
        refreshToken: current.refreshToken,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        now,
      });
    } catch (error) {
      if (error instanceof ChatGPTAuthError && error.code === 'signin_required') {
        // The refresh token is dead. Keep the account and the ID token, the
        // hint for signing in again; drop what can't be used.
        const { accessToken: _access, refreshToken: _refresh, expiresAt: _expiry, ...account } = current;
        await save({ ...account, savedAt: now() });
        throw error;
      }
      // Anything else leaves the refresh token as it was, so the current
      // access token serves out its last minutes and the next call tries again.
      if (unexpired(current)) {
        return current.accessToken;
      }
      throw error;
    }
    const replacement: ChatGPTSession = {
      ...current,
      ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      // A refresh that doesn't list scopes leaves the grant as it was.
      scopes: tokens.scopes ?? current.scopes,
      savedAt: tokens.receivedAt,
    };
    // Saved either way: the old refresh token is spent.
    await save(replacement);
    if (!grantsPlanUsage(replacement)) {
      throw planUsageNotGranted();
    }
    return tokens.accessToken;
  };

  return {
    accessToken: (signal) =>
      unlessCancelled(signal, async () => {
        const saved = await read();
        if (!usable(saved)) {
          throw signInRequired();
        }
        if (!grantsPlanUsage(saved)) {
          throw planUsageNotGranted();
        }
        if (fresh(saved)) {
          return saved.accessToken;
        }
        if (signal?.aborted === true) {
          throw cancelled(signal);
        }
        return local('take the ChatGPT sign-in lock', () => options.withSessionLock(() => refreshUnderLock(signal)));
      }),
  };
};
