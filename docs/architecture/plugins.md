# Plugins: the capability ecosystem

How capability reaches an agent, what a package that supplies it is called, and
what a developer outside this repository has to write. This is the contract
[step 06](../roadmap/06-tool-packs.md) and everything after it implement
against; [`stratus-v2.md`](./stratus-v2.md) is the architecture it sits inside.

## Three words

**Tools are callable actions. Skills teach an agent how to work. Plugins are
the packages that deliver either** — along with providers, channels, memory
stores, executors, and hooks.

The split matters because the same capability arrives two different ways. A
browser is a tool: the agent cannot navigate a page by being told about it. A
code-review rubric is a skill: the agent already has `fs.read`, and what it
lacks is the procedure. Shipping a rubric as a tool would be a function that
returns a paragraph; shipping a browser as a skill would be instructions for
something the agent cannot do.

This is the vocabulary the surrounding ecosystem has converged on, and it is
worth matching rather than inventing: the developers we want have read somebody
else's agent documentation already, and a synonym coined here is a word they
have to learn for no benefit.

**"Tool pack" is retired.** `@stratusagent/tool-fs` is a *plugin* contributing
the `fs` *toolset*.

## What a plugin contributes

Every contribution kind has an interface already. What differs is whether a
plugin can *register* one through the entrypoint, and today most cannot:

| Contributes | Interface | Registers through `setup()` |
| --- | --- | --- |
| tools | `Tool` → `ToolRegistry` | **yes**, `context.tools` |
| hooks | `EventBus.subscribe` | **yes**, `context.bus` |
| skills | `Skill` → `SkillRegistry` | **n/a — the host loads them from the manifest** ([09](../roadmap/09-skills.md)) |
| providers | `ModelProvider` | **not yet** |
| channels | `ChannelAdapter` | **not yet** |
| memory | `AgentMemoryStore` | **not yet** |
| executors | `Executor` | **not yet** |

Skills are the one kind that never needed a registration handle: a skill is
prose the manifest points at (`contributes.skills`, an id and a path inside
the package), so the host reads and registers it **without running the
plugin's code** — which is also why a broken skill file refuses the plugin at
load, before its module is imported. A plugin's skills register under the
qualified `<package>:<skill>` id, plus the bare id while no other package (and
no operator-installed skill) claims it.

The entrypoint is the `Plugin` interface the kernel has had since v1, plus the
teardown hook [06](../roadmap/06-tool-packs.md) added for plugins that hold
something:

```ts
export interface Plugin {
  name: string;
  setup(context: PluginContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
```

`PluginContext` is `{ bus, tools }` — that is the whole of it, and
`AgentRunner.initialize` calls `plugins.loadAll({ bus, tools })` with nothing
else. **So four of the seven kinds have an interface but no registration path.**
An implementation of `ChannelAdapter` exists (`@stratusagent/channel-slack`),
and the way it reaches the runtime is that the CLI constructs it and hands it to
`createGateway({ channels: [...] })` — the host wires it, not the plugin. The
same is true of providers (`createRuntimeProvider`) and memory stores (passed to
the runner).

### What the module exports

`Plugin` describes the object the registry receives. It does not say how the
loader gets one, and a generic loader cannot import a package that answers that
question differently from the next package. So the ABI is one line:

```ts
export const createPlugin = (config: JsonObject): Plugin | Promise<Plugin> => { … };
```

The host that implements all of this is `@stratusagent/plugins`.

- **A named `createPlugin` export**, not a default. Every optional package in
  this repo is already loaded by named factory —
  `createSlackChannelAdapter`, `createGateway`, `createLocalCommandExecutor` —
  and a default export makes the failure mode "imported something, called it,
  got `undefined`" instead of a resolvable name.
- **A factory, never a class.** The loader never uses `new`, so a plugin's
  construction cost is the author's business and its instance is not part of
  the contract.
- **`config` is the plugin's own block** from the `plugins` config below, minus
  `enabled`, already validated against the manifest's `config` schema. A plugin
  that takes no configuration ignores the argument; it is always passed, so
  there is no second signature.
- **Async is allowed** — a plugin that must read a file or open a connection to
  know what it contributes returns a promise, and `loadAll` awaits it.
- **`dispose()` is optional and the host calls it.** Most plugins have nothing
  to release and omit it. Some do: a browser plugin holds a Chromium and a
  listening socket, and a daemon that stopped without telling it would leak
  both. It is called on shutdown, after channels have stopped and in-flight
  turns have drained, and a plugin that throws there is logged rather than
  allowed to hold up the drain.

**One key in the config block is the host's, not the plugin's.** A plugin whose
manifest schema declares `workspaceRoot` is given the platform's answer
(`~/.stratus/workspaces`) when the operator did not set one, because the
`~/.stratus` layout is this repository's to own and a plugin deriving it would
be a second copy of a path that can drift. A plugin that never declares it is
never handed it.

A package may export additional, more specific factories for direct import
(`createFsPlugin` for a test or an embedding host that skips the loader
entirely). Those are conveniences; `createPlugin` is the one the loader knows,
and a package without it is not loadable however well it is written.

That gap is deliberate to state and not deliberate to keep. Naming the kinds
before the seams exist is the point of this document — a third-party developer
should be able to see what is contractual today and what is coming — but a
table that read "exists" for all seven would be a promise the entrypoint cannot
keep. The registration handles for providers, channels, memory, and executors
are enumerated as kernel-budget item 9 in
[`stratus-v2.md`](./stratus-v2.md) and land with the plugin loader; until they
do, **a plugin contributing one of those four kinds is configuration the host
reads, not code the plugin registers.**

A plugin depends on `core` (and on `channels` or `executors` where relevant) —
**never on the gateway** — so it behaves identically in a CLI one-shot, in the
daemon, and in whatever embeds the runtime next.

## Naming

| Thing | Shape | Examples |
| --- | --- | --- |
| Tool | `namespace.verb` | `fs.read`, `browser.goto`, `memory.remember` |
| Toolset | the namespace | `fs`, `browser`, `agent` |
| Skill | the [Agent Skills](https://agentskills.io) `name` rule: lowercase runs joined by single hyphens, at most 64 characters, equal to the directory name | `web-research`, `code-review` |
| First-party package | `@stratusagent/<kind>-<name>` | `tool-fs`, `channel-slack`, `provider-anthropic` |
| Third-party package | `stratus-plugin-<name>` | `stratus-plugin-github` |

The tool shape is already what the repo does (`memory.remember`,
`agent.delegate`, `demo.echo`); writing it down is what makes `tools: [fs.*]`
mean something. Toolset is the noun that glob names.

Two plugins may contribute the same skill id — a `pr-review` from a vendor and
one from your own team. The qualified form is `<package>:<skill>`
(`stratus-plugin-github:pr-review`). The qualifier is the
**package name verbatim**, which is verbose on purpose: a normalized short id
would be a second identifier keying access, and `@acme/stratus-plugin-github`
and `stratus-plugin-github` would normalize to the same `github` while being two
different packages from two different authors. One name per thing, and the one
that is already unique. Globs match the qualified id, so
`stratus-plugin-github:*` is the form that selects a package's skills — not
`github:*`, which matches nothing.

Tools have no qualified form: a tool name is unique per install, and a collision
is a load-time error (below).

The third-party package name is a **discovery convention, not a requirement**.
What makes a package a plugin is its manifest. The convention exists so that
`npm search stratus-plugin` and the `stratus-plugin` keyword both work before
any registry does.

## The manifest

A `"stratus"` field in `package.json`:

```jsonc
{
  "name": "stratus-plugin-github",
  "keywords": ["stratus-plugin"],
  "stratus": {
    "pluginVersion": 1,
    "contributes": {
      "tools": [
        { "name": "github.pr.comment", "risk": "gated" },
        { "name": "github.pr.read", "risk": "safe" }
      ],
      "//": "or, for a plugin whose tool names exist only at runtime:",
      "toolsDiscovered": [
        { "namespace": "mcp.*", "risk": "gated" }
      ],
      "skills": [
        { "id": "pr-review", "path": "./skills/pr-review/SKILL.md" }
      ]
    },
    "credentials": ["GITHUB_TOKEN"],
    "config": { "type": "object", "properties": { "org": { "type": "string" } } }
  }
}
```

The point of a manifest separate from the code is that **the daemon can see
what a plugin contributes, and validate its configuration, without importing
it**. A misconfigured or over-reaching plugin fails at config validation, not
at the first tool call in the middle of somebody's turn. A dedicated manifest
file beside `package.json` would get the same property; a field *in*
`package.json` gets it with one fewer file to drift.

`contributes.tools[].risk` is a **declaration, not a decision** — see the trust
model.

### Declaring a namespace instead of names

Some plugins cannot list their tools. The [MCP bridge](../roadmap/11-mcp.md)
learns its tool names by asking a server at connect time, and the set changes
when the server changes — so a static list of names is not merely inconvenient
for it, it is impossible. For those, a manifest declares a **namespace it owns**
rather than the names inside it:

```jsonc
"toolsDiscovered": [{ "namespace": "mcp.*", "risk": "gated" }]
```

This is a smaller loophole than it looks, and the constraints are what keep it
from being a wildcard:

- **A namespace is not everything.** `mcp.*` authorizes
  `mcp.linear.create_issue` and authorizes nothing named `fs.write`. Anything
  outside the declared namespace is rejected exactly as an undeclared literal
  name is — at first load, and identically on every reconnect.
- **The declared risk is a ceiling on trust, not a floor the plugin picks.**
  A discovered tool is registered at the namespace's declared risk, never below
  it, and the third-party floor still applies on top. A bridge cannot mark a
  server's tool `safe` by discovering it, which is the same conclusion 11
  reaches from its own direction: the risk assignment is ours, not the
  server's. The one word that outranks the declaration is the operator's —
  the host-owned `toolRisks` config key below — because "ours" means the
  person running the daemon, never the code being judged.
- **Provenance is unchanged.** The package is still recorded, so risk
  resolution can still ask whose code a tool is.
- **The view stays live after load.** Discovered names arrive when a server
  answers, which for a bridge is also on every *reconnect* — so the
  registration view a namespace plugin's `setup()` received keeps working
  after the plugin has committed. A late registration passes the identical
  gate (undeclared name rejected, declared risk and overrides applied,
  collision refused) and lands in the shared registry at once, since a
  plugin that already loaded whole has nothing left to stage. The view can
  also `unregister` — **only names the plugin itself registered** — so a
  tool a server stops advertising stops being advertised to agents, and the
  plugin's tool records (and everything reading them: the catalog, the
  dashboard) stay the live truth rather than a load-time snapshot.

The cost is real and belongs in the open: a namespace tells an operator
strictly less than a list. They learn *where* a plugin may register and under
what risk, not *what*. That is why [12](../roadmap/12-plugin-registry.md) has
`stratus plugin install` render such a declaration as what it is — "registers
tools under `mcp.*`, discovered at runtime, all `gated`" — rather than showing
an empty tool list and implying the plugin contributes nothing.

## Configuration

One `plugins` block in `~/.stratus/config.json`, keyed by package name:

```jsonc
{
  "plugins": {
    "@stratusagent/tool-fs": { "enabled": true, "roots": ["~/work", "~/notes"] },
    "@stratusagent/tool-shell": { "enabled": true },
    "stratus-plugin-github": { "enabled": true, "org": "stratuslabs" }
  }
}
```

Keyed by package because a plugin's identity *is* its package, and because a
plugin may contribute more than tools — a block keyed by toolset has nowhere to
put a plugin that adds a channel and a memory store.

**Per-agent settings live in an `agents` sub-block**, defaults above it:

```jsonc
"@stratusagent/tool-fs": {
  "enabled": true,
  "roots": ["~/notes"],
  "agents": {
    "ava":  { "roots": ["~/work/ava"] },
    "juno": { "roots": ["~/work/juno", "~/shared"] }
  }
}
```

This shape is not new — `approvals` already carries exactly it (defaults, then
`agents` keyed by agent id), and copying it beats inventing a second convention
for the same idea. It matters more here than there, because for a plugin like
`tool-fs` these values *are* an access-control boundary: a flat `roots` array
would give every agent enabling `fs.*` the same roots, which is one agent
reading another's files.

**`toolRisks` is the third host-owned key**, sibling to `enabled` and
`agents`: tool name to `safe` / `gated` / `dangerous`, the operator's
per-tool risk word.

```jsonc
"@stratusagent/plugin-mcp": {
  "enabled": true,
  "servers": { "linear": { "url": "https://mcp.linear.app/mcp" } },
  "toolRisks": { "mcp.linear.get_issue": "safe" }
}
```

An entry replaces the manifest's declaration for that exact name — both
directions, which is its point: a bridge's namespace is declared `gated` as
a ceiling on what *discovery* may claim, and the operator who has actually
read one server's tool is the one party entitled to decide it may run
unattended. Placement is the security property: the key is stripped before
the plugin's config reaches its code and applied by the registration view,
so the word that lowers a tool's risk is written in a trusted config, never
by the plugin — and the third-party floor still binds it, because config
can vouch for a tool, not for the code implementing it. A name the
manifest does not cover is refused rather than ignored; a typo'd override
that silently did nothing would surface as a prompt nobody can explain.

A plugin is still constructed once, not once per agent. It resolves the caller's
settings **at execution time**, from `session.agent.id` — `Tool.execute(input,
session, context)` already carries the session, so no new seam is required, and
an agent with no entry gets the defaults. A plugin whose settings are an access
boundary must resolve per call rather than closing over one value at setup, and
that is a requirement on the plugin, not a courtesy.

Loading uses the `import.meta.resolve` + dynamic-import pattern of
`loadSlackAdapter` in `packages/cli/src/index.ts`. It resolves first and imports
second on purpose: a package that is installed but missing one of *its*
dependencies throws `ERR_MODULE_NOT_FOUND` too, so inspecting the import error
cannot tell "not installed" from "installed and broken" — and silently
disabling a channel whose stored tokens say it should be running is the failure
that split buys off.

**Extracted before the plugin loader was written**, in
[06](../roadmap/06-tool-packs.md). [05](../roadmap/05-control-api.md) had taken
the count from one caller to three — the Slack adapter, the control API, and
the dashboard resolved from inside the control API — each carrying its own copy
of the same twelve lines, and the loader would have been the fourth. It is now
`loadOptionalModule` in `@stratusagent/plugins`. The two capabilities it needs
come from the caller (`{ resolve: (id) => import.meta.resolve(id), import: (id)
=> import(id) }`) rather than being used inside the helper, because
`import.meta.resolve` answers relative to the module that calls it: resolvable
*from the daemon* and resolvable *from the helper's package* are different
questions, and only the first is the one being asked.

## Trust model

A plugin runs **in-process with the daemon**: same Node process, same event
loop, same environment. Nothing below changes that, so say the consequence
first — **an enabled plugin is trusted code, and enablement is the security
boundary.** The rules exist to make that boundary deliberate, auditable, and
narrow. They are not a sandbox, and this document does not claim one:

- **Nothing auto-loads.** A plugin runs only when it is listed and enabled, and
  that list is read only from a **trusted** config. This is the rule already
  established for the `api` and `approvals` blocks: an auto-discovered
  project-local `stratus.config.json` decides nothing that can execute code.
  The reason is worth stating plainly: it stops third-party code from running
  without the operator's explicit consent.
- **The manifest is validated before the module is imported.** Reading what a
  plugin claims must never require running what it does.
- **`setup()` registers through a manifest-bound view, never the raw
  registry.** Validating `package.json` before import says what a plugin
  *claims*; it does nothing about what `setup()` then does, and `ToolRegistry.
  register` is a bare `Map.set` that records neither the originating package
  nor anything to check a claim against. A plugin handed that registry directly
  could register a tool it never declared, mark it `safe`, and run unattended —
  the floor below would be decoration. So `context.tools` is a per-plugin view
  that **rejects a name the manifest does not declare** — as a literal name or
  as falling inside a declared namespace — **retains the package as provenance**
  so risk resolution can ask whose code a tool is, and **applies the declared
  risk and the floor at registration** rather than trusting the `risk` field on
  the object it is handed. The manifest becomes enforceable rather than
  advisory, which is the only way the two rules around it mean anything. A
  namespace declaration widens what a plugin may name; it never widens what it
  may claim about risk, and it never reaches outside itself.
- **A third-party tool may not declare itself `safe`.** `safe` means "run this
  unattended, with nobody watching," and it is not a claim the code being
  judged gets to make about itself. Risk floors at `gated` for tools from
  plugins outside the trusted set; the permission layer resolves the effective
  risk. This is the direction `DEFAULT_TOOL_RISK` and `resolveToolRisk` already
  fail in — a tool that forgot to think about risk is held back, not waved
  through.

  The trusted set is the first-party scope (`@stratusagent/*`), which ships
  from this repository and is gated by its CI; a host may widen it
  deliberately, and doing so is the same kind of act as enabling the plugin at
  all. The effective risk is the riskiest of three claims — the manifest's
  declaration, that floor, and whatever the registered object says about
  itself — so a tool can raise itself above its manifest and can never talk
  its way below it.

- **A plugin's configuration is validated against its own schema before the
  module is imported.** The subset understood is deliberately small — `type`,
  `properties`, `required`, `items`, `enum`, and `additionalProperties: false`
  — so that a daemon can answer "is this well-formed" without carrying a
  validator into every install. Keywords outside the subset are ignored rather
  than refused, which buys fewer checks and never a false pass. Per-agent
  entries under `agents` are checked with `required` relaxed: an override says
  what differs for one agent, so holding it to the schema's required list would
  make the defaults above it unusable.
- **A plugin gets a scoped credential resolver and its own config block, so it
  never needs `process.env`** — it declares what it needs by name in the
  manifest and receives exactly that. Read what this does and does not buy.
  It does not *prevent* a plugin from reading `process.env`: in-process code
  can, and no interface we hand it changes that. What it buys is that an honest
  plugin never has to, so its manifest is a true statement of what it uses and
  an operator can audit against it — and that a plugin reaching for ambient env
  is doing something its manifest did not declare, which is a reviewable act
  rather than the normal way to get a key.

  This is a weaker guarantee than the agent-scoped `CredentialResolver`, and
  the asymmetry is worth understanding: an agent is a model, not code, so
  scoping is a real boundary there — an agent genuinely cannot read a credential
  it was not granted. A plugin is code, so scoping is an interface. The
  invariant that Slack channel tokens are gateway infrastructure secrets holds
  fully against agents and only conventionally against plugins.

  A real boundary needs process or worker isolation with a scrubbed
  environment. That is future work and consistent with this project's stated
  order — "policy before isolation" in [`stratus-v2.md`](./stratus-v2.md) —
  which is exactly why enablement is trusted-config-only and why nothing
  auto-loads: those are the controls actually carrying the weight here.
- **Installing a plugin grants no agent anything.** The soul's `tools:`
  allowlist still decides, per agent, which of the registered tools that agent
  may call. Two independent gates, and the second one is per-identity.
- **A name collision is a load-time error.** Two plugins contributing
  `github.pr.comment` is refused, never silently resolved to whichever loaded
  last — the same reason a duplicate agent id is `DuplicateAgentIdError` rather
  than an overwrite.

## Core in the monorepo, core outside it

> A package lives in this monorepo if the kernel's guarantees depend on it, or
> if it depends on kernel contracts that are not published yet. It lives in its
> own repository if it depends only on published contracts and on somebody
> else's API.

**In the monorepo.** The kernel and everything CI must gate: `core`, `agents`,
`state`, `gateway`, `permissions`, `providers`, `channels`, `executors`,
`executor-local`, `cli`, `control-api`, `dashboard`, `provider-anthropic`,
`provider-claude-code`, `channel-slack` — plus the capability plugins that each
carry a security invariant the kernel's promises rest on:

| Plugin | The invariant it owns |
| --- | --- |
| `tool-fs` | symlink-safe root containment, including the write-through-parent case |
| `tool-shell` | command scoping, control-operator defeat, environment scrubbing |
| `tool-browser` | request-level address validation against SSRF and DNS rebinding |
| `tool-web` | the same address policy, shared with `tool-browser`, not re-derived |

Two of those invariants turned out to belong outside the packs that own them,
and both live in the monorepo for the same reason the packs do. The **address
policy** is one module, `@stratusagent/egress`, imported by `tool-browser` and
`tool-web` — a second copy would not drift into a style difference, it would be
an SSRF hole in whichever copy went stale — and both packs are tested against
one shared table of hostile URLs, which is what fails if it is ever forked. The
**command scope engine** is in `@stratusagent/permissions` rather than in
`tool-shell`: a pack that classified its own invocations would be a second
policy, disagreeing with the first the day either changed. The shell pack
contributes the command string (`Tool.commandFor`) and nothing else.

**First-party, outside.** Same authors, separate repositories:

- **Skills** (`stratuslabs/skill-*`) — markdown with no build step. Putting them
  behind `pnpm build && pnpm typecheck && pnpm test` buys nothing and slows the
  loop that matters for them, which is editing prose.
- **Per-vendor service tools** — GitHub, Notion, Google Workspace, Linear.
  These depend on somebody else's API, and somebody else's API breaking must not
  turn this repository's CI red.
- **The macOS app**, **example agents**, and eventually **the registry index**.

`stratuslabs/skill-code-review` and `stratuslabs/skill-web-research` already sit
on the right side of this line and stay there.

## What third parties could build

The ecosystem this is for, by contribution kind:

| Kind | Examples |
| --- | --- |
| Channels | Discord, Telegram, WhatsApp, email/IMAP, SMS, Matrix, Teams, generic webhook |
| Providers | OpenRouter, Ollama and other local runtimes, Gemini, Bedrock, Azure, Groq |
| Memory | SQLite + embeddings, pgvector, Mem0, Zep, an Obsidian vault |
| Tools | GitHub, Linear/Jira, Notion, Google Workspace, Stripe, Postgres, kubectl, Home Assistant, PDF, image generation, TTS/STT, and search backends (Exa, Tavily, Firecrawl, Brave) |
| Skills | SEO writing, incident runbooks, on-call triage, financial analysis, legal review, support tone, meeting notes |
| Executors | Docker, Apple Containers, Firecracker, E2B — isolation behind the `Executor` seam |
| Hooks | Langfuse, OpenTelemetry, Sentry, audit-log shipping |

Search is the deliberate example of something that stays outside: every backend
needs a vendor key and a commercial relationship, so core ships `web.fetch` and
the ecosystem ships `web.search`. The
[MCP bridge](../roadmap/11-mcp.md) is the highest-leverage single entry in this
table — one plugin that mounts any MCP server's tools under kernel policy makes
the ecosystem non-empty on the day it lands.

## Related steps

- [06 — tools: fs, shell, browser, web](../roadmap/06-tool-packs.md)
- [09 — skills](../roadmap/09-skills.md)
- [10 — proactive agents: schedules and outbound messages](../roadmap/10-proactive.md)
- [11 — MCP bridge](../roadmap/11-mcp.md)
- [12 — plugin discovery and distribution](../roadmap/12-plugin-registry.md)
