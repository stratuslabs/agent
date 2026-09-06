# @stratusagent/tool-web

`web.fetch`: retrieve a URL and get back the text a reader would keep. No
browser, no JavaScript, no Chromium — this is what an agent reaches for
twenty times for every once it needs `browser.*`.

## Install and enable

```bash
npm install @stratusagent/tool-web
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/tool-web": { "enabled": true }
  }
}
```

Then the agent's soul decides, per identity:

```markdown
---
id: ava
tools: [web.fetch]
---
```

## Risk model

| Tool | Risk | What approval mode does |
| --- | --- | --- |
| `web.fetch` | `gated` | `interactive` asks at the terminal, `remote` asks in Slack, `headless` refuses. It reaches a service outside Stratus at an address the agent chose, which is the line 03 draws. |

Every result is labelled `external`: the body and the page-supplied title
are a document somebody else wrote, and the session that read it — and
every fact it remembers afterwards — carries the label
([Memory](../../docs/concepts/memory.md#where-a-fact-came-from)).

Approval decides *whether*; the address policy decides *where*, and it is
not the same question. An approver looking at `https://example.com/report`
has approved that URL — not the redirect it answers with.

## Settings

| Key | Default | What |
| --- | --- | --- |
| `allowedHosts` | none | Hosts exempt from the address check, by name or literal address. The narrow override: one internal service an agent is meant to reach. |
| `allowPrivateAddresses` | `false` | Reach any non-global address. The trusted-workstation posture — it turns the SSRF protection off rather than adjusting it. |
| `maxBytes` | `400000` | Stop reading here; the result says `truncated`. A call's own `maxBytes` may ask for less, never more. |
| `timeoutMs` | `20000` | Give up on the whole exchange — every redirect hop draws on the one budget. |
| `maxRedirects` | `5` | Hops to follow before refusing. |
| `userAgent` | `StratusAgent/0.5 …` | What to send. |

All of them can be set per agent under `agents`, and `allowedHosts` in
particular should be: an exemption written once at the top level is an
exemption every agent gets.

## What it refuses, and where

The address policy is `@stratusagent/egress`, **the same module
`@stratusagent/tool-browser` uses** — not a copy of it. A second
implementation would not drift into a style difference; the stale one would
be an SSRF hole. Both packs are tested against the same table of hostile
URLs, which is what fails if the module is ever forked.

- **Schemes**: `http:` and `https:`. `file:`, `data:`, and `javascript:` are
  refused before anything is fetched — this process can read the files a
  `file:` URL names.
- **Addresses**: every non-global address in both families — loopback,
  RFC 1918, carrier-NAT, link-local (where cloud instance metadata lives),
  IPv6 unique-local and link-local, multicast, and the IPv4-mapped, NAT64,
  and 6to4 forms that write the same addresses a different way.
- **Every hop**: redirects are followed one at a time and each one faces the
  policy from scratch, so a public URL that answers `302 Location:
  http://169.254.169.254/` is a refusal rather than a fetch.
- **The connection itself**: the socket's own DNS resolution is the one that
  gets checked. Resolving a name to validate it and letting the client
  resolve it again to connect is DNS rebinding with extra steps.
