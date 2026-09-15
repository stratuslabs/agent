# @stratusagent/state

Shared Stratus state wiring — the code that knows where `~/.stratus` lives and how to turn it into a running agent:

- **Config resolution**: `resolveRuntimeConfig` with the full precedence chain (flags/selection → `STRATUS_*` env vars → config file → defaults), including the trust rules that keep stored credentials away from endpoints chosen by auto-discovered project configs.
- **Credentials**: `loadCredentials` / `saveCredentials` for `~/.stratus/credentials.json` (written 0600).
- **Soul roster**: `loadRosterSouls` reads `~/.stratus/agents/*.md`; `loadSoulFile` parses one soul with path-seeded identity.
- **Agent memory**: `createHomeMemoryStore` is what every surface uses — one append-only JSONL per agent at `~/.stratus/agents/<id>/memory.jsonl` (`createShardedFileMemoryStore` over `createFileMemoryStore`), with the built-in agent's inherited aliases folded in; `migrateLegacyMemory` folds a pre-global per-directory file into them.
- **Per-agent layout**: `agentStateDirPath` / `agentSessionDbPath` / `agentMemoryFilePath` name what one agent owns under `~/.stratus/agents/<id>/`, and `fleetDbPath` names what stays fleet-wide (the schedules and the session index). `legacySessionDbPath` / `legacyMemoryFilePath` exist for the migration that moves them.
- **Provider wiring**: `createRuntimeProvider` builds the right provider (demo / OpenAI-compatible / Anthropic API / Claude Code subscription runtime / Codex harness) from a resolved config, fallback model included.
- **Versioned state**: `~/.stratus/state.json` stamps the home directory with a schema version and the ids of applied migrations. `runStateMigrations` runs the ordered, idempotent registry (`STATE_MIGRATIONS`) and records each as it completes; `pendingStateMigrations` reports what would run; `assertStateCompatible` / `newerStateMessage` refuse state stamped by a newer build than the caller. A migration whose `requiresExclusive` says this home needs the caller to hold it — the per-agent session move does, wherever a shared database is still there — is deferred by the automatic path and run by `stratus serve` (which holds the home claim) or `stratus update` (which stopped the service), with the schema stamp held back meanwhile.

Both `@stratusagent/cli` and `@stratusagent/gateway` depend on this package — the CLI depends on the gateway for `stratus serve`, so this layer exists to keep that dependency acyclic. Every function takes a `StateEnvironment` (`processEnv` / `cwd` / `homeDir` overrides) instead of touching process globals, so hosts and tests pin their own world.
