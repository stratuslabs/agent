# Memory

Agents remember: facts saved with the built-in `memory.remember` tool
persist to `~/.stratus/memory.jsonl`, keyed to the agent — so the Ava you
talk to tomorrow remembers today, from any directory, in every channel.

Recall is something the agent does, not only something done to it: every
request carries the most recent facts (up to 20, within a byte
budget), and everything older is reachable through `memory.recall`, a
full-text search over the agent's own store — plain words in, matching
facts out, newest first; a query like `C++` or an unmatched quote is a
search, never an error. `memory.forget` retires a fact by id: it stops
reaching prompts and recall, but stays in the file as a tombstone line, so
you can still see what an agent chose to drop. A single fact is capped at
4 KiB — an oversized `memory.remember` is refused outright rather than
stored truncated.

## Where remembered facts travel in a request

Facts reach the model as operator-authored context, never as something a
conversation could forge. Against the Anthropic API they ride at the **tail**
of the request as a system message rather than inside the system prompt;
everywhere else they sit in the system prompt as they always have.

The reason is cost. Prompt caching is a prefix match, so anything that changes
invalidates everything after it — and memory is the one part of what an agent
is told that changes, rewritten the moment it remembers anything. Held in the
system prompt, a single new fact would re-charge full input price for the
persona, the skills list, and the tool definitions behind it, on every turn
for the rest of the conversation. At the tail it invalidates nothing.

What does **not** change is the trust boundary. Remembered text is written by
the agent and can contain whatever a tool read off the network, so it stays on
the operator channel — a `system` message — and never becomes part of a user
turn, where anything that writes to the agent's input could forge it.

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
