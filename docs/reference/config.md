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

## Every key the config file accepts

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "soul": "./examples/souls/ava.md"
}
```

| Key | What it sets |
| --- | --- |
| `provider` | `anthropic`, `openai`, `codex`, or `demo` |
| `model` | Model for that provider |
| `baseUrl` | Override the provider API base URL (local models, proxies) |
| `apiKeyEnv` | Name of the environment variable holding the API key — trusted configs only, see below |
| `systemPrompt` | System prompt for the run |
| `soul` | Path to a soul file, resolved relative to the working directory |
| `fallbackModel` | Model to retry with when the default model errors mid-run |
| `fallbackProvider` | Provider serving the fallback model — defaults to the main provider |
| `fallbackBaseUrl` | Base URL for an OpenAI-compatible fallback (e.g. a local model) |
| `promptCache` | Cache the stable head of each Anthropic request. Default `true` — see below |
| `promptCacheTtl` | How long a cache entry lives: `5m` (default) or `1h` |
| `approvals` | Unattended-approval policy for `stratus serve` — trusted configs only, see below |
| `principals` | Which channel senders are each agent's operator: `slackUsers` (Slack user ids), with a per-agent `agents` sub-block — trusted configs only, see below |
| `api` | Control API binding for `stratus serve` — trusted configs only, see below |
| `plugins` | Plugins to load, keyed by package name — trusted configs only, see below |

Credentials stored by setup live in `~/.stratus/credentials.json`
(owner-read-only) and are **endpoint-bound**: a credential saved for one
endpoint is never sent to an endpoint a project-local config selects. See
[Security](../concepts/security.md).

That file also holds **named credentials** — the `search.apiKey` a search
backend asks for, and whatever the ecosystem asks for next. They are a
different kind of thing from a provider sign-in: a sign-in is the daemon's
own, while a named credential is an *agent* capability, gated by that
agent's `credentials:` soul list and resolved per call — the agent's own
entry first, then the fleet's shared one, then the environment. Add one with
[`stratus credential set`](./cli.md); never write a key into a config file,
which is a file people commit.

## Prompt caching

`promptCache` marks the stable head of each Anthropic request — the tool
definitions and the persona/skills system block — as cacheable. Those bytes
are identical on every turn of an agent's life, and a cache read costs about a
tenth of a full input token, so for an always-on roster this is usually the
largest single line in the bill.

**It is on by default, and there is one case where turning it off is right.**
A cache write costs 1.25x an uncached read, and the second request is what
pays it back. An agent that takes exactly one turn per burst — a schedule that
fires, says one thing, and stops — never reads its prefix back and pays the
premium every time. `"promptCache": false` is the honest setting there.

`promptCacheTtl` is `5m` unless you say otherwise, and `5m` is right far more
often than it looks. A cache *read* refreshes the entry's timer for free, so
an agent holding a conversation keeps a 5-minute entry alive indefinitely. The
gap that matters is between an agent's **bursts**, not between its turns —
`1h` earns its doubled write price only when those bursts are 5 to 60 minutes
apart.

Both keys apply to the Anthropic provider only. The Claude Code and Codex
runtimes assemble their own prompts inside their SDKs, and the
OpenAI-compatible dialect caches by a different mechanism that varies per
vendor.

Whether it is working is not a guess: `GET /sessions/:id` reports
`cacheReadTokens` per provider call. Zero across repeated turns of one
conversation means something in the prefix is changing.

## Trusted-config-only settings

Some settings are read **only** from a config you chose yourself — the
global `~/.stratus/config.json`, or a file passed with `--config` /
`STRATUS_CONFIG`. An auto-discovered project-local `stratus.config.json`
ships in any repository you clone, and none of these is a decision a clone
gets to make; a project config that tries is ignored. The three blocks say
so with a warning naming the file. `apiKeyEnv` has no such channel — it is
read while a run's provider is being resolved, before anything is logging —
so the provider's own default variable is substituted quietly, and the
setting is named in the missing-key error you get if that variable is not
set.

| Setting | Decides | Documented in |
| --- | --- | --- |
| `plugins` | Which code runs in the daemon's process, with what settings | [Tools](../guides/tools.md) |
| `approvals` | Who may authorize an agent's tool calls, and how | [Approvals](../guides/approvals.md) |
| `principals` | Whose messages an agent takes as its operator's; everyone else's arrive as `unknown` | [Slack](../../packages/channel-slack/README.md#who-counts-as-the-operator), [Memory](../concepts/memory.md#where-a-fact-came-from) |
| `api` | Which interface and port a daemon binds | [Remote access](../guides/remote-access.md) |
| `apiKeyEnv` | Which environment variable this process reads a secret out of | [Security](../concepts/security.md) |

Each block's keys and shape are documented in its own guide. `approvals`,
`principals`, and each plugin's entry also take a per-agent `agents`
sub-block, where an agent's entry overrides the defaults above it key by key
(an explicit `"slackUsers": []` excludes an agent from a shared list); the `api` block
has no per-agent form — its keys are exactly `enabled`, `host`, and
`port`.

`baseUrl` is the one setting a project config may still set and have
honoured — pointing a repository at a local model is the reason it exists —
but **no API key is sent to an endpoint an untrusted config named**, a
stored sign-in and an exported environment variable alike. The run is
refused rather than quietly redirected to the provider's official endpoint,
which would be a surprising bill and a prompt sent somewhere you did not
choose. Trust the file with `--config <path>`, or move the base URL into
`~/.stratus/config.json`.
