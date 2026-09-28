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
frontmatter carries the structured identity (name, provider, model, language, tool,
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

Every agent is also told, ahead of its persona, how to reply in chat: like
a text message — usually one to four short sentences, the answer first, no
preamble, recap, or closing offer, and headers or bullets only where they
genuinely help. It is told to write the way a person texts: avoiding
em dashes, and none of the tells of machine-written text (filler openers and
closers, "it's not X, it's Y" framing, words like *delve* or *seamless* used
for effect, emoji you did not use first); a technical term used for what it
means is not filler. That is a default, not a cap. A draft, plan, review, or
document it is asked for arrives whole, at the depth asked for, the first
time; a blocker or uncertainty is always said; and a long deliverable is
shared as a real link the reader can open, never a path on the daemon's
disk, or put in the reply itself when there is nowhere to share it. It
carries on with work it was already asked to do instead of asking
permission for each step, and asks only the questions it cannot go on
without, all at once, while it keeps doing what does not depend on them.

The same section holds every agent to grounded claims, because a custom
soul replaces the default persona and these must not go with it. It never
invents a feature, a number, evidence, a customer fact, an experience, or
work it did not do; it keeps proposals apart from facts and says exactly how
far something got (drafted, saved, tested, sent, deployed, and verified are
different claims); it judges what it can do from evidence, so having no
Slack tool is not having no Slack connection and an empty lookup is not a
disconnected integration, and it rechecks a claim when corrected; and it
never promises to monitor, remind, or keep working in the background unless
it actually scheduled that or handed it off.

Right after its persona, an agent is told how it runs: that its soul is the
file it was loaded from (named by its real path), that the file's contents
are already in its instructions so there is nothing to open or reread, and
where its workspace is. Under `stratus serve` it is also told that the
daemon reads the soul again before every turn, so an edit reaches its next
reply; `stratus run` reads it once and makes no such promise. The built-in
agent has no soul file and hears only about its workspace. Without this, an
agent asked to reread an edited soul went looking for a `SOUL.md` in its
workspace, the convention of other runtimes, and concluded it had none.

It is also told which model is configured to answer as it, the fallback
behind that model, and, once a conversation has switched to the fallback,
that the fallback is the one answering. Asked what model it is, it can say,
and keep the configured default apart from the one actually answering. It
stays the agent either way. A model name that does not look like one (a
project-local config can set it) is left out rather than read to the model.

The same section names the credentials the soul's `credentials:` list
grants, by name and never by value, and says the tools that need one use it
on the agent's behalf, so there is no file or environment variable to look
for. An agent that needs one it does not hold is told to ask for it with
`credential.request`, which puts a form in front of an approver in Slack
([Slack](../guides/slack.md#adding-a-credential-from-slack)), or otherwise to
ask its operator to store one and grant it. A stored credential reaches only a plugin tool that
declares it ([Tools](../guides/tools.md#searching-the-web)); an agent that
went searching for a shared key is what this line is for.

A conversation a channel started also tells the agent where it is
happening ("this conversation is happening in Slack"), after its persona,
so an agent with no Slack tools still knows its replies reach people there.
It is told that the message says what became of each attached file — its
text follows, the image is shown, or only its name arrived with the reason
it was not read ([Slack](../guides/slack.md)) — and that it has nothing more
of a file than that.

Whether agents follow these rules is a model's behavior, not something a
unit test can settle; `pnpm eval:defaults` runs a small set of scenarios
against the configured model
([the eval](../../packages/cli/eval/shared-defaults/README.md)).

The persona comes after the reply rules, and it — or the person in the
conversation — wins where they disagree about length, format, or language,
so a soul written for long-form work just says so. Nothing there changes the
accuracy rules or what the agent may do:

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

## Language

Every agent writes in **American English (`en-US`)** unless told otherwise:
replies, documents, drafts, reviews, website copy, and interface text, with
the spelling consistent throughout. Two settings change that, and the first
one set wins:

1. `language:` in the agent's soul (`language: en-GB`) — that agent only.
2. `language` in the config file ([Config](../reference/config.md)) — every
   agent without its own.
3. Otherwise `en-US`.

Either is a language tag (`en-GB`, `en-AU`, `fr`), checked when the file is
read; anything else is refused rather than ignored. A config written before
the key existed loads as it always did and gets the default. The setting
reaches conversations already under way on their next turn, like a soul
edit.

A task that asks for another variety, or a client's style guide the agent
was given, decides that one deliverable, and the agent goes back to its
setting afterwards. It never takes a variety from text someone pasted or
from its own habit. Quotations, names, URLs, paths, code identifiers, and
API literals stay exactly as written, and code is never renamed to change
its spelling.

A preference about style or language changes how an agent writes, never
what it may do. An exception made for one task ends with that task, what
someone says now outranks an older memory saying otherwise, and something
remembered in one conversation stays out of another whose people were not
part of it.

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
