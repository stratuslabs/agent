import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRequestAllowed,
  checkAddress,
  checkHost,
  classifyAddress,
  egressPolicyFrom,
  EgressPolicyError,
  HOSTILE_URLS,
  policyKeyFor,
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
    // The local-use NAT64 prefix embeds its IPv4 at a length the local
    // translator chooses, so there is no offset to read — and every one of
    // these could be 169.254.169.254 on the network that configured it.
    '64:ff9b:1::a9fe:a9fe',
    '64:ff9b:1::1',
    '64:ff9b:1:0:a9fe:a9fe::',
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
  assert.match(classifyAddress('64:ff9b:1::1').reason ?? '', /local-use NAT64 prefix/);
  // The well-known prefix is still judged on the address it carries, so an
  // IPv6-only network can still reach the public IPv4 internet through it.
  assert.equal(classifyAddress('64:ff9b::5db8:d822').allowed, true);
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

test('onlyHosts narrows which names are reachable, exactly or by subdomain', () => {
  const policy = { onlyHosts: ['docs.python.org', '*.wikipedia.org', '93.184.216.34'] };

  assert.equal(checkHost(policy, 'docs.python.org').allowed, true);
  assert.equal(checkHost(policy, 'DOCS.Python.org.').allowed, true);
  assert.equal(checkHost(policy, 'en.wikipedia.org').allowed, true);
  assert.equal(checkHost(policy, 'upload.en.wikipedia.org').allowed, true);
  assert.equal(checkHost(policy, '93.184.216.34').allowed, true);

  // A wildcard is subdomains only — the apex is its own entry — and a
  // suffix match on the bare name would let `evilwikipedia.org` through.
  assert.equal(checkHost(policy, 'wikipedia.org').allowed, false);
  assert.equal(checkHost(policy, 'evilwikipedia.org').allowed, false);
  assert.equal(checkHost(policy, 'python.org').allowed, false);
  assert.equal(checkHost(policy, 'attacker.example').allowed, false);
  // A trailing dot is the same name to DNS, so it is the same name here.
  assert.equal(checkHost(policy, 'attacker.example.').allowed, false);

  // Unset reaches every public host, which is the default and stays it.
  assert.equal(checkHost({}, 'attacker.example').allowed, true);
  // Set and empty reaches nothing.
  assert.equal(checkHost({ onlyHosts: [] }, 'docs.python.org').allowed, false);
  // `*` is every host — the value an agent's override uses to lift a list
  // it would otherwise inherit.
  assert.equal(checkHost({ onlyHosts: ['*'] }, 'attacker.example').allowed, true);
  // Only `*` written as itself. A wildcard cut short — `*.` from
  // `*.example.com` — normalizes to `*`, and reading it as every host
  // would lift the list on a typo; a malformed rule reaches nothing.
  assert.equal(checkHost({ onlyHosts: ['*.'] }, 'attacker.example').allowed, false);
  assert.equal(checkHost({ onlyHosts: ['*..'] }, 'attacker.example').allowed, false);
  assert.equal(checkHost({ onlyHosts: [' * '] }, 'attacker.example').allowed, true);
  // A rule is read in the form a URL gives its host, or it never matches:
  // a Unicode name arrives as punycode, an IPv6 literal compressed.
  const unicode = { onlyHosts: ['bücher.de', '*.bücher.de', '2001:db8:0:0:0:0:0:1'] };
  assert.equal(assertRequestAllowed('https://bücher.de/', unicode).hostname, 'xn--bcher-kva.de');
  assert.equal(checkHost(unicode, 'shop.xn--bcher-kva.de').allowed, true);
  assert.equal(checkHost(unicode, '[2001:db8::1]').allowed, true);
  assert.equal(checkHost(unicode, 'xn--bchr-kva.de').allowed, false);
  // A rule is a hostname, never a URL authority: parsed as one, user-info
  // or a path would move it onto a different host. Malformed matches
  // nothing.
  for (const rule of ['trusted.example@attacker.example', 'trusted.example/attacker.example', 'trusted.example\\attacker.example']) {
    assert.equal(checkHost({ onlyHosts: [rule] }, 'attacker.example').allowed, false, rule);
    assert.equal(checkHost({ onlyHosts: [rule] }, 'trusted.example').allowed, false, rule);
  }
  assert.equal(checkHost({ onlyHosts: ['*.trusted.example@attacker.example'] }, 'x.attacker.example').allowed, false);
  assert.equal(checkHost({ onlyHosts: ['trusted.example:443'] }, 'trusted.example').allowed, false);
  assert.equal(checkHost({ onlyHosts: ['trusted.example\uFF20attacker.example'] }, 'attacker.example').allowed, false);
  // Brackets belong around an IPv6 literal and nothing else; stripped from
  // anything else, a malformed rule became a working one.
  for (const rule of ['[*.example.com]', '[example.com]', '[2001:db8::1', '2001:db8::1]', '[[2001:db8::1]]']) {
    assert.equal(checkHost({ onlyHosts: [rule] }, 'secret.example.com').allowed, false, rule);
    assert.equal(checkHost({ onlyHosts: [rule] }, 'example.com').allowed, false, rule);
    assert.equal(checkHost({ onlyHosts: [rule] }, '[2001:db8::1]').allowed, false, rule);
  }
  assert.equal(checkHost({ onlyHosts: ['[2001:db8::1]'] }, '[2001:db8::1]').allowed, true);
});

test('a host outside onlyHosts is refused at the URL, before any lookup, with the setting named', () => {
  const policy = { onlyHosts: ['docs.python.org'] };
  // The exfiltration shape this exists for: a page told the agent to put
  // what it read into a query string on a host the operator never named.
  assert.throws(
    () => assertRequestAllowed('https://attacker.example/?d=secret', policy),
    (error: unknown) => error instanceof EgressPolicyError
      && /attacker\.example is not one of the hosts this agent may reach/.test(error.message)
      && /onlyHosts/.test(error.message),
  );
  assert.equal(assertRequestAllowed('https://docs.python.org/3/', policy).hostname, 'docs.python.org');
});

test('onlyHosts narrows names and never widens the address check', () => {
  // A listed name that resolves somewhere private is still refused — the
  // list is about where data may go, not a second exemption list.
  assert.equal(checkAddress({ onlyHosts: ['intranet.example'] }, 'intranet.example', '10.0.0.5').allowed, false);
  // Every path that dials goes through checkAddress, so it enforces the
  // names too.
  assert.equal(checkAddress({ onlyHosts: ['docs.python.org'] }, 'attacker.example', '93.184.216.34').allowed, false);
  // An allowedHosts entry stays reachable without being written twice.
  const both = { onlyHosts: ['docs.python.org'], allowedHosts: ['dev.internal'] };
  assert.equal(checkAddress(both, 'dev.internal', '10.0.0.5').allowed, true);
});

test('onlyHosts is read from settings failing closed, and is part of the policy key', () => {
  assert.equal(egressPolicyFrom({}).onlyHosts, undefined);
  assert.deepEqual(egressPolicyFrom({ onlyHosts: ['a.example', 7] }).onlyHosts, ['a.example']);
  // Present but not a list: a restriction nobody can read restricts to
  // nothing, rather than being dropped and lifting itself.
  assert.deepEqual(egressPolicyFrom({ onlyHosts: 'a.example' }).onlyHosts, []);

  // A browser per policy is keyed on this, so two agents with different
  // lists must never share one — and unset must not collide with empty.
  assert.notEqual(policyKeyFor({}), policyKeyFor({ onlyHosts: [] }));
  assert.notEqual(policyKeyFor({ onlyHosts: ['a.example'] }), policyKeyFor({ onlyHosts: ['b.example'] }));
  assert.equal(
    policyKeyFor({ onlyHosts: ['a.example', 'b.example'] }),
    policyKeyFor({ onlyHosts: ['b.example', 'a.example'] }),
  );
});
