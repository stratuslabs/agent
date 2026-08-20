# 14 — Memory: recall the agent performs, not recall that happens to it

## Goal

Search and forget on the memory store, a rebuildable index behind them, and
three tools that let an agent decide what is worth remembering and go looking
for it later — so "gets smarter over time" is something an agent does rather
than something the runtime does to it.

JSONL stays the source of truth. [`stratus-v2.md`](../architecture/stratus-v2.md)
decision 5 says the files users can read and edit are the interface and that
smarter stores never replace them, and that decision is not up for revision
here: what this step adds is an *index over* those files, not a store in front
of them.

## Why now

`AgentMemoryStore` in `packages/core` is `append` and `list`. That is two
problems wearing one interface.

The first is that recall is all-or-nothing. `list` returns everything an agent
has ever stored, so the only implementable policy is to inject all of it or
none of it. That is fine at ten entries and impossible at ten thousand, and an
always-on agent reaches ten thousand by running. The store as written has a
horizon measured in weeks.

The second is that the agent is not a participant. Nothing in the kernel lets a
model say *this is worth keeping* or *what do I know about this*; memory is
written by the runtime, on the runtime's schedule, about what the runtime
thought was interesting. The product's first sentence promises agents that get
smarter over time, and the mechanism for getting smarter is currently closed to
the agent.

[09](./09-skills.md) is the taught half of competence — procedures an operator
installs. This is the learned half, and the two are worth building near each
other because they fail in opposite directions: a skill that is never updated
goes stale, and a memory that is never curated goes noisy.

## Scope

**In:**

- **`AgentMemoryStore` grows `search(agentId, query, limit)` and
  `forget(agentId, entryId)`**, and `list` grows a bounded form. The in-memory
  implementation in `packages/core` implements all three, because it is what
  every test uses.
- **A derived FTS index, not a replacement store.** `~/.stratus/memory.jsonl`
  remains the record: it is what an append writes, what an operator can read in
  a terminal, and what survives if everything else is deleted. Alongside it
  sits a `node:sqlite` FTS5 index — the same storage technology the session
  store already uses, so there is no second database to operate — holding what
  `search` needs and nothing that cannot be reconstructed.

  The index is **rebuildable from the JSONL by definition**, and that property
  is the design rather than a nicety. It means an upgrade has no data migration
  to get wrong, a corrupt index is repaired by deleting it, and a user who
  hand-edits the file the way decision 5 promises they can gets a store that
  agrees with what they wrote. A version stamp on the index that does not match
  the current schema is a rebuild trigger, not an error.

  **Being derived is a claim that has to be checked, not just declared.** A
  schema stamp catches a change to the index's shape and nothing about its
  contents, which leaves two ordinary situations producing an index that is
  current-version and permanently wrong: a crash between the JSONL append and
  the index write, and an operator editing the file — the thing decision 5
  explicitly promises they may do. Either one makes `recall` quietly disagree
  with `list`, omitting entries that are in the record or returning ones that
  are not.

  So the index carries a **watermark** with two layers, because one is not
  enough. It records `(inode, size, mtime)` of the file as it stood when the
  index was written, the byte offset consumed, and a **digest of that consumed
  prefix**.

  - `(inode, size, mtime)` all match → the file has not been written to since.
    Trust the index; do no work.
  - Anything differs → recompute the digest of the prefix. If it matches, this
    was a pure append: index the tail. If it does not, the record was edited
    underneath the index: full rebuild.

  The digest is what makes the check honest, and the reason is worth writing
  down because the cheaper version looks sufficient and is not. An offset plus
  the last entry's id passes an operator editing an *earlier* entry in place
  without changing its length — and passes it again if a normal append follows,
  where the tail-index path would then quietly bless a corrupted prefix. Those
  are not exotic: fixing a typo in a remembered fact is the most obvious thing
  a person does to a file this design invites them to open.

  The cost lands in the right place. Nothing changed is the overwhelmingly
  common case and stays O(1); the prefix scan is paid only when the file
  actually moved, which is also exactly when correctness is in question. The
  failure direction is **rebuild, never trust** — an ambiguous result costs one
  rebuild, where the other default costs correctness silently and indefinitely.

  What this defends against is **accident, not tampering**: it assumes an
  operator editing their own file, not one forging metadata. Anyone who can
  rewrite `~/.stratus/memory.jsonl` can rewrite the index beside it, so
  integrity against a local attacker is not a property this can have and is not
  one it claims.
- **Retrieval by FTS5, not embeddings.** No provider, no key, no network, no
  per-query cost, deterministic output, and genuinely good at *what do I know
  about X*. Embeddings are an obvious later plugin behind the same seam, and
  starting there would make the first version of memory depend on a second
  vendor relationship. It also keeps the index derived: an embedding index that
  cost money to build is one nobody will agree to throw away and rebuild.
- **`query` is literal text, never FTS5 syntax.** This needs saying because the
  obvious implementation gets it wrong: passing the string straight into
  `MATCH ?` makes FTS5 interpret its own operators, so `C++` is a syntax error,
  an unmatched quote is a syntax error, and `AND` in the middle of a sentence
  silently changes the search. The caller here is a *model*, writing whatever
  the conversation suggests — so the common case is exactly the one that
  breaks, and `memory.recall` starts returning tool errors for ordinary
  questions.

  The store therefore tokenizes and quotes each term itself rather than
  forwarding the string, and **no input is a syntax error**: a query that
  matches nothing returns nothing. This is the same rule
  [13](./13-search.md) states for `web.search` — the query is passed through,
  not reinterpreted — and it is worth the two specs agreeing, because a skill
  that searches the web and then searches memory should not have to know that
  one of them silently speaks a query language.
- **`withLegacyDefaultMemories` learns the new methods, alias-aware.** The
  wrapper in `packages/state` today special-cases `list` only: for the built-in
  `stratus` agent it merges entries stored under `demo-agent`,
  `anthropic-agent`, and `openai-agent`, so an unsouled install that predates
  the rename keeps its memory. `append` passes straight through and there is
  nothing else to pass.

  A `search` and `forget` that delegate on `agentId` alone would compile,
  satisfy the interface, and quietly make every inherited entry unfindable and
  unforgettable — visible in `list`, absent from `recall`. So both are
  alias-aware, and **the limit applies after the merge, never per alias**, or
  a busy legacy id crowds out the others. The same test that covers `list`
  today covers all three.
- **`memory.recall(query, limit?)`** — `risk: 'safe'`. Reading what this agent
  already knows.
- **`memory.remember` keeps `risk: 'safe'`, and this step does not touch it.**
  It already exists — `MEMORY_TOOL_NAME` in `packages/agents`, registered
  `safe` by `createRememberTool` — and core's risk taxonomy defines `safe` in
  terms that name this exact case: "writes the agent already owns (its own
  memory)". Reclassifying it here would deny **every** remember call under
  headless mode, where only safe calls run, which is precisely the deployment
  the feature is for: an unattended agent that cannot record what it learned
  does not learn. See the open question for the argument that the taxonomy
  itself deserves revisiting — that argument belongs in the document that owns
  the taxonomy, not in this one.
- **`memory.forget(id)`** — `risk: 'safe'` by the same rule, and **tombstoned
  rather than deleted**, which is what makes `safe` defensible for it: the
  entry stops being live but does not stop existing, so an operator can still
  see what an agent chose to drop.
- **The per-agent key is the access boundary**, resolved from
  `session.agent.id` on every call, exactly as `tool-fs` resolves roots — never
  captured at startup and never taken from config.
- **Turn injection changes shape**: the system prompt carries a bounded slice
  (the most recent N) instead of the whole store, and everything else arrives
  through `memory.recall`. This is a **behavior change**, not an addition —
  existing agents' prompts get smaller and their unprompted recall gets
  narrower — and it is the change that makes the store survive its second year.

**Out:**

- **No shared memory between agents.** Two agents reading one store is a policy
  decision with an access-control model behind it, and the current model says
  memory is keyed by agent precisely so that routing to the wrong identity
  cannot cross it.
- **No automatic consolidation or summarization** of old entries. It is the
  right idea and it is a tuning problem that will churn; it should not be
  wired in underneath a store that is still proving its interface.
- **No embeddings.** See above.

## Design sketch

- **`migrateLegacyMemory` is not the hook for this, and assuming it was is the
  mistake this bullet exists to prevent.** It lives in
  `packages/state/src/index.ts`, not the gateway, and what it does is relocate a
  *project-local* `.stratus/memory.jsonl` into the global JSONL file — JSONL to
  JSONL, one directory to another. It has no knowledge of an index and would
  not acquire any.

  The reason this matters is that a spec which quietly assumed otherwise would
  ship an upgrade that loses every existing memory while its acceptance tests
  passed: "remember in one session, recall in the next" is satisfied by a fresh
  install, and every install in the field is not one. Keeping the JSONL as the
  record removes the failure rather than handling it — there is no import step
  to write, because the file the upgrade must not forget is the file the new
  code already reads. The index is built from it on first start.
- **`list` is active-only, and the bound applies after the filter.** This is
  the difference between forgetting something and merely hiding it from
  `recall`: `list` is what feeds turn injection, so a `forget` that only
  removed an entry from search would keep shipping the forgotten content into
  every provider request for the rest of the agent's life — while an
  acceptance criterion saying "stops appearing in `recall`" passed. Tombstoned
  entries reach an operator through an explicit audit read, never through the
  path that builds a prompt. Filtering after the bound would be the same bug in
  smaller print: N entries fetched, some dropped, a short slice returned that
  claims to be the most recent N.
- The daemon log records that an entry was written and its id. Not its content:
  a memory is closer to a transcript than to a tool argument.
- `memory.recall` returning nothing is a normal result, not an error. An agent
  that has learned nothing yet is the ordinary starting state and must not read
  as a broken tool.

## Acceptance criteria

- An agent remembers a fact in one session and recalls it in a **new session
  after a daemon restart** — the test that proves durability rather than
  process-lifetime caching.
- **An installation that already has a populated `~/.stratus/memory.jsonl`
  recalls every one of those entries after upgrading, with no import step.**
  This is the criterion a fresh-install test cannot reach, and the one that
  fails loudly if anyone later reintroduces a store that shadows the file.
- **Deleting the index and restarting reproduces it exactly**, and a stale
  schema stamp triggers the same rebuild rather than an error. A store that is
  only *claimed* to be derived is a store that has quietly become the record.
- **An entry appended to the JSONL by hand is recallable**, which is what
  decision 5's promise that the files are the interface actually costs.
- **An entry appended while the daemon was stopped is recallable on the next
  start, and an edit that rewrites the file rebuilds rather than being
  half-believed** — the watermark doing its job in both directions. The first
  is the crash case in disguise, which is why one test covers both.
- **`recall` on `C++`, on an unmatched quote, and on a sentence containing
  `AND` all return results or nothing, never a tool error** — the queries a
  model actually writes, against a store whose obvious implementation rejects
  them.
- **The built-in `stratus` agent can recall and forget a memory stored under a
  legacy default id** — an upgraded unsouled install, which every per-agent
  test passes right over.
- Agent A cannot recall agent B's entries, and the test names both agents
  rather than asserting an empty result that an unrelated bug would also
  produce.
- **`memory.remember` still runs under headless mode**, unchanged from today —
  the criterion that fails loudly if anyone reclassifies it, and it is refused
  outright for an agent whose soul does not allowlist it.
- **A forgotten entry stops appearing in `recall`, stops appearing in the
  bounded `list`, and therefore stops reaching the system prompt** — asserted
  against the injected prompt itself, not against `recall` alone, because
  `recall` was the half that would have passed either way. It remains visible
  through the operator's audit read.
- **A bounded `list` over a store whose recent entries are mostly tombstoned
  still returns a full slice of live ones**, proving the bound is applied after
  the filter rather than before it.
- Recall against a store with thousands of entries returns in bounded time and
  bounded tokens — stated as a criterion because it is the exact failure the
  current `list` has, and a version of this step that keeps that failure has
  not done anything.
- The structured log names the entry id and never its content.

## Open questions

- **Does the dashboard get a memory view?** Leaning yes. "What has my agent
  actually learned" is the first question anyone asks about a fleet that has
  been running a month, and [05](./05-control-api.md)'s catalog screen is the
  precedent for answering it from a read-only endpoint. It also gives `forget`
  a human operator, which an agent-only interface does not.
- **Should recall also fire automatically at turn start**, as a cheap FTS query
  against the incoming message, in addition to the explicit tool? Leaning no
  for this step: automatic relevance is a tuning problem that will churn for
  months, and the explicit call is the one that can be tested. Worth revisiting
  once there is real usage to tune against.
- **Does `remember` need a size cap per entry, or per agent?** Unbounded growth
  is the failure mode nobody notices until the disk does.
- **Should the risk taxonomy treat memory writes as their own category?** The
  spec keeps `memory.remember` at `safe` because that is what core's taxonomy
  says and what ships today, and reclassifying it in a roadmap page would both
  break headless agents and repeat a mistake this PR already made twice. But
  there is a real argument the taxonomy does not currently see: memory content
  is model-authored text replayed into a later system prompt, which makes it
  the one channel carrying instructions *across* the turn boundary. An agent
  that reads a hostile page and remembers what it said has laundered that text
  past every check the turn applied, into a context where it reads as the
  agent's own prior conclusion — so [13](./13-search.md)'s untrusted snippets
  and this write path are the same attack in two halves.

  That is not an argument for `gated`, which would trade the attack for a
  feature nobody can use unattended. It is an argument for something the model
  does not have: a way to mark content as untrusted at the point it enters
  memory and keep that marking when it comes back out. If the untrusted-content
  envelope in 13's open questions gets built, this is its second consumer. The
  decision belongs in `stratus-v2.md` and core, not here.
