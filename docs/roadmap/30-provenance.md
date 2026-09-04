# 30 — Provenance: the untrusted boundary, end to end

## Goal

One answer, carried the whole way, to *where did this content come from* — a
taint marking set where tools actually execute, propagated across sessions,
restarts, and delegations, and rendered so that a fact a stranger wrote never
reaches a model looking like the agent's own conclusion.

## Why now

[13](./13-search.md) landed its untrusted marking **in the `web.search` result
envelope** rather than as a kernel field, and left promoting it open.
[14](./14-memory.md) named memory as the second consumer that would justify the
promotion. Both were right to wait for a consumer. The consumer arrived:
[29](./29-memory-quality.md) cannot render a trust label it has no way to
compute.

The gap is live today, and it is not theoretical. Memory is the one channel
that carries model-authored text *across* the turn boundary: an agent that
reads a hostile page and remembers what it said has moved that text past every
check the turn applied, into a later prompt where it reads as something the
agent concluded. Nothing in the system currently marks it, and nothing can,
because the marking stops at one plugin's result envelope.

This is its own step rather than a section inside 29 because of what it
touches: `ToolResult` in `core`, the executor, four tool plugins, both harness
provider bridges, `agent.delegate`, the session store, and the prompt renderer.
That is a different blast radius and a different review from "make recall
better", and the review history of 29 is the evidence — four rounds, and every
round after the first found another hole in the taint half while the memory
half stood.

## Scope

**In:**

- **A taint field on `ToolResult`**, in `core`. The promotion 13 deferred. It
  says the result carries content from outside the trust boundary; it does not
  say what a consumer should do about it, which is each consumer's business.
- **And a producer-facing channel to set it, because the field alone is not
  one.** `Tool.execute` returns `Promise<JsonValue>` and `DefaultExecutor`
  builds the result with `successResult(call, output)` — so a plugin has no
  typed way to mark its own output, and an executor that infers the mark from
  the tool's name or its output shape is the enumerated list this step
  rejects, rebuilt one layer down. Two channels, and the repo already has the
  exact precedent in `risk` versus `commandFor`:

  - **A declaration on the tool**, the way `risk` classifies a tool: this
    tool's output carries content from outside the boundary. `browser.read`
    and `web.fetch` are that statically.
  - **A per-call mark**, the way `commandFor` classifies a *call*, for tools
    whose output is only sometimes external — an `fs.read` of a file the agent
    downloaded, an MCP tool with mixed responses. It rides on
    `ExecutionContext` as a sink the tool may call, the way
    [18](./18-usage-accounting.md)'s `onUsage` does, so the return type does
    not change.

  The executor promotes whichever fired into the `ToolResult`. A newly
  registered third-party tool that declares itself a producer must be tainted
  with no change to kernel code — that is the test that proves this is a
  contract rather than a list.
- **The producer rule is a rule, not a list.** A result is tainted when it
  carries content **written by a party the operator has not authorized** —
  a web page, a search snippet, an MCP server's response, a document the agent
  fetched. An enumerated list is how the newest tool silently arrives
  untainted: 29's first draft named `web.search`, `web.fetch`, and the
  [11](./11-mcp.md) bridge while omitting the browser, where `browser.read`
  returns page `innerText` and `goto`, `read`, `screenshot`, and `act` each
  return a page-supplied `title` — the most attacker-controlled surface of the
  four, reached by a page the agent was merely pointed at.
- **`user` is its own category and is not tainted.** The earlier phrasing —
  "content the agent did not author and the operator did not configure" — reads
  literally as tainting every message a person sends the agent, which would
  make every memory external and empty the label by making it universal. A
  message from the principal on an authenticated channel is `user`: the agent's
  own operator, speaking to it directly, is the trust root the whole permission
  model already assumes.

  **What a third party's message in a shared channel is remains open** (see
  Open questions) — a Slack channel with five members is not the same as a DM,
  and the honest answer is not obvious. This step ships the DM case as `user`
  and the open question as an open question rather than quietly deciding it.
- **The hook sits where tools execute, not in the runner's loop.** This is the
  part a reasonable implementation gets wrong. `AgentRunner.runToolCalls` looks
  like the natural place and is not: `provider-claude-code` and
  `provider-codex` run their own agent loop and bridge kernel tools in as an
  in-process MCP server, executing through `countedExecute` rather than through
  the runner. A hook in the runner's loop would never fire for those agents at
  all — so every subscription-path and Codex agent would silently have no taint
  tracking, which is worse than not shipping the feature, because the label
  would be absent rather than wrong.
- **Taint lives in the persisted session, not in process memory.** The
  gateway's session store is SQLite and sessions resume across restarts, so an
  in-memory flag launders every fact written after a restart mid-thread. It
  rides in session metadata the way `DELEGATION_DEPTH_METADATA_KEY` already
  does, or is recomputable from `session.messages`; either way it survives what
  the session survives.
- **A session resumed from before this step writes `unknown`, not `agent`.**
  Persisted sessions predating the upgrade carry `ToolResult`s with no taint
  field — including results that already hold hostile page content — and
  treating that absence as untainted keeps the laundering path open for every
  pre-upgrade transcript, which is the one corpus guaranteed to exist on the
  day this ships. It is the same reasoning as `unknown` on a legacy entry and
  gets the same answer: absence of provenance is not evidence of trust. Marking
  those sessions `external` outright would be the other overcorrection, and the
  scope here is small and self-draining — only sessions that span the upgrade,
  only until they end.
- **Propagation, stated in every direction it travels**, because each one of
  these was found separately and each passed the tests written for the others:

  - **Per session, not per fact.** The runner knows a session has seen
    untrusted content; it cannot know which words of a later write came from
    it, and a design claiming otherwise would be lying. Coarse and
    over-marking, and the failure direction is the safe one.
  - **By what enters context, not only by what a tool returned.** An
    `external` memory entry arriving through the injected block or a
    `memory.recall` result taints the session too — so `search` carries
    `trust` out with each entry. Without this the store launders its own
    contents on the next restart: a fresh session reads an external fact,
    restates it, remembers it, and the new entry is `agent` because that
    session never called a network tool. The round trip through memory is the
    cheapest version of the whole attack and needs only patience.
  - **Trust never rises within a session.** A write carries the least trusted
    label the session has seen: `agent` only if everything in context was
    `user` or `agent`, `unknown` once anything unknown entered, `external`
    once anything external did. One ordering, applied in one direction.

    **This reverses an earlier draft of this step**, which said `unknown` does
    not propagate, on the grounds that every legacy entry is `unknown` and
    legacy entries are what an upgraded install injects — so propagating it
    would mark every fact that agent ever writes again, and a universal label
    carries no signal. That cost is real. It is also the smaller of the two,
    and the argument had the direction wrong: not propagating means an agent
    reads a legacy entry that *did* come from a hostile page, restates it, and
    stores the restatement as `agent`. Uncertainty upgraded to trust, with the
    original entry still correctly labelled and the copy laundered — the exact
    path this step exists to close, walked through the one corpus every
    upgrade has.

    Nothing may raise trust except a person. The drain is the operator's
    re-assertion record below, and it is tractable rather than a corpus-wide
    chore: a mature install's injected slice is a 2 KiB pinned core plus a
    topic index, so re-asserting what is pinned is enough for most sessions
    never to see `unknown` at all.
  - **Across a delegation, both ways.** `createDelegateTool` starts the
    target's session with the parent's text as `userMessage` and metadata
    carrying depth, delegator, and root session — no taint. Outbound, a
    tainted parent hands attacker text to a teammate whose session has seen
    nothing. Inbound, an untainted parent delegates, the target reads a
    hostile page, and the reply returns as the delegate result. The
    cross-agent version is the *more* effective attack, because the roster's
    separate identities are what make "your teammate concluded this"
    convincing.

    **A delegate result carries the target session's label, whatever it is** —
    not only `external`. A target whose own injected memory was `unknown`
    replies from content the parent never saw and cannot assess, and a clause
    written in terms of tainted-or-not lets the parent take that reply as
    `agent`, which is the least-trusted rule broken at the one boundary where
    the parent has least visibility. The parent takes the lower of its own
    label and the result's, by the same ordering as everything else here.
    Writing this clause twice in terms of `external` alone, after the ordering
    replaced the binary, was the drafting error worth naming: a rule stated as
    a lattice has to be applied as one everywhere, and every place that still
    says "tainted" is a place it was not.
  - **A sub-agent's reply, when [24](./24-sub-agents.md) lands.** 24 marks a
    sub-agent's memory *proposals* untrusted and guarantees it writes no
    memory; its **reply text** is a separate channel into the parent and is
    not covered by either rule. Named here so 24 inherits the answer instead
    of rediscovering it.
- **Three trust values on a memory entry — `user`, `agent`, `external` — and
  `unknown` for an entry that carries none.** `unknown` is not `agent`:
  defaulting absent provenance to trusted carries the laundering path forward
  across every upgrade, on the only corpus anyone has. Defaulting it to
  `external` is wrong the other way — it labels everything the operator ever
  told the agent, and every line they hand-added under decision 5's promise, as
  web content. `unknown` renders under its own label: recorded before origins
  were tracked.
- **`origin` is descriptive, and small enough to say completely here**: the
  session the entry was written in, and the name of the tool whose result the
  session was tainted by, when there was one. Both optional; both absent on a
  legacy entry and on anything hand-added, which is exactly what `unknown`
  already says. It answers "where did this come from" for an operator reading
  [17](./17-fleet-console.md)'s memory view, and it is **not** a security
  control — `trust` is the control, and nothing decides anything from `origin`.
  It travels with the entry through export and import as ordinary data. Said
  here because [29](./29-memory-quality.md) carries the field on the strength
  of this step defining it, and a field promised by one spec and defined by
  neither is one two stores will implement differently.
- **An operator can re-assert an entry's trust**, through a record in
  [29](./29-memory-quality.md)'s append-only lane rather than by rewriting a
  line. Without it an upgraded agent's corpus is `unknown` **forever** —
  "it drains as new entries carry the field" covers new writes and nothing
  else, including whatever the operator pins as that agent's core. Operator
  only: an agent re-labelling its own memory as trusted is the attack writing
  its own permission slip.
- **Rendering, as an invariant rather than a per-block rule**: *nothing in the
  prompt derived from an `external` entry renders outside the external label*.
  External facts render in their own labelled region — recorded from external
  sources, to be read as reports rather than as the agent's own conclusions —
  and so does anything derived from them, 29's topic index included, since
  `about` keys are model-written text on a tainted entry and an
  instruction-shaped topic name is exactly what a hostile page would induce. As
  an invariant it covers the derived views a later step adds for free.

**Out:**

- **Per-turn or per-span provenance.** Tracking which words of a write came
  from which result needs bookkeeping the runner does not keep. Session scope
  over-marks, which is the safe direction; the finer version is a kernel change
  worth its own pricing.
- **Blocking or refusing on taint.** This step labels; it does not gate. A
  `gated` write for tainted content is a policy decision with an approval-flow
  cost, and it belongs to whoever wants it, argued on its own.
- **Sanitizing untrusted text.** There is no reliable way to strip
  instruction-shaped content from adversarial input, and a filter that mostly
  works is worse than a label that always does, because it invites trust.
- **The memory-quality half of 29** — entry shape, supersession, injection
  blocks, ranking, the harness. This step supplies the label; 29 consumes it.

## Design sketch

- The field is on `ToolResult`, so `successResult`/`failureResult` in
  `executors` carry it and every tool built through them can set it without
  each plugin inventing a convention. 13's envelope marking becomes the first
  producer rather than a parallel mechanism.
- Because the hook is at execution, the two harness bridges get it in the same
  place they already count calls, which is also where their tool results cross
  back into kernel types.
- The daemon log records that a session became tainted and by which tool, by
  **name** — never content. Same rule as every other log event.
- A session's taint is monotonic: once set it does not clear within that
  session. Clearing would need a claim about what left the context, which
  nothing can make honestly.

## Acceptance criteria

- **A fact written after `web.fetch` is `external`; the same after
  `browser.read`** — asserted separately, because different plugins own those
  results and one passing says nothing about the other.
- **A subscription-path agent (`provider-claude-code`) and a Codex agent get
  the same marking as an Anthropic-path one** — the criterion that fails if the
  hook lands in the runner's loop, where it would never fire for either.
- **Taint survives a daemon restart mid-session**: a session tainted before the
  restart still writes `external` after it.
- **A session resumed from a pre-upgrade transcript containing external content
  writes `unknown`, not `agent`** — the upgrade case, which every fresh-install
  test passes straight over.
- **A newly registered third-party tool that declares itself a producer is
  tainted with no change to kernel code**, and one that marks a single call
  through the context sink taints only that call — the pair that proves the
  producer channel is a contract rather than a list the executor keeps.
- **A fresh session that reads an `external` entry — injected or recalled — and
  then remembers writes `external`, not `agent`.**
- **A session that has read an `unknown` entry writes `unknown`, not `agent`**
  — trust never rising is the property, and this is the case that tempted an
  earlier draft into an exception.
- **A session that has read nothing but `user` and `agent` content writes
  `agent`** — the other end, which stops the rule collapsing into "everything
  is suspect".
- **Both delegation directions**: a tainted parent's target writes `external`,
  and an untainted parent whose target fetched writes `external` after the
  reply. Asserted separately — the outbound test passes with the inbound half
  missing and reads like coverage.
- **A target whose own memory was `unknown` returns a reply that makes the
  parent `unknown`** — the return leg at a label that is not `external`, which
  every test written around tainted-or-not passes straight over.
- **A user's message does not taint the session**, so an agent that is simply
  talking to its operator writes `agent` — the criterion that fails if the
  producer rule is read literally enough to swallow everything.
- **An external entry's `about` key never appears in the plain topic index** —
  asserted with an instruction-shaped topic name, against the rendered prompt,
  which is the only place the leak shows.
- **A legacy entry with no `trust` renders under the unknown label, never as
  the agent's own conclusion.**
- **An operator's re-assertion record moves an entry out of `unknown`, and an
  agent cannot write one for itself.**
- The log names the tainting tool and never its output.

## Open questions

- **What is a third party's message in a shared channel?** A Slack channel with
  five members carries text the operator did not write, and treating it as
  `user` trusts anyone in the room while treating it as `external` taints every
  channel conversation. Probably a per-channel operator setting, which is a
  configuration surface this step would rather not open before someone needs
  it.
- **Should tainted writes ever be `gated` rather than merely labelled?**
  Out of scope above, but the argument is real for a fleet where an agent
  browses untrusted pages all day.
- **Does the label reach the *user*, or only the model?** An operator reading
  their agent's memory in [17](./17-fleet-console.md) probably wants to see
  which facts came off the network, and that is a UI decision 17 owns.
- **Is session scope too coarse to be useful in practice?** An agent that
  fetches one page early marks everything after it. Measurable once
  [29](./29-memory-quality.md)'s harness exists — it is the kind of question
  the harness was built to answer.
