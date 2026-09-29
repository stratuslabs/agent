# Usage and budgets

Every model call a daemon makes is written to a **usage ledger** in
`~/.stratus/fleet.db`: which agent, which session, which provider and model,
and the four token counts the provider reported. `stratus usage` and
`GET /usage` sum it. A **budget** caps it, per UTC day or month, for the
whole install and per agent, and stops an agent that has spent its share
before the next call rather than after the bill.

## Seeing what was spent

```bash
stratus usage                                   # this UTC month, every agent
stratus usage --since 2026-09-01 --until 2026-09-15
stratus usage --agent ava --format json
stratus usage --config /etc/stratus/config.json   # a daemon started with --config reads its budget there
```

```text
Usage since 2026-09-01 (tokens, as providers reported them):
  ava  anthropic/claude-opus-5  412 call(s)  in 81,203  out 64,510  cache read 3,912,004  cache write 120,331
  bea  openai/gpt-5.5  37 call(s)  in 22,871  out 9,140  cache read —  cache write —
Budget (weighted tokens):
  this install  monthly  1,203,114 of 5,000,000  resets 2026-10-01 00:00 UTC
```

**Tokens, not money.** The counts are the providers' own, bucket by bucket,
and the four buckets stay apart because they are priced apart: input at the
full rate, output at several times that, cache reads at a tenth, cache writes
at a premium. A `—` is a bucket the provider did not report, never a zero.
Turning tokens into a bill is a price table this project does not own — see
[usage accounting](../roadmap/18-usage-accounting.md) for why.

The ledger counts what went through a daemon: `stratus serve`, every
channel, every schedule, every control API message. A `stratus run` or
`stratus chat` at the machine is neither counted nor limited — it is the
operator at the keyboard, with the same keys — and nothing from before the
ledger existed is counted.
Each session still carries its own records (`GET /sessions/:id`), and the
two agree call for call on everything the ledger saw.

## Setting a budget

In a trusted config — `~/.stratus/config.json`, or a file named with
`--config` / `STRATUS_CONFIG`:

```json
{
  "budget": {
    "daily": 2000000,
    "monthly": 30000000,
    "weights": { "outputTokens": 5, "cacheReadTokens": 0.1, "cacheWriteTokens": 1.25 },
    "agents": {
      "scout": { "daily": 200000 }
    }
  }
}
```

| Key | Means |
| --- | --- |
| `daily` | Weighted tokens the whole install may spend per UTC day |
| `monthly` | …per UTC calendar month |
| `weights` | Multiplier per bucket — `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`. A bucket not named counts 1 |
| `agents.<id>.daily`, `.monthly` | One agent's own limit, **in addition to** the install's, never instead of it |

A limit is in **weighted tokens**: each call counts
`inputTokens × w + outputTokens × w + cacheReadTokens × w + cacheWriteTokens × w`.
Weights are how a limit comes to mean what you meant. Without them a long
conversation under prompt caching — mostly cache reads at a tenth of the
input price — would hit a cap at a tenth of the spend you had in mind. Set
them to your provider's price ratios (input 1, and the others relative to
it) and a limit reads as "input-token-equivalents", which converts to money
with one multiplication. Leave a limit out for no limit. A block with no
`daily` or `monthly` anywhere in it — `{}`, or weights alone — caps nothing,
so it refuses nothing either, including under the unrecorded-spend rule
below.

Every limit is a whole number, 1 or more; weights are numbers, 0 or more. A
misshapen block is refused with the key named — a limit silently ignored
would be spend you believe is capped.

**Read live.** The daemon re-reads the block before every model call, so a
raised or lowered limit applies to the very next one — no restart. Under the
trust rule every policy block has: a project-local `stratus.config.json`
naming a budget is ignored, loudly, in favour of `~/.stratus/config.json`.
A config that cannot be read keeps the last budget that could, so an edit
in progress never lifts every limit — and before one has ever been read,
model calls are refused until it can be, since an unknown limit is not the
same as none.

## What an agent that runs out sees

The check runs before each model call, primary and fallback alike, against
everything spent in the window so far. At or past a limit, the call is not
made and the turn ends with a sentence written for whoever is in the
conversation:

> Agent scout has used its daily model budget (200,114 of 200,000 weighted
> tokens), so its model is not being called again until the budget resets
> at 2026-09-30 00:00 UTC. To continue sooner, the operator can raise
> budget.agents.scout.daily in the trusted config.

In Slack that sentence is the reply, as written — not framed as something
having gone wrong, because it is a limit working. The session is saved
`failed`, the message that was not answered stays in it, and the next
message after the reset picks the conversation up. The daemon log records
`session.failed` with `refused: true`; the control API's `session.failed`
event carries the same flag.

Two properties are worth knowing before you rely on a number:

- **One call of overshoot per turn in flight.** What a call will cost is
  not known until it returns, so a budget can only refuse the call *after*
  the one that reached it — and turns running at the same moment each get
  that one call, since each was allowed before the others reported. A
  fallback is not a second call: what a failed primary spent is counted
  before the fallback is allowed. Nor is a crash: a call whose record was
  saved on its session but not yet written to the ledger when the daemon
  died is written by the restarted daemon — as it starts, for the turn the
  crash cut off, and otherwise before that session's next call — dated
  then, and a call is only ever counted once. For a
  harness provider (a Claude subscription through Claude Code, or Codex)
  "one call" is one whole turn, since its inner steps happen inside it.
  Set a limit with that headroom in mind.
- **Unrecorded spend stops budgeted calls.** If the ledger cannot be
  written — a full disk, an I/O error — the usage is held in
  `~/.stratus/usage-held.jsonl` and retried, and while any is held no call
  under a budget with a limit in it is made: a check that cannot see spent tokens would keep
  allowing calls. The hold survives a restart, so a restarted daemon still
  refuses until the held usage is written, and each held call is counted
  once. A disk too full for even that one-line append keeps it in memory
  only: a stop then writes it out whole as a warning, which reaches the
  service manager's log (journald, `docker logs`) for someone to add back,
  and only a crash would lose it; a line of the file cut short by a
  crash is refused, never dropped, until someone repairs it. While any
  usage is held, `stratus usage` says so and exits non-zero, and
  `GET /usage` carries `unrecorded`. The turn is refused with a sentence
  saying so, and calls resume once the held usage is written.
- **The fallback never answers instead.** A spent budget is not a model
  failing, so a configured `fallbackModel` does not take over — it would
  spend exactly what the limit exists to stop, and hide that it was
  reached.

The install's limits are checked before an agent's own, so when both are
spent the message names the wider one. Another agent under its own limit
keeps serving while one agent is stopped.

## From the control API

`GET /usage?since=&until=&agent=` answers with the same rows and, when a
budget is set, every limit's `spent`, `resetsAt`, and `reached`. A
[member token](./remote-access.md#member-tokens) can read it; only the
operator can change the budget, through `PUT /config`, which is how a
hosting control plane sets each tenant's limit — see [Hosting](./hosting.md).
The event stream's `session.usage` event carries each call's records as they
land. See the [control API reference](../../packages/control-api/README.md).
