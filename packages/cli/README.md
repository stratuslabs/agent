# @stratusagent/cli

Stratus Agent CLI — create always-on agents that get smarter over time. Quickly set up Stratus Agent on your machine, create new agents, connect AI providers, and configure channels.

<img width="2400" height="1004" alt="image" src="https://github.com/user-attachments/assets/ef16d58f-694c-406e-b201-aee61b093753" />

## Install

Needs **Node.js 22.13+** — the gateway's session store uses `node:sqlite`, which runs unflagged from 22.13. On the 23.x line that landed separately, in **23.4**, so 23.0–23.3 are too old despite the higher number. Every package declares the range, and the CLI checks it at startup, so an unsupported Node gets a line naming what it needs rather than a missing-builtin error later on.

```bash
npm install -g @stratusagent/cli
stratus setup
```

That one package is everything you need to run agents: the runtime, the
providers, the agent roster, and the always-on gateway all come with it.

### Optional channel packages

Channels are the exception — the CLI ships **no** transport, so an install that
never touches Slack never carries the Slack SDKs (~9 MB). Add the one you want
alongside the CLI and `stratus serve` picks it up automatically:

```bash
npm install -g @stratusagent/channel-slack
```

If tokens are stored for an agent but the package isn't installed, `stratus
serve` says so and starts anyway, serving every other channel.

## Setup

`stratus setup` is the whole onboarding, as a small navigable menu:

```
  1) Providers            anthropic — signed in with your Claude subscription
  2) Models               default claude-opus-5 · fallback gpt-4.1-mini
  3) Agent                ~/.stratus/agents/ava.md
  4) Channels             Slack: 1 agent connected
  5) Always on            stratusd runs after setup, and at every login
  6) Test run             say hello with the current settings
  7) Save & finish
```

- **Providers** — sign in to one or more. For Claude, choose how you pay: a **Claude Pro/Max subscription** (run `claude setup-token`, paste the token — runs route through the Claude Code runtime, so your plan covers usage; requires Claude Code installed and signed in. Tool runs and memory work there too, so it's the same agent as on an API key) or an **Anthropic API key**, pasted straight into the prompt (input is hidden) and checked against the live API when the endpoint supports it — a rejected key is refused; an unreachable endpoint saves the key and verifies it on your first run. OpenAI-compatible services work like API keys, including local models and proxies via a custom base URL.
- **Models** — pick a **default** and a **fallback**, listed live from the provider APIs where possible (subscription sign-ins and offline setups fall back to the known Claude lineup). If the default model errors mid-run, the run automatically retries on the fallback — even across providers.
- **Menus are keyboard-driven** — arrow keys (or `j`/`k`) to move, Enter to pick, digits to jump, Esc to go back.
- **Agent** — name your agent (or accept a generated identity), describe their personality, and their soul file lands in `~/.stratus/agents/`, ready to edit.
- **Channels** — put an agent on Slack without opening a file. Pick the agent, and setup prints the app manifest with their name already filled in, walks you through the two tokens (input hidden), verifies each against Slack before accepting it, and stores them where `stratus serve` looks. The list marks who is connected; picking a connected agent offers to replace their tokens or disconnect.
- **Always on** — whether the roster keeps answering once you close the terminal. On by default, because an agent you have to remember to start is not always-on, and every Slack app you connected above stays silent until `stratusd` runs. Save & finish installs it (see [Always on](#always-on)); choose *do not run it for me* and setup removes any service it previously installed.
- **Test run** — say hello with the current settings before saving anything.

Credentials are stored in `~/.stratus/credentials.json` (owner-read-only) and settings in `~/.stratus/config.json`, so `stratus run` works from any directory afterwards. No env vars to export, no config files to hand-edit.

## Usage

```bash
stratus setup                          # onboarding menu: providers, models, agent, channels
stratus chat                           # talk — the conversation persists
stratus chat --soul ./ava.md
stratus run "say hello"
stratus run --soul ./ava.md "introduce yourself"
stratus run --provider anthropic --model claude-opus-5 "hello"
stratus run --prompt "use the echo tool" --format json
stratus serve                          # stratusd: the whole roster, always on
stratus serve --idle-timeout 120 --no-events
stratus serve --approvals remote       # ask a human in Slack instead of refusing
stratus service install                # keep stratusd running under launchd/systemd
stratus service status
stratus logs -f                        # what the daemon has been doing
stratus logs --agent ava -n 200
stratus doctor                         # what a run would use right now, and why
stratus agent new                      # create an agent (guided on a terminal)
stratus agent new --format soul > ava.md
stratus agents                         # who's on the team: souls, models, memory
stratus dashboard                      # local browser dashboard
```

`stratus serve` runs the gateway in the foreground: every agent in your roster
live at once on its own provider and model, sessions in SQLite so they survive
restarts, delegation between agents, a watchdog for stalled turns, and any
installed channels connected. Ctrl+C or SIGTERM drains cleanly.

### What the daemon will do on its own

Tools declare how much damage they could do — `safe`, `gated`, or
`dangerous` — and the daemon runs only the safe ones without asking. Anything
riskier is refused, with a line in the log saying which agent wanted what:

```text
09:14:36  —           warning: ava: shell.run is gated and nobody is available to approve it (session slack:ava:…)
```

That is the honest default behind a service manager, where there is no
terminal to prompt on. If somebody *is* reachable, `--approvals remote` asks
them instead — see [Asking a human](#asking-a-human-remote-approval).

A tool that declares no risk counts as `gated`, never `safe` — forgetting to
classify something should cost a prompt, not an unattended command. Every
tool that ships today (`demo.echo`, `memory.remember`, `agent.delegate`) is
`safe`, so nothing changes until you add one that isn't.

The line is *acting outside Stratus* — the filesystem, the network, another
service — not cost. Every turn spends provider tokens, including the one
that decided to call a tool, so a policy that gated on spend would have to
gate the conversation itself. Delegation stays `safe` for the same reason:
it hands work to a teammate inside the fleet, that teammate's own tool
calls face this policy again under their allowlist, and the chain is depth
bounded.

`stratus chat` and `stratus run` are unaffected: at a terminal, `--approvals`
works exactly as before (`always`, `ask`, `never`).

### Asking a human: remote approval

In `remote` mode a gated call does not fail — the turn parks, the request is
posted to Slack with **Allow once**, **Always allow**, and **Deny**, and the
turn resumes on the answer. The question goes to the thread the turn is
happening in, so whoever is talking to the agent sees it where they already
are.

Turn it on for the daemon with `--approvals remote`, or in
`~/.stratus/config.json` so the installed service picks it up too:

```jsonc
{
  "approvals": {
    "mode": "remote",              // headless (default) or remote
    "timeoutMs": 900000,           // unanswered after 15 minutes → denied (max 2147483647)
    "slackApprovers": ["U01OPS"],  // who may decide, for every agent
    "slackChannel": "C07OPS",      // where to ask when the turn isn't in Slack
    "agents": {
      "ava": { "slackApprovers": ["U01DYLAN"] }
    }
  }
}
```

An agent inherits the top-level route key by key, so `ava` above asks her own
approver in the shared `C07OPS` fallback channel. An explicit
`"slackApprovers": []` on an agent excludes it from the default list — that
agent's gated calls are then denied outright — while omitting the key
inherits.

**Only a config you chose is allowed to set this block** — `--config`,
`STRATUS_CONFIG`, or the global `~/.stratus/config.json`. An auto-discovered
project-local `stratus.config.json` outranks the global one for provider
settings, but it can be checked into any repository, and appointing the
people who may authorize an agent's tool calls is not something a clone gets
to do. Its `approvals` block is ignored, with a warning naming the file.

Three things are worth knowing before you turn it on:

- **Approvers are people, not places.** Posting into a channel does not make
  everyone in it an approver: each request is bound to the ids configured for
  that agent, and anyone else's click is refused with a notice only they see.
  The request stays open for someone who may actually answer it. This matters
  most for **Always allow**, which widens what the agent may do unattended.
- **An agent with no approver configured is denied immediately**, not left to
  time out — `remote` with nobody listed behaves exactly like `headless`. If
  no channel can ask for an agent at all (no Slack tokens for it, or
  `@stratusagent/channel-slack` not installed) there is nothing to render the
  request, so its gated calls wait out the timeout instead. The daemon names
  those agents at startup, rather than leaving you to find out at 3am:

  ```text
  approvals: remote — gated calls are parked and asked in Slack (approvers set for ava)
  ```
- **A parked turn survives a restart.** The daemon records what has not run
  before it asks, so an approval outstanding when it stops is finished when
  it starts again — the question is re-asked in Slack, the call runs on the
  answer, and anything queued behind it still runs too. The re-asked request
  keeps the window it started with rather than getting a fresh one, and a
  wait that has already used up its `timeoutMs` is denied instead of
  re-asked: downtime is not a reason to extend a security decision.
- **Always allow lasts for the session**, not forever. It stops the same tool
  asking again in the same conversation, and it is forgotten when the daemon
  restarts. A durable per-agent whitelist is a narrower promise (a normalized
  command scope) and ships with the shell tool that needs one.

The request shows the tool's **arguments**, not just its name — for anything
whose danger lives in what it was called with, approving a bare tool name is
approving something you cannot see. Arguments are escaped (a model-written
argument cannot mention or broadcast to the workspace through the prompt)
and truncated with a visible notice when they are long.

Requests are also denied — visibly, with a reason — when they expire, when
the turn is cancelled, when the daemon shuts down, and when a turn reaches a
gated call while the daemon is already stopping. Every one of those retracts
the buttons in Slack, so a message never keeps offering a decision with
nowhere to land.

`timeoutMs` is capped at 2147483647 (~24.8 days), the longest timer Node can
hold. A larger value is rejected at startup rather than accepted: it would
not wait longer, it would expire every approval almost immediately.

Approval buttons need the Slack app's **Interactivity** switched on. Apps
created from the manifest that `stratus setup` prints already have it; an app
created before this shipped needs it enabled once, in its App Manifest.

## Always on

`stratus serve` stays a foreground process on purpose — debuggable, and
composable with whatever supervisor you already run. Surviving logout, crashes,
and reboots is the platform's job, so `stratus service` hands the daemon to
launchd on macOS and to systemd on Linux:

```bash
stratus service install          # write the unit, start now, start at every login
stratus service install --no-login
stratus service status
stratus service start
stratus service stop
stratus service uninstall
```

`stratus setup` installs it for you at Save & finish unless you opt out, so
most people never run these by hand. What they get:

- **macOS** — a LaunchAgent at `~/Library/LaunchAgents/com.stratusagent.stratusd.plist`
- **Linux** — a systemd user unit at `~/.config/systemd/user/stratusd.service`

The unit runs the daemon by **absolute path** — the node binary and script of
the process that installed it, never a bare `stratus`. A service manager starts
with a minimal environment and never loads the shell profile that puts `stratus`
on your `PATH`. It stops with SIGTERM, so the gateway's drain actually runs.

A default install restarts the daemon if it crashes, but not after a clean
exit — stopping it yourself keeps it stopped. **`--no-login` gives up crash
restarts on macOS**, and that is launchd's rule rather than a choice: `KeepAlive`
implies `RunAtLoad`, so a job that must not start at login cannot ask to be
revived either. `stratus service install --no-login` says so when it finishes.
On Linux the two are independent, and `Restart=on-failure` applies either way.

`status` asks the service manager, not the unit file, whether the daemon is
alive, and exits non-zero when it isn't — so it works in a health check:

```text
stratusd  running
  manager   launchd
  unit      ~/Library/LaunchAgents/com.stratusagent.stratusd.plist
  at login  yes
```

**One limit worth knowing before you rely on it.** A LaunchAgent starts at
**login, not at power-on**, and only while that user is logged in — an
unattended Mac needs automatic login turned on too. (A `LaunchDaemon` would
start without a login, but it runs as a system user, which breaks `~/.stratus`
paths and the Claude subscription token entirely, so the LaunchAgent is the
right choice.) The systemd equivalent is `loginctl enable-linger` on a machine
you don't stay logged in to. Setup says both in the menu rather than leaving
them to be discovered after a reboot.

## Logs

Under a service manager the daemon's stdout is gone, so everything `stratus
serve` says is also written to `~/.stratus/logs/stratusd.jsonl` (owner-read-only,
rotated at 8 MB, three generations kept). That file is the record of an
overnight run, and `stratus logs` reads it from any terminal:

```bash
stratus logs                     # the last 50 records
stratus logs -f                  # follow, across rotations
stratus logs -n 200
stratus logs --agent ava
stratus logs --session slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456
stratus logs --format json       # the raw records, for jq
```

```text
09:14:02  —           stratusd ready — 3 agents, slack connected
09:14:31  ava         session.created [slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456]
09:14:36  ava         tool.completed tool=memory.remember ok=true [slack:ava:T01ABCDEF:C07GHIJKL:1731900000.123456]
09:21:07  —           warning: anthropic returned 529; retrying on the fallback model
```

Session ids are the channel's own key — `channel:agent:team:conversation[:thread]`
— so the id in the last column is exactly what `--session` wants, and the same
conversation keeps it across daemon restarts.

The log is a **trace, not a second transcript**: it records that a tool ran and
that a session completed, with the tool's name, the agent, and the session id.
Prompts, replies, and tool inputs are not written — what was said lives in the
session store instead.

One exception worth knowing before you paste a log anywhere. A failed session
records the **provider's error text verbatim**, and providers routinely quote
the request that failed — so a malformed prompt can end up inside an error
message. Skim a log before sharing it, and prefer `--agent` or `--session` to
narrow it to the run you actually mean.

### When the log is empty

A daemon that fails *before* it starts serving — a broken install, an
unreadable credentials file — never gets as far as opening the structured log,
so `stratus logs` shows nothing or shows yesterday. Those errors go to stderr,
and where stderr lands is the service manager's business, so it differs by
platform:

```bash
tail ~/.stratus/logs/stratusd.err.log      # macOS
journalctl --user-unit=stratusd.service    # Linux
```

That is where a restart loop explains itself. On macOS the LaunchAgent redirects
both streams to files, so Stratus truncates them when `serve` starts and every
five minutes while it runs — a crash loop cannot fill the disk with the same
error a million times. On Linux systemd keeps the same output in the journal
instead, which does its own rotation, so there is nothing beside the JSONL to
bound and nothing to clean up.

## When something looks off

`stratus doctor` answers one question — *what would a run use right now, and
who decided that?* Every setting is shown with the file or environment variable
it came from, because the answer is usually that something outranks what you
thought you configured:

```bash
stratus doctor
stratus doctor --format json
```

```text
Stratus Agent — what a run would use right now

  provider  anthropic
            from ~/.stratus/agents/ava.md (soul frontmatter)
  model     claude-opus-5
            from ~/.stratus/agents/ava.md (soul frontmatter)
  soul      ~/.stratus/agents/ava.md
            from ~/.stratus/config.json
  agent     Ava (ava)

Files
  config    ~/.stratus/config.json
  agents    1 soul file

Sign-ins
  anthropic Claude subscription (Pro/Max) — runs go through the Claude Code runtime
  openai    not signed in

Channels
  slack     no agents connected
            @stratusagent/channel-slack installed

1 problem found:
  ! A fallback model (gpt-4.1-mini) is configured but could not be resolved — usually
    no sign-in for its provider. A failing primary model has nothing to retry on.
```

It resolves the config exactly the way a run does rather than re-deriving the
rules, so what it prints is what you would get. It exits non-zero when it finds
a problem, and it is the fastest answer to the two most common surprises: a run
that turns out to be on the `demo` provider, and an `ANTHROPIC_API_KEY` in the
environment quietly demoting a Claude subscription sign-in to per-token billing.

## Agents are people

An agent's identity lives in a **soul file** — markdown with frontmatter for the structured parts (name, provider, model, tool allowlists) and prose for the personality:

```markdown
---
name: Ava
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
  - memory.remember
---

You are a sharp, warm generalist. Answer first, explain second...
```

Agents remember: facts saved with the built-in `memory.remember` tool persist to `~/.stratus/memory.jsonl`, keyed to the agent — so the Ava you talk to tomorrow remembers today, from any directory.

**Ids are not labels.** Frontmatter may set `id:` explicitly, and it keys the
agent's sessions, memory, credentials, Slack tokens, and every per-agent path
on disk. So it has to stay one path segment, and one ordinary map key: an id
may not start with a dot or contain a slash, a backslash, a control
character, or leading or trailing whitespace, and it may not be a name every
object already answers to (`__proto__`, `constructor`, `toString`). Anything that would leave its directory is rejected when the soul
loads rather than quietly cleaned up — `id: ../../escape` is refused, not
rewritten to `escape`.

Anything else is yours. An id like `Ava_1` or `team.alpha` is unusual but
harmless, and it is already keying that agent's sessions and sign-ins, so it
is left exactly as written. Omit `id:` and one is derived from the name as a
plain slug (`ava`); a generated agent's id is also capped at 64 characters,
but a slug derived from a name you chose is used whole, because shortening
an id moves the agent it belongs to.

Creating an agent checks the id against every id the served roster holds,
not against the filenames on disk: what the roster files *declare* (a soul
at `renamed.md` can declare `id: ava`), the configured default soul even
when its file lives elsewhere, and the reserved `stratus`. A new agent gets
a suffixed id (`ava-3f9c`) rather than one that would collide. Its name
stays the one you chose.

**Two souls cannot share an id.** That is not two agents; it is one agent
whose memory and sign-ins belong to whichever file sorted first. The roster
refuses to load and names both files, `stratus serve` will not start,
`stratus doctor` reports it, and `stratus setup` → Channels offers no
agents at all — nothing is servable while the roster is ambiguous, so
connecting a Slack app would configure something that cannot run. Neither
command offers to clear "unmatched" Slack tokens in that state either: a
roster that would not load cannot prove which ids are missing, and the
tokens at risk belong to agents that are perfectly fine. (An unreadable *single* soul still degrades to a
warning — one broken file never takes the team down. A collision has no
correct winner, which is the difference.) The built-in `stratus` id is
reserved: souls claiming it are skipped — including two of them, since
neither was going to get the id, so their agreeing on it is not a collision
to refuse over.

## Options

| Flag | Purpose |
| --- | --- |
| `--soul <file>` | Run as the agent defined by a soul file (also `STRATUS_SOUL` / config `soul` key) |
| `--provider` | `anthropic`, `openai`, or `demo` (offline, no account) |
| `--model` | Model for real providers (anthropic default: `claude-opus-5`) |
| `--base-url` | Override the provider API base URL |
| `--config <file>` | Load settings from a specific config file |
| `--approvals` | `run`/`chat`: tool approval mode — `always`, `ask`, or `never`. `serve`: how the daemon reaches a human — `headless` (refuse gated calls) or `remote` (ask in Slack); overrides the config's `approvals.mode` |
| `--max-turns` | Max provider turns per run (default 8) |
| `--format` | `text` or `json` |
| `--idle-timeout` | `stratus serve`: seconds of provider silence before the watchdog aborts a turn (default 120) |
| `--no-events` | Hide the event log |
| `--no-log-file` | `stratus serve`: do not write `~/.stratus/logs/stratusd.jsonl` |
| `--no-login` | `stratus service install`: install without the start-at-login trigger |
| `-f`, `--follow` | `stratus logs`: follow the log, across rotations |
| `-n <count>` | `stratus logs`: how much backlog to print (default 50) |
| `--agent`, `--session` | `stratus logs`: show only one agent's or one session's records |

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file. Project-local `stratus.config.json` outranks the global `~/.stratus/config.json`; stored sign-ins are endpoint-bound and never sent to endpoints a project config selects.

Today the CLI covers setup, chat, one-shot runs, agent creation, the always-on gateway and its service integration, logs, diagnostics, Slack, and the local dashboard. More channels — and one control API that every surface talks to — are next.

Part of [Stratus Agent](https://github.com/stratuslabs/agent) — a tiny TypeScript agent runtime.
