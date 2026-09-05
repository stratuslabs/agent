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
| `fs.search` | `safe` | Runs unattended. Matches **literal text** (optionally `wholeWord`), never a regular expression — see below. Given a directory it walks it without following symlinks, skipping `.git`, `node_modules`, and files over 1 MB — each skipped file is named in the result's `skipped` list (the first fifty; `skippedTotal` counts them all), never silently passed over; given a file it searches that file and no others, streamed a line at a time, whatever its size — a single line longer than a million characters (Unicode code points, whatever their encoding) is searched in its first million only, and a file that reports no size (a `/proc` file) is searched in its first 1 MB only; the result says so either way. |
| `fs.write` | `gated` | `interactive` asks at the terminal, `remote` asks in Slack, `headless` refuses. Writing where other people read is the thing worth a person's attention. |

## Settings

| Key | Default | What |
| --- | --- | --- |
| `roots` | none | Directories this agent may reach. **No roots means no filesystem** — nothing is readable, rather than everything. |
| `maxBytes` | `64000` | Cap on one `fs.read`, before the `truncated` marker. A call's own `maxBytes` may ask for less, never more. |
| `maxMatches` | `100` | Cap on `fs.search` matches. A call's own `maxMatches` may ask for fewer, never more. |
| `maxEntries` | `500` | Cap on `fs.list` entries. |
| `workspaceRoot` | `~/.stratus/workspaces` | Supplied by the daemon. Where each agent's provenance ledger lives — see below. |

Every key can be set per agent in the `agents` sub-block, over the defaults
above it, and `roots` is why the sub-block exists: a flat list would give
every agent enabling `fs.*` the same roots, which is one agent reading
another's files.

## What a read carries with it

The filesystem is a laundering channel by construction: an agent that reads
a hostile page, writes what it said into its workspace, and reads it back
next week gets a file with no provenance, arriving as its own notes. So
`fs.write` from a session whose trust label is `external` or `unknown`
records the path in a per-agent ledger,
`<workspaceRoot>/<agent>/fs-provenance.json` (owner-only, replaced
atomically) — before the bytes land, so a crash or a ledger that cannot be
written leaves a labelled path with no file rather than a file with no
label — and a later `fs.read`, `fs.search`, or `fs.list` that puts that file's
contents — or its name, which the tainted session chose — in front of the
model labels the call at the recorded level — so
the reading session, and every fact it remembers afterwards, carries it. A
truncating write from a clean session clears the record; an append keeps it.
The ledger is the daemon's record, and `fs.write` refuses to edit it even
inside a root that covers it.

What this does not cover, said plainly: a copy under another name, a file a
different process or a different agent wrote, content pasted through a path
the ledger never saw. It closes the sequence one agent can perform by
itself. Loaded without a `workspaceRoot` — a host wiring the plugin by hand
rather than through the loader — the ledger is process-local, and the
read-back-next-week case survives only as long as the process does. The
labels themselves are documented in
[Memory](../../docs/concepts/memory.md#where-a-fact-came-from).

## `fs.search` takes literal text, not a pattern

A regular expression written by a model is untrusted input compiled into
V8's backtracking engine and run on the process's only thread. `(a+)+$`
against a long line does not return in any time worth waiting for, and while
it runs every session in the daemon is stopped — for a tool classified
`safe`, which means nobody is watching.

There is no timeout to give a running regex and no way to interrupt one from
the thread it is on, so the expressive form is gone rather than bounded.
`wholeWord` covers what it was mostly wanted for. Anything genuinely
regex-shaped is a `grep` away through
[`@stratusagent/tool-shell`](../tool-shell), where a human approves the
command and the executor can kill it.

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
