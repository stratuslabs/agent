# @stratusagent/egress

Which addresses a tool may reach, enforced on the connection rather than on
the name it was asked for.

Used by [`@stratusagent/tool-web`](../tool-web) and
[`@stratusagent/tool-browser`](../tool-browser). It is one module because two
copies of this rule would not drift into a style difference — the stale one
would be an SSRF hole — and both packs are tested against `HOSTILE_URLS`, the
table exported from here, which is what fails if it is ever forked.

## The rule

**Every globally routable address, and nothing else**, in both families. A
blacklist that stops at RFC 1918 still leaves:

- `169.254.169.254` — cloud instance metadata, and the credentials it serves
- `127.0.0.1` and `::1` — the daemon's own control API, among other things
- `fc00::/7` and `fe80::/10` — the same internal services over IPv6
- `::ffff:169.254.169.254`, `64:ff9b::a9fe:a9fe`, `2002:a9fe:a9fe::` — the
  same IPv4 addresses again, written the ways an IPv4 check does not see.
  The well-known NAT64 prefix is judged on the IPv4 it carries, so an
  IPv6-only network still reaches the public internet through it; RFC 8215's
  **local-use** prefix `64:ff9b:1::/48` is refused whole, because the
  translator chooses the embedding length and there is no offset to read the
  address from

Schemes are `http:` and `https:`. `file:`, `data:`, and `javascript:` are
refused before anything is fetched: the process doing the fetching runs as the
daemon user, and address validation cannot protect a filesystem.

## Validation binds to the connection

Resolving a name to check it and then letting something else resolve it again
to connect is DNS rebinding with extra steps — the attacker's server answers
`93.184.216.34` for the check and `169.254.169.254` for the connection.

```ts
import { createPinnedLookup, requestThroughPolicy, createEgressProxy } from '@stratusagent/egress';
```

- `createPinnedLookup(policy)` is a `lookup` for Node's HTTP stack, so the
  addresses the socket uses are the addresses this checked. There is no second
  resolution to lose to.
- `requestThroughPolicy(url, …)` is one exchange over that lookup, with a byte
  cap. It deliberately does **not** follow redirects: each hop is a new request
  to a new host, so the caller loops and each hop faces the policy again.
Both of those pass `agent: false` alongside the lookup. Node's global agent
pools sockets by host and port and knows nothing about `lookup`, so a
connection opened under a permissive policy is one a stricter policy can be
handed — and a reused socket resolves nothing, so the pinned lookup that
would have refused it is never called.

- Connections through the proxy live exactly as long as the browser's side
  of them: a page navigated away from mid-transfer takes its upstream socket
  with it, and `close()` takes every one that is left.
- `createEgressProxy(policy)` is a loopback proxy for a browser, which resolves
  names for itself whatever an interception handler decides. It resolves,
  checks, and dials the checked address. `chromiumProxyOptions` /
  `chromiumProxyArgs` include `<-loopback>` in the bypass list, without which
  Chromium bypasses the proxy for exactly the addresses it exists to refuse.

## Widening it

| Setting | What it does |
| --- | --- |
| `allowedHosts` | Exempts specific hosts, by name or literal address. The narrow override: one internal service an agent is meant to reach. |
| `allowPrivateAddresses` | Reaches any non-global address. The trusted-workstation posture — it turns the protection off rather than adjusting it. |
| `allowedSchemes` | Replaces the scheme allowlist. There is no good reason to add `file:`. |

Neither is a substitute for network-level egress rules in a VM or hosted
profile ([08](../../docs/roadmap/08-deployment-profiles.md)); this is the
in-process half.
