# Fixture plugins

Not plugins anyone installs. Manifests and entry points that exist so the
CLI's tests can resolve a plugin shape this repository does not otherwise
ship — a test needing a shape no real package has gets a fixture here, and
anything that resolves a *specifier* (`import.meta.resolve`) cannot be driven
by an object literal.

| Package | The shape it exists for |
| --- | --- |
| [`stratus-plugin-fixture`](./stratus-plugin-fixture) | skills and no tools; a package the CLI has no built-in entry for |
| `stratus-plugin-fixture-provider` | a **provider** registered through `context.providers`, selectable with `provider: fixture` |
| `stratus-plugin-fixture-channel` | a **channel** registered through `context.channels`, carrying the agents with secrets under `channels.fixture.<agentId>` |
| `stratus-plugin-fixture-memory` | a **memory store** registered through `context.memory`, selectable with `memoryStore: fixture` |
| `stratus-plugin-fixture-executor` | an **executor** registered through `context.executors`, selectable with `executor: fixture`; with `disposeMarker: <path>` in its config it writes that file on dispose, so a test can prove a host released it |

One package per kind rather than one package registering all four, so each
proves one seam and a test that breaks names the seam it broke. Every one
is `private: true`, outside `packages/` so it is not mistaken for something
that ships, and linked from the **root** `package.json` — a published
package listing a private `workspace:*` devDependency would leave a version
nobody can resolve in its published metadata.
