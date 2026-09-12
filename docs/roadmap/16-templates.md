# 16 — Templates: an agent, its skills, and its plugins in one command

## Goal

`stratus template add <folder or repo>` installs an agent that already does
something: the soul, the skills it uses, and the plugin configuration behind
its tools. A template is a **folder of files**, and installing one is
**copying them into `~/.stratus`**.

## Why this shape

Every capability in steps 06 and 09–14 is reachable only by an operator
willing to hand-write frontmatter, find the plugin config, and install the
package — three documents before anything works.

The fix is not a new format. `~/.stratus` already has the shape: `agents/`,
`skills/`, `config.json`. A template is a picture of what to add to it, so
the format is the directory layout and nothing has to parse or plan. That is
also what makes it reviewable — reading a template is reading a folder,
because what is in the folder is exactly what lands on disk.

`stratus skill add <owner/repo|path>` already resolves a source, clones it,
and copies files into `~/.stratus`. `template add` is that command over more
directories, and reuses those helpers rather than growing new ones.

## Scope

**In:**

- **`stratus template add <path | owner/repo | git URL>`**, one command in
  `packages/cli`. It prints every agent, skill, plugin package and config
  key it would add, asks, then copies. `--yes` skips the prompt (scripts,
  and the desktop and web UIs that show the same list themselves);
  `--force` replaces an agent or skill already installed under that name.
- **The layout is the format.** `template.json` (name, description),
  `config.json` (merged into `~/.stratus/config.json`), `agents/*.md`,
  `skills/<id>/SKILL.md`. Every directory optional except the manifest.
- **One list of plugin packages, not two.** The keys of `config.json`'s
  `plugins` block name what to `npm install -g` *and* what to enable. A
  separate list of packages would be a second answer to drift from the
  first.
- **The config merge is additive where it can be.** Plain objects merge key
  by key; scalars and arrays replace. A template naming one plugin must not
  take away the ones already enabled.
- **Package names are validated before they reach npm.** The installer
  spawns npm through a shell on Windows; a template is a folder somebody
  downloaded, so its `plugins` keys are refused unless they are plain npm
  package names.
- **One example template in this repository**, `examples/templates/example`,
  as the reference for the layout. A test installs it.

**Out:**

- **A planner.** Resolving manifests, flooring declared risk, and detecting
  tool-name collisions before the copy is a second implementation of what
  `loadPlugins` already does at start, and it is what made the first attempt
  5,568 lines. The daemon reports a plugin it refuses; the template flow
  does not predict it.
- **Templates compiled into a package.** They are files, from a path or a
  repo, so the library the desktop and web UIs will show is a list of repos
  rather than a catalog anyone has to ship a release to change.
- **A DSL.** No conditionals, interpolation, or composition. What is in the
  folder is what lands.
- **A transaction.** Files are copied one at a time and the output says what
  landed. A rollback needs the locked, staged, atomic config write that cost
  the first attempt 18 review findings, for a failure mode an operator can
  see and fix.
- **Editing an existing agent.** Templates add; changing an agent afterwards
  is the soul file and [17](./17-fleet-console.md).

## Acceptance criteria

- From a fresh install, one command produces an agent in the roster with its
  skill installed and its plugin enabled — verified by running the command,
  not by inspecting the files it wrote.
- The review lists every agent, skill, package and config key before
  anything is written, and declining writes nothing.
- A `plugins` key that is not an npm package name is refused, and the
  installer never sees it.
- Installing a template that names one plugin leaves the plugins already
  enabled in place.
- An agent or skill already installed under the same name is skipped, the
  rest still installs, and `--force` replaces it.
- The example template in this repository installs.

## What the first version settled

- **The command is `template add`, not `agent new --template`.** A template
  can carry more than one agent, plus skills and config, so it is not a flag
  on agent creation.
- **Where templates live: anywhere.** A path or a git URL, resolved by the
  same helper `skill add` uses. Nothing is shipped in the CLI, so the four
  templates the first attempt compiled into `@stratusagent/state` are gone
  and there is one example folder in their place.
- **Where the code lives: `packages/cli`.** Nothing in `state`, `plugins`,
  or `control-api`. The whole feature is one section of `index.ts` reusing
  `resolveSource`, `cloneSource`, `installSkillsFromDirectory`, and the
  package installer setup already uses.

## Deferred

- **The library UI.** The desktop and web apps show the available templates
  and install one on click, over this command. That is [17](./17-fleet-console.md).
- **Trusting a source.** Today the review is the whole answer: a template can
  name any npm package, and installing one runs that package's install
  scripts. Signing, pinning, or a curated index is [12](./12-plugin-registry.md).
