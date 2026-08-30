# 23 — Prompt caching: stop paying full price for the same prefix every turn

## Goal

`provider-anthropic` marks the stable head of each request as cacheable, and
the system prompt is ordered so that stable sections come before volatile
ones — so an always-on agent stops re-paying full input price for a persona,
a skills block, and a tool list that did not change.

## Why now

There is no `cache_control` anywhere in `packages/provider-anthropic`. Every
turn sends the whole prefix at full input price.

This workload is close to the ideal case for prefix caching, which is what
makes the omission expensive rather than merely untidy. An agent's persona,
its skills block, and its tool definitions are byte-identical across every
turn of its life; a cache read is a small fraction of the input price. For a
roster of agents each taking tens of turns a day, that difference is the
largest single line in the bill — larger than the machine the daemon runs on,
by an order of magnitude.

It also pairs with [18](./18-usage-accounting.md) in both directions. 18 is
what makes this measurable — `usage.cache_read_input_tokens` is the only
honest proof a cache is working — and this step is most of what makes 18's
numbers worth reporting.

## Scope

**In:**

- **`cache_control` on the stable prefix** in `provider-anthropic`: the tool
  definitions and the stable system sections. The wire order is
  `tools` → `system` → `messages`, so those are the head of the prefix
  already.
- **Reordering `renderSystemPromptSections` so volatile sections trail stable
  ones.** Today it emits `preamble, persona, memory, skills` — and **memory
  is the volatile one**. It is a bounded recent slice that changes whenever
  the agent remembers something, so its current position invalidates the
  skills block sitting behind it on every write. Stable first, volatile last,
  with the cache breakpoint between them.

  This changes the prompt the model sees, so it is a behavior change and not
  only a performance one. It needs the same care as any prompt edit.
- **A TTL that outlives the gap between an agent's turns.** The default
  ephemeral TTL is minutes; an always-on agent's turns are often further apart
  than that, and a cache that has expired before the next turn buys nothing
  while still having cost a write. The longer TTL has a higher write price —
  confirm the current multiplier against the live pricing docs rather than
  assuming, and pick per how often an agent actually speaks.
- **Deterministic tool ordering.** A cached prefix is a byte match, so the
  tool list has to serialize identically every turn. Registry iteration order
  is not currently a stated guarantee, and any nondeterminism here silently
  disables the whole step.
- **Reporting whether it worked.** `cache_read_input_tokens` and
  `cache_creation_input_tokens` surfaced alongside 18's counts, because a
  cache that has quietly stopped hitting looks exactly like one that works.

**Out:**

- **The harness providers.** `provider-claude-code` and `provider-codex` own
  their own prompt assembly inside their SDKs; whatever caching happens there
  is theirs. This step is the paths where we build the request.
- **The OpenAI-compatible adapter.** Different mechanism, different vendors
  behind it, and no single answer that holds for every endpoint someone points
  it at. Worth its own look later.
- **Changing what is in the prompt.** The sections stay the same sections;
  only their order and their cache annotations change.
- **Caching tool *results* or conversation history.** History grows every
  turn, so it is the volatile tail by definition; there may be something here
  for long sessions, and it is not this step.

## Design sketch

- Caching is a **prefix match**: one changed byte invalidates everything after
  it. So the only design question that matters is what is genuinely stable,
  and the answer has to survive contact with the things that quietly are not —
  a timestamp in a preamble, a memory slice that grew, a tool list in map
  order.
- There is a **minimum cacheable prefix**, and it is model-dependent and not
  small. A minimal agent — short persona, two tools, no skills — may sit under
  it and never cache at all. That is acceptable and must not be an error; it
  does mean the win is concentrated in exactly the agents that carry real
  personas and skill sets.
- **A write costs more than an uncached read**, so a prefix that is never
  reused is a loss. The agent this hurts is the one that runs once a day: its
  cache has always expired, and it now pays the write premium every time.
  Whether to cache at all is therefore a per-agent property, not a global
  switch — and defaulting it on for every agent is the version of this step
  that makes some deployments more expensive.
- There is a **small cap on breakpoints per request**, which is a budget, not
  a formality: tools, the stable system head, and possibly a history prefix
  each want one.
- The fallback wrapper crosses providers mid-run and **caches are
  model-scoped**, so a fallback turn starts cold. Expected, worth stating, and
  a reason not to read a single cold turn as a regression.

## Acceptance criteria

- A second turn in the same session reports non-zero
  `cache_read_input_tokens`; the first reports a write. Asserted against a
  fake provider that records what it was sent, not by watching a bill.
- **A memory write does not invalidate the skills section** — the ordering
  fix, tested directly, because this is the part a future refactor will undo
  by accident.
- Two turns with an unchanged tool set send byte-identical tool definitions.
- An agent whose prefix is under the cacheable minimum runs normally, with no
  error and no cache annotation.
- A fallback to a second provider mid-session runs correctly with a cold
  cache.
- Measured on a representative agent, cached input tokens are the large
  majority of input tokens by the third turn.
- No prompt content changed other than section order — the rendered sections
  are the same sections.

## Open questions

- **Is the longer TTL worth its write premium?** It depends on the gap between
  an agent's turns, which differs per agent and is exactly the sort of thing
  worth measuring before defaulting. A per-agent setting is the likely answer;
  a global one is the likely mistake.
- **Does the reordering change behavior?** Moving memory after skills changes
  what the model reads last, and recency in a system prompt is not nothing.
  Worth a before-and-after on a real agent rather than an assumption.
- **Should the cache breakpoint move as an agent grows?** A roster where every
  agent shares one preamble could cache that shared head across agents, which
  is a bigger win and a much sharper isolation question — two agents sharing a
  cached prefix is fine only if the prefix contains nothing agent-specific.
  Left alone here deliberately.
