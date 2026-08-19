/**
 * Which addresses a tool may reach.
 *
 * The rule is "every globally routable address, and nothing else" rather
 * than a blacklist of the ranges people remember. A blacklist that stops at
 * RFC 1918 leaves cloud metadata at `169.254.169.254`, the gateway on
 * `127.0.0.1`, and — on any dual-stack network — the same services again
 * over IPv6 unique-local addresses and IPv4-mapped forms. Enumerating what
 * is *allowed* fails closed on the range nobody thought of.
 */

export interface AddressVerdict {
  allowed: boolean;
  /** One line naming what was refused, for the error the agent sees. */
  reason?: string;
}

export interface EgressPolicy {
  /**
   * Schemes a tool may request. `http:`/`https:` by default — `file:`,
   * `data:`, and the rest are rejected before anything is fetched, because
   * a browser or fetcher runs as the daemon user and address validation
   * cannot protect the filesystem.
   */
  allowedSchemes?: string[];
  /**
   * Reach addresses that are not globally routable. Off by default; on, it
   * is the trusted-workstation posture — an agent that is meant to talk to
   * a local development server. It turns off the SSRF protection, which is
   * why it is one switch an operator flips rather than something a call can
   * ask for.
   */
  allowPrivateAddresses?: boolean;
  /**
   * Hosts exempt from the address check, by hostname or literal address —
   * `localhost`, `127.0.0.1`, `dev.internal`. Narrower than the switch
   * above and the one to reach for: an agent that needs one internal
   * service should not thereby be able to read the metadata endpoint.
   */
  allowedHosts?: string[];
}

const DEFAULT_SCHEMES = ['http:', 'https:'];

const parseIPv4 = (value: string): number[] | undefined => {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    octets.push(octet);
  }
  return octets;
};

/** Every IPv4 range that is not globally routable, with the name of each. */
const classifyIPv4 = (octets: number[]): AddressVerdict => {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  const address = octets.join('.');
  const refuse = (what: string): AddressVerdict => ({
    allowed: false,
    reason: `${address} is ${what}, which is not a public address`,
  });

  if (a === 0) return refuse('the unspecified range (0.0.0.0/8)');
  if (a === 10) return refuse('a private address (10.0.0.0/8)');
  if (a === 100 && b >= 64 && b <= 127) return refuse('a carrier-NAT address (100.64.0.0/10)');
  if (a === 127) return refuse('loopback (127.0.0.0/8)');
  if (a === 169 && b === 254) {
    // The one that matters most in a hosted deployment: this is where every
    // major cloud serves instance credentials.
    return refuse('link-local (169.254.0.0/16) — cloud instance metadata lives here');
  }
  if (a === 172 && b >= 16 && b <= 31) return refuse('a private address (172.16.0.0/12)');
  if (a === 192 && b === 0 && c === 0) return refuse('IETF protocol assignment space (192.0.0.0/24)');
  if (a === 192 && b === 0 && c === 2) return refuse('documentation space (192.0.2.0/24)');
  if (a === 192 && b === 88 && c === 99) return refuse('6to4 relay anycast (192.88.99.0/24)');
  if (a === 192 && b === 168) return refuse('a private address (192.168.0.0/16)');
  if (a === 198 && (b === 18 || b === 19)) return refuse('benchmarking space (198.18.0.0/15)');
  if (a === 198 && b === 51 && c === 100) return refuse('documentation space (198.51.100.0/24)');
  if (a === 203 && b === 0 && c === 113) return refuse('documentation space (203.0.113.0/24)');
  if (a >= 224 && a <= 239) return refuse('multicast (224.0.0.0/4)');
  if (a >= 240) return refuse(d === 255 && a === 255 ? 'broadcast' : 'reserved space (240.0.0.0/4)');
  return { allowed: true };
};

const expandIPv6 = (value: string): number[] | undefined => {
  const zoneless = value.split('%')[0] ?? value;
  const [head, tail, ...extra] = zoneless.split('::');
  if (extra.length > 0) {
    return undefined;
  }
  const parseGroups = (part: string | undefined): number[] | undefined => {
    if (!part) {
      return [];
    }
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (piece.length === 0) {
        return undefined;
      }
      if (piece.includes('.')) {
        // A trailing dotted quad: `::ffff:169.254.169.254` and friends.
        const octets = parseIPv4(piece);
        if (!octets) {
          return undefined;
        }
        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        return undefined;
      }
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const left = parseGroups(head);
  const right = tail === undefined ? [] : parseGroups(tail);
  if (!left || !right) {
    return undefined;
  }
  if (tail === undefined) {
    return left.length === 8 ? left : undefined;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) {
    return undefined;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

const embeddedIPv4 = (groups: number[]): number[] | undefined => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const asOctets = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d). Both are
  // ways of writing an IPv4 address, so both are classified as one — a
  // check that only knew dotted quads would pass `::ffff:127.0.0.1`.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (g6 === 0 && g7 <= 1) {
      return undefined; // :: and ::1 are classified as IPv6 below.
    }
    return asOctets(g6, g7);
  }
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) both carry an IPv4 address
  // that the network will actually route to.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return asOctets(g6, g7);
  }
  if (g0 === 0x2002) {
    return asOctets(g1, g2);
  }
  return undefined;
};

const classifyIPv6 = (groups: number[], address: string): AddressVerdict => {
  const embedded = embeddedIPv4(groups);
  if (embedded) {
    const verdict = classifyIPv4(embedded);
    return verdict.allowed
      ? verdict
      : { allowed: false, reason: `${address} embeds ${verdict.reason ?? 'a non-public address'}` };
  }

  const [g0 = 0] = groups;
  const refuse = (what: string): AddressVerdict => ({
    allowed: false,
    reason: `${address} is ${what}, which is not a public address`,
  });

  // RFC 8215's local-use NAT64 prefix. The well-known `64:ff9b::/96` above
  // embeds its IPv4 at a fixed offset, so that one is extracted and judged
  // on the address it carries — which is what lets an IPv6-only network
  // reach the public IPv4 internet. This one may embed at any of RFC 6052's
  // lengths, chosen by whoever runs the translator, so there is no offset
  // to read it from. It is called local-use for a reason: refused whole,
  // rather than guessed at and let through as public.
  if (g0 === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return refuse('the local-use NAT64 prefix (64:ff9b:1::/48), which can translate to any address');
  }

  if (groups.every((group) => group === 0)) return refuse('the unspecified address (::)');
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return refuse('loopback (::1)');
  if ((g0 & 0xfe00) === 0xfc00) return refuse('a unique-local address (fc00::/7)');
  if ((g0 & 0xffc0) === 0xfe80) return refuse('link-local (fe80::/10)');
  if ((g0 & 0xff00) === 0xff00) return refuse('multicast (ff00::/8)');
  if (g0 === 0x2001 && groups[1] === 0x0db8) return refuse('documentation space (2001:db8::/32)');
  if (g0 === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return refuse('the discard prefix (100::/64)');
  return { allowed: true };
};

/**
 * Classify one literal address, in either family.
 *
 * Called on the address a connection is actually about to use, never on
 * the one a name resolved to a moment earlier somewhere else — that gap is
 * DNS rebinding, and it is the difference between a check and a ceremony.
 */
export const classifyAddress = (address: string): AddressVerdict => {
  const ipv4 = parseIPv4(address);
  if (ipv4) {
    return classifyIPv4(ipv4);
  }
  const ipv6 = expandIPv6(address);
  if (ipv6) {
    return classifyIPv6(ipv6, address);
  }
  return { allowed: false, reason: `${address} is not an IP address` };
};

const hostMatches = (policy: EgressPolicy, host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (policy.allowedHosts ?? []).some((entry) => entry.toLowerCase() === normalized);
};

/** Whether one resolved address may be connected to for this host. */
export const checkAddress = (policy: EgressPolicy, host: string, address: string): AddressVerdict => {
  if (policy.allowPrivateAddresses || hostMatches(policy, host)) {
    return { allowed: true };
  }
  return classifyAddress(address);
};

/** A URL this policy refuses, and why. */
export class EgressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressPolicyError';
  }
}

/**
 * The check that can be made before anything is fetched: the scheme, and
 * the address when the URL names one literally.
 *
 * A hostname cannot be judged here — that is what the connection-time
 * check is for — so this returning without throwing is not permission to
 * connect. It is permission to *try*, and it is where `file:///…` dies.
 */
export const assertRequestAllowed = (rawUrl: string, policy: EgressPolicy = {}): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressPolicyError(`Not a URL: ${rawUrl}`);
  }

  const schemes = policy.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(url.protocol)) {
    throw new EgressPolicyError(
      `Refusing ${url.protocol}//: only ${schemes.join(', ')} may be requested. `
      + 'Local schemes are rejected before navigation — this process can read the files they name.',
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = parseIPv4(host) ? host : (expandIPv6(host) ? host : undefined);
  if (literal) {
    const verdict = checkAddress(policy, host, literal);
    if (!verdict.allowed) {
      throw new EgressPolicyError(`Refusing ${url.href}: ${verdict.reason}`);
    }
  }
  return url;
};
