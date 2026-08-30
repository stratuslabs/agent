# 26 — Fleet introspection: read-only tools for an agent watching the fleet

## Goal

A small, read-only toolset — health, sessions, schedules, usage, pending
reviews — so an agent can answer *what needs a human's attention today* and say
so, on a schedule, in the channel the operator already reads.

## Why now

Everything needed to build a fleet-watching agent shipped except the reading.
[10](./10-proactive.md) landed durable schedules and `message.send`;
[17](./17-fleet-console.md) is building the surface an operator looks at. What
is missing is that **an agent has no way to see the fleet**: `schedule.list`
exists, and nothing else exposes a stuck session, a schedule that has failed
three times running, an agent consuming most of the budget, or a queue of
unreviewed skill revisions.

Close that and the fleet-watcher is a **soul file with a schedule** — one of
[16](./16-templates.md)'s templates rather than a subsystem, which is the
cheapest form this can take and the one least likely to become a second
half-monitoring-system nobody maintains.

It also gives two other steps somewhere to land. [17](./17-fleet-console.md)
needs a notion of *what is worth attention* to be more than a list viewer, and
[21](./21-team-knowledge.md)'s revision lane needs somewhere for a backlog to
surface when nobody has opened the console in a week.

## Scope

**In:**

- **A read-only `fleet.*` toolset**, roughly: roster and per-agent health;
  sessions with status and age, enough to spot one that has been running far
  too long; schedules with their last outcome; usage per agent once
  [18](./18-usage-accounting.md) supplies it; counts of anything queued for a
  human.
- **Aggregates by default, not content.** These answer *how many, how old,
  which agent, what status*. A count of stuck sessions is an operational fact;
  their transcripts are other agents' conversations.
- **`gated`, and out of every template's default allowlist.** This is the most
  privileged read in the system — the one place an agent sees across the whole
  fleet — and it should be an operator's deliberate grant.
- **Everything resolves through the existing seams.** The control API and
  `@stratusagent/state` already answer these questions for the console; these
  tools are a second consumer of the same rules, never a second implementation.
- **A template in [16](./16-templates.md)** wiring the toolset, a schedule, and
  `message.send` into a working fleet-watcher a person can edit.

**Out:**

- **Any write.** No restarting, no cancelling, no upgrading, no editing another
  agent's anything. An agent that could act on the fleet would be the most
  privileged thing in the deployment and the most attractive target in it;
  reading is the whole capability and the boundary is worth being boring about.
- **A monitoring subsystem.** No metrics store, no alerting engine, no
  thresholds in config. The tools report; a soul decides what is worth saying;
  a schedule decides when.
- **Reading session content across agents.** The isolation
  [15](./15-agent-isolation.md) is making structural is not worth trading for a
  better summary.
- **Infrastructure health.** Whether the process is up, the disk is full, or
  the image is current belongs to whatever is running the daemon — a service
  manager or a deployment's own control plane. These tools describe the
  *fleet*, not the *host*.
- **A built-in fleet-watcher agent.** It is a template, and templates are
  editable. Shipping it as a privileged built-in makes it unremovable and
  unauditable.

## Design sketch

- **Read-only is a property of the tools, not a promise in the docs.** There is
  no write path to omit an approval for; the toolset has no mutating verb.
- The fleet-watcher reports **to humans**. It is not something other agents
  delegate to — that would be a persistent shared service with fleet-wide read
  privileges, which is the shape [24](./24-sub-agents.md) deliberately rejects.
- Aggregates keep the caching story intact: these results are small and change
  every call, so they belong in the volatile tail of a prompt rather than
  anywhere [23](./23-prompt-caching.md) wants stable.
- What counts as "too long" or "concerning" is the soul's judgement, in prose,
  where an operator can edit it — not a constant in this repository. A fleet of
  research agents and a fleet of triage agents disagree about a slow turn.
- The daemon log records that a fleet read happened. It is a trace, and this is
  exactly the kind of privileged read worth being able to audit later.

## Acceptance criteria

- An agent with the toolset allowlisted reports the roster, a stuck session,
  and a failing schedule; one without it is refused at both gates.
- No tool in the set can change anything — asserted by the absence of a
  mutating path, not by a test that tries one.
- No tool returns another agent's session content.
- The template runs on a schedule and posts a digest through `message.send`.
- Numbers reported match what [17](./17-fleet-console.md) shows for the same
  fleet, because both read the same rules.
- The structured log shows the fleet read happened.

## Open questions

- **Does [17](./17-fleet-console.md) make this redundant?** If the console is
  good and someone opens it daily, a digest agent adds little. The case for
  building it anyway is that nobody opens a console daily, and the digest goes
  where they already are. Worth revisiting once 17 is real.
- **Where does "pending review" come from before [21](./21-team-knowledge.md)?**
  Approvals and schedules exist now; the revision lane does not. The toolset
  can ship with what exists and grow, or wait — probably ship.
- **Per-agent or fleet-wide scoping?** A watcher wants the fleet. An ordinary
  agent asking about *itself* — its own usage, its own schedules — is a
  different and much less privileged question, and might deserve a separate,
  `safe` self-read rather than a grant of the fleet-wide toolset.
