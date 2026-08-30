# 18 — Usage accounting: `usage` on `ProviderResponse`

## Goal

`ProviderResponse` grows a `usage` field, the runner accumulates it with its
attribution intact, and `session.completed` carries the result — so the system
can answer **how many tokens of what kind, from which provider and model**, a
turn and a session consumed.

Tokens, not money. Turning usage into cost is a downstream projection against a
price table this repository does not own; see below.

## Why now

The vendor SDKs return token usage on every response and the adapters throw it
away. `ProviderResponse` is `{ parts }`, so there is no other source: the
completion event cannot report usage, the dashboard cannot show it, and no
budget cap can be enforced because nothing knows what has been spent.

This is [`stratus-v2.md`](../architecture/stratus-v2.md)'s kernel change 7 and
it is currently owned by [08](./08-deployment-profiles.md). It is pulled out
here because it is not a deployment concern. An operator running one daemon on
one machine has the same question — *which agent is spending my tokens* — and
today the answer is the provider's own console with no per-agent breakdown.
It also blocks two things ranked above 08: the session view in
[17](./17-fleet-console.md), and the per-agent daily cap that
[13](./13-search.md) flags as needed "before the first unattended agent, not
after the first bill."

Landing it early is also cheap in a way it will not stay. Every provider
adapter has to be touched, and there are four provider shapes now.

## The accounting unit, named once

Three things get called a "turn" in conversation and they are not the same.
Naming them here is what prevents double counting around retries,
harness-internal calls, resumed sessions, and fallback attempts:

- **Provider call** — one request to one model. The unit a provider reports
  usage for, and the unit attribution is preserved at.
- **Stratus turn** — one pass through the runner. Exactly one provider call for
  the kernel-loop providers; **several** for a harness provider running its own
  inner loop.
- **Session** — the durable conversation. Many turns, possibly across a
  restart, possibly across two providers if the fallback wrapper engaged.

## Scope

**In:**

- **`usage?: TokenUsage` on `ProviderResponse`**, optional, with a shape that
  is the intersection every provider actually reports: input tokens, output
  tokens, and the two cache counters where the provider distinguishes them.
  Absent when the provider does not report — never zero, because zero is a
  measurement and absence is not.
- **Attribution is preserved, not summed away.** What persists is a set of
  records carrying the provider and model each count came from:

  ```ts
  interface UsageRecord {
    provider: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }
  ```

  A flat scalar total would be unusable for the thing this step exists to
  enable. A thousand tokens of one model is not a thousand of another, input
  and output are priced differently, cache reads and writes differ again, and
  the fallback wrapper can cross *providers* inside one session. Collapsing
  those dimensions at write time throws away what no downstream consumer can
  reconstruct. Records are grouped by (provider, model); a session may expose a
  convenience total derived from them, and that total is a view, never the
  stored form.
- **Accumulation in the runner**, across every provider call of a session
  including the calls a harness provider made inside its own loop, emitted with
  `session.completed`.
- **Every adapter populates it**: `provider-anthropic`, `provider-claude-code`,
  `provider-codex`, and the OpenAI-compatible adapter in `providers`. The two
  harness providers are the interesting ones — several provider calls per
  Stratus turn, and each carries its own model.
- **Persistence with the session**, so a past session's usage survives a
  restart and the console can show it, grouped as stored.

**Out:**

- **Currency, and any price table.** Prices are per-model, per-vendor, and
  per-contract; a table living here would be wrong here, silently, and stale
  within a quarter. The attribution this step preserves is exactly what a
  downstream projection needs to do the conversion correctly.
- Budget caps and enforcement. This step supplies the numbers; deciding what to
  do when they get large is a policy question, and 13's design note — a
  per-agent cap in config rather than an approval prompt on every call — is
  where that starts. Separate step.
- Cost as an approval input. [Approvals](../guides/approvals.md) states the
  line deliberately: the risk model grades acting on the world, not spend, and
  a policy that gated on spend would have to gate the conversation itself.
- Any change to what the daemon log records. Usage is not a prompt and not a
  reply, so a count is loggable in principle — but the log is a trace and this
  step does not expand it.

## Design sketch

- Optional on the interface, so a provider that reports nothing stays
  conforming and the field's absence is honest rather than a fabricated zero.
  `exactOptionalPropertyTypes` means it is added by conditional spread; the
  distinction between absent and zero is the whole point of the field.
- Subscription-path providers report tokens even where the operator is not
  billed per token, and that is worth keeping rather than suppressing: it is
  how an operator compares what a run *would* cost across providers, and the
  fallback wrapper crossing providers mid-run makes that a live question.
- Accumulation belongs in the runner rather than in each adapter, for the usual
  reason: four copies of a summing rule is four places for a fallback or a
  retried call to be counted once, twice, or not at all.
- A retried provider call counts, as its own record. Tokens spent on an attempt
  that failed were still spent, and a number that quietly excludes them will
  not reconcile against the provider's own reporting — which is the only
  external check this number has.
- A resumed session accumulates onto what it already had. The stored form is
  the session's records, not the process's.

## Acceptance criteria

- A session against a fake provider reporting known counts emits exactly those
  counts; a two-call session emits both records.
- **A run that falls back to a second provider mid-session reports both
  providers' usage with provider and model intact on each record** — not merged
  into one total. This is the criterion the attribution requirement exists for.
- A harness provider whose inner loop makes three provider calls against two
  models reports both models separately, and the derived total equals their
  sum.
- A provider reporting no usage produces a completion event with the field
  absent, and nothing downstream treats that as zero.
- A retried provider call appears once, and the count is not lost.
- A session's usage survives a daemon restart and reads back grouped as stored;
  a resumed session adds to it rather than replacing it.
- No endpoint and no log line gained a credential or a prompt in the process.

## Open questions

- **Per-agent rollups in the store?** Per-session records are what the runner
  naturally produces. Per-agent-per-day is what an operator asks for and what a
  cap needs, and deriving it by scanning sessions gets slow exactly when a
  fleet is busy. Possibly a small rollup keyed by (agent, provider, model, day),
  possibly not this step.
- **Does `usage` belong on the streaming path too?** A long turn's consumption
  is unknown until it completes, which is fine for accounting and not fine for
  a cap meant to stop a runaway loop. Leaning: completion-only here, and the
  cap step revisits it.
- **Is `model` reliably available at the point the record is written?** For the
  kernel-loop providers, yes. For a harness provider that switched models
  internally, it depends on what the SDK reports back, and where it does not,
  the record carries the provider with `model` absent rather than a guess.
