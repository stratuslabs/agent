# Skills

Tools are capability; a **skill** is competence — markdown that teaches an
agent a procedure: the rubric for a code review, the order to check things
in, the format to answer in. A skill is a directory with a `SKILL.md`, in
the [Agent Skills](https://agentskills.io) format — the open standard a few
dozen agents read, so a skill published for any of them is a candidate for
yours, and one you write here works there:

```text
~/.stratus/skills/
  code-review/
    SKILL.md
```

```markdown
---
name: code-review
description: Use when reviewing a diff or a pull request.
---

# Code review

Lead with the verdict, then findings ordered by severity...
```

`name` is the skill's id and, as the spec requires, equals its directory
name. `description` is what routing runs on. The other fields the spec
defines, the two Stratus extensions (`metadata.requires` and
`metadata.version`), and the exact list of where Stratus and the spec
differ are in the [skill format reference](../reference/skill-format.md).
Plugins can ship skills too, declared in their manifest; those are
addressed by the package name verbatim (`stratus-plugin-github:pr-review`),
and by the bare id while no other package claims it.

## Installing skills

Anything on GitHub laid out as skill directories — including repos published
to [skills.sh](https://skills.sh) — installs directly:

```bash
stratus skill add owner/skills-repo          # a whole repo of skills
stratus skill add owner/repo --skill hn-search --agent ava
stratus skill add ./my-skills                # a local directory
stratus skills                               # what is installed, and who enables it
```

`skill add` takes a GitHub `owner/repo`, any git URL, or a local path; it
finds skills at the repo root, one level down, and in the `skills/`,
`.claude/skills/`, and `.agents/skills/` directories the ecosystem uses,
then copies each **whole directory** into `~/.stratus/skills/`. An id
already installed is refused per skill (`--force` replaces it).

**Nothing installs that does not conform.** Every skill is validated
against the spec before it is copied — the same checks the reference
`skills-ref validate` runs — and one that fails is refused, naming what is
wrong, while the rest of the repo still installs:

```text
Warning: skipped pdf: name "pdf-processing" does not match the directory name "pdf". The spec requires the two to agree — rename one.
```

What the spec constrains is refused: no `name`, a `name` that is not an id
or not the directory's, a `description` or `compatibility` past its
ceiling. What the spec is silent on is installed with a warning next to
the install line, so the person deciding whether to enable it hears it:
frontmatter fields another host owns (Claude Code's `argument-hint`, say),
the pre-spec Stratus key form, and a bundled `scripts/` directory. A skill's
`compatibility` line, when it has one, is printed too — it is written for
exactly this moment.

The same check runs without installing, for an author about to publish or
an operator asking why something was refused. It takes a skill directory,
a directory of skills, or the id of an installed skill, and exits 1 if
anything would be refused:

```bash
stratus skill validate ./my-skill
stratus skill validate code-review
```

## Installing while the daemon runs

A skill takes effect **without a restart**, and without dropping a single
channel connection. Once the copy is done, `stratus skill add` tells the
running daemon to re-read `~/.stratus/skills/` — the daemon it finds through
`~/.stratus/gateway.json`; `--no-reload` skips this, and a machine with no
daemon running sees nothing about one — and an allowlisted agent reads the
new skill on its next turn. For a skill you edited or removed by hand:

```bash
stratus skill reload         # or: POST /skills/reload on the control API
```

Two rules keep a reload honest:

- **A reload swaps the whole set or nothing.** A skill that will not load —
  a `SKILL.md` with no description, a directory whose name is not an id —
  fails the reload with the file named, and the daemon keeps serving the
  set it had. Half a catalog is worse than a stale one; fix the file and
  reload again. (At start there is no previous set to keep, so a broken
  skill is a warning there and the rest still load.)
- **Loaded is not enabled.** A reloaded skill reaches only the agents whose
  souls list it, exactly as at start. A removed skill stops being loadable,
  and an agent whose soul still lists it fails a read the way it would for
  any missing skill.

A reload produces what a restart would: an operator skill still outranks a
plugin's bare alias for the same id, and a bare id two plugins both want
stays contested. Reloading with nothing changed is a no-op, and a reload
during a turn that is reading a skill does not fail that turn.

Plugins are the other half. A plugin is code, and code gets a restart — an
announced one, `stratus restart`. See
[what needs a restart, and what does not](./always-on.md#what-needs-a-restart-and-what-does-not).

## Enabling skills

**Installed is not enabled.** A skill is markdown, but it is markdown your
agent will *follow*, so installing a repo grants no agent anything — each
soul still opts in through `skills:`. Pass `--agent <id>` to do both at
once: the command appends the installed ids to that soul's list (rendering
the file through the canonical formatter, like the API's field edits do).

An agent gets a skill only when its soul asks — same allowlist shape as
`tools:`, except that omitting it means **none** (a skill silently changing
how an agent behaves is worse than an agent that has to be told):

```markdown
---
name: Ava
tools: [fs.read, fs.search]
skills:
  - code-review
  - stratus-plugin-github:*
---
```

Treat a skill from outside the way you would treat a plugin: **untrusted
until you have read it.** The risk is not that it executes — it is prose —
but that it instructs, and an agent with real tools will do what it says.
Enabling one is the same kind of decision as enabling a plugin, and the
artifact being markdown does not make it smaller.

## How an agent uses a skill

**An enabled skill costs one line per turn, not its body.** Only the name
and description reach the system prompt; the agent loads the full procedure
with the built-in `skill.read` tool when the description says it is
relevant. That is what lets a fleet carry thirty procedures without every
turn paying for all thirty. `skill.read` is part of the skills mechanism —
never list it under `tools:`; it appears (and works) for exactly the agents
whose soul enables any skill, and reads only the skills that soul allows.

**Write the description for routing.** It is the only thing the model sees
before deciding to load the body, so it says *when to reach for this*, not
what the file contains: "Use when reviewing a diff or a pull request", not
"A rubric with twelve sections". A skill without a description does not
load.

A skill whose `metadata.requires` names toolsets the agent's `tools:` does
not cover is a warning when the daemon loads the roster, never a refusal —
a skill is prose, and can degrade. `stratus run` and `stratus chat` serve
the same skills directory the daemon does, so a skill that routes locally
routes in Slack.

## What portability means

A skill is prose, and prose ports: the `SKILL.md`, and the `references/`
and `assets/` it bundles, mean the same thing on every agent that reads
the standard. Three things do not port, and are worth knowing before you
wonder why nothing happens:

- **Tool names.** A procedure that says "run `fs.read`" was written for
  this install's toolsets; one that says "use the Read tool" was written
  for someone else's. A skill referencing a tool this install lacks still
  installs, and the failure when the agent reaches for it is the ordinary
  allowlist refusal — nothing maps one agent's tool names onto another's.
- **`allowed-tools`.** The spec's pre-approval list is read and ignored.
  Here a tool is granted by a trusted config and a soul's `tools:`, and a
  file that arrived in a `git clone` is neither.
- **`scripts/`.** The spec lets a skill bundle executable code. Stratus
  installs those files as files and never registers or runs them: prose
  imports, executables do not. An agent can run one only through its own
  `shell.run` gate, approved like any other command, and a skill whose
  procedure depends on a script needs that tool and that approval to work
  here. Something that needs to *act* is a plugin contributing a tool.
