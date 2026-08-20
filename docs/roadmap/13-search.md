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

- **`web.search`, with every option pinned to a meaning.** Naming the options
  is not specifying them: two adapters can both satisfy
  `{ search(query, options) }` while accepting incompatible calls, which
  defeats the one criterion this step exists for. So the schema is the
  deliverable, not an implementation detail of it:

  | Field | Type | Meaning |
  | --- | --- | --- |
  | `query` | `string`, required, non-empty | **Literal text.** The backend must do whatever its provider requires — escaping, quoting, a literal-search parameter — so the upstream searches for the characters given rather than parsing operators out of them. |
  | `count` | `integer`, 1–50, default 10 | A *maximum*. Returning fewer is normal; returning more is a contract violation. |
  | `site` | `string?` — one **hostname**, at least two labels, no scheme, no port, no path | Matches that host and anything under it, on label boundaries: `example.com` matches `docs.example.com` and **not** `notexample.com`; `docs.example.com` matches only itself and its own subdomains. Normalized before comparison — lowercased, any trailing dot removed, IDN converted to its A-label form. Not a query operator, so a backend without native support filters after the fact rather than splicing `site:` into the query. |
  | `freshness` | `string?` — an ISO 8601 duration of **fixed length only**. Accepted: `W`, `D` in the date portion and `H`, `M`, `S` after the `T` (`P7D`, `P4W`, `PT12H`, `PT30M`). Rejected: `Y` and `M` **in the date portion** (`P1Y`, `P1M`). | An age, not a cutoff timestamp and not an enum. Measured back from the instant the request is made, in UTC. Results older than it are excluded, **and so are results with no known date** — see below. |

  **"Verbatim" was the wrong word for `query`, and the two halves of it could
  not both be true.** Most search APIs parse their own operators out of the
  query field, so handing the string over untouched is precisely what lets the
  upstream reinterpret `site:`, `OR`, a minus sign, or a quote — while a
  backend that escapes them is no longer passing anything verbatim. Two
  conforming adapters would then answer the same call differently, which is
  the failure this table exists to prevent.

  What is actually required is the *meaning*: the query is literal, and each
  backend does whatever its provider needs to make that true. An unbalanced
  quote is a search for a quote character, not a syntax error. This is the
  same rule [14](./14-memory.md) states for `memory.recall` against FTS5, and
  for the same reason — the caller is a model writing prose, and the moment a
  search field parses operators, ordinary sentences start meaning something
  nobody typed.

  And the result: `title` and `url` required (`url` absolute, `http`/`https`
  only, already validated by the address policy), `snippet` a plain string with
  markup stripped, `publishedAt` an **ISO 8601 instant in UTC** when the
  backend supplies one and absent when it does not — never a guess, never a
  locale-formatted date.

  **Fixed-length only, because `P1M` and `P1Y` are not one length.** Calendar
  arithmetic is where two conforming adapters part company: subtracting a month
  from 31 March, or a year from 29 February, has more than one defensible
  answer, and an adapter that converts to 30 or 365 days instead disagrees with
  one that does not — at boundaries, intermittently, which is the worst way for
  a difference to show up. Rejecting the two ambiguous designators costs
  nothing a caller wants: `P30D` and `P365D` say what someone asking for "a
  month" or "a year" of search results actually means, and say it identically
  everywhere.

  **"Registrable domain" was the wrong term and it fought its own example.**
  A registrable domain is the public-suffix-plus-one form, so `docs.example.com`
  is not one — an adapter enforcing the term would reject or normalize it up to
  `example.com`, silently widening a search another adapter would keep narrow.
  Hostname with label-boundary suffix matching says what was actually meant and
  needs no public-suffix list to implement, which is a dependency worth not
  acquiring. The two-label minimum is what stops `site: com`.

  **`M` means two things and only one of them is rejected.** ISO 8601 uses the
  same letter for months in the date portion and minutes after the `T`, so
  "reject `M`" would throw out `PT30M`, which is fixed-length and perfectly
  well defined. The rejection is positional: `P1M` is refused, `PT30M` is
  accepted. `W` is accepted for the same reason `D` is — a week is exactly
  seven days with no calendar dependency.

  **An undated result does not survive a `freshness` filter.** Backends omit
  dates for some hits routinely, so leaving this unsaid lets two conforming
  adapters return different sets for identical calls — which is the
  interchangeability criterion failing on the most ordinary input there is.
  Exclusion is the right side to land on for the same reason the rest of this
  table is strict: the agent asked for recent results and will say the answer
  is recent, and "we could not determine a date" is not evidence that it is.
  The cost is real and worth stating rather than hiding — a good undated page
  is dropped — which is why the exclusion applies *only* when `freshness` is
  set, and a call that does not ask about time sees every result.

  Anything a backend cannot honor it must **refuse rather than approximate**.
  A backend that silently ignores `freshness` is worse than one that fails,
  because the agent's next sentence will state the result is recent.
- **The name is `web.search`**, as both governing documents already say — not
  `search.web`. This is not cosmetic: souls and skills allowlist by name, so
  the two spellings are two different capabilities, and a fleet written against
  one silently loses search when a plugin ships the other.
- **The name sits in the `web` namespace on purpose.** A soul that already says
  `tools: [web.*]` picks up search when the operator installs a backend, with
  no soul edit — which is the behaviour an operator expects and the reason the
  glob exists. The risk floor is what keeps that safe rather than surprising:
  `web.*` is first-party today, but an ecosystem search plugin is third-party
  and floors at `gated` no matter what its manifest claims, so the glob widens
  what an agent *can reach* and never what it can do unapproved.
- **A published `SearchProvider` shape that carries the call's context** —
  `{ search(query, options, context): Promise<SearchResult[]> }`, where
  `context` is `{ credentials: ScopedCredentials; signal?: AbortSignal }`.
  Published *from* this repo, implemented *outside* it, so Brave, Tavily, Exa,
  Google CSE, and SearXNG adapters are written against something rather than
  each inventing a result type.

  **The third parameter is what makes per-agent keys possible at all.**
  `CredentialResolver.resolve` takes an `AgentDefinition`, so a `search(query,
  options)` seam leaves one shared adapter instance no way to reach the calling
  agent's key except a factory outside the contract or mutable global state —
  and the per-call credential criterion would not be implementable from the
  published interface.

  It passes `ScopedCredentials` rather than the agent, and that choice is the
  security half: `scopeCredentials(agent, resolver)` is already bound to one
  agent, and its `get(name)` is the whole surface. An adapter therefore has no
  way to *name* another agent, so it has no way to reach another agent's key —
  where handing it an `AgentDefinition` and a resolver would make agent
  isolation a thing every third-party backend author has to not get wrong.

  The `signal` is the turn's, for the same reason every other long-running
  contract in this repository carries one: a cancelled turn must stop the HTTP
  request, not merely stop waiting on it.
- **Normalized results are part of the contract, not an implementation
  detail.** A backend's raw payload never reaches the agent. This is the whole
  value of specifying the step: a provider that reshapes its JSON must not
  reshape what every soul and skill in the fleet was written against.
- **One backend-neutral credential name: `search.apiKey`.** Every backend that
  needs a key asks for that name and no other. This is not tidiness — without
  it the step's central criterion is false. A soul's `credentials` list is
  enforced by `CredentialResolver`, so a Brave adapter asking for
  `BRAVE_API_KEY` and a Tavily adapter asking for `TAVILY_API_KEY` means
  swapping backends edits **every soul in the fleet**, even though the
  `web.search` tool allowlist never moved.

  Two corollaries keep the single name honest. A backend needing something
  that is *not* secret — Google CSE's engine id, SearXNG's base URL — puts it
  in the plugin's config block, which is not soul-scoped and therefore does
  not drag souls into a swap. And a backend needing **no** credential at all
  is legitimate and must not be forced to invent one: SearXNG is the case, and
  an adapter that never calls `get` is conforming, not broken.
- **The rules a backend inherits rather than re-deriving**: the key through
  the `ScopedCredentials` it is handed per call, and every request through
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
- **A place to put that key, which does not exist yet.** This is a prerequisite
  of the step and not an aside: `CredentialsFile` in `packages/state` is
  `Partial<Record<'anthropic' | 'openai', StoredCredential>>` — a closed union
  with no room for a Brave or Tavily key — and `EnvCredentialResolver` is the
  only `CredentialResolver` in the repository. It checks the agent's allowlist
  and then returns `this.env[name]`, one process-wide value per name. So an
  operator told to keep a search key in the credential store today has nowhere
  to put it, and the backend reports the missing-key failure on every call.

  Three parts, all small, all in `state`:

  1. **A named-credential namespace** in the credentials file, beside the
     provider entries, keyed by credential name.
  2. **A file-backed `CredentialResolver`** that reads it, keeps
     `EnvCredentialResolver`'s allowlist check exactly, and falls back to the
     environment so existing setups keep working. Per-agent keys are a lookup
     order rather than an interface change — the agent's own entry, then the
     shared one — because `CredentialResolver.resolve` already takes the agent.
  3. **A way to provision one** from the CLI, since a credential nobody can
     add is a credential nobody has.

  The existing invariants carry over unchanged and are worth restating because
  this is the code that could quietly break them: the file stays `0600` with an
  explicit `chmod`, no endpoint returns a secret, and **channel tokens stay out
  of this path** — they live under `channels.slack.<agentId>` precisely so an
  agent cannot read the tokens of the transport carrying it, and a named
  namespace next door must not become a way in.

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

- **The selection scope is per install; the credential scope is per agent.**
  Which backend runs is the operator's choice, expressed by installing it — the
  `plugins` block already keys on package name, so there is no second
  `provider:` selector to invent and no registry of valid names to keep
  current. Two search plugins enabled at once is a name collision on
  `web.search` and therefore a load-time error, which is the right answer
  rather than an awkward one: a tool name is unique per install, and that rule
  is load-bearing everywhere else in the contract.

  So a fleet does not mix backends, and it does not need to: what differs
  between agents is *whose account pays and whose instance answers*, which is
  the credential, resolved per call. A deployment that genuinely needs two
  backends wants two daemons — the same conclusion 06 reached about the
  browser's address policy, for the same reason.
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
  installed search plugin changes no soul, no skill, and no result shape —
  including no edit to any soul's `credentials` list, which the single
  `search.apiKey` name is what buys. This is the criterion the whole step
  exists for, and a version that ships one backend and never proves the second
  has not met it.
- **A backend that needs no credential works unchanged**, with no placeholder
  key invented to satisfy a contract — the SearXNG case, and the proof the
  single name did not become a single requirement.
- **A third-party search plugin registers `gated` even if its manifest says
  `safe`** — the floor holding across a namespace whose other tools are
  first-party.
- **One option suite runs against both backends and gets answers meaning the
  same thing**: `count` respected as a maximum, `site` excluding a
  lookalike parent domain, `freshness` excluding an older result **and an
  undated one**, and `publishedAt` parsing as a UTC instant from both. This is
  where interchangeability is actually won or lost, and the undated case
  belongs in it because it is the one every backend produces without being
  asked.
- **`P1M` and `P1Y` are rejected by both backends with the same error, while
  `PT30M` is accepted by both** — proving the rejection is positional rather
  than a blanket ban on the letter, which would throw out a fixed-length
  duration the table explicitly permits.
- **An operator-bearing query returns results about the operators.**
  `site:example.com`, `a OR b`, `-foo`, and a string with an unbalanced quote
  each search for their literal text on both backends, rather than being
  interpreted by one provider and not the other.
- **A backend that cannot honor an option fails the call naming it**, rather
  than returning results that silently ignore it.
- **A key stored in the credential store is resolvable by an allowlisted agent
  and refused for one whose soul does not list it** — the existing
  `EnvCredentialResolver` check surviving the move to a file-backed store.
- **A named credential is never returned by any endpoint**, and the credentials
  file is still `0600` after the new namespace is written to it.
- **Two agents searching the one installed backend use their own credentials**,
  resolved per call — the test that proves the agent resolution is real and not
  a startup-time capture. Different *backends* per agent is not a criterion,
  because it is not a thing the design permits; see the selection scope below.
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
