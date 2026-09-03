# Plugins: what installing does, and does not do

Everything optional is a **plugin**: one package that contributes tools,
skills, providers, channels, memory stores, executors, or hooks. A
transport you don't use is weight you shouldn't carry, so each one is
separate and you add only what you want. (The contract itself — plugin,
tool, toolset, skill, and what the ecosystem builds versus what core
ships — is specified in
[`architecture/plugins.md`](../architecture/plugins.md).)

## What one install brings

Installing the CLI (`npm install -g @stratusagent/cli`) brings the whole
runtime with it — these thirteen packages are what you get, and you never
install them individually:

- `@stratusagent/cli`, the `stratus` command: setup, chat, one-shot runs, the gateway, the dashboard
- `@stratusagent/core`, the runtime primitives and agent loop
- `@stratusagent/agents`, agent identities, souls, memory, delegation, and routing
- `@stratusagent/state`, shared state wiring: config resolution, credentials, the soul roster, file memory, provider construction
- `@stratusagent/gateway`, stratusd — the always-on gateway with durable SQLite sessions and a per-provider runner pool
- `@stratusagent/permissions`, the policy layer deciding what a tool call may do unattended, what needs a human, and what is refused
- `@stratusagent/providers`, helpers for building model providers
- `@stratusagent/provider-anthropic`, the Claude provider on the official Anthropic SDK
- `@stratusagent/provider-claude-code`, the Claude subscription runtime on the Claude Agent SDK
- `@stratusagent/provider-codex`, the ChatGPT/Codex runtime on the OpenAI Codex SDK, with kernel tools served over a loopback MCP endpoint
- `@stratusagent/executors`, helpers for execution behavior
- `@stratusagent/executor-local`, a concrete local child-process executor adapter
- `@stratusagent/plugins`, the plugin host: reads a plugin's manifest without importing it, holds `setup()` to what that manifest declared, and turns a config block into running capability

## Installing a plugin does not run it

The rule for anything you add: a plugin is code in the daemon's own
process, so it runs only once it is named and enabled in a **trusted
config** — the global `~/.stratus/config.json`, or a file you passed with
`--config` — never by being present on disk, and never by a
`stratus.config.json` that shipped in a repository you cloned.

And because it is code in the daemon's process, enabling, disabling,
upgrading, or reconfiguring one takes a restart — an announced one,
`stratus restart`, which refuses new turns, drains the ones in flight, and
comes back with sessions and channels intact. Skills are the exception:
prose read from disk, reloaded live by `stratus skill add`. The full table
of what needs a restart is in
[Always on](../guides/always-on.md#what-needs-a-restart-and-what-does-not).

Today's optional packages predate that rule and each keeps its own path, so
be precise about which is which. A **channel** starts when *its credentials
are stored* — a decision you already made when you connected the app. The
**control API** starts whenever it is *installed*, and binds a port;
installing it is how you say you want one open, and `--no-api` or
`api.enabled: false` is how you say you don't. The **dashboard** follows
the control API. None of those is the enablement gate above, and none of
them is a precedent for a plugin that wants one.

## The optional packages that exist today

- [`@stratusagent/channel-slack`](../../packages/channel-slack) — talk to
  your agents in Slack, each as its own app. Adds ~9 MB of Slack SDKs.
  See [Slack](../guides/slack.md).
- [`@stratusagent/channels`](../../packages/channels) — the channel
  contract itself: inbound messages, streaming outbound connections,
  session keys. It arrives as a dependency of any channel package, and it
  is what you build a new transport against.
- [`@stratusagent/control-api`](../../packages/control-api) — the
  authenticated HTTP + WebSocket API over a running daemon.
  See [Remote access](../guides/remote-access.md).
- [`@stratusagent/dashboard`](../../packages/dashboard) — the web UI on top
  of that API. No build step: what ships in `ui/` is hand-written HTML,
  CSS, and ES modules.
- [`@stratusagent/tool-fs`](../../packages/tool-fs),
  [`tool-shell`](../../packages/tool-shell),
  [`tool-web`](../../packages/tool-web),
  [`tool-browser`](../../packages/tool-browser) — real capability, each
  enabled in a trusted config and granted per agent.
  See [Tools](../guides/tools.md).
- [`@stratusagent/plugin-mcp`](../../packages/plugin-mcp) — any MCP
  server's tools under the same policy. See [MCP](../guides/mcp.md).
- [`@stratusagent/egress`](../../packages/egress) — the shared address
  policy both network packs use; arrives as their dependency.
- [`@stratusagent/search`](../../packages/search) — the `web.search`
  contract: the tool name, the option meanings, and the result envelope a
  search backend implements. No backend and no vendor ship here; a backend
  is a plugin somebody else publishes, and this is what makes two of them
  interchangeable. See [Tools](../guides/tools.md#searching-the-web).

[`stratus setup`](../start/setup.md#what-save--finish-offers) offers these
installs at **Save & finish** when your own answers imply them, and does it
before starting the daemon, so it comes up with them present. Declining
prints the command instead. Without a channel installed, everything else
works exactly as before: the daemon logs an install hint for any agent that
has channel credentials stored and serves the rest of the roster normally.

## Two gates, and the second is per identity

Installing a tool plugin still grants no agent anything: each agent's soul
lists what it may call (`tools: [fs.read, fs.search]`, or `fs.*` for a
whole toolset). The first gate is the operator's (a trusted config lists
and enables the plugin); the second is the identity's (the soul opts in).
[Skills](../guides/skills.md) work the same way: installed is not enabled.
