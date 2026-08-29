# Configuration

## Where settings come from

Precedence, highest first:

1. **Flags** — `--provider`, `--model`, `--soul`, …
2. **`STRATUS_*` env vars** — `STRATUS_PROVIDER`, `STRATUS_MODEL`,
   `STRATUS_SOUL`, `STRATUS_CONFIG`, …
3. **Soul file hints** — a soul's `provider:`/`model:` frontmatter
4. **Config file** — a project-local `stratus.config.json` outranks the
   global `~/.stratus/config.json`

`stratus setup` writes the global file for you; a project can carry its own
`stratus.config.json` (start from
[`stratus.config.json.example`](../../stratus.config.json.example)), and
`--config <file>` / `STRATUS_CONFIG` load a specific one.
[`stratus doctor`](../guides/troubleshooting.md) prints what a run would
use right now and which file or env var decided each setting.

## Provider settings

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "soul": "./examples/souls/ava.md"
}
```

Credentials stored by setup live in `~/.stratus/credentials.json`
(owner-read-only) and are **endpoint-bound**: a credential saved for one
endpoint is never sent to an endpoint a project-local config selects. See
[Security](../concepts/security.md).

## Trusted-config-only blocks

Three blocks are read **only** from a config you chose yourself — the
global `~/.stratus/config.json`, or a file passed with `--config` /
`STRATUS_CONFIG`. An auto-discovered project-local `stratus.config.json`
ships in any repository you clone, and none of these is a decision a clone
gets to make; a project config that tries is ignored, with a warning naming
the file.

| Block | Decides | Documented in |
| --- | --- | --- |
| `plugins` | Which code runs in the daemon's process, with what settings | [Tools](../guides/tools.md) |
| `approvals` | Who may authorize an agent's tool calls, and how | [Approvals](../guides/approvals.md) |
| `api` | Which interface and port a daemon binds | [Remote access](../guides/remote-access.md) |

Each block's keys and shape are documented in its own guide; all three
share the per-agent `agents` sub-block pattern, where an agent's entry
overrides the defaults above it key by key.
