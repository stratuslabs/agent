# @stratusagent/plugins

The plugin host: what a plugin claims, what it is allowed to register, and how
a config block becomes running capability.

The contract lives in
[`docs/architecture/plugins.md`](../../docs/architecture/plugins.md) and is not
re-derived here. This package is what makes it enforceable.

You do not install this directly — it comes with `@stratusagent/cli`. You do
read it if you are writing a plugin.

## What a plugin author needs

A `stratus` field in `package.json`, and one named export:

```jsonc
{
  "name": "stratus-plugin-notes",
  "keywords": ["stratus-plugin"],
  "stratus": {
    "pluginVersion": 1,
    "contributes": {
      "tools": [
        { "name": "notes.read", "risk": "safe" },
        { "name": "notes.write", "risk": "gated" }
      ]
    },
    "config": {
      "type": "object",
      "properties": { "vault": { "type": "string" } },
      "required": ["vault"]
    }
  }
}
```

```ts
export const createPlugin = (config) => ({
  name: 'stratus-plugin-notes',
  setup(context) {
    context.tools.register(readTool(config));
  },
  // Optional. Only if setup acquired something a daemon shutdown must release.
  async dispose() {},
});
```

## What the host does with it

- **Reads the manifest without importing the package.** A misconfigured or
  over-reaching plugin fails at load, with its own name in the message, rather
  than at the first tool call in the middle of somebody's turn.
- **Validates your config against your schema** — including each per-agent
  entry under `agents`, with `required` relaxed there, because an override says
  what differs for one agent rather than restating the defaults.
- **Hands `setup()` a manifest-bound registry, not the real one.** A name your
  manifest does not declare is refused. The risk a tool registers at is the
  riskiest of three claims — your manifest's, the floor your package is held
  to, and whatever the object says about itself — so a tool can raise itself
  and can never talk its way below what it declared.
- **Stages and commits.** Nothing reaches the shared registry until your whole
  `setup()` has succeeded, so a plugin that over-reaches on its fourth tool
  leaves none of the first three behind.
- **Refuses collisions.** Two packages contributing one tool name is a
  load-time error naming both, never whichever loaded last.
- **Keeps the view live for discovered names.** A plugin declared with
  `toolsDiscovered` (the MCP bridge) learns names from a server, on connect
  and again on reconnect — so the view it was handed keeps registering after
  commit, under the identical gate, and can `unregister` its own names when
  a server stops advertising one. Its tool records stay current, which is
  what the catalog and dashboard read.
- **Applies the operator's `toolRisks`.** A host-owned config key (sibling
  to `enabled` and `agents`, stripped before your code sees the block) that
  replaces the manifest's risk for an exact tool name, both directions,
  still floored for untrusted packages. It exists so an operator who has
  read a bridged server's tool can mark it `safe` — a claim the plugin's
  own code never gets to make.

## Resolving settings per call

```ts
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

async execute(input, session) {
  const settings = resolvePluginAgentConfig(config, session.agent.id);
  …
}
```

Per call, from the session — not once at setup. For a plugin whose settings
are an access boundary (`tool-fs` roots are the example), resolving once hands
every agent whichever value was resolved first, which is one agent reading
another's files from code that looks correct.

## `loadOptionalModule`

The resolve-then-import split, in one place:

```ts
const slack = await loadOptionalModule('@stratusagent/channel-slack', {
  resolve: (id) => import.meta.resolve(id),
  import: (id) => import(id),
});
```

Only a package failing to **resolve** means "not installed". One that is
installed but missing a dependency of its own throws `ERR_MODULE_NOT_FOUND`
too, naming that dependency — so reading the import's error would turn a broken
install into a silently disabled feature.

The two capabilities come from the caller because `import.meta.resolve` answers
relative to the module that calls it: resolvable *from the daemon* and
resolvable *from this package* are different questions, and only the first is
the one being asked.
