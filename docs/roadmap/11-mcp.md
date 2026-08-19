# 11 — MCP bridge: mount any MCP server as Stratus tools

## Goal

A plugin that connects to Model Context Protocol servers and registers their
tools in the `ToolRegistry` — under the same allowlist, the same risk model,
and the same approval policy as a tool written for Stratus.

## Why now

[06](./06-tool-packs.md) names MCP client support as out of scope and "worth a
future step of its own"; this is that step. It sits here rather than earlier
because the pack convention had to exist first — the bridge is a plugin, and
writing it before [`plugins.md`](../architecture/plugins.md) settled would have
made it *the* extension mechanism instead of one of them.

Its value is disproportionate: it is one package, and it makes the ecosystem
non-empty on the day it lands. Every MCP server anyone has already written
becomes available to a Stratus agent without that author knowing Stratus
exists. Nothing else on the roadmap has that ratio.

## Scope

**In:**

- **`@stratusagent/plugin-mcp`** — configured with a list of servers (stdio
  command or HTTP endpoint), each with its own credential grants. Discovers
  tools at load and registers them namespaced by server:
  `mcp.<server>.<tool>`, so a soul allowlists `mcp.linear.*` and an operator
  can see at a glance which tools are foreign.
- **Risk assignment is ours, not the server's.** MCP has no risk vocabulary,
  and a remote server's self-description is exactly the input the trust model
  says not to take at face value. Every bridged tool floors at `gated`, with
  per-tool overrides in config for an operator who has read the server.
- **Schema translation** both ways, and result normalization into `JsonValue`,
  including MCP's content blocks (text, images, resources) — images land in the
  per-agent workspace directory 06 introduces, so channels can upload them.
- **Lifecycle**: connect at startup, reconnect with backoff, and a server that
  is down degrades to its tools being unavailable rather than failing the
  daemon's start.
- **Environment scrubbing for stdio servers** — a subprocess MCP server is a
  subprocess, and gets the replacement-environment treatment `tool-shell`
  introduced, not the daemon's env.

**Out:** Stratus *as* an MCP server (exposing our tools to other clients — a
different step with a different threat model); MCP prompts and resources as
first-class concepts beyond what tool results need; sampling.

## Design sketch

- The bridge depends on `core` only, like every other plugin, and takes its
  server list through its factory rather than through `PluginContext`.
- Tool descriptors are built once at connect and cached; a server that changes
  its tool list mid-run is picked up on reconnect, and the change is logged
  because an agent's allowlist may no longer mean what it meant.
- A tool name that collides after namespacing is a load-time error, per the
  trust model.
- The Claude subscription path ([04](./04-agent-sdk-bridge.md)) already exposes
  kernel tools to the Agent SDK over in-process MCP. This step is the mirror
  image and deliberately does not share code with it — one is a server we host,
  the other a client we drive.

## Acceptance criteria

- A published MCP server configured in `~/.stratus/config.json` has its tools
  callable by an agent whose soul allowlists them, and *not* by one that does
  not.
- A bridged tool defaults to `gated` even when the server describes it as
  read-only; the override is explicit and per tool.
- A stdio server cannot read `ANTHROPIC_API_KEY` from its environment.
- A server that is unreachable at startup leaves the daemon serving every other
  agent normally, with an install-hint-style log line.
- An image returned by a bridged tool reaches Slack.

## Open questions

- Do bridged tools appear in `GET /api/v1/catalog/tools` differently from
  native ones? Leaning yes — an operator deciding what to allowlist should know
  which tools are somebody else's code.
- OAuth-authenticated HTTP servers need a token flow the credential store does
  not model yet. Deferred until a server we actually want requires it.
