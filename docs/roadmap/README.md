# Stratus Agent Roadmap

The execution plan for the [v2 architecture](../architecture/stratus-v2.md). Each step has a one-page spec: goal, why now, scope, design sketch, acceptance criteria, and open questions.

Steps 06, 09–12, and 13–14 build the capability ecosystem; the contract they share — plugins, toolsets, tools, skills — is specified once in [`plugins.md`](../architecture/plugins.md).

Steps are ordered by dependency, not by calendar. Numbers are stable identifiers — new work slots in between or after, it doesn't renumber.

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
| 07 | [macOS app: visual agent creation and management](./07-macos-app.md) | **Dropped** — see [Not doing](#not-doing) | ~~Create and manage agents without the CLI~~ |
| 08 | [Deployment profiles: single-tenant VM, hosted multi-tenant, credential leases](./08-deployment-profiles.md) | Not started | Non-local deployments as configurations of the framework |
| 09 | [Skills: procedures an agent loads when it needs them](./09-skills.md) | Shipped — `SkillRegistry` and `skill.read` with the two-gate allowlist exemption, `skills:` in soul frontmatter, `~/.stratus/skills/` plus manifest-contributed plugin skills under qualified ids, the shared persona/memory/skills prompt renderer (the cleanup `stratus-v2.md` flagged), and the skills catalog in `/catalog/tools` | Agents that know *how*, without paying for every procedure every turn |
| 10 | [Proactive agents: schedules and outbound messages](./10-proactive.md) | Shipped — durable per-agent schedules in the session database with a gateway tick scheduler (interval floor, per-agent concurrency cap, consume-before-dispatch double-run protection, one-catch-up restart sweep), the channel contract's addressable outbound seam with its first implementation in the Slack adapter, `message.send`, the (schedule, destination) approval scope in the permission engine, and `stratus schedules` / `GET,DELETE /schedules` for operators | Agents that act without being spoken to first |
| 11 | [MCP bridge: mount any MCP server as Stratus tools](./11-mcp.md) | Shipped — `@stratusagent/plugin-mcp` (stdio + Streamable HTTP, discovery under the `mcp.*` namespace declaration, reconnect with backoff, scrubbed stdio env, images into the per-agent workspace), the registration view kept live after commit so reconnect-discovered tools register under the same gate, and the operator's per-tool `toolRisks` override as a host-owned config key | Every existing MCP server, under kernel policy |
| 12 | [Plugin discovery and distribution](./12-plugin-registry.md) | Deferred — see [Not doing](#not-doing) | Finding, installing, and trusting third-party plugins |
| 13 | [Web search: the contract the ecosystem implements](./13-search.md) | Not started — **Now** | One `web.search` shape every backend obeys, so swapping vendors changes no soul |
| 14 | [Memory: recall the agent performs, not recall that happens to it](./14-memory.md) | Shipped — `search`, `forget`, and bounded `list` on the store contract, the derived FTS5 index with the consumed-offset + prefix-digest watermark, `memory.recall` and `memory.forget` (tombstoning, `safe`), per-entry and per-read byte caps, the alias-aware legacy merge, and prompt injection as a bounded recent slice; the dashboard memory view deferred to a follow-up | Durable, searchable memory an agent writes and reads deliberately |
| 15 | [Agent isolation: per-agent state, process-per-agent, containerized execution](./15-agent-isolation.md) | Not started — layer A **Next**, layers B/C **Later** | The agent as a boundary: state, credentials, and execution that are structurally its own |
| 16 | [Agent templates: a working teammate in one command](./16-templates.md) | Not started — **Now** | `stratus agent new --template triage` — soul, allowlist, and both configuration gates answered as one reviewable bundle |
| 17 | [Fleet console: the dashboard as the management surface](./17-fleet-console.md) | Not started — **Now** | Roster, health, live sessions, pending approvals, and memory for an operator who never opens a terminal |
| 18 | [Usage accounting: `usage` on `ProviderResponse`](./18-usage-accounting.md) | Not started — **Now** | Token accounting the runner accumulates with provider and model intact — what every cost question and every budget cap needs first |
| 19 | [Registration seams: providers, channels, and memory stores as real plugins](./19-registration-seams.md) | Not started — **Next**, in two phases | `PluginContext` grows past `{ bus, tools }` — four contribution kinds registered *by a plugin* instead of host-wired. **19A** the primitives, proved by in-repo fixtures; **19B** the real consumers |
| 20 | [Discord channel: the second adapter](./20-channel-discord.md) | Not started — **Next** | A second surface, and the proof that `@stratusagent/channels` is a contract rather than a Slack-shaped hole |
| 21 | [Team knowledge: shared skills and roster-scoped memory](./21-team-knowledge.md) | Not started — **Next** | One agent learns a procedure, a human reviews it, the whole roster has it — and an explicit answer for what memory is shared and what stays private |
| 22 | [Slack single-app mode: the whole roster on one app](./22-slack-single-app.md) | Not started — **Next** | A second identity mode in `channel-slack`, for workspaces where one app per agent is not something an admin will approve |

## Sequencing

### Now — make the roster reachable

- **16 — templates.** The highest-leverage item on this page. It removes the onboarding cost *without weakening either gate*, which is the only acceptable way to remove it: a template answers both gates as one bundle somebody reviewed, rather than removing either gate.
- **17 — fleet console.** The API and the dashboard both exist; this makes the dashboard the surface rather than a viewer, for the operator who is never going to run `stratus schedules` at a prompt.
- **13 — `web.search`.** An agent that can fetch a URL but cannot find one is a capability that invites fabrication, which is 13's own framing and it is right. Contract here, backends in the ecosystem.
- **18 — usage accounting.** A small kernel change with an outsized reach: the vendor SDKs return token usage and the adapters discard it, so today no part of the system can answer what a run cost. Budget caps, per-agent cost reporting, and the console's session view all need this first, and none of them can be built until it exists.

### Next — compound what a fleet can do

- **19 — registration seams: providers, channels, and memory stores as plugins.** Four of the seven advertised contribution kinds are host-wired. `PluginContext` is `{ bus, tools }`, so `setup` has no way to register a provider, a channel, a memory store, or an executor — which is why `provider-codex` is a hardcoded case inside `createRuntimeProvider` and the Slack adapter is wired by the CLI. It splits in two, because the proof cannot precede the seam: **19A** lands the registration handles, the manifest-bound views, collision behavior, the host-owned path for channel transport secrets, and in-repository fixture plugins proving each registry; **19B** converts one first-party provider and carries Discord (20) through the seam. Executors ride along. It is also the step that makes `plugins.md` describe the system rather than the intention.
- **20 — Discord.** In the monorepo first (see [Ground rules](#ground-rules)), landing through 19A's seam and thereby completing 19B, and moved out only once the contract has stopped moving.
- **21 — team knowledge.** A procedure one agent worked out is useful to the whole roster, and today there is no path from the first to the second that a human reviews. This is also where the shared-versus-private memory boundary gets decided, which 14 left open and every multi-agent deployment hits.
- **22 — Slack single-app mode.** One app per agent buys the best identity — own avatar, own presence, own DMs — at the highest setup cost in the product: a five-agent roster is five Slack apps, five admin approvals, five token pairs, and five socket connections. Plenty of workspaces will not approve that, and the answer belongs in the adapter as a second identity mode rather than in whatever is deploying it.
- **15 layer A — per-agent state.** Makes "sessions never cross" structural rather than enforced, and pre-decides half of 08.

### Later

- **08 — deployment profiles.**
- **15 layers B/C — process-per-agent and containerized execution.**
- **First plugins published outside this repository** — per-vendor service tools (GitHub, Linear, Notion). These need no seam that does not already exist and can start any time; they are here rather than in Now only because nothing else is blocked on them.

### Not doing

- **07 — macOS app.** Dropped. Its stated job — creating and managing agents visually — is what 17 delivers, sooner and on every platform, against an API that already exists. A second native surface for the same job is not worth what it costs to keep current. Nothing here forecloses picking it up again.
- **12 — plugin registry.** Deferred, not dropped. Discovery and distribution for an ecosystem that does not exist yet is a platform built for nobody; the trigger to revisit is third-party plugins existing that we did not write. Note that 19 is a genuine prerequisite either way — there is no point distributing channel or provider plugins that nothing can register.

## Ground rules

- Every step lands behind the existing kernel seams (`packages/core/src/index.ts`) — new capability means a new plugin, not a bigger kernel.
- Surfaces never own an agent loop; they consume the gateway API.
- A step's spec is *light* on purpose: enough to start and to know when you're done. Design detail beyond that belongs in the PR that implements it.
- **A plugin moves outside this repository when its contract has stopped moving and a seam exists to register it.** Tools and skills clear both bars today, which is why `stratuslabs/skill-*` already lives outside. Channels, providers, memory stores, and executors clear neither until 19 — which is why Discord (20) is built here first and moved afterwards. Publishing across repositories against a contract still under change is the expensive version of this mistake; the cheap version is one `git mv` later.
