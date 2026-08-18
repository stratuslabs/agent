# @stratusagent/cli

Stratus Agent CLI — create always-on agents that get smarter over time. Quickly set up Stratus Agent on your machine, create new agents, connect AI providers, and configure channels.

## Install

Needs **Node.js 22.13+** — the gateway's session store uses `node:sqlite`, which runs unflagged from 22.13.

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

## Always on

`stratus serve` stays a foreground process on purpose — debuggable, and
composable with whatever supervisor you already run. Surviving logout, crashes,
and reboots is the platform's job, so `stratus service` hands the daemon to
launchd on macOS and to systemd on Linux:

```bash
stratus service install          # write the unit, start now, start at every login
stratus service install --no-login
stratus service status
stratus service start | stop | uninstall
```

`stratus setup` installs it for you at Save & finish unless you opt out, so
most people never run these by hand. What they get:

- **macOS** — a LaunchAgent at `~/Library/LaunchAgents/com.stratusagent.stratusd.plist`
- **Linux** — a systemd user unit at `~/.config/systemd/user/stratusd.service`

The unit runs the daemon by **absolute path** — the node binary and script of
the process that installed it, never a bare `stratus`. A service manager starts
with a minimal environment and never loads the shell profile that puts `stratus`
on your `PATH`. It restarts on crash but not after a clean exit, and stops with
SIGTERM so the gateway's drain actually runs.

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
rotated at 8 MB, three generations kept). That file is the only record of an
overnight run, and `stratus logs` reads it from any terminal:

```bash
stratus logs                     # the last 50 records
stratus logs -f                  # follow, across rotations
stratus logs -n 200
stratus logs --agent ava
stratus logs --session slack-C07AB12CD-1731900000.123456
stratus logs --format json       # the raw records, for jq
```

```text
09:14:02  —           stratusd ready — 3 agents, slack connected
09:14:31  ava         session.created [slack-C07AB12CD-1731900000.123456]
09:14:36  ava         tool.completed tool=memory.remember ok=true [slack-C07AB12CD-1731900000.123456]
09:21:07  —           warning: anthropic returned 529; retrying on the fallback model
```

The log is a **trace, not a second transcript**: it records that a tool ran and
that a session completed, never tool inputs or message text. What was said
lives in the session store, and `~/.stratus/logs` stays safe to read over
someone's shoulder or paste into an issue.

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

## Options

| Flag | Purpose |
| --- | --- |
| `--soul <file>` | Run as the agent defined by a soul file (also `STRATUS_SOUL` / config `soul` key) |
| `--provider` | `anthropic`, `openai`, or `demo` (offline, no account) |
| `--model` | Model for real providers (anthropic default: `claude-opus-5`) |
| `--base-url` | Override the provider API base URL |
| `--config <file>` | Load settings from a specific config file |
| `--approvals` | Tool approval mode: `always`, `ask`, or `never` |
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
