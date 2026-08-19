import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDashboardAssets } from '../src/index.ts';

/** The asset server, on a throwaway socket. */
const serving = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const assets = createDashboardAssets();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    void assets.serve(pathname, response).then((served) => {
      if (!served) {
        response.statusCode = 404;
        response.end('nothing here');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
};

test('the shell, its stylesheet, and its modules are served with usable types', async () => {
  const host = await serving();
  try {
    const shell = await fetch(`${host.url}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await shell.text(), /<title>Stratus Agent<\/title>/);

    const styles = await fetch(`${host.url}/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get('content-type') ?? '', /text\/css/);

    // A module served as anything but JavaScript is a blank page with a
    // console error, which is exactly the failure nobody thinks to check.
    const app = await fetch(`${host.url}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get('content-type') ?? '', /text\/javascript/);

    const nested = await fetch(`${host.url}/views/agent.js`);
    assert.equal(nested.status, 200);
    assert.match(nested.headers.get('content-type') ?? '', /text\/javascript/);
  } finally {
    await host.close();
  }
});

test('a client route falls back to the shell, and a missing asset does not', async () => {
  const host = await serving();
  try {
    // The router lives in the page, so an extensionless path is a screen it
    // renders rather than a file that is missing.
    const route = await fetch(`${host.url}/agents/ava`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<div id="app"/);

    // A file that genuinely is not there must 404 rather than quietly hand
    // back HTML — a missing module served as the shell is a syntax error in
    // the console instead of a missing file.
    const missing = await fetch(`${host.url}/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    await host.close();
  }
});

test('a path cannot escape the asset directory', async () => {
  const host = await serving();
  try {
    // Every shape of the same attempt: raw, encoded, doubled-up, and one
    // aimed at a file that certainly exists on the machine.
    for (const attack of [
      '/../package.json',
      '/../../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/../src/index.ts',
      '/../../../../../../etc/passwd',
    ]) {
      const response = await fetch(`${host.url}${attack}`);
      const body = await response.text();
      assert.ok(
        !body.includes('"name": "@stratusagent/dashboard"'),
        `${attack} leaked the package manifest`,
      );
      assert.ok(!body.includes('root:x:'), `${attack} leaked /etc/passwd`);
      assert.ok(
        !body.includes('createDashboardAssets'),
        `${attack} leaked source outside the ui directory`,
      );
    }
  } finally {
    await host.close();
  }
});

test('the page declares a policy that keeps it talking to its own origin', async () => {
  const host = await serving();
  try {
    const shell = await fetch(`${host.url}/`);
    const policy = shell.headers.get('content-security-policy') ?? '';
    // The dashboard holds a live session against a local daemon. A policy
    // that let it fetch or embed elsewhere would make any future mistake in
    // the page an exfiltration route rather than a rendering bug.
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /connect-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await host.close();
  }
});
