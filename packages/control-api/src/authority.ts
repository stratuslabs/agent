/**
 * A host and port as a URL authority.
 *
 * IPv6 literals have to be bracketed or the colons in the address run into
 * the port: `http://::1:4123` is not a URL, and an API that advertised it
 * would also fail every request, since that string is the base `new URL`
 * parses each incoming path against. Its own module because the control API
 * and the events listener both bind with it.
 */
export const authority = (host: string, port: number): string =>
  host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
