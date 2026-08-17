# Stratus Agent v2 Architecture: One Runtime, Many Deployments

This is the vision for where Stratus Agent goes after v1. The [v1 architecture](./stratus-v1.md) defined the kernel boundary and deliberately left transports, durable storage, remote execution, and product surfaces out of scope. This document is about exactly those things: how the kernel grows into a framework that can power a personal agent fleet, a hosted agent-as-a-service product, and bespoke high-access business agents — without becoming three different codebases.

The step-by-step execution plan lives in [`docs/roadmap/`](../roadmap/README.md). This document explains the shape and the reasoning.

## Where we are

The v1 kernel worked out. `@stratusagent/core` is ~600 lines with zero runtime dependencies, and its seams — `ModelProvider`, `Tool`, `Executor`, `ApprovalPolicy`, `SessionStore`, `AgentMemoryStore`, `CredentialResolver`, `Plugin`, the event bus — are the right ones. Agents-as-people (souls, deterministic avatars, per-agent tool and credential allowlists, delegation, routing) is implemented and tested. The CLI can run one-shot sessions and hold a persistent conversation (`stratus chat`).

What does not exist yet:

- **No channel layer.** Slack appears only in a code comment. There is no inbound message contract, no outbound reply interface, no long-running process to host either.
- **No durable sessions.** `InMemorySessionStore` is the only session store; `stratus chat` resumes sessions within a process, but everything dies with it.
- **No usable service surface.** The dashboard is a smoke-test page with no connection to the runtime. There is no API another surface could consume.
- **Delegation and routing are library-only.** `createDelegateTool` and `createAgentRouter` are exported and tested but nothing wires them into a real entrypoint.
- **The subscription provider is text-only.** `@stratusagent/provider-claude-code` runs with no tools and a flattened transcript, so agents on a Claude subscription cannot use `memory.remember` or anything else.

We also have a predecessor to learn from. StratusOS (the `stratuslabs/os` repo) was a 44k-line Swift experiment at a Mac-native agent. It shipped real, proven pieces — streaming chat channels, a launchd daemon, a battle-tested permission engine — and it failed in instructive ways, chiefly by never deciding who owns the agent loop and by building elaborate subsystems (4-layer SQL memory, container isolation) that users and reality routed around. The lessons are folded into the decisions below and itemized at the end.

## The thesis

**One runtime, many deployments.** The products we want to build — a personal fleet on Mac Minis spoken to through Slack, a hosted growth-research agent sold as a service, custom wide-access agents in client VMs — are not three architectures. They are one always-on gateway process, configured three ways. Every layer of the design serves that collapse:

```text
L0  KERNEL       @stratusagent/core — contracts and the loop. Stays tiny.
L1  PACKAGES     optional capability packages: providers, tool packs,
                 channels, memory stores, the permission engine
L2  GATEWAY      stratusd (`stratus serve`) — the always-on process:
                 agent roster, durable sessions, channel adapters,
                 one HTTP + WebSocket control API
L3  SURFACES     CLI, web dashboard, macOS app — thin clients of the
                 gateway API and the shared ~/.stratus state
L4  DEPLOYMENT   recipes, not products: launchd on a Mac Mini,
                 systemd/Docker in a VM, multi-tenant hosted
```

A new agent business is a **configuration** — souls + tool packs + channel + deployment recipe — not a new codebase.

## The layers

### L0 — Kernel

The kernel keeps the v1 discipline: contracts, the runner loop, in-memory defaults, zero dependencies. Only three additions earn a place in core, because every layer above needs them:

1. **Streaming.** The `StratusEvent` union grows delta events (text and tool-call deltas) so channels can edit messages as tokens arrive and UIs can render live. Non-streaming providers keep working; deltas are additive.
2. **Cancellation.** `run`/`resume` accept an abort signal. A daemon cannot exist without a way to stop a turn.
3. **Durability in practice.** The `SessionStore` seam already exists; the gateway supplies a real implementation and the kernel guarantees sessions round-trip through it (including provider metadata like the Anthropic raw-turn cache).

One cleanup rides along: persona + memory system-prompt rendering is currently duplicated in all three provider packages and should become a single shared contract.

### L1 — Capability packages

Everything optional is a package, installed only where needed:

- **Providers** (exist): `provider-anthropic`, `provider-claude-code`, the OpenAI-compatible adapter in `providers`.
- **Channels** (new): `@stratusagent/channels` defines the contract — inbound message → router → session mapping, outbound post/edit/typing, per-agent bot identity. `@stratusagent/channel-slack` is the first adapter. Others (Discord, Telegram, email) follow the same shape; StratusOS proved the pattern generalizes across three chat platforms.
- **Tool packs** (new): `tool-fs`, `tool-shell`, `tool-browser`, folding in the existing `stratuslabs/tool-browser` and `tool-screenshot` work. A pack is a `Plugin` that registers tools; an agent opts in via its soul's tool allowlist.
- **Permissions** (new): the StratusOS permission engine ported to TypeScript behind the existing `ApprovalPolicy` seam — safe-command allowlist, per-agent persistent whitelist, shell-metacharacter detection, headless mode, remote approval.
- **Memory** (later): stays markdown/JSONL-first. A SQLite store with budget-aware retrieval is a future optional package behind the same `AgentMemoryStore` interface, not a prerequisite for anything.

### L2 — The gateway

`stratusd` — started as `stratus serve` — is the single most important thing to build, because everything we want presumes a process that outlives a terminal command. It:

- loads the soul roster from `~/.stratus/agents/` and existing config/credential state,
- holds a SQLite session store keyed so a chat thread maps to a resumable session,
- runs channel adapters and the agent router,
- enforces approvals (including surfacing them remotely — an agent that hits a gated tool while nobody is at the machine should ask in Slack, not die on a TTY prompt),
- exposes one control API (HTTP + WebSocket): list agents, list/read sessions, send messages, stream events, resolve pending approvals.

The gateway is a package + CLI command, not a fork of the runtime. It composes the same `AgentRunner` the CLI uses today.

### L3 — Surfaces

Every surface is a thin client. None of them ever reimplements the loop — that is the mistake that sank StratusOS, where the Swift app owned its own loop and everything (permissions, memory, providers) had to be rebuilt inside it.

- **CLI** (exists): keeps its in-process mode for one-shots and `chat`; gains `serve` and, later, remote-client commands against a running gateway.
- **Web dashboard**: replaces the smoke-test page with a real chat and monitoring UI over the control API. Also the foundation for the hosted product's UI.
- **macOS app**: a SwiftUI **local management app**, not a chat runtime. Its job is the thing the CLI is worst at: letting a user create and manage agents visually — create an agent (a soul-file editor with name/avatar/personality), manage the roster, configure providers, models, and credentials, and start/stop/health-check the local `stratusd`. It reads and writes the same `~/.stratus` state the CLI uses, and talks to the gateway API when the daemon is running. Chat in the app can come later via the same API, but it is explicitly not the point.
- **iOS**: out of scope entirely for now. Nothing in the architecture forecloses it — it would be another client of the same API — but we are not designing for it yet.

### L4 — Deployment recipes

The runtime is one persistent Node process everywhere; only the recipe changes:

- **Mac Mini (personal fleet)**: launchd plist + `stratus serve`. Slack Socket Mode means no public ingress.
- **Client VM (bespoke business agents)**: the same daemon under systemd, or the same thing in a Docker container, on any Linux box. Wide-open tool packs, 1–5 users, no multi-tenancy work.
- **Hosted (agent-as-a-service)**: the same container image on a persistent-process platform (Fly.io / Railway / a VPS), multi-tenant configuration, locked-down tool packs.

**We do not run the agent runtime on serverless.** Agent loops are long-running, Slack Socket Mode needs a persistent connection, and scheduled/background work does not fit function invocations. Vercel remains a fine home for the hosted product's marketing site and dashboard frontend — just not for the fleet.

## Key decisions

1. **The kernel owns the loop; providers are model clients.** The Claude Agent SDK is bridged into the kernel's contracts (tools exposed to it via in-process MCP, calling back through `ToolRegistry` → `ApprovalPolicy` → `Executor`), never the other way around. This resolves, deliberately, the fork StratusOS left open — its final commit bolted the Agent SDK in as "just another provider," which silently bypassed its entire permission and memory system. Both billing paths (Anthropic API key, Claude subscription) are provider concerns; nothing else in the stack knows the difference.
2. **Each agent is a real Slack app.** Slack offers no way to give one bot multiple identities with presence and DMs, so per-agent avatars and presence mean one Slack app (one bot token) per agent, generated from a manifest template. The Slack adapter holds a token → agent map; the session key is `(team, channel, thread_ts)` so threads are resumable conversations.
3. **Surfaces are clients of one API.** Adding a surface must be cheap forever. The control API is the only doorway; the loop is never duplicated.
4. **Persistent process, not serverless.** See L4.
5. **Markdown-first memory.** StratusOS built a 4-layer SQL memory system and users edited the markdown files next to it. We keep soul files and JSONL memory as the source of truth and add smarter stores later behind the existing seam.
6. **Policy before isolation.** The permission engine (allowlists + approvals + metacharacter detection) is the near-term safety layer. Container/VM isolation becomes real work only when client VM deployments demand it.

## Carried from StratusOS / rejected from StratusOS

**Carried:**

- The permission engine as built (`PermissionManager.swift`): safe-command allowlist, per-agent persistent whitelist, session cache, three-way approval, and — the hard-won part — treating any shell metacharacter (`|`, `;`, `` ` ``, `&&`, `$(`) as disqualifying a command from auto-approval.
- A single typed event stream consumed identically by GUI and daemon.
- Activity-based watchdogs: abort a turn when no token has arrived for N seconds, not on total elapsed time.
- Budget-aware, source-weighted context assembly (`ContextAssembler.swift`) — the retrieval shape to use whenever a smarter memory store lands.
- Streaming chat channels with message edits and typing indicators behind one channel protocol.
- The credential-lease spec (`TEMPORARY_ACCESS_SPEC.md`): time-boxed, scoped, use-capped credential grants with sub-leases for delegation. Unbuilt there; scheduled late here.
- The tool-message sanitizer invariant: every `tool_use` must have a matching `tool_result`, re-checked after any history compaction.

**Rejected:**

- The 4-layer SQL memory system as a prerequisite (the markdown file won).
- Keyword-hash embeddings pretending to be semantic search, and in-memory vector indexes rebuilt by re-embedding everything at startup.
- Keyword-heuristic "smart" model routing.
- Deciding on heavyweight dependencies (Mem0, LanceDB, MLX) in ADRs before prototyping them across a language boundary.
- Native apps that own the runtime.

## How the business tracks map

| Track | Configuration |
| --- | --- |
| Stratus Labs personal fleet (now) | `stratusd` on Mac Minis via launchd; Slack channel package with one Slack app per agent; permission engine in ask-with-remote-approval mode; CLI for administration |
| Growth-research agent-as-a-service (later) | A separate product repo that depends on the framework: multi-tenant `stratusd`, locked-down tool pack (search/fetch/report — no shell), web dashboard as the product UI, hosted on a persistent-process platform |
| Bespoke client agents in VMs (later) | The systemd/Docker recipe; wide-open tool packs including browser and shell; credential leases for anything sensitive; single-tenant |

## Explicitly out of scope (for this whole arc)

- iOS app
- Serverless agent runtime
- Marketplace (agents/tools/skills distribution)
- 4-layer memory, vector search, and model-routing heuristics
- Container isolation as a default (revisit when client VMs go live)

## Reading order

Start with the [roadmap index](../roadmap/README.md); each step there has a one-page spec with goals, scope, design sketch, and acceptance criteria.
