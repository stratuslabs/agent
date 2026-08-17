# Stratus Agent v2 Architecture: One Runtime, Many Deployments

This is the spec for where Stratus Agent goes after v1. The [v1 architecture](./stratus-v1.md) defined the kernel boundary and deliberately left transports, durable storage, remote execution, and product surfaces out of scope. This document specifies exactly those things. The step-by-step execution plan lives in [`docs/roadmap/`](../roadmap/README.md).

## Current state

The v1 kernel worked out. `@stratusagent/core` is ~600 lines with zero runtime dependencies, and its seams — `ModelProvider`, `Tool`, `Executor`, `ApprovalPolicy`, `SessionStore`, `AgentMemoryStore`, `CredentialResolver`, `Plugin`, the event bus — are the right ones. Agents-as-people (souls, deterministic avatars, per-agent tool and credential allowlists, delegation, routing) is implemented and tested. The CLI can run one-shot sessions and hold a persistent conversation (`stratus chat`).

What does not exist yet:

- **No channel layer.** There is no inbound message contract, no outbound reply interface, no long-running process to host either.
- **No durable sessions.** `InMemorySessionStore` is the only session store; `stratus chat` resumes sessions within a process, but everything dies with it.
- **No usable service surface.** The dashboard is a smoke-test page with no connection to the runtime. There is no API another surface could consume.
- **Delegation and routing are library-only.** `createDelegateTool` and `createAgentRouter` are exported and tested but nothing wires them into a real entrypoint.
- **The subscription provider is text-only.** `@stratusagent/provider-claude-code` runs with no tools and a flattened transcript, so agents on a Claude subscription cannot use `memory.remember` or anything else.

## The thesis

**One runtime, many deployments.** Whether agents run on a machine at home, in a VM, or as a hosted service, it is the same always-on process configured differently — never a different architecture. Every layer serves that collapse:

```text
L0  KERNEL       @stratusagent/core — contracts and the loop. Stays tiny.
L1  PACKAGES     optional capability packages: providers, tool packs,
                 channels, memory stores, the permission engine
L2  GATEWAY      stratusd (`stratus serve`) — the always-on process:
                 agent roster, durable sessions, channel adapters,
                 one HTTP + WebSocket control API
L3  SURFACES     CLI, web dashboard, macOS app — thin clients of the
                 gateway API and the shared ~/.stratus state
L4  DEPLOYMENT   recipes, not products: launchd on macOS, systemd/Docker
                 on Linux, multi-tenant hosted
```

A new agent deployment is a **configuration** — souls + tool packs + channel + deployment recipe — not a new codebase.

## The layers

### L0 — Kernel

The kernel keeps the v1 discipline: contracts, the runner loop, in-memory defaults, zero dependencies. The rule is not "core never changes" — it is that **contracts may grow in small, enumerated ways; behavior, policy, vendors, and persistence never enter**. The full budget of kernel changes for this roadmap:

Landing with the gateway (step 01), because every layer above needs them:

1. **Streaming.** The `StratusEvent` union grows delta events (text and tool-call deltas) so channels can edit messages as tokens arrive and UIs can render live. Non-streaming providers keep working; deltas are additive.
2. **Cancellation.** `run`/`resume` accept an abort signal, and it propagates through the `Executor`/`Tool` contracts so in-flight subprocesses die with the turn. A daemon cannot exist without a way to stop a turn.
3. **Durability in practice.** The `SessionStore` seam already exists; the gateway supplies a real implementation and the kernel guarantees sessions round-trip through it (including provider metadata like the Anthropic raw-turn cache).

Contract extensions owned by later steps:

4. Approval-request/resolve event variants, a risk level on registered `Tool`s (derived into their descriptors), and the resolved tool + risk in `ApprovalContext` (step 03).
5. A callable tool-dispatch seam on `ProviderRequest`, so providers that host an inner loop execute tools through the kernel chain instead of around it (step 04).
6. Glob support in per-agent tool allowlists (step 06).
7. A `usage` field on `ProviderResponse`, accumulated by the runner and emitted with `session.completed` (step 08).

Anything beyond this list gets decided in this document first, not in an implementation PR. One cleanup rides along: persona + memory system-prompt rendering is currently duplicated in all three provider packages and becomes a single shared contract.

### L1 — Capability packages

Everything optional is a package, installed only where needed:

- **Providers** (exist): `provider-anthropic`, `provider-claude-code`, the OpenAI-compatible adapter in `providers`.
- **Channels** (new): `@stratusagent/channels` defines the contract — inbound message → router → session mapping, outbound post/edit/typing, per-agent bot identity. `@stratusagent/channel-slack` is the first adapter; others (Discord, Telegram, email) follow the same shape.
- **Tool packs** (new): `tool-fs`, `tool-shell`, `tool-browser`, folding in the existing `stratuslabs/tool-browser` and `tool-screenshot` work. A pack is a `Plugin` that registers tools; an agent opts in via its soul's tool allowlist.
- **Permissions** (new): a policy engine behind the existing `ApprovalPolicy` seam — safe-command allowlist, per-agent persistent whitelist, shell control-operator detection, headless mode, remote approval.
- **Memory** (later): stays markdown/JSONL-first. A SQLite store with budget-aware retrieval is a future optional package behind the same `AgentMemoryStore` interface, not a prerequisite for anything.

### L2 — The gateway

`stratusd` — started as `stratus serve` — is the single most important thing to build, because everything above presumes a process that outlives a terminal command. It:

- loads the soul roster from `~/.stratus/agents/` and existing config/credential state,
- holds a SQLite session store keyed so a chat thread maps to a resumable session,
- runs channel adapters and the agent router,
- enforces approvals, including surfacing them remotely — an agent that hits a gated tool while nobody is at the machine asks in Slack instead of dying on a TTY prompt,
- exposes one control API (HTTP + WebSocket): list agents, list/read sessions, send messages, stream events, resolve pending approvals, and manage configuration (agent create/edit, credentials, settings, model/tool catalogs).

The gateway is a package + CLI command, not a fork of the runtime. It composes the same `AgentRunner` the CLI uses today.

### L3 — Surfaces

Every surface is a thin client. None of them ever reimplements the loop.

- **CLI** (exists): keeps its in-process mode for one-shots and `chat`; gains `serve` and, later, remote-client commands against a running gateway.
- **Web dashboard**: replaces the smoke-test page with a real chat and monitoring UI over the control API.
- **macOS app**: a SwiftUI **local management app**, not a chat runtime. Its job is the thing the CLI is worst at: letting a user create and manage agents visually — create an agent (a soul-file editor with name/avatar/personality), manage the roster, configure providers, models, and credentials, and start/stop/health-check the local `stratusd`. It reads and writes the same `~/.stratus` state the CLI uses, and talks to the gateway API when the daemon is running. Chat in the app can come later via the same API, but it is explicitly not the point.
- **iOS**: out of scope entirely for now. Nothing here forecloses it — it would be another client of the same API — but we are not designing for it yet.

### L4 — Deployment recipes

The runtime is one persistent Node process everywhere; only the recipe changes:

- **Local machine**: launchd plist + `stratus serve`. Slack Socket Mode means no public ingress.
- **VM (single-tenant)**: the same daemon under systemd, or in a Docker container, on any Linux box. Wide tool access, a handful of users, no multi-tenancy work.
- **Hosted (multi-tenant)**: the same container image on a persistent-process platform, multi-tenant configuration, locked-down tool packs.

**The agent runtime does not run on serverless.** Agent loops are long-running, Slack Socket Mode needs a persistent connection, and scheduled/background work does not fit function invocations. Serverless platforms remain fine for frontends and marketing sites — not for the runtime.

## Key decisions

1. **The kernel owns the loop; providers are model clients.** The Claude Agent SDK is bridged into the kernel's contracts (tools exposed to it via in-process MCP, calling back through `ToolRegistry` → `ApprovalPolicy` → `Executor`), never the other way around. An SDK that owns the loop becomes a side door around permissions and memory; that is ruled out by design. Both billing paths (Anthropic API key, Claude subscription) are provider concerns; nothing else in the stack knows the difference.
2. **Each agent is a real Slack app.** Slack offers no way to give one bot multiple identities with presence and DMs, so per-agent avatars and presence mean one Slack app (one bot token) per agent, generated from a manifest template. The Slack adapter holds a token → agent map; the session key is `(agent, team, channel, thread_ts)` so threads are resumable conversations and a session never crosses agent identities, even when two agents share a thread.
3. **Surfaces are clients of one API.** Adding a surface must be cheap forever. The control API is the only doorway; the loop is never duplicated.
4. **Persistent process, not serverless.** See L4.
5. **Markdown-first memory.** Soul files and JSONL memory are the source of truth users can read and edit. Smarter stores come later behind the existing seam; they never replace the files as the interface.
6. **Policy before isolation.** The permission engine (allowlists + approvals + metacharacter detection) is the near-term safety layer. Container/VM isolation becomes real work only when a deployment's threat model demands it.

## Standing invariants

Rules every step of the roadmap honors:

- A safe-command allowlist is only safe with **control-operator detection**: any shell control operator — `|`, `&`, `;`, `&&`, `||`, newlines, backticks, `$(`, subshell parens, or redirection — disqualifies a command from auto-approval regardless of its base command.
- Watchdogs are **activity-based**: abort a turn when no event has arrived for N seconds, not on total elapsed time.
- Every `tool_use` must have a matching `tool_result`, re-checked after any history compaction.
- One typed event stream serves every consumer — CLI, channels, dashboard, approvals — with no side channels.
- Tool subprocesses get a **scrubbed environment**: only explicitly granted variables, never the daemon's env (which holds credentials).

## Explicitly out of scope (for this whole arc)

- iOS app
- Serverless agent runtime
- Marketplace (agents/tools/skills distribution)
- Layered SQL memory, vector search, and model-routing heuristics
- Container isolation as a default

## Reading order

Start with the [roadmap index](../roadmap/README.md); each step there has a one-page spec with goals, scope, design sketch, and acceptance criteria.
