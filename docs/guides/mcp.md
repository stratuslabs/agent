# MCP

`@stratusagent/plugin-mcp` is the bridge to the
[Model Context Protocol](https://modelcontextprotocol.io) ecosystem: any
MCP server's tools become Stratus tools under the same policy as everything
else, named `mcp.<server>.<tool>` and discovered when the server connects.

```bash
npm install -g @stratusagent/plugin-mcp
```

Like every plugin, it is enabled in a
[trusted config](../concepts/plugins.md) and granted per agent through the
soul's allowlist — `tools: [mcp.linear.*]` grants one server:

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "@stratusagent/plugin-mcp": {
      "enabled": true,
      "servers": { /* stdio or Streamable HTTP servers — see the package README */ }
    }
  }
}
```

## The posture

- **Every bridged tool is `gated`**, regardless of how the server describes
  itself — the operator's per-tool `toolRisks` entry is the only thing that
  lowers one. A server's self-description is not a security decision your
  daemon inherits.
- **A stdio server's environment is replaced** the way
  [`tool-shell`'s](./tools.md) is: it gets what you granted and nothing
  else, not the daemon's own environment.
- Reconnects (with backoff) keep discovered tools registered under the same
  gate; images a server returns land in the per-agent workspace.

Server settings, transports, and lifecycle are documented in the
[`@stratusagent/plugin-mcp` README](../../packages/plugin-mcp/README.md),
which is canonical for the bridge. How gating and approval work once a tool
is mounted: [Approvals](./approvals.md).
