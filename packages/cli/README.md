# @stratusagent/cli

**Always-on agents that get smarter over time.** Set up Stratus Agent on
your machine, create agents with real identities, connect AI providers, and
put them in Slack — from one command.

<!-- Pinned to the commit that added the asset so it renders on any ref
     (including this branch pre-merge) and on npm, which needs an absolute
     URL. Replacing the banner means updating this pin. -->
![Stratus Labs](https://raw.githubusercontent.com/stratuslabs/agent/265bc175e60fd901b339095215439505606755bc/docs/assets/stratus-banner.png)

## Install

```bash
npm install -g @stratusagent/cli
stratus setup
```

That one package is everything you need to run agents: the runtime, the
providers, the agent roster, and the always-on gateway all come with it.
Needs **Node.js 22.13+** (23.x line: 23.4+) — the CLI checks at startup and
says so plainly if yours is too old. Details:
[Installation](https://github.com/stratuslabs/agent/blob/main/docs/start/installation.md).

`stratus setup` is the whole onboarding, as one small menu: sign in (Claude
Pro/Max subscription or API key, ChatGPT/Codex, or any OpenAI-compatible
service), pick default and fallback models, create your first agent,
connect Slack, and
install the always-on service — no config files to edit, no env vars to
export. Walkthrough:
[Setup](https://github.com/stratuslabs/agent/blob/main/docs/start/setup.md).

## Commands

```bash
stratus setup                          # onboarding menu: providers, models, agent, channels
stratus chat                           # talk — the conversation persists
stratus run "say hello"                # one-shot run (works offline on the demo provider)
stratus serve                          # stratusd: the whole roster, always on
stratus serve --approvals remote       # ask a human in Slack instead of refusing
stratus service install                # keep stratusd running under launchd/systemd
stratus logs -f                        # what the daemon has been doing
stratus doctor                         # what a run would use right now, and why
stratus update                         # stop → upgrade → migrate → repair unit → restart
stratus agent new                      # create an agent (guided on a terminal)
stratus agents                         # who's on the team: souls, models, memory
stratus skill add owner/repo           # install skills from GitHub (Agent Skills format, validated)
stratus skill validate ./my-skill      # check a skill against the spec without installing it
stratus schedules                      # what the fleet has scheduled, and where it reports
stratus dashboard                      # web dashboard, signed in via a one-time link
```

Full reference with every subcommand:
[CLI reference](https://github.com/stratuslabs/agent/blob/main/docs/reference/cli.md).

## Options

| Flag | Purpose |
| --- | --- |
| `--soul <file>` | Run as the agent defined by a soul file (also `STRATUS_SOUL` / config `soul` key) |
| `--provider` | `anthropic`, `openai`, `codex`, or `demo` (offline, no account) |
| `--model` | Model for real providers (anthropic default: `claude-opus-5`, codex default: `gpt-5.5`) |
| `--base-url` | Override the provider API base URL |
| `--config <file>` | Load settings from a specific config file |
| `--approvals` | `run`/`chat`: `always`, `ask`, or `never`. `serve`: `headless` (refuse gated calls) or `remote` (ask in Slack) |
| `--max-turns` | Max provider turns per run (default 8) |
| `--format` | `text` or `json` |
| `--idle-timeout` | `serve`: seconds of provider silence before the watchdog aborts a turn (default 120) |
| `--no-events` | Hide the event log |
| `--no-log-file` | `serve`: do not write `~/.stratus/logs/stratusd.jsonl` |
| `--no-api` | `serve`: do not serve the control API |
| `--api-host`, `--api-port` | `serve`: control API bind (default `127.0.0.1:4123`) |
| `--gateway <url>`, `--token` | `agents`: read the roster from a running daemon's control API |
| `--port`, `--host`, `--no-open` | `dashboard`: where a daemon it starts should bind; skip opening the browser |
| `--no-login` | `service install`: install without the start-at-login trigger |
| `-f`, `-n`, `--agent`, `--session` | `logs`: follow, backlog size, and filters |

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file.
Project-local `stratus.config.json` outranks the global
`~/.stratus/config.json`; stored sign-ins are endpoint-bound and never sent
to endpoints a project config selects. Details:
[Configuration](https://github.com/stratuslabs/agent/blob/main/docs/reference/config.md).

## Optional packages

Out of the box an agent can already echo, remember, recall, delegate, and
(in the daemon) schedule. Everything beyond that — a transport, real-world
tools, an open port — is a separate package you add only when you want it,
and `stratus setup` offers the ones your answers imply:

```bash
npm install -g @stratusagent/channel-slack                        # agents in Slack
npm install -g @stratusagent/tool-fs @stratusagent/tool-shell \
               @stratusagent/tool-web @stratusagent/tool-browser  # real capability
npm install -g @stratusagent/plugin-mcp                           # mount MCP servers
npm install -g @stratusagent/control-api @stratusagent/dashboard  # HTTP API + web UI
```

A tool or MCP plugin runs nothing by being installed — a config you chose
enables it, then each agent's soul allowlists its tools. The two surfaces
switch on differently, on purpose: the Slack channel connects when an
agent's stored tokens say so, and installing the control API is itself the
decision to open an authenticated local port (`--no-api` takes it back).
The reasoning:
[the plugin trust model](https://github.com/stratuslabs/agent/blob/main/docs/concepts/plugins.md).

## Learn more

| I want to… | Read |
| --- | --- |
| Put my agents in Slack | [Slack](https://github.com/stratuslabs/agent/blob/main/docs/guides/slack.md) |
| Give agents files, a shell, the web, a browser | [Tools](https://github.com/stratuslabs/agent/blob/main/docs/guides/tools.md) |
| Decide what runs unattended, approve the rest from Slack | [Approvals](https://github.com/stratuslabs/agent/blob/main/docs/guides/approvals.md) |
| Let agents act on their own schedule | [Schedules](https://github.com/stratuslabs/agent/blob/main/docs/guides/schedules.md) |
| Teach an agent a procedure | [Skills](https://github.com/stratuslabs/agent/blob/main/docs/guides/skills.md) |
| Run it as a service, read its logs, upgrade it | [Always on](https://github.com/stratuslabs/agent/blob/main/docs/guides/always-on.md) · [Logs](https://github.com/stratuslabs/agent/blob/main/docs/guides/logs.md) · [Updating](https://github.com/stratuslabs/agent/blob/main/docs/guides/updating.md) |
| Understand souls, ids, and memory | [Agents](https://github.com/stratuslabs/agent/blob/main/docs/concepts/agents.md) · [Memory](https://github.com/stratuslabs/agent/blob/main/docs/concepts/memory.md) |
| Fix a surprise | [Troubleshooting](https://github.com/stratuslabs/agent/blob/main/docs/guides/troubleshooting.md) |

The full index: [docs](https://github.com/stratuslabs/agent/blob/main/docs/README.md).

Part of [Stratus Agent](https://github.com/stratuslabs/agent) — a tiny
TypeScript agent runtime, MIT licensed.
