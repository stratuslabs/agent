# 14 — Memory: recall the agent performs, not recall that happens to it

## Goal

Search and forget on the memory store, a durable default behind it, and three
tools that let an agent decide what is worth remembering and go looking for it
later — so "gets smarter over time" is something an agent does rather than
something the runtime does to it.

## Why now

`AgentMemoryStore` in `packages/core` is `append` and `list`. That is two
problems wearing one interface.

The first is that recall is all-or-nothing. `list` returns everything an agent
has ever stored, so the only implementable policy is to inject all of it or
none of it. That is fine at ten entries and impossible at ten thousand, and an
always-on agent reaches ten thousand by running. The store as written has a
horizon measured in weeks.

The second is that the agent is not a participant. Nothing in the kernel lets a
model say *this is worth keeping* or *what do I know about this*; memory is
written by the runtime, on the runtime's schedule, about what the runtime
thought was interesting. The product's first sentence promises agents that get
smarter over time, and the mechanism for getting smarter is currently closed to
the agent.

[09](./09-skills.md) is the taught half of competence — procedures an operator
installs. This is the learned half, and the two are worth building near each
other because they fail in opposite directions: a skill that is never updated
goes stale, and a memory that is never curated goes noisy.

## Scope

**In:**

- **`AgentMemoryStore` grows `search(agentId, query, limit)` and
  `forget(agentId, entryId)`**, and `list` grows a bounded form. The in-memory
  implementation in `packages/core` implements all three, because it is what
  every test uses.
- **A durable default.** The gateway already runs `node:sqlite` for its session
  store; memory uses the same, not a second storage technology to operate. An
  always-on agent whose memory dies with the process is not the product being
  described. Alternative stores stay a plugin contribution, as
  [`plugins.md`](../architecture/plugins.md) already says they are.
- **Retrieval by FTS5, not embeddings.** No provider, no key, no network, no
  per-query cost, deterministic output, and genuinely good at *what do I know
  about X*. Embeddings are an obvious later plugin behind the same seam, and
  starting there would make the first version of memory depend on a second
  vendor relationship.
- **`memory.recall(query, limit?)`** — `risk: 'safe'`. Reading what this agent
  already knows.
- **`memory.remember(content, tags?)`** — `risk: 'gated'`. Argued below.
- **`memory.forget(id)`** — `risk: 'gated'`, and tombstoned rather than
  deleted, so an operator can still see what an agent chose to drop.
- **The per-agent key is the access boundary**, resolved from
  `session.agent.id` on every call, exactly as `tool-fs` resolves roots — never
  captured at startup and never taken from config.
- **Turn injection changes shape**: the system prompt carries a bounded slice
  (the most recent N) instead of the whole store, and everything else arrives
  through `memory.recall`. This is a **behavior change**, not an addition —
  existing agents' prompts get smaller and their unprompted recall gets
  narrower — and it is the change that makes the store survive its second year.

**Out:**

- **No shared memory between agents.** Two agents reading one store is a policy
  decision with an access-control model behind it, and the current model says
  memory is keyed by agent precisely so that routing to the wrong identity
  cannot cross it.
- **No automatic consolidation or summarization** of old entries. It is the
  right idea and it is a tuning problem that will churn; it should not be
  wired in underneath a store that is still proving its interface.
- **No embeddings.** See above.

## Design sketch

- The schema change goes through `migrateLegacyMemory` in the gateway, which
  already exists for exactly this and is the only place that should know how an
  older layout is read.
- `memory.remember` is `gated` for a reason worth writing down. Memory content
  is model-authored text that is replayed into a later system prompt, which
  makes it the one channel in the system that carries instructions *across the
  turn boundary*. An agent that reads a hostile page and remembers what it said
  has laundered that text past every check the turn applied to it, into a
  context where it looks like the agent's own prior conclusion. That is a
  materially different act from writing a file, and it is why the write is
  gated while the read is not. It also means [13](./13-search.md)'s untrusted
  snippets and this step's write path are the same attack in two halves.
- The daemon log records that an entry was written and its id. Not its content:
  a memory is closer to a transcript than to a tool argument.
- `memory.recall` returning nothing is a normal result, not an error. An agent
  that has learned nothing yet is the ordinary starting state and must not read
  as a broken tool.

## Acceptance criteria

- An agent remembers a fact in one session and recalls it in a **new session
  after a daemon restart** — the test that proves durability rather than
  process-lifetime caching.
- Agent A cannot recall agent B's entries, and the test names both agents
  rather than asserting an empty result that an unrelated bug would also
  produce.
- `memory.remember` prompts under the default risk and is refused outright for
  an agent whose soul does not allowlist it.
- A forgotten entry stops appearing in `recall` and remains visible to an
  operator through the store.
- Recall against a store with thousands of entries returns in bounded time and
  bounded tokens — stated as a criterion because it is the exact failure the
  current `list` has, and a version of this step that keeps that failure has
  not done anything.
- The structured log names the entry id and never its content.

## Open questions

- **Does the dashboard get a memory view?** Leaning yes. "What has my agent
  actually learned" is the first question anyone asks about a fleet that has
  been running a month, and [05](./05-control-api.md)'s catalog screen is the
  precedent for answering it from a read-only endpoint. It also gives `forget`
  a human operator, which an agent-only interface does not.
- **Should recall also fire automatically at turn start**, as a cheap FTS query
  against the incoming message, in addition to the explicit tool? Leaning no
  for this step: automatic relevance is a tuning problem that will churn for
  months, and the explicit call is the one that can be tested. Worth revisiting
  once there is real usage to tune against.
- **Does `remember` need a size cap per entry, or per agent?** Unbounded growth
  is the failure mode nobody notices until the disk does.
