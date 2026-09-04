# Approvals

At a terminal, `stratus chat` and `stratus run` ask you directly:
`--approvals` is `always`, `ask` (interactive y/N prompt), or `never`. This
page is about the daemon, where there is no terminal to prompt on.

## What the daemon will do on its own

Tools declare how much damage they could do — `safe`, `gated`, or
`dangerous` — and the daemon runs only the safe ones without asking.
Anything riskier is refused, with a line in the log saying which agent
wanted what:

```text
09:14:36  —           warning: ava: shell.run is gated and nobody is available to approve it (session slack:ava:…)
```

That is the honest default (`headless`) behind a service manager. If
somebody *is* reachable, `--approvals remote` asks them instead — see
below.

A tool that declares no risk counts as `gated`, never `safe` — forgetting
to classify something should cost a prompt, not an unattended command. Most
built-in tools (`demo.echo`, `memory.remember`, `memory.recall`,
`memory.forget`, `agent.delegate`, `schedule.list`, `schedule.cancel`) are
`safe`; the built-in exceptions are `schedule.every`, `schedule.at`, and
`message.send`, which are `gated` because they act past the end of the
turn — see [Schedules](./schedules.md). Anything you install is where this
starts to bite, which is what [Tools](./tools.md) is about.

Two tools are the exception to the whole paragraph, because their risk is
in what a particular call does rather than in the tool's identity. Both are
`gated`, and the permission engine then judges each call:

- **A shell**, by the command it would run — see [Shell commands](./shell.md).
- **`browser.act`**, by the site the conversation is on — see
  [Browser actions](./browser.md).

Nothing built in is `dangerous` any more. The tier is still there, and an
operator's `toolRisks` or a plugin's manifest can still put a tool in it —
it is the only way to say "never unattended, whatever scopes exist" about
somebody else's code — but no first-party tool declares it. `browser.act`
was its one member, and it was there because no scope model existed for a
click rather than because a click is worse than a shell command.

A `dangerous` call asks **every time**, and **Always allow** on one does not
change that: the call runs, and nothing is remembered. Two other calls
behave the same way — a browser action with no page to grant, and a shell
command the parser cannot reduce to a scope — and all three are called
**one-shot**: they are not offered **Always allow** at all, on any surface.
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
      "ava": { "slackApprovers": ["U01DYLAN"] }
    }
  }
}
```

An agent inherits the top-level route key by key, so `ava` above asks her
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
  approvals: remote — gated calls are parked and asked in Slack (approvers set for ava)
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
- **Always allow means different things, and which one you get depends on
  the tool.** For an ordinary tool it lasts for the session: it stops that
  tool asking again in the same conversation, and it is forgotten when the
  daemon restarts. For a call judged by a *scope* it persists that scope
  instead, in `~/.stratus/agents/<id>.whitelist.json`, and a saved one
  survives a restart — a command scope for `shell.run` (see
  [Shell commands](./shell.md)), an origin for `browser.act` (see
  [Browser actions](./browser.md)). When that file exists and no longer
  parses it is never written over, so the answer holds only until the
  daemon stops; the log line says which happened, and the Slack message
  cannot, because it is sent before the write is attempted. A scoped tool never gets the tool-wide
  grant, whatever the answer: one yes to `git status` must not become a yes
  to every command, and one yes to a page must not become a yes to every
  page.

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
