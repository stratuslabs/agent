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
`fs.*` never matches `fsx.read`. Listing nothing grants every registered
tool, which is fine for a private agent and is not what you want once a
shell is installed.

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
- **What a tool reads from outside is labelled, and the label travels.**
  `web.fetch`, `web.search`, the four `browser.*` tools, and every bridged
  MCP tool declare their output `external`; `shell.run` declares `unknown`,
  since `git status` and `curl` come back through the same stdout; `fs.read`
  labels a file the agent wrote while its session was tainted, from a
  per-agent ledger under `~/.stratus/workspaces/<agent>/`. The session that read any of it only
  ever gets less trusted, and every fact it remembers carries the label.
  A third-party plugin whose output comes from outside declares
  `outputTrust: 'external'` on the tool, or marks a single call through
  the execution context — see [`plugins.md`](../architecture/plugins.md).
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
The tool also declares its output `external`, the same label `web.fetch`,
the browser, and every MCP-bridged tool carry, so the session that read a
result stays labelled and every fact it remembers afterwards says where it
came from ([Memory](../concepts/memory.md#where-a-fact-came-from)). That
marking is not a defence against prompt injection; it is a label.

## What runs without asking

Which of these tools run unattended in the daemon — and how a human gets
asked about the rest — is the approval policy's decision, covered in
[Approvals](./approvals.md). For `shell.run`, the permission engine judges
each command individually: [Shell commands](./shell.md).
