# CLI reference

Every command, then every flag. `stratus --help` prints the same surface;
each command's behavior is documented in depth in the guide the table
links to.

## Commands

```bash
stratus setup                          # onboarding menu: providers, models, agent, plugins, channels, approvals
stratus chat                           # talk — the conversation persists
stratus chat --soul ./blair.md
stratus run "say hello"
stratus run --soul ./blair.md "introduce yourself"
stratus run --provider anthropic --model claude-opus-5 "hello"
stratus run --provider codex "say hello"
stratus run --prompt "use the echo tool" --format json
stratus serve                          # stratusd: the whole roster, always on; exits 78 on a config it cannot load
stratus serve --idle-timeout 120 --no-events
stratus serve --approvals remote       # ask a human in Slack instead of refusing
stratus serve --log-format json        # the log's records as JSON lines on stdout, for docker logs / journald
stratus service install                # keep stratusd running under launchd/systemd
stratus service status                 # asks the service manager; exits non-zero when not running
stratus service start
stratus service stop
stratus service uninstall
stratus logs -f                        # what the daemon has been doing
stratus logs --agent blair -n 200
stratus doctor                         # what a run would use right now, and why
stratus update                         # the whole upgrade dance, in the safe order — the CLI and its companions
stratus update --check                 # report what an update would do, do nothing
stratus --version                      # which build this is (also: stratus version, stratus -v)
stratus agent new                      # create an agent (guided on a terminal)
stratus agent new --name Blair --instructions "You research things." --format soul > blair.md
stratus agents                         # who's on the team (also: stratus agent list)
stratus template add ./my-template     # install an agent, its skills, and the plugins behind them
stratus template add owner/repo --yes  # …from GitHub, without the review prompt
stratus skill add owner/repo           # install skills from GitHub or a local path
stratus skill add owner/repo --skill hn-search --agent blair
stratus skill validate ./my-skill      # check a skill (or a repo of them, or an installed id) against the Agent Skills spec
stratus skills                         # the built-in skill, then what is installed and who enables it (also: stratus skill list)
stratus skill reload                   # a running daemon re-reads ~/.stratus/skills — no restart
stratus plugins                        # installed → enabled → granted → what approvals does with it (also: stratus plugin list)
stratus plugins --format json          # the same chain as data
stratus restart                        # announced restart: refuse, drain, come back — what a plugin change needs
stratus health                         # is the running daemon serving? one line, exit 0/1 — for health checks
stratus health --format json           # the daemon's /health answer as data
printf %s "$KEY" | stratus credential set search.apiKey   # store a named credential (value from stdin, never a flag)
stratus credential set search.apiKey --agent blair       # one agent's own key, over the shared one
stratus credentials                    # stored names, never values (also: stratus credential list)
stratus credential remove search.apiKey
stratus channel set imessage --agent blair apiKey apiSecret  # a channel plugin's secrets for one agent (asked without echo, or one per stdin line)
stratus channel set slack --agent blair                      # Slack's appToken and botToken
stratus channels                       # which agents have secrets for which channel, names only (also: stratus channel list)
stratus channel remove imessage --agent blair
stratus schedules                      # what the fleet has scheduled (also: stratus schedule list)
stratus schedules cancel <id>          # stop the next firing, revoke its destination
stratus grants blair                   # what blair may do unattended: standing tool grants, command scopes, sites
stratus grants revoke blair --tool web.fetch            # take a standing grant back — a running daemon stops honouring it at once
stratus grants revoke blair --scope "git push"          # or a command scope, by the line the listing shows
stratus grants revoke blair --origin https://app.example.com
stratus memory list blair              # every live fact, with its trust label, pin, and validity
stratus memory list blair --trust unknown --format json
stratus memory search blair deploy pipeline             # the way the agent searches: words, and what a fact is about
stratus memory audit blair             # everything ever written, forgotten included, and what replaced what
stratus memory pin blair <id>...       # keep facts in the prompt every turn (and memory unpin)
stratus memory forget blair <id>...    # retire facts; they stay in the record
stratus memory export blair --file blair.jsonl          # move an agent's memory to another machine
stratus memory import blair --file blair.jsonl          # lands external unless --preserve-trust
stratus memory reassert blair --trust user --all-unknown  # re-label every fact with no recorded origin
stratus memory reassert blair --trust agent <id>...
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
| `template add` | [Templates](../guides/templates.md) |
| `skill add`, `skill validate`, `skills`, `skill reload` | [Skills](../guides/skills.md), [Skill format](./skill-format.md) |
| `credential set`, `credentials`, `credential remove` | [Tools](../guides/tools.md#searching-the-web), [Security](../concepts/security.md) |
| `channel set`, `channels`, `channel remove` | [Extending](../guides/extending.md#channels), [Slack](../guides/slack.md) |
| `restart` | [Always on](../guides/always-on.md#stratus-restart-announced-drained-and-back) |
| `health` | [Deployment](../guides/deployment.md#health-checks) |
| `schedules …` | [Schedules](../guides/schedules.md) |
| `grants`, `grants revoke` | [Approvals](../guides/approvals.md#standing-grants) |
| `memory list`, `memory search`, `memory audit`, `memory forget` | [Memory](../concepts/memory.md#searching-it-yourself) — every `memory` subcommand works the built-in store, and refuses against a fleet whose config selects another |
| `memory pin`, `memory unpin` | [Memory](../concepts/memory.md#pinned-facts) |
| `memory export`, `memory import` | [Memory](../concepts/memory.md#moving-an-agents-memory) |
| `memory reassert` | [Memory](../concepts/memory.md#where-a-fact-came-from) |
| `session rollover` | [Memory](../concepts/memory.md#the-label-is-yours-to-raise-and-only-yours), [Control API](../../packages/control-api/README.md) |
| `dashboard` | [Remote access](../guides/remote-access.md) |

## Options

| Flag | Purpose |
| --- | --- |
| `--prompt`, `-p` | Pass the prompt explicitly |
| `--stdin` | Read the prompt from stdin |
| `--soul <file>` | Run as the agent defined by a soul file (also `STRATUS_SOUL` / config `soul` key) |
| `--provider` | `anthropic`, `openai`, `codex`, `demo` (offline, no account), or the name a [plugin provider](../guides/extending.md#providers) registers |
| `--model` | Model for real providers (anthropic default: `claude-opus-5`, codex default: `gpt-5.5`) |
| `--base-url` | Override the provider API base URL |
| `--config <file>` | Load settings from a specific config file |
| `--approvals` | `run`/`chat`: tool approval mode — `always`, `ask` (a y/N on every call), `gated` (`safe` tools run, the rest ask), or `never`. Default: `gated` at a terminal; `always` when stdin is not one (a pipe, a script, `--stdin`), said once on stderr the first time a gated tool runs. `serve`: how the daemon reaches a human — `headless` (refuse gated calls) or `remote` (ask in Slack); overrides the config's `approvals.mode` |
| `--max-turns` | Max tool turns per run before it wraps up with a summary (default 40). `stratus serve` has no flag for it — the daemon reads [`maxTurns`](./config.md#how-many-turns-one-message-may-spend) from a trusted config |
| `--format` | `text` or `json`; `agent new` also accepts `soul` — a ready-to-edit soul file |
| `--name` | `agent new`: the agent's name (omit to have one generated) |
| `--instructions` | `agent new`: the agent's persona/instructions |
| `--idle-timeout` | `stratus serve`: seconds of provider silence before the watchdog aborts a turn (default 120) |
| `--no-events` | Hide the event log |
| `--no-log-file` | `stratus serve`: do not write `~/.stratus/logs/stratusd.jsonl` |
| `--log-format` | `stratus serve`: `text` (default) — human lines on stdout — or `json`: every record written to the log file, also written to stdout as one JSON line, and nothing else there. For `docker logs`, journald, and log shippers; see [Logs](../guides/logs.md#logs-on-stdout-for-a-container-or-journald) |
| `--no-api` | `stratus serve`: do not serve the control API |
| `--api` | `stratus serve`: serve it even where the config says `api.enabled: false` (what `stratus dashboard` asks of the daemon it starts) |
| `--api-host` | `stratus serve`: control API interface (default `127.0.0.1`) |
| `--api-port` | `stratus serve`: control API port (default `4123`; `0` picks any free port). A port the daemon cannot bind stops it — it does not serve without the API |
| `--gateway <url>` | `stratus agents`, `skill reload`, `restart`, `session rollover`, `grants`, `health`: a running daemon's control API (all but `agents` default to the daemon `~/.stratus/gateway.json` names; `grants` reads the files instead when none is serving) |
| `--tool`, `--scope`, `--origin` | `stratus grants revoke`: which grant goes — exactly one of them |
| `--trust <level>` | `stratus memory list`: show only entries at this label. `stratus memory reassert`: the label to record — `user`, `agent`, `unknown`, or `external` |
| `--all-unknown` | `stratus memory reassert`: every live entry with no recorded origin, the upgrade case; ids may be given as well |
| `--limit <n>` | `stratus memory search`: maximum hits. The store bounds the read either way |
| `--file <path>` | `stratus memory export` (omit for stdout) / `stratus memory import`: the JSONL |
| `--preserve-trust` | `stratus memory import`: keep each entry's recorded trust label instead of landing it `external`. For a file you own and vouch for |
| `--port`, `--host` | `stratus dashboard`: where a daemon it starts should bind |
| `--no-open` | `stratus dashboard`: skip automatic browser opening |
| `--version`, `-v` | Print this build's version and exit — reads nothing but itself, so it answers offline and before any state migration |
| `--token` | Bearer token for `--gateway` (default: `~/.stratus/gateway-token`, or `STRATUS_GATEWAY_TOKEN`) |
| `--no-login` | `stratus service install`: install without the start-at-login trigger |
| `-f`, `--follow` | `stratus logs`: follow the log, across rotations |
| `-n <count>` | `stratus logs`: how much backlog to print (default 50) |
| `--agent` | `stratus logs`: show only one agent's records. `skill add`: also enable the installed skills in that agent's soul. `credential set` / `credential remove`: that agent's own entry rather than the fleet's shared one. `channel set` / `channel remove`: the agent whose binding it is (required) |
| `--session` | `stratus logs`: show only one session's records |
| `--skill <id>` | `stratus skill add`: pick one skill from a multi-skill repo (repeatable) |
| `--force` | `stratus skill add`: replace an already-installed skill id. `stratus template add`: replace an agent or skill already installed under the same name |
| `--no-reload` | `stratus skill add`: install without telling a running daemon to reload |
| `--yes`, `-y` | `stratus template add`: install without the review prompt |
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

`stratus channel set <kind> --agent <id> <name>...` names the secrets on
the command line and never their values. At a terminal it asks for each
without echoing it; otherwise it reads **one value per line from stdin**,
in the order named, keeping each exactly as typed:

```bash
printf '%s\n%s\n' "$API_KEY" "$API_SECRET" | stratus channel set imessage --agent blair apiKey apiSecret
```

It replaces whatever that agent had stored on that channel, refuses an
agent the roster does not have (the channel would skip it), and is read by
a running daemon at its next start. Slack's names are `appToken` and
`botToken`, the default when none are given.

Tool plugins have no flags: what is installed is a config decision
(`plugins` in a trusted config) and what an agent may call is a soul
decision (`tools:`). Neither is something a single run should be able to
widen from the command line.

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file —
spelled out in [Configuration](./config.md).
