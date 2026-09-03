# Schedules and outbound messages

Everything else in these docs answers when spoken to. Two toolsets make an
always-on daemon into agents that act on their own:

- **`schedule.every` / `schedule.at`** — recurring (an interval like
  `"30m"` or a five-field cron expression, local time) or one-shot
  (ISO-8601), with the prompt each firing runs and, optionally, the
  destination its reports are pre-authorized to post to.
- **`schedule.list` / `schedule.cancel`** — an agent's own audit and undo.
- **`message.send`** — post to a channel or DM outside the current
  conversation:
  `{ destination: { channel: "slack", to: "C0123456789" }, text }`.
  Without it a scheduled turn works in silence.

Souls opt in like any other tool:

```markdown
---
name: Ava
tools:
  - schedule.*
  - message.send
---
```

## The approval belongs to the schedule, not to the firing

Creating a schedule is `gated`: a human approves "every morning, check the
repo, report to #eng" once — cadence, prompt, and destination together. A
`message.send` from that schedule's firings *to that destination* then runs
unattended, in headless mode included: it is the decision already made, not
a new one. Anywhere else — another channel, a DM, a schedule that declared
no destination — stays gated exactly as in an inbound turn, so under
`headless` it is refused and under `remote` it asks in Slack (in the
configured `approvals.slackChannel`, since a scheduled turn has no thread
of its own). Note that a plain **Allow once** on `schedule.every` therefore
mints something durable — the request shows the cadence, prompt, and
destination, because that is what is being approved. See
[Approvals](./approvals.md) for the modes.

## The rest of the shape, briefly

- **Each firing is its own session** (`schedule:<id>:<slot>`), dispatched
  through the same path a channel message takes, marked `scheduled: true`
  in metadata. Continuity across firings is what
  [agent memory](../concepts/memory.md) is for. That prefix is **reserved**:
  a firing's session carries the destination grant approved with the
  schedule, so nothing outside the scheduler may dispatch into one. The
  daemon refuses it, and the control API answers `400 session_id_reserved`
  rather than accepting a turn that could never run.
- **Schedules are immutable.** Editing is cancel-plus-create, so the
  approval's scope is exactly the row's lifetime.
- **A one-shot's row lives exactly as long as its firing.** The slot is
  spent before the firing starts and the row is retired when the firing
  finishes — including a firing that was parked on a human when the daemon
  stopped and finished after the restart. Until then it is listed without a
  next firing, because it is still the scope of that approval.
- **A destination is validated at creation** — the agent's Slack app must
  be able to see the conversation and be a member of it — so a schedule
  that could never report is refused while somebody is present to hear why,
  not at 6am. The same membership check runs on every send: no cold-DMing.
- **Schedules survive restarts** (they live in the daemon's own database),
  a slot is consumed *before* its firing dispatches so a crash mid-firing
  never double-runs it, and a missed window gets at most one late
  catch-up — windows that passed entirely are skipped with a log line.
- **Two limits hold unattended spend down**: an interval floor (default one
  minute) and a per-agent cap on concurrent scheduled turns (default one —
  a firing that would exceed it waits for the next tick).

## The operator's view

What the fleet has set is never only the agents' business:

```bash
stratus schedules                    # every agent's schedules, straight from the daemon's database
stratus schedules cancel <id>        # stop the next firing; the destination grant dies with the row
```

Cancelling — from the CLI, the control API (`DELETE /schedules/:id`), or
the agent's own `schedule.cancel` — revokes the pre-authorized destination
in the same stroke, and a running daemon notices without a restart. The
daemon log records that a schedule was created, fired, or cancelled (ids
and destinations, never prompt contents beyond the row itself).
