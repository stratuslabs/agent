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

Setup writes only the keys its own menus set, and carries every other key
it finds through unchanged — the `api` and `principals` blocks, and the
`vision`, `promptCache`, and `promptCacheTtl` preferences. The `plugins` and
`approvals` blocks have menus, and those menus edit what they read: a plugin
switched off keeps its settings under `enabled: false`, and per-agent
`agents` overrides and `toolRisks` entries setup never asks about survive
every pass. See [Setup](../start/setup.md#where-everything-lands).

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
| `provider` | `anthropic`, `openai`, `codex`, `demo`, or the name a [plugin provider](../guides/extending.md#providers) registers (`ollama`) |
| `model` | Model for that provider |
| `baseUrl` | Override the provider API base URL (local models, proxies) |
| `apiKeyEnv` | Name of the environment variable holding the API key — trusted configs only, see below |
| `systemPrompt` | System prompt for the run — trusted configs only, see below |
| `soul` | Path to a soul file, resolved relative to the working directory — trusted configs only, see below |
| `fallbackModel` | Model to retry with when the default model errors mid-run |
| `fallbackProvider` | Provider serving the fallback model — defaults to the main provider; a plugin provider's name works here too |
| `fallbackBaseUrl` | Base URL for an OpenAI-compatible fallback (e.g. a local model) |
| `promptCache` | Cache the stable head of each Anthropic request. Default `true` — see below |
| `promptCacheTtl` | How long a cache entry lives: `5m` (default) or `1h` |
| `maxTokens` | Per-turn output cap sent to Anthropic. Default `16000`; lower it for a model or proxy whose ceiling is below that, raise it for longer answers — see below |
| `vision` | Whether an OpenAI-compatible model takes images — the main one or the fallback, it is one setting. Default `true`; set `false` for a text-only model, which would otherwise reject every turn of a session an image was sent to — see [Slack](../guides/slack.md#sending-an-image) |
| `approvals` | Unattended-approval policy for `stratus serve` — trusted configs only, see below |
| `principals` | Which channel senders are each agent's operator: `slackUsers` (Slack user ids), and whether anyone else gets a turn at all: `admit` (`anyone`, the default, or `principals`), each with a per-agent `agents` sub-block — trusted configs only, see below |
| `api` | Control API binding for `stratus serve` — trusted configs only, see below |
| `plugins` | Plugins to load, keyed by package name — trusted configs only, see below |
| `executor` | Which executor runs tool calls: `local` (the default) or the name a [plugin executor](../guides/extending.md#executors) registers — trusted configs only, see below |
| `memoryStore` | Which store backs agent memory: `file` (the default) or the name a [plugin memory store](../guides/extending.md#memory-stores) registers — trusted configs only, see below |
| `maxTurns` | How many provider turns one message may spend before the turn is failed as a runaway. Default `8` — trusted configs only, see below |

Credentials stored by setup live in `~/.stratus/credentials.json`
(owner-read-only) and are **endpoint-bound**: a credential saved for one
endpoint is never sent to an endpoint a project-local config selects. See
[Security](../concepts/security.md).

That file also holds every **channel's transport secrets**, under
`channels.<kind>.<agentId>` — Slack's app and bot tokens, and whatever a
[plugin channel](../guides/extending.md#channels) documents for its kind.
They are the daemon's own, never an agent's: nothing resolves them through
a soul's `credentials:` list.

That file also holds **named credentials** — the `search.apiKey` a search
backend asks for, and whatever the ecosystem asks for next. They are a
different kind of thing from a provider sign-in: a sign-in is the daemon's
own, while a named credential is an *agent* capability, gated by that
agent's `credentials:` soul list and resolved per call — the agent's own
entry first, then the fleet's shared one, then the environment. Add one with
[`stratus credential set`](./cli.md); never write a key into a config file,
which is a file people commit.

## How long an answer may be

Anthropic requires a per-turn output cap, and `maxTokens` sets it. The
default is 16000.

```json
{
  "maxTokens": 4096
}
```

A reply that hits the cap is **refused, not returned**: the model was still
going, so what arrived is a fragment, and a fragment delivered as an answer
reads exactly like a complete one. The error names the cap that was in
force.

Two reasons to set it:

- **Lower**, for a model or a `baseUrl` proxy whose own ceiling is under
  the default. The adapter takes whatever model name you give it, so it
  cannot know — and a cap above what the endpoint accepts is refused
  before anything is generated, on every turn.
- **Higher**, for agents that write long answers. Past roughly 20000 this
  only works where the request streams: the Anthropic SDK refuses a
  non-streaming call whose cap puts its estimated duration past ten
  minutes. `stratus serve` streams, so a daemon can go higher; `stratus
  run` cannot always.

A configured Anthropic `fallbackModel` runs under the same cap, like
`promptCache` and `promptCacheTtl` — one setting for the daemon, applying
to whichever Anthropic model ends up serving the turn. That matters most
here: a fallback left on the default would fail every request from the
moment it took over.

It is not a budget — nothing is spent for being allowed, only for what the
model actually writes. The other providers ignore it: the harnesses choose
their own cap, and the OpenAI-compatible adapter sends none, so there the
ceiling is the endpoint's own default.

## How many turns one message may spend

A dispatched turn calls the provider, runs whatever tools it asked for,
calls the provider again with the results, and repeats. `maxTurns` is the
ceiling on that loop — the point at which the turn is failed rather than
allowed to keep going.

```json
{
  "maxTurns": 24
}
```

The default is 8, which is the whole budget for one Slack message: a task
that needs nine rounds of tool calls fails on the ninth. It fails *before*
the ninth provider call rather than after it, so there is no partial
answer — the error is `Session exceeded the maximum of 8 provider turns`,
and the work of the first eight turns is in the transcript but was never
summed up. Sending the message again resumes the session with the ceiling
reset, which is the recovery; raising `maxTurns` is the fix.

Raise it for agents that do multi-step work — reading several files,
walking a set of issues, anything with a fan-out. Leave it low for a fleet
that answers questions.

It is a **spending** limit as much as a safety one, which is why it is
trusted-config only: a turn that loops 500 times costs 500 provider calls.
That cuts both ways, so a project-local config cannot lower it either. The
floor is 1, and 1 does not stop the daemon answering: the ceiling is
tested before each provider call, so the first one is always allowed and a
question the agent can answer outright still gets answered. What it stops
is the *second* turn — every agent that reads a file, searches, or calls
any tool at all fails the moment it tries to use the result.

A delegated sub-session gets its own allowance rather than a share of its
parent's: `agent.delegate` starts a separate dispatch, and each dispatch is
held to this ceiling. The bound on delegation *depth* is a different
setting — see [Tools](../guides/tools.md).

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
so with a warning naming the file. A project config that says nothing
about a block leaves the global file's block in force — a clone that
cannot set a policy cannot make one disappear either, so `stratus serve`
started inside a repository still runs under your own `principals`. `apiKeyEnv` has no such channel — it is
read while a run's provider is being resolved, before anything is logging —
so the provider's own default variable is substituted quietly, and the
setting is named in the missing-key error you get if that variable is not
set.

| Setting | Decides | Documented in |
| --- | --- | --- |
| `plugins` | Which code runs in the daemon's process, with what settings | [Tools](../guides/tools.md) |
| `executor`, `memoryStore` | Which of that code an agent's commands run in, and where its memories are written — a cloned repo swapping a sandbox for the host is the downgrade this refuses | [Extending](../guides/extending.md) |
| `approvals` | Who may authorize an agent's tool calls, and how | [Approvals](../guides/approvals.md) |
| `principals` | Whose messages an agent takes as its operator's; everyone else's arrive as `unknown` | [Slack](../../packages/channel-slack/README.md#who-counts-as-the-operator), [Memory](../concepts/memory.md#where-a-fact-came-from) |
| `api` | Which interface and port a daemon binds | [Remote access](../guides/remote-access.md) |
| `maxTurns` | How long a loop one message can buy, which is both a runaway guard and a spending limit | [Always on](../guides/always-on.md#how-many-turns-one-message-may-spend) |
| `apiKeyEnv` | Which environment variable this process reads a secret out of | [Security](../concepts/security.md) |
| `soul`, `systemPrompt` | What the agent is told it is and what it may do — a persona in a cloned repo is a system prompt written by whoever pushed it. `--soul` and `STRATUS_SOUL` still name one; the run says once, on stderr, what the file asked for and did not get, and `stratus serve` says it once at startup, whether or not its runtime resolves | [Security](../concepts/security.md) |

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
