# @stratusagent/search

**`web.search`: the contract, not a backend.** One tool name, one option
meaning, one result shape — so two independently written search plugins are
interchangeable behind one soul allowlist, and swapping vendors changes no
soul, no skill, and no result shape.

This package ships **no backend and reaches no vendor.** Every backend needs
an API key and a commercial relationship, so core ships `web.fetch` and the
ecosystem ships `web.search` ([`plugins.md`](../../docs/architecture/plugins.md)).
What has to be first-party is the half that makes the other half worth
anything.

## For an operator

You need a backend plugin. Install it, enable it in a trusted config, and
store the key:

```bash
npm install -g stratus-plugin-somesearch
printf %s "$SEARCH_KEY" | stratus credential set search.apiKey
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "stratus-plugin-somesearch": { "enabled": true, "maxSearchesPerDay": 200 }
  }
}
```

Then each agent's soul opts in, on both gates — the tool and the credential:

```markdown
---
id: ava
tools: [web.fetch, web.search]
credentials: [search.apiKey]
---
```

`tools: [web.*]` picks up search too, with no soul edit, which is the reason
the glob exists. The `credentials:` line is separate and is **not** optional:
without it every call answers "Agent ava is not allowed to access credential:
search.apiKey".

**Two backends cannot be enabled at once.** Both contribute `web.search`, and
a tool name is unique per install, so that is a load-time error naming both
packages. A deployment that genuinely needs two backends wants two daemons.

### Settings every backend accepts

A backend's manifest must declare these in its `config` schema, because they
are read by the shared tool rather than by the backend's own code. All of
them take a per-agent override in the `agents` sub-block.

| Key | Default | What |
| --- | --- | --- |
| `maxSearchesPerDay` | `200` | Calls one agent may make in a UTC day. A query acts on nothing, but a metered API costs money and an agent in a loop can spend it. `0` refuses every call, which is how you turn one agent's search off without editing its soul. There is deliberately no "uncapped" — set a large number if that is what you mean. |
| `allowedHosts` | none | Hosts exempt from the address check. What a self-hosted backend on `localhost` needs. |
| `allowPrivateAddresses` | `false` | Reach any non-global address. Turns the SSRF protection off rather than adjusting it. |

The cap is **kept in the daemon's process**, so a restart forgives the count.
That is stated rather than hidden: its job is to stop a runaway loop, and a
loop lives inside one daemon's lifetime.

### The credential is one name, whatever the vendor

`search.apiKey`. Always. A Brave adapter asking for `BRAVE_API_KEY` and a
Tavily adapter asking for `TAVILY_API_KEY` would mean swapping backends edits
**every soul in the fleet**, even though the `web.search` allowlist entry
never moved.

Two corollaries. Something that is *not* secret — a Google CSE engine id, a
SearXNG base URL — goes in the plugin's config block, which is not
soul-scoped. And a backend needing **no** credential is legitimate: a
self-hosted instance never calls `get`, and is conforming rather than broken.

A key belongs in the credential store, never as a literal in the config
block — a key in `stratus.config.json` is a key in a file people commit.

## For a backend author

Implement one method. Everything else — the tool name, the schema, the
option parsing, the filtering, the envelope, the credential seam, the address
policy — is this package's, which is what makes your backend swappable with
somebody else's.

```ts
import {
  createWebSearchTool,
  defineSearchProvider,
  SEARCH_CREDENTIAL_NAME,
} from '@stratusagent/search';
import { requestThroughPolicy } from '@stratusagent/egress';
import type { JsonObject, Plugin } from '@stratusagent/core';

const createBackend = (config: JsonObject) => defineSearchProvider({
  name: 'somesearch',
  async search(query, options, context) {
    const key = await context.credentials.get(SEARCH_CREDENTIAL_NAME);
    const url = new URL('https://api.somesearch.example/v1/search');
    url.searchParams.set('q', query);          // literal text — see below
    url.searchParams.set('count', String(options.count));
    if (options.site) url.searchParams.set('host', options.site);
    if (options.freshness) url.searchParams.set('since', options.freshness.since);

    // Every request through the policy you were handed. Never derive one.
    const response = await requestThroughPolicy(url.href, {
      policy: context.policy,
      headers: { 'x-api-key': key },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (response.status !== 200) {
      throw new Error(`The somesearch API answered ${response.status}.`);
    }
    return (JSON.parse(response.body).results ?? []).map((row) => ({
      title: row.title,
      url: row.url,
      snippet: row.description,
      publishedAt: row.published,
    }));
  },
});

export const createPlugin = (config: JsonObject): Plugin => ({
  name: 'stratus-plugin-somesearch',
  setup(context) {
    context.tools.register(createWebSearchTool({
      provider: createBackend(config),
      config,
      ...(context.credentials ? { credentials: context.credentials } : {}),
      // The daemon's log records that a search ran and against which
      // provider — never the query, which is user content.
      onSearch: (record) => context.log?.(`web.search via ${record.provider} — ${record.results} result(s)`),
    }));
  },
});
```

Your `package.json` manifest declares the tool and the credential:

```jsonc
"stratus": {
  "pluginVersion": 1,
  "contributes": { "tools": [{ "name": "web.search", "risk": "safe" }] },
  "credentials": ["search.apiKey"],
  "config": {
    "type": "object",
    "properties": {
      "maxSearchesPerDay": { "type": "integer" },
      "allowedHosts": { "type": "array", "items": { "type": "string" } },
      "allowPrivateAddresses": { "type": "boolean" }
    },
    "additionalProperties": false
  }
}
```

Declare `risk: "safe"` if you like — **it will register `gated` anyway.**
`safe` means "run this unattended, with nobody watching", and that is not a
claim the code being judged gets to make about itself; the third-party floor
applies to `web.*` exactly as it does everywhere else.

### The options, pinned

| Field | Type | Meaning |
| --- | --- | --- |
| `query` | `string`, required, non-empty | **Literal text.** Do whatever your provider requires — escaping, quoting, a literal-search parameter — so the upstream searches for the characters given rather than parsing operators out of them. An unbalanced quote is a search for a quote character, not a syntax error. |
| `count` | `integer`, 1–50, default 10 | A **maximum**. Returning fewer is normal; returning more is a contract violation, and this package truncates. |
| `site` | one normalized hostname | Matches that host and anything under it, on label boundaries: `example.com` matches `docs.example.com` and **not** `notexample.com`. Already lower-cased, trailing dot removed, IDN in A-label form. Not a query operator — never splice `site:` into the query. |
| `freshness` | `{ duration, ms, since }` | An age, resolved to an instant once per call. `since` is the oldest a result may be. |

A call carrying any **other** field is refused naming it. The caller is a
model writing JSON, so `freshnes: "P7D"` is a realistic mistake — and read as
"no freshness filter" it runs an unrestricted search that *succeeds*, after
which the agent says the answer is recent. A dropped option is a silently
ignored one arriving a step earlier, and this table is strict for that reason
throughout.

### What `publishedAt` may be

An **ISO 8601 instant**, and the shape is checked before anything is parsed
— because `new Date(value)` is not a validator. It reads `03/04/2026` as
4 March without ever saying whether the backend meant March or April, and it
silently *corrects* `2026-02-30` into 2 March. A lenient parse therefore does
not fail to date a result, it **invents** a date, and a `freshness` filter
then keeps or drops the result on the strength of it.

| Accepted | Read as |
| --- | --- |
| `2026-09-01T09:00:00Z` | itself |
| `2026-09-01T11:00:00+02:00`, `…+0200` | the same instant, in UTC |
| `2026-09-01` | UTC midnight |

Everything else becomes absent, which under `freshness` means the result is
dropped: a locale-formatted date, a day that does not exist, and a
**zone-less** `2026-09-01T10:00:00` — that last one is *local* time to
whatever machine parses it, so the same string is two different instants on
two daemons, which is the disagreement this package exists to remove. Convert
your vendor's format; that is the one job a backend cannot hand back.

A date with no time is accepted rather than refused because plenty of
backends only have a day, and refusing them would silently empty every
`freshness` search against such a backend. Reading it as midnight errs
towards calling a page slightly older than it is, which is the safe
direction.

Results older than `freshness` are excluded, **and so are results with no
known date** — which is the case every backend produces without being asked.
Leaving that unsaid would let two conforming adapters return different sets
for identical calls. The agent asked for recent results and will say the
answer is recent, and "we could not determine a date" is not evidence that it
is. The exclusion applies *only* when `freshness` is set.

**Refuse rather than approximate.** A backend that silently ignores an option
is worse than one that fails. Declare what you cannot honor and the call is
refused naming it, before a request is spent:

```ts
defineSearchProvider({ name: 'somesearch', unsupported: ['freshness'], search })
```

Omitting `unsupported` means you honor everything, which fails towards the
contract: you opt out deliberately rather than being quietly excused.

### What you do not have to get right

The shared tool applies `count`, `site`, and `freshness` to whatever you
return, validates every result URL against the address policy, strips markup
from snippets, and turns `publishedAt` into a UTC instant (dropping anything
that will not parse, rather than guessing).

Pass your vendor's decorated snippet straight through — highlight markup is
expected. Inline formatting is **removed**, not replaced with a space,
because vendors highlight the matched *substring*: `un<strong>expected</strong>`
reads back as `unexpected`, and `<strong>kettle</strong>.` keeps its full
stop attached. Anything that is not inline formatting becomes a space
instead, so two table cells never fuse into `AlphaBeta`. Send the options upstream anyway
where your vendor supports them — native filtering ranks better than a filter
applied afterwards — but the guarantee does not rest on your having done so.

Freshness is fixed-length only: `P7D`, `P4W`, `PT12H`, `PT30M`. `P1M` and
`P1Y` are refused, because a month from 31 March and a year from 29 February
each have more than one defensible answer, and an adapter that converted to
30 or 365 days would disagree with one that did not — at boundaries,
intermittently. The rejection is **positional**: `PT30M` is thirty minutes
and is fine.

## The result envelope

```jsonc
{
  "query": "kettles",
  "provider": "somesearch",
  "results": [
    { "title": "…", "url": "https://…", "snippet": "…", "publishedAt": "2026-09-01T09:00:00.000Z" }
  ],
  "untrusted": true,
  "untrustedNote": "Titles and snippets below were written by the pages that own them…"
}
```

Snippets are attacker-controlled text: written by whoever owns the page,
selected by a third-party ranker, and handed to a model that is about to
decide what to do next. **This does not solve prompt injection** and does not
claim to — it marks the boundary, because doing so is nearly free here and a
retrofit across every tool that returns third-party text is not. Whether the
marking should become a kernel concept that `web.fetch` and the MCP bridge
share is [13](../../docs/roadmap/13-search.md)'s open question, still open.
