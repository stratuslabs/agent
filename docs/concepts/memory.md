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

## Where a fact came from

Every remembered fact carries a **trust label** — one answer to *who wrote
this*, set where tools run and carried from there into the entry:

| Label | Means |
| --- | --- |
| `user` | An authorized principal said it: you at a local terminal, or a Slack sender you named under `principals`. Hand-added lines you re-assert land here too. |
| `agent` | The agent's own work, in a conversation where everything in context was yours or its own. What an ordinary conversation writes. |
| `unknown` | No recorded origin: an entry written before labels existed, a hand-added line, or a fact written in a conversation with someone not configured as a principal. Never read as `agent` — absence of provenance is not evidence of trust. |
| `external` | Written after the session read content from outside — a web page, a search result, a fetched document, an MCP server's reply. It may repeat what a stranger wrote. |

The label is **per session, not per fact**. Once a session has read a page,
everything it remembers afterwards is `external`, because nothing can say
which words of a later fact came from the page. Trust only ever goes down
within a session: reading an `external` or `unknown` entry — injected into
the prompt or found with `memory.recall` — lowers the session too, so a
fresh session cannot launder an old entry by restating it. The same holds
across a delegation in both directions, across a daemon restart (the label
lives on the stored session), and across the filesystem: a file an agent
wrote while tainted is recorded in a per-agent ledger, and reading it back
next week carries the label with it.

**Rendering keeps the regions apart.** Facts reach the prompt grouped by
label, each region introduced by a line saying what it is, so a stranger's
sentence never renders under the heading for the agent's own conclusions.
`memory.recall` returns each hit's label, and `memory.remember` reports the
label it wrote.

Each entry also carries an `origin` — the session it was written in, and
what tainted that session when something did (a tool name, or `memory`,
`sender`, `legacy`). It describes; it never decides.

### The label is yours to raise, and only yours

Nothing raises a label except a person. After an upgrade every existing
entry reads `unknown`, and because the injected slice of such a store makes
every new session `unknown` on its first turn, the whole corpus would stay
that way forever if only new writes carried the field. So:

```bash
stratus memory list ava                            # every live entry, with its label
stratus memory list ava --trust unknown            # the ones with no recorded origin
stratus memory reassert ava --trust user --all-unknown
stratus memory reassert ava --trust agent ava:memory:… ava:memory:…
```

Re-asserting appends a record to the JSONL — the file is never rewritten —
and a running daemon reads it on its next turn. No tool can do this: an
agent re-labelling its own memory as trusted would be the attack writing its
own permission slip.

Some sessions never end — a Slack DM is one resumable conversation for the
life of the install — and a session from before labels existed reads
`unknown` for as long as it lasts, whatever you re-assert. The remedy is a
session boundary, not a raised label: `stratus session rollover <id>`
archives the transcript so far and starts the same id over. The fresh
session is still `unknown` on its first turn if the entries it injects are,
which is correct, and what `stratus memory list` is for.
