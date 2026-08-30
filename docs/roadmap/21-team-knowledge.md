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
- **A review surface for proposals** in [17](./17-fleet-console.md) — read the
  proposed body, see what it was derived from, accept, edit, or reject.
- **Roster-scoped memory as a second scope, not a replacement.** Agent-scoped
  memory stays exactly as 14 built it. A shared scope is additive, written
  deliberately, and readable by agents whose souls opt in.
- **Writing to the shared scope is `gated`.** Agent-scoped `memory.remember` is
  `safe` because an agent editing its own notes acts on nothing outside itself.
  Writing something every teammate will read is a different act, and the risk
  model grades acting on the world.
- **Opt-in per soul, both directions.** An agent reads the shared scope only if
  its soul says so, and writes only if its soul says so. A roster where every
  agent silently reads a common pool is not a roster of separate identities.

**Out:**

- **Autonomous skill creation with no human step.** An agent that writes its
  own procedures and immediately follows them is a system whose behavior nobody
  approved, and the whole permission model here is built on the opposite
  premise. The review step is the feature.
- **Skills that rewrite themselves during use.** Same reason, worse: a skill
  that changes as it runs cannot be reviewed at all, because what was reviewed
  is not what ran.
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
- A shared write is refused in `headless` mode and asks in `remote` mode.
- Two agents both opted in: one writes, the other recalls it; a third that did
  not opt in does not.
- Agent-scoped memory is byte-identical in behavior to before this step —
  the 14 test suite passes unchanged.
- A shared entry is attributable to the agent that wrote it, and `forget`
  tombstones it for every reader.

## Open questions

- **What triggers a proposal?** An explicit tool the agent calls
  (`skill.propose`) is legible and depends on the agent noticing. A
  post-session pass over what happened catches more and is a second model call
  per session with a quality problem of its own. Leaning explicit first,
  because a proposal nobody reviews is worse than no proposal.
- **Does an agent see its own pending proposals?** Arguing yes: it stops it
  proposing the same thing four times. Arguing no: pending proposals in context
  are an agent acting on unreviewed procedure, one step removed.
- **Is shared memory one scope or several?** One roster-wide pool is simple and
  will be wrong for any deployment with two teams of agents. Named scopes with
  soul-level membership is the obvious generalization and is probably not
  needed until somebody has that deployment.
