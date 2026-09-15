# Memory

Agents remember: facts saved with the built-in `memory.remember` tool
persist to `~/.stratus/memory.jsonl`, keyed to the agent — so the Ava you
talk to tomorrow remembers today, from any directory, in every channel.

Recall is something the agent does, not only something done to it. Every
request carries three bounded blocks — the facts the agent **pinned**, an
index of what it knows **about**, and a short tail of what it learned most
recently — and everything else is reachable through `memory.recall`, a
full-text search over the agent's own store: plain words in, matching facts
out, newest first; a query like `C++` or an unmatched quote is a search,
never an error. `memory.forget` retires a fact by id: it stops reaching
prompts and recall, but stays in the file as a tombstone line, so you can
still see what an agent chose to drop. A single fact is capped at 4 KiB —
an oversized `memory.remember` is refused outright rather than stored
truncated.

## What a remembered fact carries

A fact is more than its text. Beyond the four fields every line must have —
`id`, `agentId`, `content`, `createdAt` — the agent may record:

| Field | Means |
| --- | --- |
| `kind` | `semantic` (about the world), `episodic` (something that happened), `procedural` (how something is done), or `preference`. These have different useful lifetimes, and one flat bucket is how a store goes noisy. |
| `about` | The entities the fact concerns — people, systems, projects. This is what the prompt's topic index is built from, and it **participates in search**: a fact reading "it now runs on Postgres" with `about: ["deploy pipeline"]` is found by a search for the pipeline. |
| `validFrom`, `validUntil` | When the fact starts and stops being true. A different axis from `createdAt`, which is when it was written — conflating the two is why assistants confidently report where someone used to work. |
| `supersedes` | The id of a fact this one replaces. |

Every one of them is optional and additive. A line carrying only the four
required fields still loads, is still recallable, and still reaches the
prompt — see [The file is yours](#the-file-is-yours).

Two caps, and both refuse rather than truncate: a fact is at most 4 KiB,
and it may name at most twelve entities in 512 bytes. A fact about a dozen
things is usually a fact that has not been written down properly yet.

### Facts that stop being true

An entry outside its validity window **leaves what is true now and stays
findable**. It is dropped from the pinned core, the topic index, and the
recency tail; `memory.recall` still returns it, marked `expired` or
`not-yet-valid`, and so does `stratus memory list`. One rule, both bounds:
a fact that is not true *yet* must not reach the prompt either, or it is
presented as true now.

Being outside the window is not deletion. The entry is in the file, in
search, and in `stratus memory audit`; it is just not what is true now,
which is the only claim the injected slice makes.

### Facts the agent stopped believing

`memory.remember` takes a `supersedes` id, and that field *is* the
retirement — one appended line, not a tombstone plus a replacement, because
the file's only atomicity is one append and stopping between two of them
would lose a fact. A superseded entry leaves `list`, `search`, and the
prompt exactly as a forgotten one does, and stays visible in
`stratus memory audit` beside the entry that replaced it, which is strictly
more than a delete would leave behind.

The retirement is scoped to the **successor's** validity window. A revision
dated from next Monday leaves the old fact standing until then, and a
revision that has already expired displaces nothing — otherwise recording a
change you know is coming would make the agent forget something it still
believes and gain nothing for it.

Two revisions of the same fact both retire it and both stay live. The
invariant is the retirement, not a unique replacement: each is a fact the
agent wrote, and two live successors that disagree are a contradiction in
content rather than a storage race.

### Pinned facts

Some things an agent should still know after a year with no search at all:
who its operator is, where to escalate, how the team works.
`memory.pin` — and `stratus memory pin <agent> <id>...` — keeps a fact in
the prompt every turn.

The pinned core is capped at **2 KiB of content** and **refuses rather than
evicting**: a pinned set that silently dropped its oldest member would be a
pin that did not mean anything. Unpin something first. Pinning is a record
appended to the file, never a field written onto the entry, so the entry's
own line stays byte-identical — which is what keeps the append-only
concurrency model and the hand-edit promise intact.

### What the agent knows about

The second block is not facts but **topics**: the `about` keys across
everything true now, each with a count and when it last changed. Roughly a
thousand tokens tells the agent the shape of its own store, which is what
turns `memory.recall` from a guess at query terms into a targeted read — an
agent that does not know what it knows cannot know to ask.

### How often a fact gets read

`stratus memory search --format json` reports a `usage` count for each hit.
These counters live in the derived index, never in the record, because they
are observations about *reading* rather than facts the agent learned. The
consequence is exact: **deleting the index loses your usage statistics,
never your memories.** Nothing is ever deleted on them.

## Where remembered facts travel in a request

Facts reach the model as operator-authored context, never as something a
conversation could forge. Against the Anthropic API they ride at the **tail**
of the request as a system message rather than inside the system prompt;
everywhere else they sit in the system prompt as they always have.

All three blocks travel together, as **one** memory section. That is a
requirement rather than a layout choice: the Anthropic placement finds the
volatile section by kind, so siblings sharing that kind would move one to
the tail and drop the rest of the request on the floor.

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

Four kinds of line live in it: entries, the tombstones `forget` appends,
the re-assertions below, and pins. Everything that *changes* an entry is a
record naming it, never a rewrite of its line — which is what lets two
processes write the same file with nothing but `O_APPEND` between them, and
what keeps a line you edited by hand yours.

The daemon log never records a fact's contents — a memory write, forget,
supersession, or pin records the **entry id** it touched, so "when did the
agent learn this" has an answer without the log becoming a second
transcript. See [Logs](../guides/logs.md).

## Souls written before recall existed

One thing to check: a `tools:` allowlist naming exactly `memory.remember`
lets the agent keep saving facts but not search them, and with the prompt
carrying only the pinned core, the topic index, and a short tail, its older
memories are out of reach. Add `memory.recall`, `memory.forget`, and
`memory.pin` — or just `memory.*`. A soul with no `tools:` list is
unaffected; omitted means every registered tool.

## Where a fact came from

Every remembered fact carries a **trust label** — one answer to *who wrote
this*, set where tools run and carried from there into the entry:

| Label | Means |
| --- | --- |
| `user` | An authorized principal said it: you at a local terminal, or a Slack sender you named under `principals`. Hand-added lines you re-assert land here too. |
| `agent` | The agent's own work, in a conversation where everything in context was yours or its own. What an ordinary conversation writes. |
| `unknown` | No recorded origin: an entry written before labels existed, a hand-added line, a fact written in a conversation with someone not configured as a principal, or one written after a `shell.run` — whose stdout could be `git status` or `curl`, and nothing can say which. Never read as `agent` — absence of provenance is not evidence of trust. |
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
Every entry renders on one line, control characters and Unicode bidi
controls spelled out (`\n`, `\u001b`, `\u202e`), so a fact holding a
newline and a copy of a heading cannot open a forged trusted region inside
the one it was filed under.
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

`--all-unknown` re-labels only entries with **no recorded origin** — the
upgrade corpus. An entry *recorded* as `unknown` — written after a message
from someone not configured as a principal, or after a shell command — may
repeat what a stranger said, so the bulk command leaves it alone and
`stratus memory list` points it out; re-assert one by id once you have read
it. The text listing spells control characters out (`\n`, `\u001b`), so an
entry cannot forge a neighbour's header or repaint the screen you are
deciding from; `--format json` carries the content as stored. Re-asserting appends a record to the JSONL — the file is never
rewritten — and a running daemon reads it on its next turn. No tool can do this: an
agent re-labelling its own memory as trusted would be the attack writing its
own permission slip.

Some sessions never end — a Slack DM is one resumable conversation for the
life of the install — and a session from before labels existed reads
`unknown` for as long as it lasts, whatever you re-assert. The remedy is a
session boundary, not a raised label: `stratus session rollover <id>`
archives the transcript so far and starts the same id over. The fresh
session is still `unknown` on its first turn if the entries it injects are,
which is correct, and what `stratus memory list` is for.

## Moving an agent's memory

```bash
stratus memory export ava --file ava-memory.jsonl   # everything Ava still holds
stratus memory import ava --file ava-memory.jsonl   # on the other machine
```

Export writes the entries the agent still holds, oldest first — superseded
ones included, because the successor carries its own retirement and the
revision travels with it. Forgotten entries stay behind: a tombstone is a
record, and a file of entries has nowhere to put one, so exporting them
would resurrect facts the agent dropped.

**An imported entry lands `external`.** Import is the laundering problem
with a human in the middle: a file from elsewhere may repeat what a stranger
wrote, and nothing in the file can say otherwise. So a round trip preserves
entries and order, deliberately not labels. When the file is one you own —
moving an agent to a new machine — `--preserve-trust` keeps each recorded
label, because a person vouching for it is exactly what the default is
waiting for.

## Searching it yourself

```bash
stratus memory search ava deploy pipeline    # the way the agent searches
stratus memory audit ava                     # everything ever written, and what replaced what
stratus memory pin ava ava:memory:…          # and stratus memory unpin
stratus memory forget ava ava:memory:…
```

`search` matches the way `memory.recall` does — every word has to appear in
a fact, or in what the fact is about — and marks anything outside its
validity window. `--format json` carries the content as stored, along with
each entry's `kind`, `about`, validity, and recall count.

Every read reports the **ordering** it applied. Today that is always
`recency`, which is the one ordering the contract requires of every store;
a store backed by embeddings can serve `relevance` or `hybrid` instead, and
one asked for an ordering it does not implement serves `recency` and says
so rather than failing.
