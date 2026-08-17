# 08 — Deployment Profiles: single-tenant VM, hosted multi-tenant, credential leases

## Goal

Ship the two non-local deployment profiles as configurations of the framework — a single-tenant, wide-access VM deployment and a hosted, locked-down multi-tenant deployment — plus the credential-lease model that high-access deployments need.

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
  - **Metering hooks**: per-turn token/cost accounting (provider usage is already returned by SDKs; surface it on `session.completed` events) so an operator can meter and cap.
  - **Operator-held provider credentials** with per-tenant budget caps, instead of every tenant bringing a key.
- Reference configuration: a restricted tool pack (search/fetch/report — no shell, no fs writes, no browser `act`) demonstrating the locked-down posture.
- Hosting target: a persistent-process platform running the same container image as the VM profile. Serverless stays frontend-only, per the v2 decision.

### C. Credential leases

- A `CredentialResolver` implementation where sensitive credentials are granted as **leases**: `{ scope, expiresAt, maxUses, reason }`, auto-revoked on expiry/use-count/daemon restart, every resolution logged.
- Delegated sub-agents get **sub-leases** that can never exceed the parent's scope or duration (hooks into `agent.delegate`).
- Applied first to the VM profile (where agents hold real third-party credentials); local deployments can adopt it opportunistically.

**Out:** marketplace, org/team accounts and SSO, container isolation as a default (revisit if a deployment's threat model demands it), any product-specific features.

## Design sketch

- The framework/downstream boundary follows one rule: if a hosted deployment needs something a local deployment could also use (metering, namespacing, leases), it lands in the framework; if only a specific service needs it (billing, tenant signup, custom UI), it lands downstream.
- A profile is just configuration — souls + pack config + permission mode + recipe. Proving that no profile requires framework forks is itself an acceptance criterion.
- Leases require **per-use resolution**, not just a wrapped resolver: today `createRuntimeProvider` resolves credentials into raw `apiKey`/`authToken` strings that provider closures hold for every later request, so expiry and use caps would be checked exactly once. This step therefore adds a per-request credential contract — providers accept a credential *source* invoked on each request (or an opaque proxy that fails once revoked) instead of a captured string. `createLeaseResolver(base: CredentialResolver)` still decorates the existing env/file resolvers for grant bookkeeping, and unleased credentials may keep the static path — nothing that works today changes until a credential is marked leased.

## Acceptance criteria

- A VM can be provisioned from the recipe in under an hour: agents live in Slack, browser + shell working under remote approval, backup/restore drill documented and tested once.
- A multi-tenant gateway runs ≥2 isolated tenants: no cross-tenant visibility of sessions, memory, event streams, whitelists, or tool workspaces (tested per resource, including the same-agent-id-in-two-tenants case), per-tenant cost accounting matches provider-reported usage within rounding, a tenant hitting its cap is stopped cleanly with a friendly message.
- A leased credential expires mid-conversation and the agent's next use fails gracefully and visibly; a delegated sub-agent's sub-lease is provably narrower (test at the `agent.delegate` seam).
- The monorepo contains zero billing/signup/tenant-management code.

## Open questions

- Tenant isolation depth: key-prefix namespaces vs. gateway-process-per-tenant. Process-per-tenant is operationally heavier but makes isolation trivial and matches the "one runtime, many deployments" grain — decide against real tenant counts.
- Lease grants: approved at runtime (Slack buttons like 03?) vs. pre-granted at provisioning. Start pre-granted; add runtime grants only when a deployment demands it.
