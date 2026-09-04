# 29 — Memory quality: entries that carry their own history, and a ruler to measure recall

## Goal

Memory that is still useful in year two: entries that know enough about
themselves to be superseded, ranked, and bounded by validity; an injected slice
chosen by what the agent knows rather than by what the clock says; and a
benchmark that turns every later tuning decision into a measurement instead of
an argument.

## Why now

[14](./14-memory.md) built the substrate and was right about it — JSONL as the
record, a derived index, recall the agent performs. What it could not do in one
step is make the *selection* good, and it says so: turn injection is the twenty
most recent entries, oldest first.

Recency is the weakest selection policy available. It is uncorrelated with the
conversation, it silently drops everything older, and it spends tokens every
turn to do both. It is also the only policy the current entry shape can
support: a `MemoryEntry` is `{ id, agentId, content, createdAt }` plus opaque
metadata, so nothing downstream can tell a preference from an observation, or a
current fact from a superseded one. Every ranking idea dies at the same place —
there is nothing to rank on.

Two things make this the moment rather than later:

- **Every open question in 14 and 21 is a tuning question with no way to settle
  it.** Automatic recall at turn start, decay, slice size, consolidation
  aggressiveness — each is recorded as "leaning" one way. Those do not converge
  by argument, and each one relitigated in a PR review costs more than the
  harness that would answer it.
- **[21](./21-team-knowledge.md) is about to add a second scope and a second
  writer.** Whatever an entry must carry — validity, authorship, supersession —
  is far cheaper to add while there is one scope and one writer than after a
  shared pool exists with its own rendering and its own mutation policy.

**Depends on [30](./30-provenance.md)** for the trust label an entry carries and
for how a labelled region renders. The two were one step until review made the
split obvious: every round after the first found another hole in the provenance
half while the quality half stood, which is what a different blast radius and a
different review look like.

## Scope

**In:**

- **`MemoryEntry` grows optional, additive fields**, and the JSONL stays the
  record. A line carrying only `id`, `agentId`, `content`, and `createdAt`
  still loads, is still recallable, and still reaches the prompt — the
  hand-edit promise from decision 5 is not weakened by a richer shape, so
  `isEntryRecord` keeps requiring exactly the four fields it requires today.

  - **`kind`** — `semantic` (a fact about the world), `episodic` (a thing that
    happened), `procedural` (how something is done), `preference`. One flat
    bucket is why memory goes noisy: these have different useful lifetimes and
    different injection value, and no policy can distinguish them from prose.
  - **`about`** — the entities a fact concerns. This is what makes "everything
    I know about the deploy pipeline" a lookup rather than a guess at query
    terms, and it is what the index block below is built from.

    **`about` participates in matching, in both stores.** Search matches query
    tokens against `content` alone today, so without this the index block
    advertises a topic the search cannot find: an entry reading "it now uses
    Postgres" with `about: ["deploy pipeline"]` would be listed under that
    topic and then miss the very query the listing invites. That also breaks
    the entity-alias case in the corpus, which is precisely the case `about`
    exists to serve — an alias in `about` matching a pronoun in `content` is
    the point, not an edge. The FTS `tokens` column and
    `memoryQueryMatches` both cover content plus `about` keys, tokenized by
    the shared tokenizer, with parity coverage: an implementation that
    searched one and not the other would be a divergence, not a preference.
  - **`validFrom` / `validUntil`** — validity is a different axis from
    `createdAt`, which is transaction time. Conflating them is why assistants
    confidently report where someone used to work. Two optional fields buy the
    bitemporal distinction outright.

    **An entry outside its validity window leaves the injected slice and stays
    findable by `search`** — one rule, both bounds. A `validUntil` in the past
    is the case that motivates it; a `validFrom` in the future is the same
    error running the other way, and an entry that is not true yet reaching the
    pinned core or the index would be presented as true now, which is exactly
    the confusion the two fields exist to prevent. Stated as one policy rather
    than left to the implementation, because excluding and downranking produce
    different prompts and different harness numbers — a step that leaves the
    choice open cannot be measured against itself. Being outside the window is
    not deletion: the entry is in the record, in `search`, and in `audit`; it
    is not what is true now, which is the only claim the injected slice makes.

    **`memory.recall` says so when a hit is out of window.** `createRecallTool`
    projects a hit to `id`, `content`, and `createdAt` and nothing else, so an
    implementation could satisfy the injection rule above and still hand the
    model an expired fact that reads exactly like a current one — the
    confusion the two fields exist to prevent, arriving through the other
    door. Keeping an out-of-window entry findable is right; returning it
    *unmarked* is not. The recall result carries validity status and renders
    it.
  - **`trust` and `origin`** — defined by [30](./30-provenance.md), carried
    here. The entry is where the label lives; what sets it, how it propagates,
    and how a labelled region renders are 30's.
  - **`supersedes`** — see the record lane below.

  **Every field lives in the JSONL, never only in the index.** The derived
  claim is the load-bearing property of 14's design and this step does not get
  to spend it.

- **The record lane grows two more record types, and pinning is one of them.**
  14's file holds entries and tombstones; `forget` appends rather than
  rewrites, because `O_APPEND` is the whole concurrency model and decision 5
  promises the file stays hand-editable. Anything that *changes* an entry has
  to be a record, never a field write:

  - **Supersession** — **one record, not two**: the successor entry carries
    `supersedes` itself, and that field *is* the retirement. A superseded entry
    is not live — it leaves `list`, `search`, and therefore the prompt, exactly
    as a forgotten one does — and `liveEntriesFor` learns to read the field
    alongside the tombstones it already reads.

    A separate tombstone plus a separate successor entry would be two appends
    with no transaction between them, and the store's only atomicity is one
    `O_APPEND` record. Stopping between them leaves either both beliefs live
    (successor first) or a retirement with no replacement (tombstone first) —
    the second being the worse half, since it loses a fact on a crash in a
    store whose whole posture is that nothing is lost. One record has no
    in-between state to reason about.
  - **Pin and unpin** — a record naming the entry. `pinned` cannot be a field
    on the entry: pinning is a toggle, from the agent and from the operator's
    CLI and console, and a toggle on an append-only line is a rewrite. This
    was a field in the first draft of this spec and that was simply wrong.

  [30](./30-provenance.md)'s operator trust re-assertion is a third record in
  the same lane, which is what makes an upgraded install's `unknown` corpus
  recoverable rather than permanent.

  What supersession fixes is the failure that makes long-lived memory useless.
  Remembering "the deploy runs on Postgres now" leaves "the deploy runs on
  MySQL" in the store today, and both land in the same prompt with nothing to
  separate them. Belief revision is the normal case for an agent that runs for
  a year, and an append-only store is the right place to model it — the old
  entry stays visible in `audit` with the entry that replaced it, which is
  strictly more than a delete would leave behind.

  **Every id a record names must resolve to a live entry the caller owns,
  before anything is appended**, and this is a security requirement rather than
  input hygiene. `liveEntriesFor` computes its forgotten set from *every*
  tombstone in the file with no agent filter — deliberately, so a hand-edited
  file where a tombstone precedes its entry still means forgotten — and
  ownership is enforced only inside `forget`'s write path, which resolves the
  entry from the caller's own live set first. These are the **second and third
  writers into that lane**, and a writer that skips the check lets agent A
  retire agent B's memory by naming its id: gone from B's `list`, its `search`,
  and its prompt, with B's own `forget` never called. That is the per-agent
  boundary — the access model the whole store rests on — breached by a field on
  a `safe` tool.

  The write-path check is the requirement. Worth pricing alongside it:
  `liveEntriesFor` honouring only tombstones whose `agentId` matches the
  entry's would make the boundary **structural** rather than a rule every
  future writer has to remember, and the tombstone already carries the field.
  The order-independence the current comment protects survives that change;
  what it gives up is one hand-edited-file case nobody has asked for.

  **Concurrent supersession of the same entry needs no winner, and picking one
  would be wrong.** The invariant is about the entry being *retired*, not about
  its replacement being unique: `liveEntriesFor` drops an entry if any
  tombstone anywhere names it, so two processes superseding E concurrently both
  retire it, in either order, with no race to resolve — that order-independence
  is the property 14 built the forgotten set for. What they also produce is two
  live successors, and both should stay live: each is a fact the agent wrote,
  and retiring one to make the other unique would delete a write nobody asked
  to retract, in a step whose whole posture is that nothing is deleted. Two
  successors that disagree are a **contradiction in content**, which is the
  maintenance pass's job — not a storage race, and not something a
  `(createdAt, id)` tie-break can adjudicate, because it has no idea which
  belief is right. The pin cap needs a replay rule because a *budget* is a
  scarce resource two writers can overspend; supersession has no budget.

  Contradiction *detection* is a maintenance-pass job and explicitly not a turn
  job. This step ships the mechanism, not the detector.

- **Turn injection becomes three bounded blocks instead of one recency slice.**
  They are three blocks *within* [09](./09-skills.md)'s single `memory`
  section, not three tagged sections of their own, and that is a requirement
  rather than a formatting preference. [23](./23-prompt-caching.md)'s Anthropic
  placement reads `parts.find((part) => part.kind === 'memory')` and strips
  with `parts.filter((part) => part.kind !== 'memory')`: three sections sharing
  the kind would send the first to the tail and **drop the other two from the
  request entirely**, and three new kinds would leave them on the cached
  prefix, which is exactly what 23 moved memory off. One aggregate volatile
  section is the only shape that leaves the adapter untouched, and it keeps
  `buildPrompt`'s own reasoning — one block, joined as it has always been
  joined — intact. If a later step needs the blocks separately placed, that is
  a change to the adapter with its own argument, not a side effect of this one.

  - **Pinned core**, always present, hard-capped (2 KiB). This is what makes an
    agent still know the basics after a year with no search at all, and the cap
    **refuses rather than evicts**: a pinned set that silently drops its oldest
    member is a pin that does not mean anything.

    **The cap needs a replay rule as well as a write-path check**, because
    check-then-append is not atomic here. The CLI and the daemon build
    separate stores over the same file and coordinate by `O_APPEND` alone —
    that is the stated concurrency model, not an oversight — so two processes
    pinning near the limit can both read the same total, both accept, and both
    append. The write path refusing is the common case and stays the rule; for
    the race it cannot see, **replay decides deterministically: pins take
    effect in the order their records appear in the file, until the cap, and
    the remainder are recorded but inert**, visible in `audit` like anything
    else the record holds. Both stores compute the same effective set from the
    same file, which is the property that matters — the alternative is an
    injected slice that either overruns its budget or drops a pin by whichever
    order it happened to read.

    **Append order, not `(createdAt, id)`** — a timestamp is the wrong key for
    a budget. A pin written later with a skewed-earlier clock, or in the same
    millisecond with a lower id, sorts *ahead* of a pin that is already
    effective and can consume the budget out from under it, making an accepted
    pin inert after the fact and contradicting the refusal the cap promises.
    `O_APPEND` already supplies a total order that no later writer can insert
    itself into, and the store already parses records in file order; using it
    means an accepted pin stays accepted. Recall ordering keeps its
    `(createdAt, id)` rule, which is a different question — presenting facts
    newest-first is about meaning, and allocating a scarce budget is about
    arrival.
  - **A memory index** — not facts, but what the agent *knows about*: entity
    names from `about`, counts, last-updated. Roughly a thousand tokens' worth
    of budget tells the agent the shape of its own store, which is what turns
    `memory.recall` from a guess into a targeted read. This is the block that
    makes 14's thesis true rather than aspirational: the current recency slice
    is recall that happens *to* an agent, and it is what the spec argued
    against. It renders under [30](./30-provenance.md)'s labelling invariant
    like every other view derived from entries.
  - **A recency tail**, smaller than today's twenty and bounded in bytes, so a
    cold store with nothing pinned and nothing indexed still behaves as it does
    now.

- **Ranking becomes a declared strategy on the read, not a property of the
  store.** 14 froze ordering at recency for a real reason — BM25 cannot be
  reproduced by the in-memory store, so requiring relevance would build
  divergence into the contract. That reasoning is right and its conclusion is
  now the ceiling on retrieval quality.

  The way out is to name the strategy in the request and report it in the
  result. `recency` is mandatory and is what the parity tests assert;
  `relevance` and `hybrid` are optional, declared, and a store that lacks the
  one asked for serves `recency` and says so rather than erroring. Two
  implementations stay honest about ordering without memory being frozen at
  clock order forever, and an embeddings-backed store behind
  [19](./19-registration-seams.md) becomes an additive capability rather than a
  contract break.

- **Usage telemetry in the index, and only in the index.** `lastRecalledAt` and
  `recallCount` are observations about reading, not facts the agent learned, so
  they stay out of the record. The documented consequence is exact: deleting
  the index loses your usage statistics, never your memories. Ranking may use
  them; **nothing deletes on them**.

- **An evaluation harness, in scope from the start — with a stated ground truth
  and a stated definition of better.** A criterion requiring "before-and-after
  numbers" is satisfiable by a number that measures nothing, so this says which
  number.

  **The corpus carries per-turn relevance labels.** Each turn of a synthetic
  agent lifetime names the facts a competent agent should have had in context
  for it. That label set is what precision is measured against — without it,
  "precision of the injected slice" has no denominator, because injection here
  is not query-driven (automatic retrieval is out, below).

  What the deterministic harness scores, and what each number means:

  - **Precision of the injected slice** against those labels — the primary
    number, and the one 29 is claiming to improve.
  - **Tokens per relevant fact injected** — the paired number, because a policy
    that wins precision by injecting more has not won. Both move or neither
    counts.
  - **Staleness rate** — the share of injected facts that are superseded or
    outside their validity window. A correctness number, not a tuning one: it
    goes to zero.
  - **Negatives kept out** — the labelled facts that must not appear.
  - **Recall@k over `search`**, scoped honestly: with `recency` mandatory this
    tests the matching contract, the bounded-read rule, and parity between the
    two store implementations. It is not a measure of 29's selection policy and
    is not the headline number; it becomes one when a `relevance` strategy
    lands behind [19](./19-registration-seams.md).

  **Better means: precision up and staleness down at no more tokens per
  relevant fact**, against the recency policy this step replaces, on the same
  corpus. The landing PR carries both sides of that comparison.

  It runs deterministically under `node --test` against both store
  implementations, with no live model in the default path.

- **`stratus memory`** — `list`, `search`, `forget`, `audit`, `pin`, `export`,
  `import`. [17](./17-fleet-console.md) owns the console view and still does;
  this is the terminal half, and the export path is what the harness needs to
  run a corpus in the first place. **An imported entry lands `external`** per
  [30](./30-provenance.md) unless the operator explicitly says otherwise —
  import is the laundering problem with a human in the middle.

  **So a round trip preserves entries and order, not labels**, and the two
  statements have to be read together or they contradict each other: `search`
  returns each entry's trust, and import deliberately re-labels, so a round
  trip that expected identical provenance would be asserting the safety rule
  does not work. The default trip is for the harness, which cares about which
  entries come back in which order. The operator flag that preserves
  provenance is for the other job — moving an agent to a new machine, where
  re-labelling a corpus the operator already owns as `external` is the wrong
  answer — and that path preserves trust because a person vouched for the
  file.

**Out:**

- **A knowledge graph.** Entity extraction is brittle, the maintenance cost is
  permanent, and a graph is a second record that the JSONL would have to agree
  with — which is the property decision 5 exists to protect. `about` keys on
  entries reach most of the benefit at a fraction of the cost, and if they
  prove insufficient the harness will say so with a number.
- **Embeddings as the default index.** 14's argument stands unchanged: a second
  vendor relationship underneath v1, and an index too expensive to throw away
  quietly stops being derived. It remains the obvious plugin behind 19's seam.
- **Runtime-authored writes of any kind.** Nothing enters the store without the
  agent's own tool call under its own policy — that invariant is most of why
  this memory is trustworthy, and end-of-turn extraction is the standard way it
  gets lost. A reflection step that *proposes* candidates is the supported
  shape, reusing [24](./24-sub-agents.md)'s proposal mechanism, and it is a
  separate step from this one.
- **Automatic retrieval at turn start.** Still the right idea and still
  unmeasurable today. Building the ruler before the tuning is the whole point
  of the ordering here; 14 left this open leaning no, and this step's harness
  is what changes the answer from a preference to a result.
- **The provenance contract.** That is [30](./30-provenance.md).
- **The shared scope.** That is [21](./21-team-knowledge.md), and it should
  land on this entry shape rather than beside it.
- **Deletion.** Nothing in this step deletes anything. Decay ranks; validity
  filters; supersession retires. The record stays the record.

## Design sketch

- **The schema stamp is the migration.** New index columns bump
  `INDEX_SCHEMA_VERSION`, which 14 already defined as a rebuild trigger rather
  than an error. There is no data migration to write, because the file the
  upgrade must not forget is the file the new code already reads.
- **The pinned cap refuses, on the same reasoning as the per-entry byte cap.**
  14 refuses an over-cap fact rather than truncating it because a half-stored
  fact is worse than a refused one. A silently evicted pin is the same mistake
  with a different unit.
- **`memory.pin` is `safe`**, by the rule that already covers `remember` and
  `forget`: the agent's own notes, appended rather than destroyed, keyed to the
  agent. The operator can pin and unpin through the CLI and the console.
- **The corpus is fixtures, not recordings.** Real transcripts would carry
  conversation content into the repository and would be unlicensable to share;
  synthetic lifetimes are also the only way to have labelled negatives, which
  are the half that actually catches over-injection.
- The daemon log records that an entry was superseded or pinned, by **id**.
  Same rule as every other memory event: a reference, never content.

## Acceptance criteria

- **A JSONL line carrying only the four required fields loads, recalls, and
  reaches the injected prompt** — the hand-edit promise re-asserted against the
  wider shape, which is the thing a richer schema is most likely to break.
- **A live entry whose `validUntil` has passed is excluded from what is true
  now and still findable by `search`** — the behavior the corpus scores, and
  the one that separates validity from supersession.
- **The same for an entry whose `validFrom` is still in the future**, pinned
  included: a fact that is not true yet must not reach the pinned core, the
  index, or the tail. One rule, both bounds, and the future case is the one an
  expiry-shaped implementation forgets.
- **A `memory.recall` hit that is out of window comes back marked as such** —
  because the injection rule passes while recall still hands the model an
  expired fact indistinguishable from a current one.
- **A query matching only an entry's `about` key returns that entry, in both
  stores** — the alias case the topic index advertises, and the one that fails
  today with matching over `content` alone.
- An entry that supersedes another: the superseded entry is not live in
  `list`, `search`, or the injected prompt, and its successor is; `audit` shows
  both and names which replaced which.
- **Two processes superseding the same entry concurrently retire it once and
  leave both successors live** — the invariant is the retirement, not a unique
  replacement, and a test expecting one successor would be asserting a
  guarantee this design deliberately does not make.
- **A crash during a supersession leaves either the whole revision or none of
  it** — one record, so there is no state where an entry is retired with its
  replacement missing. Asserted by interrupting between logical writes, which
  is the failure a two-append implementation has and this one cannot.
- **Pinning and unpinning leave the entry's own line byte-identical** — the
  criterion that fails if `pinned` is implemented as a field write, which is
  the convenient implementation and breaks `O_APPEND` and decision 5 together.
- **A pin past the cap is refused naming the cap, and no existing pin is
  dropped** — asserted, because eviction is the convenient implementation.
- **An agent naming another agent's entry id in `supersedes` — or in a pin — is
  refused, and that entry stays live in its owner's `list`, `search`, and
  prompt** — the per-agent boundary asserted against the victim's reads rather
  than the attacker's error, since a refusal that still appended the record
  would pass an error-message test.
- Over a store of ten thousand entries, the injected slice stays within budget
  and contains the pinned core and the index; the recency tail is what shrinks.
  The pinned set is never pushed out by volume.
- **Exactly one `memory`-kind section reaches the Anthropic placement, and all
  three blocks arrive at the tail** — the criterion that fails if the blocks
  are ever split into sibling sections, which drops two of them from the
  request outright.
- Both store implementations return the same entries in the same order for a
  `recency` read, including a `createdAt` tie. A store asked for a strategy it
  does not implement serves `recency`, reports that in the result, and does not
  error.
- **Deleting the index rebuilds every new field, and the usage counters reset
  while no fact is lost** — the derived claim, re-proved at the wider schema.
- The harness runs in CI, deterministically, against both stores, and a
  regression in injected-slice precision fails the run.
- **The PR carries precision, tokens per relevant fact, and staleness rate for
  the recency policy it replaces and the policy it lands** — the three numbers
  "better" is defined as, on the same corpus. Without them the claim is
  unfalsifiable, and this criterion is the one that makes the step mean
  anything.
- **`export` then `import` into an empty store returns the same entries in the
  same order**, with provenance re-labelled per 30 — the comparison is
  deliberately over entries and order, since expecting labels to survive would
  assert that the import safety rule does not work. **Under the operator's
  preserving flag, trust survives too**, which is the migration path and the
  half a default-only test never reaches.
- **Two processes pinning concurrently at the cap produce one effective pinned
  set, identical in both**, with the overflow recorded and inert rather than
  either process's write silently winning — the race the write-path check
  cannot see, since `O_APPEND` is the only coordination between them.
- **A pin appended later with an earlier or tied timestamp does not displace an
  already-effective pin** — asserted with a skewed clock and with a
  same-millisecond tie, because a timestamp key makes the cap retroactive and
  turns the promised refusal into a silent eviction.
- Agent A cannot read agent B's entries with every new field in play, the test
  naming both agents rather than asserting an empty result an unrelated bug
  would also produce.
- The structured log names the ids of superseded and pinned entries and never
  their content.

## Open questions

- **Should the agent get an as-of read over retired beliefs?** Supersession
  makes the old entry unreachable to the agent by design, and "what did I think
  before" is a question worth answering. The hazard is that the obvious
  implementation is a laundering path in a different costume: a read that
  returns retracted content puts it back in context, where it reads as
  something the agent knows rather than something it stopped believing.
  Anything built here has to render a retired fact as retired, and that is a
  design worth its own argument rather than a parameter on `search`.
- **Does the index block belong in the prompt, or behind a `memory.topics`
  tool?** In the prompt it costs tokens every turn; behind a tool it costs a
  round trip and depends on the agent choosing to call it. Leaning prompt,
  because an agent that does not know what it knows cannot know to ask — and
  this is precisely the kind of question the harness exists to settle.
- **Is `about` model-written or extracted?** Leaning model-written at the point
  of remembering: extraction is the knowledge graph arriving through a side
  door, and the agent writing the fact is the party that knows what it is
  about.
- **Should `kind` gate injection eligibility, or only ranking — and should any
  `kind` be exempt from expiry?** Both questions are the same one about
  `episodic` entries: they age fastest, and they carry "what happened last
  time", which does not stop being true when it stops being current. The expiry
  *policy* is settled in Scope; the exemption is arguable on its own.
- **Does [21](./21-team-knowledge.md)'s `MemoryScope` need a third `project`
  variant designed now?** An agent working across three repositories wants
  repository-scoped facts, and retrofitting a third variant into a union that
  shipped with two is the expensive version of finding that out.
- **Does the harness ever get a judged mode?** Some questions — is this recall
  actually relevant — need a model. That is cost and nondeterminism in CI, so
  it likely runs on demand rather than per commit, and the default path stays
  deterministic either way.
