# @stratusagent/memory-sqlite

Agent memory on one SQLite file, as a **plugin**. It registers a memory
store named `sqlite` through the plugin seam
([19](../../docs/roadmap/19-registration-seams.md)); a trusted config
selects it for the fleet, and every agent's `memory.remember`,
`memory.recall`, and `memory.forget` — and the memory each turn's prompt is
built from — go through it instead of the built-in file store.

## Install and enable

```bash
npm install @stratusagent/memory-sqlite
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/memory-sqlite": { "enabled": true, "path": "~/.stratus/memory.sqlite" }
  },
  "memoryStore": "sqlite"
}
```

`path` is required: where the database lives is your decision, not one
the plugin guesses inside a directory it does not own. `~` expands as in a
shell. The file and its WAL sidecars are owner-only (`0600`), like the
file store and the session database.

## What it is, and is not

The same [memory contract](../../docs/concepts/memory.md) as the built-in
store — per-agent keying, `search` as whole-token AND matching, newest
first with ties broken by id, bounded reads by count and bytes, tombstones
rather than deletes, an operator audit read, trust re-assertion — on a
different shape: rows in SQLite, no derived index. Every read selects an
agent's live rows and applies the contract's own rules from
`@stratusagent/core`, so this store and the file store cannot disagree
about what a query matches or which entries a bounded read keeps.

It exists to prove that `AgentMemoryStore` holds for a shape that is not
JSONL-plus-FTS5, and it is a real store; it is not a faster one. Selecting
it moves new memories here — nothing is migrated from the file store, and
switching back leaves what was written here where it is.
