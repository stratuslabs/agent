# 29 — Memory quality: entries that carry their own history, and a ruler to measure recall

## Goal

Memory that is still useful in year two: entries that know enough about
themselves to be superseded, ranked, and trusted; an injected slice chosen by
what the agent knows rather than by what the clock says; and a benchmark that
turns every later tuning decision into a measurement instead of an argument.

## Why now

[14](./14-memory.md) built the substrate and was right about it — JSONL as the
record, a derived index, recall the agent performs. What it could not do in one
step is make the *selection* good, and it says so: turn injection is the twenty
most recent entries, oldest first.

Recency is the weakest selection policy available. It is uncorrelated with the
conversation, it silently drops everything older, and it spends tokens every
turn to do both. It is also the only policy the current entry shape can
support: a `MemoryEntry` is `{ id, agentId, content, createdAt }` plus opaque
metadata, so nothing downstream can tell a preference from an observation, a
current fact from a superseded one, or something the user said from something a
web page said. Every ranking idea dies at the same place — there is nothing to
rank on.

Three things make this the moment rather than later:

- **Every open question in 14 and 21 is a tuning question with no way to settle
  it.** Automatic recall at turn start, decay, slice size, consolidation
  aggressiveness — each is recorded as "leaning" one way. Those do not converge
  by argument, and each one relitigated in a PR review costs more than the
  harness that would answer it.
- **[21](./21-team-knowledge.md) is about to add a second scope and a second
  writer.** Whatever an entry must carry — provenance, validity, authorship,
  supersession — is far cheaper to add while there is one scope and one writer
  than after a shared pool exists with its own rendering and its own mutation
  policy.
- **The laundering path is live today.** [13](./13-search.md) landed its
  untrusted marking in the `web.search` result envelope rather than as a kernel
  field, and 14 named memory as the second consumer that would justify
  promoting it. Memory is the one channel carrying model-authored text *across*
  the turn boundary: an agent that reads a hostile page and remembers what it
  said has moved that text past every check the turn applied, into a later
  prompt where it reads as the agent's own prior conclusion.

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
  - **`validFrom` / `validUntil`** — validity is a different axis from
    `createdAt`, which is transaction time. Conflating them is why assistants
    confidently report where someone used to work. Two optional fields buy the
    bitemporal distinction outright.

    **An entry whose `validUntil` has passed leaves the injected slice and
    stays findable by `search`.** One policy, stated here rather than left to
    the implementation, because excluding and downranking produce different
    prompts and different harness numbers — a step that leaves the choice open
    cannot be measured against itself. Expiry is not deletion: the entry is in
    the record, in `search`, and in `audit`; it has stopped being what is true
    now, which is the only claim the injected slice makes.
  - **`trust` and `origin`** — `user`, `agent`, or `external`, plus the session
    and the tool it came through.

    **An entry with no `trust` is `unknown`, and `unknown` is not `agent`.**
    Every entry on an upgraded install lacks the field, including anything
    written after reading a hostile page under today's code, so a default of
    "trusted" would preserve the exact laundering path this step closes — on
    the whole existing corpus, which is the only corpus anyone has. Defaulting
    to `external` is wrong in the other direction and not merely
    over-cautious: it would label everything the operator ever told the agent,
    and every line they hand-added under decision 5's promise, as web content,
    which is false and empties the external label of meaning by making it
    universal. So `unknown` renders under its own label — recorded before
    origins were tracked — outside the framing that presents a fact as the
    agent's own conclusion. It is the honest statement, it closes the path,
    and it drains by itself as entries written afterwards carry the field.
  - **`pinned`** — see the injection change below.
  - **`supersedes`** — see the next bullet.

  **Every field lives in the JSONL, never only in the index.** The derived
  claim is the load-bearing property of 14's design and this step does not get
  to spend it.

- **Supersession as a record, not a rewrite.** `memory.remember` accepts
  `supersedes: [id]`, and a supersession is a tombstone that names its
  successor — the same lane `forget` already appends to, so `liveEntriesFor`
  gains no new concept. The read rule is that a superseded entry is not live:
  it leaves `list`, `search`, and therefore the prompt, exactly as a forgotten
  one does.

  What this fixes is the failure that makes long-lived memory useless.
  Remembering "the deploy runs on Postgres now" leaves "the deploy runs on
  MySQL" in the store today, and both land in the same prompt with nothing to
  separate them. Belief revision is the normal case for an agent that runs for
  a year, and an append-only store is the right place to model it — the old
  entry stays visible in `audit` with the entry that replaced it, which is
  strictly more than a delete would leave behind.

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
  - **A memory index** — not facts, but what the agent *knows about*: entity
    names from `about`, counts, last-updated. Roughly a thousand tokens' worth
    of budget tells the agent the shape of its own store, which is what turns
    `memory.recall` from a guess into a targeted read. This is the block that
    makes 14's thesis true rather than aspirational: the current recency slice
    is recall that happens *to* an agent, and it is what the spec argued
    against.

    **The index inherits its entries' labels**, and that generalizes to an
    invariant the whole step is held to: *nothing in the prompt derived from
    an external entry renders outside the external label*. `about` keys are
    model-written text on a tainted entry — an instruction-shaped topic name
    is exactly what a hostile page would induce — so a topic any external
    entry contributes renders under the external label and never in the plain
    index, appearing in both regions when trusted entries contribute it too
    rather than being merged into one unlabelled line. Stated as an invariant
    rather than a patch on this block, because the index is only the first
    derived view: a count, a last-updated stamp, or whatever a later step
    renders from entries inherits the same rule for free.
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

- **The untrusted marking, promoted to the kernel and carried out the far
  side.** A taint field on `ToolResult` — the promotion 13 deferred and named
  this as the consumer for.

  **The producer rule is a rule, not a list**: a result is tainted when it
  carries content the agent did not author and the operator did not configure.
  An enumerated list is how the newest tool silently arrives untainted, and the
  first draft of this spec proved the point by naming `web.search`,
  `web.fetch`, and the [11](./11-mcp.md) bridge while omitting the browser —
  where `browser.read` returns page `innerText` and `goto`, `read`,
  `screenshot`, and `act` all return a page-supplied `title`. That is the most
  attacker-controlled surface of the four, reached by a page the agent was
  merely pointed at. Every one of those is a producer, and so is the next tool
  that reads something a stranger wrote.

  An entry written in a session that has seen a
  tainted result is stored `trust: 'external'`, and external-origin facts
  render in their **own labelled block**: recorded from external sources, to be
  read as reports rather than as the agent's own conclusions.

  The propagation rule is deliberately coarse and errs toward over-marking
  (see Design sketch). A fact wrongly marked external is a fact the model
  treats with slightly more suspicion; a fact wrongly marked trusted is the
  attack.

- **Usage telemetry in the index, and only in the index.** `lastRecalledAt` and
  `recallCount` are observations about reading, not facts the agent learned, so
  they stay out of the record. The documented consequence is exact: deleting
  the index loses your usage statistics, never your memories. Ranking may use
  them; **nothing deletes on them**.

- **An evaluation harness, in scope from the start.** A fixture corpus of
  synthetic agent lifetimes with labelled ground truth, weighted toward the
  cases that separate a working memory from a plausible one: superseded facts,
  direct contradictions, entity aliases, validity-scoped queries, and
  **negative cases the agent must not recall**. Metrics: recall@k, precision of
  the injected slice, staleness rate (share of injected facts already
  superseded), tokens per useful fact.

  **The temporal case is scoped to validity, not to supersession**, and the
  distinction is what makes it scoreable at all. A superseded entry is not
  live: it leaves `list` and `search` by the read rule above, and `audit` is
  the operator's read — so "what did I believe in March" names no retrieval
  path the agent has, and a corpus requiring it would be scoring a recall
  nothing can perform. What *is* answerable is a live entry whose
  `validUntil` has passed — still in the record, still findable, and correctly
  excluded from what is true now. That is the temporal behavior this step
  actually ships, so that is what the corpus measures. An agent-accessible
  as-of read over retired beliefs is a real question and is in Open questions,
  where its own hazard is named.

  It runs deterministically under `node --test` against both store
  implementations, with no live model in the default path. It is not a
  follow-up: a step that changes the selection policy and cannot say by how
  much it improved has not established anything, and the PR that lands this is
  required to carry the before-and-after numbers for the policy it replaces.

- **`stratus memory`** — `list`, `search`, `forget`, `audit`, `pin`, `export`,
  `import`. [17](./17-fleet-console.md) owns the console view and still does;
  this is the terminal half, and the export path is what the harness needs to
  run a corpus in the first place. **An imported entry lands as `external`**
  unless the operator explicitly says otherwise, because import is exactly the
  shape of the laundering problem above with a human in the middle.

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
- **The shared scope.** That is [21](./21-team-knowledge.md), and it should
  land on this entry shape rather than beside it.
- **Deletion.** Nothing in this step deletes anything. Decay ranks; validity
  filters; supersession retires. The record stays the record.

## Design sketch

- **The schema stamp is the migration.** New index columns bump
  `INDEX_SCHEMA_VERSION`, which 14 already defined as a rebuild trigger rather
  than an error. There is no data migration to write, because the file the
  upgrade must not forget is the file the new code already reads.
- **Taint propagates per session, not per fact.** The runner knows a turn saw
  untrusted content; it does not track which words in a later `memory.remember`
  came from it, and a design that claimed to would be lying. So: once a session
  has seen untrusted content, entries written later in that session are
  `external`. Coarse, over-marking, and the failure direction is the safe one.
- **A session is tainted by what enters its context, not only by what a tool
  returned.** A tainted `ToolResult` is one source; **an `external` entry
  arriving through the injected memory block or through a `memory.recall`
  result is another**, which means `search` has to carry `trust` out with each
  entry rather than content alone. Without this the store launders its own
  contents on the next restart: a fresh session reads an external fact from
  the prompt, restates it, remembers it — and the new entry is `agent`,
  because that session never called a network tool. The round trip through
  memory is the cheapest version of the whole attack, and it is available to
  anything that can wait a session.
- **`external` propagates; `unknown` does not**, and the asymmetry is the
  decision rather than an oversight. `external` is a positive claim that
  content came from a stranger, so anything written in its presence inherits
  it. `unknown` is a statement about *missing metadata on old entries* — and
  since every legacy entry is `unknown` and legacy entries are what an
  upgraded install injects, propagating it would mark every fact every
  upgraded agent ever writes again, permanently. That is the same
  make-the-label-universal failure the `unknown` default exists to avoid,
  arriving through the back door.
- **Taint crosses a delegation.** `createDelegateTool` starts the target's
  session with the parent's text as `userMessage` and metadata carrying depth,
  delegator, and root session — so a tainted parent hands attacker-influenced
  text to a teammate whose session has seen nothing, and the teammate stores
  it as its own conclusion. A per-session rule with no delegation clause is a
  cross-agent laundering path, which is worse than the single-agent one it
  replaces: the roster's separate identities are what make the launder
  convincing. The parent's taint rides in the delegation metadata beside the
  keys already there. [24](./24-sub-agents.md) is unaffected — a sub-agent
  writes no memory at all — but that is a different tool, and its rule does
  not cover this one.
- **The pinned cap refuses, on the same reasoning as the per-entry byte cap.**
  14 refuses an over-cap fact rather than truncating it because a half-stored
  fact is worse than a refused one. A silently evicted pin is the same mistake
  with a different unit.
- **`memory.pin` is `safe`**, by the rule that already covers `remember` and
  `forget`: the agent's own notes, tombstoned rather than destroyed, keyed to
  the agent. The operator can pin and unpin through the CLI and the console.
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
- **That same line renders under the unknown-origin label, never as the
  agent's own conclusion** — asserted against the rendered prompt, because the
  whole existing corpus is that line, and a default of trusted would carry the
  laundering path forward across every upgrade.
- **An `about` key on an external entry never appears in the plain index** —
  asserted with an instruction-shaped topic name against the rendered prompt,
  which is the only place the leak is visible: the entry itself is labelled
  correctly the whole time.
- **A live entry whose `validUntil` has passed is excluded from what is true
  now and still findable by `search`** — the temporal behavior the corpus
  scores, and the one that separates validity from supersession.
- An entry that supersedes another: only the successor is live in `list`,
  `search`, and the injected prompt; `audit` shows both and names which
  replaced which.
- **A pin past the cap is refused naming the cap, and no existing pin is
  dropped** — asserted, because eviction is the convenient implementation.
- Over a store of ten thousand entries, the injected slice stays within budget
  and contains the pinned core and the index; the recency tail is what shrinks.
  The pinned set is never pushed out by volume.
- **A fact written after a `web.fetch` in the same session is marked external
  and renders in the labelled block** — asserted against the rendered prompt
  rather than the stored entry, because the entry is the half that would pass
  either way.
- **The same holds after `browser.read`**, asserted separately rather than
  assumed from the `web.fetch` case. Two different plugins own those two
  results, so one passing says nothing about the other, and the browser is the
  producer a list-shaped taint contract loses first.
- **A fresh session that reads an external entry — from the injected block or
  from `memory.recall` — and then remembers something writes `external`, not
  `agent`.** The round trip through the store on a later restart is the
  cheapest version of the whole attack, and it passes every taint test that
  only exercises tool results.
- **A session that has seen only `unknown` entries still writes `agent`** —
  the other half of that rule, and the one that stops an upgraded install
  marking every fact it will ever write again.
- **An agent tainted by a fetch delegates; the target's `memory.remember`
  writes `external`** — the cross-agent path, asserted end to end, because
  every single-session taint test passes while it is open.
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
- **The PR carries the harness's numbers for the recency policy it replaces and
  the policy it lands** — without them "better" is unfalsifiable, and this
  criterion is the one that makes the step mean anything.
- `export` then `import` into an empty store reproduces the same recall
  results, and imported entries are `external` unless explicitly flagged.
- Agent A cannot read agent B's entries with every new field in play, the test
  naming both agents rather than asserting an empty result an unrelated bug
  would also produce.
- The structured log names the ids of superseded and pinned entries and never
  their content.

## Open questions

- **Should the agent get an as-of read over retired beliefs?** Supersession
  makes the old entry unreachable to the agent by design, and "what did I
  think before" is a question worth answering. The hazard is that the obvious
  implementation is the laundering path in a different costume: a read that
  returns retracted content puts it back in the context, where it reads as
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
- **Should `kind` gate injection eligibility, or only ranking?** Episodic
  entries are the ones that age fastest and also the ones that carry "what
  happened last time", which is often exactly what is wanted.
- **Is session-level taint too coarse to be useful?** An agent that fetches one
  page at the start of a long session marks everything after it external. The
  finer version needs per-turn provenance the runner does not currently keep,
  and adding it is a kernel change worth pricing separately.
- **Should any `kind` be exempt from expiry?** The policy itself is settled in
  Scope — an expired entry leaves the injected slice and stays findable by
  `search` — because leaving it open contradicted the acceptance criterion
  that requires exclusion, and downranking and excluding produce different
  prompts and different harness numbers, so an implementation cannot satisfy
  both. What is genuinely open is narrower: `episodic` entries carry "what
  happened last time", which does not stop being true when it stops being
  current, and an exemption for them is arguable on its own.
- **Does [21](./21-team-knowledge.md)'s `MemoryScope` need a third `project`
  variant designed now?** An agent working across three repositories wants
  repository-scoped facts, and retrofitting a third variant into a union that
  shipped with two is the expensive version of finding that out.
- **Does the harness ever get a judged mode?** Some questions — is this recall
  actually relevant — need a model. That is cost and nondeterminism in CI, so
  it likely runs on demand rather than per commit, and the default path stays
  deterministic either way.
