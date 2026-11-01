# Memory

Agents remember: facts saved with the built-in `memory.remember` tool
persist to `~/.stratus/agents/<id>/memory.jsonl` — one file per agent, in
that agent's own [state directory](../reference/state-layout.md) — so the
Blair you talk to tomorrow remembers today, from any directory, in every
channel, and no read of theirs can reach anybody else's facts.

Recall is something the agent does, not only something done to it. Every
request carries three bounded blocks — the facts the agent **pinned**, an
index of what it knows **about**, and a short tail of what it learned most
recently. Each pinned and recent fact starts with the UTC minute it was
recorded (`- (2026-10-21 13:33Z) …`), so a fact from last week doesn't
read like one from this turn.
Everything else is reachable through `memory.recall`, a
full-text search over the agent's own store: plain words in, best matches
out first; a query like `C++` or an unmatched quote is a search, never an
error. `memory.forget` retires a fact by id: it stops reaching
prompts and recall, but stays in the file as a tombstone line, so you can
still see what an agent chose to drop. A single fact is capped at 4 KiB —
an oversized `memory.remember` is refused outright rather than stored
truncated.

## What a remembered fact carries

A fact is more than its text. Beyond the four fields every line must have —
`id`, `agentId`, `content`, `createdAt` — the agent may record:

| Field | Means |
| --- | --- |
| `kind` | `semantic` (about the world), `episodic` (something that happened), `procedural` (how something is done), or `preference`. These have different useful lifetimes, and one flat bucket is how a store goes noisy. An `episodic` fact with no `validUntil` expires after 14 days; see [Task notes expire by default](#task-notes-expire-by-default). |
| `about` | The entities the fact concerns — people, systems, projects. This is what the prompt's topic index is built from, and it **participates in search**: a fact reading "it now runs on Postgres" with `about: ["deploy pipeline"]` is found by a search for the pipeline. |
| `validFrom`, `validUntil` | When the fact starts and stops being true. A different axis from `createdAt`, which is when it was written — conflating the two is why assistants confidently report where someone used to work. ISO-8601; a date alone is UTC midnight, and a *time* must carry `Z` or an offset, or the same bound would mean a different instant on every machine. A day that does not exist is refused rather than rolled forward — `2026-02-30` would otherwise be stored as March 2nd, moving the bound two days with nothing on record to say so. |
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

### Task notes expire by default

Most of what a working agent remembers is short-lived: a PR's head, a
loop's status, where a task got to. Without an end date those notes read as
current forever. So an `episodic` fact with no `validUntil` of its own
leaves what is true now **14 days** after it was written, or after its
`validFrom` if that is later. From then on it behaves exactly like a fact
whose window closed: out of the topic index and the recency tail, still
returned by `memory.recall` and `stratus memory list`, marked `expired`.

Nothing in the file changes. The default is read off `kind` and
`createdAt`, so notes written before it existed expire the same way, and a
note given a `validUntil` keeps that date instead, longer or shorter. Facts
of every other kind, and lines with no `kind`, have no default.

Two things do not follow from a note going stale. A **pinned** note stays
in the pinned core, because pinning is how an agent says a note is still
current. And a note that **superseded** a fact keeps that fact retired: a
stale note is not evidence that the belief it replaced is true again.

The built-in stores apply the default. For a store plugin, core exports it
as `effectiveMemoryValidityAt`. `memoryValidityAt` and
`isMemoryEntryCurrent` keep reading only the record's own window, so a
store plugin written before the default (`memory-sqlite` 0.14.0, for one)
keeps its pins and keeps listing old notes until it adopts it.

### Facts the agent stopped believing

`memory.remember` takes a `supersedes` id, and that field *is* the
retirement — one appended line, not a tombstone plus a replacement, because
the file's only atomicity is one append and stopping between two of them
would lose a fact. A superseded entry leaves `list`, `search`, and the
prompt exactly as a forgotten one does, and stays visible in
`stratus memory audit` beside the entry that replaced it, which is strictly
more than a delete would leave behind.

The retirement is scoped to the **successor's** own validity window (its
`validFrom` and `validUntil`, not the episodic default). A revision
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
pin that did not mean anything. Unpin something first.

The budget is a **prefix** of the pins in the order they were made, so one
pin that overruns the cap makes every pin recorded after it inert too,
whatever its size. Two daemons pinning at once can produce that: each reads
a total that does not yet include the other's write, and both append. The
replay resolves it the same way in every store rather than evicting either
one — and a later pin then refuses **naming the pin that is blocking it**,
because the effective set is under the cap in that state and unpinning from
*it* would free nothing.

The budget is allocated over the record, not over what is true today. A
pinned fact that is superseded, or outside its validity window, keeps its
place and simply stops rendering — otherwise a later pin would be accepted
into space that comes back. `stratus memory list` marks it `[pinned]`
alongside `[expired]` or `[not-yet-valid]`, because it is the entry to
unpin when a pin refuses and the arithmetic looks wrong. Pinning is a record
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
never your memories** — and an upgrade that changes how they are keyed
drops them for the same reason, since a count attributed to the wrong agent
is worse than no count. Nothing is ever deleted on them.

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
`memory.jsonl.index` — safe to delete at any time, it is rebuilt from the
JSONL on the next recall.

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

**An agent that works through MCP remembers as `external` by default.** A
server's reply is outside content unless you say otherwise, so one call to
it lowers the rest of the session, and every fact remembered afterwards
carries that label. For a server you run whose replies are only your own or
the agent's data, set `"outputTrust": "agent"` on its entry (see the
[MCP guide](../guides/mcp.md)); its replies then count as the agent's own
work. A server that passes on text other people wrote, such as an issue
tracker with outside reporters, should stay `external` or be set to
`"unknown"`: vouching for it would file their words as the agent's. Setting
the label does not relabel entries written before; re-assert those by id
after reading them (below), and roll a long-lived session over if it is
already tainted.

Each entry also carries an `origin` — the session it was written in, and
what tainted that session when something did (a tool name, or `memory`,
`sender`, `legacy`). It describes; it never decides.

### The label is yours to raise, and only yours

Nothing raises a label except a person. After an upgrade every existing
entry reads `unknown`, and because the injected slice of such a store makes
every new session `unknown` on its first turn, the whole corpus would stay
that way forever if only new writes carried the field. So:

```bash
stratus memory list blair                          # every live entry, with its label
stratus memory list blair --trust unknown          # the ones with no recorded origin
stratus memory reassert blair --trust user --all-unknown
stratus memory reassert blair --trust agent blair:memory:… blair:memory:…
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

Some sessions never end — a Slack DM's top level is one resumable
conversation for the life of the install — and a session from before labels existed reads
`unknown` for as long as it lasts, whatever you re-assert. The remedy is a
session boundary, not a raised label: `stratus session rollover <id>`
archives the transcript so far and starts the same id over. The fresh
session is still `unknown` on its first turn if the entries it injects are,
which is correct, and what `stratus memory list` is for.

## Memory passes

A memory pass is a short model run, as the agent, that reads the newest
messages of one conversation and saves the lasting facts in them, so a
preference stated in passing is still there next week. Nothing in core
decides when to run one. An operator-installed plugin asks for passes
through `PluginContext.memoryPasses`: `start(agentId, mode)`, called from
the plugin's `setup`, turns upkeep on for an agent until the daemon stops,
and `run(request)` runs one pass and resolves with how it ended. A pass
asked for before the daemon has loaded its agents is skipped as
`not-started`. No tool starts a pass, so neither the agent
nor a chat message can. With no plugin asking, nothing runs and nothing
changes. Only the daemon offers it: under `stratus run` a plugin gets no
`memoryPasses`.

What a pass may do is enforced by the runtime, not left to the prompt:

- Its only tools are `memory.recall` and a narrowed `memory.remember`. It
  saves at most 5 facts in at most 4 model calls, and only `semantic`,
  `procedural`, or `preference` facts, never `episodic` task notes.
- It may replace (`supersedes`) only a fact it recalled in that same pass,
  and never a pinned fact or one labeled `user`.
- It runs on exactly the model the request names, or the agent's own, with
  no fallback.
- It writes at the conversation's trust label, so a conversation that read
  a web page writes `external`, and every fact it writes carries
  `metadata.memoryPass` (`{ id, kind }`) and the conversation's session id.

Which messages it reads:

- Only conversations of the kinds the request lists, `public` when it lists
  none, so a DM is read only when the plugin's config says so. A session
  with no channel (your CLI or control API) always counts, and a channel
  that reports no kind never does.
- Never a sub-agent's session, and a schedule firing or event trigger's
  session only when the request sets `scheduled: true`.
- Only messages written while upkeep was on, and only ones no earlier pass
  took. A pass reads about 32 KB at a time, oldest first. A message alone
  over that goes in cut to fit, and the ledger records the cut.
- Never a conversation with a turn running. That pass is `skipped`
  (`turn-running`) and the plugin asks again later.

In `shadow` mode a pass runs the same way but writes what it would have
saved to `agents/<id>/memory-shadow.jsonl`, and no real fact changes. Tidy
passes, which merge duplicate facts, are not built yet: a tidy request comes
back `skipped` (`tidy-unsupported`).

### The ledger

Each pass that read something is recorded in
`~/.stratus/agents/<id>/memory-passes.jsonl`, append-only like
`memory.jsonl`: when upkeep started and stopped, which messages each pass
took, and how it ended. Ids, times, and counts, never content. That is also
where each conversation's place is kept, so a pass never competes with a
turn saving its session. A pass that fails before writing anything gives
its messages back for the next pass. One that wrote something keeps them,
so nothing is saved twice. A daemon stop aborts running passes at once
instead of holding the drain, and a pass a crash cut off is settled the
same way at the next start.

### Seeing and undoing what passes did

```bash
stratus memory passes blair            # newest first: status, reason, counts, what it read
stratus memory list blair --pass <id>  # what one pass wrote, forgotten entries included
stratus memory undo-pass blair <id>    # forget everything that pass wrote
```

`passes` shows each pass's kind, mode, status and reason (`failed
(model)`, `failed (budget)`), how many facts it saved and replaced, and
which messages it read, with any message cut to fit. `open` means a pass is
running, or a crash cut it off and the next start will settle it.
`list --pass` on a shadow pass shows what it would have saved.

`undo-pass` forgets every live entry carrying the pass id. A forget is
append-only, so the entries stay in the record, and whatever they replaced
is live again. A shadow pass wrote nothing to memory, so there is nothing
to undo. Like the rest of `stratus memory`, these read the built-in store
only.

The control API has the same two reads for a dashboard or script:
`GET /api/v1/agents/:id/memory/passes`, and
`GET /api/v1/agents/:id/memory/passes/:passId` for one pass and what it
wrote, from whichever store the daemon writes to. The bus gets
`memory.pass-completed` for every pass, with its status and counts and no
content.

## Moving an agent's memory

```bash
stratus memory export blair --file blair-memory.jsonl  # everything Blair still holds
stratus memory import blair --file blair-memory.jsonl  # on the other machine
```

The exported file is owner-only (`0600`), and an existing path is tightened
before the corpus lands in it.

Export writes the entries the agent still holds, oldest first — superseded
ones included, because the successor carries its own retirement and the
revision travels with it. Forgotten entries stay behind: a tombstone is a
record, and a file of entries has nowhere to put one, so exporting them
would resurrect facts the agent dropped.

**Export refuses when one entry id is held twice.** The built-in `stratus`
agent inherits the memories older builds wrote under `demo-agent`,
`anthropic-agent`, and `openai-agent`, and a hand edit — or one corpus
imported for both — can put the same id under its own id and under an
inherited one. Every read shows the current copy and hides the inherited
one; import keeps the first copy of an id it sees and skips the rest. Since
the inherited copy is usually the older of the two, writing both would
migrate the copy that was hidden and drop the one you have been reading. So
export stops and names the ids: `stratus memory audit <agent>` shows both,
and forgetting the copy you do not want makes the export unambiguous.

**An imported entry lands `external`.** Import is the laundering problem
with a human in the middle: a file from elsewhere may repeat what a stranger
wrote, and nothing in the file can say otherwise. So a round trip preserves
entries and order, deliberately not labels. When the file is one you own —
moving an agent to a new machine — `--preserve-trust` keeps each recorded
label, because a person vouching for it is exactly what the default is
waiting for.

## Searching it yourself

```bash
stratus memory search blair deploy pipeline  # the way the agent searches
stratus memory audit blair                   # everything ever written, and what replaced what
stratus memory pin blair blair:memory:…      # and stratus memory unpin
stratus memory forget blair blair:memory:…
```

Every one of these works the **built-in file store** directly, with no
daemon in the way. If a trusted config selects a contributed store with
`memoryStore`, the fleet's memories live somewhere else and `stratus
memory` refuses rather than answering from a JSONL nothing reads — see
[Extending](../guides/extending.md#memory-stores).

`search` matches the way `memory.recall` does — a word can match a fact or
what the fact is about — and marks anything outside its validity window.
`--format json` carries the content as stored, along with each entry's
`kind`, `about`, validity, and recall count.

Every read reports the **ordering** it applied. `memory.recall` and
`stratus memory search` ask for `hybrid`, and the built-in store serves it:

- **`hybrid`** — any of the words can match. Facts holding every word come
  first, then the rest, so a fact matching some of the words never buries
  one matching all of them, however short or recent it is. Within each
  group, facts carrying more of the words, and the rarer ones, rank higher
  (SQLite's BM25 score), and a newer fact gets a boost that fades with age:
  1.5× today, 1.25× at 30 days, 1.125× at 90. So between two facts that
  match about equally well the newer one comes first, but a newer fact has
  to be at least two thirds as good a match to pass an older one. BM25 also
  favors a short fact over a long one with the same words, which is why
  the every-word group is kept apart.
- **`relevance`** — the same matching and grouping, by BM25 alone.
- **`recency`** — every word has to appear, newest first. This is the one
  ordering the contract requires of every store, and what a read gets when
  it names none.

A store asked for an ordering it does not implement serves `recency` and
says so rather than failing, so an agent on a store without ranking (the
in-memory one, or a plugin's) still gets answers, matched on every word.
