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

The checks are of three kinds:

| Check | Passes when |
|---|---|
| `readSkill` | The agent called `skill.read` for `stratus` before answering |
| `matches` | The reply contains the pattern, such as the right command |
| `notMatches` | It does not, such as a pasted key repeated back, or a credential link posted in a channel |

They are pattern checks, so a failure is a reply worth reading, and a pass
is not proof. `readSkill` is on the questions an agent cannot answer well
from general knowledge; a question like "are we on the terminal?" is
answered from the room line and is not required to read anything.

Run it against whatever `stratus` is configured to run on, optionally as a
particular soul, or one case at a time:

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
is one) runs here as it does in production. Two things are deliberately
different:

- **Memory is a throwaway store**, not the soul's own: the `forget-me`
  case would otherwise recall and retire a real fact.
- **Plugin tools are not offered.** This runner has no approval policy, so
  a plugin tool would run unattended, `shell.run` included. A soul with
  many plugin tools therefore routes against a shorter list here than in
  production, and a pass on one is a little less evidence.

It prints each case with its reply and a total, and exits non-zero when a
case fails. It refuses to run on the demo provider, which would answer
from a script.

When the skill changes, run this before and after: a rewrite that reads
better and routes worse is a regression no other test sees.
