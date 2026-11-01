import test from 'node:test';
import assert from 'node:assert/strict';

import { bindsLoopback, isLoopbackAddress } from '../src/index.ts';

test('isLoopbackAddress: 127.0.0.0/8 and ::1, in every form Node reports them', () => {
  for (const address of ['127.0.0.1', '127.5.5.5', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
});

test('isLoopbackAddress: wildcards, LAN and tailnet addresses, and anything that is not an address', () => {
  // Names are not addresses: what a name binds is the resolver's answer,
  // which is `bindsLoopback`'s job.
  for (const address of ['0.0.0.0', '::', '192.168.1.2', '100.64.0.1', '128.0.0.1', '::ffff:10.0.0.1', '::2', 'localhost', '127.1', '[::1]', '']) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test('bindsLoopback: decided by what the name resolves to, the way listen binds it', async () => {
  // An /etc/hosts alias no spelling rule can know: the resolver is the answer.
  const hosts: Record<string, string> = { 'ip6-localhost': '::1', 'loopback.internal': '127.0.0.2', 'mac-mini.example.ts.net': '100.64.0.1' };
  const lookup = async (host: string) => {
    const address = hosts[host];
    if (address === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    }
    return { address };
  };
  assert.equal(await bindsLoopback('ip6-localhost', lookup), true);
  assert.equal(await bindsLoopback('loopback.internal', lookup), true);
  assert.equal(await bindsLoopback('mac-mini.example.ts.net', lookup), false);
  // A name that does not resolve cannot be bound either; it is not loopback.
  assert.equal(await bindsLoopback('nowhere.invalid', lookup), false);
});

test('bindsLoopback: the real resolver, on names and addresses every platform has', async () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1']) {
    assert.equal(await bindsLoopback(host), true, host);
  }
  for (const host of ['0.0.0.0', '::']) {
    assert.equal(await bindsLoopback(host), false, host);
  }
});
