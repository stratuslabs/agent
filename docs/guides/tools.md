# Tools

Out of the box an agent can echo, remember, recall and forget its own
memories, and delegate. Everything else — files, a shell, the web, a
browser — arrives as a **plugin**: one package you install, list, and
enable.

```bash
npm install -g @stratusagent/tool-fs @stratusagent/tool-shell \
                @stratusagent/tool-web @stratusagent/tool-browser
```

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "@stratusagent/tool-fs": {
      "enabled": true,
      "roots": ["~/notes"],
      "agents": {
        "ava":  { "roots": ["~/work/ava"] },
        "juno": { "roots": ["~/work/juno", "~/shared"] }
      }
    },
    "@stratusagent/tool-web": { "enabled": true },
    "@stratusagent/tool-shell": { "enabled": true, "cwd": "~/work" }
  }
}
```

Keyed by **package name**, because a plugin's identity is its package and one
may contribute more than tools. Per-agent settings go in an `agents`
sub-block over the defaults above them — the same shape
[`approvals`](./approvals.md) already uses, and it matters more here: for
`tool-fs` those values are an access boundary between agents rather than a
preference.

**Only a config you chose may list plugins** — `--config`, `STRATUS_CONFIG`,
or the global `~/.stratus/config.json`. A plugin runs in the daemon's own
process, so this list is a list of code, and an auto-discovered
project-local `stratus.config.json` ships with any repository you clone. Its
`plugins` block is ignored, with a warning naming the file, exactly as `api`
and `approvals` are. The reasoning lives in
[the plugin trust model](../concepts/plugins.md).

`stratus run` and `stratus chat` load the same plugins from the same config,
so a tool that works locally works in the daemon, and one that is missing is
missing in both.

## Installing a plugin grants no agent anything

The soul's allowlist is the second gate, and the per-identity one:

```markdown
---
id: ava
tools: [fs.read, fs.search, web.fetch]
---
```

`fs.*` grants a whole toolset, so an agent given "the filesystem" does not
need editing every time the pack gains a tool. The prefix keeps its dot:
`fs.*` never matches `fsx.read`. Omitting the key grants every registered
tool, which is fine for a private agent and is not what you want once a
shell is installed.

**Omitting `tools:` and writing `tools: []` are opposites.** No key grants
everything; an empty list grants nothing. A bare `tools:` with nothing
indented under it is the empty list — the shape you get by writing the key
and not filling it, or by deleting the last entry — so that one is warned
about too:

```
agent blair has an empty tools: list, which grants nothing — remove the key to allow every registered tool, or list the ones it should have
```

**An entry naming a tool nothing provides is inert, and says so.** A `fs.*`
whose plugin is not installed, or a name with a typo in it, grants nothing —
it cannot, since the allowlist only ever narrows what is registered. Both
`stratus serve` (at roster load) and a local `stratus run` warn about the
entries in an agent's list that select no registered tool:

```
agent ava lists tools nothing registered provides: fs.* — check the names, or install the plugin that provides them
```

If *every* entry is like that, a second line says so, because the
consequence is bigger than a dead line in a file:

```
agent blair has an allowlist that grants nothing, so none of the tools its persona talks about are there to call
```

A model told to use a tool it has not been given tends to write the call out
as prose, often with a plausible-looking result attached. It reads like the
thing happened. Nothing ran.

**`skill.read` is not one of the tools this key grants.** It rides on the
`skills:` gate — an agent with a skill enabled has the reader whether or not
`tools:` mentions it, and an agent with no skills does not have it however
permissive `tools:` is. So listing it here does nothing, and gets its own
line saying which key does grant it:

```
agent blair lists skill.read under tools:, which grants nothing — skill.read is granted by the skills: key instead
```

That is also why `tools: [skill.read]` counts as an allowlist that grants
nothing: the reader loads a skill's instructions, and the tools those
instructions call for are still not there.

**A daemon tool named in a local run is a right name in the wrong
process.** `schedule.*`, `message.send`, and `agent.delegate` need the
dispatcher, the store, and the channels, so only `stratus serve` registers
them. A soul that uses them is correct; `stratus run` just cannot call it,
and says which it is rather than sending you after a plugin:

```
agent ava lists schedule.*, message.send, which only the daemon provides — the names are right, but stratus run cannot call them; stratus serve can
```

A namespace a plugin discovers into is never reported this way. An MCP
server that is unreachable when the daemon starts registers nothing and
reconnects on its own, so `mcp.linear.*` is a tool that has not arrived
yet rather than a name that does not exist — the check reads the
`toolsDiscovered` namespaces a loaded plugin declared, and leaves those
entries alone.

## What is available

| Package | Tools | Risk |
| --- | --- | --- |
| [`@stratusagent/tool-fs`](../../packages/tool-fs) | `fs.read`, `fs.list`, `fs.search` | `safe` inside the agent's roots |
| | `fs.write` | `gated` |
| [`@stratusagent/tool-shell`](../../packages/tool-shell) | `shell.run` | `gated`, then [judged per command](./shell.md) |
| [`@stratusagent/tool-web`](../../packages/tool-web) | `web.fetch` | `gated` |
| [`@stratusagent/tool-browser`](../../packages/tool-browser) | `browser.goto`, `.read`, `.screenshot` | `gated` |
| | `browser.act` | `gated`, then [judged per site](./browser.md) |
| [`@stratusagent/plugin-mcp`](../../packages/plugin-mcp) | `mcp.<server>.<tool>` — any MCP server's tools, [discovered at connect](./mcp.md) | `gated`, whatever the server says; per-tool `toolRisks` overrides |
| a search backend plugin, [against the `web.search` contract](../../packages/search) | `web.search` | `gated` — the third-party floor, whatever the backend's manifest says |

Each package's README carries its own settings and the reasoning behind its
risk levels. Four things are worth knowing here:

- **`tool-fs` roots are a boundary, not a preference.** No roots means no
  filesystem — nothing is readable, rather than everything. Containment is
  decided between real paths, so a symlink inside a root pointing at
  `~/.stratus/credentials.json` is refused, and so is a write *through* a
  symlinked directory.
- **`tool-shell` replaces the environment.** The command gets exactly what
  you granted (`passEnv`, `env`) and nothing else — the daemon's own
  environment, where `ANTHROPIC_API_KEY` lives, is not there to read.
- **`browser.act` is judged by the site it acts on.** A CSS selector
  describes nothing — `#submit` is equally "load more results" and "confirm
  purchase" — so the scope is the origin of the page the conversation is
  already on, never anything the call claims about itself. That is what lets
  an installed service click at all; it used to be `dangerous`, which meant
  a human every time and a refusal in `headless`. See
  [Browser actions](./browser.md).
- **`tool-web` and `tool-browser` refuse local addresses.** Both share one
  policy — [`@stratusagent/egress`](../../packages/egress) — `http:`/`https:`
  only, and no loopback, RFC 1918, link-local (`169.254.169.254`), or IPv6
  unique-local — including the IPv4-mapped and NAT64 spellings of the same
  addresses. It is enforced on the connection, so a redirect or a DNS answer
  cannot walk an agent into your metadata endpoint. `allowedHosts` opens a
  specific one when you mean to.
- **`web.search` is a contract, not a package you install from us.** Every
  search backend needs a vendor key and a commercial relationship, so core
  ships `web.fetch` and the ecosystem ships `web.search`. What is
  first-party is the *shape* — one tool name, one meaning per option, one
  result envelope — so swapping vendors changes no soul and no skill. See
  [Searching the web](#searching-the-web) below.
- **`plugin-mcp` mounts somebody else's code.** Each configured MCP server's
  tools register as `mcp.<server>.<tool>`, so `tools: [mcp.linear.*]` grants
  one server, and every bridged tool is `gated` regardless of how the server
  describes itself — the operator's per-tool `toolRisks` entry is the only
  thing that lowers one. A stdio server's environment is replaced the way
  `tool-shell`'s is. See [MCP](./mcp.md).

`GET /api/v1/catalog/tools` lists what a running daemon actually has, and
the dashboard's **Plugins** screen renders it — including a plugin you
enabled that failed to load, which is invisible in a list of tools.

## Searching the web

An agent that can fetch a URL but cannot find one is not a smaller
capability — it is one that invites the model to guess a plausible domain.
`web.search` closes that, and it arrives as a backend plugin somebody else
publishes:

```bash
npm install -g stratus-plugin-somesearch
printf %s "$SEARCH_KEY" | stratus credential set search.apiKey
```

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "stratus-plugin-somesearch": { "enabled": true, "maxSearchesPerDay": 200 }
  }
}
```

```markdown
---
id: ava
tools: [web.fetch, web.search]
credentials: [search.apiKey]
---
```

Three things are worth knowing, and the
[contract package](../../packages/search) is canonical for the rest:

- **The credential name is `search.apiKey` whatever the vendor is.** That is
  what makes a swap free: a backend asking for `BRAVE_API_KEY` would mean
  changing vendors edits every soul in the fleet. Store it with
  `stratus credential set` — never as a literal in a config file people
  commit. A self-hosted backend that needs no key at all is legitimate and
  asks for nothing.
- **`credentials:` is a second, separate gate.** `tools: [web.*]` picks up
  search with no soul edit, but without `credentials: [search.apiKey]` every
  call answers "not allowed to access credential".
- **A metered API costs money, and that is a budget rather than a
  permission.** `maxSearchesPerDay` caps one agent's calls in a UTC day
  (default 200) instead of asking a human to approve each query. It lives in
  the daemon's process, so a restart forgives the count.

Two search backends cannot be enabled at once: both contribute `web.search`,
a tool name is unique per install, and that is a load-time error naming both.

Search results are **third-party text** — titles and snippets written by
whoever owns the page and selected by a ranker — and the envelope says so.
That marking is not a defence against prompt injection; it is a label.

## What runs without asking

Which of these tools run unattended in the daemon — and how a human gets
asked about the rest — is the approval policy's decision, covered in
[Approvals](./approvals.md). For `shell.run`, the permission engine judges
each command individually: [Shell commands](./shell.md).
