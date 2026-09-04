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

The gap is live today, and it is not theoretical. Memory carries model-authored
text *across* the turn boundary: an agent that reads a hostile page and
remembers what it said has moved that text past every check the turn applied,
into a later prompt where it reads as something the agent concluded. Nothing in
the system currently marks it, and nothing can, because the marking stops at one
plugin's result envelope.

**Memory is the principal such channel, not the only one**, and earlier drafts
of this step said "the only" — which was wrong in a way worth correcting rather
than softening. An agent can `fs.write` fetched text into its workspace and
`fs.read` it back in a later session, where the file carries no provenance and
the content arrives looking like the agent's own notes. The filesystem is a
durable store the agent controls, so it is a laundering channel by
construction, and a step that closed memory while claiming completeness would
be advertising a boundary it does not have.

This is its own step rather than a section inside 29 because of what it
touches: `ToolResult` in `core`, the executor, four tool plugins, both harness
provider bridges, `agent.delegate`, the session store, and the prompt renderer.
That is a different blast radius and a different review from "make recall
better", and the review history of 29 is the evidence — four rounds, and every
round after the first found another hole in the taint half while the memory
half stood.

## Scope

**In:**

- **A trust field on `ToolResult`**, in `core`. The promotion 13 deferred. It
  carries **a value from the ordering below, not a boolean** — a result can be
  `unknown` as easily as `external`, and a delegate reply from a target working
  off its own legacy notes is exactly that. A binary field forces an
  implementation to either upgrade such a reply to `agent` or overstate it as
  `external`, and both are lies of the kind the label exists to prevent. It
  says where the content came from; it does not say what a consumer should do
  about it, which is each consumer's business.
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
- **`user` is its own category, and it is earned by an authorized principal —
  never inferred from the shape of a channel.** An earlier draft said a message
  "from the principal on an authenticated channel" is `user`, treating a DM as
  proof of who was speaking. It is not. The Slack adapter's checks are: the
  event has a user, is not a bot, has no subtype, is a DM or an app mention,
  and is not the bot itself. **Nothing there establishes that the sender is the
  agent's operator** — any member of the workspace can open a DM or type an
  `@mention`, and under the earlier wording their message would have arrived as
  the trust root. That is instruction-shaped content from a stranger, labelled
  `user`, one `memory.remember` away from being the agent's own conclusion.

  So: `user` requires the operator to have **said who the principal is**. A
  per-agent authorized-sender mapping is part of this step — small, an
  allowlist of ids per bound channel — and it is the thing that makes `user`
  mean something.

  - A local CLI session is `user` with no mapping needed: the machine's owner
    is the operator, and that is what the permission model already assumes
    everywhere else.
  - A channel sender the operator has authorized is `user`.
  - **A channel sender they have not is `unknown`** — not `external`, because
    claiming a stranger wrote it overstates what we know when the sender may
    well be the operator who simply has not configured the mapping yet; and
    not `user`, because that is the whole finding. `unknown` propagates under
    the ordering, so the safe behavior holds while the claim stays honest.

  This also settles what was an open question about shared channels, and
  settles it better than the question was framed: the distinction was never DM
  versus channel, it is authorized principal versus not. A five-member channel
  where all five are authorized is fine; a DM from a stranger is not.

  **The principal is a property of the turn, not of the session**, and getting
  that backwards would undo the mapping entirely. A Slack thread keys one
  session for every turn in it, so an authorized member can open a thread and
  an unauthorized one can mention the agent inside it afterwards — same
  session, different sender. A check that read the principal from persisted
  session metadata would see the *first* sender forever and hand the later
  member's content the first member's trust.

  So the sender is evaluated **every turn**, and an unauthorized turn lowers
  the session to `unknown` and leaves it there — monotonic, like everything
  else here, and right: that content is in the transcript from then on.
  **`runner.resume` has to carry the turn's metadata to make this possible,
  and today it does not** — the gateway passes `metadata` to `runner.run` and
  calls `resume` with `{ sessionId, userMessage, signal }` alone, so a resumed
  turn currently arrives with no way to say who sent it. That is a kernel
  change this step owns rather than an implementation detail it can assume.
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
  those sessions `external` outright would be the other overcorrection.

  **"Only until they end" is not good enough, because some of them do not
  end.** The Slack adapter keys a DM session on the DM channel id alone, so an
  operator's ongoing conversation with an agent is *one* resumable session that
  may run for the life of the install — and with trust monotonic within a
  session, a pre-upgrade DM would write `unknown` forever, even once its
  transcript held nothing but the operator's own messages. Entry re-assertion
  cannot fix that: it re-labels entries, and this is a *session* label.

  The remedy is a session boundary, not a trust upgrade: an operator-triggered
  **rollover** that starts a fresh session for a conversation, leaving the
  pre-upgrade prefix behind in the record where it belongs. That is honest —
  the old session stays what it was — and it is the only move that does not
  either strand a conversation at `unknown` or quietly raise trust over a
  transcript nobody re-read.
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
    re-assertion record below — and **re-asserting the pinned core alone is not
    enough**, which an earlier draft of this bullet claimed. [29](./29-memory-quality.md)
    keeps injecting recent entries in a tail, and on an upgraded install those
    are legacy entries at `unknown`, so a session goes `unknown` on its first
    turn no matter how carefully the pins were re-labelled. The drain is
    proportional to **everything that reaches the prompt**, not to the pins.

    That makes bulk re-assertion part of the operator surface rather than a
    convenience: `stratus memory` and [17](./17-fleet-console.md) re-assert a
    selection, not one entry at a time. It is still bounded work — an operator
    reviews what their agent actually surfaces, once — but it is honest about
    the size, and a claim that pinning covers it would send someone into an
    afternoon of confusion wondering why their agent still writes `unknown`.
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
- **A tainted-write ledger, so the filesystem round trip closes too.** While a
  session is at `external` or `unknown`, the paths it writes through `fs.write`
  are recorded against the agent, and a later `fs.read` of one of those paths
  taints the reading session at the recorded label. Small — a set of paths per
  agent, in the agent's own state, next to the roots `tool-fs` already resolves
  per call — and it covers the realistic sequence: fetch, write, read back next
  week, remember.

  **What it does not cover, said plainly**: a copy under another name, a file
  a different process wrote, or content pasted through some path the ledger
  never saw. Full filesystem provenance means carrying labels on bytes across
  a surface the agent does not exclusively own, which is a different project.
  This closes the sequence an agent can perform by itself, which is the one
  that matters here, and leaves the rest named rather than implied.
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
  prompt derived from an entry renders under a higher label than that entry
  carries*. Stated over the ordering rather than over `external` alone,
  because `unknown` stopped being only a legacy artifact the moment an
  unauthorized sender's message started producing it — a stranger in a Slack
  thread can now induce an `unknown` entry with an instruction-shaped `about`,
  and an invariant naming only `external` would let that topic through into
  the plain index with the warning stripped. Each label gets its own region;
  facts and everything derived from them, 29's topic index included, render in
  the region their source earns. As
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
- **An authorized principal's message does not taint the session**, so an agent
  talking to its operator writes `agent` — the criterion that fails if the
  producer rule is read literally enough to swallow everything.
- **A message from a workspace member who is not an authorized principal makes
  the session `unknown`**, in a DM as much as in a channel — the criterion that
  fails if `user` is inferred from channel shape, which is what the adapter's
  own checks would have allowed.
- **A mixed-sender thread**: an authorized member opens it, an unauthorized one
  mentions the agent later, and the turn after that writes `unknown` — the
  criterion that fails if the principal is read from session metadata once
  instead of from each turn's sender.
- **A rolled-over session writes `agent` again where its pre-upgrade
  predecessor wrote `unknown`** — over a store whose injected slice has been
  re-asserted, with the old session unchanged. The qualifier is the criterion:
  roll over a store that still has `unknown` entries in its recency tail and
  the new session is `unknown` on its first turn, correctly, which is the
  result that catches anyone who thinks rollover alone is the remedy.
- **Neither an `external` nor an `unknown` entry's `about` key appears in the
  plain topic index** — asserted with an instruction-shaped topic name against
  the rendered prompt, which is the only place the leak shows, and asserted at
  both labels, since a stranger's message now produces the `unknown` one.
- **Write-then-read across sessions**: a tainted session `fs.write`s fetched
  text, a fresh session reads that path and remembers — and the entry is
  `external`, not `agent`. The sequence an agent can perform unaided, and the
  one that makes "memory is the only channel" false.
- **A legacy entry with no `trust` renders under the unknown label, never as
  the agent's own conclusion.**
- **An operator's re-assertion record moves an entry out of `unknown`, and an
  agent cannot write one for itself.**
- The log names the tainting tool and never its output.

## Open questions

- **How much configuration should the authorized-principal mapping be?** The
  question this replaced asked what a third party's message in a shared channel
  is, and framed it as DM versus channel — the wrong axis, as the adapter's own
  checks show, since a DM proves nothing about who is typing. Scope now says an
  allowlist of sender ids per bound channel. What stays open is how much more
  than that it should be: a group, a Slack user-group reference, or a "whoever
  installed the app" default that most installs would never touch.
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
