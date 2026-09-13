# Reading the room — the eval

The judgement behind `listens: judge` is a prompt (`UNADDRESSED_TURN_NOTE`
in `@stratusagent/core`), and a prompt cannot be specified into
correctness: a model asked "should you answer this?" says yes far more
often than a person would. This is the ruler [31](../../../../docs/roadmap/31-reading-the-room.md)
asked for, so "it interrupts too much" is a number that moves rather than
an argument had again every review.

`threads.json` is a labelled set of small multi-person threads. In each,
the first message names Ava and runs as an addressed turn; every message
after it runs as a turn nobody asked for — exactly the turn a judging agent
takes — and is labelled `speak` (a colleague in Ava's position would say
something: an open question only she can answer, a correction to something
somebody is about to act on, an answer to a question she asked) or `silent`
(two people talking to each other, small talk, thanks). A message that
names another agent, and that agent's reply, is marked `observe`: the Slack
adapter only ever hears those, so they enter the session with no turn and
no score, as in production. Attention windows are not simulated: this
measures the decision, not the budget.

Run it against whatever `stratus` is configured to run on, optionally as a
particular soul:

```bash
pnpm eval:room
pnpm eval:room -- --soul ~/.stratus/agents/ava.md
```

The corpus names its agent Ava; with a soul of another name every mention
of Ava in the threads is retargeted to that name, so the agent under test
is the one being spoken to. Colleagues (Bea) keep their names.

It prints, per thread and in total, **false speech** (spoke when labelled
silent) and **false silence** (silent when labelled speak), and a score
that weights false speech three times false silence — a colleague who
misses one cue is easier to live with than one who answers every message.
The score is not a gate: it needs a model, so it runs on demand, and the
number to watch is the trend across prompt changes rather than any one run.
