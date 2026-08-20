/**
 * The table every tool that reaches the network is tested against.
 *
 * Shipped in `src` rather than kept in one package's tests because two
 * packages must be held to it, and the acceptance criterion for that is
 * exact: `web.fetch` refuses the same addresses and schemes as `browser.*`,
 * *proven by a test that runs the same table through both*. If the shared
 * module is ever forked, this is what fails — in whichever package forked
 * it, because both suites read this list rather than their own.
 */
export interface HostileUrl {
  url: string;
  /** What it is, for a failing assertion that names the hole rather than an index. */
  what: string;
}

export const HOSTILE_URLS: HostileUrl[] = [
  { url: 'file:///home/ada/.stratus/credentials.json', what: 'the credential store, by file: URL' },
  { url: 'file:///etc/passwd', what: 'a local file' },
  { url: 'data:text/html,<script>fetch("http://169.254.169.254")</script>', what: 'an inline document' },
  { url: 'javascript:fetch("http://127.0.0.1")', what: 'a javascript: URL' },
  { url: 'ftp://example.com/secrets', what: 'a scheme nobody asked for' },
  { url: 'http://169.254.169.254/latest/meta-data/', what: 'cloud instance metadata' },
  { url: 'http://[fd00::1]/', what: 'an IPv6 unique-local address' },
  { url: 'http://[::ffff:169.254.169.254]/', what: 'metadata again, as an IPv4-mapped IPv6 address' },
  { url: 'http://[::ffff:127.0.0.1]/', what: 'loopback, as an IPv4-mapped IPv6 address' },
  { url: 'http://[64:ff9b::a9fe:a9fe]/', what: 'metadata again, through NAT64' },
  { url: 'http://[64:ff9b:1::a9fe:a9fe]/', what: 'metadata again, through the local-use NAT64 prefix' },
  { url: 'http://[2002:a9fe:a9fe::]/', what: 'metadata again, through 6to4' },
  { url: 'http://127.0.0.1:4123/api/v1/credentials', what: 'the daemon’s own control API' },
  { url: 'http://[::1]:4123/api/v1/credentials', what: 'the control API over IPv6 loopback' },
  { url: 'http://localhost:4123/api/v1/credentials', what: 'the control API by name' },
  { url: 'http://10.0.0.5/', what: 'an RFC 1918 address' },
  { url: 'http://172.16.4.4/', what: 'an RFC 1918 address in the /12' },
  { url: 'http://192.168.1.1/', what: 'the home router' },
  { url: 'http://100.100.100.200/', what: 'a carrier-NAT address' },
  { url: 'http://[fe80::1]/', what: 'an IPv6 link-local address' },
  { url: 'http://0.0.0.0/', what: 'the unspecified address' },
  { url: 'http://192.0.0.1/', what: 'IETF protocol assignment space' },
  { url: 'http://224.0.0.1/', what: 'multicast' },
];
