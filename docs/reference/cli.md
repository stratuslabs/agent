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
stratus service status                 # asks the service manager; exits non-zero when not running
stratus service start
stratus service stop
stratus service uninstall
stratus logs -f                        # what the daemon has been doing
stratus logs --agent ava -n 200
stratus doctor                         # what a run would use right now, and why
stratus update                         # the whole upgrade dance, in the safe order
stratus update --check                 # report what an update would do, do nothing
stratus agent new                      # create an agent (guided on a terminal)
stratus agent new --name Ava --instructions "You research things." --format soul > ava.md
stratus agents                         # who's on the team (also: stratus agent list)
stratus skill add owner/repo           # install skills from GitHub or a local path
stratus skill add owner/repo --skill hn-search --agent ava
stratus skill validate ./my-skill      # check a skill (or a repo of them, or an installed id) against the Agent Skills spec
stratus skills                         # what is installed, who enables it (also: stratus skill list)
stratus skill reload                   # a running daemon re-reads ~/.stratus/skills — no restart
stratus restart                        # announced restart: refuse, drain, come back — what a plugin change needs
printf %s "$KEY" | stratus credential set search.apiKey   # store a named credential (value from stdin, never a flag)
stratus credential set search.apiKey --agent ava         # one agent's own key, over the shared one
stratus credentials                    # stored names, never values (also: stratus credential list)
stratus credential remove search.apiKey
stratus schedules                      # what the fleet has scheduled (also: stratus schedule list)
stratus schedules cancel <id>          # stop the next firing, revoke its destination
stratus memory list ava                # every live fact, with the trust label it carries
stratus memory list ava --trust unknown --format json
stratus memory reassert ava --trust user --all-unknown   # re-label every fact with no recorded origin
stratus memory reassert ava --trust agent <id>...
stratus session rollover <session-id>  # archive a conversation's transcript and start the same id over
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
| `skill add`, `skill validate`, `skills`, `skill reload` | [Skills](../guides/skills.md), [Skill format](./skill-format.md) |
| `credential set`, `credentials`, `credential remove` | [Tools](../guides/tools.md#searching-the-web), [Security](../concepts/security.md) |
| `restart` | [Always on](../guides/always-on.md#stratus-restart-announced-drained-and-back) |
| `schedules …` | [Schedules](../guides/schedules.md) |
| `memory list`, `memory reassert` | [Memory](../concepts/memory.md#where-a-fact-came-from) |
| `session rollover` | [Memory](../concepts/memory.md#the-label-is-yours-to-raise-and-only-yours), [Control API](../../packages/control-api/README.md) |
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
| `--format` | `text` or `json`; `agent new` also accepts `soul` — a ready-to-edit soul file |
| `--name` | `agent new`: the agent's name (omit to have one generated) |
| `--instructions` | `agent new`: the agent's persona/instructions |
| `--idle-timeout` | `stratus serve`: seconds of provider silence before the watchdog aborts a turn (default 120) |
| `--no-events` | Hide the event log |
| `--no-log-file` | `stratus serve`: do not write `~/.stratus/logs/stratusd.jsonl` |
| `--no-api` | `stratus serve`: do not serve the control API |
| `--api` | `stratus serve`: serve it even where the config says `api.enabled: false` (what `stratus dashboard` asks of the daemon it starts) |
| `--api-host` | `stratus serve`: control API interface (default `127.0.0.1`) |
| `--api-port` | `stratus serve`: control API port (default `4123`; `0` picks any free port). A port the daemon cannot bind stops it — it does not serve without the API |
| `--gateway <url>` | `stratus agents`, `skill reload`, `restart`, `session rollover`: a running daemon's control API (all but `agents` default to the daemon `~/.stratus/gateway.json` names) |
| `--trust <level>` | `stratus memory list`: show only entries at this label. `stratus memory reassert`: the label to record — `user`, `agent`, `unknown`, or `external` |
| `--all-unknown` | `stratus memory reassert`: every live entry with no recorded origin, the upgrade case; ids may be given as well |
| `--port`, `--host` | `stratus dashboard`: where a daemon it starts should bind |
| `--no-open` | `stratus dashboard`: skip automatic browser opening |
| `--token` | Bearer token for `--gateway` (default: `~/.stratus/gateway-token`, or `STRATUS_GATEWAY_TOKEN`) |
| `--no-login` | `stratus service install`: install without the start-at-login trigger |
| `-f`, `--follow` | `stratus logs`: follow the log, across rotations |
| `-n <count>` | `stratus logs`: how much backlog to print (default 50) |
| `--agent` | `stratus logs`: show only one agent's records. `skill add`: also enable the installed skills in that agent's soul. `credential set` / `credential remove`: that agent's own entry rather than the fleet's shared one |
| `--session` | `stratus logs`: show only one session's records |
| `--skill <id>` | `stratus skill add`: pick one skill from a multi-skill repo (repeatable) |
| `--force` | `stratus skill add`: replace an already-installed skill id |
| `--no-reload` | `stratus skill add`: install without telling a running daemon to reload |
| `--reason` | `stratus restart`: why, for the daemon's log |
| `--drain-timeout <seconds>` | `stratus restart`: how long in-flight turns get to finish before they are aborted (default 30) |
| `--help`, `-h` | Show help |

`stratus credential set` takes the value on **stdin and never in a flag** —
a secret in argv is a secret in your shell history and in every `ps` on the
machine. Nothing prints a stored value back: `stratus credentials` reports
names and which agents have their own.

It strips **one trailing newline and nothing else**, so `echo "$KEY" |` and
`printf %s "$KEY" |` both store the same key, and a key whose own value
begins or ends with a space is stored as it is rather than quietly altered.

Tool plugins have no flags: what is installed is a config decision
(`plugins` in a trusted config) and what an agent may call is a soul
decision (`tools:`). Neither is something a single run should be able to
widen from the command line.

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file —
spelled out in [Configuration](./config.md).
