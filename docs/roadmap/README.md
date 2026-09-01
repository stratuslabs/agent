# Stratus Agent Roadmap

The execution plan for the [v2 architecture](../architecture/stratus-v2.md). Each step has a one-page spec: goal, why now, scope, design sketch, acceptance criteria, and open questions.

Steps 06, 09–12, and 13–14 build the capability ecosystem; the contract they share — plugins, toolsets, tools, skills — is specified once in [`plugins.md`](../architecture/plugins.md).

**Numbers are stable identifiers** — new work slots in between or after, and nothing renumbers, because every spec cross-references the others by number. The table has two halves: **shipped and parked steps first, in order**, then **everything actively planned, by priority rather than by number** — so the numbers run out of sequence on purpose. [Sequencing](#sequencing) says why each sits where it does, and within a band the order is a judgement about leverage and unblocking rather than a dependency chain — anything in the same band can start.

## The through-line

**The unit is a roster, not an agent.** Named, persistent identities with their own memory, tools, credentials, and presence, delegating to each other under one gateway. That is the thing the architecture is actually for, and [15](./15-agent-isolation.md) states the part that distinguishes it: an agent boundary *with one gateway still coordinating the fleet* — which profiles-as-separate-installs cannot do.

Two consequences for what ranks first:

- **A roster nobody can stand up is a roster nobody has.** Onboarding (16) and the management surface (17) rank above new capability, because every capability already shipped is reachable only by someone willing to hand-write a soul file and answer two configuration gates.
- **Depth over breadth.** More tools, more channels, and more execution backends are all real work with real value, and none of them makes the roster more of a roster. Where a step deepens what a *fleet* can do, it outranks a step that widens what one agent can reach.

## Steps

| Step | Spec | Status | Delivers |
| --- | --- | --- | --- |
| 01 | [The gateway: `stratus serve`, durable sessions, streaming + cancellation](./01-gateway.md) | Shipped | An always-on process with sessions that survive restarts |
| 02 | [Slack channel: contract package + per-agent bot identity](./02-slack-channel.md) | Shipped | Talk to your agents in Slack, each with its own avatar and presence |
| 03 | [Permission engine: allowlists, whitelists, headless + remote approval](./03-permissions.md) | Shipped — risk model and headless mode (#47), remote approval through Slack (#49), restart recovery (#51), agent ids as a validated invariant (#52); command scopes shipped with 06, where they finally had a caller | Agents can be trusted with real tools while unattended |
| 04 | [Agent SDK tool bridge: tools + real history on the subscription path](./04-agent-sdk-bridge.md) | Shipped — tool bridge and dispatcher-side persistence (#31, #51), SDK-native history and parity tests (#54, #55), streaming deltas with the watchdog's tool-phase signal (#56), clean restart for turns no process can resume (#57); two Slack-adapter follow-ups named in the spec | Claude-subscription agents get full tool calling under kernel policy |
| 05 | [Control API + web dashboard](./05-control-api.md) | Shipped — shared rules extracted from the CLI, gateway seams (turn ids, listable approvals, roster reload), `@stratusagent/control-api` with auth and the management group, and `@stratusagent/dashboard` on top of it; `/catalog/tools` landed with 06 | One API for every surface; a real chat/monitoring UI |
| 06 | [Tools: fs, shell, browser, web](./06-tool-packs.md) | Shipped — the plugin host and manifest enforcement, `tool-fs`, `tool-shell`, `tool-web`, `tool-browser`, the shared egress policy, the command scopes 03 deferred, and `/catalog/tools` with the dashboard screen | Reusable capability plugins agents opt into by allowlist |
| 07 | [Desktop app: install to a running agent without a terminal](./07-desktop-app.md) | Scoped, mostly unblocked, not planned — see [Not planned](#not-planned) | A signed macOS download that reaches a working agent in under two minutes, with no terminal at any point |
| 09 | [Skills: procedures an agent loads when it needs them](./09-skills.md) | Shipped — `SkillRegistry` and `skill.read` with the two-gate allowlist exemption, `skills:` in soul frontmatter, `~/.stratus/skills/` plus manifest-contributed plugin skills under qualified ids, the shared persona/memory/skills prompt renderer (the cleanup `stratus-v2.md` flagged), and the skills catalog in `/catalog/tools` | Agents that know *how*, without paying for every procedure every turn |
| 10 | [Proactive agents: schedules and outbound messages](./10-proactive.md) | Shipped — durable per-agent schedules in the session database with a gateway tick scheduler (interval floor, per-agent concurrency cap, consume-before-dispatch double-run protection, one-catch-up restart sweep), the channel contract's addressable outbound seam with its first implementation in the Slack adapter, `message.send`, the (schedule, destination) approval scope in the permission engine, and `stratus schedules` / `GET,DELETE /schedules` for operators | Agents that act without being spoken to first |
| 11 | [MCP bridge: mount any MCP server as Stratus tools](./11-mcp.md) | Shipped — `@stratusagent/plugin-mcp` (stdio + Streamable HTTP, discovery under the `mcp.*` namespace declaration, reconnect with backoff, scrubbed stdio env, images into the per-agent workspace), the registration view kept live after commit so reconnect-discovered tools register under the same gate, and the operator's per-tool `toolRisks` override as a host-owned config key | Every existing MCP server, under kernel policy |
| 12 | [Plugin discovery and distribution](./12-plugin-registry.md) | Deferred — see [Not planned](#not-planned); skills split out to [25](./25-skills-interop.md) | Finding, installing, and trusting third-party **plugins** |
| 14 | [Memory: recall the agent performs, not recall that happens to it](./14-memory.md) | Shipped — `search`, `forget`, and bounded `list` on the store contract, the derived FTS5 index with the consumed-offset + prefix-digest watermark, `memory.recall` and `memory.forget` (tombstoning, `safe`), per-entry and per-read byte caps, the alias-aware legacy merge, and prompt injection as a bounded recent slice; the dashboard memory view deferred to a follow-up | Durable, searchable memory an agent writes and reads deliberately |
| 18 | [Usage accounting: `usage` on `ProviderResponse`](./18-usage-accounting.md) | Shipped — the kernel contract as a response field **plus** a per-request `onUsage` sink (#89), because one field carries neither a harness's several inner calls nor a call that threw; attributed `UsageRecord`s the runner accumulates and the session persists, emitted with `session.completed`; all four adapters populating them, the two harness runtimes reporting per model (#90); the fallback wrapper naming and forwarding what it serves. Of the spec's open questions: completion-only, as it leaned; `model` proved available everywhere; the per-agent daily rollup stays open, for the step that needs a cap | Token accounting the runner accumulates with provider and model intact — what every cost question and every budget cap needs first |
| 23 | [Prompt caching: stop paying full price for the same prefix every turn](./23-prompt-caching.md) | Shipped (#98) — one `cache_control` breakpoint at the end of the stable head (the last system block, or the last tool for an agent with no system block), memory moved **out** of the system prompt to a `role: "system"` tail message with a remembered fallback for models that reject one, deterministic tool ordering against the MCP bridge's reconnect reshuffle, and `promptCache` / `promptCacheTtl` inherited by an Anthropic fallback. `core` grew a *tagged* view of the prompt sections rather than a new order, so the three providers that do not cache send what they always sent. The spec was corrected first, in its own commit: the cacheable minimum is 512 tokens on our default model and not monotonic, a cache read refreshes the entry for free (so 5 minutes, not an hour, is the default), and one breakpoint covers tools and system together. Per-soul override deferred | `cache_control` on the stable prefix, and the volatile section moved off it |
| 16 | [Agent templates: a working teammate in one command](./16-templates.md) | Not started — **Now** | `stratus agent new --template triage` — soul, allowlist, and both configuration gates answered as one reviewable bundle |
| 27 | [Live reload: install a skill without restarting the fleet](./27-live-reload.md) | Not started — **Now** | Skills reload live; plugins still restart, but announced and drained |
| 17 | [Fleet console: the dashboard as the management surface](./17-fleet-console.md) | Not started — **Now** | Roster, health, live sessions, pending approvals, and memory for an operator who never opens a terminal |
| 13 | [Web search: the contract the ecosystem implements](./13-search.md) | Not started — **Now** | One `web.search` shape every backend obeys, so swapping vendors changes no soul |
| 28 | [Standing grants: "always allow" means one thing everywhere](./28-standing-grants.md) | Not started — **Next** | A durable per-agent tool grant, so "always allow" survives a restart whatever it was answering |
| 19 | [Registration seams: providers, channels, and memory stores as real plugins](./19-registration-seams.md) | Not started — **Next**, in two phases | `PluginContext` grows past `{ bus, tools }` — four contribution kinds registered *by a plugin* instead of host-wired. **19A** the primitives, proved by in-repo fixtures; **19B** the real consumers |
| 24 | [Sub-agents: ephemeral helpers an agent spawns for one task](./24-sub-agents.md) | Not started — **Next** | `agent.spawn` — N ephemeral sub-agents in parallel, each with a narrowed slice of the parent's capabilities, results returned together |
| 25 | [Skills interop: conform to the standard, consume the ecosystem](./25-skills-interop.md) | Not started — **Next** | A skill written for the open standard works here, and one written here works elsewhere |
| 15 | [Agent isolation: per-agent state, process-per-agent, containerized execution](./15-agent-isolation.md) | Not started — layer A **Next**, layers B/C **Later** | The agent as a boundary: state, credentials, and execution that are structurally its own |
| 21 | [Team knowledge: shared skills and roster-scoped memory](./21-team-knowledge.md) | Not started — **Next** | One agent learns a procedure, a human reviews it, the whole roster has it — and an explicit answer for what memory is shared and what stays private |
| 20 | [Discord channel: the second adapter](./20-channel-discord.md) | Not started — **Next** | A second surface, and the proof that `@stratusagent/channels` is a contract rather than a Slack-shaped hole |
| 22 | [Slack single-app mode: the whole roster on one app](./22-slack-single-app.md) | Not started — **Next** | A second identity mode in `channel-slack`, for workspaces where one app per agent is not something an admin will approve |
| 26 | [Fleet introspection: read-only tools for an agent watching the fleet](./26-fleet-introspection.md) | Not started — **Later** | `fleet.*` reads, so a fleet-watcher is a soul with a schedule rather than a subsystem |
| 08 | [Deployment profiles: single-tenant VM, hosted multi-tenant, credential leases](./08-deployment-profiles.md) | Not started | Non-local deployments as configurations of the framework |

## Sequencing

### Now — make the roster reachable


- **[16](./16-templates.md) — templates.** The highest-leverage item on this page. It removes the onboarding cost *without weakening either gate*, which is the only acceptable way to remove it: a template answers both gates as one bundle somebody reviewed, rather than removing either gate.
- **[27](./27-live-reload.md) — live reload.** Souls already hot-reload; skills and plugins do not, so installing either restarts the daemon — dropping every agent's channel connection at once for a change that concerned one agent. Skills are the case people meet on their second day and the easy half: prose read from disk, no code imported. Plugins keep their restart deliberately, but an announced and drained one.
- **[17](./17-fleet-console.md) — fleet console.** The API and the dashboard both exist; this makes the dashboard the surface rather than a viewer, for the operator who is never going to run `stratus schedules` at a prompt.
- **[13](./13-search.md) — `web.search`.** An agent that can fetch a URL but cannot find one is a capability that invites fabrication, which is 13's own framing and it is right. Contract here, backends in the ecosystem.

### Next — compound what a fleet can do

- **[19](./19-registration-seams.md) — registration seams: providers, channels, and memory stores as plugins.** Four of the seven advertised contribution kinds are host-wired. `PluginContext` is `{ bus, tools }`, so `setup` has no way to register a provider, a channel, a memory store, or an executor — which is why `provider-codex` is a hardcoded case inside `createRuntimeProvider` and the Slack adapter is wired by the CLI. It splits in two, because the proof cannot precede the seam: **19A** lands the registration handles, the manifest-bound views, collision behavior, the host-owned path for channel transport secrets, and in-repository fixture plugins proving each registry; **19B** converts one first-party provider and carries Discord ([20](./20-channel-discord.md)) through the seam. Executors ride along. It is also the step that makes `plugins.md` describe the system rather than the intention.
- **[28](./28-standing-grants.md) — standing grants.** There are two "always allow"s and they behave differently: a command scope is durable and per-agent, a tool-wide always dies with the session. Same button, same sentence, different lifetime, and an operator cannot tell which they got. It also leaves a gap nobody chose — in `headless`, a `gated` tool with no command and no destination has no path to running unattended at all. [24](./24-sub-agents.md) needs it to inherit anything but command scopes, and [26](./26-fleet-introspection.md) had to argue around it.
- **[24](./24-sub-agents.md) — sub-agents.** `agent.spawn` starts N ephemeral helpers in parallel, each with a task and a narrowed slice of the parent's capabilities. Two arguments: context offloading, where five sub-agents that each read one page leave the parent with a thousand tokens instead of fifty thousand, on a cheaper model — a larger lever than [23](./23-prompt-caching.md) and applied per task rather than once; and parallelism, which is not available at all today, since `runToolCalls` is a sequential `for await` and five delegate calls take five times the wall clock of one. Deliberately a **fan-out tool** rather than a parallel kernel loop: the approval checkpoint carries `remaining: calls.slice(index + 1)` and crash recovery depends on that ordering, so parallelizing the kernel would drag both in. Capabilities are a subset of the parent's — the opposite of `agent.delegate`'s rule, and the spec says why.
- **[25](./25-skills-interop.md) — skills interop.** `SKILL.md` is an open standard read by roughly thirty tools, with a third-party package manager and a large public index already over it. [09](./09-skills.md) already chose that format, so conformance is small work for outsized leverage — a skills story that starts from an existing corpus rather than from zero.
- **[15](./15-agent-isolation.md) layer A — per-agent state.** Makes "sessions never cross" structural rather than enforced, and pre-decides half of [08](./08-deployment-profiles.md).
- **[21](./21-team-knowledge.md) — team knowledge.** A procedure one agent worked out is useful to the whole roster, and today there is no path from the first to the second that a human reviews. This is also where the shared-versus-private memory boundary gets decided, which [14](./14-memory.md) left open and every multi-agent deployment hits.
- **[20](./20-channel-discord.md) — Discord.** In the monorepo first (see [Ground rules](#ground-rules)), landing through [19A](./19-registration-seams.md)'s seam and thereby completing 19B, and moved out only once the contract has stopped moving.
- **[22](./22-slack-single-app.md) — Slack single-app mode.** One app per agent buys the best identity — own avatar, own presence, own DMs — at the highest setup cost in the product: a five-agent roster is five Slack apps, five admin approvals, five token pairs, and five socket connections. Plenty of workspaces will not approve that, and the answer belongs in the adapter as a second identity mode rather than in whatever is deploying it.

### Later

- **[26](./26-fleet-introspection.md) — fleet introspection.** An agent has no way to see the fleet: `schedule.list` exists, and nothing exposes a stuck session, a repeatedly failing schedule, or a queue nobody has looked at. Add read-only `fleet.*` and the fleet-watcher everyone wants becomes a soul with a schedule — a [16](./16-templates.md) template rather than a subsystem. Read-only, `gated`, and out of every default allowlist: it is the most privileged read in the system. Held here because [17](./17-fleet-console.md) may make the digest redundant, which is worth finding out first.
- **[08](./08-deployment-profiles.md) — deployment profiles.**
- **[15](./15-agent-isolation.md) layers B/C — process-per-agent and containerized execution.**
- **First plugins published outside this repository** — per-vendor service tools (GitHub, Linear, Notion). These need no seam that does not already exist and can start any time; they are here rather than in Now only because nothing else is blocked on them.

### Not planned

- **[07](./07-desktop-app.md) — desktop app.** Rewritten and scoped rather
  than revived. The step it used to be — a second native surface for managing
  agents — is still [17](./17-fleet-console.md)'s job and is still not worth
  duplicating; what it is now is a distribution and lifecycle vehicle for the
  people every path into this product currently loses at a terminal. The
  runtime questions are settled in
  [07-runtime-spike.md](./07-runtime-spike.md) — a shipped Node, a prebuilt
  package tree, no package manager at first run.

  **What it still needs is not all in this step**, and the spec's `Depends on`
  and `Open questions` carry the list rather than this bullet duplicating it.
  Four shapes of work: **kernel** — every runtime import of the two optional
  providers out of `state` and the CLI, and a migration fencing protocol that
  stops or fences *any* active state-writing process, not only `stratusd`;
  **API** — a template read, an atomic apply (since `POST /agents` carries no
  allowlists or plugin configuration while [16](./16-templates.md) requires the
  soul and the config to commit together), and a sign-in capability descriptor,
  because the API can perform a sign-in but cannot describe one; **an unrun spike** — whether
  `claude setup-token` can be captured without a TTY, which decides one of the
  five sign-in paths; and **the onboarding sequence itself**, deliberately
  unwritten after a detailed version was specified and falsified repeatedly
  under review, leaving the constraints any design must satisfy in place of a
  design. It is scoped so that it can start when it is chosen, not because it
  is scheduled.
- **[12](./12-plugin-registry.md) — plugin registry.** Deferred, and now narrower. Discovery and distribution for an ecosystem that does not exist yet is a platform built for nobody; the trigger to revisit is third-party plugins existing that we did not write, and [19](./19-registration-seams.md) is a prerequisite either way — there is no point distributing channel or provider plugins that nothing can register.

  **Skills are the half that was never really deferred**, because that reasoning does not apply to them: the standard exists, the ecosystem exists, and somebody else already built the distribution. That is [25](./25-skills-interop.md), and it needs no registry of ours at all.

## Ground rules

- Every step lands behind the existing kernel seams (`packages/core/src/index.ts`) — new capability means a new plugin, not a bigger kernel.
- Surfaces never own an agent loop; they consume the gateway API.
- A step's spec is *light* on purpose: enough to start and to know when you're done. Design detail beyond that belongs in the PR that implements it.
- **A plugin moves outside this repository when its contract has stopped moving and a seam exists to register it.** Tools and skills clear both bars today, which is why `stratuslabs/skill-*` already lives outside. Channels, providers, memory stores, and executors clear neither until 19 — which is why Discord (20) is built here first and moved afterwards. Publishing across repositories against a contract still under change is the expensive version of this mistake; the cheap version is one `git mv` later.
