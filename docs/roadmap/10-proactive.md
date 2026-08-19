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
- **`message.send`** — post to a channel or DM outside the current turn, over
  the [02](./02-slack-channel.md) channel contract's outbound operation. This
  is what makes a scheduled turn observable; without it a scheduled agent works
  in silence.
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
- **Risk:** `schedule.*` is `gated` and `message.send` is `gated`. Both act
  outside the turn — one spends future money unattended, the other speaks to
  people who did not ask. Neither is `dangerous`: both are reversible, and
  `schedule.cancel` is the reversal.
- A missed firing (daemon down) does not stampede on restart. At most one
  catch-up run per schedule, and a schedule whose window has passed entirely is
  skipped with a log line, not replayed.
- A scheduled turn carries metadata marking it scheduled, so a channel renderer
  can say so and an approval request arriving out of nowhere is explicable.

## Acceptance criteria

- An agent asked "check my repo every morning and tell me what changed" sets a
  schedule, and the firing produces a Slack message without anyone in the loop.
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
- Should `message.send` be able to start a conversation with someone the agent
  has never spoken to, or only reply into channels it is already in? Leaning
  the latter by default with config to widen it, because the alternative is an
  agent that can cold-DM a workspace.
