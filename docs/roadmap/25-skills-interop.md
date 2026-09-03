# 25 — Skills interop: conform to the standard, consume the ecosystem

## Goal

A skill written for the Agent Skills standard works in Stratus, and a skill
written here works everywhere else that reads the standard. Installing one from
the existing ecosystem is a command, not a copy-paste.

## Why now

`SKILL.md` is an **open standard with a published spec**, and by early 2026 it
was read by something like thirty tools from competing vendors — coding agents,
IDE assistants, and CLIs that share nothing else. A package manager over it
already exists, third-party and MIT, with a large public index and one-command
install across those agents.

Two consequences, and the second is the one that changes a decision:

**Conformance is nearly free and the leverage is large.** [09](./09-skills.md)
already chose `SKILL.md` with frontmatter, so the gap — if there is one — is
small. Closing it means every skill anyone writes for the standard is a
candidate for a Stratus agent, and every skill written here is portable out.
For a project whose skills story is "an agent learns a procedure," starting
from a corpus rather than from zero is worth more than anything we could write.

**It splits [12](./12-plugin-registry.md).** 12 is deferred because building
discovery for an ecosystem that does not exist is a platform for nobody. That
reasoning holds for *plugins* and is simply false for *skills*: the ecosystem
exists, somebody else built the distribution, and consuming it requires
building no registry at all. Skills distribution is available now; plugin
distribution stays deferred.

## Scope

**In:**

- **A conformance pass against the published spec**, and a written list of any
  place we differ — `~/.stratus/skills/<id>/SKILL.md` and the frontmatter keys
  against what the spec requires and permits.
- **Fix what does not conform**, or record deliberately why not. A difference
  that survives should be a decision with a reason, not an accident.
- **Install from the ecosystem** — a skill from a git repository or the
  existing index lands in `~/.stratus/skills/` under its id.
  `stratus skill add` already does this, accepting a GitHub repo, a git URL,
  or a local path — so this step is about conformance and validation on that
  shipped path rather than a new command.
- **Strict validation at install, and a refusal that names the problem.**
  Nothing installs that does not conform. This matches how the plugin manifest
  is already treated — validated before the module is imported — and it buys
  the property that matters: a skill that installed actually loads.
- **Docs stating what portability does and does not mean.** A skill is prose;
  its *portability* is real. But a skill that references tools this install
  does not have is portable and useless, and a reader should know which they
  have before they wonder why nothing happens.

**Out:**

- **Publishing to, or operating, any index.** Consuming somebody else's
  distribution is the whole point of this step; running one is 12.
- **Automatic installation from anywhere.** A skill is prose an agent follows
  and a trusted config decides what runs — a skill that installed itself
  because an agent found it is the auto-loading `plugins.md` forbids, wearing
  a friendlier name.
- **Executable skills.** Where the standard admits scripts and resources
  alongside the prose, those are code, and code arrives here as a plugin
  through the two gates. Prose imports; executables do not.
- **Changing what a skill *is*.** `plugins.md`'s line holds: a skill teaches a
  procedure, a thing that acts is a tool.

## Design sketch

- Conformance is a floor, not a ceiling. Where the standard is silent and we
  need something — qualified `<package>:<skill>` ids, the operator-outranks-
  plugin precedence — that stays, because it answers a question the standard
  does not ask. Where the standard speaks, we follow it.
- **A skill from outside is untrusted prose**, and it is prose an agent will
  follow. Installing one is an operator decision on the same footing as
  enabling a plugin, and the docs should not soften that because the artifact
  is markdown rather than JavaScript. The risk is not that it executes; it is
  that it instructs.
- Ids collide across sources. The existing precedence — an operator's bare id
  outranks a plugin's alias, and an id two plugins both want goes to neither —
  already answers this and should not grow a third rule for ecosystem skills.
- Strict-and-loud beats permissive-and-quiet. A rejected skill that names its
  problem is a fixable afternoon; a silently half-loaded one is a bug report
  six weeks later.

## Acceptance criteria

- A skill from the public ecosystem installs and an allowlisted agent loads
  and follows it, with no manual editing.
- A skill written here validates against the published spec.
- A non-conforming skill is refused at install, naming what is wrong.
- A skill referencing a tool this install lacks still installs, and the failure
  when an agent reaches for that tool is the ordinary allowlist refusal.
- Existing `~/.stratus/skills/` content keeps working across the change, and
  existing plugin-contributed skills keep their qualified ids.
- Both gates still apply: installing a skill enables nothing, and an agent
  loads it only if its soul lists it.

## Open questions

- **Do we differ from the spec anywhere that matters?** Unknown until the
  conformance pass runs, and the answer decides whether this step is an
  afternoon or a fortnight.
- **Does `stratus skill add` need an ecosystem-aware source form**, or is a
  git URL enough? The command is friendlier and is one more surface to
  keep current against somebody else's index.
- **Do we publish our own skills outward?** `stratuslabs/skill-*` already exists
  outside this repository. Making them discoverable in the shared index costs
  little and is a distribution decision rather than an engineering one.
