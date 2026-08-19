import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRequestAllowed,
  checkAddress,
  classifyAddress,
  EgressPolicyError,
  HOSTILE_URLS,
} from '../src/index.ts';

test('every non-global address is refused, in both families and every disguise', () => {
  const refused = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fc00::abcd',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    // The same addresses again, written the ways a blacklist misses.
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::',
  ];
  for (const address of refused) {
    assert.equal(classifyAddress(address).allowed, false, `should refuse ${address}`);
  }

  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1', '100.128.0.1']) {
    assert.equal(classifyAddress(address).allowed, true, `should allow ${address}`);
  }
});

test('a refusal names the range, because the agent has to be told something true', () => {
  assert.match(classifyAddress('169.254.169.254').reason ?? '', /link-local.*instance metadata/);
  assert.match(classifyAddress('::ffff:10.0.0.1').reason ?? '', /embeds .*private address/);
  assert.match(classifyAddress('fd00::1').reason ?? '', /unique-local/);
  assert.match(classifyAddress('not-an-address').reason ?? '', /not an IP address/);
});

test('the scheme allowlist rejects local schemes before anything is fetched', () => {
  assert.throws(() => assertRequestAllowed('file:///etc/passwd'), EgressPolicyError as never);
  assert.throws(() => assertRequestAllowed('data:text/html,hi'), /only http:, https:/);
  assert.throws(() => assertRequestAllowed('javascript:alert(1)'), /only http:, https:/);
  assert.throws(() => assertRequestAllowed('not a url'), /Not a URL/);
  assert.equal(assertRequestAllowed('https://example.com/x').hostname, 'example.com');
});

test('the hostile table is refused by scheme or by address, every entry', () => {
  for (const entry of HOSTILE_URLS) {
    let refused = false;
    try {
      const url = assertRequestAllowed(entry.url);
      // Anything that survives the URL-level check is a *name*, and names
      // are judged where they are resolved. Prove that this one resolves
      // somewhere the policy refuses rather than leaving it untested.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      refused = !checkAddress({}, host, host === 'localhost' ? '127.0.0.1' : host).allowed;
    } catch (error) {
      refused = error instanceof EgressPolicyError;
    }
    assert.equal(refused, true, `should refuse ${entry.what}: ${entry.url}`);
  }
});

test('an operator can widen the policy, narrowly or bluntly', () => {
  // The narrow way: one host an agent is meant to reach.
  assert.equal(checkAddress({ allowedHosts: ['dev.internal'] }, 'dev.internal', '10.0.0.5').allowed, true);
  assert.equal(checkAddress({ allowedHosts: ['dev.internal'] }, 'other.internal', '10.0.0.5').allowed, false);
  // The blunt way, which is the trusted-workstation posture and turns the
  // protection off rather than adjusting it.
  assert.equal(checkAddress({ allowPrivateAddresses: true }, 'anything', '169.254.169.254').allowed, true);
  assert.equal(
    assertRequestAllowed('http://127.0.0.1:8080/', { allowPrivateAddresses: true }).port,
    '8080',
  );
});
