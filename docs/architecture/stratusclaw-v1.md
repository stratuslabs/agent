# StratusClaw v1 Architecture

## Product framing

StratusClaw is the kernel: a small runtime that defines the contracts for sessions, providers, tools, plugins, events, and orchestration. StratusOS is an optional GUI and product layer that can sit on top of the kernel, but the kernel should remain usable from code, tests, CLIs, servers, or other UIs without depending on any StratusOS concerns.

## Kernel boundary

Core owns the stable execution contract:

- session, message, event, and tool types
- the runner orchestration loop
- plugin registration hooks
- approval and execution interfaces
- minimal in-memory defaults for local development and tests

Plugins and modules sit outside the kernel when they add behavior rather than define shared contracts. That includes concrete model adapters, persistence backends, transports, GUI state, deployment choices, and product-specific workflows.

## v1 package architecture

```text
packages/
  core/       # kernel contracts + minimal orchestration runtime
  providers/  # adapter helpers for building provider implementations against core
  executors/  # adapter helpers for building executor implementations against core
```

`@stratusclaw/core` stays intentionally small and dependency-light.

`@stratusclaw/providers` is the first boundary package outside the kernel. It provides reusable builders for constructing provider responses cleanly, while keeping actual OpenAI, Anthropic, local model, or gateway-specific adapters in separate packages later.

`@stratusclaw/executors` is the matching execution boundary package. It provides result helpers plus baseline executor adapters that can be reused by local, container, or remote execution packages later without pulling that policy into core.

## Event and state model

The kernel uses an event-first model around a session:

1. a session is created and moves to `running`
2. the provider returns structured parts
3. parts emit events and may trigger tool execution
4. tool results are appended back into session state
5. the session resolves to `completed` or `failed`

State is session-centric, append-only in spirit, and easy to persist or replay later. Events are the public seam for logging, UI updates, analytics, and future adapters.

## Execution model

The kernel coordinates provider output, approvals, and tool execution, but it should not decide where work runs. Local processes, containers, sandboxes, and cloud executors all have different trust, lifecycle, and infrastructure concerns.

Those execution targets stay outside core so the kernel can remain portable and policy-free. Core defines the executor interface; environment-specific packages implement it. The public helpers for those implementations now live in `@stratusclaw/executors`, which keeps adapter ergonomics outside the kernel while still preserving a tiny zero-config path for local tests.

## Explicitly out of scope for v1

- concrete vendor SDK integrations
- remote execution runtimes
- container orchestration or cloud deployment primitives
- durable storage beyond in-memory defaults
- transport layers and hosted APIs
- GUI state management for StratusOS
- retries, queues, scheduling, and multi-agent coordination
