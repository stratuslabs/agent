# 08 — Deployment Profiles: single-tenant VM, hosted multi-tenant, credential leases

## Goal

Ship the two non-local deployment profiles as configurations of the framework — a single-tenant, wide-access VM deployment and a hosted, locked-down multi-tenant deployment — plus the credential-lease model that high-access deployments need.

## Shipped

All three parts, in one PR, with the decisions the spec left open made and
two places where the design sketch was changed on contact with the code.
Each is recorded here so the next reader does not re-derive it.

**A — the VM profile** is a recipe plus two small CLI additions. An image
built from a checkout (`deploy/docker/Dockerfile`: non-root, one volume for
the home, `stratus health` as its healthcheck, a `browser` target with
Chromium), a hardened compose file, and a system-level systemd unit for a
bare VM (`deploy/systemd/`). `stratus serve --log-format json` writes the
structured log's records to stdout for docker logging drivers, journald, or
a shipper, and `stratus health` gives probes something to call. The guide is
[Deployment](../guides/deployment.md): volume layout, what can and cannot
come from the environment, log shipping, upgrade, the hardening checklist,
and a backup/restore drill that was run once against the image. The default
configuration is `examples/profiles/vm`. Backup stays the copy-with-the-daemon-stopped
the state layout already documents: [33](./33-backups.md) automates it and is
its own step, so this one does not build a second backup.

**B — hosted multi-tenant: a tenant is a cell.** The open question,
key-prefix namespaces against a process per tenant, went to the process,
and more precisely to **one home, one daemon, one container per tenant**.
[15](./15-agent-isolation.md) layer A had already made every durable
resource keyed by the home. A tenant key threaded through one process
would have had to reach the roster, both session stores, memory,
credential resolution, grants, workspaces, browser contexts, MCP server
processes, plugin state, and the bus, and "any resource without a tenant key
is an isolation bug" would have been a promise kept by review forever. Cells
keep it structurally: no cell has a handle on another's files, sockets, or
bus. It is also where the field settled for mutually untrusted tenants
(OpenClaw's documented multi-tenant hosting is containers per tenant and
calls one gateway "not a hostile multi-tenant security boundary"; LangGraph's
owner-filtered model is key-prefix filtering in application code, the
shape rejected here). What landed in the framework is
only what a local install can use too:

- **Tenant-bound authentication as a role.** Every token a cell accepts is
  bound to that cell by construction, so what was missing was not a tenant
  claim but least privilege: `stratus token create` mints a **member**
  token (only its hash stored, in `api-tokens.json`), and the route table
  fails closed. A member may do everything except the five routes that reach
  past the operator's policy: `PUT /config`, `PUT /credentials/:provider`,
  `POST /credentials/verify`, `POST /restart`, and `POST /leases`. Without
  that, a tenant holding a cell's only token could point the operator's key
  at its own server through `baseUrl`, or enable `tool-shell`. A tenant id is
  never read from a request, because a cell has only one tenant. Two member
  routes check inside the handler, because review found them reaching past
  the operator without changing any policy. A soul may gain only the
  agent's *own* stored credentials, never the operator's shared ones. A
  channel binding may be added but not replaced. What a member reaches is
  bounded by the plugins the operator loaded, and not by less: a member
  who edits souls and answers approvals can drive any loaded tool. With a
  shell loaded, that includes the machine. The docs say so, and the hosted
  profile loads no such tool.
- **Metering**: [18](./18-usage-accounting.md) had shipped the usage
  records, and this step adds the rest. A `session.usage` kernel event
  announces each provider call's records before the next call. A usage
  ledger in `fleet.db` keeps them with a timestamp and the agent (a session's
  records carry neither, and a budget is a statement about a window).
  `GET /usage` and `stratus usage` read it. Tokens, never money.
- **Budget caps**: a trusted `budget` block in weighted tokens, per UTC day
  and month, for the home and per agent. It is read live, so a control plane
  sets a tenant's limit with `PUT /config`. It is checked before every
  provider call, and a breach throws `BudgetExceededError`. Its sentence names
  the limit, the reset, and the key. The runner marks the failure
  `refused`, the fallback wrapper does not answer instead, and Slack posts
  the sentence without "Something went wrong". The kernel gained
  `HostRefusalError` for exactly this. The cost of judging before a call is
  one call of overshoot, and for a harness provider that is one turn.
  [Usage and budgets](../guides/usage-and-budgets.md) says so.
- **Operator-held provider keys** needed no new mechanism, only the two
  above. The key lives in the cell's environment, and a member can neither
  read it, redirect it, nor displace it. The budget bounds what it spends.
- **The reference configuration** is `examples/profiles/hosted`: fetch-only
  tools, `headless` approvals with `web.fetch` lowered to `safe` by the
  operator's `toolRisks` (a cell has no Slack approver to ask), a budget,
  and a tighter `maxTurns`. The guide is [Hosting](../guides/hosting.md).
  Hosting target: the same image, one container per cell.

**C — credential leases.** A trusted `leases.credentials` list fences named
credentials and provider sign-ins (`provider:anthropic`). A fenced key costs
a use of a live lease `{ agent, credential, expiresAt, maxUses?, reason }`,
granted with `stratus lease grant` or `POST /leases` (operator only).
Leases are stored in `fleet.db` with one atomic `UPDATE … RETURNING` per use,
so a CLI revoke and a daemon's use cannot double-count. Every use is a
`credential.leased` event, allowed or refused. `CredentialResolver.resolve`
gained an optional use context (the session and what the key is for),
which a sub-lease needs and which web.search and provider-openai pass.
Two deviations from the design sketch:

- **Restart neither revokes nor resets a lease.** The spec asked for both
  "auto-revoked on daemon restart" and "start pre-granted". Those cannot
  both hold: an operator's pre-granted lease would then die at every crash
  restart, at 3am, and a use count held in memory would reset at every
  restart, which would make `maxUses` mean nothing. Leases are durable and
  bounded by a required expiry of at most 90 days. The thing that does die
  with the process is the **sub-lease**, which is never written down.
- **The per-request check is a guard on each provider, not a credential
  source threaded into four adapters.** The sketch's concern was that a
  pooled provider holds its key for every later request, so an expiry would
  be checked once. `createRuntimeProvider` now takes a `ProviderCallGuard`
  and wraps each leaf provider (primary and fallback separately, since they
  spend different sign-ins) so the lease is judged on every `generate`.
  That meets the requirement without changing any adapter's shape. For the
  kernel-loop adapters it is per model call; for a harness it is per turn.
  The key still sits in the pooled provider's memory, as it did. Moving it
  out belongs to [15](./15-agent-isolation.md) layer B's runtime process,
  not here.

**Sub-leases** are minted at the `agent.delegate` seam in the gateway,
where the delegator's session and the delegate's sub-session are both
known. Each is clamped explicitly rather than only cascaded (Vault clamps
nothing at creation and relies on cascade revocation): an expiry no later
than the parent's, uses no more than the parent had left, and one
sub-session only. Every use also charges the parent, a parent revoked or
spent ends its sub-leases at once, and a sub-lease is dropped when the
delegated turn settles. The delegate's own leases come first. A named
credential still needs the delegate's own soul to list it, since the
allowlist runs before any lease.

Of the open questions: **cells, not namespaces** (above). **Leases are
pre-granted** at provisioning or at the machine, by an operator, and
runtime grants from Slack wait for a deployment that asks for them.

## Why now

Only after 01–06: both profiles are compositions of the gateway, channels, permissions, tool packs, and control API. The framework work in this step is deliberately small; most of the effort is recipes and hardening.

## Scope

**In:**

### A. Single-tenant VM profile (wide access)

- A documented, repeatable deployment: Docker image for `stratusd` (and a bare systemd unit variant), volume layout for `~/.stratus`, env-based credential injection, log shipping, backup of `sessions.db` + memory + souls, upgrade procedure.
- Default configuration: all tool packs including browser and shell, permission engine in `remote` mode with a designated Slack approver, a handful of named users.
- Hardening checklist: non-root user, egress notes, no gateway port exposed beyond the tunnel, env scrubbing verified (06).

### B. Hosted multi-tenant profile (locked down)

- Anything specific to a hosted offering (billing, signup, custom UI) lives in a **separate downstream repo** that depends on the framework — this monorepo gains no service code. What lands here is only the generic capability a multi-tenant gateway needs:
  - **Namespace isolation**: a tenant id threads through **every** gateway-owned resource, not just data at rest — roster and agent identities, session store, memory store, credential and permission resolution, persistent whitelists, tool workspaces and browser contexts, and event-stream authorization (subscriptions are tenant-filtered; two tenants using the same agent id must never share capabilities or observe each other's events). Key-prefix scoping is acceptable v1 (separate DB files per tenant preferred if cheap), but the scope requirement is total: any resource without a tenant key is an isolation bug.
  - **Tenant-bound authentication**: filtering by tenant id only isolates if the id comes from the authenticated principal. The hosted profile replaces step 05's single gateway-wide token with per-tenant credentials — each API token/session is minted for exactly one tenant, the authorization context carries that tenant id, and every request and event subscription is scoped by it server-side. A tenant id is never accepted from a client-supplied parameter. (A trusted downstream auth boundary — the service frontend authenticating users and asserting tenant identity over a private link — is an acceptable variant; process-per-tenant sidesteps the problem entirely and remains the open-question alternative.)
  - **Metering hooks**: a `usage` field on `ProviderResponse` — the vendor SDKs return token usage today but our adapters discard it, and the completion event has no other source for it — which the runner accumulates per session and emits with `session.completed`. That provider-to-kernel contract is what makes per-turn metering and budget caps accurate enough to bill and to actually stop a capped tenant.
  - **Operator-held provider credentials** with per-tenant budget caps, instead of every tenant bringing a key.
- Reference configuration: a restricted tool pack (search/fetch/report — no shell, no fs writes, no browser `act`) demonstrating the locked-down posture.
- Hosting target: a persistent-process platform running the same container image as the VM profile. Serverless stays frontend-only, per the v2 decision.

### C. Credential leases

- A `CredentialResolver` implementation where sensitive credentials are granted as **leases**: `{ scope, expiresAt, maxUses, reason }`, auto-revoked on expiry/use-count/daemon restart, every resolution logged.
- Delegated sub-agents get **sub-leases** that can never exceed the parent's scope or duration (hooks into `agent.delegate`, which step 01 wires into the gateway runtime).
- Applied first to the VM profile (where agents hold real third-party credentials); local deployments can adopt it opportunistically.

**Out:** marketplace, org/team accounts and SSO, container isolation as a default (revisit if a deployment's threat model demands it), any product-specific features.

## Design sketch

- The framework/downstream boundary follows one rule: if a hosted deployment needs something a local deployment could also use (metering, namespacing, leases), it lands in the framework; if only a specific service needs it (billing, tenant signup, custom UI), it lands downstream.
- A profile is just configuration — souls + pack config + permission mode + recipe. Proving that no profile requires framework forks is itself an acceptance criterion.
- Leases require **per-use resolution**, not just a wrapped resolver: today `createRuntimeProvider` resolves credentials into raw `apiKey`/`authToken` strings that provider closures hold for every later request, so expiry and use caps would be checked exactly once. This step therefore adds a per-request credential contract — providers accept a credential *source* invoked on each request (or an opaque proxy that fails once revoked) instead of a captured string. `createLeaseResolver(base: CredentialResolver)` still decorates the existing env/file resolvers for grant bookkeeping, and unleased credentials may keep the static path — nothing that works today changes until a credential is marked leased.

## Acceptance criteria

- A VM can be provisioned from the recipe in under an hour: agents live in Slack, browser + shell working under remote approval, backup/restore drill documented and tested once. **Met as far as a sandbox can take it**: the image was built and started from the recipe, answered `stratus health` and a message through the API, and survived the backup/restore drill exactly as [Deployment](../guides/deployment.md) documents it. The Slack half needs a real workspace and was not exercised here.
- A multi-tenant gateway runs ≥2 isolated tenants: no cross-tenant visibility of sessions, memory, event streams, whitelists, or tool workspaces (tested per resource, including the same-agent-id-in-two-tenants case), per-tenant cost accounting matches provider-reported usage within rounding, a tenant hitting its cap is stopped cleanly with a friendly message. **Met**: `packages/control-api/test/tenancy.test.ts` runs two cells with the same agent id and session id, resource by resource, tokens and the event stream included. The ledger's totals equal the sessions' records call for call (`packages/gateway/test/deployment.test.ts`). A capped cell is refused with its sentence while the other serves.
- A leased credential expires mid-conversation and the agent's next use fails gracefully and visibly; a delegated sub-agent's sub-lease is provably narrower (test at the `agent.delegate` seam). **Met**: a lease used up mid-conversation refuses the next call with a `refused` failure naming the lease, and a revoke from another process is the very next use's answer. At the delegate seam, the sub-lease observed during the delegated call has an expiry no later than its parent's, fewer uses than the parent had left, and one sub-session. Its uses are charged to the parent, and it is gone when the task is.
- The monorepo contains zero billing/signup/tenant-management code. **Met**: a cell is configuration. Signup, billing, and the control plane are the downstream service's, and [Hosting](../guides/hosting.md) says what that service does per cell.

## Open questions

- Tenant isolation depth: key-prefix namespaces vs. gateway-process-per-tenant. Process-per-tenant is operationally heavier but makes isolation trivial and matches the "one runtime, many deployments" grain — decide against real tenant counts.
- Lease grants: approved at runtime (Slack buttons like 03?) vs. pre-granted at provisioning. Start pre-granted; add runtime grants only when a deployment demands it.
