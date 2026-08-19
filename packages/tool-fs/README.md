# @stratusagent/tool-fs

The `fs` toolset: an agent reads, lists, and searches inside directories you
chose, and writes only with the permission engine's blessing.

This is a **plugin** — it contributes a toolset, and nothing loads it unless
your config says so. See [`plugins.md`](../../docs/architecture/plugins.md)
for what that means.

## Install and enable

```bash
npm install @stratusagent/tool-fs
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
    }
  }
}
```

Read from a **trusted** config only — `~/.stratus/config.json`, or a file you
passed with `--config`. A project-local `stratus.config.json` ships in any
repository somebody clones, and cannot decide which code runs in your daemon.

Installing the plugin grants no agent anything. The soul's allowlist is the
second gate, and the per-identity one:

```markdown
---
id: ava
tools: [fs.read, fs.search]     # or fs.* for the whole toolset
---
```

## Risk model

| Tool | Risk | What approval mode does |
| --- | --- | --- |
| `fs.read` | `safe` | Runs unattended. Nothing outside the agent's roots is readable, which is what makes reading safe rather than merely convenient. |
| `fs.list` | `safe` | Runs unattended. Symlinks are listed as symlinks and never followed. |
| `fs.search` | `safe` | Runs unattended. Walks the root without following symlinks; skips `.git` and `node_modules`, and files over 1 MB. |
| `fs.write` | `gated` | `interactive` asks at the terminal, `remote` asks in Slack, `headless` refuses. Writing where other people read is the thing worth a person's attention. |

## Settings

| Key | Default | What |
| --- | --- | --- |
| `roots` | none | Directories this agent may reach. **No roots means no filesystem** — nothing is readable, rather than everything. |
| `maxBytes` | `64000` | Cap on one `fs.read`, before the `truncated` marker. |
| `maxMatches` | `100` | Cap on `fs.search` matches. |
| `maxEntries` | `500` | Cap on `fs.list` entries. |

Every key can be set per agent in the `agents` sub-block, over the defaults
above it, and `roots` is why the sub-block exists: a flat list would give
every agent enabling `fs.*` the same roots, which is one agent reading
another's files.

## The containment rule

Roots are an **access boundary between agents**, so they are resolved on
every call from `session.agent.id` — never read once when the plugin is
constructed. A plugin that closed over its roots at setup would hand every
agent whichever set resolved first.

Containment is decided between **real** paths, not strings:

- The requested path is normalized, then the deepest part of it that exists
  is canonicalized, and *that* must be inside a canonicalized root. A
  lexical check would catch `../../.stratus/credentials.json` and miss a
  symlink inside the root pointing at the same file.
- For a path that does not exist yet, the canonicalized part is its nearest
  existing ancestor — which is what makes writing `root/link/planted.txt`
  through a symlinked `link` a refusal rather than a write into `/etc`.
- Opens use `O_NOFOLLOW`, and a file that existed at check time is compared
  by inode after opening, so a name repointed in between fails instead of
  being followed.

A path inside a root that is not a regular file — a fifo, a socket, a device
— is refused rather than opened. Opening one of those does not fail, it
*blocks*, and a tool call that never returns is worse than one that says no.
The opens carry `O_NONBLOCK` as well, so missing that check would be a
returned error rather than a turn that never ends.

What this does not do is walk the path one directory at a time holding each
open — that needs `openat`, which Node does not expose — so a swap of an
intermediate directory remains possible in principle. The roots you choose
are the boundary; this module is what stops the ordinary escapes from
crossing it.
