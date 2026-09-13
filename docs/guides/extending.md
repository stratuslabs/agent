# Extending Stratus: providers, channels, memory stores, executors

Four things a plugin can supply besides tools and skills — and how each one
is selected once it is installed. The contract a plugin author writes
against is [`architecture/plugins.md`](../architecture/plugins.md); this
page is the operator's half: what to put in a config or a soul, and what
the daemon refuses.

Everything here follows the two rules every plugin already obeys. **A plugin
runs only when it is listed and enabled in a trusted config** — the global
`~/.stratus/config.json`, or a file passed with `--config` — never by being
installed. And **installing grants nothing by itself**: a provider has to be
selected by a soul, a channel needs tokens stored for an agent, and an
executor or memory store has to be named in the config before any of it
does anything.

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "stratus-plugin-ollama":   { "enabled": true, "baseUrl": "http://127.0.0.1:11434" },
    "stratus-plugin-discord":  { "enabled": true },
    "stratus-plugin-vectors":  { "enabled": true },
    "stratus-plugin-sandbox":  { "enabled": true }
  },
  "executor": "sandbox",
  "memoryStore": "vectors"
}
```

`stratus plugins` lists what each installed plugin declares and how it is
selected:

```console
$ stratus plugins
stratus-plugin-ollama         installed, enabled
  provider ollama             a soul selects it with provider:
stratus-plugin-discord        installed, enabled
  channel discord             starts for the agents with tokens under channels.<kind> in credentials.json
```

## Providers

A plugin registers a provider under a **name** — `ollama`, `openrouter` —
and a soul selects it exactly as it selects a built-in:

```markdown
---
name: Ava
id: ava
provider: ollama
model: llama3
---
```

The same name works in the config file's `provider` and `fallbackProvider`,
in `--provider`, and in `STRATUS_PROVIDER`. A built-in name (`anthropic`,
`openai`, `codex`, `demo`) always means the built-in; a plugin cannot
register one of those.

Two things differ from a built-in provider, and both follow from the plugin
owning its own connection:

- **No sign-in is stored for it.** A plugin provider takes its endpoint and
  settings from its own block in `plugins`, and any key it needs through
  the credentials its manifest declares — a
  [named credential](../reference/config.md) the agent's soul allowlists,
  set with `stratus credential set`. `stratus setup` does not ask for one,
  and `stratus doctor` reports the provider without a key line.
- **`model:` is a hint the provider may leave unset.** A soul or config that
  names one gets it; one that does not runs on the provider's own default,
  and the roster listing says so rather than guessing.

Diagnostics show the resolved form, `plugin:ollama`, so a line in
`stratus doctor` or a session's metadata says at a glance that a plugin is
serving the run. A soul naming a provider no loaded plugin registers is
refused when its first turn is built, naming what *is* registered:

```
No provider named ollama is registered (plugins registered: fixture). Built in: demo, openai, anthropic, codex. Enable the plugin that contributes ollama in the plugins block of a trusted config, or select another provider.
```

A plugin provider works as a **fallback target** too: `fallbackProvider:
ollama` with a `fallbackModel` fails over to it when the primary errors
mid-run, under the same sticky-fallback rules as a built-in.

The first-party one is
[`@stratusagent/provider-openai`](../../packages/provider-openai): the same
chat-completions adapter the built-in `openai` selection uses, registered
as `openai-compatible`, with its endpoint in its config block and its key
resolved per agent from the `openai.apiKey` named credential.

## Channels

A channel plugin registers an adapter for a **kind** — `discord`, `matrix` —
and carries the agents that have transport secrets stored for that kind.
Those are the agents it speaks for, inbound and out: an agent's
`message.send` to that kind goes through the adapter carrying it, and an
agent no adapter of the kind carries is refused rather than posted under
another agent's identity.
The secrets live where Slack's tokens already do, in
`~/.stratus/credentials.json` under `channels.<kind>.<agentId>`, and the
plugin's README says which names to store:

```jsonc
// ~/.stratus/credentials.json (0600)
{
  "channels": {
    "slack":   { "ava": { "appToken": "xapp-…", "botToken": "xoxb-…" } },
    "discord": { "ava": { "botToken": "…" }, "juno": { "botToken": "…" } }
  }
}
```

Store them through the control API — `PUT /credentials/channels/discord`
with `{ "agentId": "ava", "secrets": { "botToken": "…" } }` — or by editing
the file; `stratus setup`'s channel menu is Slack's. Saving Slack tokens
never disturbs another kind's, and `GET /credentials` lists which agents
are bound on each kind, ids only.

These are **the daemon's secrets, not the agent's**. A channel plugin
receives its own kind's entries through a host-owned handle; nothing
resolves them through a soul's `credentials:` list, so an agent cannot read
the tokens of the transport carrying it, whatever the token is called.

One agent may be reachable on several kinds — Slack and Discord both — and
that is not a collision. What collides is two plugins both claiming the
same kind for the same agent, which refuses the second plugin at load.
Channels start after the roster and stop before plugins are disposed, in
the order the `plugins` block lists them.

`stratus run` and `stratus chat` have no channels; a channel plugin listed
in the config still loads there, registers nothing, and is told so if it
asks for its secrets.

## Memory stores

A memory-store plugin registers a store under a name, and the config
selects it fleet-wide:

```jsonc
{ "memoryStore": "vectors" }
```

`file` (or the key absent) is the built-in store. The selected store backs
`memory.remember`, `memory.recall`, `memory.forget`, and the memory each
turn's prompt is built from, for every agent — still keyed per agent by the
[memory contract](../concepts/memory.md), so two agents on one store never
see each other's entries. `stratus run` reads the same key from the same
trusted config, so a local test remembers into the store the daemon would.

A `memoryStore` naming something no loaded plugin registers **refuses to
start** rather than falling back to the file store: a daemon writing
memories somewhere the operator did not select is a daemon whose agents
remember into the wrong place.

The first-party one is
[`@stratusagent/memory-sqlite`](../../packages/memory-sqlite): the same
contract on one owner-only SQLite file, with no derived index, selected
with `memoryStore: sqlite` and a `path` in its config block. Nothing is
migrated between stores when you switch.

## Executors

An executor plugin registers an executor under a name — the seam an
isolated or containerized runtime arrives through — and the config selects
it for every tool call:

```jsonc
{ "executor": "sandbox" }
```

`local` (or the key absent) is the built-in child-process executor. As
with the memory store, a name nothing registers refuses to start: an
operator who selected a sandbox must not find their agents' commands
running on the host anyway. A session's metadata records which executor
ran it (`local-command` for the built-in, the registered name otherwise).

## What is trusted-config-only, and why

`executor` and `memoryStore` are read only from a trusted config, exactly
like `plugins`. The plugins block decides which code runs inside the
daemon; these two decide which of that code an agent's commands run in and
where its memories are written. An auto-discovered project-local
`stratus.config.json` ships in any repository you clone, and swapping a
sandbox executor for the host's is precisely the decision a clone must not
get to make — its key is ignored with a warning naming the file, and the
global file's choice stays in force. `PUT /config` on the control API
carries both across a settings save untouched and never writes them.

## Writing one

The contract — the `contributes` manifest kinds, the handles a plugin's
`setup()` registers through, what the view refuses and why, and the shape
each contribution takes — is in
[`architecture/plugins.md`](../architecture/plugins.md#registering-providers-channels-memory-stores-and-executors).
The four fixture plugins under [`fixtures/`](../../fixtures/README.md) are
the smallest complete example of each kind.
