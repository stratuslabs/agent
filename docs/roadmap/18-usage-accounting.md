# 18 — Usage accounting: `usage` on `ProviderResponse`

## Goal

`ProviderResponse` grows a `usage` field, the runner accumulates it across a
session, and `session.completed` carries the total — so the system can answer
what a turn, a session, and an agent cost.

## Why now

The vendor SDKs return token usage on every response and the adapters throw it
away. `ProviderResponse` is `{ parts }`, so there is no other source: the
completion event cannot report a cost, the dashboard cannot show one, and no
budget cap can be enforced because nothing knows what has been spent.

This is [`stratus-v2.md`](../architecture/stratus-v2.md)'s kernel change 7 and
it is currently owned by [08](./08-deployment-profiles.md). It is pulled out
here because it is not a deployment concern. An operator running one daemon on
one machine has the same question — *which agent is spending my tokens* — and
today the answer is the provider's billing page with no per-agent breakdown.
It also blocks two things ranked above 08: the session view in
[17](./17-fleet-console.md), and the per-agent daily cap that
[13](./13-search.md) flags as needed "before the first unattended agent, not
after the first bill."

Landing it early is also cheap in a way it will not stay. Every provider
adapter has to be touched, and there are four provider shapes now.

## Scope

**In:**

- **`usage?: TokenUsage` on `ProviderResponse`**, optional, with a shape that
  is the intersection every provider actually reports: input tokens, output
  tokens, and the two cache counters where the provider distinguishes them.
  Absent when the provider does not report — never zero, because zero is a
  measurement and absence is not.
- **Accumulation in the runner**, across every turn of a session including
  turns a harness provider ran inside its own loop, emitted with
  `session.completed`.
- **Every adapter populates it**: `provider-anthropic`, `provider-claude-code`,
  `provider-codex`, and the OpenAI-compatible adapter in `providers`. The two
  harness providers are the interesting ones — their inner loops make several
  model calls per Stratus turn, and the number that matters is the sum.
- **Persistence with the session**, so a past session's cost survives a
  restart and the console can show it.
- **Tokens, not currency.** A price table is a per-model, per-vendor,
  per-contract thing that goes stale silently and would have to live in this
  repository to be wrong in it. Tokens are what the provider reports and what
  every downstream conversion needs.

**Out:**

- Budget caps and enforcement. This step supplies the number; deciding what to
  do when it gets large is a policy question, and the design note from 13 —
  a per-agent cap in config rather than an approval prompt — is where that
  starts. Separate step.
- Cost as an approval input. [Approvals](../guides/approvals.md) states the
  line deliberately: the risk model grades acting on the world, not spend, and
  a policy that gated on cost would have to gate the conversation itself.
- Any change to what the daemon log records. Usage is not a prompt and not a
  reply, so a count is loggable in principle — but the log is a trace and this
  step does not expand it.

## Design sketch

- Optional on the interface, so a provider that reports nothing stays
  conforming and the field's absence is honest rather than a fabricated zero.
  `exactOptionalPropertyTypes` means it is added by conditional spread; the
  distinction between "absent" and "zero" is the whole point of the field.
- Subscription-path providers report tokens even where the operator is not
  billed per token, and that is worth having rather than suppressing: it is how
  an operator compares what a run *would* cost across providers, and the
  fallback wrapper crossing providers mid-run makes that a live question.
- Accumulation belongs in the runner rather than in each adapter, for the usual
  reason: four copies of a summing rule is four places for a fallback or a
  retried turn to be counted once, twice, or not at all.
- A retried turn counts. Tokens spent on an attempt that failed were still
  spent, and a number that quietly excludes them will not reconcile against the
  provider's own bill — which is the only external check this number has.

## Acceptance criteria

- A session against a fake provider reporting known counts emits exactly those
  counts on `session.completed`; a two-turn session emits the sum.
- A harness provider whose inner loop makes three model calls reports the total
  for the Stratus turn, not the last call's.
- A provider reporting no usage produces a completion event with the field
  absent, and nothing downstream treats that as zero.
- A run that falls back to a second provider mid-session reports both
  providers' tokens in the total.
- A session's usage survives a daemon restart and reads back from the store.
- No endpoint and no log line gained a credential or a prompt in the process.

## Open questions

- **Per-agent or per-session totals in the store?** Per-session is what the
  runner naturally produces. Per-agent-per-day is what an operator asks for and
  what a cap needs, and deriving it by scanning sessions gets slow exactly when
  a fleet is busy. Possibly a small rollup, possibly not this step.
- **Does `usage` belong on the streaming path too?** A long turn's cost is
  unknown until it completes, which is fine for accounting and not fine for a
  cap that is supposed to stop a runaway loop. Leaning: completion-only here,
  and the cap step revisits it.
