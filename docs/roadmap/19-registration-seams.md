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

## Two phases, because the proof cannot precede the seam

An earlier draft of this step asked for one *external* plugin of each kind as
its proof, including Discord — which is [20](./20-channel-discord.md), which
registers through this step. That made 19 and 20 each other's prerequisites,
with no point at which either could be called done. It also asked for a plugin
in another repository while this step is the one still moving the contract,
which the roadmap's own externalization rule forbids.

So the work splits, and the split is the fix:

### 19A — the primitives

Finishable on its own, proved from inside this repository.

**In:**

- **Registration handles on `PluginContext`** for providers, channels, memory
  stores, and executors, each following the shape `tools` already established:
  a manifest-bound view, not the raw registry.
- **The manifest declares what a plugin contributes, and the view enforces it.**
  This is the rule 06 established for tools and the reason is unchanged:
  `ToolRegistry.register` is a bare `Map.set` retaining no provenance, so a
  plugin handed a raw registry can register something it never declared. A
  plugin that declares a channel and registers a provider is a load-time error.
- **Collision behavior**, decided and tested: two plugins registering the same
  provider name, or a second channel for one agent, fail at load. A tool name
  is unique per install and these are no different.
- **A scoped `CredentialResolver` and the plugin's own config block on the
  context**, so an honest plugin declares what it needs by name instead of
  reaching into ambient environment. Stated plainly because `stratus-v2.md`
  states it and it is worth not losing: this makes the manifest *auditable*, it
  is not an isolation boundary. In-process code can always read `process.env`.
- **A host-owned path for channel transport secrets — a prerequisite, not an
  open question.** The invariant is firm: channel tokens live under
  `channels.slack.<agentId>`, are host-owned, and are never resolved through
  the agent-scoped resolver, because an agent must not read the tokens of the
  transport carrying it. A channel plugin therefore cannot initialize at all
  until it has some other defined way to receive them. 19A defines it; without
  it there is no such thing as a registerable channel.
- **Opening the closed unions.** `StratusProviderName` and
  `CredentialProviderName` become extensible, and the surfaces that enumerate
  them — setup, `control-api`, the dashboard — read a registry rather than a
  literal. Most of the work in the step and none of the interest.
- **In-repository fixture plugins, one per kind**, under `test/`. Each
  registers through its handle and is exercised end to end. Fixtures rather
  than products, because the point of 19A is that the seam works, and a fixture
  proves that without importing somebody else's API or a second repository's
  release cycle.

### 19B — the real consumers

**In:**

- **Convert one first-party provider** to register through the seam — the
  smallest of the three — proving the registry satisfies real callers,
  including the fallback wrapper that constructs two providers by name from
  configuration.
- **[20](./20-channel-discord.md) lands through the seam** rather than wired in
  the CLI. 20 is where that is delivered and tested; 19B is done when the seam
  carried it.
- **A memory store that is not JSONL-plus-FTS5**, proving `AgentMemoryStore`
  holds for a different shape. Small; an embeddings-backed store is the obvious
  candidate and does not have to be a good one to prove the point.

**Out of both phases:**

- **A plugin in another repository.** That is the follow-up, and it is gated on
  the roadmap's externalization rule: the contract has to have stopped moving
  first, which by definition it has not while this step is moving it.
- Changing any of the four interfaces. They are right; what is missing is a way
  to hand one over. If one turns out to be wrong, that is a finding, not scope.
- Converting the remaining first-party providers and the Slack adapter. Worth
  doing, larger than this step, and a regression there should not read as a
  regression in the seam.
- Isolation between plugins. In-process code is in-process code, and pretending
  a registration view changes that would be the false promise
  [15](./15-agent-isolation.md) is careful to avoid making.
- Discovery, installation, and trust. Still 12. A plugin runs only when it is
  listed and enabled in a **trusted** config, and this step does not soften
  that by one word.

## Design sketch

- `PluginContext` grows by four handles, not by a redesign. Existing plugins
  compile untouched, which is the test of whether the shape is additive.
- Registration order stays deterministic and is decided by the `plugins` config
  block. A fleet whose behavior depends on load order is one nobody can debug.
- Memory stores register per-agent-resolvable, not process-global. `tool-fs`
  already carries the reason in place — caching at setup would hand every agent
  the first agent's roots — and a memory store making that mistake would hand
  every agent the first agent's memories.
- The `dispose` contract already exists on `Plugin` and now matters more: a
  channel plugin holds a socket, an executor may hold a subprocess. Shutdown
  ordering is the documented one — channels stop, then plugins dispose.

## Acceptance criteria

**19A:**

- A fixture plugin of each of the four kinds registers through its handle and
  is exercised: a provider serves a run, a channel receives an inbound message,
  a memory store backs `memory.remember` and `memory.recall`, an executor runs
  a command.
- Two fixture agents using the fixture memory store do not observe each other's
  entries.
- A plugin that registers a contribution kind its manifest does not declare
  fails at load, naming the package and the undeclared kind.
- Two plugins registering the same provider name fail at load rather than one
  silently winning.
- A plugin resolves a credential it declared and is refused one it did not.
- A channel plugin receives its transport secrets through the host-owned path,
  and no agent can resolve them.
- Every existing first-party plugin still loads with no manifest change.

**19B:**

- The converted first-party provider serves a run selected by a soul's
  `provider:`, and also works as a **fallback target**.
- Discord runs with neither the CLI nor the gateway naming it.
- The non-default memory store backs an agent's memory end to end.

## Open questions

- **Does the soul's `provider:` accept a package name?** A registered provider
  needs a name a soul can select, and package names are the unique identifier
  `plugins.md` already chose for skills. The counter-argument is that
  `provider: anthropic` is what people will keep writing.
- **Which first-party provider gets converted in 19B?** Leaning the
  OpenAI-compatible adapter in `providers`: it is the plainest of the shapes,
  so a conversion problem there is a seam problem rather than a harness
  problem.
- **Do fixtures live in one package or beside each seam?** One place is easier
  to keep coherent; beside each seam is easier to find. Minor, but decide
  before there are four of them in two conventions.
