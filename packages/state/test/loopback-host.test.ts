import test from 'node:test';
import assert from 'node:assert/strict';

import { isLoopbackHost } from '../src/index.ts';

test('isLoopbackHost: loopback names and 127.0.0.0/8 stay on this machine', () => {
  for (const host of ['127.0.0.1', '127.5.5.5', 'localhost', 'LocalHost', ' localhost ', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
});

test('isLoopbackHost: wildcards, LAN and tailnet addresses, and look-alike names do not', () => {
  for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.2', '100.64.0.1', '::ffff:10.0.0.1', 'mac-mini.example.ts.net', '127.0.0.1.example.com', 'localhost.example.com', '']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
