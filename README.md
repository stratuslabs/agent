# StratusClaw

StratusClaw is a tiny JavaScript agent kernel. This workspace currently contains the core package, provider helpers, executor helpers, and the minimum scaffolding needed to validate the architecture.

## Kernel boundary

`@stratusclaw/core` owns contracts and the thinnest runnable orchestration loop:

- event types and an in-memory event bus
- session and agent lifecycle types
- model provider interfaces for text, streaming parts, and tool call outputs
- tool interfaces and normalized tool result types
- executor and approval policy contracts
- plugin registry and loader hooks
- in-memory session persistence
- a minimal orchestrator that wires provider output to tools, executor calls, events, and session state

Out of scope for this first cut:

- transport layers
- persistence adapters beyond memory
- concrete LLM providers
- remote execution
- prompt management
- retries, scheduling, queues, or deployments

See `docs/architecture/stratusclaw-v1.md` for the current v1 architecture proposal.

## Package layout

```text
stratusclaw/
  docs/
    architecture/
      stratusclaw-v1.md
  packages/
    core/       # @stratusclaw/core
    providers/  # @stratusclaw/providers
    executors/  # @stratusclaw/executors
```

`@stratusclaw/providers` holds response builders and adapter helpers for provider packages.

`@stratusclaw/executors` holds result builders and baseline executor adapters so local, container, and remote execution strategies can stay outside the kernel.

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```
