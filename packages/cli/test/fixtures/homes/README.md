# Upgrade fixture homes

Each directory is a `~/.stratus` written by a published release, used by
`test/upgrade-fixtures.test.ts` to check that the current build upgrades it
without losing anything. They are stored as `stratus/` because the repository
ignores `.stratus/`; the test copies each one into a temporary home.

How each was made, with the release installed from npm into a throwaway
prefix and `HOME`:

1. `config.json` set to `{ "provider": "demo", "api": { "port": <free port> } }`
   and `credentials.json` to a fake Anthropic key (`sk-ant-FIXTURE-not-a-real-key`).
2. `stratus serve`, with `@stratusagent/control-api` of the same version installed.
3. Over the control API: `POST /agents` for Ava (`provider: demo`) and Bob;
   `POST /sessions/fixture-ava-1/messages` with "Say hello", then "Use the
   echo tool"; `POST /sessions/fixture-bob-1/messages` with "Hello Bob".
4. SIGTERM, so the daemon stopped cleanly.
5. One memory each for `ava` and `bob`, appended with that release's own
   memory store (`createFileMemoryStore(memoryFilePath(env))` on 0.11.0,
   `createHomeMemoryStore(env)` on 0.12.0).

After that, `logs/`, `stratusd.lock` and `gateway-token` were removed, and
`config.json` was reduced to `{ "provider": "demo" }` (the test picks a free
port with `--api-port 0`). Nothing here holds a real credential or a host path.

| Release | Layout it shows |
| --- | --- |
| 0.11.0 | State stamp at schema 1; one shared `sessions.db` and `memory.jsonl` at the home root |
| 0.12.0 | State stamp at schema 4; per-agent `agents/<id>/sessions.db` and `memory.jsonl`, plus `fleet.db` |

Add a home here when a release changes what it writes to disk.
