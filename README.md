# Stratus Agent

Stratus Agent is a tiny JavaScript agent runtime and CLI.

You can talk to an agent in the terminal, run your whole roster as an always-on daemon, or reach them from Slack — each agent as its own bot. Sessions are durable, memory is keyed to the agent, and there is a small local dashboard for smoke testing.

## What it includes

Installing the CLI (`npm install -g @stratusagent/cli`) brings the whole
runtime with it — these ten packages are what you get, and you never install
them individually:

- `@stratusagent/cli`, the `stratus` command: setup, chat, one-shot runs, the gateway, the dashboard
- `@stratusagent/core`, the runtime primitives and agent loop
- `@stratusagent/agents`, agent identities, souls, memory, delegation, and routing
- `@stratusagent/state`, shared state wiring: config resolution, credentials, the soul roster, file memory, provider construction
- `@stratusagent/gateway`, stratusd — the always-on gateway with durable SQLite sessions and a per-provider runner pool
- `@stratusagent/providers`, helpers for building model providers
- `@stratusagent/provider-anthropic`, the Claude provider on the official Anthropic SDK
- `@stratusagent/provider-claude-code`, the Claude subscription runtime on the Claude Agent SDK
- `@stratusagent/executors`, helpers for execution behavior
- `@stratusagent/executor-local`, a concrete local child-process executor adapter

### Optional packages

Channels are **not** part of that install. A transport you don't use is weight
you shouldn't carry, so each one is a separate package you add only if you want
it. Install it next to the CLI and `stratus serve` picks it up on its own:

- `@stratusagent/channel-slack` — talk to your agents in Slack: one Slack app per agent (its own avatar, presence, and DMs), Socket Mode so no public ingress is needed, resumable threads, and replies that stream via message edits. Adds roughly 9 MB of Slack SDKs.

  ```bash
  npm install -g @stratusagent/channel-slack
  ```

- `@stratusagent/channels` — the channel contract itself: inbound messages, streaming outbound connections, session keys. It arrives as a dependency of any channel package, and it is what you build a new transport against.

Without a channel installed, everything else works exactly as before: the
daemon logs an install hint for any agent that has channel credentials stored
and serves the rest of the roster normally.

## Current status

This repo is early, but the core loop is complete.

Today it is useful for:
- talking with your agent in a persistent conversation (`stratus chat`) — the session carries across turns and remembered facts accumulate
- running the whole roster as an always-on daemon (`stratus serve`) — durable sessions that survive restarts, each agent on its own provider and model, delegation between them, and a progress-based watchdog
- keeping that daemon running once the terminal closes (`stratus service install`, on by default after setup) — a LaunchAgent on macOS, a systemd user service on Linux — with `stratus logs` to read what it did while you were away. Both start at **login**, so a machine that should recover unattended after a reboot needs automatic login on macOS, or `loginctl enable-linger` on Linux
- talking to your agents in Slack — each agent is its own Slack app with its own avatar and presence, threads are resumable conversations, and replies stream via message edits (install `@stratusagent/channel-slack`, then run `stratus setup` → **Channels** to create and connect each agent's app; see `packages/channel-slack/README.md`)
- running a multi-turn agent loop locally: provider → tools → provider until the model finishes
- running real tool-calling sessions against Claude (via the official Anthropic SDK) or any OpenAI-compatible provider (tools are advertised with JSON schemas, tool calls execute locally, and results are fed back to the model)
- defining agents as soul files — markdown personas you run with `stratus run --soul ./ava.md "hi"`
- gating tool execution with an approval policy (`--approvals always|ask|never`)
- continuing an existing session with follow-up user messages via `runner.resume()`
- opening a tiny local dashboard for browser-based smoke testing
- seeing how provider output becomes session events

It is not yet a full production agent platform. The v1 kernel deliberately left durable storage, remote executors, and retries/queues out of scope (see `docs/architecture/stratus-v1.md`); the gateway has since brought durable sessions in, and remote executors and retries/queues are still open.

## Agents are people

Stratus agents are designed to feel like a person you work with, not a stateless bot:

- **One identity everywhere.** An agent's memory is keyed to the agent — never to a session or channel — so what they learn in one thread they know in every other conversation. Agents can save facts with the built-in `memory.remember` tool, and their memory is handed to the model on every turn. CLI runs persist it to `~/.stratus/memory.jsonl`, so the agent you talk to tomorrow remembers today — from any directory.
- **Scoped access.** Each agent has its own tool allowlist and its own credential allowlist. An agent can only call the tools it was given, and can only resolve the secrets it was granted.
- **Delegation.** An orchestrator agent uses the `agent.delegate` tool to hand a task to a teammate and gets their reply back — the teammate runs with *their own* memory, tools, and credentials.
- **Routing.** `createAgentRouter` maps inbound work (a channel, a mention, a message) to the right agent, so the same person consistently answers in the same places.

Creating an agent takes one call — or one command. If you don't name them, we will, and every agent gets a deterministic color palette derived from their name, rendered in the one shared Stratus avatar style — so the team looks cohesive and each agent looks the same on every surface:

```bash
stratus agent new
# Say hello to Freya.
#   id      freya-k3x9
#   avatar  stratus theme, hue 211, palette #3d7dd9 #8fb8ea #d9993d
```

```ts
import { defineAgent } from '@stratusagent/agents';

const scout = defineAgent({ instructions: 'You research things thoroughly.' });
// scout.name → "Arlo", scout.avatar → matching palette + style
```

### Soul files

An agent can live in a file. A soul file is markdown with frontmatter — the frontmatter carries the structured identity (name, provider, model, tool and credential allowlists) and the body is the persona itself, written in prose:

```markdown
---
name: Ava
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
  - memory.remember
---

You are a sharp, warm generalist assistant. Answer first, explain second...
```

Run it directly, point your config at it, or generate one to start from:

```bash
stratus run --soul ./examples/souls/ava.md "hello"
stratus agent new --format soul > my-agent.md   # generated identity, ready to edit
```

Two well-written example souls live in `examples/souls/` — they double as the format docs. A soul's provider/model are hints: `--provider`/`--model` flags and `STRATUS_*` env vars still win.

## Install

Stratus Agent needs **Node.js 22.13+** (or **23.4+** if you are on the 23.x line — `node:sqlite` was unflagged separately there, so 23.0–23.3 are too old despite the higher number). On macOS, `brew install node` gets you a new enough one; on Linux, use your package manager or nvm. Every package declares the range in `engines`, and `stratus` checks it before it does anything, so an unsupported Node says so plainly.

Then:

```bash
npm install -g @stratusagent/cli
stratus setup
```

That is the whole install for the runtime. If you want Slack, add the channel package too — see [Optional packages](#optional-packages):

```bash
npm install -g @stratusagent/channel-slack
```

### Setup

Setup is the whole onboarding: a small menu where you pick a provider, sign in, create your first agent, connect channels, and test it — no config files to edit and no env vars to export:

- **Sign in from the menu.** For Claude, choose how you pay: **Claude subscription (Pro/Max)** — sign in through Claude Code (`claude setup-token`) so usage is covered by your plan — or **Anthropic API key**, pasted straight into the prompt and verified against the live API before it's accepted. OpenAI-compatible keys work the same way.
- **Credentials are stored for you** in `~/.stratus/credentials.json` (owner-read-only), and settings in `~/.stratus/config.json`, so `stratus run` works from any directory afterwards. A project-local `stratus.config.json` still wins when present, and env vars outrank both.
- **Create your agent inside setup** — name them (or let Stratus name them), describe their personality, and their soul file lands in `~/.stratus/agents/` ready to edit.
- **Default and fallback models.** The Models menu lists every model your sign-ins can actually reach (fetched live from the provider APIs) and lets you pick a **default** and a **fallback** — when the default model errors mid-run, the run automatically retries on the fallback, even across providers.
- **Connect channels.** The Channels menu walks each agent onto Slack: it prints the app manifest with the agent's name already filled in, takes both tokens without echoing them, verifies each against Slack, and stores them for the daemon. Nothing to hand-edit.
- **Always on, by default.** The Always on entry installs `stratusd` as a background service — running now, and again at every login — so the roster keeps answering once you close the terminal. Every Slack app you just connected is silent until it runs. Opt out and setup removes the service instead.
- **Test without leaving the menu.** The Test run entry does a real "say hello" with your current settings.

Prefer doing it by hand? Copy `stratus.config.json.example` into your project instead.

## From source

To work on Stratus Agent itself you also need **pnpm 10**:

```bash
corepack enable && corepack prepare pnpm@10.18.3 --activate
git clone https://github.com/stratuslabs/agent.git && cd agent
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test
```

If the suite is green the toolchain is good. In a source checkout the CLI runs from its build output rather than the global `stratus` binary:

```bash
node packages/cli/dist/bin.js setup
node packages/cli/dist/bin.js run "Say hello"
```

Every `stratus …` command below works that way too.

## Quickstart

### 1) Run the demo path

The `demo` provider needs no account at all:

```bash
stratus run "say hello"
```

Or trigger the demo tool:

```bash
stratus run --prompt "please use the echo tool"
```

### 2) Open the local dashboard

```bash
stratus dashboard
```

The command prints the local URL, opens your default browser, and exposes a tiny `/api/echo` endpoint that the page can exercise.

### 3) Run a real provider path

`stratus setup` is the easy way in, but every setting has an env var and a flag behind it. The flagship path is Claude via the official Anthropic SDK:

```bash
export ANTHROPIC_API_KEY=your-key
stratus run --provider anthropic "say hello"
```

The Claude provider defaults to `claude-opus-5` and handles multi-turn tool calling, the agent's persona and memory, and adaptive thinking out of the box.

Any OpenAI-compatible API works too:

```bash
export STRATUS_PROVIDER=openai
export OPENAI_API_KEY=your-key
export STRATUS_MODEL=gpt-4.1-mini
stratus run "say hello"
```

Or with a config file `stratus.config.json` (start from `stratus.config.json.example`):

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "soul": "./examples/souls/ava.md"
}
```

Then:

```bash
export ANTHROPIC_API_KEY=your-key
stratus run "say hello"
```

Legacy `STRATUSCLAW_*` env vars and `stratusclaw.config.json` still work for compatibility.

## What you’ll see

A run prints a short event log followed by the final session messages.

A text-only demo prompt looks like this:

```text
Starting Stratus Agent local loop with provider=demo
• session.created <id>
• session.updated running
• provider.response 1 part(s)
• session.updated completed
• session.completed <id>

Messages
[user] say hello
[assistant] Demo provider ready. Prompt received: say helloNo tool call was needed, so this run stays text-only. Mention “tool” or “echo” to trigger the demo tool.
```

A prompt that mentions `tool` or `echo` runs the full multi-turn loop: the provider requests a tool, the tool executes locally, and the result goes back to the provider for a final answer:

```text
• provider.response 2 part(s)
• tool.called demo.echo
• tool.completed demo.echo ok=true
• provider.response 1 part(s)
```

```text
[assistant] → tool call demo.echo({"text":"please use the echo tool"})
[tool:demo.echo] { "ok": true, "output": { "uppercase": "PLEASE USE THE ECHO TOOL", ... } }
[assistant] The demo.echo tool finished with: {"received":"please use the echo tool", ...}
```

The dashboard prints a line like this when it starts:

```text
Stratus Agent Dashboard ready at http://127.0.0.1:4123
Press Ctrl+C to stop.
Opened your default browser.
```

## CLI usage

```bash
stratus setup
stratus chat
stratus chat --soul ./examples/souls/ava.md
stratus run --prompt "Use the demo tool"
stratus run "Say hello"
stratus run --provider anthropic "Say hello"
stratus run --soul ./examples/souls/ava.md "Say hello"
stratus run --provider openai --model gpt-4.1-mini "Say hello"
stratus agents
stratus dashboard
stratus dashboard --port 4123 --host 127.0.0.1 --no-open
stratus serve
stratus serve --idle-timeout 120 --no-events
stratus service install
stratus service status
stratus logs -f
stratus logs --agent ava -n 200
stratus doctor
```

Three of those are about running the daemon rather than talking to an agent,
and `packages/cli/README.md` covers each in full:

- **`stratus service`** keeps `stratusd` running under launchd (macOS) or
  systemd (Linux), starting it now and at every login. `stratus setup` installs
  it by default, so this is mostly for checking on it (`status`) or opting out
  later (`uninstall`).
- **`stratus logs`** reads `~/.stratus/logs/stratusd.jsonl` — what the daemon
  has been doing since you closed the terminal. `-f` follows it, `--agent` and
  `--session` filter it. It is a trace, not a transcript: prompts, replies, and
  tool inputs are deliberately not in it, though a failed session does record
  the provider's error text verbatim.
- **`stratus doctor`** prints what a run would use right now — provider, model,
  soul — and which file or environment variable decided each, then flags
  anything that would surprise you. It is the fastest answer to "why is this
  using the demo provider?" and to an `ANTHROPIC_API_KEY` quietly demoting a
  Claude subscription sign-in to per-token billing.

Current options:

- `--prompt`, `-p`, pass the prompt explicitly
- `--stdin`, read the prompt from stdin
- `--provider`, choose `anthropic`, `openai`, or `demo`
- `--model`, set the model for real providers (anthropic defaults to `claude-opus-5`)
- `--base-url`, override the provider API base URL
- `--soul`, run as the agent defined by a soul file (also `STRATUS_SOUL` or the config `soul` key)
- `--config`, load provider settings from a JSON config file
- `--format`, choose `text` or `json`
- `--no-events`, hide event logs in text mode
- `--approvals`, tool approval mode: `always`, `ask` (interactive y/N prompt), or `never`
- `--max-turns`, maximum provider turns per run (default: 8)
- `--port`, set the dashboard port
- `--host`, set the dashboard host
- `--no-open`, skip automatic browser opening
- `--idle-timeout`, seconds of silence from a streaming provider before `stratus serve`'s watchdog aborts the turn (default: 120)
- `--no-log-file`, stop `stratus serve` writing `~/.stratus/logs/stratusd.jsonl`
- `--no-login`, install the service without the start-at-login trigger
- `-f`, `-n`, `--agent`, `--session`, `stratus logs`: follow, backlog size, and filters
- `--help`, `-h`, show help

## Repo shape

```text
packages/
  agents/
  channel-slack/
  channels/
  cli/
  core/
  executor-local/
  executors/
  gateway/
  provider-anthropic/
  provider-claude-code/
  providers/
  state/
examples/
  souls/
docs/
  architecture/
  roadmap/
```

## Development commands

```bash
pnpm build
pnpm typecheck
pnpm test
```

## Where this is headed

The kernel stays small and understandable; capability grows as optional packages around it. The always-on runtime (`stratus serve`) is here — it hosts a roster of agents with durable sessions and speaks through channel packages, Slack first, each agent as its own bot identity. What is still ahead is one control API that every surface — CLI, web dashboard, macOS management app — consumes as a thin client, plus more channels behind the same contract.

- **Vision:** [`docs/architecture/stratus-v2.md`](docs/architecture/stratus-v2.md) — the layered architecture, key decisions, and how the deployment targets (local machines, VMs, hosted) collapse into one runtime.
- **Roadmap:** [`docs/roadmap/`](docs/roadmap/README.md) — ordered steps with a one-page spec each, from the gateway daemon to productization.
- **v1 design notes:** [`docs/architecture/stratus-v1.md`](docs/architecture/stratus-v1.md) — the kernel boundary this all builds on.
