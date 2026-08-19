# 10 — Proactive agents: schedules and outbound messages

## Goal

An agent that acts without being spoken to first — on a schedule it set itself,
and able to say something in a channel when it has something to say.

## Why now

Every step so far builds a better *responder*. The daemon from
[01](./01-gateway.md) is always on, and the only thing that ever starts a turn
is an inbound message. That makes "always on" a deployment detail rather than a
capability: the same agent would behave identically as a CLI invocation with a
long-lived shell.

Nothing else on the board covers this, and the Swift iteration had it —
`CronScheduler`, `CronJobConfig`, and per-agent heartbeats. It belongs after
[06](./06-tool-packs.md) because a scheduled turn with no tools can only
produce text nobody reads, and after [09](./09-skills.md) because "what to do
every morning" is a procedure, not a prompt.

## Scope

**In:**

- **`schedule.*`** — `schedule.every` (interval or cron), `schedule.at`
  (one-shot), `schedule.list`, `schedule.cancel`. Schedules are **per agent**,
  durable in the same store sessions live in, and survive a restart the way a
  parked approval does. A firing creates a session with the agent's own
  provider, memory, and allowlist, through the same dispatch path a channel
  message uses — never a second runner.
- **`message.send`** — post to a channel or DM outside the current turn. This
  is what makes a scheduled turn observable; without it a scheduled agent works
  in silence.
- **An addressable outbound seam on the channel contract**, which this step has
  to add before `message.send` can exist. `@stratusagent/channels` today has no
  way to say *where*: `OutboundConnection` (`post` / `edit` / `upload`) is the
  write side of one conversation and is only ever handed to you inside that
  conversation, and `ChannelAdapter` is `{ name, start, stop }`. Nothing in
  either lets a caller name a destination it is not already talking to.

  So the contract gains one operation — obtaining an `OutboundConnection` for a
  destination given by a **channel-native id** (a Slack channel or DM id, the
  same convention `AgentApprovalConfig.slackApprovers` already uses, because
  mapping through a Stratus identity adds a lookup that can only be wrong).
  The connection shape itself is reused unchanged; what is new is being able to
  get one by address. `SessionRouting` is the near neighbour and deliberately
  not this: it exists so a channel can reach a session with no live turn to
  hang the message on, which is finding an *existing* conversation rather than
  addressing an arbitrary one.

  An adapter that cannot address destinations (a transport with no concept of
  one) declines the operation, and a schedule naming a destination it cannot
  serve fails at creation — when a person is present to hear why — rather than
  at 6am.
- **A schedule declares its destination, and that destination is
  pre-authorized.** Without this the step does not work at all, and the
  arithmetic is worth stating: `message.send` is `gated`, headless refuses every
  gated call, remote parks one waiting for a person, and each firing is its own
  session — so the session-scoped `always` answer cannot carry to the next
  firing (`ApprovalAnswer` in `packages/core`, deliberately "not forever"). A
  schedule that must ask permission to speak, every morning, forever, is not an
  unattended agent.

  The resolution is that **the approval belongs to the schedule, not to the
  firing**. `schedule.every` is gated, so a human approves "every morning, check
  the repo, report to #eng" once — destination included, because a schedule that
  does not say where it reports is not reviewable. A `message.send` to *that*
  destination from a turn of *that* schedule is then pre-authorized: it is the
  decision already made, not a new one. Anywhere else stays `gated` exactly as
  it is in an inbound turn, so the pre-authorization is one channel, named by a
  person, at approval time.
- **Per-agent concurrency and rate limits**, because a schedule is the first
  thing in the system that can spend money while nobody is watching. A cap on
  concurrent scheduled turns per agent, and a floor on interval.
- **`stratus schedules`** to list and cancel what the fleet has set, and the
  same over the control API — an agent that scheduled something an operator
  cannot see or stop is a bug.

**Out:** cross-agent schedules (an agent scheduling work for another agent —
delegation already covers the useful half); calendar integration; heartbeats as
a *health* mechanism, which is monitoring and belongs with 08.

## Design sketch

- The scheduler lives in the gateway, not the kernel: it needs the dispatcher,
  the session store, and the roster, and the kernel does not know about any of
  them. `schedule.*` tools are a plugin over a gateway-supplied handle, the same
  way `agent.delegate` takes a dispatcher rather than capturing a runner.
- **Risk:** `schedule.*` is `gated` and `message.send` is `gated`, with the
  scheduled-destination carve-out above. Both act outside the turn — one spends
  future money unattended, the other speaks to people who did not ask. Neither
  is `dangerous`: both are reversible, and `schedule.cancel` is the reversal.
- The carve-out is a **new approval scope**, and that is the part of this step
  worth arguing about rather than implementing quietly. Today an approval is
  scoped to one call (`once`) or one session (`always`), and the kernel says
  outright that a durable whitelist is a different, narrower promise belonging
  to the step that needs one. This is that step, and the promise here is
  narrower still: not a command pattern, but a single (schedule, destination)
  pair, minted by a human decision, revoked by `schedule.cancel`, and listable
  by `stratus schedules`. It should be built as its own scope with those
  properties, not by widening `always`.
- A missed firing (daemon down) does not stampede on restart. At most one
  catch-up run per schedule, and a schedule whose window has passed entirely is
  skipped with a log line, not replayed.
- A scheduled turn carries metadata marking it scheduled, so a channel renderer
  can say so and an approval request arriving out of nowhere is explicable.

## Acceptance criteria

- An agent asked "check my repo every morning and tell me what changed" sets a
  schedule, and the firing produces a Slack message without anyone in the loop —
  **in headless mode**, which is what an installed service runs. A test that
  passes only under `remote` with a human clicking has not tested this step.
- The same scheduled turn sending to a channel the schedule did not declare is
  gated normally: refused under headless, parked under remote.
- A schedule naming a destination its agent's channel cannot address is refused
  at `schedule.every` time, with a message saying so — not accepted and then
  silently unable to report.
- Schedules survive a daemon restart, and a restart during a firing does not
  double-run it.
- A gated tool call inside a scheduled turn parks and asks exactly as it would
  in an inbound turn — headless refuses, remote asks in Slack.
- `stratus schedules` lists what every agent has set; cancelling from the CLI
  stops the next firing.
- The interval floor and per-agent concurrency cap are enforced with tests that
  fail without them.

## Open questions

- Does a scheduled turn get its own session per firing, or resume one long
  session per schedule? Leaning per firing, with the schedule id in metadata —
  a year-long session is a compaction problem nobody asked for.
- Should the pre-authorized destination survive an *edit* to the schedule, or
  does changing when or what it runs re-open the question of where it reports?
  Leaning re-approve on any edit: the cheap answer is that a schedule is
  immutable and editing one is cancel-plus-create, which makes the approval
  scope trivially correct and costs an operator one extra confirmation.
- Should `message.send` be able to start a conversation with someone the agent
  has never spoken to, or only reply into channels it is already in? Leaning
  the latter by default with config to widen it, because the alternative is an
  agent that can cold-DM a workspace.
