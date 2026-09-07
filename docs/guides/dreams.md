# Dreams: what an agent works on overnight

[Schedules](./schedules.md) let an agent act at a time it chose. Dreaming is
the other half: a file **you** wrote, worked through in a window at night —
experiments, builds, reading — with nobody to report to and nothing to
interrupt.

Two things it is not, because both would be a different feature:

- **Not a schedule.** There is no row, no cadence, and no approval to
  grant, because a dream asks for nothing. Editing the file is how a dream
  changes; deleting `dreams:` from the soul is how dreaming stops.
- **Not a background loop.** A night is a small, bounded number of ordinary
  turns. The agent runs with its own tools, its own allowlist, and its own
  approval mode — a `gated` tool at 3am is refused under `headless` and
  asked in Slack under `remote`, exactly as it would be at 3pm.

## Turning it on

Two files. The soul says the agent dreams and where its dreams live:

```markdown
---
name: Scout
dreams: ./scout.dreams.md
tools:
  - web.fetch
  - memory.*
---
```

The path is resolved **relative to the soul file**, not to whatever
directory the daemon happens to have been started in. `~/.stratus/agents/`
is the ordinary place for both — name the file `<agent>.dreams.md` there,
because that directory is scanned by extension and a `*.dreams.md` sibling
is the one `.md` in it the roster knows is not a soul. Anywhere else, call
it what you like.

Then the dream file itself — frontmatter for when, `##` headings for what:

```markdown
---
window: 01:00-05:00
maxPerNight: 2
---

Nobody is awake. `memory.remember` is the report: one entry per finding,
written for someone who was not here. Leave nothing running.

## Follow up on last night's open questions

Read back what you remembered recently and close the cheapest loose end.

## Re-read the sources behind a claim we repeat

Verified, likely, or unknown — and if it has become unknown, say so.
```

[`examples/souls/scout.dreams.md`](../../examples/souls) is that file,
written out in full; it doubles as the format docs.

- **The prose before the first `##` is a preamble**, prepended to every
  dream's prompt. Standing rules go there once instead of in each dream.
- **Each `##` heading is one dream**, and its body is the work. A heading
  inside a fenced code block is content, not a new dream.
- **`window:`** is two 24-hour local times (default `01:00-05:00`). It may
  cross midnight: `23:00-03:00` is one night, named for the evening it
  opened on, so the small hours belong to the night before rather than
  starting a fresh one.
- **`maxPerNight:`** caps what one night starts (default 3). Dreams run in
  file order, one at a time, and the ones past the cap wait for another
  night.

Check it before the first night, in daylight:

```bash
stratus dreams                # every dreaming agent: file, window, dreams, last night
stratus dreams --agent scout --format json
```

A file that will not parse is reported there, by name and reason, instead
of in a log line at 1am.

## What a night actually does

Each dream is its own session — `dream:<agent>:<night>:<n>` — dispatched
through the same path a channel message takes, so it is a durable session
like any other: readable in the dashboard and over `GET /sessions`, while
the [daemon log](./logs.md) records only that it ran, the way it records
every other turn.

What carries a finding out of the night is the agent's
[memory](../concepts/memory.md). **A dream that remembers nothing leaves
nothing behind**, which is why the preamble above spends its words on that.

The rest of the shape, briefly:

- **A dream is spent before it runs.** The night's count is written to the
  daemon's database ahead of the dispatch, so a daemon that dies mid-dream
  comes back to a night that has already used that dream. It moves to the
  next one; it never replays.
- **A missed night is skipped, not caught up.** If the window closed while
  the daemon was down, that night did not happen. A schedule names a task
  and gets one late catch-up; a dream names a night, and doing it at
  lunchtime is a different act.
- **The file is re-read every night** — an edit this evening is tonight's
  work. Adding `dreams:` to a soul takes effect at the next roster reload
  (`POST /roster/reload`, or a restart); see
  [what needs a restart](./always-on.md#what-needs-a-restart-and-what-does-not).
- **One dream at a time per agent**, in file order. The next starts when the
  last has finished.
- **Dreaming needs the daemon.** `stratus serve` (or the installed service)
  is what has a clock; `stratus run` and `stratus chat` never dream.

## What it costs, and what it may reach

Dreaming is the one thing in Stratus that spends money on work nobody asked
for tonight, so the defaults are small on purpose: three dreams, one at a
time. `maxPerNight:` is the knob, and it is in the file you are already
editing.

It reaches exactly what the agent reaches by day — the soul's `tools:`
allowlist, its credentials, its
[approval mode](./approvals.md) — and nothing more:

- **No destination is pre-authorized.** A schedule can carry one a human
  approved with its cadence. A dream carries none, so `message.send` at 3am
  is gated like any other unattended send. The morning report is a
  schedule's job; the night's job is to remember.
- **Its session is reserved.** Nothing outside the dream runtime may
  dispatch or observe into a `dream:` session — the control API answers
  `400 session_id_reserved` — so what you read in the morning is the
  night's own work and nobody else's.
- **The dream file may not live in `~/.stratus/workspaces/`.** That is the
  agents' own scratch directory, the one place they can write by default,
  and a dream prompt is dispatched as *your* words (see
  [Security](../concepts/security.md#dreaming)). An agent able to write its
  own dream file could give itself standing overnight instructions at your
  authority; the daemon refuses that path and says so.
