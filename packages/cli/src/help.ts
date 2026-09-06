import { DEFAULT_ANTHROPIC_MODEL } from '@stratusagent/provider-anthropic';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/provider-codex';

export const HELP_TEXT = `Stratus Agent CLI

Usage:
  stratus setup
  stratus chat
  stratus chat --soul ./examples/souls/ava.md
  stratus run --prompt "Use the demo tool"
  stratus run "Say hello"
  ANTHROPIC_API_KEY=... stratus run --provider anthropic "Say hello"
  stratus run --soul ./examples/souls/ava.md "Say hello"
  echo "Use the echo tool" | stratus run --stdin
  STRATUS_PROVIDER=openai OPENAI_API_KEY=... stratus run "Say hello"
  stratus run --config ./stratus.config.json --provider openai "Say hello"
  stratus agents
  stratus agents --gateway http://127.0.0.1:4123
  stratus skill add stratuslabs/skill-code-review
  stratus skill add ./my-skills --skill code-review --agent ava
  stratus skill validate ./my-skill
  stratus skills
  stratus skill reload
  stratus restart
  stratus schedules
  stratus schedules cancel <id>
  stratus memory list ava
  stratus memory reassert ava --trust user --all-unknown
  stratus session rollover slack:ava:T01ABCDEF:D07GHIJKL
  printf %s "$BRAVE_KEY" | stratus credential set search.apiKey
  stratus credentials
  stratus doctor
  stratus update
  stratus update --check
  stratus service install
  stratus service status
  stratus logs -f
  stratus logs --agent ava -n 200
  stratus dashboard
  stratus dashboard --port 4123 --host 0.0.0.0 --no-open

Commands:
  setup            Menu-driven onboarding: pick a provider, sign in (Claude
                   subscription or API key), create your agent, connect it to
                   Slack, and test it — settings go to ~/.stratus/config.json,
                   sign-ins and channel tokens to ~/.stratus/credentials.json
                   (0600). Save & finish offers to install any optional
                   package your answers imply (the Slack channel, the control
                   API and dashboard) before it starts the daemon
  chat             Talk with your agent — the conversation persists across turns
                   and remembered facts accumulate; /exit or Ctrl+C to leave
  run              Execute one local Stratus Agent session
  serve            Run stratusd, the always-on gateway: durable sessions, the
                   whole roster live at once (each agent on its own provider),
                   delegation, and a watchdog — one per home (it refuses to
                   start over a daemon already serving ~/.stratus), and
                   Ctrl+C / SIGTERM drains cleanly
                   (--idle-timeout <seconds>, --approvals <headless|remote>,
                   --no-events, --no-log-file, --config <path>); everything it
                   says is also written to ~/.stratus/logs, which
                   "stratus logs" reads. With @stratusagent/control-api
                   installed it also serves the HTTP + WebSocket control API
                   on 127.0.0.1:4123 (--no-api, --api-host, --api-port, or
                   the config file's "api" block)
  service          Keep stratusd running under launchd (macOS) or systemd
                   (Linux): install, uninstall, status, start, stop.
                   Installing starts it now and at every login
                   (--no-login installs without the login trigger,
                   --config <path> pins the daemon to one config file)
  logs             Read the daemon's log from any terminal: -f to follow,
                   -n <count> for backlog, --agent / --session to filter,
                   --format json for the raw records
  skill add        Install skills from a GitHub repo (owner/repo or URL) or a
                   local path into ~/.stratus/skills — whole directories, one
                   per skill; works with skills published for other agents
                   (skills.sh-style repos). Installed is not enabled: a soul
                   opts in via skills:, or pass --agent <id> to enable now.
                   --skill <id> picks from a multi-skill repo (repeatable),
                   --force replaces an already-installed id. A skill that
                   does not conform to the Agent Skills spec is refused,
                   naming what is wrong; one that installs with caveats
                   (fields another host owns, a bundled scripts/) says so.
                   A running daemon reloads its skills afterwards, no
                   restart (--no-reload skips that)
  skill validate   Check a skill directory, a directory of skills, or an
                   installed skill id against the Agent Skills spec — the
                   same check "skill add" runs, so what validates installs.
                   Exit 1 if anything would be refused
  skills           List installed skills and which agents enable each
                   (also: stratus skill list)
  skill reload     Ask the running daemon to re-read ~/.stratus/skills — for a
                   skill edited or removed by hand. A skill that will not
                   load refuses the whole reload and the previous set keeps
                   serving; nothing becomes reachable to an agent whose soul
                   does not list it
  restart          Ask the running daemon for an announced restart — what a
                   plugin change needs: it refuses new turns, lets in-flight
                   ones finish for up to --drain-timeout <seconds> (default
                   30), then comes back with sessions, schedules, and
                   channels intact, under the service manager or not
  credential set   Store a named credential an agent can resolve — a search
                   backend asks for search.apiKey. The value is read from
                   stdin, never from a flag, so it stays out of your shell
                   history: printf %s "$KEY" | stratus credential set
                   search.apiKey. --agent <id> stores one agent's own key,
                   which outranks the shared entry for that agent. Storing
                   grants nothing: the soul still needs credentials: [name]
  credentials      List stored credential names and which agents have their
                   own — names only, never values (also: credential list)
  credential remove
                   Forget one (--agent <id> for that agent's own entry)
  schedules        List every schedule the fleet has set — cadence, prompt,
                   pre-authorized destination, next firing — straight from the
                   daemon's database (--format json). "stratus schedules
                   cancel <id>" stops the next firing and revokes the
                   destination that was approved with it
                   (also: stratus schedule list / schedule cancel <id>)
  memory list      Show an agent's live memory with the trust label each
                   entry carries — user, agent, unknown (no recorded origin,
                   or written in a conversation with someone not configured
                   as a principal), external (recorded after reading content
                   from outside). --trust <level> filters; --format json
  memory reassert  Re-label entries as an operator: stratus memory reassert
                   <agent> --trust user <id>..., or --all-unknown for every
                   entry with no recorded origin (the upgrade case; an
                   entry recorded unknown — a stranger's message, a shell
                   command — is left for you to name by id). Appends
                   a record to ~/.stratus/memory.jsonl; a running daemon
                   sees it on its next turn. The only way a label ever
                   rises — no tool can do this
  session rollover Start a conversation over under the same session id,
                   archiving its transcript so far — for a long-lived
                   session (a Slack DM) that predates provenance tracking
                   and would otherwise write unknown forever. Asks the
                   running daemon (--gateway, --token)
  agent new        Create an agent identity (generates a human-ish name + avatar theme)
  agents           List your agents: who they are, where their souls live, what
                   they run on, what they remember (also: stratus agent list).
                   --gateway <url> asks a running daemon instead of resolving
                   locally, authenticating with ~/.stratus/gateway-token
                   (override with --token or STRATUS_GATEWAY_TOKEN)
  doctor           Show what a run would use right now — provider, model, soul —
                   and which file or environment variable decided each, then
                   flag anything that would surprise you (--format json)
  update           The whole upgrade dance, in the order that cannot lose
                   data: stop stratusd, upgrade the package from npm, run
                   pending state migrations, rewrite the service unit with
                   current node/entrypoint paths, restart. --check reports
                   what it would do without doing any of it (exits 1 when
                   something is actionable). Works offline too — an
                   unreachable npm skips the upgrade but still migrates and
                   repairs the unit
  dashboard        Open the web dashboard: finds a running daemon (or starts one),
                   mints a single-use sign-in link, and opens your browser at it.
                   Needs @stratusagent/control-api and @stratusagent/dashboard
  help             Show this help message

Agent options:
  --name           Agent name (omit to have one generated)
  --instructions   The agent's persona/instructions
  --format         Output format for agent new: text, json, or soul (a ready-to-edit soul file)

Options:
  --prompt, -p     Prompt to send to the local agent loop
  --stdin          Read the prompt from stdin
  --provider       Provider to use: anthropic, openai, codex, or demo
  --model          Model name for real providers (anthropic default: ${DEFAULT_ANTHROPIC_MODEL}, openai default: gpt-4.1-mini, codex default: ${DEFAULT_CODEX_MODEL})
  --base-url       Override the provider API base URL
  --soul           Run as the agent defined by a soul file (markdown + frontmatter, see examples/souls)
  --config         Config file path (run: load settings from it, setup: write it)
  --format         Output format: text or json (default: text)
  --no-events      Hide event-by-event progress lines in text mode
  --approvals      run/chat: tool approval mode — always, ask, or never (default: always)
                   serve: how the daemon reaches a human — headless (refuse every
                   gated call) or remote (ask in Slack). Default headless, or
                   the config file's "approvals.mode"
  --max-turns      Maximum provider turns per run (default: 8)
  --port           dashboard: port for a daemon it starts (default: 4123)
  --host           dashboard: host for a daemon it starts (default: 127.0.0.1)
  --no-open        Do not open the browser automatically
  --gateway        agents / skill reload / restart / session rollover: a running
                   daemon's control API (all but agents default to the daemon
                   ~/.stratus/gateway.json names)
  --trust          memory list: show only this label; memory reassert: the
                   label to record (user, agent, unknown, external)
  --all-unknown    memory reassert: every live entry with no recorded origin
  --token          Bearer token for --gateway (default: ~/.stratus/gateway-token)
  --no-reload      skill add: install without reloading a running daemon
  --reason         restart: why, for the daemon's log
  --drain-timeout  restart: seconds the daemon lets in-flight turns finish
                   before aborting them (default: 30)
  --no-api         serve: do not serve the control API
  --api            serve: serve it even where the config says api.enabled: false
  --api-host       serve: control API interface (default: 127.0.0.1)
  --api-port       serve: control API port (default: 4123, 0 for any free port)
  --help, -h       Show this help message

Config file:
  The CLI looks for ./stratus.config.json first, then a path from --config / STRATUS_CONFIG,
  then the global ~/.stratus/config.json written by \`stratus setup\`.
  A "soul" key (or STRATUS_SOUL) points at a soul file so every run uses that agent.

Plugins (tools):
  Capability is optional: install a package, then list it under "plugins" in a
  TRUSTED config (--config, STRATUS_CONFIG, or ~/.stratus/config.json), keyed by
  package name. A plugin runs inside this process, so an auto-discovered
  project-local stratus.config.json may not enable one.

    "plugins": {
      "@stratusagent/tool-fs": { "enabled": true, "roots": ["~/notes"],
                                 "agents": { "ava": { "roots": ["~/work/ava"] } } },
      "@stratusagent/tool-web": { "enabled": true }
    }

  Available: @stratusagent/tool-fs (fs.read/list/search/write),
  @stratusagent/tool-shell (shell.run), @stratusagent/tool-web (web.fetch),
  @stratusagent/tool-browser (browser.goto/read/screenshot/act).
  Installing one grants no agent anything — each soul lists what it may call.

Soul files:
  A soul file is markdown with frontmatter (name, provider, model, tools, skills, credentials)
  followed by the agent's persona in prose. See examples/souls/ava.md.
  "tools" takes exact names or a whole toolset: tools: [fs.read, fs.search] or
  tools: [fs.*]. Omitted means every registered tool.
  "skills" is the same allowlist shape over installed skills (see stratus
  skills), except omitted means none — a skill is enabled per agent, never
  by being installed.
`;
