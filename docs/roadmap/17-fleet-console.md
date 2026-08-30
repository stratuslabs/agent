# 17 — Fleet console: the dashboard as the management surface

## Goal

Make `@stratusagent/dashboard` the place a fleet is actually operated from —
roster and health, live and past sessions, pending approvals, schedules, and
memory — for someone who is never going to open a terminal.

## Why now

[05](./05-control-api.md) built the API and a UI on top of it, and the
management group is already there. What is missing is that the surface a person
would *manage* from is still the CLI: schedules are `stratus schedules`,
approvals are a Slack button or a log line, memory has no view at all —
[14](./14-memory.md) shipped with its dashboard view explicitly deferred, and
this is where that debt lands.

It also cleans up after two decisions. [07](./07-macos-app.md) is dropped, and
its stated job — creating and managing agents visually — has to live somewhere;
this is where. And [16](./16-templates.md) makes agent creation a reviewable
bundle, which is a flow with a UI shape, not just a CLI one.

## Scope

**In:**

- **Roster view.** Every agent with its avatar, provider and model, tool and
  skill allowlists, channel presence, and whether it is currently working.
- **Session view.** Live sessions streaming over the existing WebSocket, past
  sessions readable, each with its turns, tool calls, and outcome. Per-turn
  cost once [18](./18-usage-accounting.md) supplies it.
- **Approvals.** The pending queue as a first-class screen with allow / always
  allow / deny, against the API 05 already exposes. Slack stays the fast path;
  this is the one that works when the approver is not in Slack.
- **Schedules.** What each agent has scheduled, when it next fires, what it did
  last time, and cancellation.
- **Memory.** The per-agent view 14 deferred: browse, search, and forget,
  against `list`, `search`, and `forget` on the store contract. `audit` is the
  operator read and belongs here rather than anywhere an agent can reach.
- **Agent creation and editing**, including the 16 template flow with its
  review step rendered rather than printed.

**Delivered in vertical slices.** The list above is a product epic, and
several of its read endpoints do not exist yet — which is how a step becomes a
long-lived branch that lands nothing for two months. Each slice is
independently releasable, and the acceptance criteria below are the milestone,
not the gate on each slice:

1. **Roster and health** — the screen that makes the daemon legible at all.
2. **Sessions and approvals** — the two that need the event stream, together
   because they share it.
3. **Schedules and memory** — the two that need new read endpoints.
4. **Template-backed creation and editing** — last, because it depends on
   [16](./16-templates.md) landing.

**Out:**

- A second copy of any rule. Everything on every screen resolves through the
  control API, which resolves through `@stratusagent/state`. A dashboard that
  computed effective configuration itself would be the fourth implementation of
  a precedence chain that already has exactly one.
- New endpoints where an existing one serves. Where the API genuinely lacks
  something (memory reads are the likely case), it is added to `control-api`
  with its README updated in the same PR — that document is what the other
  surfaces are written against.
- Multi-user accounts, roles, or per-user views. The control API's auth model
  is one deployment, one set of credentials; changing that is 08's business.
- A build step or a framework. `dashboard` carries no dependencies on purpose
  and stays that way.

## Design sketch

- Every screen is a projection of the event stream plus a read endpoint. The
  event envelope in `control-api`'s README is the contract; a screen that needs
  something not in the envelope is a signal to extend the envelope, not to
  poll.
- Secrets never arrive. Credential screens report presence, type, and bound
  endpoint, and session reads stay stripped by `redactAnthropicRawTurns` —
  both are existing invariants and this step is the one most likely to erode
  them by accident.
- Cookie-authenticated requests stay origin-bound and bearer ones do not, per
  the existing security note. A new screen does not get to relax that.
- The dashboard is served by the daemon it manages. Remote access remains the
  `remote-access` guide's business — a tunnel or a bound interface, decided by
  a trusted config.

## Acceptance criteria

- An operator with no terminal can: create an agent from a template, watch a
  session run, resolve a gated call, cancel a schedule, and delete a memory
  entry.
- A pending approval resolved in the dashboard resumes the parked turn, and
  the same approval resolved in Slack disappears from the dashboard without a
  reload.
- No response to any dashboard screen contains a credential value or a raw
  Anthropic turn — asserted in a test, not by inspection.
- The memory view's forget tombstones the entry and the agent's next
  `memory.recall` does not return it.
- Every new endpoint this step adds is documented in
  `packages/control-api/README.md` in the same PR.

## Open questions

- **Does the console show the daemon log?** `stratus logs` exists and the
  JSONL is a trace rather than a transcript, so a log screen is genuinely
  useful. The caution is the documented one: `session.failed` persists provider
  error text verbatim, so a log view is not automatically safe to screen-share
  and must not be presented as though it were.
- ~~How much of 16's review step is duplicated here?~~ **Decided:** the
  summary is computed once in `@stratusagent/state` and rendered by both the
  CLI and this console. Two implementations of "what will this grant" is two
  answers to the only question the review step asks, and the divergence would
  surface as an operator approving one thing and getting another. 16 owns the
  computation; this step owns the rendering.
