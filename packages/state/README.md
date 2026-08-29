# @stratusagent/state

Shared Stratus state wiring — the code that knows where `~/.stratus` lives and how to turn it into a running agent:

- **Config resolution**: `resolveRuntimeConfig` with the full precedence chain (flags/selection → `STRATUS_*` env vars → config file → defaults), including the trust rules that keep stored credentials away from endpoints chosen by auto-discovered project configs.
- **Credentials**: `loadCredentials` / `saveCredentials` for `~/.stratus/credentials.json` (written 0600).
- **Soul roster**: `loadRosterSouls` reads `~/.stratus/agents/*.md`; `loadSoulFile` parses one soul with path-seeded identity.
- **Agent memory**: `createFileMemoryStore` (append-only JSONL keyed by agent id) plus `migrateLegacyMemory` for pre-global memory files.
- **Provider wiring**: `createRuntimeProvider` builds the right provider (demo / OpenAI-compatible / Anthropic API / Claude Code subscription runtime) from a resolved config, fallback model included.
- **Versioned state**: `~/.stratus/state.json` stamps the home directory with a schema version and the ids of applied migrations. `runStateMigrations` runs the ordered, idempotent registry (`STATE_MIGRATIONS`) and records each as it completes; `pendingStateMigrations` reports what would run; `assertStateCompatible` / `newerStateMessage` refuse state stamped by a newer build than the caller.

Both `@stratusagent/cli` and `@stratusagent/gateway` depend on this package — the CLI depends on the gateway for `stratus serve`, so this layer exists to keep that dependency acyclic. Every function takes a `StateEnvironment` (`processEnv` / `cwd` / `homeDir` overrides) instead of touching process globals, so hosts and tests pin their own world.
