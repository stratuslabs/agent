# Memory

Agents remember: facts saved with the built-in `memory.remember` tool
persist to `~/.stratus/memory.jsonl`, keyed to the agent — so the Ava you
talk to tomorrow remembers today, from any directory, in every channel.

Recall is something the agent does, not only something done to it: the
system prompt carries the most recent facts (up to 20, within a byte
budget), and everything older is reachable through `memory.recall`, a
full-text search over the agent's own store — plain words in, matching
facts out, newest first; a query like `C++` or an unmatched quote is a
search, never an error. `memory.forget` retires a fact by id: it stops
reaching prompts and recall, but stays in the file as a tombstone line, so
you can still see what an agent chose to drop. A single fact is capped at
4 KiB — an oversized `memory.remember` is refused outright rather than
stored truncated.

## The file is yours

The JSONL is the record and you may edit it: add a line by hand and it is
recallable; fix a typo and nothing goes stale. Search is served from a
derived FTS index the CLI writes alongside,
`~/.stratus/memory.jsonl.index` — safe to delete at any time, it is rebuilt
from the JSONL on the next recall.

The daemon log never records a fact's contents — a memory write or forget
records the **entry id** it touched, so "when did the agent learn this" has
an answer without the log becoming a second transcript. See
[Logs](../guides/logs.md).

## Souls written before recall existed

One thing to check: a `tools:` allowlist naming exactly `memory.remember`
lets the agent keep saving facts but not search them, and with the prompt
carrying only the recent slice, its older memories are out of reach. Add
`memory.recall` and `memory.forget` — or just `memory.*`. A soul with no
`tools:` list is unaffected; omitted means every registered tool.
