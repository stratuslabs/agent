# 32 — Dreaming: a file of overnight work, and a window to do it in

## Goal

An agent can be given standing work that has no deadline and no audience —
experiments, builds, reading — written by its operator in a `DREAMS.md`
beside the soul, and worked through in a window at night. What survives the
night is what the agent remembered.

## Why now

[10](./10-proactive.md) shipped the only way an agent acts unprompted, and
it is the wrong shape for this. A schedule is a row an agent creates, a
human approves once, and a destination reports to: cadence, prompt, and
destination together, immutable, cancelled by id. That is exactly right for
"every morning, check the repo, report to #eng", and it fits standing
open-ended work badly:

- The work is the operator's, not the agent's, so `schedule.every` is the
  wrong author and `schedule.cancel` is the wrong undo — an agent could
  delete the work it was given.
- It changes often. A schedule is immutable by design (the approval's scope
  is the row's lifetime), so "edit the list" is cancel-plus-create, and a
  list of six lines of inquiry is six rows to keep in sync with a file
  nobody has.
- It reports to a destination. Overnight work has nobody to report to;
  its output belongs in [memory](./14-memory.md), which is the thing that
  carries a finding into tomorrow's conversation.

Everything underneath already exists: durable sessions, a per-agent memory
an agent writes deliberately, the approval modes, and — in [30](./30-provenance.md)
— a trust label that says whose words a turn is running on. This step is
the small piece on top.

## Scope

**In:**

- **`dreams:` in soul frontmatter**, a path resolved relative to the soul.
  That is the per-agent switch, and the only one.
- **A dream file**: the same tiny frontmatter dialect souls and skills use
  (`window:`, `maxPerNight:`), prose before the first `##` as a preamble
  prepended to every dream, and each `##` heading plus its body as one
  dream.
- **A nightly window that may cross midnight**, named for the local date it
  opened on, so 23:00–03:00 is one night rather than two halves.
- **A dream runtime in the gateway**: a tick that finds the open window,
  claims one dream durably *before* dispatching it, and runs the file in
  order, one dream at a time per agent, up to the cap.
- **A reserved `dream:` session namespace**, refused by the public dispatch
  and observe doors and by the control API, exactly as `schedule:` is.
- **`stratus dreams`** — the plan from disk (file, window, dreams in order)
  and the record from the daemon's database (what last night started and
  finished), with `--agent` and `--format json`.

**Out:**

- **A destination, or any other grant.** A dream is not a schedule; nothing
  is pre-authorized, and `message.send` at 3am is gated like any other
  unattended send. The morning report is a schedule's job.
- **Catch-up.** A window that closed while the daemon was down is a night
  that did not happen.
- **An `agent.dream`-style tool.** The file is the operator's; an agent
  that wants recurring work of its own already has `schedule.every`.
- **A control API surface.** The CLI reads the daemon's database directly,
  the way `stratus schedules` does. The fleet console ([17](./17-fleet-console.md))
  is where a hosted view belongs.

## Design sketch

The split follows schedules exactly, because the reasons are the same:
`@stratusagent/agents` owns the pure half (the file format, the window
arithmetic, the prompt composition, the metadata keys), and
`@stratusagent/gateway` owns the runtime and the store — it is the only
package with a dispatcher and a database.

- `SqliteDreamStore`, one row per agent in the session database, through its
  own connection (`stratus dreams` reads it from another process).
  `started` is incremented before the dispatch: the double-run guarantee.
- `createDreamRuntime` ticks once a minute, resolves each dreamer's file
  fresh, opens the night if it is not open, and claims the next dream if
  the agent has none running.
- `resolveDreamsPath` lives in `@stratusagent/state`, which owns
  `~/.stratus`, and refuses a path inside `workspaces/` — the one directory
  agents write by default. A dream prompt is dispatched at `user` trust,
  and a dream file an agent could write would be an agent writing its own
  standing instructions at its operator's authority.

## Acceptance criteria

- A soul with `dreams:` and a file beside it runs its dreams, in order, in
  the window, and nothing outside it.
- A dream claimed before a crash is not replayed after the restart; the
  night continues from the next one.
- A window that passed while the daemon was down starts nothing.
- `dream:` session ids are refused by `Gateway.dispatch`, `Gateway.observe`,
  and `POST /sessions/:id/messages`.
- A dream file inside `~/.stratus/workspaces/` is refused by name, and that
  agent does not dream.
- `stratus dreams` reports a file that will not parse, with the reason.

## Open questions

- **Running a night on demand.** There is no `stratus dreams run <agent>`
  today: testing a dream file means waiting for the window or moving it.
  That wants a control API endpoint (the daemon is what dispatches), which
  is a surface decision this step deliberately left alone.
- **Whether a night should be summarized.** Each dream is its own session,
  so "what happened last night" is `stratus dreams` plus the transcripts.
  A synthesis pass at the end of a night is the obvious next thing and the
  obvious way to double the cost.
- **Cadence per dream.** Every dream is nightly-eligible; a dream that
  should run weekly has no way to say so, and the cap is what keeps a long
  file from running every night in full.
