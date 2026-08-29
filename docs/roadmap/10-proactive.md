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
  parked approval does. A schedule carries the **prompt its firings dispatch**
  — "check the repo, summarize what changed" is data on the row, written by
  the agent at creation and reviewed by the human who approves it. A firing
  creates a session with the agent's own provider, memory, and allowlist,
  through the same dispatch path a channel message uses — never a second
  runner.

  The risk split is per tool, not per toolset: `schedule.every` and
  `schedule.at` are `gated` (they spend future money unattended), while
  `schedule.list` is a read and `schedule.cancel` only ever *narrows*
  authority — both are `safe`, precisely because cancel is the reversal: a
  headless agent that set a bad schedule must be able to undo it without
  waiting for the human whose absence is the problem.
- **`message.send`** — post to a channel or DM outside the current turn. This
  is what makes a scheduled turn observable; without it a scheduled agent works
  in silence.
- **An addressable outbound seam on the channel contract**, which this step has
  to add before `message.send` can exist. `@stratusagent/channels` today has no
  way to say *where*: `OutboundConnection` (`post` / `edit` / `upload`) is the
  write side of one conversation and is only ever handed to you inside that
  conversation, and `ChannelAdapter` is `{ name, start, stop }`. Nothing in
  either lets a caller name a destination it is not already talking to.

  So the contract gains one operation — obtaining an `OutboundConnection` for
  an **agent plus a channel-native destination id** (a Slack channel or DM id,
  the same convention `AgentApprovalConfig.slackApprovers` already uses,
  because mapping through a Stratus identity adds a lookup that can only be
  wrong). The agent is part of the address, not context: each agent is its own
  Slack app, possibly in a different workspace, so a destination id alone does
  not say whose tokens — or whose workspace's id space — it belongs to. The
  connection *shape* is reused unchanged, but note that nothing implements it
  yet: `ReplyRenderer` is the Slack adapter's de-facto write side and is
  per-turn stateful, so this step writes the contract's first real
  implementation. `SessionRouting` is the near neighbour and deliberately
  not this: it exists so a channel can reach a session with no live turn to
  hang the message on, which is finding an *existing* conversation rather than
  addressing an arbitrary one.

  An adapter that cannot address destinations (a transport with no concept of
  one) declines the operation, and a schedule naming a destination it cannot
  serve fails at creation — when a person is present to hear why — rather than
  at 6am. For Slack that check is real API surface, not a lookup the adapter
  can already do: existence and membership come from `conversations.info`,
  which means new read scopes on the app manifest and a new method on the
  adapter's web-client seam.
- **A schedule declares its destination — or declares that it has none — and
  a declared destination is pre-authorized.** The destination is optional
  because a silent schedule is still reviewable: "this may speak nowhere" is a
  complete answer, and nightly maintenance work (memory consolidation, a
  workspace sweep) is a real use with nothing to say. A firing of a
  destination-less schedule that tries `message.send` anyway is gated exactly
  like any inbound turn. For schedules that do report, the pre-authorization
  is required — without it the step does not work at all, and the
  arithmetic is worth stating: `message.send` is `gated`, headless refuses every
  gated call, remote parks one waiting for a person, and each firing is its own
  session — so the session-scoped `always` answer cannot carry to the next
  firing (`ApprovalAnswer` in `packages/core`, deliberately "not forever"). A
  schedule that must ask permission to speak, every morning, forever, is not an
  unattended agent.

  The resolution is that **the approval belongs to the schedule, not to the
  firing**. `schedule.every` is gated, so a human approves "every morning, check
  the repo, report to #eng" once — destination included, because where a
  schedule reports is part of what is being reviewed. A `message.send` to
  *that* destination from a turn of *that* schedule is then pre-authorized: it
  is the decision already made, not a new one. Anywhere else stays `gated`
  exactly as it is in an inbound turn, so the pre-authorization is one channel,
  named by a person, at approval time.

  One consequence worth stating because it changes what an approver is shown:
  a plain "once" answer to `schedule.every` mints something durable. The
  approval prompt for that call must therefore render the cadence, the prompt,
  and the destination — the person is standing up recurring speech, and the
  prompt has to say so rather than reading like any other one-shot yes.
- **Per-agent concurrency and rate limits**, because a schedule is the first
  thing in the system that can spend money while nobody is watching. A cap on
  concurrent scheduled turns per agent, and a floor on interval.
- **`stratus schedules`** to list and cancel what the fleet has set, and the
  same over the control API — an agent that scheduled something an operator
  cannot see or stop is a bug.

**Out:** cross-agent schedules (an agent scheduling work for another agent —
delegation already covers the useful half); calendar integration; heartbeats as
a *health* mechanism, which is monitoring and belongs with 08. Note that the
other kind of heartbeat — the OpenClaw/Hermes-style attention loop, "wake up
every half hour, look at your checklist, speak only if something needs saying"
— is *not* excluded, because it needs no machinery of its own: it is exactly a
`schedule.every` whose prompt says to look around, and silence is the free
default here since a scheduled turn has no implicit reply channel — speaking
requires an explicit `message.send`, so "nothing to report" is just a session
that completes. No suppression token contract required.

## Design sketch

- The scheduler lives in the gateway, not the kernel: it needs the dispatcher,
  the session store, and the roster, and the kernel does not know about any of
  them. `schedule.*` and `message.send` are first-party tools the gateway
  registers with a closure over its own handles, exactly as it registers
  `agent.delegate` today — not plugins through the loader, whose context is
  still `{ bus, tools }` and has no way to carry a live dispatcher. (Growing
  `PluginContext` is kernel-budget item 9 in `stratus-v2.md` and is not this
  step's job.)
- **Risk:** `schedule.every`/`schedule.at` are `gated` and `message.send` is
  `gated`, with the scheduled-destination carve-out above; `schedule.list` and
  `schedule.cancel` are `safe` (see Scope). None is `dangerous`: everything
  here is reversible, and `schedule.cancel` is the reversal — which is itself
  the argument for cancel being `safe`.
- The carve-out is a **new approval scope**, and that is the part of this step
  worth arguing about rather than implementing quietly. Today an approval is
  scoped to one call (`once`) or one session (`always`), and the kernel says
  outright that a durable whitelist is a different, narrower promise belonging
  to the step that needs one. This is that step, and the promise here is
  narrower still: not a command pattern, but a single (schedule, destination)
  pair, minted by a human decision, revoked by `schedule.cancel`, and listable
  by `stratus schedules`. It should be built as its own scope with those
  properties, not by widening `always` — and concretely, **the schedule row is
  the scope**: the destination lives on the record the human approved, revoke
  is deleting the row, and the audit list is the schedule list, so there is no
  second store to drift from the first. The policy stays free of the tool's
  input shape the same way the command-scope engine does: the tool says what
  destination an invocation names (`destinationFor`, mirroring `commandFor`),
  and an injected check answers whether this session's schedule covers it —
  consulted before the headless refusal, never for a `dangerous` tool.
  `ApprovalAnswer` stays three values; the human approves the *creation* with
  the buttons that already exist.
- A missed firing (daemon down) does not stampede on restart. At most one
  catch-up run per schedule, and a schedule whose window has passed entirely is
  skipped with a log line, not replayed. Double-run protection is a schedule-row
  write, not a session sweep: the firing's slot (`last_fired_at`, next fire)
  is consumed **before** the dispatch, so a daemon that dies mid-firing leaves
  a failed session — which the abandoned-turn sweep already reports honestly —
  and never a second run of the same window.
- A scheduled turn carries metadata marking it scheduled (and naming its
  schedule), so a channel renderer can say so, an approval request arriving out
  of nowhere is explicable, and the carve-out check can find the row.
- The asymmetry with `agent.delegate` is deliberate and worth a sentence,
  because delegation resolved the same headless arithmetic by declaring itself
  `safe` (with a "revisit when a human can actually be asked" comment):
  delegation stays inside the fleet, under every per-agent allowlist and the
  same approval policy, while `message.send` speaks to people outside it — so
  one demotes risk and the other keeps the gate and earns a narrow,
  human-minted exception instead.

## Acceptance criteria

- An agent asked "check my repo every morning and tell me what changed" sets a
  schedule, and the firing produces a Slack message without anyone in the loop —
  **in headless mode**, which is what an installed service runs. A test that
  passes only under `remote` with a human clicking has not tested this step.
- The same scheduled turn sending to a channel the schedule did not declare is
  gated normally: refused under headless, parked under remote. A firing of a
  schedule that declared *no* destination is the degenerate case of the same
  test: every `message.send` it attempts is gated.
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

All three were settled in review; recorded here with the reasoning rather than
deleted, since each is the kind of question a reader re-asks.

- **Session per firing — decided per firing**, with the schedule id in
  metadata. A year-long session is a compaction problem nobody asked for, and
  it is a provider-replay-cache problem too. Cross-firing continuity is what
  agent memory is for ([14](./14-memory.md)); OpenClaw walked the other path
  first, hit the token cost, and grew isolated sessions plus a side "scratch"
  store — which is this design, arrived at the expensive way.
- **Edits — decided: schedules are immutable.** Editing is cancel-plus-create,
  so there is no edit operation at all in this step; the approval scope's
  lifecycle is exactly the row's lifecycle, and the cost is one extra
  confirmation.
- **Cold outreach — decided: only conversations the agent's app is a member
  of** (the same check creation-time validation runs), no widening config in
  this step. The alternative is an agent that can cold-DM a workspace, and a
  config knob for that deserves to be argued for by someone who needs it.
