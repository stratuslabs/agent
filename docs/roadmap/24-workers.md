# 24 — Workers: shared utility agents the whole roster can call

## Goal

A **worker** is an agent configured as a shared service rather than a
teammate: skilled, tool-using, reasoning in a loop — and with no persona, no
memory of its own, no channel presence, and no place in the roster a human
sees. Any agent can hand it a task; it does the work and returns a result.

## The name, first, because it is a vocabulary decision

[`plugins.md`](../architecture/plugins.md) governs the nouns and the rule is
one word per thing. This step proposes **worker** and deliberately does *not*
use "sub-agent", which elsewhere in the ecosystem means an ephemeral,
spawned-per-task, parallel helper. What this step describes is close to the
opposite: persistent, shared, and long-lived. Borrowing the word would import
the wrong model of what these are.

**The line against the existing nouns has to hold, or the vocabulary erodes.**
`plugins.md` already rules that a procedure is a *skill* and doing something is
a *tool*. A worker is a third thing **only when it must reason and use tools
iteratively** to do its job. A summarizer that takes text and returns text is a
tool: cheaper, faster, deterministic, and testable. If that line is not stated
plainly in the docs this step lands, people will build workers where a tool
would do, and get something slower and more expensive for it.

## Why now

Two arguments, and the second is the one that pays.

**Consistency.** Five agents that each need to research, triage, or summarize
will each do it differently, and improving any of them improves only that one.
A shared worker is one place to fix it — the same argument
[21](./21-team-knowledge.md) makes for skills, one level up.

**Context offloading, which is a cost lever rather than an architectural
preference.** A worker that reads five pages and returns three hundred words
means the calling agent never carries fifty thousand tokens of page content in
its own context, and never pays to re-send it on every subsequent turn of that
conversation. The worker can run a cheap model while the teammate runs an
expensive one. Model spend dominates every other cost in a fleet by an order of
magnitude, so this is plausibly a larger lever than
[23](./23-prompt-caching.md) — and unlike caching it is one an operator applies
per task rather than once.

It is also mostly built. `createDelegateTool` already runs another agent in its
own sub-session with that agent's memory, tool allowlist, and credentials, and
bounds the chain with `maxDepth`. What is missing is the configuration that
makes an agent a service rather than a person, and a way for a caller to know
which services exist.

## Scope

**In:**

- **`worker: true` in soul frontmatter** (name subject to the decision above),
  which changes four things and nothing else:
  - **No memory.** A worker neither reads nor writes agent memory. A utility
    invoked by the whole fleet accumulating a record of every task it was ever
    given is context bloat first and a privacy problem second — it would be the
    one place where one agent's work becomes readable through another's.
  - **No roster presence.** Excluded from `listAgentSummaries`, from
    `servedRuntimes`, from channel identity, and from avatar generation. A
    worker is not addressable by a human in Slack, and does not appear in the
    fleet console's roster view as a teammate.
  - **No inbound routing.** `createAgentRouter` never routes a person's message
    to a worker.
  - **Invocable only by delegation**, from an agent whose soul allows it.
- **Discovery for callers.** A calling agent needs to know which workers exist
  and what each is for, which is a description and a name — the same shape as a
  tool catalog, and the natural place is the delegate tool's own description
  rather than a new mechanism.
- **A per-agent allowlist of which workers it may call.** Delegation today
  targets any agent by name. "Many agents can use it" is a good default and a
  bad rule: the same two-gate discipline that governs tools should govern which
  services an agent can spend tokens on.
- **The approval routing answer.** When agent A delegates to worker W and W
  hits a gated call, whose approver is asked. The allowlist half is already
  settled — W's own — but the routing half is not, and a worker serving five
  agents makes "ask the operator who is responsible" ambiguous in a way a
  single agent never was.
- **Docs stating the worker/tool/skill line**, in `plugins.md` and in the
  guide, in the terms above.

**Out:**

- **Ephemeral spawn-per-task parallelism.** Fanning out N copies of a worker to
  do N pieces of one job is a different feature with different failure modes
  (partial results, cost explosion, ordering) and should not ride along on a
  step about shared services.
- **A new kernel concept.** A worker is an `AgentDefinition` with flags. If
  this needs a new interface in `core`, the design is wrong — the seams already
  carry it.
- **Workers calling workers.** `maxDepth` already bounds delegation chains and
  this step does not raise it. Worth revisiting only with a real case.
- **Cross-agent result caching.** Two agents asking one worker the same
  question in the same hour is a real waste and a real information leak between
  agents — the second agent would learn what the first asked. Not here.
- **Workers as a distribution unit.** Shipping a worker someone else wrote is
  [12](./12-plugin-registry.md).

## Design sketch

- The delegate tool stays `safe`, and its existing reasoning carries over
  unchanged: delegation does not act outside Stratus, the delegate's own calls
  face policy again under its own allowlist, and `maxDepth` bounds the chain.
  Nothing about a worker changes that argument.
- **A worker's sub-session is still a session** — durable, resumable, and
  visible in the console. "No memory" is about the agent-scoped memory store,
  not about hiding what the worker did. An operator debugging a bad answer
  needs to see the worker's turns.
- The result comes back as the delegate tool's result, which is text today.
  Whether a worker should be able to return something structured is worth
  asking once there is one that wants to.
- **Cost attribution follows the worker, not the caller.**
  [18](./18-usage-accounting.md)'s records carry provider and model, and a
  worker on a cheap model is exactly the case that makes per-agent rollups
  worth having — an operator should be able to see that the research worker is
  the fleet's largest line item, or that it is saving them money.
- A worker with no persona still gets a system prompt: its skills, its tools,
  and whatever the preamble carries. `renderSystemPromptSections` already omits
  empty sections, so this needs no special case — and per [23](./23-prompt-caching.md),
  a worker's prefix is stable and heavily reused, which makes it the best
  caching case in the fleet.

## Acceptance criteria

- An agent delegates to a worker and gets a result; the worker ran under its
  own tool allowlist and its own credentials.
- The worker appears in no roster listing, has no channel identity, and a
  message addressed to it in Slack does not reach it.
- The worker neither reads nor writes agent memory, asserted directly — and the
  calling agent's memory is unchanged by the delegation.
- An agent whose soul does not allow a worker cannot call it, and the refusal
  names the reason.
- Two agents delegating to the same worker concurrently get independent
  sessions and neither observes the other's.
- A gated call inside a worker asks the approver the routing rule names, and
  resumes correctly on the answer.
- The worker's sessions are visible in the console and its usage is attributed
  to the worker.
- `maxDepth` still bounds a chain that runs through a worker.

## Open questions

- **`worker: true`, or a `kind:` field?** A boolean is smallest and reads
  correctly today. A `kind: teammate | worker` admits a third kind later
  without a second boolean fighting the first. Leaning boolean until something
  needs the third.
- **Whose approver?** Three candidates: the calling agent's, the worker's own,
  or the operator's fallback channel. The worker's own is most consistent with
  "the delegate's calls face its own policy", and is also the one most likely
  to have nobody configured — which by the existing headless rule means the
  call is refused. That may be the right answer and it should be a decision,
  not a default nobody chose.
- **Should a worker be allowed memory it does not own** — reading the roster
  scope from [21](./21-team-knowledge.md) without writing agent-scoped memory
  of its own? A research worker that knows the team's vocabulary is better at
  its job. It is also the exact path by which one agent's private context could
  reach another through a shared service, so it wants deciding with 21 rather
  than separately.
