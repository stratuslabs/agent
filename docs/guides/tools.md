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
| | `browser.act` | `dangerous` — always a human |
| [`@stratusagent/plugin-mcp`](../../packages/plugin-mcp) | `mcp.<server>.<tool>` — any MCP server's tools, [discovered at connect](./mcp.md) | `gated`, whatever the server says; per-tool `toolRisks` overrides |

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
- **`tool-web` and `tool-browser` refuse local addresses.** Both share one
  policy — [`@stratusagent/egress`](../../packages/egress) — `http:`/`https:`
  only, and no loopback, RFC 1918, link-local (`169.254.169.254`), or IPv6
  unique-local — including the IPv4-mapped and NAT64 spellings of the same
  addresses. It is enforced on the connection, so a redirect or a DNS answer
  cannot walk an agent into your metadata endpoint. `allowedHosts` opens a
  specific one when you mean to.
- **`plugin-mcp` mounts somebody else's code.** Each configured MCP server's
  tools register as `mcp.<server>.<tool>`, so `tools: [mcp.linear.*]` grants
  one server, and every bridged tool is `gated` regardless of how the server
  describes itself — the operator's per-tool `toolRisks` entry is the only
  thing that lowers one. A stdio server's environment is replaced the way
  `tool-shell`'s is. See [MCP](./mcp.md).

`GET /api/v1/catalog/tools` lists what a running daemon actually has, and
the dashboard's **Plugins** screen renders it — including a plugin you
enabled that failed to load, which is invisible in a list of tools.

## What runs without asking

Which of these tools run unattended in the daemon — and how a human gets
asked about the rest — is the approval policy's decision, covered in
[Approvals](./approvals.md). For `shell.run`, the permission engine judges
each command individually: [Shell commands](./shell.md).
