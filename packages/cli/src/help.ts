import { defaultModelFor } from '@stratusagent/state';

/*
 * The help, held as entries rather than one block of text, so `stratus
 * --help` and `stratus <command> --help` come from the same words: the
 * global help renders every entry, and a command's help renders the ones
 * that are about it. Two copies would drift, and the per-command one is
 * the one people read when they are already stuck.
 */

interface HelpEntry {
  /** The left column: a command (`skill add`) or an option (`--prompt, -p`). */
  readonly name: string;
  /** The right column, one line per line, without the column's indent. */
  readonly text: string;
}

interface OptionHelp extends HelpEntry {
  /** The commands, by their name in COMMANDS, whose own help lists this option. */
  readonly for: readonly string[];
}

/** Each example also shows in the help of the command it runs. */
const USAGE: readonly string[] = [
  'stratus setup',
  'stratus chat',
  'stratus chat --soul ./examples/souls/blair.md',
  'stratus run --provider demo --prompt "Use the demo tool"',
  'stratus run "Say hello"',
  'ANTHROPIC_API_KEY=... stratus run --provider anthropic "Say hello"',
  'stratus run --soul ./examples/souls/blair.md "Say hello"',
  'echo "Use the echo tool" | stratus run --provider demo --stdin',
  'STRATUS_PROVIDER=openai OPENAI_API_KEY=... stratus run "Say hello"',
  'stratus run --config ./stratus.config.json --provider openai "Say hello"',
  'stratus agents',
  'stratus agents --gateway http://127.0.0.1:4123',
  'stratus template add ./examples/templates/example',
  'stratus template add stratuslabs/template-oncall --yes',
  'stratus skill add stratuslabs/skill-code-review',
  'stratus skill add ./my-skills --skill code-review --agent blair',
  'stratus skill validate ./my-skill',
  'stratus skills',
  'stratus plugins',
  'stratus plugins --format json',
  'stratus skill reload',
  'stratus restart',
  'stratus health',
  'stratus events',
  'stratus sessions --status failed',
  'stratus schedules',
  'stratus schedules cancel <id>',
  'stratus tasks',
  'stratus tasks cancel <id>',
  'stratus grants blair',
  'stratus grants revoke blair --tool web.fetch',
  'stratus people',
  'stratus people add U0123ABCD --approver',
  'stratus memory list blair',
  'stratus memory search blair deploy pipeline',
  'stratus memory pin blair blair:memory:...',
  'stratus memory export blair --file blair-memory.jsonl',
  'stratus memory reassert blair --trust user --all-unknown',
  'stratus session rollover slack:blair:T01ABCDEF:D07GHIJKL',
  'printf %s "$BRAVE_KEY" | stratus credential set search.apiKey',
  'stratus credentials',
  'stratus signin set anthropic --agent remy',
  'stratus signins',
  'stratus channel set imessage --agent blair apiKey apiSecret',
  'stratus channels',
  'stratus doctor',
  'stratus update',
  'stratus update --check',
  'stratus --version',
  'stratus service install',
  'stratus service status',
  'stratus logs -f',
  'stratus logs --agent blair -n 200',
  'stratus dashboard',
  'stratus dashboard --port 4123 --host 0.0.0.0 --no-open',
];

const COMMANDS: readonly HelpEntry[] = [
  {
    name: 'setup',
    text: `Menu-driven onboarding: pick a provider, sign in (Claude
subscription or API key), create your agent, enable the
plugins it may use, connect it to Slack or a channel a
plugin contributes, choose who
approves gated calls unattended, and test it — settings
go to ~/.stratus/config.json,
sign-ins and channel tokens to ~/.stratus/credentials.json
(0600). Save & finish offers to install any optional
package your answers imply (the Slack channel, the control
API and dashboard) before it starts the daemon`,
  },
  {
    name: 'chat',
    text: `Talk with your agent — the conversation persists across turns
and remembered facts accumulate; /exit or Ctrl+C to leave`,
  },
  {
    name: 'run',
    text: `Execute one local Stratus Agent session`,
  },
  {
    name: 'serve',
    text: `Run stratusd, the always-on gateway: durable sessions, the
whole roster live at once (each agent on its own provider),
delegation, and a watchdog — one per home (it refuses to
start over a daemon already serving ~/.stratus, and exits
78 on a trusted config that will not load), and
Ctrl+C / SIGTERM drains (30s, then aborts)
(--idle-timeout <seconds>, --approvals <headless|remote>,
--no-events, --no-log-file, --config <path>); everything it
says is also written to ~/.stratus/logs, which
"stratus logs" reads (--log-format json puts those same
records on stdout as JSON lines instead of the human
ones, for docker logs and journald). With
@stratusagent/control-api installed it also serves the
HTTP + WebSocket control API on 127.0.0.1:4123 (--no-api,
--api-host, --api-port, or the config file's "api" block)`,
  },
  {
    name: 'service',
    text: `Keep stratusd running under launchd (macOS) or systemd
(Linux): install, uninstall, status, start, stop.
Installing starts it now and at every login
(--no-login installs without the login trigger,
--config <path> pins the daemon to one config file)`,
  },
  {
    name: 'logs',
    text: `Read the daemon's log from any terminal: -f to follow,
-n <count> for backlog, --agent / --session to filter,
--format json for the raw records`,
  },
  {
    name: 'template add',
    text: `Install a template — a folder (or GitHub repo) holding
soul files, skills, and the plugin config they need. Prints
every agent, skill, plugin package and config key it would
add, then asks; --yes installs without asking, --force
replaces an agent or skill already installed under the same
name. Plugin packages the template's config.json names are
installed with npm install -g and enabled in
~/.stratus/config.json, which needs a restart to take
effect. See docs/guides/templates.md for the layout`,
  },
  {
    name: 'skill add',
    text: `Install skills from a GitHub repo (owner/repo or URL) or a
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
restart (--no-reload skips that)`,
  },
  {
    name: 'skill validate',
    text: `Check a skill directory, a directory of skills, or an
installed skill id against the Agent Skills spec — the
same check "skill add" runs, so what validates installs.
Exit 1 if anything would be refused`,
  },
  {
    name: 'skills',
    text: `List installed skills and which agents enable each, after
the built-in stratus skill every agent has
(also: stratus skill list)`,
  },
  {
    name: 'plugins',
    text: `What this machine's plugins are, and where the chain from
installed to callable breaks: whether the package resolves,
whether a trusted config enables it, which agents' tools:
lists select each tool it declares, and what the approval
policy does with a gated call. Read from each package's
manifest, so nothing is imported and no plugin's setup runs
(--format json, --config <path>; also: stratus plugin list)`,
  },
  {
    name: 'skill reload',
    text: `Ask the running daemon to re-read ~/.stratus/skills — for a
skill edited or removed by hand. A skill that will not
load refuses the whole reload and the previous set keeps
serving; nothing becomes reachable to an agent whose soul
does not list it`,
  },
  {
    name: 'restart',
    text: `Ask the running daemon for an announced restart — what a
plugin change needs: it refuses new turns, lets in-flight
ones finish for up to --drain-timeout <seconds> (default
30), then comes back with sessions, schedules, and
channels intact, under the service manager or not`,
  },
  {
    name: 'health',
    text: `Ask the running daemon whether it is serving: exit 0 and
one line (version, uptime, agents, sessions, pending
approvals), or exit 1 and one sentence saying why not.
For a container HEALTHCHECK, a Kubernetes probe, or a
monitoring script (--gateway, --token, --format json)`,
  },
  {
    name: 'events',
    text: `What the running daemon's events port has been doing, per
source: the last delivery, the last refusal and why, the
last 24 hours by status, and requests refused before they
left a row, such as a webhook with the wrong secret
(--gateway, --token, --format json)`,
  },
  {
    name: 'sessions',
    text: `What the running daemon's sessions are doing, newest
first: status, agent, last update, id. A message that ran
out of steps shows as completed (stopped early: turn
limit). --agent <id>, --status <idle|running|
pending_approval|completed|failed|stopped-early>,
--limit <n> (default 20), --format json
(also: stratus session list)`,
  },
  {
    name: 'tasks',
    text: `The running daemon's background tasks: every one running
or not yet in its conversation, newest first, then the 20
most recently finished. Status, agent (and worker), start,
steps, id, and whether the outcome is in the
conversation; never what a task was asked or answered.
--agent <id>, --format json. "stratus tasks cancel <id>"
stops one, and its conversation gets a notice`,
  },
  {
    name: 'credential set',
    text: `Store a named credential an agent can resolve — a search
backend asks for search.apiKey. The value is read from
stdin, never from a flag, so it stays out of your shell
history: printf %s "$KEY" | stratus credential set
search.apiKey. --agent <id> stores one agent's own key,
which outranks the shared entry for that agent. Storing
grants nothing: the soul still needs credentials: [name].
--env <VAR> (with --agent) also binds it, as below`,
  },
  {
    name: 'credential env',
    text: `Let one agent's shell commands read a stored key as an
environment variable: stratus credential env
twilio.authToken TWILIO_AUTH_TOKEN --agent <id>. Applies
from the agent's next command, no restart; only while its
soul lists the name. --remove drops the binding. The
config's credentialsEnv still wins for a variable it maps`,
  },
  {
    name: 'credentials',
    text: `List stored credential names, which agents have their
own, and what each agent's shell reads — names only,
never values (also: credential list)`,
  },
  {
    name: 'credential remove',
    text: `Forget one (--agent <id> for that agent's own entry),
with the bindings that read it`,
  },
  {
    name: 'signin set',
    text: `Give one agent its own Claude subscription: stratus signin
set anthropic --agent <id> asks for a \`claude setup-token\`
token without echoing it, or reads it from stdin; never
from a flag. It outranks the shared sign-in (and any
ANTHROPIC_API_KEY) for that agent only. Not a named
credential: no soul lists it and no tool can read it.
A running daemon uses it from that agent's next turn.
--config <path>: check the agent against the roster of
the config the daemon runs on`,
  },
  {
    name: 'signin list',
    text: `Which agents have a sign-in of their own — names only,
never tokens (also: signins)`,
  },
  {
    name: 'signin remove',
    text: `Forget one agent's own sign-in; its next turn runs on the
shared one again`,
  },
  {
    name: 'channel set',
    text: `Store a channel plugin's secrets for one agent: stratus
channel set <kind> --agent <id> <name>... asks for each
value without echoing it, or reads one per line from
stdin; never from a flag. Replaces what that agent had on
that channel. Slack's are appToken and botToken, the
default when no names are given. Read at the next start`,
  },
  {
    name: 'channel list',
    text: `Which agents have secrets stored for which channel —
names only, never values (also: channels)`,
  },
  {
    name: 'channel remove',
    text: `Forget one agent's secrets for one channel`,
  },
  {
    name: 'schedules',
    text: `List every schedule the fleet has set — cadence, prompt,
pre-authorized destination, next firing — straight from the
daemon's database (--format json). "stratus schedules
cancel <id>" stops the next firing and revokes the
destination that was approved with it
(also: stratus schedule list / schedule cancel <id>)`,
  },
  {
    name: 'grants',
    text: `What an agent may do unattended beyond the built-in safe
list — its standing tool grants, command scopes,
commands granted by name, and sites, each an "always allow" somebody answered. From the
running daemon when one is serving (--gateway, --token),
else from ~/.stratus/agents/<id>/whitelist.json; --format
json. "stratus grants revoke <agent> --tool <name> |
--scope "<command>" | --origin <origin>" takes one back,
and a running daemon stops honouring it at once. Also
lists approvals.commands from config: the daemon's own
when one is serving, else the file --config names (or
the one stratus serve would find)`,
  },
  {
    name: 'people',
    text: `Who each agent answers to on Slack and who may approve its
calls: its admit setting, people and approvers, and
whether each list is the shared one or its own. "stratus
people add <member-id>" adds a teammate to the shared
list (--agent <id>: that agent's own list, starting as a
copy of the shared one; --approver: as an approver too).
"stratus people remove <member-id>" takes them off every
list (--agent: that agent only; --approver: approving
only). Edits the trusted config (--config, else
STRATUS_CONFIG, else ~/.stratus/config.json), then
reloads a running daemon, which applies it with no
restart, and says whether it did`,
  },
  {
    name: 'memory list',
    text: `Show an agent's live memory with the trust label each
entry carries — user, agent, unknown (no recorded origin,
or written in a conversation with someone not configured
as a principal), external (recorded after reading content
from outside) — plus what is pinned and what is outside
its validity window. --trust <level> filters; --format json.
--pass <id> shows what one memory pass wrote instead,
forgotten entries included`,
  },
  {
    name: 'memory search',
    text: `Search one agent's memory the way the agent does: plain
words, matched against a fact or what it is about, best
matches first and newer ahead of equally good older
ones. Expired facts are found and marked. --limit <n>;
--format json`,
  },
  {
    name: 'memory forget',
    text: `Retire entries by id. They leave the prompt and recall
and stay in the record, where audit still shows them`,
  },
  {
    name: 'memory audit',
    text: `Every entry the agent ever wrote, forgotten ones
included, with which entry replaced which`,
  },
  {
    name: 'memory pin',
    text: `Keep entries in the agent's prompt every turn:
stratus memory pin <agent> <id>.... The pinned core is
capped at 2 KiB of content and refuses rather than
evicting, so nothing already pinned is ever dropped.
"memory unpin" takes one back`,
  },
  {
    name: 'memory export',
    text: `Write an agent's entries to JSONL (--file <path>, else
stdout) — for moving an agent to another machine`,
  },
  {
    name: 'memory import',
    text: `Read that JSONL back into an agent (--file <path>).
Imported entries land external, because a file from
elsewhere may repeat what a stranger wrote;
--preserve-trust keeps each recorded label instead, for
a file you vouch for`,
  },
  {
    name: 'memory reassert',
    text: `Re-label entries as an operator: stratus memory reassert
<agent> --trust user <id>..., or --all-unknown for every
entry with no recorded origin (the upgrade case; an
entry recorded unknown — a stranger's message, a shell
command — is left for you to name by id). Appends
a record to ~/.stratus/memory.jsonl; a running daemon
sees it on its next turn. The only way a label ever
rises — no tool can do this`,
  },
  {
    name: 'memory passes',
    text: `An agent's memory passes from its ledger, newest first:
kind, mode, status and reason, how many facts each saved
and replaced, and the messages it read, with any message
cut to fit. --limit <n> (default 20); --format json`,
  },
  {
    name: 'memory undo-pass',
    text: `Forget every entry one pass wrote: stratus memory
undo-pass <agent> <pass-id>. What they replaced is live
again. Append-only, like forget`,
  },
  {
    name: 'session rollover',
    text: `Start a conversation over under the same session id,
archiving its transcript so far — for a long-lived
session (a Slack DM) that predates provenance tracking
and would otherwise write unknown forever. Asks the
running daemon (--gateway, --token)`,
  },
  {
    name: 'agent new',
    text: `Create an agent identity (generates a human-ish name + avatar theme)`,
  },
  {
    name: 'agents',
    text: `List your agents: who they are, where their souls live, what
they run on, what they remember (also: stratus agent list).
--gateway <url> asks a running daemon instead of resolving
locally, authenticating with ~/.stratus/gateway-token
(override with --token or STRATUS_GATEWAY_TOKEN)`,
  },
  {
    name: 'doctor',
    text: `Show what a run would use right now — provider, model, soul —
and which file or environment variable decided each, then
flag anything that would surprise you (--format json).
--live also asks each provider your runs use whether it
accepts the key`,
  },
  {
    name: 'update',
    text: `The whole upgrade dance, in the order that cannot lose
data: stop stratusd, upgrade the package from npm —
together with every optional first-party package this
machine has, which ship in lockstep with it — run
pending state migrations, rewrite the service unit with
current node/entrypoint paths, restart. Configured
plugins that release on their own go to their latest
release when this build would load it. --check reports
what it would do without doing any of it (exits 1 when
something is actionable, a companion left behind
included). Works offline too — an unreachable npm skips
the upgrade but still migrates and repairs the unit`,
  },
  {
    name: 'dashboard',
    text: `Open the web dashboard: finds a running daemon (or starts one),
mints a single-use sign-in link, and opens your browser at it.
Needs @stratusagent/control-api and @stratusagent/dashboard,
and offers to install them when they are missing`,
  },
  {
    name: 'help',
    text: `Show this help message`,
  },
  {
    name: 'version',
    text: `Print this build's version (also: --version, -v)`,
  },
];

const AGENT_OPTIONS: readonly OptionHelp[] = [
  {
    name: '--name',
    for: ['agent new'],
    text: `Agent name (omit to have one generated)`,
  },
  {
    name: '--instructions',
    for: ['agent new'],
    text: `The agent's persona/instructions`,
  },
  {
    name: '--format',
    for: ['agent new'],
    text: `Output format for agent new: text, json, or soul (a ready-to-edit soul file)`,
  },
];

const OPTIONS: readonly OptionHelp[] = [
  {
    name: '--prompt, -p',
    for: ['run'],
    text: `Prompt to send to the local agent loop`,
  },
  {
    name: '--stdin',
    for: ['run'],
    text: `Read the prompt from stdin`,
  },
  {
    name: '--provider',
    for: ['run', 'chat'],
    text: `Provider to use: anthropic, openai, codex, demo, or the name a plugin registers`,
  },
  {
    name: '--model',
    for: ['run', 'chat'],
    text: `Model name for real providers (anthropic default: ${defaultModelFor('anthropic')}, openai default: ${defaultModelFor('openai')}, codex default: ${defaultModelFor('codex')})`,
  },
  {
    name: '--base-url',
    for: ['run', 'chat'],
    text: `Override the provider API base URL`,
  },
  {
    name: '--soul',
    for: ['run', 'chat'],
    text: `Run as the agent defined by a soul file (markdown + frontmatter, see examples/souls)`,
  },
  {
    name: '--config',
    for: ['run', 'chat', 'setup', 'serve', 'service', 'doctor', 'plugins', 'grants', 'people', 'signin set'],
    text: `Config file path (run: load settings from it, setup: write it)`,
  },
  {
    name: '--format',
    for: ['run', 'doctor', 'plugins', 'health', 'events', 'sessions', 'tasks', 'schedules', 'grants', 'logs', 'agents', 'memory list', 'memory search', 'memory passes'],
    text: `Output format: text or json (default: text)`,
  },
  {
    name: '--no-events',
    for: ['run', 'serve'],
    text: `Hide event-by-event progress lines in text mode`,
  },
  {
    name: '--approvals',
    for: ['run', 'chat', 'serve'],
    text: `run/chat: tool approval mode — always, open (gated tools run, dangerous
ones ask), ask (every call), gated (safe tools run, the rest ask), or
never. Default: open, from approvals.posture (with no terminal,
a call that would ask is refused, said once on stderr); with
posture guarded (or an unreadable config), gated at a terminal
and never otherwise: gated calls are refused, said once on stderr
serve: how the daemon reaches a human for a call that needs
approval (dangerous ones under posture open, every gated one
under guarded) — headless (refuse it) or remote (ask in Slack).
Default headless, or the config file's "approvals.mode"`,
  },
  {
    name: '--max-turns',
    for: ['run', 'chat'],
    text: `Maximum tool turns per run before it wraps up (default: 40)`,
  },
  {
    name: '--port',
    for: ['dashboard'],
    text: `dashboard: port for a daemon it starts (default: 4123)`,
  },
  {
    name: '--host',
    for: ['dashboard'],
    text: `dashboard: host for a daemon it starts (default: 127.0.0.1)`,
  },
  {
    name: '--no-open',
    for: ['dashboard'],
    text: `Do not open the browser automatically`,
  },
  {
    name: '--gateway',
    for: ['agents', 'skill reload', 'restart', 'session rollover', 'sessions', 'health', 'events', 'tasks', 'grants'],
    text: `agents / skill reload / restart / session rollover /
sessions / health / events: a running daemon's control API (all but
agents default to the daemon ~/.stratus/gateway.json names)`,
  },
  {
    name: '--trust',
    for: ['memory list', 'memory reassert'],
    text: `memory list: show only this label; memory reassert: the
label to record (user, agent, unknown, external)`,
  },
  {
    name: '--all-unknown',
    for: ['memory reassert'],
    text: `memory reassert: every live entry with no recorded origin`,
  },
  {
    name: '--limit',
    for: ['memory search', 'sessions', 'memory passes'],
    text: `memory search: maximum hits (the store bounds it too);
sessions: how many to list (default 20); memory passes:
how many, newest first (default 20)`,
  },
  {
    name: '--pass',
    for: ['memory list'],
    text: `memory list: only what this memory pass wrote`,
  },
  {
    name: '--status',
    for: ['sessions'],
    text: `sessions: only this status, or stopped-early`,
  },
  {
    name: '--file',
    for: ['memory export', 'memory import'],
    text: `memory export / import: the JSONL path`,
  },
  {
    name: '--preserve-trust',
    for: ['memory import'],
    text: `memory import: keep each entry's recorded trust label
instead of landing it external`,
  },
  {
    name: '--token',
    for: ['agents', 'skill reload', 'restart', 'session rollover', 'sessions', 'health', 'events', 'tasks', 'grants'],
    text: `Bearer token for --gateway (default: ~/.stratus/gateway-token)`,
  },
  {
    name: '--no-reload',
    for: ['skill add'],
    text: `skill add: install without reloading a running daemon`,
  },
  {
    name: '-y, --yes',
    for: ['template add'],
    text: `template add: install without the review prompt`,
  },
  {
    name: '--reason',
    for: ['restart'],
    text: `restart: why, for the daemon's log`,
  },
  {
    name: '--drain-timeout',
    for: ['restart'],
    text: `restart: seconds the daemon lets in-flight turns finish
before aborting them (default: 30)`,
  },
  {
    name: '--no-api',
    for: ['serve'],
    text: `serve: do not serve the control API`,
  },
  {
    name: '--api',
    for: ['serve'],
    text: `serve: serve it even where the config says api.enabled: false`,
  },
  {
    name: '--api-host',
    for: ['serve'],
    text: `serve: control API interface (default: 127.0.0.1)`,
  },
  {
    name: '--api-port',
    for: ['serve'],
    text: `serve: control API port (default: 4123, 0 for any free port)`,
  },
  {
    name: '--events-host',
    for: ['serve'],
    text: `serve: events listener interface (default: 127.0.0.1). The
listener runs only when the config's "events" block names
a source`,
  },
  {
    name: '--log-format',
    for: ['serve'],
    text: `serve: text (default) or json — every structured log record
as one JSON line on stdout, and no human lines`,
  },
  {
    name: '--held',
    for: ['serve'],
    text: `serve: start held — the control API answers health, but no
channel connects and no schedule fires until
POST /api/v1/promote (for upgrades that must prove healthy)`,
  },
  {
    name: '--hold-new-version',
    for: ['serve'],
    text: `serve: like --held, but only when this version has not
been promoted on this home yet; a promotion records it, so
restarts of the same version serve at once`,
  },
  {
    name: '--help, -h',
    for: [],
    text: `Show this help message`,
  },
  {
    name: '--version, -v',
    for: [],
    text: `Print this build's version and exit`,
  },
];

/** Only in the whole help: it is about every command at once. */
const REFERENCE = `Config file:
  The CLI looks for ./stratus.config.json first, then a path from --config / STRATUS_CONFIG,
  then the global ~/.stratus/config.json written by \`stratus setup\`.
  A "soul" key (or STRATUS_SOUL) points at a soul file so every run uses that agent —
  from ~/.stratus/config.json or a file named with --config; an auto-discovered
  ./stratus.config.json does not get to choose a soul or a systemPrompt.

Plugins (tools):
  Capability is optional: install a package, then list it under "plugins" in a
  TRUSTED config (--config, STRATUS_CONFIG, or ~/.stratus/config.json), keyed by
  package name. A plugin runs inside this process, so an auto-discovered
  project-local stratus.config.json may not enable one.

    "plugins": {
      "@stratusagent/tool-fs": { "enabled": true, "roots": ["~/notes"],
                                 "agents": { "blair": { "roots": ["~/work/blair"] } } },
      "@stratusagent/tool-web": { "enabled": true }
    }

  Available: @stratusagent/tool-fs (fs.read/list/search/write),
  @stratusagent/tool-shell (shell.run), @stratusagent/tool-web (web.fetch),
  @stratusagent/tool-browser (browser.goto/read/screenshot/act).
  Installing one grants no agent anything — each soul lists what it may call.

Soul files:
  A soul file is markdown with frontmatter (name, provider, model, tools, skills, credentials, delegates)
  followed by the agent's persona in prose. See examples/souls/blair.md.
  "tools" takes exact names or a whole toolset: tools: [fs.read, fs.search] or
  tools: [fs.*], or tools: ["*"] for every tool. Omitted means only the safe tools (reads and memory),
  or every tool on a home set up before 0.14.3.
  "delegates" lists the agent ids this agent may hand work to with agent.delegate,
  or ['*'] for anyone on the roster; omitted means nobody.
  "skills" is the same allowlist shape over installed skills (see stratus
  skills), except omitted means none — a skill is enabled per agent, never
  by being installed.
`;

/*
 * `stratus agent list` is the `agents` entry, and so on: the forms a
 * command's description lists as "also:", plus a second word that is an
 * action of the entry, not an entry of its own. Without these, `stratus
 * skill list --help` would find the three `skill …` entries instead of
 * `skills`.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'agent list': 'agents',
  schedule: 'schedules',
  'schedule list': 'schedules',
  'schedule cancel': 'schedules',
  plugin: 'plugins',
  'plugin list': 'plugins',
  'skill list': 'skills',
  'session list': 'sessions',
  'credential list': 'credentials',
  signins: 'signin list',
  channels: 'channel list',
  'memory unpin': 'memory pin',
};

const COLUMN = 19;

const renderEntry = ({ name, text }: HelpEntry): string => {
  const [first = '', ...rest] = text.split('\n');
  const indent = ' '.repeat(COLUMN);
  // A name too long for the column takes a line of its own.
  const head = name.length <= COLUMN - 3
    ? `  ${name.padEnd(COLUMN - 2)}${first}`
    : `  ${name}\n${indent}${first}`;
  return [head, ...rest.map((line) => `${indent}${line}`)].join('\n');
};

const renderSection = (title: string, lines: readonly string[]): string => `${title}\n${lines.join('\n')}\n`;

const renderHelp = (usage: readonly string[], commands: readonly HelpEntry[], agentOptions: readonly HelpEntry[], options: readonly HelpEntry[]): string => [
  ...(usage.length > 0 ? [renderSection('Usage:', usage.map((line) => `  ${line}`))] : []),
  renderSection('Commands:', commands.map(renderEntry)),
  ...(agentOptions.length > 0 ? [renderSection('Agent options:', agentOptions.map(renderEntry))] : []),
  ...(options.length > 0 ? [renderSection('Options:', options.map(renderEntry))] : []),
].join('\n');

export const HELP_TEXT = `Stratus Agent CLI\n\n${renderHelp(USAGE, COMMANDS, AGENT_OPTIONS, OPTIONS)}\n${REFERENCE}`;

const entriesNamed = (key: string): readonly HelpEntry[] => {
  const name = ALIASES[key] ?? key;
  return COMMANDS.filter((entry) => entry.name === name || entry.name.startsWith(`${name} `));
};

/**
 * The command a help request or a usage error is about, as typed: the
 * longest run of the leading words (at most two) that names an entry, or
 * a family of them (`memory` names every `memory …` entry). Undefined for
 * no command, or one the help does not know.
 */
export const helpTopic = (words: readonly string[]): string | undefined => {
  const leading: string[] = [];
  for (const word of words) {
    if (leading.length === 2 || word.startsWith('-')) {
      break;
    }
    leading.push(word);
  }
  for (let count = leading.length; count > 0; count -= 1) {
    const key = leading.slice(0, count).join(' ');
    if (entriesNamed(key).length > 0) {
      return key;
    }
  }
  return undefined;
};

/** One command's help: its usage lines, its entries, and the options they take. */
export const commandHelp = (topic: string): string => {
  const entries = entriesNamed(topic);
  const names = new Set(entries.map((entry) => entry.name));
  const about = (line: string): boolean => {
    const words = line.slice(line.indexOf('stratus ') + 'stratus '.length).split(' ');
    const key = helpTopic(words);
    return key !== undefined && entriesNamed(key).some((entry) => names.has(entry.name));
  };
  const takes = (option: OptionHelp): boolean => option.for.some((name) => names.has(name));
  return renderHelp(USAGE.filter(about), entries, AGENT_OPTIONS.filter(takes), OPTIONS.filter(takes));
};

/**
 * The one line a usage error ends with, pointing at the help for the
 * command that was mistyped, or at the whole list when the command itself
 * was the mistake.
 */
export const usagePointer = (argv: readonly string[]): string => {
  const topic = argv[0] === 'help' ? undefined : helpTopic(argv);
  return topic === undefined
    ? 'Run `stratus --help` for the list of commands.'
    : `Run \`stratus ${topic} --help\` for its usage.`;
};
