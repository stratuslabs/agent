# Agents

Stratus agents are designed to work like a teammate, not a stateless bot:

- **One identity everywhere.** An agent's memory is keyed to the agent —
  never to a session or channel — so what they learn in one thread they
  know in every other conversation. See [Memory](./memory.md).
- **Scoped access.** Each agent has its own tool allowlist and its own
  credential allowlist. An agent can only call the tools it was given, and
  can only resolve the secrets it was granted.
- **Delegation.** An orchestrator agent uses the `agent.delegate` tool to
  hand a task to a teammate and gets their reply back — the teammate runs
  with *their own* memory, tools, and credentials. Who it may hand work to
  is its soul's `delegates:` list — agent ids, or `*` for anyone on the
  roster — and, like `credentials:`, omitted means nobody: running a turn
  as another agent is the lateral move an injected prompt would ask for.
  Because `*` means anyone, no agent may have it as an id: a soul that
  declares `id: *` is skipped at load with a message naming the fix, and
  its sessions, memory, and credentials stay on disk under that id. The
  registry refuses the id too, so a definition built in code cannot put
  it on the roster either.
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

That gives you an identity with no capability. A
[template](../guides/templates.md) gives you a working one: a folder or a
GitHub repo carrying the soul, the skills it uses, and the plugin config
behind its tools, installed in one reviewed command.

```bash
stratus template add ./examples/templates/example
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

Every agent is also told, ahead of its persona, to keep replies the size
of a text message — under six lines of plain prose, no headers or bullet
lists, no preamble or closing offer, at most one follow-up question — and
to go longer only when asked for depth or a document, or when a decision
turns on detail the reader lacks. The persona comes after that and wins
where they disagree, so a soul written for long-form work just says so:

```markdown
When asked for a report, write the full report — headings and all.
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
`provider:` may name a built-in or the name a
[plugin provider](../guides/extending.md#providers) registers.

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
it is left exactly as written. Mixed case is fine on its own; what is not
is *two* ids a filesystem would read as one name — differing only in case,
or only in how an accent is encoded. That is a collision, and so is an id
that collides that way with the reserved `stratus`. See below.

Omit `id:` and one is derived from the name
as a plain slug (`ava`); a generated agent's id is also capped at 64
characters, but a slug derived from a name you chose is used whole, because
shortening an id moves the agent it belongs to.

Creating an agent checks the id against every id the served roster holds,
not against the filenames on disk: what the roster files *declare* (a soul
at `renamed.md` can declare `id: ava`), the configured default soul even
when its file lives elsewhere, and the reserved `stratus`. It checks by the
same folded rule the roster and the filesystem use, so an existing `AVA`
blocks a new `ava` — otherwise the command would report a new agent and
leave a roster that refuses to load. `stratus template add` applies it to
the souls a template ships, against each other as well as against yours. A
new agent gets a suffixed id (`ava-3f9c`) rather than one that would
collide. Its name stays the one you chose.

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
to refuse over — in any case it is spelled, since `agents/Stratus/` is the
built-in agent's own state directory wherever the filesystem folds case.

Two ids the **filesystem** would treat as one name are the same collision,
and are refused the same way. An id names the agent's directory under
`~/.stratus/agents/`, and macOS and Windows resolve `Ava` and `ava` to one
of them — so the two agents would share their conversations, their
memories, and the file that says what each may do unattended. Case is not
the only thing folded: APFS also ignores Unicode normalization, so `café`
written with one code point and `café` written with a combining accent are
one directory there and two different strings everywhere else. Both count.
It is refused on every platform, Linux included: a souls directory is
copied between machines, and a roster that loads on the server and refuses
on the laptop finds the problem at the worst moment. Rename one of the two.

The configured default soul is held to the same rule from the other side.
It does not live on the roster, so it is checked against the agents already
registered when it resolves: a default whose id would open a roster agent's
directory — or the built-in `stratus`'s — is ignored with a line saying so,
and agentId-less turns route to the built-in until you rename one of them.
The roster agent keeps serving either way.
