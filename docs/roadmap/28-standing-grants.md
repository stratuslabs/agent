# 28 — Standing grants: "always allow" means one thing everywhere

## Goal

An operator's "always allow" produces a **durable, per-agent grant** whatever
it was answering — a shell command or any other gated tool — instead of one
answer that survives a restart and another that dies with the session.

## Why now

There are two "always allow"s today and they behave differently:

- **A command scope** is durable and per-agent. It lands in
  `~/.stratus/agents/<id>.whitelist.json` and is consulted on every later run,
  including unattended ones.
- **A tool-wide always** is a `Set` keyed by `sessionKey(session.id, toolName)`.
  It lasts as long as the session and is gone after a restart.

An operator cannot tell which they got. Both are the same button and the same
sentence, and the difference only shows up later, as an agent asking again for
something the operator remembers permanently allowing — or as an unattended
firing that fails at 3am for a tool that worked all afternoon.

It also leaves a hole with no floor under it. In `headless` — what every
installed service runs — a `gated` call is approved by exactly two things: a
matching command scope, or a schedule's destination pre-authorization. A gated
tool with neither has **no path to running unattended at all**, no matter what
the operator has approved in the past. That is not a policy decision anybody
made; it is a gap between two mechanisms.

Two steps already run into it. [24](./24-sub-agents.md) needs a sub-agent to
inherit its parent's standing permissions, and can only inherit command scopes
today. [26](./26-fleet-introspection.md) had to argue its way around the gap
rather than through it.

## Scope

**In:**

- **A durable per-agent tool grant**, stored beside the command scopes it
  already keeps, consulted in the same place, and surviving restarts.
- **One vocabulary.** "Always allow" means the same thing in the CLI prompt, in
  Slack, and in [17](./17-fleet-console.md): granted for this agent until
  revoked. A one-turn answer is "allow once" and says so.
- **Revocation, and somewhere to see what is granted.** A standing grant nobody
  can list is one nobody can audit, and a grant nobody can remove is a
  ratchet. Both the CLI and the console.
- **The grant is per (agent, tool).** Not fleet-wide, not per session. An
  operator saying yes for one agent is not saying yes for its teammates —
  which is the whole reason the roster has separate identities.

**Out — and these three are the security argument, not scoping preferences:**

- **Never for a tool that exposes `commandFor`.** A shell tool's risk lives in
  its *argument*, not its identity, and the engine already resolves the
  command first "so that the tool-wide `always` below can never apply to it:
  one yes to `git status` must not become a standing yes to every command the
  shell can run." A durable tool grant for `shell.run` would be exactly the
  standing yes that comment exists to prevent. Shell keeps command scopes;
  everything else gets tool grants; nothing gets both.
- **Never for `dangerous` — and this is a deliberate tightening, not a
  preserved invariant.** Today the tool-wide "always" has no risk guard, so a
  `dangerous` tool can already receive a session-scoped grant; "always a human,
  in every mode" is really *always a human the first time, and not necessarily
  again within that session*. Making that grant durable would stretch a
  once-per-session concession into a permanent one, which is a different
  decision than the one anybody made. If a standing grant for `dangerous` is
  wanted later it should be argued for on its own, not inherited from this
  step.

  The narrower question — whether `browser.act` should be `dangerous` at all —
  was a real one and has since been answered where it belonged, with the tool:
  `dangerous` was standing in for *no scope model exists for this* rather than
  for *categorically worse than a shell*, and per-origin scopes gave it one, so
  it is `gated` and judged per site ([browser actions](../guides/browser.md)).
  Nothing first-party declares `dangerous` now — the tier is what an operator's
  `toolRisks` or a plugin's manifest uses to say "never unattended" about
  somebody else's code — so the exclusion above is written for those, and the
  same structural rule already holds for `originFor` as for `commandFor`: a
  tool that offers either never receives a tool-wide grant.
- **Not a config key.** A grant is something an operator answered in front of a
  specific request, with the risk in front of them. A list in a config file is
  a different object with different provenance, and if that is wanted it is
  the soul's allowlist, which already exists.

## Design sketch

- The check belongs where the session-scoped one already sits — before the
  `headless` refusal, after the command-scope resolution — so ordering keeps
  the `commandFor` exclusion structural rather than a rule to remember.
- **A grant is scoped to the tool as it was when granted.** A tool that later
  changes what it does under the same name is not the tool the operator said
  yes to; a third-party plugin update is the realistic case. Recording the
  contributing package with the grant is cheap now and the only thing that
  makes the question answerable later.
- Storage sits with the command whitelist rather than beside it in a second
  file — one place an operator looks to see what an agent may do unattended.
- The daemon log records that a standing grant was used, not just that a tool
  ran. A grant is how something happened unattended, and that is exactly what
  someone reconstructing an incident needs.
- **`safe` tools need no grant and must not acquire one.** Nothing about this
  step changes what runs without asking.

## Acceptance criteria

- Answering "always allow" for a gated tool, then restarting the daemon, runs
  that tool for that agent without asking.
- The same grant does not apply to another agent.
- "Allow once" does not persist.
- A tool exposing `commandFor` cannot receive a tool grant — asserted, since
  this is the invariant most likely to be lost in a refactor.
- A `dangerous` tool cannot receive one.
- A granted tool runs in `headless` mode; an ungranted gated one is still
  refused there.
- Grants list and revoke from both the CLI and the console, and a revoked
  grant stops working without a restart.
- The log distinguishes a call that ran under a standing grant from one that
  ran because it was `safe`.

## Open questions

- **Does this change [26](./26-fleet-introspection.md) back to `gated`?** It
  makes `gated` workable there, which it was not before. The argument for
  `safe` does not depend on that and should be re-read on its own terms: the
  risk model grades acting on the world, and a fleet read acts on nothing. The
  counter is that an explicit grant is a better record of the operator's
  intent than an allowlist entry. Worth settling deliberately rather than
  inheriting whichever answer was convenient.
- **Should a grant expire?** A standing yes that is a year old was given
  against a different fleet. [08](./08-deployment-profiles.md)'s lease model —
  scope, expiry, use count, reason — is the shape if one is wanted, and it may
  be too much machinery for a single-operator install.
- **Does the grant survive an agent being deleted and its id reused?** Ids are
  a validated invariant and reuse is possible. A grant outliving its agent and
  landing on a different one is a small, ugly failure.
