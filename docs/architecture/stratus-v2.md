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

1. **Streaming.** The `StratusEvent` union grows delta events (text and tool-call deltas), fed by an optional per-request delta sink on `ProviderRequest` — a single-promise `generate` cannot stream on its own. Channels can then edit messages as tokens arrive and UIs render live. Non-streaming providers keep working; deltas are additive.
2. **Cancellation.** `run`/`resume` accept an abort signal, and it propagates through the provider contract (`ProviderRequest` carries it; adapters cancel the underlying request or SDK query) and the `Executor`/`Tool` contracts, so in-flight requests and subprocesses die with the turn. A daemon cannot exist without a way to stop a turn.
3. **Durability in practice.** The `SessionStore` seam already exists; the gateway supplies a real implementation and the kernel guarantees sessions round-trip through it (including provider metadata like the Anthropic raw-turn cache).

Contract extensions owned by later steps:

4. Approval-request/resolve event variants, a risk level on registered `Tool`s (derived into their descriptors), and the resolved tool + risk in `ApprovalContext` (step 03).
5. A callable tool-dispatch seam on `ProviderRequest`, so providers that host an inner loop execute tools through the kernel chain — and have them recorded in session history — instead of around it (step 04).
6. Glob support in per-agent tool allowlists (step 06).
7. Token accounting: a `usage` field on `ProviderResponse` **and** an optional per-request usage sink on `ProviderRequest` (`onUsage`), because one field on the response cannot carry a harness provider's several inner calls or the tokens of a call that then threw. The runner accumulates them onto the session as attributed `UsageRecord`s — turn, provider, model, and four disjoint token buckets, never a summed scalar — persisted with the session and emitted with `session.completed` (step 18, pulled out of 08: an operator running one daemon has the same question).
8. `Skill` and `SkillRegistry` contracts, shaped like `Tool` and `ToolRegistry`, with the body loaded lazily rather than held (step 09).
9. `PluginContext` grows past `{ bus, tools }`. Two distinct reasons, and both are needed before the plugin contract means what [`plugins.md`](./plugins.md) says it means. **Registration handles** for providers, channels, memory stores, and executors: their interfaces exist, but `loadAll({ bus, tools })` gives `setup` no way to register one, so four of the seven advertised contribution kinds are today wired by the host rather than by the plugin. **A scoped `CredentialResolver` plus the plugin's own config block**, so an honest plugin declares what it needs by name instead of reaching into ambient environment — an interface that makes the manifest auditable, not an isolation boundary (in-process code can always read `process.env`; see decision 6). And **a manifest-bound registration view in place of the raw `ToolRegistry`**: `register` is a bare `Map.set` retaining no provenance, so a plugin handed it directly can register a tool it never declared and mark it `safe`, which makes the third-party risk floor unenforceable. The view rejects undeclared names, keeps the package for risk resolution, and applies the floor at registration (steps 06, 09).
10. `AgentDefinition.skills?: string[]`, and `skills` added to the soul frontmatter list keys — the same allowlist shape `tools` already has (step 09).
11. `AgentMemoryStore` grows `search` and `forget`, and `list` grows a bounded form (step 14). `append` + `list` admits exactly one retrieval policy — inject everything — which has a horizon of weeks on an always-on agent, and it gives the agent no way to participate in what is kept. This extends the interface; it does not change what is behind it. Decision 5 stands: JSONL remains the source of truth and the thing a user can read and edit, and the SQLite FTS index step 14 adds is derived from it and rebuildable by deleting it, which is what keeps "smarter stores never replace the files as the interface" true rather than merely stated.

Anything beyond this list gets decided in this document first, not in an implementation PR. One cleanup rides along: persona + memory system-prompt rendering was duplicated in all three provider packages; step 09 made it the kernel's shared renderer (`renderSystemPromptSections` in `core`), which is also where the skills block renders once instead of a fourth copy appearing.

### L1 — Capability packages

Everything optional is a package, installed only where needed:

- **Providers** (exist): `provider-anthropic`, `provider-claude-code`, `provider-codex`, the OpenAI-compatible adapter in `providers`. The Codex provider is specified below; it shipped after that section settled its one open question.
- **Channels** (new): `@stratusagent/channels` defines the contract — inbound message → router → session mapping, outbound post/edit/typing, per-agent bot identity. `@stratusagent/channel-slack` is the first adapter; others (Discord, Telegram, email) follow the same shape.
- **Tools** (new): `tool-fs`, `tool-shell`, `tool-browser`, `tool-web`, folding in the existing `stratuslabs/tool-browser` and `tool-screenshot` work. Each is a `Plugin` contributing a *toolset*; an agent opts in via its soul's tool allowlist.
- **Skills** (new): markdown procedures — `SKILL.md` with frontmatter — enabled per agent and loaded into context only when the agent reaches for one. Tools are what an agent *can* do; skills are how it does them well.
- **Permissions** (new): a policy engine behind the existing `ApprovalPolicy` seam — safe-command allowlist, per-agent persistent whitelist, shell control-operator detection, headless mode, remote approval.
- **Memory** (later): stays markdown/JSONL-first. A SQLite store with budget-aware retrieval is a future optional package behind the same `AgentMemoryStore` interface, not a prerequisite for anything. [Step 14](../roadmap/14-memory.md) takes the narrower half of that — an FTS index *derived from* the JSONL, plus `search`/`forget` on the interface (kernel change 11) — and leaves the JSONL as the record.

All of these are **plugins** — one word for one distribution unit, whatever it contributes. [`plugins.md`](./plugins.md) specifies the contract: the contribution kinds and the seams they map to, naming, the `package.json` manifest, the `plugins` config block, the trust model for code that runs in-process with the daemon, and the rule for which packages live in this monorepo and which live in their own repositories. It is the document a third-party developer reads, and the vocabulary landed before the packages on purpose — naming is cheap now and expensive once things exist.

#### Codex — a third provider shape (built)

Codex is not another OpenAI model reachable through the existing adapter. It is a *harness* with its own agent loop, standing in the same relation to a ChatGPT subscription that Claude Code stands in to Pro/Max — so supporting it means the stack carries three provider shapes, not two:

| Shape | Transport | Who owns the loop | Today |
| --- | --- | --- | --- |
| Stateless chat completions | `fetch` → `/v1/chat/completions` | the kernel runner | the OpenAI-compatible adapter in `providers` |
| Vendor SDK, one request per turn | `@anthropic-ai/sdk`, Messages API | the kernel runner | `provider-anthropic` |
| Harness with an inner loop | `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` | the provider, calling back into the kernel | `provider-claude-code`, `provider-codex` |

`provider-codex` wraps `@openai/codex-sdk` as the second instance of the third shape, and that shape is the expensive one. Decision 1 is what makes it expensive: an SDK that owns the loop is admitted only if its tool calls come back through `ToolRegistry` → `ApprovalPolicy` → `Executor`. `bridgeKernelTools` is how `provider-claude-code` pays that price, and the Codex provider pays it again over its own transport (below). The helpers both harness providers share — the side-effect markers the fallback wrapper honors, the MCP wire-naming rule, the transcript-per-prompt rendering — live once in `@stratusagent/providers` rather than twice in the two packages.

**The mechanical cost was small, but it was not confined to the CLI.** `StratusProviderName` and `CredentialProviderName` are closed unions in `state`, and the third name had to reach every surface that hard-coded the pair instead of deriving it — the `['anthropic', 'openai'] as const` sweeps (now one exported `CREDENTIAL_PROVIDER_NAMES` list the surfaces share), the value predicates across `state`, `cli`, and `control-api`, `defaultApiKeyEnvName`, the setup menu's provider list, the credentials response in `packages/control-api/src/routes.ts`, and `PROVIDERS` in `packages/dashboard/ui/views/settings.js` — plus surfaces the original inventory missed: the `FallbackRuntime` union, the gateway's `streamsDeltas`, and setup's mirrored test-runtime builder. The `verifyProviderKey` carve-out extends as predicted: a ChatGPT sign-in has no key to check, so it is recorded as a marker credential (`oauth_token`, value unused — the real tokens stay in codex's own auth store under `~/.codex`) and verified on the first run, while a `CODEX_API_KEY` is an OpenAI platform key and verifies against the platform's models endpoint.

**The one question this document reserved for itself — which transport carries kernel tools into the Codex loop — is answered: a loopback streamable-HTTP MCP endpoint the daemon hosts.** The Claude Agent SDK accepts an in-process MCP server; Codex instead takes MCP servers as a spawned command or a streamable HTTP URL with a bearer token read from a named environment variable, so the daemon hosts the URL form on `127.0.0.1` and spawns nothing — the scrubbed-environment invariant is not what is at stake on that path. What replaces it is a listening socket carrying every kernel tool call, and what authenticates it is: a fresh 256-bit bearer token minted per turn, reaching the codex subprocess only through its environment (`bearer_token_env_var`), required on every request (constant-time comparison) with non-loopback connections refused outright. The socket exists only for the duration of the turn and serves only that turn's session and tool allowlist, so a leaked URL is dead the moment the turn ends; taking the token would take reading the subprocess environment, which is owner-only — the same boundary that already protects `~/.stratus/credentials.json`.

**And Stratus stays authoritative over tool execution, as required.** Codex ships its own sandbox (`read-only` / `workspace-write` / `danger-full-access`) and approval policy (`untrusted` through `never`), and those govern model-generated shell commands *inside its harness* — commands that never traverse `ToolRegistry` → `ApprovalPolicy` → `Executor`. Letting the Codex policy decide is precisely the side door decision 1 rules out, so the shipped configuration disables its native tools outright — `features.shell_tool = false` removes the exec tools (and with them file edits, which ride the shell in current codex), with web search, the image reader, the plan and sleep tools, and lifecycle hooks off, and `project_doc_max_bytes = 0` so a repository's AGENTS.md never becomes agent instructions — and pins its policy to pass-through (sandbox `read-only`, approvals `never`) as belt and braces under them. The kernel's chain is the sole gate.

No roadmap step claimed this work, and the sequencing note stands: the plugin contract still cannot register a provider (kernel change 9 above), so `provider-codex` is host-wired — the third case inside `createRuntimeProvider` — exactly like the two providers before it, and becomes a plugin-registered provider when that seam lands.

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

1. **The kernel owns the loop; providers are model clients.** The Claude Agent SDK is bridged into the kernel's contracts (tools exposed to it via in-process MCP, calling back through `ToolRegistry` → `ApprovalPolicy` → `Executor`), never the other way around. An SDK that owns the loop becomes a side door around permissions and memory; that is ruled out by design. Both billing paths (Anthropic API key, Claude subscription) are provider concerns; nothing else in the stack knows the difference. A ChatGPT subscription through Codex is a third instance of this rule rather than an exception to it — see the Codex subsection under L1.
2. **Each agent is a real Slack app.** Slack offers no way to give one bot multiple identities with presence and DMs, so per-agent avatars and presence mean one Slack app (one bot token) per agent, generated from a manifest template. The Slack adapter holds a token → agent map; the session key is `(agent, team, channel, thread_ts)` so threads are resumable conversations and a session never crosses agent identities, even when two agents share a thread.
3. **Surfaces are clients of one API.** Adding a surface must be cheap forever. The control API is the only doorway; the loop is never duplicated.
4. **Persistent process, not serverless.** See L4.
5. **Markdown-first memory.** Soul files and JSONL memory are the source of truth users can read and edit. Smarter stores come later behind the existing seam; they never replace the files as the interface.
6. **Policy before isolation.** The permission engine (allowlists + approvals + metacharacter detection) is the near-term safety layer. Container/VM isolation becomes real work only when a deployment's threat model demands it. This is also what an *enabled plugin* is trusted under: plugin code runs in the daemon's process, so scoping its credentials is an interface rather than a boundary, and the controls carrying the weight are that nothing auto-loads and that enablement is readable only from a trusted config. Worker or process isolation with a scrubbed environment is what would make it a boundary, and it is not built.

## Standing invariants

Rules every step of the roadmap honors:

- A safe-command allowlist is only safe with **control-operator detection**: any shell control operator — `|`, `&`, `;`, `&&`, `||`, newlines, backticks, `$(`, subshell parens, or redirection — disqualifies a command from auto-approval regardless of its base command.
- Watchdogs are **activity-based**: abort a turn when no event has arrived for N seconds, not on total elapsed time.
- Every `tool_use` must have a matching `tool_result`, re-checked after any history compaction.
- One typed event stream serves every consumer — CLI, channels, dashboard, approvals — with no side channels.
- Tool subprocesses get a **scrubbed environment**: only explicitly granted variables, never the daemon's env (which holds credentials).
- Agent ids are **path-safe slugs** (`[a-z0-9][a-z0-9-]*`) and **unique**, validated once at the parse/load boundary — ids reach filesystem paths (whitelists, workspaces) and key every per-agent resource, an explicit soul-frontmatter id is untrusted input, and a duplicate id is a load-time error, never a silent overwrite.

## Explicitly out of scope (for this whole arc)

- iOS app
- Serverless agent runtime
- Marketplace infrastructure. The *vocabulary* is settled now (see [`plugins.md`](./plugins.md)) because renaming after packages exist is expensive; discovery and distribution are step 12, and nothing before it depends on them.
- Layered SQL memory, vector search, and model-routing heuristics
- Container isolation as a default

## Reading order

Start with the [roadmap index](../roadmap/README.md); each step there has a one-page spec with goals, scope, design sketch, and acceptance criteria.
