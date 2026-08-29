# @stratusagent/plugin-mcp

The MCP bridge: mount any [Model Context Protocol](https://modelcontextprotocol.io)
server's tools as Stratus tools — under the same allowlists, the same risk
model, and the same approval policy as a tool written for Stratus. Every MCP
server anyone has already written becomes available to an agent whose soul
opts in, without that server's author knowing Stratus exists.

## Install and enable

```bash
npm install -g @stratusagent/plugin-mcp
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/plugin-mcp": {
      "enabled": true,
      "servers": {
        // A subprocess server, spoken to over stdio:
        "linear": {
          "command": "npx",
          "args": ["-y", "@linear/mcp-server"],
          "env": { "LINEAR_API_KEY": "lin_api_…" }
        },
        // A remote server, spoken to over Streamable HTTP:
        "docs": {
          "url": "https://mcp.example.com/mcp",
          "headers": { "Authorization": "Bearer …" }
        }
      }
    }
  }
}
```

Then allowlist the tools in a soul, exactly as for any other toolset:

```markdown
---
id: ava
tools: [mcp.linear.*, fs.read]
---
```

## Naming: `mcp.<server>.<tool>`

Tools register namespaced by the server's config key: the Linear server's
`create_issue` becomes `mcp.linear.create_issue`. A soul grants a whole
server with `mcp.linear.*` (or every bridged server with `mcp.*`), and an
operator reading a tool list sees at a glance which tools are somebody
else's code. Server keys become name segments, so they must be lowercase
`[a-z0-9_-]`; a discovered tool name is folded to the same shape
(`createIssue` → `mcp.linear.createissue`), and two names that fold to the
same segment refuse the server rather than letting one silently answer for
the other.

## Risk: ours, not the server's

MCP has no risk vocabulary, and a remote server's self-description is
exactly the input the trust model says not to take at face value. So
**every bridged tool registers `gated`** — a human decides when nobody is
watching — even when the server describes it as read-only. The package's
manifest declares the namespace (`toolsDiscovered: [{ "namespace": "mcp.*",
"risk": "gated" }]`) and the plugin host enforces it at registration, on
first connect and identically on reconnect.

The override is the operator's, explicit and per tool, through the host's
`toolRisks` key — sibling to `enabled`, applied by the host rather than by
this package's code:

```jsonc
"@stratusagent/plugin-mcp": {
  "enabled": true,
  "servers": { "linear": { … } },
  "toolRisks": {
    "mcp.linear.get_issue": "safe",      // you read the server; it only reads
    "mcp.linear.delete_issue": "dangerous"
  }
}
```

## Server settings

| Setting | Applies to | Meaning |
| --- | --- | --- |
| `command`, `args`, `cwd` | stdio | The subprocess to spawn. Exactly one of `command` / `url` per server. |
| `env` | stdio | Variables set outright, name to value — where a server's API key goes. |
| `passEnv` | stdio | Names forwarded from the daemon's environment. Defaults to `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`. |
| `url` | HTTP | The Streamable HTTP endpoint. |
| `headers` | HTTP | Headers sent with every request — where a bearer token goes. |
| `connectTimeoutMs` | both | One budget for the connect handshake *and* the whole tool-discovery walk (default 15000), so a server can stall startup neither by being unreachable nor by paginating slowly. |
| `callTimeoutMs` | both | Per-call budget (default 60000). |

A setting on the wrong transport kind — `headers` on a stdio server, `env`
on an HTTP one — is refused at load rather than silently ignored, and so is
a `passEnv` that is not an array of names: a grant an operator believes is
in effect must never quietly be nothing.

**The stdio environment is replaced, not extended.** A subprocess MCP
server is a subprocess, and gets the same treatment `tool-shell`'s commands
do: exactly what this config granted — the harmless default inheritance,
`passEnv` names, `env` values — and nothing else. The daemon's environment,
where `ANTHROPIC_API_KEY` and every other exported key lives, is not there
to read.

OAuth-authenticated HTTP servers are not modeled yet; a static bearer in
`headers` is what exists today.

## Lifecycle

- **Connect at startup, degrade when down.** A server that is unreachable
  leaves the daemon serving everything else, with a log line naming the
  server and the config block to check; its tools appear when it comes back.
  Reconnection backs off from one second to a minute.
- **Discovery is per connect.** Tool descriptors are cached from connect to
  connect; a server that changes its list mid-run is picked up on
  reconnect. A tool discovered only then registers normally; one no longer
  advertised is unregistered — both logged, because an agent's allowlist
  may no longer mean what it meant.
- **While a server is down**, calls to its tools fail with a "not
  connected" error rather than hanging.

## Results

Tool results normalize into plain values:

- Text content comes back as a string (or under `text` when there is more).
- `structuredContent` passes through as `structured`.
- **Images, audio, and binary resources are written into the agent's
  workspace** (`~/.stratus/workspaces/<agent>/mcp/<server>/`) and returned
  under `files` — the key channels deliver as attachments, so an image from
  a bridged tool reaches Slack like a screenshot does.
- Resource links pass through under `resources`.
- A result the server marks `isError` fails the call, like any failing tool.

## What this is not

Stratus does not become an MCP *server* here (exposing its tools to other
clients is a different step with a different threat model), and MCP prompts,
resources, and sampling are out of scope beyond what tool results need.
