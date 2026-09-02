# 12 — Plugin discovery and distribution

## Goal

A way to find a plugin, install it, and know who wrote it — without which the
ecosystem [`plugins.md`](../architecture/plugins.md) describes is a convention
nobody can act on.

## Why now

Last, deliberately. A registry with three entries is a worse artifact than no
registry, and the trust model has a dependency that only distribution can
satisfy: "a third-party tool may not declare itself `safe`" needs a
**trusted-publisher set** to be more than a permanent floor. Until then every
third-party tool is `gated`, which is correct but blunt.

The v2 architecture lists "Marketplace (agents/tools/skills distribution)" as
out of scope for its arc. This step is where that changes, and it is the reason
the vocabulary landed early: naming is cheap now and expensive after packages
exist.

## Scope

**In:**

- **Discovery without a registry, first.** The `stratus-plugin` keyword in
  `package.json` makes npm the index on day one. This step's first deliverable
  is `stratus plugin search`, which queries npm — no infrastructure at all.
- **`stratus plugin install <name>`** — installs alongside the CLI, reads the
  manifest, shows what the plugin contributes and which credentials it wants,
  and requires confirmation before writing it into the `plugins` block. The
  confirmation is the point: the trust model says nothing auto-loads, and an
  install command that silently enables would defeat it.

  A plugin declaring a **namespace** rather than names is rendered as what it
  is — "registers tools under `mcp.*`, discovered at runtime, all `gated`" —
  never as an empty tool list. A namespace tells an operator less than a list
  does, and the confirmation screen is exactly the wrong place to disguise
  that.
- **`stratus plugin list` / `remove`**, and the same over the control API so the
  dashboard ([17](./17-fleet-console.md)) can show installed plugins with their
  contributions. This said "and macOS app" when written; [07](./07-desktop-app.md)
  was rewritten as a distribution and lifecycle step and holds no management
  screens.
- **A curated index repo** (`stratuslabs/plugins`) once there are enough
  packages to be worth curating: metadata, categories, and the
  **trusted-publisher set** the risk floor reads. Trusted means we have looked
  at it, not that it is safe — the wording matters and belongs in the docs.
- **Version compatibility.** `stratus.pluginVersion` and a peer range on
  `@stratusagent/core`, checked at load, so a plugin written against an older
  contract fails with a sentence rather than a `TypeError`.

**Out:** hosting our own package registry (npm is the registry); paid plugins
and billing; agent packages as a distributable unit — a soul plus a plugin list
is a config file, and shipping it is a smaller problem best solved after
plugins work.

## Design sketch

- Global installs live next to the CLI, which is how `channel-slack` already
  works; the loader is the same `import.meta.resolve` seam, so "installed"
  means the same thing it means today.
- The index is data in a git repository, not a service. A pull request adds an
  entry; nothing is hosted; the CLI fetches raw JSON. The Swift iteration's
  `docs/MARKETPLACE_PLAN.md` reached the same design, and it is still right.
- Trust is per publisher, not per package, and it is not transitive: a trusted
  publisher's plugin may still contribute a `gated` tool, because the floor
  lifting means "this author may declare `safe`", not "everything here is".

## Acceptance criteria

- `stratus plugin search browser` finds packages by keyword with no
  infrastructure deployed.
- `stratus plugin install` shows contributions and requested credentials, and a
  declined confirmation leaves the config untouched.
- A plugin declaring an incompatible `pluginVersion` refuses to load with a
  message naming the version it needs.
- A tool from an untrusted publisher declaring `risk: "safe"` is executed as
  `gated`, and the test proves the declaration was ignored.
- Uninstalling a plugin removes it from the config and leaves souls that
  allowlisted its tools loadable — an allowlist entry for a tool that no longer
  exists is not a broken agent.

## Open questions

- Should souls be able to declare the plugins they need, so `stratus agent
  install` can resolve them? Attractive, and also how a soul file becomes able
  to cause code to be installed — likely a prompt-only flow, never automatic.
- Does the index carry skills separately from plugins? Skills are markdown with
  no install risk, so a lighter path for them is defensible; the counterargument
  is two mechanisms where one would do.
