# 13 — Web search: finding a page, not only reading one

## Goal

A `search` toolset that returns ranked results for a query, behind a provider
the operator chooses and pays for — so an agent can find the page it needs
instead of being handed the URL.

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

- **`@stratusagent/tool-search`**, one plugin contributing one toolset, on the
  contract in [`plugins.md`](../architecture/plugins.md).
- **`search.web(query, count?, site?, freshness?)`** → a ranked array of
  `{ title, url, snippet, publishedAt? }`. `risk: 'safe'` — see the open
  question; the short version is that reading a public index acts on nothing.
- **A `SearchProvider` seam** — `{ search(query, options): Promise<SearchResult[]> }` —
  with adapters for Brave, Tavily, Exa, and Google CSE. The operator picks one
  per agent; there is no default, because a default provider is a default
  bill.
- **Keys through the `CredentialResolver`**, resolved per call from
  `session.agent.id` the way `tool-fs` resolves its roots. Not through the
  plugin's config block: a literal key in the `plugins` block would put an API
  key in `stratus.config.json`, and project-local config files get committed.
- **Every request through `@stratusagent/egress`.** A self-hosted SearXNG is a
  legitimate configuration, and an operator pointing a provider at
  `http://localhost:8888` must be doing it deliberately rather than by
  accident — which is precisely what the shared address policy already
  decides.
- **Normalized results only.** The provider's raw payload does not reach the
  agent. A provider that reshapes its JSON must not reshape what every soul
  and skill in the fleet was written against.

**Out:**

- **No first-party index.** There is nothing here worth building and a great
  deal worth buying.
- **No fetching.** `search.web` returns URLs; reading one is `web.fetch`, which
  already exists and already validates redirects hop by hop. Composition is the
  point, and a `search.fetch` that did both would be a second, worse copy of a
  policy 06 owns.
- **No embeddings or semantic retrieval.** That is a different problem with a
  different store; see [14](./14-memory.md).
- **No cross-agent result cache.** Two agents sharing a cache share a record of
  what each was asked to look for, which is an information leak between agents
  whose entire design is isolation. A per-agent cache is fine and is not this
  step.

## Design sketch

- The provider is named in config (`provider: 'brave'`); an unknown name is a
  load-time failure that lists the valid set, not a runtime failure on the
  first search.
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

- An agent whose soul allowlists `search.*` gets results; one that does not is
  refused at both gates.
- Two agents configured with different providers each get their own, from their
  own credential — the test that proves the per-call agent resolution is real
  and not a startup-time capture.
- A provider endpoint on a loopback address is refused unless the operator
  allowed it, proving the egress policy applies here as it does to `web.fetch`.
- A missing key produces a named, actionable failure on that call only.
- A provider returning malformed JSON, a 429, or a 500 fails the call rather
  than the turn.
- The structured log shows the search happened and never shows the query.

## Open questions

- **Is `search.web` `safe` or `gated`?** Leaning `safe`: the risk model grades
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
