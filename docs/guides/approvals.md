# Approvals

At a terminal, `stratus chat` and `stratus run` ask you directly:
`--approvals` is `always`, `ask` (a y/N prompt on every call), `gated`
(`safe` tools run, everything else asks — exactly the line the daemon
draws below), or `never`. `gated` is the default when stdin is a terminal.
When stdin is a pipe or a script, or the prompt came in through `--stdin`,
nobody can answer a y/N, so the default is `always`, and the run says so
once on stderr the first time a gated tool runs. This page is about the
daemon, where there is no terminal to prompt on.

## What the daemon will do on its own

Tools declare how much damage they could do — `safe`, `gated`, or
`dangerous` — and the daemon runs only the safe ones without asking.
Anything riskier is refused, with a line in the log saying which agent
wanted what:

```text
09:14:36  —           warning: blair: shell.run is gated and nobody is available to approve it (session slack:blair:…)
```

That is the honest default (`headless`) behind a service manager. If
somebody *is* reachable, `--approvals remote` asks them instead — see
below. What somebody has already answered **Always allow** to still runs
unattended: a command scope, a site, or a standing grant on the tool — see
[Standing grants](#standing-grants) — unless the conversation has read a web
page and you have asked for that to cost it its grants; see
[After an agent reads the web](#after-an-agent-reads-the-web).

A tool that declares no risk counts as `gated`, never `safe` — forgetting
to classify something should cost a prompt, not an unattended command. Most
built-in tools (`demo.echo`, `memory.remember`, `memory.recall`,
`memory.forget`, `agent.delegate`, `schedule.list`, `schedule.cancel`) are
`safe`; the built-in exceptions are `schedule.every`, `schedule.at`, and
`message.send`, which are `gated` because they act past the end of the
turn — see [Schedules](./schedules.md). Anything you install is where this
starts to bite, which is what [Tools](./tools.md) is about.

Three tools are the exception to the whole paragraph, because their risk is
in what a particular call does rather than in the tool's identity. All are
`gated`, and the permission engine then judges each call:

- **A shell**, by the command it would run — see [Shell commands](./shell.md).
- **`browser.act`**, by the site the conversation is on — see
  [Browser actions](./browser.md).
- **`web.fetch`**, by the site of the URL it fetches. **Always allow** on
  one grants that site (`https://docs.example.com`), never every URL. A
  redirect to a different site is not followed: the result names where it
  pointed (`redirectedTo`), and fetching that is a call of its own, judged
  the same way. `http://` moving to `https://` on the same host is followed.

Nothing built in is `dangerous` any more. The tier is still there, and an
operator's `toolRisks` or a plugin's manifest can still put a tool in it —
it is the only way to say "never unattended, whatever scopes exist" about
somebody else's code — but no first-party tool declares it. `browser.act`
was its one member, and it was there because no scope model existed for a
click rather than because a click is worse than a shell command.

A `dangerous` call asks **every time**, and **Always allow** on one does not
change that: the call runs, and nothing is remembered. Three other calls
behave the same way — a browser action with no page to grant, a shell
command the parser cannot reduce to a scope, and any call from a
conversation the [external-content gate](#after-an-agent-reads-the-web) has
closed — and all four are called **one-shot**: they are not offered **Always allow** at all, on any surface.
Slack, the dashboard, and the terminal prompt each say that an approval
covers the one call, rather than showing a button that does nothing extra.

The `dangerous` half of that is stricter than it used to be — the
session-wide grant applied to `dangerous` too, which made "always a human" a
promise about the first call only — and the tier is worth having only if it
means what it says.

The line is *acting outside Stratus* — the filesystem, the network, another
service — not cost. Every turn spends provider tokens, including the one
that decided to call a tool, so a policy that gated on spend would have to
gate the conversation itself. Delegation stays `safe` for the same reason:
it hands work to a teammate inside the fleet, that teammate's own tool
calls face this policy again under their allowlist, and the chain is depth
bounded.

## Asking a human: remote approval

In `remote` mode a gated call does not fail — the turn parks, the request
is posted to Slack with **Allow once**, **Always allow**, and **Deny**, and
the turn resumes on the answer. The question goes to the thread the turn is
happening in, so whoever is talking to the agent sees it where they already
are.

Turn it on for the daemon with `--approvals remote`, or in
`~/.stratus/config.json` so the installed service picks it up too:

```jsonc
{
  "approvals": {
    "mode": "remote",              // headless (default) or remote
    "timeoutMs": 900000,           // unanswered after 15 minutes → denied (max 2147483647)
    "slackApprovers": ["U01OPS"],  // who may decide, for every agent
    "slackChannel": "C07OPS",      // where to ask when the turn isn't in Slack
    "agents": {
      "blair": { "slackApprovers": ["U01DYLAN"] }
    }
  }
}
```

An agent inherits the top-level route key by key, so `blair` above asks its
own approver in the shared `C07OPS` fallback channel. An explicit
`"slackApprovers": []` on an agent excludes it from the default list — that
agent's gated calls are then denied outright — while omitting the key
inherits.

**Only a config you chose is allowed to set this block** — `--config`,
`STRATUS_CONFIG`, or the global `~/.stratus/config.json`. An
auto-discovered project-local `stratus.config.json` outranks the global one
for provider settings, but it can be checked into any repository, and
appointing the people who may authorize an agent's tool calls is not
something a clone gets to do. Its `approvals` block is ignored, with a
warning naming the file.

## Before you turn it on

- **Approvers are people, not places.** Posting into a channel does not
  make everyone in it an approver: each request is bound to the ids
  configured for that agent, and anyone else's click is refused with a
  notice only they see. The request stays open for someone who may actually
  answer it. This matters most for **Always allow**, which widens what the
  agent may do unattended.
- **An agent with no approver configured is denied immediately**, not left
  to time out — `remote` with nobody listed behaves exactly like
  `headless`. If no channel can ask for an agent at all (no Slack tokens
  for it, or `@stratusagent/channel-slack` not installed) there is nothing
  to render the request, so its gated calls wait out the timeout instead.
  The daemon names those agents at startup, rather than leaving you to find
  out at 3am:

  ```text
  approvals: remote — gated calls are parked and asked in Slack (approvers set for blair)
  ```
- **A parked turn survives a restart.** The daemon records what has not run
  before it asks, so an approval outstanding when it stops is finished when
  it starts again — the question is re-asked in Slack, the call runs on the
  answer, and anything queued behind it still runs too. The re-asked
  request keeps the window it started with rather than getting a fresh one,
  and a wait that has already used up its `timeoutMs` is denied instead of
  re-asked: downtime is not a reason to extend a security decision.
- **A turn that was mid-flight is failed, not left hanging.** Parking is
  the one state a restart can resume from — a turn that stopped anywhere
  else (waiting on the provider, inside a tool, or on an approval asked by
  an agent billed through a Claude subscription, which is deliberately not
  checkpointed) cannot be. Those sessions come back marked `failed`, with a
  reason saying stratusd stopped while they were running and to send the
  message again, rather than claiming to still be running forever. This is
  only for an ungraceful stop: a normal restart denies what is parked and
  finishes the turns those denials release before it exits. The thread
  hears about it too: a turn that fails with nobody rendering it is
  reported where it was asked, rather than going quiet and reading as an
  agent that never replied.

  A sub-session started by `agent.delegate` is the one parked turn that is
  *not* resumed. Its reply is read by the delegating turn and nothing
  else, and that turn was mid-flight — it is one of the sessions failed
  above — so re-asking the question would have someone approve a command
  that runs for no one. The sub-session comes back `failed` too, with a
  reason naming the delegating turn, and the message to repeat is the one
  that started the delegation. This applies only while the sub-session is
  the delegation's: `agent.delegate` reports the sub-session's id, and a
  message sent to that id afterwards continues it as an ordinary
  conversation, whose parked turns are resumed like any other.
- **A button left behind by a dead daemon corrects itself when clicked.** A
  normal shutdown retracts its buttons; a crash cannot, and the new process
  has no record of what the old one posted. Clicking such a prompt tells
  you it is no longer pending *and* rewrites the message so the next reader
  is not offered a decision nothing is waiting for. A prompt nobody clicks
  stays as it is.
- **Always allow means one thing: granted to this agent, until you revoke
  it.** What it grants depends on how the tool is judged, and the prompt
  says which before you answer. A call judged by a *scope* persists that
  scope — a command scope for `shell.run` (see
  [Shell commands](./shell.md)), an origin for `browser.act` (see
  [Browser actions](./browser.md)) and for `web.fetch`. Every other gated tool gets a
  **standing grant** on the tool itself — see
  [Standing grants](#standing-grants). The one exception is a send outside
  a schedule (`message.send`): a grant there would be a yes to every
  destination, and no per-destination grant exists yet, so it lasts for
  the session and the prompt says so. Everything else lives in
  `~/.stratus/agents/<id>/whitelist.json` and survives a restart. When that
  file exists and no longer parses it is never written over, so the answer
  holds only until the daemon stops; the log line says which happened, and
  the Slack message cannot, because it is sent before the write is
  attempted. A scoped tool never gets the tool-wide grant, whatever the
  answer: one yes to `git status` must not become a yes to every command,
  and one yes to a page must not become a yes to every page.

## Commands you installed for your agents

A tool you install on the host for your agents to use (`agentboard`, your
test runner, `gh`) shouldn't need an approval each time. List it once in
`~/.stratus/config.json`:

```jsonc
{
  "approvals": {
    "commands": ["agentboard", "gh pr"],                 // every agent
    "agents": { "nova": { "commands": ["pnpm test"] } }  // adds to the list above for nova
  }
}
```

Each entry is a command and, optionally, the subcommands it's limited to.
Whatever follows may vary: `agentboard` covers `agentboard task get 311`
and `agentboard list --column todo`, and `pnpm test` covers
`pnpm test --filter cli` but not `pnpm publish`. The same things stay
refused as for an **Always allow** scope: destructive flags like
`--force`, `-f`, and `--hard`, whatever the built-in list refuses for that
command (`git -c`), and git refspec deletes. Each command in a pipeline
still has to be covered on its own.

An entry keeps every limit the built-in list draws for the same command:
`git branch` still only lists branches, and `grep` still takes no file. A
bare `git` is refused, because it would cover the mutating forms of the
subcommands the built-in list limits. List the subcommands instead
(`git push`, `git fetch`). An entry that extends a limited built-in scope,
like `grep fix`, is refused too, since it would let a file follow the
pattern. The built-in scope already runs those commands unattended within
its limits.

Unlike the other keys here, an agent's list adds to the top-level one
rather than replacing it. An entry that isn't plain words (a flag, `|`, a
glob, a path in any word) is ignored, with a warning at startup, and is left out of
every listing of what's allowed. The daemon logs what
config allows when it starts, and `stratus grants <agent>` lists these
entries above the agent's grants. They aren't grants, so
`stratus grants revoke` can't take one back. Remove it from config and
restart. Revoking a remembered scope that config also lists removes the
grant and says the command still runs because of config. Like grants, they stop counting for a conversation that has read
external content when `externalContent` is `gate`.

Only a config you chose can set this, the same rule as the rest of
`approvals`. Listing a program means trusting what it runs: `pnpm test`
executes whatever the repository's test script says.

## Workspace autonomy

An agent working on code spends most of its calls reading: listing files,
searching them, opening one. Each of those is a shell command that asks,
because the engine can't tell `cat notes.md` in the agent's own workspace
from `cat ~/.stratus/credentials.json`. Turn on autonomy for an agent and
it can:

```jsonc
{
  "approvals": {
    "agents": { "nova": { "autonomy": "workspace" } }   // or "autonomy" at the top for every agent
  }
}
```

With `autonomy: "workspace"`, a command that only reads, and only reads
paths inside the agent's workspace (`~/.stratus/agents/<id>/workspace`, or
`<workspaceRoot>/<id>` when `tool-shell` has its own `workspaceRoot`),
runs without asking. That covers `cat`, `ls`, `head`, `tail`, `wc`, `grep`,
`rg`, and `find`, and each stage of a pipeline is judged on its own, so
`cat src/main.ts | wc -l` runs too. Each path is resolved through its
symlinks, so a link that points out of the workspace is outside. The
shell's working directory has to be inside the workspace as well, so an
agent with a configured `cwd` elsewhere gets nothing from this.

What still asks: a path outside the workspace, a glob or `~` or `$` (the
shell expands those into paths the engine never saw), and any flag that
would follow links out, run a program, or write a file (`grep -R`,
`rg --follow`, `rg --pre`, `find -exec`, `find -delete`, `tail -f`). An
unknown flag asks too. `rg` runs only with `--no-ignore` (or `-u`), because
otherwise it reads ignore files outside the workspace: above it, in your
home directory, and in a linked worktree's git directory.
`grep -rn` needs nothing extra. The shell never passes `RIPGREP_CONFIG_PATH` or
`GREP_OPTIONS` to a command, whatever its `env` or `passEnv` says, because
they add options the command line doesn't show. Nor are shell startup variables passed (`BASH_ENV`, `ENV`, `ZDOTDIR`,
exported `BASH_FUNC_*` functions), since they run code before the command,
and zsh, tcsh, csh, and fish are started without their user startup
files (`-f`, or `fish --no-config`) for the same reason.
Nor does `PATH` keep an
entry the agent can write to (its workspace or working directory, or a
relative entry like `.`), because a program there named `cat` or `git`
would run in place of the real one. Reads stay allowed after the conversation reads web
content, even with `externalContent: "gate"`, because reading the agent's
own files can't send anything anywhere.

Local git runs too, in a repository inside the workspace (the cwd, or
`-C <path>`): `add`, `commit`, `switch`, `checkout`, `restore`, `branch`,
`worktree add` (to a path inside the workspace) and `list`, `stash`,
`merge`, `rebase`, `cherry-pick`, `reset`, `fetch`, `pull`, `tag`, `mv`,
and `rm`, plus the read-only ones. Each subcommand has a list of the flags it may use, and anything else
asks: `--force`, `--hard`, `-D`, `--no-verify`, `stash drop`/`clear`,
options that read a file or run a program (`commit -F`, `tag -F`,
`rebase -x`, `--pathspec-from-file`), interactive forms (`add -p`,
`rebase -i`), and any flag nobody listed. So do any option before the
subcommand except `-C` and `--no-pager`, a `+` or `:` refspec on fetch or
pull, `push` except as below, and any subcommand not on the list
(`config`, `clean`, `filter-branch`). The repository git will actually use has to be inside too: a `.git` file
or link naming one elsewhere asks. Fetch and pull take a configured remote,
never a path. A commit or annotated tag needs its message on the command
line, and the shell sets `GIT_EDITOR` and `GIT_SEQUENCE_EDITOR` to `true`
for every command, since an editor can only hang without a terminal or run
whatever a repository's config names. Unlike reads, local git stops
running unattended once the conversation reads web content under
`externalContent: "gate"`. Commit, merge, and rebase run the repository's
hooks, which a repository only has if somebody put them there.

`git push <remote> <refspec>` runs too, for the agent's own branches: the
branch that lands on the remote (the refspec's destination, or the
checked-out branch for `HEAD`) must start with one of the agent's prefixes,
which are `<agentId>/` unless `branchPrefixes` says otherwise. A bare
`git push` or `git push origin` asks, because the repository's config, not
the command, decides where it goes. A name that is also a tag, or isn't a
local branch, asks too, and so does a repository whose config sets `push.followTags` or any
`push` mapping (in any spelling, including a worktree's `config.worktree`)
or includes another file, since that decides the destination instead.



```jsonc
"approvals": { "agents": { "nova": { "autonomy": "workspace", "branchPrefixes": ["nova/", "fix/"] } } }
```

The remote has to be configured in the repository, never a URL, a path,
or a directory that happens to share a remote's spelling. Force in any spelling, deletes, `--all`, `--mirror`, `--tags`, and
`--no-verify` still ask, and so does any other flag. Nothing pushed this
way lands without review, which is what makes it safe to run unattended.
Like local git, it stops once the external-content gate closes.

**What local git and push trust.** Turning these on trusts the agent's own
repositories, not only its command lines. Git runs programs named in a
repository's config and files: hooks, `diff.external` and textconv
drivers, clean and smudge filters (run by `git add` and checkout), `core.sshCommand`, `core.fsmonitor`, merge drivers, and objects
borrowed through `objects/info/alternates`. Git config in your home
directory (`~/.gitconfig`) applies too, including `push.followTags` and
`remote.*.push`. The checks above refuse the forms they can see on the
command line and in the repository's own config, but an agent that can
write its repository's `.git` (an `fs.write` grant covering the
workspace, for instance) can make any approved git command run anything.
Turn on autonomy for agents you trust with that. A sandboxed executor is
the boundary for agents you don't.

This is policy over command arguments, not a sandbox. It holds because
these commands read only what they're told to. A program you list in
`approvals.commands` can still read anything, which is why those are
listed by you and never inferred.

## Standing grants

Most installed tools are `gated` and name no scope — `fs.write`, a
bridged MCP tool — so **Always allow** on one grants the
**tool** to that agent: it runs without asking from then on, in every
session and after every restart, until an operator revokes it. That is the
only path such a tool has to running unattended at all: a `gated` call in
`headless` mode is otherwise refused, whatever was approved in the past.

`web.fetch` had a standing grant like this before it was judged by site.
A `web.fetch` entry under `tools` in a whitelist file can still show up in
`stratus grants`, but it no longer covers any call: the next fetch asks, and
**Always allow** on it grants that site. Revoke the old entry to tidy the
listing.

**Grants are the daemon's, and only the daemon's.** `stratus run` and
`stratus chat` do not consult them and cannot create one: at your own
terminal `--approvals ask` is a per-call y/N on the tool call itself, with
no **Always allow** to answer, exactly as it was before grants existed —
you are the gate there, so there is nothing to remember. The same has
always been true of [command scopes](./shell.md) and
[sites](./browser.md).

The grant is written to the same file as the agent's command scopes and
sites, under `tools`, with the package that contributed the tool, when it
was granted, and who answered — a Slack user id when a channel asked, or
`api` / `dashboard` with the caller's own label after a colon when the
decision came through the control API:

```jsonc
// ~/.stratus/agents/blair/whitelist.json
{
  "version": 1,
  "scopes": [{ "command": "git", "args": ["push"], "denyRefspecForms": true }],
  "origins": [{ "origin": "https://app.example.com", "tool": "browser.act" }],
  "tools": [
    { "tool": "fs.write", "package": "@stratusagent/tool-fs", "grantedAt": "2026-09-07T09:14:36.000Z", "grantedBy": "U01DYLAN" }
  ]
}
```

Three rules hold it in place, and they are the security argument rather
than scoping choices:

- **Per agent.** A grant Blair holds is not one Juno inherits — which is the
  whole reason the roster has separate identities.
- **Never for a tool judged by a scope, and never for `dangerous`.** A
  shell tool's risk lives in its argument, so a standing yes to `shell.run`
  would be a yes to every command; the engine resolves the command *first*,
  so the tool grant can never apply to it, and the same holds for a tool
  judged by site. A `dangerous` tool asks every time, whatever the answer.
  A `tools` row written by hand for either kind is ignored.
- **Scoped to the tool as it was when granted.** The grant records which
  package contributed the tool, and stops applying when that changes: a
  *different* package claiming a name you granted — one plugin swapped for
  another, an MCP server's tool taken over — asks again, and the listing
  marks the old grant stale. A kernel tool records no package and matches
  only a kernel tool.

  **What this does not catch is the same package upgraded in place.** The
  name is unchanged, so the grant survives the new version, and a tool that
  quietly does more after an update keeps running unattended. That is a
  deliberate limit rather than an oversight: pinning a grant to a version
  would revoke every grant on every routine upgrade, which teaches an
  operator to re-approve without reading — the opposite of what a standing
  grant is for. Tighter identity is worth arguing on its own terms, and
  until it exists the remedy is `stratus grants revoke` after an upgrade
  you have reason to distrust. Grant durable tools from packages you would
  also let update themselves.

### Seeing and revoking them

```bash
stratus grants blair                                # everything blair may do unattended, all three kinds
stratus grants revoke blair --tool fs.write           # a standing grant
stratus grants revoke blair --scope "git push"        # a command scope, by the line the listing shows
stratus grants revoke blair --origin https://app.example.com
```

With a daemon serving, both go through its control API (`GET
/agents/:id/grants` and `POST /agents/:id/grants/revoke` — see the
[control API README](../../packages/control-api/README.md)), and a revoke
takes effect on the very next call, with no restart. The daemon caches
each agent's file, so editing it behind a running daemon changes nothing
until that daemon restarts; the command falls back to the file, and says
so, only when the daemon `~/.stratus/gateway.json` names does not answer.
With no daemon at all, the file is edited directly.

A file-fallback revoke holds `~/.stratus/grants.lock` from the read it
decides on until its write lands, and a daemon reads each grant file under
the same lock. So a daemon starting during a revoke reads the file before
the revoke or after it, never halfway, and can't cache a grant the command
then reports as gone. The daemon's own grant writes (an "always" answer)
take the lock too, and apply to the file as it is rather than to what the
daemon cached, so one landing after a revoke doesn't bring the revoked
grant back, and one landing before it isn't lost. Nothing goes ahead
without the lock. A revoke that can't get it within 5 seconds revokes
nothing and says so; run it again. A daemon that can't treats that agent
as having no grants for that one call, so it asks rather than acting, and
an "always" answer it can't save holds only until the daemon restarts. One case is unchanged: a daemon
that is already running, and whose control API doesn't answer, keeps
whatever it read until it restarts. The command still writes the file
then, because refusing would leave no way to revoke at all, and the next
daemon to start reads the file.

A grant can outlive its agent: delete a soul and its `whitelist.json`
stays, and an agent created later under the same id inherits it.
`stratus grants <id>` shows it whether or not a soul exists, so revoke the
rows or remove the file when you retire an id. Grants do not expire on
their own.

### What the log records about a grant

A call that ran under a standing grant is logged as such — the tool, when
the grant was made and by whom, never the call's input — so a run that
happened unattended can be told apart from one that ran because the tool
was `safe`:

```text
09:14:36  —  blair: fs.write now runs without asking, until revoked (granted by U01DYLAN)
03:00:02  —  blair: fs.write ran under a standing grant (fs.write (@stratusagent/tool-fs), granted 2026-09-07T09:14:36.000Z by U01DYLAN) (session schedule:…)
```

## After an agent reads the web

A grant is your answer about calls the agent chooses. Once it has read a web
page, a search result, or an MCP server's reply, a call may be one the page
chose instead: text written by a stranger, telling the agent to send your
files somewhere or to fetch a URL with a secret in its query string. Nothing
can reliably tell those instructions apart from content, so the defence is
not to filter the text but to stop treating your old answers as covering
what comes after it.

Every tool that returns third-party text labels its result `external`
(see [Security](../concepts/security.md#what-an-agent-can-reach)), and the
conversation keeps the lowest label it has seen. `externalContent` decides
what that label does to the agent's grants:

```jsonc
// ~/.stratus/config.json
{
  "approvals": {
    "externalContent": "gate",                     // every agent…
    "agents": { "coder": { "externalContent": "label" } }  // …except this one
  }
}
```

- **`label`** (the default) records it, and changes nothing else.
- **`gate`** withdraws the agent's grants from that conversation from then
  on. Standing grants, command scopes you approved, sites, and "always this
  session" stop counting; every gated call asks a person, or under
  `headless` is refused, with a log line naming what the conversation read:

  ```text
  09:14:36  —  warning: scout: fs.write was called after this conversation read external content (from web.fetch); with approvals.externalContent set to "gate" no grant covers it, and nobody is available to approve it (session …)
  ```

  An approval given in a gated conversation is **one-shot**: there is no
  **Always allow**, because the request in front of you was composed after
  the page had its say, and a grant made there is exactly the standing
  authority the gate withdrew.

What still runs unattended under `gate` is what never rested on a grant:
`safe` tools, the built-in read-only commands (`git status`, `git log`, …),
and a schedule's pre-authorized destination — a schedule that reads the web
and reports to the channel you approved it for is the job it was approved
to do, and the page can only change the words it sends there.

Three limits to know before relying on it:

- **It is per conversation, not per call.** The first `web.fetch` closes the
  gate for the rest of that session, including the next `web.fetch`. An
  agent whose job is reading many pages unattended needs those reads to be
  `safe`, which `toolRisks` on the plugin sets for every agent that holds
  the tool (see [Tools](./tools.md)). That says a fetch to any public
  address is acceptable unattended — a URL can carry whatever the agent
  read — so make it only for souls that hold nothing that can write or
  send.
- **Only `external` content trips it.** A shell's output is `unknown`, not
  `external`, so a coding agent keeps its grants after `ls`. A message from
  a Slack sender you have not named as a principal is `unknown` too; refuse
  those before the turn starts with `principals.admit: "principals"`
  ([Slack](../../packages/channel-slack/README.md#who-counts-as-the-operator)).
- **It gates what an agent does, not what it believes.** A page can still
  mislead an answer. What the gate removes is the page's ability to act
  through your grants without a person seeing the call.

## What the request shows, and how it ends

The request shows the tool's **arguments**, not just its name — for
anything whose danger lives in what it was called with, approving a bare
tool name is approving something you cannot see. Arguments are escaped (a
model-written argument cannot mention or broadcast to the workspace through
the prompt) and truncated with a visible notice when they are long.

For `browser.act` it also shows the **site**, beside the tool name. The
arguments there are a CSS selector, which says nothing about where a click
lands — and the site is the thing **Always allow** widens, so an approver
who was not shown it would be granting something they cannot see. The site
is checked again when the answer comes back: a page that redirected while
the request was outstanding refuses rather than acting on a yes given for
somewhere else.

Requests are also denied — visibly, with a reason — when they expire, when
the turn is cancelled, when the daemon shuts down, and when a turn reaches
a gated call while the daemon is already stopping. Every one of those
retracts the buttons in Slack, so a message never keeps offering a decision
with nowhere to land.

`timeoutMs` is capped at 2147483647 (~24.8 days), the longest timer Node
can hold. A larger value is rejected at startup rather than accepted: it
would not wait longer, it would expire every approval almost immediately.

Approval buttons need the Slack app's **Interactivity** switched on. Apps
created from the manifest that `stratus setup` prints already have it; an
app created before this shipped needs it enabled once, in its App Manifest.
