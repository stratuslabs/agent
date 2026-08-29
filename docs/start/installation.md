# Installation

## Requirements

Stratus Agent needs **Node.js 22.13+** (or **23.4+** if you are on the 23.x
line — `node:sqlite` was unflagged separately there, so 23.0–23.3 are too old
despite the higher number). On macOS, `brew install node` gets you a new
enough one; on Linux, use your package manager or nvm. Every package declares
the range in `engines`, and `stratus` checks it before it does anything, so an
unsupported Node says so plainly rather than failing on a missing builtin
later.

## Install the CLI

```bash
npm install -g @stratusagent/cli
stratus setup
```

That one package is everything you need to run agents: the runtime, the
providers, the agent roster, and the always-on gateway all come with it.
[Setup](./setup.md) is the whole onboarding — no config files to edit and no
env vars to export.

## Optional packages

Everything else is a [plugin](../concepts/plugins.md): one package that
contributes a channel, tools, or a surface. A transport you don't use is
weight you shouldn't carry, so each one is separate and you add only what you
want. `stratus setup` offers the ones your own answers imply at
**Save & finish**, so you rarely type these by hand:

```bash
npm install -g @stratusagent/channel-slack     # talk to agents in Slack (~9 MB of Slack SDKs)
npm install -g @stratusagent/tool-fs @stratusagent/tool-shell \
               @stratusagent/tool-web @stratusagent/tool-browser   # real capability
npm install -g @stratusagent/plugin-mcp        # mount MCP servers' tools
npm install -g @stratusagent/control-api @stratusagent/dashboard   # HTTP API + web UI
```

What each adds, and the gates that keep an installed package from doing
anything by itself: [Slack](../guides/slack.md) ·
[Tools](../guides/tools.md) · [MCP](../guides/mcp.md) ·
[Remote access](../guides/remote-access.md) ·
[the plugin trust model](../concepts/plugins.md).

Prefer doing it by hand instead of through setup? Copy
[`stratus.config.json.example`](../../stratus.config.json.example) into your
project and see the [configuration reference](../reference/config.md).

## From source

To work on Stratus Agent itself you also need **pnpm 10**:

```bash
corepack enable && corepack prepare pnpm@10.18.3 --activate
git clone https://github.com/stratuslabs/agent.git && cd agent
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test
```

If the suite is green the toolchain is good. In a source checkout the CLI
runs from its build output rather than the global `stratus` binary:

```bash
node packages/cli/dist/bin.js setup
node packages/cli/dist/bin.js run "Say hello"
```

Every `stratus …` command in these docs works that way too.
