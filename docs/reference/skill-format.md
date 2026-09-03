# Skill format

The `SKILL.md` Stratus reads is the [Agent Skills](https://agentskills.io)
format, field by field, plus two host extensions where the spec leaves room
for them. This page is the exact list — what the spec requires, what
Stratus adds, what it ignores, and where the two differ on purpose. The
[skills guide](../guides/skills.md) says how to install and enable one.

## Layout

```text
<name>/
  SKILL.md        # required: frontmatter + the procedure
  references/     # optional: documents the procedure points at
  assets/         # optional: templates and resources
  scripts/        # optional in the spec; installed as files, never run
```

The directory name is the skill's id — what a soul's `skills:` names and
what `~/.stratus/skills/` is keyed by — and the spec requires `name` to
equal it.

## Frontmatter

| Field | Spec | Here |
| --- | --- | --- |
| `name` | Required. Lowercase letters, digits, and hyphens in hyphen-separated runs; at most 64 characters; no leading, trailing, or doubled hyphen; equal to the directory name | The id. Required at install, exactly as the spec says. At load, an installed skill without one falls back to its directory name — see [Where Stratus differs](#where-stratus-differs) |
| `description` | Required, at most 1024 characters | What routing runs on: the one line the model sees before deciding to load the body. Say *when* to reach for the skill |
| `license` | Optional. A license name, or a bundled file | Read, kept, not acted on |
| `compatibility` | Optional, at most 500 characters. What the skill needs from its environment | Printed by `stratus skill add` under the install line — it is written for that reader |
| `metadata` | Optional. A map of string keys to string values, for host-specific properties | Where the Stratus extensions live (below). Other keys are kept and ignored |
| `allowed-tools` | Optional, experimental. Space-separated tools the skill is pre-approved to use | **Ignored.** A tool is granted by a trusted config and a soul's `tools:`; a file that arrived in a `git clone` grants nothing |

Anything else at the top level belongs to some other host. It is skipped —
with its nested block, so Claude Code's `hooks:` or a `metadata:`-shaped
block under another name does no harm — and `stratus skill add` and
`stratus skill validate` name it in a warning.

The frontmatter dialect is a subset of YAML, read without a YAML library:
`key: value` scalars (quoted or bare), block lists and `[a, b]`, the block
scalar forms for a multi-line `description` (`>-`, `|`, and their
indicator variants), and one level of `key: value` pairs under
`metadata:`. Anchors, flow maps, and nested maps under `metadata:` are
not read; a nested block under `metadata:` is refused rather than
half-read, since the spec says every value there is a string.

## Stratus extensions

Both live under `metadata:`, which is the spec's home for host properties,
so a skill carrying them still passes `skills-ref validate` and every other
reader that honors the spec:

```markdown
---
name: web-research
description: Use when a question needs sources from the live web.
metadata:
  version: "1.2.0"
  requires: web.* browser.goto
---
```

- **`metadata.requires`** — the toolsets or tools the procedure expects,
  space-separated, in this install's vocabulary (`browser.*`, `fs.read`).
  Advisory: an agent that enables the skill without those tools gets a
  warning when the roster loads, never a refusal. A skill is prose and can
  degrade.
- **`metadata.version`** — informational; nothing keys on it.

The pre-spec Stratus form wrote both at the top level (`version: 1.2.0`,
`requires:` as a list). That form **still loads**, so what is already in
`~/.stratus/skills/` keeps working, and `metadata` wins when both are
written — but the reference validator refuses top-level keys it does not
know, so a skill meant to travel should use the `metadata:` form.
`stratus skill validate` says so when it sees the old one.

## Validation

`stratus skill add` validates every skill before copying it, and `stratus
skill validate <path | id>` runs the same check without installing. One
implementation, so what validates installs and what installs loads.

**Refused** (an error, and the skill does not install):

- no `name`; a `name` that breaks the rule above; a `name` that is not the
  directory name (checked for a skill inside a repository; a repository
  whose root *is* the skill installs under its `name`, since its checkout
  directory is circumstance rather than identity)
- no `description`, or one past 1024 characters
- `compatibility` past 500 characters
- frontmatter that does not parse: a nested block under `metadata:`, a
  list item outside a list, an unclosed `---`

**Warned** (installed, and said next to the install line):

- top-level keys outside the spec — another host's, and ignored here
- the pre-spec Stratus keys, with the `metadata:` form to move to
- a bundled `scripts/`, with a count — installed as files, never run

The spec's advice to keep `SKILL.md` under 500 lines and reference the rest
is advice; nothing here measures it.

## Where Stratus differs

Conformance is a floor. Where the spec speaks, Stratus follows it; where it
is silent and the fleet needs an answer, the answer stays. Each of these
is a decision with a reason, not an accident:

1. **Unknown top-level keys warn instead of refusing.** The reference
   validator refuses any key it does not define. The published corpus
   carries other hosts' keys routinely, and refusing a skill over a field
   that changes nothing here would fail the point of conforming — which is
   that a skill from the ecosystem installs without editing. Strict where
   it matters, loud where it does not.
2. **Loading is judged by the rule the content was written under.**
   Install requires `name` and the spec's id rule; loading what is already
   in `~/.stratus/skills/` — content that predates the spec — does not. A
   skill without a `name` falls back to its directory name, and a
   directory (or a plugin's declared id) that the earlier, looser rule
   accepted — `old--id`, `trailing-`, one past 64 characters — is still
   served, with a warning at load, rather than an upgrade silently taking
   an enabled procedure away from an agent. A fresh install of either is
   refused, and `stratus skill validate <id>` says what to add or rename.
3. **A root-of-repository skill is not checked against its directory
   name.** Git puts a clone wherever it puts it; the skill's `name` is its
   identity and is what it installs under.
4. **Qualified ids.** A plugin's skill is `<package>:<skill>`, and a soul
   selects a package's skills with `<package>:*`. The spec has no notion of
   packages, so it has no opinion; the qualified form answers a question it
   does not ask. Details in [plugins.md](../architecture/plugins.md#naming).
5. **Precedence across sources.** An operator's bare id outranks a
   plugin's bare alias, and a bare id two plugins both want goes to neither.
   Same reason, same page.
6. **`allowed-tools` grants nothing.** Both gates hold: installing a skill
   enables nothing, and an agent loads it only if its soul lists it. The
   spec's list is read so it is not reported as unknown, and then unused.
7. **`scripts/` never runs.** The spec admits executable code beside the
   prose. Here nothing registers or runs it; an agent can run one only
   through its own `shell.run` gate, like any other command. Code arrives
   as a plugin, through the two gates.
8. **A YAML subset.** The dialect above is what is read, and the rest of
   YAML is not — deliberately, so `@stratusagent/agents` carries no
   dependency for a file that is four fields long.
