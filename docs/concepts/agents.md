# Agents are people

Stratus agents are designed to feel like a person you work with, not a
stateless bot:

- **One identity everywhere.** An agent's memory is keyed to the agent —
  never to a session or channel — so what they learn in one thread they
  know in every other conversation. See [Memory](./memory.md).
- **Scoped access.** Each agent has its own tool allowlist and its own
  credential allowlist. An agent can only call the tools it was given, and
  can only resolve the secrets it was granted.
- **Delegation.** An orchestrator agent uses the `agent.delegate` tool to
  hand a task to a teammate and gets their reply back — the teammate runs
  with *their own* memory, tools, and credentials.
- **Routing.** `createAgentRouter` maps inbound work (a channel, a mention,
  a message) to the right agent, so the same person consistently answers in
  the same places.

## Creating an agent

One call — or one command. If you don't name them, we will, and every agent
gets a deterministic color palette derived from their name, rendered in the
one shared Stratus avatar style — so the team looks cohesive and each agent
looks the same on every surface:

```bash
stratus agent new
# Say hello to Freya.
#   id      freya-k3x9
#   avatar  stratus theme, hue 211, palette #3d7dd9 #8fb8ea #d9993d
```

```ts
import { defineAgent } from '@stratusagent/agents';

const scout = defineAgent({ instructions: 'You research things thoroughly.' });
// scout.name → "Arlo", scout.avatar → matching palette + style
```

## Soul files

An agent can live in a file. A soul file is markdown with frontmatter — the
frontmatter carries the structured identity (name, provider, model, tool,
skill and credential allowlists) and the body is the persona itself,
written in prose:

```markdown
---
name: Ava
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
  - memory.*
skills:
  - code-review
---

You are a sharp, warm generalist assistant. Answer first, explain second...
```

Run it directly, point your config at it, or generate one to start from:

```bash
stratus run --soul ./examples/souls/ava.md "hello"
stratus agent new --format soul > my-agent.md   # generated identity, ready to edit
```

Two well-written example souls live in
[`examples/souls/`](../../examples/souls) — they double as the format docs.
A soul's provider/model are hints:
[`--provider`/`--model` flags and `STRATUS_*` env vars still win](../reference/config.md).

The `tools:` list is the per-identity gate over everything a plugin
installs — see [Tools](../guides/tools.md) — and `skills:` opts into
procedures the same way — see [Skills](../guides/skills.md).

## Ids are not labels

Frontmatter may set `id:` explicitly, and it keys the agent's sessions,
memory, credentials, Slack tokens, and every per-agent path on disk. So it
has to stay one path segment, and one ordinary map key: an id may not start
with a dot or contain a slash, a backslash, a control character, or leading
or trailing whitespace, and it may not be a name every object already
answers to (`__proto__`, `constructor`, `toString`). Anything that would
leave its directory is rejected when the soul loads rather than quietly
cleaned up — `id: ../../escape` is refused, not rewritten to `escape`.

Anything else is yours. An id like `Ava_1` or `team.alpha` is unusual but
harmless, and it is already keying that agent's sessions and sign-ins, so
it is left exactly as written. Omit `id:` and one is derived from the name
as a plain slug (`ava`); a generated agent's id is also capped at 64
characters, but a slug derived from a name you chose is used whole, because
shortening an id moves the agent it belongs to.

Creating an agent checks the id against every id the served roster holds,
not against the filenames on disk: what the roster files *declare* (a soul
at `renamed.md` can declare `id: ava`), the configured default soul even
when its file lives elsewhere, and the reserved `stratus`. A new agent gets
a suffixed id (`ava-3f9c`) rather than one that would collide. Its name
stays the one you chose.

## Two souls cannot share an id

That is not two agents; it is one agent whose memory and sign-ins belong to
whichever file sorted first. The roster refuses to load and names both
files, `stratus serve` will not start, `stratus doctor` reports it, and
`stratus setup` → Channels offers no agents at all — nothing is servable
while the roster is ambiguous, so connecting a Slack app would configure
something that cannot run. Neither command offers to clear "unmatched"
Slack tokens in that state either: a roster that would not load cannot
prove which ids are missing, and the tokens at risk belong to agents that
are perfectly fine. (An unreadable *single* soul still degrades to a
warning — one broken file never takes the team down. A collision has no
correct winner, which is the difference.) The built-in `stratus` id is
reserved: souls claiming it are skipped — including two of them, since
neither was going to get the id, so their agreeing on it is not a collision
to refuse over.
