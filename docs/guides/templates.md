# Agent templates

`stratus agent new` on its own gives you an identity: a name, an avatar, a
persona, and no capability. A **template** gives you a teammate — the same
soul, plus the tool allowlist it needs and the plugin configuration behind
that allowlist, shown to you as one bundle before any of it is written.

```bash
stratus agent templates                  # what ships, and what each needs installed
stratus agent new --template triage      # review it, then create
```

## The two gates are still there

Nothing about a template makes capability arrive on its own. Installing a
plugin still runs nothing; a config you chose still has to enable it; and
the soul still has to allowlist each tool by name. Those are the two gates
[Plugins](../concepts/plugins.md) describes, and a template does not touch
either.

What it changes is *how they are answered*. Today you answer them by hand,
one at a time, out of separate documents, before anything works at all. A
template answers both as a proposal you review once and accept — or
decline, which writes nothing.

## What the review shows

The confirmation is the point of the command, so read it. It is not the
template's wish list; it is what will be true on **this machine**
afterwards.

```
On-call triage — Watches logs and status pages, and says what changed and whether it matters.

Creates Kit (id kit)
  soul    ~/.stratus/agents/kit.md
  config  ~/.stratus/config.json

Tools this agent may call:
  fs.read             safe      @stratusagent/tool-fs
  fs.list             safe      @stratusagent/tool-fs
  fs.search           safe      @stratusagent/tool-fs
  web.fetch           gated     @stratusagent/tool-web
  memory.remember     safe      the kernel
  ...
                      gated: asks a human every time, until you grant it a scope.

Plugin configuration:
  @stratusagent/tool-fs 0.11.2 — added, for reading logs (fs.read, fs.list, fs.search)
      { "enabled": true, "agents": { "kit": { "roots": ["~/.stratus/workspaces/kit"] } } }
  @stratusagent/tool-web 0.11.2 — already configured the way this needs it; kept exactly as it is
```

Four things in there are worth knowing about.

**The risk beside each tool is the one that will be enforced**, read off the
resolved plugin manifests — never off anything the template says about
itself. A third-party package whose manifest calls its own `shell.run`
`safe` shows here as `gated`, because [the floor](../concepts/plugins.md)
decides and this only reports what it decided. Your own `toolRisks`
override, if you have set one, is what shows.

**Tools are named literally, never as `fs.*`.** A glob authorizes every tool
in a namespace *including ones a later plugin update adds*, which would keep
widening a grant after you approved it. If a soul you wrote by hand carries
a wildcard, this flow will show it as a wildcard and say so, rather than
printing the narrower list it happens to reach today.

**The plugin lines are a diff, not a request.** `added` writes a new block.
`already configured the way this needs it` writes nothing at all — not even
to touch the file's mtime. `already configured; these keys are added` names
exactly the keys. And a setting the template contradicts is a **conflict**:
the command stops, prints both values, and changes nothing, because
silently keeping either one would make the summary you just read a lie.
That covers the per-agent block too — if you configured `agents.<id>` before
the agent existed, or an entry outlived a soul you deleted, the template
reports the contradiction rather than replacing what you chose.

**Filesystem roots are per agent.** A template that needs `fs.read` writes
its roots under `agents.<id>` — the agent's own workspace — rather than
widening the fleet-wide `roots`, which would hand every existing agent a
directory nobody reviewed on their behalf. Widen it by hand in
`~/.stratus/config.json` once you know what you want read; see
[Tools](./tools.md).

## What ships

| Template | What it is | Needs installed |
| --- | --- | --- |
| `research` | Reads the web and your notes, and hands back what is actually known. | `@stratusagent/tool-web`, `@stratusagent/tool-fs` |
| `triage` | Watches logs and status pages, and says what changed and whether it matters. Also allowlists `schedule.every` and `message.send`, both `gated` — see below. | `@stratusagent/tool-fs`, `@stratusagent/tool-web` |
| `operator` | Runs the commands you have approved, and shows you the output. | `@stratusagent/tool-shell`, `@stratusagent/tool-fs` |
| `assistant` | Keeps track of your people, projects, and decisions across every conversation. | nothing — memory is kernel capability |

First-party only, shipped inside the CLI. There is no way to install a
template from somewhere else, and that is deliberate: a bundle you review is
a very different thing from a bundle you downloaded.

A template that names a plugin you have not installed **creates nothing**
and prints the install command. Install it, then run the same command
again.

## Templates never carry a credential

A template is a file that gets copied around and read out of a repository,
so it names the credentials its tools need and never holds one. A named
credential that is missing is reported and does not stop the creation — the
agent's other tools work, and the flow prints the command that provides it:

```bash
printf %s "$KEY" | stratus credential set search.apiKey --agent kit
```

## A template never creates a schedule

Some agents are only useful on a cadence, and `triage` is one. It ends its
flow by *proposing* a schedule rather than writing one:

```
This agent is most useful on a schedule, which this does NOT create.
  Ask them, once they are running: "schedule yourself every 1h: Check the services you watch. …"
  They will ask you to approve it — that is the second reviewed step.
```

A schedule's cadence, prompt, and destination are a decision, which is why
`schedule.every` is `gated` in the first place. A bundle that quietly
inserted schedule rows would put unattended recurring work behind something
nobody read as such.

The `triage` soul **does** allowlist `schedule.every` and `message.send`,
and both show in the review as `gated`. That is not the template creating a
schedule — it is what makes the proposal reachable at all. An allowlist is
checked before the approval policy, so a soul without `schedule.every` would
refuse the call outright and the approval prompt this flow promises could
never appear. Gated means you are still the one who says yes, once, to a
specific cadence and destination; a firing's `message.send` then runs
unattended only to the destination approved with that schedule. See
[Schedules](./schedules.md).

## After it lands

The soul is an ordinary soul file — edit it, rename the agent, narrow its
tools, all the usual ways. A template creates; changing an agent afterwards
is the file.

If the creation wrote plugin entries, the running daemon does not have them
yet:

```bash
stratus restart          # announced, drained, back with sessions intact
```

Skills reload live; plugins need this. See
[Always on](./always-on.md#stratus-restart-announced-drained-and-back).

## Scripting it

`--yes` skips the confirmation. It is not the documented path — the review
is what makes a template acceptable — but the same bundle is applied either
way, and stdout is byte-identical between the two, because the question
itself goes to stderr.

```bash
stratus agent new --template research --name Vera --yes
```

## Things that stop the command

Each of these changes nothing at all — no soul file, no config entry:

- A plugin the template needs that is not installed.
- A plugin setting the template contradicts.
- A project-local `stratus.config.json` as the active config, **for a
  template that needs plugins**. Plugin entries are read only from a config
  you chose, so there is nowhere to write them; pass `--config`, or move
  those settings to `~/.stratus/config.json`. A template with no plugins —
  `assistant` — writes only a soul and is unaffected: it runs no config
  transaction at all, so it takes no lock and leaves nothing beside your
  config.
- A plugin block this host would refuse to load — a `toolRisks` value that is
  not a risk word, or a setting its manifest's schema rejects. The daemon
  refuses such a plugin whole, so the tools in the review would not exist
  after a restart; the command says so instead of creating an agent that
  stops working at the next one.
- A tool name a plugin you already enable contributes. A tool name is unique
  per install, so the daemon refuses whichever plugin loads second — the
  soul would end up calling a different implementation than the one you
  reviewed, or none. The plan reads every enabled plugin's manifest, not
  just the ones the template names, so it can say this before you commit.
  Two plugins of your own colliding with each other does **not** stop the
  command: the daemon already refuses one of them, and that is neither
  something this creates nor something it can fix.
- A workspace directory that cannot be created. The per-agent roots point at
  it, and a root that will never exist is a soul whose first `fs.list`
  fails.
- Declining the review.

The bundle is also re-resolved against the config at the moment it commits,
not just the moment you read it. If something changed in between — another
command enabled a plugin that takes one of these tool names, or moved a
tool's risk — the command writes nothing and tells you to look again. What
you approved and what would land have to be the same thing.

If the id the template wanted is already taken — two `--template triage`
runs both want `kit` — the second agent gets a suffixed id and a palette of
its own, and the command tells you which id it actually took.
