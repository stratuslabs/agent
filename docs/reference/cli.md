# CLI reference

Every command, then every flag. `stratus --help` prints the same surface;
each command's behavior is documented in depth in the guide the table
links to.

## Commands

```bash
stratus setup                          # onboarding menu: providers, models, agent, channels
stratus chat                           # talk — the conversation persists
stratus chat --soul ./ava.md
stratus run "say hello"
stratus run --soul ./ava.md "introduce yourself"
stratus run --provider anthropic --model claude-opus-5 "hello"
stratus run --provider codex "say hello"
stratus run --prompt "use the echo tool" --format json
stratus serve                          # stratusd: the whole roster, always on
stratus serve --idle-timeout 120 --no-events
stratus serve --approvals remote       # ask a human in Slack instead of refusing
stratus service install                # keep stratusd running under launchd/systemd
stratus service status
stratus logs -f                        # what the daemon has been doing
stratus logs --agent ava -n 200
stratus doctor                         # what a run would use right now, and why
stratus update                         # the whole upgrade dance, in the safe order
stratus update --check                 # report what an update would do, do nothing
stratus agent new                      # create an agent (guided on a terminal)
stratus agent new --format soul > ava.md
stratus agents                         # who's on the team: souls, models, memory
stratus skill add owner/repo           # install skills from GitHub or a local path
stratus skills                         # what is installed, and who enables it
stratus schedules                      # what the fleet has scheduled, and where it reports
stratus schedules cancel <id>          # stop the next firing, revoke its destination
stratus dashboard                      # local browser dashboard
```

| Command | Covered in |
| --- | --- |
| `setup` | [Setup](../start/setup.md) |
| `chat`, `run` | [Quickstart](../start/quickstart.md) |
| `serve` | [Always on](../guides/always-on.md), [Approvals](../guides/approvals.md) |
| `service …` | [Always on](../guides/always-on.md) |
| `logs` | [Logs](../guides/logs.md) |
| `doctor` | [Troubleshooting](../guides/troubleshooting.md) |
| `update` | [Updating](../guides/updating.md) |
| `agent new`, `agents` | [Agents](../concepts/agents.md) |
| `skill add`, `skills` | [Skills](../guides/skills.md) |
| `schedules …` | [Schedules](../guides/schedules.md) |
| `dashboard` | [Remote access](../guides/remote-access.md) |

## Options

| Flag | Purpose |
| --- | --- |
| `--prompt`, `-p` | Pass the prompt explicitly |
| `--stdin` | Read the prompt from stdin |
| `--soul <file>` | Run as the agent defined by a soul file (also `STRATUS_SOUL` / config `soul` key) |
| `--provider` | `anthropic`, `openai`, `codex`, or `demo` (offline, no account) |
| `--model` | Model for real providers (anthropic default: `claude-opus-5`, codex default: `gpt-5.5`) |
| `--base-url` | Override the provider API base URL |
| `--config <file>` | Load settings from a specific config file |
| `--approvals` | `run`/`chat`: tool approval mode — `always`, `ask`, or `never`. `serve`: how the daemon reaches a human — `headless` (refuse gated calls) or `remote` (ask in Slack); overrides the config's `approvals.mode` |
| `--max-turns` | Max provider turns per run (default 8) |
| `--format` | `text` or `json` |
| `--idle-timeout` | `stratus serve`: seconds of provider silence before the watchdog aborts a turn (default 120) |
| `--no-events` | Hide the event log |
| `--no-log-file` | `stratus serve`: do not write `~/.stratus/logs/stratusd.jsonl` |
| `--no-api` | `stratus serve`: do not serve the control API |
| `--api-host` | `stratus serve`: control API interface (default `127.0.0.1`) |
| `--api-port` | `stratus serve`: control API port (default `4123`; `0` picks any free port) |
| `--gateway <url>` | `stratus agents`: read the roster from a running daemon's control API |
| `--port`, `--host` | `stratus dashboard`: where a daemon it starts should bind |
| `--no-open` | `stratus dashboard`: skip automatic browser opening |
| `--token` | Bearer token for `--gateway` (default: `~/.stratus/gateway-token`, or `STRATUS_GATEWAY_TOKEN`) |
| `--no-login` | `stratus service install`: install without the start-at-login trigger |
| `-f`, `--follow` | `stratus logs`: follow the log, across rotations |
| `-n <count>` | `stratus logs`: how much backlog to print (default 50) |
| `--agent`, `--session` | `stratus logs`: show only one agent's or one session's records |
| `--force` | `stratus skill add`: replace an already-installed skill id |
| `--help`, `-h` | Show help |

Tool plugins have no flags: what is installed is a config decision
(`plugins` in a trusted config) and what an agent may call is a soul
decision (`tools:`). Neither is something a single run should be able to
widen from the command line.

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file —
spelled out in [Configuration](./config.md).
