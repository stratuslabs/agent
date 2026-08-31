# 23 — Prompt caching: stop paying full price for the same prefix every turn

## Goal

`provider-anthropic` marks the stable head of each request as cacheable, and
the volatile part of what an agent is told — its memory — moves out of the
system prompt to the tail of the request, where changing it invalidates
nothing. An always-on agent stops re-paying full input price for a persona, a
skills block, and a tool list that did not change.

## Why now

There is no `cache_control` anywhere in `packages/provider-anthropic`. Every
turn sends the whole prefix at full input price.

This workload is close to the ideal case for prefix caching, which is what
makes the omission expensive rather than merely untidy. An agent's persona,
its skills block, and its tool definitions are byte-identical across every
turn of its life; a cache read is a tenth of the input price. For a roster of
agents each taking tens of turns a day, that difference is the largest single
line in the bill — larger than the machine the daemon runs on, by an order of
magnitude.

It also pairs with [18](./18-usage-accounting.md) in both directions. 18 is
what makes this measurable — `cacheReadTokens` is the only honest proof a
cache is working — and this step is most of what makes 18's numbers worth
reporting. 18 shipped, so the instrument exists before the change it measures.

## Vendor facts this step rests on

Checked against the current caching reference rather than assumed; several
corrected an earlier draft of this spec, and each is load-bearing below.

| Fact | Value |
| --- | --- |
| Render order | `tools` → `system` → `messages`. A breakpoint on the **last system block caches tools and system together**, so the head needs one breakpoint, not two. |
| Breakpoints per request | 4. |
| Minimum cacheable prefix | **Model-dependent and not monotonic**: 512 tokens on Opus 5 (our default), 1024 on Opus 4.8 and Sonnet 5, 2048 on Opus 4.7, 4096 on Opus 4.6/4.5 and Haiku 4.5. Under it, nothing caches — silently, with no error. |
| Price | Read ~0.1× input. Write **1.25×** at 5-minute TTL, **2×** at 1-hour. |
| Break-even | Two requests at 5-minute TTL, three at 1-hour. |
| TTL refresh | **A cache read refreshes the entry's timer for free**, on either TTL. Lifetime is measured from the *start* of the writing or reading request, so a long generation eats into it. |
| Volatile content | The guidance is not "order it last within `system`" but **"get it out of `system`"** — inject it later in `messages`, where it invalidates nothing ahead of it. |
| `role: "system"` messages | A `{"role": "system", "content": "…"}` entry in `messages[]` is the supported channel for exactly that. **Opus 5, Opus 4.8, Fable 5, Mythos 5; not Sonnet 5**, which returns a catchable 400. No beta header. Must follow a `user` message and be last or followed by an `assistant` turn. |

The last two are why this spec's design changed; see below.

## Scope

**In:**

- **`cache_control` on the stable head** in `provider-anthropic`: one
  breakpoint on the last system block, which covers the tool definitions and
  the system prompt together.
- **Memory moves out of the system prompt into a `role: "system"` message**
  at the tail of `messages`, rather than being reordered within `system`.

  Memory is the volatile section — a bounded slice of the twenty most recent
  entries, rewritten whenever the agent remembers anything. Reordering it
  behind skills would still leave it *inside* the cached prefix, so a write
  would still invalidate every message after it. Moving it out leaves the
  whole system block byte-stable, and a tail message invalidates nothing
  ahead of itself.

  Two further reasons this beats the reorder:

  - **It is confined to one adapter.** The reorder would change the prompt
    for `provider-claude-code`, `provider-codex`, and the OpenAI-compatible
    adapter — all three explicitly out of scope for caching, and the last of
    which emits *one system message per section*, so a reorder changes its
    message sequence. Placement is a wire-format decision, so it belongs in
    the adapter whose wire format it is.
  - **It keeps memory on a non-spoofable channel.** Memory content is written
    by the agent and can carry whatever a tool read off the network. It is
    trusted today because it sits in the system prompt. `role: "system"`
    preserves that; moving it into a user turn would not, and is the version
    of this change that quietly becomes a prompt-injection surface.
- **A fallback for models without `role: "system"`.** Sonnet 5 rejects it.
  The adapter catches that one 400, remembers it for the life of the provider
  instance, and renders memory in the system block as it does today. One
  wasted request per process, not per turn.
- **Deterministic tool ordering**, by sorting the wire tool list by name in
  the adapter. A cached prefix is a byte match, and registry order is
  insertion order — which the MCP bridge changes at runtime, because a
  reconnect re-registers discovered tools and moves them to the end. That
  silently disables caching for the rest of the daemon's life, and is
  invisible without 18's counters.
- **A cache setting**, defaulting to on at the 5-minute TTL. Daemon-wide
  (`promptCache` / `promptCacheTtl` in the config file) in this step; the
  per-soul override is a follow-up, because the case that needs it — a
  once-a-day schedule beside conversational agents on one daemon — is a
  roster shape rather than a deployment one, and a soul key is where it
  belongs.
- **Reporting whether it worked.** Already shipped: 18 records
  `cacheReadTokens` and `cacheWriteTokens` per provider call.

**Out:**

- **The harness providers.** `provider-claude-code` and `provider-codex` own
  their own prompt assembly inside their SDKs; whatever caching happens there
  is theirs. This step is the paths where we build the request.
- **The OpenAI-compatible adapter.** Different mechanism, different vendors
  behind it, and no single answer that holds for every endpoint someone
  points it at. Worth its own look later. Under this design it is not touched
  at all, where the reorder would have changed it.
- **Reordering `renderSystemPromptSections`.** Superseded. The renderer grows
  a way to ask for its sections *tagged*, so a provider can place them per its
  wire format; the existing string-array function keeps its exact current
  order and output, and the three other consumers see no change.
- **Changing what is in the prompt.** The sections stay the same sections
  with the same text; only their placement and cache annotations change.
- **Caching tool *results* or conversation history.** History grows every
  turn, so it is the volatile tail by definition; there may be something here
  for long sessions, and it is not this step.
- **Cross-agent prefix sharing.** A roster sharing one cached preamble is a
  bigger win and a much sharper isolation question. Left alone deliberately.

## Design sketch

- Caching is a **prefix match**: one changed byte invalidates everything after
  it. So the only design question that matters is what is genuinely stable,
  and the answer has to survive contact with the things that quietly are not —
  a timestamp in a preamble, a memory slice that grew, a tool list in map
  order.
- **`core` gains a tagged view, not a new order.** `renderSystemPromptSections`
  keeps returning the same strings in the same order; a sibling returns the
  same sections tagged by kind, and the existing function becomes a join over
  it. One rule about what the sections are, two ways to ask for it — which is
  the extension its own docstring already implies, that the contract is the
  content rather than the joining.
- **There is a minimum cacheable prefix**, and on our default model it is 512
  tokens — smaller than an earlier draft of this spec assumed. A minimal agent
  may still sit under it and never cache, which is acceptable and must not be
  an error: a marker on a too-short prefix is a silent no-op, not a failure.
  The caution is real for an operator pinned to Opus 4.6 or Haiku 4.5, where
  the floor is 4096.
- **A write costs more than an uncached read**, so a prefix that is never
  reused is a loss. At the 5-minute TTL the break-even is the second request,
  and a read refreshes the timer for free — so an agent holding a conversation
  keeps its entry warm indefinitely. The agent this still hurts is the one
  that takes exactly one turn per burst: it pays 1.25× on the stable head
  every time and never reads it back. Hence a per-agent setting.
- **The 1-hour TTL is not the default**, which corrects an earlier reading.
  Because reads refresh for free, the gap that matters is between an agent's
  *bursts*, not between its turns; within an active conversation the 5-minute
  entry sustains itself and the doubled write price buys nothing.
- **One breakpoint, not several.** A breakpoint on the last system block
  covers tools and system together, leaving the budget of four almost
  untouched for whatever wants one later.
- The fallback wrapper crosses providers mid-run and **caches are
  model-scoped**, so a fallback turn starts cold. Expected, worth stating, and
  a reason not to read a single cold turn as a regression.

## Acceptance criteria

- A second turn in the same session reports non-zero `cacheReadTokens`; the
  first reports a write. Asserted against a fake transport that records what
  it was sent, not by watching a bill.
- **A memory write leaves the system block byte-identical** — the whole point,
  tested directly, because this is the part a future refactor will undo by
  accident.
- Two turns with an unchanged tool set send byte-identical tool definitions,
  **including after a tool is unregistered and re-registered** — the MCP
  reconnect case.
- An agent whose prefix is under the cacheable minimum runs normally, with no
  error.
- A model that rejects `role: "system"` completes the turn with memory in the
  system block, and does not pay the rejected request again on the next turn.
- A fallback to a second provider mid-session runs correctly with a cold
  cache.
- The other three providers' rendered prompts are unchanged, asserted against
  their existing expectations.
- No prompt content changed — the rendered sections are the same sections with
  the same text.

## Open questions

- **Should caching default on?** Defaulting on makes the once-a-day agent
  slightly more expensive and every conversational agent much cheaper. 18's
  counters make the regression visible per agent, which is the argument for
  defaulting on and watching, rather than defaulting off and never finding
  out. Open because it is a judgement about deployments this repository cannot
  see.
- **Does moving memory to the tail change behavior?** It changes what the
  model reads last, and recency is not nothing — though the tail is arguably
  the *better* place for "what you remember about this person", next to the
  turn it bears on. Unlike the reorder this design replaced, it is the shape
  the vendor documents for injected state, so the burden of proof sits with
  the deviation rather than with us. Still worth a before-and-after on a real
  agent rather than an assumption.
- **Should the cache breakpoint move as an agent grows?** A roster where every
  agent shares one preamble could cache that shared head across agents, which
  is a bigger win and a much sharper isolation question — two agents sharing a
  cached prefix is fine only if the prefix contains nothing agent-specific.
  Left alone here deliberately.
