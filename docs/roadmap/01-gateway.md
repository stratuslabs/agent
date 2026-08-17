# 01 — The Gateway: `stratus serve`, durable sessions, streaming + cancellation

## Goal

A long-running daemon (`stratusd`, started with `stratus serve`) that hosts the agent roster with durable, resumable sessions — the process every channel, API, and surface plugs into.

## Why now

Everything in the v2 vision presumes a process that outlives a terminal command: Slack presence, remote approvals, a control API, checking on agents from elsewhere. None of it can exist first. Today the only session store is `InMemorySessionStore`, and while `stratus chat` resumes sessions in-process, every session still dies with the process.

## Scope

**In:**

- New package `@stratusagent/gateway`: composes the same `AgentRunner`, tool registry, providers, and file memory store the CLI uses, but as a persistent service with a lifecycle (start, drain, stop).
- `stratus serve` command in the CLI to run it in the foreground; a documented launchd plist for macOS deployment (template in the package, `HOME`-relative — no hardcoded user paths).
- Durable `SessionStore` implementation backed by SQLite (`~/.stratus/sessions.db`), honoring the existing `create/get/save` seam in `packages/core/src/index.ts`. Sessions must round-trip completely — including `metadata` (the Anthropic provider caches raw turns there under `anthropicRawTurns`; losing it breaks tool-use replay).
- Kernel additions (the only core changes in this roadmap):
  - **Streaming deltas**: extend the `StratusEvent` union with `provider.delta` (text / tool-call fragments). Providers that don't stream emit none; consumers that don't care ignore them.
  - **Cancellation**: `run`/`resume` accept an `AbortSignal` that **propagates through the execution contracts** — `Executor.execute` and `Tool.execute` gain an execution context carrying the signal, and `LocalCommandExecutor` kills its child process on abort (today it only kills on its own timeout). Aborting fails the turn cleanly (session `failed` with a distinguishable reason, no orphaned subprocesses).
  - An activity watchdog helper in the gateway: abort a turn when no event has arrived for N seconds (progress-based, not wall-clock).
- Session identity convention: callers pass stable session ids (channels will use thread-derived keys) so any inbound message can resume its conversation across daemon restarts.
- Extract the triplicated persona/memory system-prompt rendering from the three provider packages into one shared helper (natural to do while touching providers for streaming).

**Out:** channels (02), HTTP API (05), any scheduler/cron, multi-tenancy, queueing. The gateway at this step is only reachable in-process and via signals — that's fine; step 02 gives it its first real front door.

## Design sketch

- `createGateway(config)` → `{ start(), stop(), dispatch(input): AsyncIterable<StratusEvent> }` where `dispatch` is the one entrypoint channels/API will call: it resolves the agent (router or explicit id), loads-or-creates the session by id, and runs a turn.
- SQLite via `node:sqlite` to keep the zero-heavy-deps ethos; one `sessions` table (id, agent_id, status, JSON body, timestamps) is enough — no ORM. `node:sqlite` is unflagged only on **Node 22.13+** (22.6–22.12 require `--experimental-sqlite`), so this step raises the documented repo floor from 22.6 to 22.13 — still the Node 22 line, and cheaper than a native dependency or flag juggling in launchd plists.
- Config: the CLI's state wiring — `resolveRuntimeConfig` precedence (flags → env → config file → defaults), credential store access, soul roster loading, and the file memory store — is **extracted into a shared lower-level package** (working name `@stratusagent/state`) that both the CLI and the gateway depend on. The CLI must depend on the gateway to implement `stratus serve`, so the gateway importing from the CLI would be a package cycle; extraction, not duplication. Gateway-specific keys live under a `gateway` section of `~/.stratus/config.json`.
- Single-flight per session (a second dispatch to a busy session queues or rejects — pick one and document it), concurrent across sessions.

## Acceptance criteria

- `stratus serve` starts, loads the roster from `~/.stratus/agents/`, and logs a ready line; SIGTERM drains in-flight turns then exits.
- Kill and restart the daemon mid-conversation: a follow-up message with the same session id continues the conversation with full history, including after a tool-use turn on the Anthropic provider.
- A turn aborted via the watchdog or signal leaves the session in a consistent `failed` state and the daemon healthy.
- Streaming: with the Anthropic provider, `provider.delta` events arrive before the final `provider.response`; `pnpm test` covers delta ordering with a scripted provider.
- Existing CLI behavior (`run`, `chat`) unchanged; all packages still build/typecheck/test green.

## Open questions

- Does `stratus chat` switch to gateway-backed sessions immediately (persistent conversations for free) or stay in-process until 05? Leaning: switch it, behind a flag at first.
- Retention: sessions.db grows forever without a policy — prune on age, cap, or leave to the operator for now?
