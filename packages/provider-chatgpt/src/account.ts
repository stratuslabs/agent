// Signing this install in and out of ChatGPT: the protocol steps joined
// with the saved sign-in document and its lock. Setup calls these and
// decides how to show the browser URL; nothing here prints or opens one.
//
// One ChatGPT account per install for now. OpenAI's rule for several is that
// a sign-in never overwrites another account registration's credentials, so
// a new account replaces the saved one only once it is signed out, and a
// sign-in that finds a different account signed in when it saves is refused.
import { ChatGPTAuthError } from './errors.ts';
import { listenForCallback } from './loopback.ts';
import {
  completeSignIn,
  createSignInAttempt,
  discoverEndpoints,
  revokeRefreshToken,
  type ChatGPTEndpoints,
  type RequestOptions,
  type ReturningAccount,
  type RevokeOptions,
  type RevokeResult,
} from './protocol.ts';
import { sessionFromSignIn, storageFailed, type ChatGPTSession } from './session.ts';
import { createChatGPTSessionStore, ensureChatGPTHostId, type ChatGPTSignInDocument } from './session-file.ts';

export interface ChatGPTAccountOptions extends RequestOptions {
  /** The saved sign-in (in Stratus, state's `createChatGPTSignInFile`). */
  readonly document: ChatGPTSignInDocument;
  /** The lock every process that reads or writes the document shares. */
  readonly withSessionLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Read from OpenAI's sign-in configuration when left out. */
  readonly endpoints?: ChatGPTEndpoints;
  readonly now?: () => number;
}

export interface SignInWithChatGPTOptions extends ChatGPTAccountOptions {
  /**
   * Shows the user the sign-in page: open a browser, print the URL, or both.
   * Called once, after the callback listener is waiting. On a returning
   * sign-in the URL carries the saved ID token as `id_token_hint`, so never
   * log it.
   */
  readonly openUrl: (url: string) => void | Promise<void>;
  /**
   * `saved` (the default) signs the saved account in again with its issued
   * client ID, or registers a first one when there is none. `new` registers a
   * new client for another account, which takes the saved account's place,
   * so it is refused while that one is signed in.
   */
  readonly account?: 'saved' | 'new';
  /** Callback ports to try, in order. Default: 1455, then any free port. */
  readonly ports?: readonly number[];
  /** How long to wait for the browser. Default: the listener's, 5 minutes. */
  readonly timeoutMs?: number;
}

/** What a sign-in tells setup. No tokens: those stay in the document. */
export interface ChatGPTSignInOutcome {
  readonly email?: string;
  readonly subject: string;
  /** A new client was registered (a first sign-in, or `account: 'new'`). */
  readonly registered: boolean;
  /**
   * Whether the user let Stratus use their ChatGPT plan. A sign-in without
   * it is saved, but no turn runs on it until they sign in again and allow it.
   */
  readonly planUsage: boolean;
  /** When the access token expires; it refreshes on its own before then. */
  readonly expiresAt: number;
}

export interface SignOutOfChatGPTOptions extends ChatGPTAccountOptions {
  /** Revocation tries, counting the first. Default 3. */
  readonly attempts?: number;
  readonly wait?: RevokeOptions['wait'];
}

export interface ChatGPTSignOutOutcome {
  /** There were tokens to clear. */
  readonly signedOut: boolean;
  readonly email?: string;
  /**
   * Present when there was a refresh token to revoke. When `confirmed` is
   * false the tokens were cleared anyway, and the user can disconnect the
   * app in ChatGPT's settings.
   */
  readonly revocation?: RevokeResult;
}

const holdsTokens = (session: ChatGPTSession): boolean =>
  session.accessToken !== undefined || session.refreshToken !== undefined;

const sameRegistration = (a: ChatGPTSession, b: { readonly clientId: string; readonly subject: string }): boolean =>
  a.clientId === b.clientId && a.subject === b.subject;

const alreadySignedIn = (session: ChatGPTSession): ChatGPTAuthError =>
  new ChatGPTAuthError(
    'signed_in',
    `This install is signed in with ChatGPT as ${session.email ?? 'another account'}. Sign out first to use a different account.`,
  );

const cancelled = (signal: AbortSignal): ChatGPTAuthError =>
  new ChatGPTAuthError('cancelled', 'The ChatGPT sign-in was cancelled.', { cause: signal.reason });

/** Runs a read, write or lock, with any failure that isn't ours as `storage_failed`. */
const local = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw storageFailed(what, error);
  }
};

const requestOptions = (options: RequestOptions): RequestOptions => ({
  ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  ...(options.signal !== undefined ? { signal: options.signal } : {}),
});

/**
 * Signs this install in with ChatGPT in the browser and saves the session.
 * The host ID is made and saved first, so every sign-in from this install
 * names the same host. The ID token is validated before anything is saved,
 * and the save happens under the session lock.
 */
export const signInWithChatGPT = async (options: SignInWithChatGPTOptions): Promise<ChatGPTSignInOutcome> => {
  const { document, withSessionLock, signal } = options;
  const now = options.now ?? Date.now;
  const store = createChatGPTSessionStore(document);
  if (signal?.aborted === true) {
    throw cancelled(signal);
  }

  const hostId = await local("save this install's ChatGPT host ID", () => ensureChatGPTHostId(document, withSessionLock));
  const saved = await local('read the saved ChatGPT sign-in', () => store.read());
  if (options.account === 'new' && saved !== undefined && holdsTokens(saved)) {
    throw alreadySignedIn(saved);
  }
  const account: ReturningAccount | undefined = options.account !== 'new' && saved !== undefined
    ? {
        clientId: saved.clientId,
        subject: saved.subject,
        ...(saved.idToken !== undefined ? { idToken: saved.idToken } : {}),
        ...(saved.email !== undefined ? { email: saved.email } : {}),
      }
    : undefined;
  const endpoints = options.endpoints ?? await discoverEndpoints(requestOptions(options));

  const listener = await listenForCallback(options.ports !== undefined ? { ports: options.ports } : {});
  let signIn;
  try {
    const attempt = createSignInAttempt({
      endpoints,
      hostId,
      redirectUri: listener.redirectUri,
      ...(account !== undefined ? { account } : {}),
    });
    // Waiting before the page opens: the listener turns away a callback
    // nobody is waiting for, and a browser can come back fast.
    const callback = listener.waitFor(attempt.state, {
      ...(signal !== undefined ? { signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    // If opening the page throws, closing the listener rejects this wait,
    // and nobody is left to see it.
    callback.catch(() => undefined);
    await options.openUrl(attempt.url);
    signIn = await completeSignIn({ ...requestOptions(options), endpoints, attempt, callback: await callback, now });
  } finally {
    await listener.close();
  }

  const session = sessionFromSignIn(signIn);
  await local('save the ChatGPT sign-in', () =>
    withSessionLock(async () => {
      // Another setup may have signed a different account in while the
      // browser was open. Its tokens are never overwritten.
      const current = await store.read();
      if (current !== undefined && holdsTokens(current) && !sameRegistration(current, session)) {
        throw alreadySignedIn(current);
      }
      await store.write(session);
    }),
  );
  return {
    ...(signIn.email !== undefined ? { email: signIn.email } : {}),
    subject: signIn.subject,
    registered: account === undefined,
    planUsage: signIn.planUsage,
    expiresAt: signIn.tokens.expiresAt,
  };
};

/**
 * Signs this install out of ChatGPT, as OpenAI asks: under the session lock,
 * so no refresh runs meanwhile, it revokes the saved refresh token, then
 * clears the access, refresh and ID tokens whether or not OpenAI confirmed.
 * The account (issued client ID, subject, email) and the host ID stay for
 * signing in again. A cancelled sign-out clears nothing.
 */
export const signOutOfChatGPT = async (options: SignOutOfChatGPTOptions): Promise<ChatGPTSignOutOutcome> => {
  const { document, withSessionLock, signal } = options;
  const now = options.now ?? Date.now;
  const store = createChatGPTSessionStore(document);
  if (signal?.aborted === true) {
    throw new ChatGPTAuthError('cancelled', 'Signing out of ChatGPT was cancelled.', { cause: signal.reason });
  }

  return local('sign out of ChatGPT on this machine', () =>
    withSessionLock(async (): Promise<ChatGPTSignOutOutcome> => {
      const current = await store.read();
      if (current === undefined) {
        return { signedOut: false };
      }
      const email = current.email !== undefined ? { email: current.email } : {};
      if (!holdsTokens(current) && current.idToken === undefined) {
        return { signedOut: false, ...email };
      }

      let revocation: RevokeResult | undefined;
      if (current.refreshToken !== undefined) {
        let endpoints = options.endpoints;
        if (endpoints === undefined) {
          try {
            endpoints = await discoverEndpoints(requestOptions(options));
          } catch (error) {
            if (error instanceof ChatGPTAuthError && error.code === 'cancelled') {
              throw error;
            }
            revocation = { confirmed: false, reason: error instanceof Error ? error.message : String(error) };
          }
        }
        if (endpoints !== undefined) {
          revocation = await revokeRefreshToken({
            ...requestOptions(options),
            endpoints,
            clientId: current.clientId,
            refreshToken: current.refreshToken,
            ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
            ...(options.wait !== undefined ? { wait: options.wait } : {}),
          });
        }
      }

      const { idToken: _id, accessToken: _access, refreshToken: _refresh, expiresAt: _expiry, ...account } = current;
      await store.write({ ...account, savedAt: now() });
      return { signedOut: holdsTokens(current), ...email, ...(revocation !== undefined ? { revocation } : {}) };
    }),
  );
};
