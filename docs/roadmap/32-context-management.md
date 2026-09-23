# 32 — Context management: a conversation that never has to end

## Goal

A long-running conversation stays useful rather than merely alive. Today a
session that outgrows the model's context window keeps going on a sliding
window — the oldest turns simply stop being sent. That is the right floor
and the wrong ceiling: the agent forgets the beginning of a conversation it
is still having, silently as far as the person talking to it is concerned.

This step replaces dropping with **summarizing**, so what leaves the window
leaves a record behind, and makes the trade visible where it is being made.

## Why now

The unrecoverable half is already fixed. Before it, a transcript past the
window was a *permanent* failure: the session is durable, so every later
message replayed the same too-long request and was refused identically, and
a Slack DM — one session for the life of the install — became an id its
channel still routed to and nothing could answer. `ContextOverflowError`,
`contextFloor`, and the retry in `executeTurns` closed that; a conversation
now narrows instead of dying.

What that fix deliberately does not do is remember anything. The floor is a
count of messages no longer sent, and the note in their place says only how
many there were. So:

| Today | After this step |
| --- | --- |
| The oldest turns are dropped | The oldest turns are summarized, and the summary stays in the window |
| The agent is told a number | The agent is told what happened in them |
| The trim is a log line | The trim is in the transcript, attributable, and re-readable |
| Every provider gets the same blunt treatment | The Anthropic path can use the API's own compaction |

Three things make now the moment rather than later:

- **The floor only ever rises.** A conversation that trims once trims
  again, and each trim is a permanent loss of everything before it. The
  longer this ships without summarization, the more real conversations are
  running on a window that has quietly eaten their first hour.
- **Memory exists and is the wrong tool.** `memory.remember` is agent-chosen,
  agent-scoped, and deliberately small ([14](./14-memory.md),
  [29](./29-memory-quality.md)). It is not a transcript summary and should
  not become one — a summary is a property of *this conversation*, not a
  durable fact about the world.
- **The vendor now does half of it.** Anthropic's server-side compaction
  (beta `compact-2026-01-12`) summarizes earlier context on its own and
  hands back a block to replay. That is exactly the thing this repo's rule
  about not re-deriving what lives somewhere else points at — for the
  default provider. It does not cover the others, which is why the kernel
  still needs its own answer.

## Scope

**In:**

- **A summary record on the session**, written when the window narrows and
  replayed in place of what it replaces. It is transcript state, not memory:
  it lives with the session, is redacted from reads the way the Anthropic
  raw-turn cache is if it carries model reasoning, and is garbage-collected
  with the session.
- **Summarization through the session's own provider**, as a separate call
  with its own `turnId` and usage record, so the cost is attributed rather
  than folded into the turn that triggered it. [18](./18-usage-accounting.md)
  is what makes that reportable.
- **A trust label on the summary.** A summary of a transcript that contains
  `external` content is not `agent` content — it is a restatement of
  whatever was in there, and [30](./30-provenance.md)'s whole argument is
  that restating does not launder. The summary carries the least-trusted
  label of the messages it covers, and the session's label does not rise
  because a summary replaced them.
- **Provider opt-in for native compaction**, behind the same seam
  `ContextOverflowError` uses. A provider that can compact server-side says
  so; the kernel then lets it, and skips its own summarization for that
  session. `provider-anthropic` is the first implementation.
- **The operator's controls**: whether to summarize at all (a fleet that
  would rather forget cheaply than pay for a summary is a real position),
  and the window target, so this does not have to wait for an actual
  rejection to act.

**Out:**

- **Acting before the provider says no.** Today's recovery is reactive: the
  request is sent, refused, and retried smaller. Proactive trimming needs a
  token count the kernel does not have — `messages.count_tokens` is a
  round trip and a vendor API, and a character heuristic that is wrong in
  the expensive direction trims conversations that would have fit. The
  operator's window target above is the opt-in; the default stays reactive.
- **Storage.** A session is one JSON blob rewritten on every save, so a long
  transcript costs O(transcript) per tool call and O(turns²) per session, on
  a synchronous SQLite write. Real, and a different change — this step
  bounds what is *sent*, not what is kept.
- **Retrieval over the transcript.** "Search what fell out of the window"
  is a better answer than a summary for some questions, and a much larger
  step; it wants [13](./13-search.md)'s contract shape and its own spec.

## Design sketch

The seam is already there. `sessionWithinContextFloor` builds the view a
provider is sent; summarization changes what that view contains rather than
where it is decided.

```
overflow → raiseContextFloor → summarize what just left → store on session
                                      ↓
        sessionWithinContextFloor prepends the summary to the kept tail
```

Three properties the current code already establishes and this must keep:

- **The window starts on a turn boundary.** A `tool` result whose `tool_use`
  was cut away is a request every provider rejects, which would turn one
  overflow into a permanent failure of a different kind.
- **The floor is monotonic and durable.** It is saved before the retry, so a
  daemon that dies mid-recovery does not come back and replay the request
  that was just refused.
- **The transcript on disk is never shortened.** The window is a view. The
  record of what happened stays whole, and `rolloverSession` remains the one
  thing that deliberately leaves a conversation behind.

For the native path, the API's compaction block must be replayed verbatim on
the next request — the same contract the raw-turn cache already honours for
thinking blocks, and the same failure mode if it is dropped, so it belongs
in the same place.

## Acceptance criteria

- A conversation trimmed by the window can still answer a question whose
  answer is only in the summarized region — the test that separates this
  step from what shipped before it.
- The summary is attributed: a `turnId` and a usage record of its own, and
  `stratus logs` shows the summarization as its own event.
- A summary of a transcript containing `external` content is labelled
  `external`, and the session's label does not rise when the summary
  replaces those messages.
- A provider that compacts natively is not also summarized by the kernel,
  and its compaction block survives a tool call, an approval wait, and a
  daemon restart.
- A summarization that fails does not fail the turn: the window still
  narrows, the note still says what left, and the conversation continues —
  degrading to what ships today.
- The transcript on disk is unchanged by any of it.
- The docs say what an operator gives up on each setting, and `stratus logs`
  is documented as the place a trim is visible.

## Open questions

- **What is a summary of a tool-heavy stretch?** Twenty `fs.read` results
  and their calls summarize badly — the useful residue is often "it read
  these twelve files" rather than their contents. Anthropic's context
  editing (`clear_tool_uses_20250919`) clears tool results specifically,
  which suggests treating tool traffic and conversation differently rather
  than summarizing both as prose.
- **Does the summary get re-summarized?** A conversation long enough to trim
  twice has a summary inside the region being summarized. Nesting is the
  obvious answer and the obvious way to lose everything slowly.
- **Should a trim be visible in the channel?** The person talking to the
  agent is the one who will notice it forgetting, and a one-line note in
  Slack is cheap. It is also an interruption in a thread, and the same
  argument that keeps `session.tainted` out of the channel may apply.
- **Who pays for a summary on a fleet with a fallback model?** The
  summarizing call is not the turn, and running it on the cheaper fallback
  is attractive and is exactly the kind of implicit model choice
  [24](./24-sub-agents.md) decided an operator has to make explicitly.
