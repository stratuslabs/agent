# stratus-plugin-fixture

Not a plugin anyone installs. A manifest that exists so the CLI's tests can
resolve a plugin this repository does not otherwise have.

Every package under `packages/` that carries a `stratus` manifest contributes
**tools** and is named in the CLI's own `PLUGIN_SETUP` table. That left two
shapes with no fixture, and three review findings landed on code no test could
reach:

- **A plugin contributing skills and no tools.** Skills are gated the opposite
  way to tools — an omitted `tools:` list is every registered tool, an omitted
  `skills:` list is *none* — so the lines about them are separate code, and the
  "nothing here for a `tools:` list to name" branch is reachable only from a
  manifest like this one.
- **A package the CLI has no built-in entry for.** `PLUGIN_SETUP` covers the
  five first-party packages; what setup says about anything else — that it read
  a manifest and never loaded the package — could not be exercised while every
  resolvable plugin was one of the five.

Two skills rather than one on purpose: the allowlist setup prints has to name
all of them, and a fixture with one skill cannot tell a correct list from a
`[0]`.

The workspace root devDepends on it twice — the root, not `packages/cli`,
because that package is published and a private `workspace:*` devDependency
would leave a version nobody can resolve in its metadata. The second link is
a pnpm alias:

```json
"stratus-plugin-aliased": "workspace:stratus-plugin-fixture@*"
```

That is not a spare copy. A `plugins` config key is *also* the specifier a
daemon imports, and the loader qualifies skills with the **manifest's**
`packageName` — so a key and a package name that disagree is a real
configuration, and the only way to build one is to install the same package
under a second name.

`private: true`, and outside `packages/` so it is not mistaken for one.
