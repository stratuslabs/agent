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

This is the vocabulary [OpenClaw](https://docs.openclaw.ai/tools) and
[Hermes](https://github.com/NousResearch/hermes-agent) settled on, and it is
worth matching rather than inventing: the developers we want have read their
docs already.

**"Tool pack" is retired.** `@stratusagent/tool-fs` is a *plugin* contributing
the `fs` *toolset*.

## What a plugin contributes

Every contribution kind has an interface already. What differs is whether a
plugin can *register* one through the entrypoint, and today most cannot:

| Contributes | Interface | Registers through `setup()` |
| --- | --- | --- |
| tools | `Tool` → `ToolRegistry` | **yes**, `context.tools` |
| hooks | `EventBus.subscribe` | **yes**, `context.bus` |
| skills | `SkillRegistry` | not yet — [09](../roadmap/09-skills.md) |
| providers | `ModelProvider` | **not yet** |
| channels | `ChannelAdapter` | **not yet** |
| memory | `AgentMemoryStore` | **not yet** |
| executors | `Executor` | **not yet** |

The entrypoint is the `Plugin` interface the kernel has had since v1:

```ts
export interface Plugin {
  name: string;
  setup(context: PluginContext): Promise<void> | void;
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
| Skill | kebab-case id | `web-research`, `code-review` |
| First-party package | `@stratusagent/<kind>-<name>` | `tool-fs`, `channel-slack`, `provider-anthropic` |
| Third-party package | `stratus-plugin-<name>` | `stratus-plugin-github` |

The tool shape is already what the repo does (`memory.remember`,
`agent.delegate`, `demo.echo`); writing it down is what makes `tools: [fs.*]`
mean something. Toolset is the noun that glob names.

Two plugins may contribute the same skill id — a `pr-review` from a vendor and
one from your own team. The qualified form is `<package>:<skill>`
(`stratus-plugin-github:pr-review`), following Hermes. The qualifier is the
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
at the first tool call in the middle of somebody's turn. OpenClaw gets this
property from a separate `openclaw.plugin.json`; a field in `package.json` is
the same property with one fewer file to drift.

`contributes.tools[].risk` is a **declaration, not a decision** — see the trust
model.

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

Loading uses the `import.meta.resolve` + dynamic-import pattern of
`loadSlackAdapter` in `packages/cli/src/index.ts`, which is today the repo's
only instance of it. It resolves first and imports second on purpose: a package
that is installed but missing one of *its* dependencies throws
`ERR_MODULE_NOT_FOUND` too, so inspecting the import error cannot tell "not
installed" from "installed and broken" — and silently disabling a channel whose
stored tokens say it should be running is the failure that split buys off.

A plugin loader needs exactly that distinction, so it calls the same pattern
rather than a second copy of it. With more than one consumer, extracting a
shared optional-package loader is the move — and that is the moment to do it,
rather than letting a third caller re-derive the split.

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
  Hermes states the reason exactly right — it "stops third-party code from
  running without your explicit consent."
- **The manifest is validated before the module is imported.** Reading what a
  plugin claims must never require running what it does.
- **A third-party tool may not declare itself `safe`.** `safe` means "run this
  unattended, with nobody watching," and it is not a claim the code being
  judged gets to make about itself. Risk floors at `gated` for tools from
  plugins outside the trusted set; the permission layer resolves the effective
  risk. This is the direction `DEFAULT_TOOL_RISK` and `resolveToolRisk` already
  fail in — a tool that forgot to think about risk is held back, not waved
  through.
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
`executor-local`, `cli`, `provider-anthropic`, `provider-claude-code`,
`channel-slack` — joined by `control-api` and `dashboard` when
[05](../roadmap/05-control-api.md) lands — plus the capability plugins that each
carry a security invariant the kernel's promises rest on:

| Plugin | The invariant it owns |
| --- | --- |
| `tool-fs` | symlink-safe root containment, including the write-through-parent case |
| `tool-shell` | command scoping, control-operator defeat, environment scrubbing |
| `tool-browser` | request-level address validation against SSRF and DNS rebinding |
| `tool-web` | the same address policy, shared with `tool-browser`, not re-derived |

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
