# 13 — Web search: the contract the ecosystem implements

## Goal

Specify `web.search` — its name, its result shape, and the rules any backend
obeys — so an agent can find the page it needs instead of being handed the URL,
and so two independently written search plugins are interchangeable behind one
soul allowlist.

**The backends stay outside this repository.**
[`plugins.md`](../architecture/plugins.md) calls search "the deliberate example
of something that stays outside" — every backend needs a vendor key and a
commercial relationship, so core ships `web.fetch` and the ecosystem ships
`web.search` — and [06](./06-tool-packs.md) lists web search under **Out** for
the same reason. That boundary is not revisited here. What this step supplies
is the half that has to be first-party for the ecosystem half to be worth
anything: a fixed tool name and a fixed result shape, so a soul or a skill
written against search keeps working when the operator changes vendor.

## Why now

[06](./06-tool-packs.md) shipped `web.fetch` and `browser.*`, and both begin
with a URL the agent must already have. It does not have one. What happens in
practice is that the model guesses: sometimes a 404, sometimes worse — a
plausible-looking domain that belongs to somebody else and answers confidently.
A fetch tool without a search tool is not a smaller capability, it is a
capability that invites fabrication.

It is also the gap most visible from outside. Search is a primitive on every
comparable platform, and it is the first thing missing from a feature
comparison. [09](./09-skills.md) makes this worse before it makes it better:
research procedures are exactly the sort of thing a skill teaches, and every
one of them will be written assuming search exists.

## Scope

**In:**

- **`web.search(query, count?, site?, freshness?)`** → a ranked array of
  `{ title, url, snippet, publishedAt? }`. The name is `web.search`, as both
  governing documents already say — not `search.web`. This is not cosmetic:
  souls and skills allowlist by name, so the two spellings are two different
  capabilities, and a fleet written against one silently loses search when a
  plugin ships the other.
- **The name sits in the `web` namespace on purpose.** A soul that already says
  `tools: [web.*]` picks up search when the operator installs a backend, with
  no soul edit — which is the behaviour an operator expects and the reason the
  glob exists. The risk floor is what keeps that safe rather than surprising:
  `web.*` is first-party today, but an ecosystem search plugin is third-party
  and floors at `gated` no matter what its manifest claims, so the glob widens
  what an agent *can reach* and never what it can do unapproved.
- **A published `SearchProvider` shape** —
  `{ search(query, options): Promise<SearchResult[]> }` — so Brave, Tavily,
  Exa, Google CSE, and SearXNG adapters are written against something rather
  than each inventing a result type. Published *from* this repo, implemented
  *outside* it.
- **Normalized results are part of the contract, not an implementation
  detail.** A backend's raw payload never reaches the agent. This is the whole
  value of specifying the step: a provider that reshapes its JSON must not
  reshape what every soul and skill in the fleet was written against.
- **The rules a backend inherits rather than re-deriving**: keys through the
  scoped `CredentialResolver`, resolved per call from `session.agent.id` the
  way `tool-fs` resolves its roots; and every request through
  `@stratusagent/egress`. Both are available to third-party plugins — the
  resolver through `PluginContext` (kernel change 9), the address policy as a
  published package — so "it needs the credential resolver" is not an argument
  for shipping the backend here. It is an argument for saying so in the
  contract, which is what this bullet is.
- **Two rules stated once, because a backend author will otherwise guess.** A
  key belongs in the credential store, never as a literal in the plugin's
  config block — a key in `stratus.config.json` is a key in a file people
  commit. And a self-hosted backend on `http://localhost:8888` is a legitimate
  configuration that must be a deliberate allowance rather than an accident,
  which is exactly the decision the shared address policy already makes.

**Out:**

- **No first-party backend, and no `@stratusagent/tool-search`.** This is the
  governing boundary, not a scoping preference: vendor keys and commercial
  relationships stay in the ecosystem. See the open question for the one case
  that argues against it.
- **No first-party index.** There is nothing here worth building and a great
  deal worth buying.
- **No fetching.** `web.search` returns URLs; reading one is `web.fetch`, which
  already exists and already validates redirects hop by hop. Composition is the
  point, and a tool that did both would be a second, worse copy of a policy 06
  owns.
- **No embeddings or semantic retrieval.** That is a different problem with a
  different store; see [14](./14-memory.md).
- **No cross-agent result cache.** Two agents sharing a cache share a record of
  what each was asked to look for, which is an information leak between agents
  whose entire design is isolation. A per-agent cache is fine and is not this
  step.

## Design sketch

- **Which backend is installed is the operator's choice, expressed by
  installing it** — the `plugins` block already keys on package name, so there
  is no second `provider:` selector to invent and no registry of valid names to
  keep current. Two search plugins enabled at once is a name collision on
  `web.search` and therefore a load-time error, which is the right answer: the
  operator picks one.
- A missing or rejected key fails **that call**, with the install-hint shape
  the other packs use — naming the credential to add — and leaves the daemon
  serving every other agent. A search key is the kind of thing that expires on
  a Sunday.
- Snippets are attacker-controlled text. They are written by whoever owns the
  page, selected by a third-party ranker, and handed to a model that is about
  to decide what to do next: this is the classic injection surface, and it
  arrives here before it arrives anywhere else in the system. This step does
  not solve prompt injection. It should mark the result envelope as untrusted
  content anyway, because doing so is nearly free now and a retrofit across
  every tool that returns third-party text is not.
- The daemon log records that a search ran and against which provider. **Not
  the query** — a query is user content, and the log is a trace rather than a
  second transcript.

## Acceptance criteria

- An agent whose soul allowlists `web.search` — or `web.*` — gets results; one
  that does not is refused at both gates.
- **Two backends from different authors are interchangeable**: swapping the
  installed search plugin changes no soul, no skill, and no result shape. This
  is the criterion the whole step exists for, and a version that ships one
  backend and never proves the second has not met it.
- **A third-party search plugin registers `gated` even if its manifest says
  `safe`** — the floor holding across a namespace whose other tools are
  first-party.
- Two agents configured with different backends each get their own, from their
  own credential — the test that proves the per-call agent resolution is real
  and not a startup-time capture.
- A provider endpoint on a loopback address is refused unless the operator
  allowed it, proving the egress policy applies here as it does to `web.fetch`.
- A missing key produces a named, actionable failure on that call only.
- A provider returning malformed JSON, a 429, or a 500 fails the call rather
  than the turn.
- The structured log shows the search happened and never shows the query.

## Open questions

- **Does SearXNG earn a first-party exception?** The reason `plugins.md` keeps
  search outside is stated precisely — "every backend needs a vendor key and a
  commercial relationship" — and SearXNG is the one backend for which that
  sentence is false. It is self-hosted, needs no key, and involves no vendor,
  for a product whose agents already run on the operator's own hardware. That
  is a narrow, principled exception rather than an erosion of the boundary, and
  it would give the contract a reference implementation that CI can actually
  run. It is also a change to a governing document, so it is a decision to
  make deliberately in `plugins.md` and not a scope call inside this step.
  Everything else here is written to be true either way.
- **Is `web.search` `safe` or `gated`?** Leaning `safe` as a contract
  statement, while noting that the third-party floor makes it `gated` in
  practice for any ecosystem backend — a gap worth stating rather than
  discovering. The reasoning for `safe`: the risk model grades
  *acting on the world*, and a query acts on nothing. The counter-argument is
  real but different in kind — a metered API costs money, and an agent in a
  loop can spend it. That is a budget control, not a permission, and the
  answer is probably a per-agent daily cap in the plugin's config rather than
  an approval prompt on every search. Worth deciding before the first
  unattended agent, not after the first bill.
- **Should the untrusted-content marking be a kernel concept?** If
  `ToolResult` grew a way to say "this text came from outside", `web.fetch`
  and the MCP bridge in [11](./11-mcp.md) would both want it too. Leaning yes,
  and leaning towards doing it here because this is where it first hurts.
