# Skills

Tools are capability; a **skill** is competence — markdown that teaches an
agent a procedure: the rubric for a code review, the order to check things
in, the format to answer in. A skill is a directory with a `SKILL.md`:

```text
~/.stratus/skills/
  code-review/
    SKILL.md
```

```markdown
---
name: Code Review
description: Use when reviewing a diff or a pull request.
---

# Code review

Lead with the verdict, then findings ordered by severity...
```

The frontmatter is the soul dialect — `name`, `description`, optional
`version`, and an optional `requires:` list of toolsets the procedure
expects (`browser.*`) — read **tolerantly**, unlike a soul's: keys other
ecosystems write (`license`, `allowed-tools`, nested `metadata:`) and YAML's
multi-line descriptions are skipped rather than refused, so a skill
published for another agent loads here unmodified. The directory name is the
skill's id. Plugins can ship skills too, declared in their manifest; those
are addressed by the package name verbatim
(`stratus-plugin-github:pr-review`), and by the bare id while no other
package claims it.

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
already installed is refused per skill (`--force` replaces it), and an
unparseable skill is reported while the rest still install.

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

A skill whose `requires:` names toolsets the agent's `tools:` does not cover
is a warning when the daemon loads the roster, never a refusal — a skill is
prose, and can degrade. `stratus run` and `stratus chat` serve the same
skills directory the daemon does, so a skill that routes locally routes in
Slack.
