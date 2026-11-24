import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The daemon and a foreground `stratus run` share one ChatGPT sign-in, and
// its refresh token works once. Two real processes, the real sign-in file
// from @stratusagent/state and its lock, and a token endpoint that refuses a
// spent refresh token, as OpenAI's does.

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceUrl = pathToFileURL(path.join(packageDir, 'src', 'index.ts')).href;

const CHILD = `
import { createChatGPTSignInFile } from '@stratusagent/state';
import { createChatGPTSessionStore, createChatGPTTokenSource } from ${JSON.stringify(sourceUrl)};
const file = createChatGPTSignInFile({ homeDir: process.env.TEST_HOME });
const issuer = process.env.TEST_ISSUER;
const source = createChatGPTTokenSource({
  endpoints: {
    issuer,
    authorizationEndpoint: issuer + '/authorize',
    tokenEndpoint: issuer + '/token',
    revocationEndpoint: issuer + '/revoke',
    jwksUri: issuer + '/jwks',
  },
  store: createChatGPTSessionStore(file),
  withSessionLock: file.withLock,
});
process.stdout.write('ready\\n');
process.stdin.once('data', async () => {
  try {
    process.stdout.write(JSON.stringify({ token: await source.accessToken(undefined) }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ code: error.code, message: error.message }) + '\\n');
  }
  process.exit(0);
});
`;

const startChild = (home: string, issuer: string): { child: ChildProcess; lines: AsyncIterator<string> } => {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', CHILD],
    { cwd: packageDir, env: { ...process.env, TEST_HOME: home, TEST_ISSUER: issuer }, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  return { child, lines: createInterface({ input: child.stdout! })[Symbol.asyncIterator]() };
};

const nextLine = async (lines: AsyncIterator<string>): Promise<string> => {
  const { value, done } = await lines.next();
  assert.ok(done !== true, 'the child exited without answering');
  return value;
};

test('two processes due a refresh at once send one refresh, and both use its token', { timeout: 30_000 }, async () => {
  let current = 1;
  const presented: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      presented.push(form.get('refresh_token') ?? '');
      // Slow enough that the other process is due while this one is out.
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        if (form.get('refresh_token') !== `refresh-${current}`) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token already used' }));
          return;
        }
        current += 1;
        response.end(JSON.stringify({
          access_token: `access-${current}`,
          refresh_token: `refresh-${current}`,
          token_type: 'Bearer',
          expires_in: 3600,
        }));
      }, 300);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-chatgpt-two-'));
  const signInPath = path.join(home, '.stratus', 'chatgpt-sign-in.json');
  await mkdir(path.dirname(signInPath), { recursive: true });
  await writeFile(signInPath, JSON.stringify({
    hostId: 'urn:uuid:host-1',
    session: {
      clientId: 'oaiapp_issued123',
      subject: 'user-sub-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      // Inside the five minutes before expiry, so both are due a refresh.
      expiresAt: Date.now() + 60_000,
      scopes: ['openid', 'chatgpt.tokens.use.direct'],
      savedAt: Date.now(),
    },
  }));

  const children = [startChild(home, issuer), startChild(home, issuer)];
  try {
    for (const { lines } of children) {
      assert.equal(await nextLine(lines), 'ready');
    }
    for (const { child } of children) {
      child.stdin!.write('go\n');
    }
    const answers = await Promise.all(children.map(async ({ lines }) => JSON.parse(await nextLine(lines))));
    assert.deepEqual(answers, [{ token: 'access-2' }, { token: 'access-2' }]);
    assert.deepEqual(presented, ['refresh-1']);
    const saved = JSON.parse(await readFile(signInPath, 'utf8'));
    assert.equal(saved.session.refreshToken, 'refresh-2');
    assert.equal(saved.hostId, 'urn:uuid:host-1');
  } finally {
    for (const { child } of children) {
      child.kill();
    }
    server.close();
  }
});
