# Credential leases

A soul's `credentials:` list says which keys an agent may **hold**. A lease
says it may **use** one — now, for a while, a bounded number of times, for
a stated reason — and every use is recorded. Leases are for the keys where
holding is not the same as being allowed: a production deploy token, a
billing API, the org-wide GitHub token an incident responder needs for an
hour.

Nothing is leased by default, and a credential not on the list works
exactly as it always did.

## Fencing a credential

List it under `leases` in a trusted config:

```json
{
  "leases": {
    "credentials": ["github.token", "stripe.apiKey", "provider:anthropic"]
  }
}
```

Two kinds of name:

- A **named credential** — anything `stratus credentials` lists, the keys
  tools and plugins resolve through the agent's `credentials:` list.
- A **provider sign-in**, as `provider:anthropic`, `provider:openai`, or
  `provider:codex`. Then every model call the agent makes on that sign-in
  needs a lease — the key the daemon holds in its environment or in
  `credentials.json` included.

From then on, a use with no live lease is refused. The block is re-read
before every use — by the daemon, and by a `stratus run` or `stratus chat`
already open — so fencing a key applies to its next use, with no restart. If the config cannot be read and no list was ever read, every
credential is refused until it can be — "unknown" is never taken to mean
"nothing is leased".

## Granting, listing, revoking

```bash
stratus lease grant ava github.token --for 2h --uses 20 --reason "incident 412: roll back the release"
stratus lease list                    # active leases (also: stratus leases)
stratus lease list --all              # expired, used-up, and revoked ones too — the record
stratus lease revoke lease_3f9c0a1b2c3d4e5f
```

| Field | Rule |
| --- | --- |
| `--for` | Required. `30m`, `2h`, `7d` — at most 90 days. A lease that never ends is a standing grant, and the soul's `credentials:` list already is one |
| `--uses` | Optional. The most uses it pays for; without it, unlimited inside its window |
| `--reason` | Required. The audit trail without a reason is a list of ids |

The commands work on `fleet.db` directly, daemon or not, and each change is
one atomic statement: the daemon reads the lease row on every use, so a
revoke is the very next use's answer. The control API has the same three —
`GET /leases`, `POST /leases` (operator only), `POST /leases/:id/revoke` —
recording who granted or revoked as `api:<name>` or `dashboard:<name>`.

A lease does not replace the soul: the agent's `credentials:` list still has
to name a named credential, and it is checked first. A lease granted to an
agent whose soul does not list the key is never used.

## What a use costs, and what a refusal looks like

A **use** is one resolution of the key: one tool call that reaches for it
(one `web.search`, say), or one model call on a leased sign-in — which, for
an agent looping through tools, is one per step of the loop. For a harness
provider (Claude Code, Codex) it is one per turn. When an agent holds more
than one live lease on a key, the one expiring soonest is spent first.

With no live lease, nothing is sent with the key. A tool gets the refusal as
its result, so the agent can say what happened; a model call ends the turn
with it, shown in Slack as written. Either way it names the lease and the
fix:

> Agent ava's lease on github.token (lease_3f9c0a1b2c3d4e5f) expired at
> 2026-09-29T16:00:00.000Z, so the key was not used. An operator can grant a
> new one with `stratus lease grant ava github.token --for 1h --reason "…"`.

A leased sign-in that runs out is not a model failing, so a configured
fallback model does not answer instead.

**Every use is recorded**, allowed or refused, as a `credential.leased`
event: the credential's name, the lease that paid, what it was used for
(`web.search`, `provider`), and for a refusal its sentence. It is in
[`stratus logs`](./logs.md) and on the control API's event stream. The key
never is.

A restart neither resets a lease's count nor extends it: uses are counted in
`fleet.db` as they happen.

## Delegation: a sub-lease, never more than the parent

When an agent holding a lease hands work to another with `agent.delegate`,
the delegate borrows it as a **sub-lease** for that one task:

- it expires no later than the lease it draws on;
- it pays for no more uses than that lease had left;
- it works only in the one sub-session the delegation opened;
- every use also spends one of the parent's, so a delegate cannot stretch
  a limit by being the one who uses it;
- revoking, expiring, or using up the parent ends it at once;
- and it is gone when the delegated turn is — or with the daemon, since it
  is never written down. A delegated turn that resumes after a restart has
  only the delegate's own leases.

The delegate's own leases come first; a sub-lease is what the delegator
lends on top, for this task. `GET /leases` lists live sub-leases with their
`parentId` and `sessionId` — and with the `state` a use would find, so one
whose parent has ended is listed as ended, not `active` — and
`POST /leases/<sub-id>/revoke` ends one —
and any lent on from it — while the task is still running. `stratus lease
list`, which reads the file, shows only granted ones. A delegate whose
borrowed lease has ended is told that, not that it holds none.

## When to use this, and when not

Leases answer "this agent may use this key, for this long, and I want every
use on the record". They are pre-granted by an operator — at the machine or
through the API — rather than requested mid-turn. For keys an agent should
simply always hold, leave them off the list: the soul's `credentials:` list
is that grant. For deciding whether a *tool call* may run at all, see
[Approvals](./approvals.md); a lease is about the key, not the call.
