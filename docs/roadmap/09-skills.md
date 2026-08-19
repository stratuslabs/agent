# 09 — Skills: procedures an agent loads when it needs them

## Goal

Markdown files that teach an agent *how* to do something, enabled per agent in
its soul, and loaded into context only when relevant — so a fleet can carry
thirty procedures without every turn paying for all thirty.

## Why now

[06](./06-tool-packs.md) gives agents capability; capability is not competence.
An agent with `fs.read` and `shell.run` can review a diff, and will review it
differently every time. The rubric, the order to check things in, the format
to answer in — that is a skill, and there is nowhere to put one today.

Two skills already exist as repositories from the Swift iteration —
`stratuslabs/skill-code-review` and `stratuslabs/skill-web-research` — written
against a loader that concatenated every enabled `SKILL.md` into the system
prompt. That is the thing not to rebuild: `skill-code-review` alone is several
thousand words, and paying for it on a turn that says "thanks" is how a fleet
gets expensive quietly. See [`plugins.md`](../architecture/plugins.md) for how
skills relate to tools and to the packages that ship them.

## Scope

**In:**

- **The format.** A skill is a directory with `SKILL.md` — YAML-ish frontmatter
  (`name`, `description`, optional `version`) and a markdown body — plus
  whatever `examples/` and `templates/` it wants. The existing frontmatter
  parser in `packages/agents` handles this dialect already; extend it rather
  than adding a YAML dependency.
- **`SkillRegistry` in the kernel** (`packages/core`), alongside `ToolRegistry`
  and shaped like it. A `Skill` is `{ id, name, description, body }` where
  `body` is loaded lazily.
- **Progressive disclosure.** Only `name` and `description` reach the system
  prompt, one line each. The body arrives through a kernel-registered
  `skill.read` tool, `risk: 'safe'` — reading a file the operator installed and
  the soul opted into is not an act on the world. This is the whole point of
  the step: the marginal cost of an enabled-but-unused skill is one line.
- **`skills:` in soul frontmatter**, added to `SOUL_LIST_KEYS`, and
  `AgentDefinition.skills?: string[]` — the same allowlist shape as `tools:`,
  including glob (`github:*`). Omitted means none, matching `credentials:`
  rather than `tools:`: a skill silently changing how an agent behaves is worse
  than an agent that has to be told.
- **`~/.stratus/skills/`** for operator-installed skills, and skills contributed
  by plugins via the manifest's `contributes.skills`.
- Descriptions are what routing runs on, so the step owns the guidance for
  writing one: a description says *when to reach for this*, not what it
  contains.

**Out:** automatic skill selection by embedding similarity (the model choosing
from descriptions is the mechanism); skills that carry executable code (that is
a plugin contributing a tool); distribution and discovery ([12](./12-plugin-registry.md)).

## Design sketch

- Loading is lazy and cached per skill id, not per read. A body read three times
  in one turn hits the disk once.
- The prompt block is rendered by the shared persona/memory renderer, not by
  each provider package — that duplication is already flagged for cleanup in
  [`stratus-v2.md`](../architecture/stratus-v2.md).
- `skill.read` takes an id and returns the body. An id the agent is not allowed
  is refused by the same allowlist machinery tools use, so there is one gate,
  not a second implementation of one.
- A skill id collision between two plugins resolves to the qualified
  `<plugin>:<skill>` form; a collision between two unqualified ids in
  `~/.stratus/skills/` is a load-time error.

## Acceptance criteria

- An agent with 20 skills enabled sends 20 lines, not 20 bodies: assert the
  rendered system prompt's length against the sum of description lengths, and
  watch it fail if a body leaks in.
- `skill.read` on an id outside the soul's `skills:` list is refused, and the
  refusal is the allowlist's, not a second copy of it.
- A soul with no `skills:` key gets no skills — not every installed one.
- `stratuslabs/skill-code-review` and `stratuslabs/skill-web-research` load
  unmodified except for frontmatter.
- A plugin contributing a skill and a plugin contributing a tool with the same
  namespace can be installed together, and the skill is reachable qualified.

## Open questions

- Does `skill.read` return the whole body, or sections addressable by heading?
  Whole body first — sectioning is a second progressive-disclosure layer, and
  the first one has to prove insufficient before it earns the complexity.
- Should a skill be able to *require* a toolset (`requires: [browser.*]`) and
  warn when an agent enables it without those tools? Leaning yes, as a warning
  at load, never a hard failure — a skill is prose and can degrade.
