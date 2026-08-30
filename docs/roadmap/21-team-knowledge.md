# 21 — Team knowledge: shared skills and roster-scoped memory

## Goal

A procedure one agent worked out becomes a skill the whole roster can use,
through a step a human reviews — and memory gains an explicit answer to what is
shared across a roster and what stays the agent's own.

## Why now

Two gaps that look separate and are the same gap.

[09](./09-skills.md) shipped skills as something an operator authors and
installs. But an always-on agent that solves the same problem the third time
has *learned a procedure*, and there is no path from that to a skill except a
human noticing and writing it down. Every neighbouring project is building
some version of this loop, and the shape available here is a better one: a
roster means the useful unit is not "this agent got better" but "the team did."

[14](./14-memory.md) made memory something an agent performs — `recall` and
`forget`, an index derived from JSONL that stays the record. It is keyed by
agent throughout, deliberately, and that is right for what an agent knows about
its own work. It gives no answer at all for what a *team* knows: two agents on
the same deployment cannot share a fact without a human copying it, and
[10](./10-proactive.md) plus `agent.delegate` mean they are already working on
each other's tasks.

Doing these together is not bundling. A promoted skill and a shared memory
entry are the same question — *what does an agent know that the roster should
know, and who approved it* — and answering it twice would produce two
mechanisms that disagree.

## Scope

**In:**

- **Skill promotion, with a human in the middle.** An agent proposes a skill:
  a `SKILL.md` body, a name, and the sessions it came from. The proposal goes
  nowhere until a human accepts it. Accepting writes it to
  `~/.stratus/skills/` as an ordinary skill, indistinguishable afterwards from
  one somebody typed.
- **Three signals decide what gets proposed, and none of them works alone.**
  - **Complexity** — a task that took many tool calls was expensive enough to
    be worth not re-deriving. Cheap to measure and needs no extra model call.
    Alone it encodes expensive one-offs that never recur.
  - **Recurrence** — the same shape of work has happened before. Alone it
    encodes trivia. Detection belongs in the maintenance pass below rather
    than in the turn: an agent mid-task sees only its own turn, while a pass
    over the corpus sees the pattern.

    **There is no corpus to search yet, and this step has to supply one.**
    [14](./14-memory.md)'s FTS5 index is built from remembered memory
    entries, not from session transcripts — so work that was never written
    to memory is invisible to it, which is most work. Recurrence detection
    needs session history it can search, and defining that access is part of
    this step rather than an assumption it can make.
  - **Agreement** — whether other agents already do this, and whether they do
    it the same way. Convergence is a strong promote signal. **Divergence is
    a signal not to promote**: if one agent posts deploy summaries as bullets
    in one channel and another as a table in a second, the procedure is
    contextual rather than shared, and flattening it would make both worse.

  Divergence is worth surfacing rather than silently dropping — *your agents
  do this two different ways, pick one* is a question only a roster can ask,
  and it is a better prompt to a human than any proposal.
- **A review surface for proposals** in [17](./17-fleet-console.md) — read the
  proposed body, see what it was derived from, accept, edit, or reject.
- **A maintenance pass over the skill corpus, in scope from the start.**
  Promotion without maintenance produces sprawl: overlapping near-duplicates,
  each partly wrong, and an agent that loads the wrong one. The pass runs in
  the background and does four things — detect recurrence for proposals,
  consolidate overlapping skills, flag stale ones (a skill naming a tool that
  no longer exists, or derived from work nobody does any more), and report
  what it did. It proposes; it does not silently rewrite.

  This is not optional polish. Every implementation of a promotion loop that
  has run for a while has needed one, and building it after the sprawl exists
  means cleaning up rather than preventing.
- **A revision lane for skill improvement, separate from approvals.** A skill
  that turns out to be wrong, incomplete, or stale should be improvable
  without a human retyping it. The agent proposes a **revision** — a diff
  against the current skill — and the live skill keeps running unchanged until
  the revision is accepted. Nothing is patched mid-turn, so what was reviewed
  stays what ran.

  **The lane is deliberately not the approvals queue.** Approvals are
  synchronous and turn-blocking: a turn is parked and a human is being waited
  on right now. A revision blocks nothing. Mixing them trains people to
  ignore the queue that matters, which costs more than the convenience is
  worth.

  The maintenance pass is the first-pass reviewer: it accepts mechanical
  revisions on its own — and the bar for "mechanical" has to be *provably no
  change in behavior*, which is narrower than it first looks. A typo or a
  dead link qualifies. **A renamed tool and a reordered step do not**: the
  rename points the procedure at a different tool, and reordering dependent
  steps changes what the procedure does. Both are behavior changes wearing
  cosmetic clothes, and both go to a human.

  Everything else **escalates**: a new tool, a widened scope, or any
  procedure touching a `gated` or `dangerous` capability. That escalation rule is what keeps the lane scalable; without
  it a human reviews everything and stops reviewing anything.
- **Roster-scoped memory as a second scope, not a replacement.** Agent-scoped
  memory stays exactly as 14 built it. A shared scope is additive, written
  deliberately, and readable by agents whose souls opt in.
- **Scope, principal, and authorship are three things and get three
  representations.** `AgentMemoryStore` takes an `agentId` on every method, and
  the temptation is to express the shared scope as a synthetic agent id through
  the same parameter. That makes one string carry three jobs — *where the entry
  lives*, *who is asking*, and *who wrote it* — and the second and third are
  exactly what authorization and attribution need to be separate. So the store
  takes an explicit scope:

  ```ts
  type MemoryScope =
    | { type: 'agent'; agentId: string }
    | { type: 'roster'; rosterId: string };
  ```

  with the acting agent passed alongside it wherever authorization or
  attribution is required.
- **Authorization lives in the host and tool layer, never in the store.** After
  [19](./19-registration-seams.md) an `AgentMemoryStore` can be a third-party
  plugin, and a design where each store re-implements the opt-in check is a
  design where one plugin gets it wrong and nobody notices. The store persists
  and retrieves; whether this agent may read or write this scope is decided
  before the call.
- **Writing to the shared scope is `gated`.** Agent-scoped `memory.remember` is
  `safe` because an agent editing its own notes acts on nothing outside itself.
  Writing something every teammate will read is a different act, and the risk
  model grades acting on the world.
- **A complete mutation policy, decided before implementation**, because a
  shared tombstone is a fleet-wide effect and "who may cause it" cannot be left
  to the first PR:
  - **Forgetting a shared entry is `gated`**, on the same reasoning as writing
    one.
  - **An agent may forget a shared entry it wrote.** Any opted-in agent
    forgetting any other agent's entry is refused — a roster where one agent
    can silently retract another's contribution is not a roster of separate
    identities, and the approval prompt is not a sufficient substitute for the
    author's own judgement.
  - **The operator has an administrative path** — through
    [17](./17-fleet-console.md) — that can forget any shared entry regardless
    of author. Somebody has to be able to remove a bad fact, and it is the
    human.
  - **Editing is forget-plus-write, and the editor becomes the author of the
    new entry.** No in-place mutation, so the audit trail stays append-only and
    attribution never silently transfers.
- **Opt-in per soul, both directions.** An agent reads the shared scope only if
  its soul says so, and writes only if its soul says so. A roster where every
  agent silently reads a common pool is not a roster of separate identities.

**Out:**

- **Autonomous skill creation with no human step.** An agent that writes its
  own procedures and immediately follows them is a system whose behavior nobody
  approved, and the whole permission model here is built on the opposite
  premise. The review step is the feature.
- **Skills that rewrite themselves during use.** The revision lane above is
  the supported path and the distinction is the whole point: a skill that
  mutates while running cannot be reviewed at all, because what was reviewed
  is not what ran. Proposing a revision is fine; applying one mid-turn is not.
- **Cross-*deployment* sharing.** A skill leaving this machine is distribution,
  which is [12](./12-plugin-registry.md).
- **Embeddings or semantic retrieval** for the shared scope. Same store shape
  as 14 — JSONL as the record, a derived index. A better index is a plugin
  behind `AgentMemoryStore`, and after [19](./19-registration-seams.md) it can
  actually be one.
- **Agents editing each other's agent-scoped memory.** The shared scope exists
  precisely so that stays impossible.

## Design sketch

- A proposal is inert data until accepted — never on any agent's skill path,
  never in any prompt. This is the property that makes the review step real
  rather than ceremonial.
- Promotion produces an ordinary skill. There is no second skill type with a
  second set of rules, and a promoted skill is qualified, allowlisted, and
  loaded exactly like any other.
- The shared scope is a scope within the existing store contract, not a second
  store. `append`, `list`, `search`, `forget`, and `audit` already carry an
  agent id; the shared scope is another key through the same paths, so the byte
  caps, tombstoning, and the derived-index watermark all apply unchanged.
- Every shared entry records which agent wrote it. A fact the whole roster acts
  on with no author is one nobody can evaluate or retract.
- Shared memory is injected under its own bounded slice, distinct from the
  agent's own. An agent should be able to tell what it learned from what it was
  told, and the prompt renderer from 09 is where that distinction is drawn.
- The daemon log records that a promotion happened and that shared memory was
  written. Not the bodies — the log is a trace, not a second transcript.

## Acceptance criteria

- An agent proposes a skill; it appears for review; nothing loads it; the
  proposing agent cannot read it back as a skill.
- Accepting writes an ordinary skill, and an agent whose soul allowlists it
  loads it on the next run with no restart-specific handling.
- Rejecting leaves no trace on any skill path.
- An agent that does not opt in to the shared scope cannot read it or write to
  it, at both gates.
- A proposal fires on a task that is both complex and recurrent, and does not
  fire on a complex one-off or on a recurring trivial one.
- Two agents doing the same work differently produce a surfaced divergence
  rather than a proposal.
- A proposed revision leaves the live skill byte-identical until accepted; the
  proposing agent's next run loads the old body.
- A mechanical revision (a renamed tool) is accepted by the maintenance pass;
  one adding a tool escalates to a human.
- A revision never appears in the approvals queue, and a parked approval never
  appears in the revision lane.
- The maintenance pass proposes a consolidation of two overlapping skills and
  rewrites neither until accepted.
- A shared write is refused in `headless` mode and asks in `remote` mode, and
  so is a shared forget.
- An agent forgetting a shared entry it wrote succeeds; the same agent
  attempting to forget another agent's shared entry is refused, and the refusal
  names the reason rather than reporting "not found".
- The operator's administrative path forgets an entry regardless of author.
- A memory-store plugin that performs no authorization of its own is still
  safe, because the check ran before the call — asserted with a store that
  deliberately checks nothing.
- Two agents both opted in: one writes, the other recalls it; a third that did
  not opt in does not.
- Agent-scoped memory is byte-identical in behavior to before this step —
  the 14 test suite passes unchanged.
- A shared entry is attributable to the agent that wrote it, and `forget`
  tombstones it for every reader.

## Open questions

- **How much of the trigger is mechanical?** Complexity is countable; recurrence
  needs a similarity judgement over past sessions, which is a model call in the
  maintenance pass and has a quality problem of its own. An explicit
  `skill.propose` an agent can call stays useful either way, as the path for a
  procedure the agent knows is worth keeping and the counters missed.
- **Does the maintenance pass need its own agent, or is it a scheduled turn?**
  [10](./10-proactive.md) already ships durable schedules, so a soul with a
  schedule may be the whole mechanism. That would make this a template rather
  than a subsystem, which is the cheaper answer if it holds.
- **Does an agent see its own pending proposals?** Arguing yes: it stops it
  proposing the same thing four times. Arguing no: pending proposals in context
  are an agent acting on unreviewed procedure, one step removed.
- **Is shared memory one scope or several?** The `rosterId` in `MemoryScope`
  leaves room for several without committing to them. One roster-wide pool is
  what ships; named scopes with soul-level membership are the generalization,
  and are probably not needed until somebody runs two teams of agents on one
  daemon.
- **Does the shared scope survive [15](./15-agent-isolation.md) layer A?**
  Per-agent state makes agent-scoped storage structurally separate, and a
  roster-scoped store is by definition the thing that crosses that boundary. It
  is a deliberate, narrow, opt-in crossing rather than a leak — but 15 should
  know it exists before it draws its lines.
