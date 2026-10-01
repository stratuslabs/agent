# The built-in skill — the eval

The `stratus` skill (`packages/agents/skills/stratus/SKILL.md`) is only as
good as two things a unit test cannot settle: whether a model, asked a
question about Stratus, decides to **read** it, and whether what it then
says is right. The skill's description is the only part of it in every
prompt, so a description that loses the routing decision is a skill that
never runs, however accurate its body. The CLI tests prove the file is a
valid skill that names every command; this measures what a model does
with it.

`cases.json` holds eighteen single-turn scenarios, drawn from the
questions the skill was written and fact-checked against: how a key
reaches a tool, what to do with a key pasted into chat, where the config
lives, what needs a restart, Slack setup, why a reply stopped or came from
another model, how to make the agent forget something, and which version
is running. Each runs in a Slack room, so the room line is in the prompt
too: a DM, a private channel of four, or a public channel of a thousand.

The checks are of four kinds:

| Check | Passes when |
|---|---|
| `readSkill` | The agent called `skill.read` for `stratus` before answering |
| `matches` | The reply contains the pattern, such as the right command |
| `notMatches` | It does not, such as a pasted key repeated back, or a credential link posted in a channel |
| `noToolCall` | The agent never called a given tool, such as `memory.remember` with a key pasted into chat: what it did, not only what it said |

A case runs against whatever is configured, so a check can carry a `when`
and is scored only where it has a right answer:

| `when` | Scored only when |
|---|---|
| `primary` | The configured model answered, not the fallback: the agent is told when it is on the fallback, so "yes, I switched" is right only from there |
| `fallbackConfigured` | A fallback model exists: without one there is nothing to roll over |
| `tool` | The agent's `tools:` allow that tool: an agent with no `credential.request` has no link to move to a DM |
| `notHeld` | The agent does not already hold that credential, granted in its `credentials:` and stored: a grant alone is permission for a key nobody has supplied, so only an agent holding `search.apiKey` is right to say nothing is needed |

They are pattern checks, so a failure is a reply worth reading, and a pass
is not proof. `readSkill` is on the questions an agent cannot answer well
from general knowledge or from its own instructions. A question like "are
we on the terminal?" is answered from the room line, and "do I need to
restart after editing your soul?" from the line every served agent gets
saying an edit reaches its next reply, so neither is required to read
anything.

Run it against whatever `stratus` is configured to run on, optionally as a
particular soul, or one case at a time. Without `--soul` the agent is Kai,
from `cases.json`, standing in for a roster soul at
`~/.stratus/agents/kai.md`, as every agent a Slack workspace talks to is:
it is told where its soul is and that an edit reaches its next reply, and
`credential.request` can grant a key in it. The file is named, never read
or written. A soul resolves the way the daemon
resolves it, so a `provider` or `model` it pins wins over `STRATUS_PROVIDER`
and `STRATUS_MODEL` here too:

```bash
pnpm eval:skill
pnpm eval:skill -- --soul ~/.stratus/agents/kai.md
pnpm eval:skill -- --case pasted-secret
```

It sends the prompt production sends, with the room each case names, and
the catalog the model has to choose from built the way the daemon builds
it: the shipped skill, then the skills installed in `~/.stratus/skills/`
(read, never changed), then the plugins' skills, all filtered by the
soul's `skills:`, and the memory tools. The plugins the trusted config
enables are loaded, so a provider a plugin contributes (`openai-compatible`
is one) runs here as it does in production, and the trusted config's
`maxTurns` is the budget here too. Four things are deliberately
different:

- **Memory is a throwaway store, one per case**, not the soul's own: the
  `forget-me` case would otherwise recall and retire a real fact, and a
  fact one case remembered would reach every later case's prompt.
- **`credential.request` asks nobody.** The real tool is offered to any
  soul whose `tools:` allow it, as the daemon offers it, but it answers
  the way the gateway does when no form can be shown: a form asked for
  outright is refused with nothing pending, and a link, asked for or fallen
  back to, is a placeholder. That is the riskiest real path, and what `link-in-private-channel`
  checks: the agent is handed a bearer link in a shared room and must not
  post it.
- **The run is in English.** A `language` from the soul or config is left
  out of the prompt, with a note saying so, because the checks match
  English replies and a correct answer in another language would fail them.
- **Plugin tools are not offered.** This runner has no approval policy, so
  a plugin tool would run unattended, `shell.run` included. A soul with
  many plugin tools therefore routes against a shorter list here than in
  production, and a pass on one is a little less evidence.

It prints each case with its reply and a total, and exits non-zero when a
case fails. A case the `fallbackModel` answered, because the primary
failed, says so, and so does the total: its pass or failure is the
fallback's, not the primary's. A case where both failed says that instead. It refuses to run on the demo provider, which would answer
from a script.

When the skill changes, run this before and after: a rewrite that reads
better and routes worse is a regression no other test sees.
