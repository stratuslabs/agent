import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatGPTSessionStore,
  ensureChatGPTHostId,
  parseChatGPTSession,
  type ChatGPTSession,
  type ChatGPTSignInDocument,
} from '../src/index.ts';

const session: ChatGPTSession = {
  clientId: 'oaiapp_issued123',
  subject: 'user-sub-1',
  email: 'person@example.com',
  idToken: 'id-token-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 1_800_000_000_000,
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  savedAt: 1_799_999_000_000,
};

const memoryDocument = (initial?: Record<string, unknown>) => {
  let contents = initial;
  const writes: Record<string, unknown>[] = [];
  const document: ChatGPTSignInDocument = {
    read: async () => (contents === undefined ? undefined : structuredClone(contents)),
    write: async (next) => {
      writes.push(structuredClone(next));
      contents = structuredClone(next);
    },
  };
  return { document, writes, current: () => contents };
};

/** Counts how often the lock was taken, and whether work ran inside it. */
const countingLock = () => {
  const lock = {
    taken: 0,
    held: false,
    withSessionLock: async <T>(work: () => Promise<T>): Promise<T> => {
      lock.taken += 1;
      lock.held = true;
      try {
        return await work();
      } finally {
        lock.held = false;
      }
    },
  };
  return lock;
};

test('a saved session reads back as saved', () => {
  assert.deepEqual(parseChatGPTSession(JSON.parse(JSON.stringify(session))), session);
  const { email: _email, idToken: _id, accessToken: _a, refreshToken: _r, expiresAt: _e, ...signedOut } = session;
  assert.deepEqual(parseChatGPTSession(signedOut), signedOut);
});

test('a record without its account is no session; a damaged token reads as signed out with the account kept', () => {
  for (const notASession of [undefined, null, 'refresh-1', [session], {}, { ...session, clientId: '' }, { ...session, subject: 7 }]) {
    assert.equal(parseChatGPTSession(notASession), undefined, JSON.stringify(notASession));
  }
  const damaged = parseChatGPTSession({ ...session, accessToken: 42, refreshToken: '', expiresAt: 'soon', scopes: ['openid', 9], savedAt: null, extra: 'x' });
  assert.deepEqual(damaged, {
    clientId: session.clientId,
    subject: session.subject,
    email: session.email,
    idToken: session.idToken,
    scopes: ['openid'],
    savedAt: 0,
  });
});

test('the session store reads the session out of the document and replaces only the session', async () => {
  const doc = memoryDocument({ hostId: 'urn:uuid:host-1', later: { kept: true } });
  const store = createChatGPTSessionStore(doc.document);
  assert.equal(await store.read(), undefined);

  await store.write(session);
  assert.deepEqual(await store.read(), session);
  // A sign-out keeps the account and the host ID.
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, ...account } = session;
  await store.write(account);
  assert.deepEqual(doc.current(), { hostId: 'urn:uuid:host-1', later: { kept: true }, session: account });

  assert.equal(await createChatGPTSessionStore(memoryDocument().document).read(), undefined);
});

test('the host ID is made once under the lock and then kept, through a sign-out', async () => {
  const doc = memoryDocument();
  const lock = countingLock();
  let made = 0;
  const create = () => {
    made += 1;
    assert.equal(lock.held, true, 'made outside the lock');
    return `urn:uuid:host-${made}`;
  };
  assert.equal(await ensureChatGPTHostId(doc.document, lock.withSessionLock, create), 'urn:uuid:host-1');
  assert.equal(await ensureChatGPTHostId(doc.document, lock.withSessionLock, create), 'urn:uuid:host-1');
  assert.equal(made, 1);
  assert.equal(lock.taken, 2);
  assert.equal(doc.writes.length, 1);

  const store = createChatGPTSessionStore(doc.document);
  await store.write(session);
  await store.write({ clientId: session.clientId, subject: session.subject, scopes: [], savedAt: 1 });
  assert.equal(await ensureChatGPTHostId(doc.document, lock.withSessionLock, create), 'urn:uuid:host-1');
  assert.equal(made, 1);
});

test('without a create function the host ID is a urn:uuid', async () => {
  const lock = countingLock();
  assert.match(await ensureChatGPTHostId(memoryDocument().document, lock.withSessionLock), /^urn:uuid:[0-9a-f-]{36}$/);
});
