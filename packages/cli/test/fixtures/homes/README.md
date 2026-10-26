# Upgrade fixture homes

Each directory is a `~/.stratus` written by a published release, used by
`test/upgrade-fixtures.test.ts` to check that the current build upgrades it
without losing anything. They are stored as `stratus/` because the repository
ignores `.stratus/`; the test copies each one into a temporary home.

How 0.11.0 and 0.12.0 were made, with the release installed from npm into a
throwaway prefix and `HOME`:

1. `config.json` set to `{ "provider": "demo", "api": { "port": <free port> } }`
   and `credentials.json` to a fake Anthropic key in the shape these releases read
   (`{ "anthropic": { "type": "api_key", "value": "sk-ant-FIXTURE-not-a-real-key" } }`).
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

## 0.13.5: a working host's home

`make-home.mjs` wrote this one, and can write the next:

    node packages/cli/test/fixtures/homes/make-home.mjs 0.13.5

It installs that release's CLI, control API, `tool-shell` and `tool-web` from
npm into a scratch prefix, along with the test-only plugin in
`scripts/release-smoke/plugin`. That plugin's `smoke` provider makes exactly
the tool call a message names. The script then runs the release's own
`stratus serve` against a scratch `HOME` with approvals `guarded` and drives
it over the control API:

- Ava (a hand-written soul, as operators write them) runs `demo.echo`,
  `shell.run git --version`, `web.fetch https://example.com/` and
  `schedule.every 1d`. Each gated call is approved with "always", so the
  release's own approval path writes a command scope, an origin and a tool
  grant. The schedule is stored in `fleet.db`.
- Bob is created with `POST /agents` and says hello on `demo`.
- An Anthropic subscription sign-in, an OpenAI API key and Ava's named
  credential `fixture.token` are stored over the API. All are fake.
- One memory each, through the release's own memory store, and a file
  dropped into Ava's visible workspace (an empty one wouldn't survive git).

Afterward it removes `logs/`, the lock and `gateway-token`, drops the smoke
plugin from `config.json` and sets Ava to `provider: demo`, since the test
has no smoke plugin. `tool-shell` ran with `sandbox: "off"`, so the
transcript holds the command's output and not a sandbox refusal from a shell
that can't nest one.

0.13 keeps souls and workspaces in the visible `~/Agents` folder, linked from
`~/.stratus/agents` by absolute path. The fixture keeps `Agents/` and the
links as written, and `home.json` names the scratch home they point into;
the test re-points them at its own temporary home. The only paths inside are
under that deleted scratch home.

| Release | Layout it shows |
| --- | --- |
| 0.11.0 | State stamp at schema 1; one shared `sessions.db` and `memory.jsonl` at the home root |
| 0.12.0 | State stamp at schema 4; per-agent `agents/<id>/sessions.db` and `memory.jsonl`, plus `fleet.db` |
| 0.13.5 | Schema 4, plus what a host accumulates: souls and a workspace in `~/Agents`, grants of three kinds, a schedule, sign-ins, a named credential, approval and plugin config |

Add a home here when a release changes what it writes to disk.
