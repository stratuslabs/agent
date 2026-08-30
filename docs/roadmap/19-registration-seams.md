# 19 — Registration seams: providers, channels, and memory stores as real plugins

## Goal

`PluginContext` grows past `{ bus, tools }`, so a plugin's `setup` can register
a **provider**, a **channel**, a **memory store**, or an **executor** — the four
contribution kinds [`plugins.md`](../architecture/plugins.md) advertises and the
host currently wires by hand.

## Why now

`plugins.md` describes seven contribution kinds. Three of them work. The
interfaces for the other four all exist and are all good — `ModelProvider`,
`ChannelAdapter`, `AgentMemoryStore`, `Executor` — but `PluginContext` is
`{ bus, tools }`, so `setup` is handed no way to register one. The result is
that every one of them is host-wired: `provider-codex` is a hardcoded third
case inside `createRuntimeProvider` in `@stratusagent/state`, and the Slack
adapter is constructed by the CLI.

The cost is visible in the record. `stratus-v2.md`'s own account of adding the
Codex provider lists what a "plugin" cost to add: `StratusProviderName` and
`CredentialProviderName` are closed unions, so the third name had to reach
`verifyProviderKey`, `defaultApiKeyEnvName`, the setup menu, the credentials
route in `control-api`, `PROVIDERS` in the dashboard, the `FallbackRuntime`
union, and the gateway's `streamsDeltas`. That is what shipping a provider
costs today, and it is why nobody outside this repository will ship one.

It is also the gate on everything downstream. [20](./20-channel-discord.md)
should register itself rather than be wired in; [12](./12-plugin-registry.md)
is pointless while the interesting plugin kinds cannot be loaded; and
[15](./15-agent-isolation.md)'s layers B and C want an executor that arrives as
a package.

## Scope

**In:**

- **Registration handles on `PluginContext`** for providers, channels, memory
  stores, and executors, each following the shape `tools` already established:
  a manifest-bound view, not the raw registry.
- **The manifest declares what a plugin contributes, and the view enforces it.**
  This is the rule 06 established for tools and the reason it exists is
  unchanged: `ToolRegistry.register` is a bare `Map.set` retaining no
  provenance, so a plugin handed a raw registry can register something it never
  declared. A plugin that declares a channel and registers a provider is a
  load-time error.
- **A scoped `CredentialResolver` and the plugin's own config block on the
  context**, so an honest plugin declares what it needs by name instead of
  reaching into ambient environment. Stated plainly, because it is stated in
  `stratus-v2.md` and worth not losing: this makes the manifest *auditable*, it
  is not an isolation boundary. In-process code can always read `process.env`.
- **Opening the closed unions.** `StratusProviderName` and
  `CredentialProviderName` become extensible, and the surfaces that enumerate
  them — setup, `control-api`, the dashboard — read a registry rather than a
  literal. This is most of the work in the step and none of the interest.
- **One plugin of each kind as proof**, because a seam with no consumer is a
  seam that does not work yet:
  - a **provider** plugin outside this repository (OpenRouter or Ollama),
  - a **channel**: Discord (20) registering through the seam,
  - a **memory store** behind `AgentMemoryStore` that is not JSONL-plus-FTS5,
  - an **executor**, which may be as small as a wrapper proving the shape.

**Out:**

- Changing any of the four interfaces. They are right; what is missing is a way
  to hand one over. If one turns out to be wrong, that is a finding, not scope.
- Isolation between plugins. In-process code is in-process code, and pretending
  a registration view changes that would be the false promise
  [15](./15-agent-isolation.md) is careful to avoid making.
- Discovery, installation, and trust. Still 12. A plugin runs only when it is
  listed and enabled in a **trusted** config, and this step does not soften
  that by one word.
- Registering a *second* provider for the same name, or a second channel for
  the same agent. Collisions are load-time errors, exactly as tool names are.

## Design sketch

- `PluginContext` grows by four optional-to-use handles, not by a redesign.
  Existing plugins compile untouched, which is the test of whether the shape
  is additive.
- Registration order stays deterministic and is decided by the `plugins` config
  block. A fleet whose behavior depends on load order is one nobody can debug.
- Memory stores register per-agent-resolvable, not process-global. `tool-fs`
  already carries the reason in place — caching at setup would hand every agent
  the first agent's roots — and a memory store making that mistake would hand
  every agent the first agent's memories.
- The `dispose` contract already exists on `Plugin` and now matters more: a
  channel plugin holds a socket, an executor may hold a subprocess. Shutdown
  ordering is the documented one — channels stop, then plugins dispose.
- The provider registry has to satisfy `createRuntimeProvider`'s existing
  callers unchanged, including the fallback wrapper that crosses providers
  mid-run. That wrapper is the sharpest test of the seam: it constructs two
  providers by name from configuration.

## Acceptance criteria

- A provider plugin in a separate repository, installed and enabled by config,
  is selectable by a soul's `provider:` and serves a run — with no edit to any
  file in this monorepo.
- The same provider works as a fallback target, proving the registry satisfies
  `FallbackRuntime` rather than only the primary path.
- A channel plugin registers and receives inbound messages without the CLI or
  gateway naming it.
- A memory store plugin backs `memory.remember` and `memory.recall` for an
  agent, and two agents using it do not observe each other's entries.
- A plugin that registers a contribution kind its manifest does not declare
  fails at load, and the failure names the package and the undeclared kind.
- Two plugins registering the same provider name fail at load rather than one
  silently winning.
- A plugin resolves a credential it declared and is refused one it did not.
- Every existing first-party plugin still loads with no manifest change.

## Open questions

- **Do the host-wired providers become plugins in this step, or after it?**
  Converting `provider-anthropic`, `provider-claude-code`, and `provider-codex`
  proves the seam properly and is a large diff through the CLI, gateway, and
  setup. Leaning: land the seam with an external proof first, convert the
  first-party three as a follow-up, so a regression in the conversion is not a
  regression in the seam.
- **Does the soul's `provider:` accept a package name?** A registered provider
  needs a name a soul can select, and package names are the unique identifier
  `plugins.md` already chose for skills. The counter-argument is that
  `provider: anthropic` is what people will keep writing.
- **What does a channel plugin do about per-agent transport secrets?** The
  invariant is firm — channel tokens live under `channels.slack.<agentId>` and
  are never resolved through the agent-scoped resolver, because an agent must
  not read the tokens of the transport carrying it. A third-party channel
  plugin needs its tokens by some path that keeps that true, and the scoped
  resolver is deliberately the wrong one.
