# Security posture

The one-page map of what protects what. Each rule is deliberate; the pages
linked own the full story.

## Secrets on disk

- `~/.stratus/credentials.json` is `0600` (owner-read-only), and so are
  `~/.stratus/gateway-token`, `~/.stratus/gateway.json`,
  `~/.stratus/logs/stratusd.jsonl`, and each agent's
  `<id>.whitelist.json`.
- **Stored sign-ins are endpoint-bound**: a credential saved for one
  endpoint is never sent to an endpoint a project-local config selects.
- **Slack channel tokens are gateway infrastructure secrets.** They live
  under `channels.slack.<agentId>` and are never resolvable through an
  agent's own credential allowlist — an agent must not be able to read the
  tokens of the transport carrying it. ([Slack](../guides/slack.md))

## What a cloned repo cannot decide

The `plugins`, `approvals`, and `api` config blocks are read **only from a
trusted config** — the global `~/.stratus/config.json` or a file you
passed yourself. An auto-discovered project-local `stratus.config.json`
ships in any repository; which code runs in the daemon, who may approve
its tool calls, and which interface it binds are not decisions a clone
gets to make. ([Configuration](../reference/config.md))

## What an agent can reach

- **Two gates on every capability**: a trusted config enables the plugin,
  and the agent's own soul lists what it may call.
  ([Plugins](./plugins.md), [Tools](../guides/tools.md))
- **The daemon runs only `safe` tools unattended**; everything else is
  refused or asked of a configured human. ([Approvals](../guides/approvals.md))
- **Shell commands are judged individually**, control operators disqualify
  a command outright, and "Always allow" persists a scope minus its
  destructive forms. ([Shell commands](../guides/shell.md))
- **Network tools refuse local addresses** — loopback, RFC 1918,
  link-local, IPv6 unique-local, and their IPv4-mapped and NAT64
  spellings — validated on the connection, so a redirect or DNS answer
  cannot walk an agent into a metadata endpoint. ([Tools](../guides/tools.md))
- **`tool-shell` and stdio MCP servers get a replaced environment**: the
  daemon's own env vars, where API keys live, are not there to read.

## What is written down

- **The daemon log is a trace, not a second transcript**: tool names,
  session ids, and memory entry ids — never prompts, replies, tool inputs,
  or shell command text. The one qualification: a failed session records
  the provider's error text verbatim, and providers quote the failing
  request — so skim a log before sharing it. ([Logs](../guides/logs.md))
- **No control API endpoint returns a secret.** Credential reads report
  presence, type, and bound endpoint; session reads strip the Anthropic
  raw-turn cache. ([Control API](../../packages/control-api/README.md))

## The network posture

The control API binds `127.0.0.1` and exists only when its package is
installed. Cookie-authenticated requests are origin-bound; bearer ones are
not, because a browser never attaches a bearer token on a page's behalf.
Reaching a machine from outside goes through a tunnel, not a public bind.
([Remote access](../guides/remote-access.md))
