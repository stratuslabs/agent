// What a saved ChatGPT sign-in looks like on disk: one JSON document with
// the install's host ID and the session. Where the document lives, how it is
// written and its lock belong to the host (in Stratus, `@stratusagent/state`'s
// createChatGPTSignInFile); this file owns only what is in it.
import { createHostId } from './protocol.ts';
import type { ChatGPTSession, ChatGPTSessionStore } from './session.ts';

/** The document the sign-in is kept in, read and replaced whole. */
export interface ChatGPTSignInDocument {
  read(): Promise<Record<string, unknown> | undefined>;
  write(contents: Record<string, unknown>): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const filledString = (value: unknown): value is string => typeof value === 'string' && value !== '';

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The saved session, or undefined when there isn't one. A record without
 * its account (client ID and subject) is not a session. An optional field
 * of the wrong type is left out rather than failing the whole record, so a
 * damaged token reads as signed out and the account stays for the next
 * sign-in. Fields this version doesn't know are dropped.
 */
export const parseChatGPTSession = (value: unknown): ChatGPTSession | undefined => {
  if (!isRecord(value) || !filledString(value.clientId) || !filledString(value.subject)) {
    return undefined;
  }
  return {
    clientId: value.clientId,
    subject: value.subject,
    ...(filledString(value.email) ? { email: value.email } : {}),
    ...(filledString(value.idToken) ? { idToken: value.idToken } : {}),
    ...(filledString(value.accessToken) ? { accessToken: value.accessToken } : {}),
    ...(filledString(value.refreshToken) ? { refreshToken: value.refreshToken } : {}),
    ...(finiteNumber(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    scopes: Array.isArray(value.scopes) ? value.scopes.filter(filledString) : [],
    savedAt: finiteNumber(value.savedAt) ? value.savedAt : 0,
  };
};

/**
 * The session store over a sign-in document. A write replaces the session
 * and keeps everything else in the document, the host ID above all. Like
 * every write of the document, it belongs inside the session lock.
 */
export const createChatGPTSessionStore = (document: ChatGPTSignInDocument): ChatGPTSessionStore => ({
  read: async () => parseChatGPTSession((await document.read())?.session),
  write: async (session) => {
    await document.write({ ...((await document.read()) ?? {}), session });
  },
});

/**
 * This install's host ID (`ext_agent_host_id`), created and saved the first
 * time it is asked for. Kept through sign-out, so signing in again comes from
 * the same host. Takes the session lock itself, since it may write.
 */
export const ensureChatGPTHostId = (
  document: ChatGPTSignInDocument,
  withSessionLock: <T>(work: () => Promise<T>) => Promise<T>,
  create: () => string = createHostId,
): Promise<string> =>
  withSessionLock(async () => {
    const current = (await document.read()) ?? {};
    if (filledString(current.hostId)) {
      return current.hostId;
    }
    const hostId = create();
    await document.write({ ...current, hostId });
    return hostId;
  });
