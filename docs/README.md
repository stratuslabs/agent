# Stratus Agent documentation

Everything user-facing, organized by what you are trying to do. The two
READMEs — [the repo front door](../README.md) and
[the npm page](../packages/cli/README.md) — stay short and link here; this
tree is where the depth lives.

## Find what you need

| I want to… | Read |
| --- | --- |
| Install Stratus | [Installation](./start/installation.md) |
| Run the setup menu, sign in, create my first agent | [Setup](./start/setup.md) |
| Run something *right now*, account or not | [Quickstart](./start/quickstart.md) |
| Talk to my agents in Slack | [Slack](./guides/slack.md) |
| Give agents files, a shell, the web, a browser | [Tools](./guides/tools.md) |
| Control which shell commands run unattended | [Shell commands](./guides/shell.md) |
| Teach an agent a procedure | [Skills](./guides/skills.md) |
| Decide what runs unattended and approve the rest from Slack | [Approvals](./guides/approvals.md) |
| Let agents act on their own schedule | [Schedules](./guides/schedules.md) |
| Keep the daemon running after I close the terminal | [Always on](./guides/always-on.md) |
| See what the daemon did overnight | [Logs](./guides/logs.md) |
| Upgrade without losing anything | [Updating](./guides/updating.md) |
| Figure out why a run used the wrong provider | [Troubleshooting](./guides/troubleshooting.md) |
| Mount an MCP server's tools | [MCP](./guides/mcp.md) |
| Use the web dashboard, or reach a daemon from another machine | [Remote access](./guides/remote-access.md) |
| Look up a command or flag | [CLI reference](./reference/cli.md) |
| Look up a config key, or understand precedence | [Configuration](./reference/config.md) |
| Understand souls, ids, and agent identity | [Agents](./concepts/agents.md) |
| Understand what an agent remembers | [Memory](./concepts/memory.md) |
| Understand what installing a plugin does (and does not do) | [Plugins](./concepts/plugins.md) |
| See the security posture in one place | [Security](./concepts/security.md) |
| Drive a daemon over HTTP/WebSocket | [Control API reference](../packages/control-api/README.md) |
| Understand the design, or see what is coming | [Architecture](./architecture/stratus-v2.md) · [Roadmap](./roadmap/README.md) |

## How this tree is organized

- **`start/`** — the path from nothing to a working agent.
- **`guides/`** — one task each: doing a thing with a running install.
- **`reference/`** — lookup tables: every command, flag, and config key.
- **`concepts/`** — the ideas underneath: agents, memory, plugins, security.
- **`architecture/`** — design documents; [`plugins.md`](./architecture/plugins.md)
  is the contract the ecosystem builds against.
- **`roadmap/`** — ordered steps with a one-page spec each.

Package READMEs stay canonical for their own surface:
[`channel-slack`](../packages/channel-slack/README.md) for the Slack app
setup, [`control-api`](../packages/control-api/README.md) for the HTTP + WS
contract, [`plugin-mcp`](../packages/plugin-mcp/README.md) and the
[`tool-*`](../packages/tool-fs/README.md) packages for their own settings.
