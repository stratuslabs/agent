# 11 — MCP bridge: mount any MCP server as Stratus tools

## Goal

A plugin that connects to Model Context Protocol servers and registers their
tools in the `ToolRegistry` — under the same allowlist, the same risk model,
and the same approval policy as a tool written for Stratus.

## Status

**Shipped.** `@stratusagent/plugin-mcp`, plus the one seam the plugin host
was missing for it.

- **The bridge.** Configured per server (stdio command or Streamable HTTP
  endpoint, each with its own env grants or headers), it discovers tools at
  connect and registers them as `mcp.<server>.<tool>` through the
  manifest-bound view, under `toolsDiscovered: [{ "namespace": "mcp.*",
  "risk": "gated" }]`. Results normalize into `JsonValue`; images, audio,
  and binary resources land in the per-agent workspace and return under
  `files`, the key channels upload — which is how a bridged image reaches
  Slack.
- **The view stays live after commit.** The registration view used to be
  staging that ended at load, so a tool discovered on reconnect had nowhere
  to go. It now keeps working for a committed plugin — the identical gate,
  applied late: an undeclared name is rejected exactly as at first load, and
  `unregister` reaches only the plugin's own names. The plugin's tool
  records are live too, so `/catalog/tools` and the gateway's provenance
  answer for reconnect-discovered tools without being told.
- **Risk is ours, enforced in two layers.** Every bridged tool floors at
  `gated` (a `readOnlyHint` from the server changes nothing), and the
  per-tool override became the host-owned `toolRisks` config key — applied
  by the view, stripped from what the plugin's code sees, so the word that
  lowers a tool's risk is only ever the operator's. It generalizes to every
  plugin, and the third-party floor still binds it.
- **Lifecycle.** Connect at startup with a per-server timeout; an
  unreachable server leaves the daemon serving everything else, with an
  install-hint-style line naming the config block, and reconnects with
  backoff (1s doubling to 60s). Reconnect re-lists and diffs: additions
  register, removals unregister, both logged because an allowlist may no
  longer mean what it meant. Two server tool names folding to one bridged
  name refuse the server rather than letting one answer for the other.
- **Environment scrubbing.** A stdio server's environment is replaced, not
  inherited — the default pass list (`PATH`, `HOME`, `LANG`, `LC_ALL`,
  `TZ`) moved to core as `DEFAULT_SUBPROCESS_PASS_ENV` so `tool-shell` and
  the bridge share one answer — proven by a test that spawns a real stdio
  server and reads its env: `ANTHROPIC_API_KEY` is not there.

Of the open questions below: bridged tools already appear differently in
`GET /catalog/tools` — every plugin tool carries `package` provenance, and
the `mcp.<server>.` prefix says whose code it is — so no separate marking
was added. OAuth-authenticated HTTP servers stay deferred; a static bearer
in `headers` is what exists.

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
- **The manifest declares a namespace, not names.** This is the one plugin that
  cannot enumerate its contributions: names arrive from the server at connect
  and change when the server changes. So the package declares
  `toolsDiscovered: [{ "namespace": "mcp.*", "risk": "gated" }]` and the
  manifest-bound registration view in
  [`plugins.md`](../architecture/plugins.md) accepts discovered names inside
  that namespace — on first connect and identically on reconnect — while still
  rejecting anything outside it. Without the namespace form the bridge would be
  refused by its own contract; with it, the bridge still cannot register
  `fs.write`.
- **Risk assignment is ours, not the server's.** MCP has no risk vocabulary,
  and a remote server's self-description is exactly the input the trust model
  says not to take at face value. Every bridged tool floors at `gated` — the
  namespace's declared risk is a ceiling on what discovery may claim, never a
  floor the bridge lowers — with per-tool overrides in config for an operator
  who has read the server.
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
- A tool discovered only on reconnect registers successfully, and a server
  advertising a tool named outside `mcp.*` is refused — the pair that proves the
  namespace declaration is a boundary rather than a formality.
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
