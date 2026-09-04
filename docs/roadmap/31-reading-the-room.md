# 31 — Reading the room: overhearing, and an agent's own choice to speak

## Goal

An agent in a shared thread behaves like a person in one: it follows what is
being said whether or not anyone is talking to it, and it answers when it has
something to add rather than because a rule fired. Being told "thanks, we've
got it from here" works, because it is a sentence the agent read and not a
feature somebody had to build.

## Why now

[02](./02-slack-channel.md)'s thread follow-through made a mention start a
conversation and every reply in that thread continue it. That is right for
the thread it was built for — one person and one agent — and wrong the moment
a second person joins: two colleagues talking under a message the agent
answered get an answer each, because the rule cannot tell "and what about the
second one?" from "yeah, saw it — let's ship."

The rule is not the defect. It is the only thing available, because the agent
can neither **hear** the conversation nor **decline** to join it:

- **It hears only what it answered.** A session holds the messages the agent
  took a turn on, and nothing said between them. So even when it *is*
  addressed, it answers with the thread's middle missing — which is also why
  an agent tagged in halfway through today starts from the message that
  tagged it and nothing before.
- **Every turn ends in a message.** A turn that produces no text posts
  `(no reply)`, because until now every turn was one somebody explicitly
  asked for. There is no shape for "read it, not mine, said nothing."

Give it both and the mechanical rule stops carrying weight it was never able
to carry. This is the step where "feels like a colleague" stops being a
description of the streaming and starts being about judgement.

## Scope

**In:**

- **Overhearing — a message reaching a session without a turn.** A message in
  a thread the agent is in, addressed to somebody else, is appended to that
  agent's session and no turn runs. No model call, no reply, no cost beyond a
  session write. The next turn the agent *does* take has the conversation in
  hand.
  - Kernel: `AgentRunner` gains `observe({ sessionId, message })` alongside
    `run`/`resume` — append and save, emitting a distinct event rather than
    anything a channel would mistake for a turn (a renderer that saw
    `session.updated: running` would open a placeholder for a turn that will
    never speak). The gateway exposes it on the dispatcher so a channel can
    reach it, and it takes the same single-flight session chain as a
    dispatch, so an overheard message and a turn never interleave writes.
  - **Overheard text is somebody else's.** It enters the prompt with no one
    having addressed it, which is exactly the boundary [30](./30-provenance.md)
    draws: it is marked untrusted at the point it enters and rendered as
    quoted third-party speech, never as the agent's own prior conclusion.
    This is why 31 lands after 30 (see [Sequencing](#sequencing)).
- **A turn that may end in silence.** `dispatch` carries whether the message
  was *addressed* to this agent or merely *heard* by it. An unaddressed turn
  is told, in the prompt, that it was not spoken to and may answer with
  nothing; an empty reply is a decision, not a failure, and posts nothing at
  all — no `(no reply)`, and no placeholder either.
  - Channel: the Slack renderer opens its placeholder **lazily**, on the first
    text or tool line rather than at intake. Worth having on its own — a
    thread should not flicker a `…` every time somebody types — and required
    here, since a placeholder posted before the decision is a message the
    decision cannot take back.
- **Attention, so judgement is affordable.** Deciding costs a model call per
  message, and two people talking for an hour is a hundred of them for one
  "no". A person's attention decays the same way: you stay tuned in for a
  while after being spoken to, then drift out. So an agent judges only while
  **attentive** — a bounded window after it last spoke or was named, in
  messages and in minutes, whichever ends first — and outside it a message is
  overheard (free) with no turn at all. A mention re-arms attention, which is
  what a mention has always meant.
- **How an agent listens, in its soul.** `listens:` frontmatter, three values,
  because this is part of what an agent *is* and not how a daemon is
  deployed — it belongs beside `tools:` and `skills:`, not in a config block
  a deployment owns:
  - `mentions` — only when named. The behavior before 02's follow-through,
    kept because some agents should be exactly this.
  - `thread` — every reply in a thread it is in. Today's rule: cheap,
    predictable, and right for a thread with one person in it.
  - `judge` — overhear always, decide while attentive.

**Out:** any of this outside a thread the agent is already in — the channel at
large stays none of its business, and
[02](./02-slack-channel.md)'s "the room is not a conversation" rule is what
keeps the blast radius of overhearing to conversations somebody invited the
agent into. Also out: DMs (addressed by construction), reading a thread's
history from the platform's own API (overhearing accumulates forward from the
mention; backfilling what was said before the agent arrived is its own
decision, with its own privacy answer), and any cross-agent shared view — each
agent overhears into its own session, as sessions have always been.

## Design sketch

The three pieces are separable and land in dependency order, each useful
alone:

1. **`observe` and the overheard lane.** Ships with `listens: thread`
   unchanged — an agent still answers every reply, but now with the messages
   it did not answer in its context. This alone closes the "tagged in halfway
   through knows nothing" gap that 02's follow-through left open, and it is
   the piece with a kernel seam in it.
2. **Silent turns and the lazy placeholder.** No behavior change on its own:
   every turn today is addressed, and an addressed turn that says nothing
   still says `(no reply)`.
3. **`judge` and attention.** Now possible, because a turn can read the room
   and say nothing about it.

The prompt for an unaddressed turn is the load-bearing part and the part that
cannot be specified into correctness: models are eager, and one asked "should
you answer this?" says yes far more often than a person would. Treat it the
way [29](./29-memory-quality.md) treats recall — a stated ground truth and an
eval over transcripts of real multi-person threads, so "it interrupts too
much" is a number that moves rather than an argument had again every review.
A first ruler: a labelled set of threads where each message is marked *for the
agent* / *not for it*, scored on false-speech (interrupting) far more heavily
than on false-silence (missing a cue), because a colleague who misses one
question is easier to live with than one who answers every message.

Dismissal needs no mechanism. "Thanks Ava, we'll take it from here" is a
sentence, and an agent that reads the thread reads that too — which is the
test of whether this design is the right one.

## Acceptance criteria

- Two people hold a ten-message exchange in a thread an agent is in; the agent
  posts nothing. The eleventh message asks it something, and its answer shows
  it followed the ten — no re-explaining, and it can refer to what was said.
- An agent mentioned into a thread that has been running without it answers
  with what it overheard since it arrived, and says so honestly rather than
  inventing the part before.
- A turn that decides not to speak leaves the thread untouched: no
  placeholder, no `(no reply)`, no edit.
- Past the attention window an untagged message runs no turn at all (assert
  the provider is never called), and a mention re-arms it.
- `listens: mentions` reproduces pre-follow-through behavior exactly, and
  `listens: thread` reproduces today's.
- Overheard text carries [30](./30-provenance.md)'s untrusted marking across a
  restart, and an injection attempt in an overheard message does not reach the
  model as an instruction.
- Cost is bounded and stated: for a thread of N messages with M addressed to
  the agent, the model is called at most M + (messages inside attention
  windows) times, and a test pins that arithmetic.

## Open questions

- **Default `thread` or `judge`?** Leaning `thread`, with `judge` opt-in until
  the eval says the judgement is good enough to hand a default. A default that
  interrupts is worse than one that is slightly deaf, because the deaf one is
  fixed by an `@` and the other is fixed by an apology.
- **Is judgement a full turn, or a cheap pre-pass on a small model?** Leaning
  the full turn. A classifier has neither the persona nor the history, which
  is the entire reason this is better than a rule — and a pre-pass that gets
  it wrong is a rule with a model's price. Worth measuring once there is an
  eval, since the cost gap is large.
- **Attention window shape** — messages, minutes, or both, and does the agent
  get to extend its own ("I'll keep an eye on this")? Both is the honest
  start; self-extension is a nice affordance and a good way to never drift out
  of anything.
- **Does every overheard message cost a session write?** A busy thread would
  make that a write per message. Batching, or a tail the session keeps
  in-process until the next turn, is an optimization with a crash-consistency
  question attached.
- **Does `observe` belong to channels only?** A control-API caller adding
  context to a session without running a turn is the same operation, and
  probably wants it.
- Should an agent overhear its *own* thread while a turn of its is in flight,
  or does the single-flight chain already answer that by ordering them?
