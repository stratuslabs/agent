# 08 — Productization: hosted service config, VM recipe, credential leases

## Goal

Turn the two business tracks into shipping configurations of the framework: the hosted growth-research agent (multi-tenant, locked down, sold monthly) and bespoke client agents (single-tenant, wide access, delivered in a VM) — plus the credential-lease model that high-access deployments need.

## Why now

Only after 01–06: both products are compositions of the gateway, channels, permissions, tool packs, and control API. The framework work in this step is deliberately small; most of the effort is recipes, hardening, and one new product repo.

## Scope

**In:**

### A. Client-VM recipe (single-tenant, wide access)

- A documented, repeatable deployment: Docker image for `stratusd` (and a bare systemd unit variant), volume layout for `~/.stratus`, env-based credential injection, log shipping, backup of `sessions.db` + memory + souls, upgrade procedure.
- Default configuration profile: all tool packs including browser and shell, permission engine in `remote` mode with the client's Slack as approver, 1–5 named users.
- Hardening checklist: non-root user, egress notes, no gateway port exposed beyond the tunnel, env scrubbing verified (06).

### B. Hosted growth-research service (multi-tenant, locked down)

- A **separate product repo** that depends on the framework — the monorepo gains no SaaS code. The product supplies: tenant model (each tenant = roster entry/entries + isolated session/memory namespaces), signup/billing (Stripe), a product web UI built on the dashboard components, and the growth-research agent itself (soul + a restricted pack: search/fetch/report — no shell, no fs writes, no browser `act`).
- Framework changes it forces (land them here, in the framework, generically):
  - **Namespace isolation**: session store and memory store scoped per tenant (key-prefix level is acceptable v1; separate DB files per tenant preferred if cheap).
  - **Metering hooks**: per-turn token/cost accounting events (provider usage is already returned by SDKs; surface it on `session.completed` events) so the product can bill and cap.
  - **Operator credentials, not BYO-key**: the service's own provider keys with per-tenant budget caps.
- Hosting: persistent-process platform (Fly.io/Railway/VPS — same container image as the VM recipe). Vercel only for marketing/frontend, per the v2 decision.

### C. Credential leases (from StratusOS's `TEMPORARY_ACCESS_SPEC.md`)

- A `CredentialResolver` implementation where sensitive credentials are granted as **leases**: `{ scope, expiresAt, maxUses, reason }`, auto-revoked on expiry/use-count/daemon restart, every resolution logged. Delegated sub-agents get **sub-leases** that can never exceed the parent's scope or duration (hooks into `agent.delegate`).
- Applied first to the client-VM profile (where agents hold real client credentials); the personal fleet can adopt it opportunistically.

**Out:** marketplace, org/team accounts and SSO, container isolation as a default (revisit if client-VM threat models demand it), any second product.

## Design sketch

- Track the framework/product boundary with one rule: if the hosted product needs something a Mac Mini deployment could also use (metering, namespacing, leases), it lands in the framework; if only the product needs it (billing, tenant signup, product UI), it lands in the product repo.
- The growth-research agent is just a soul + pack config in the product repo — proving the "a business is a configuration" thesis is itself an acceptance criterion.
- Leases wrap, not replace: `createLeaseResolver(base: CredentialResolver)` decorates the existing env/file resolvers, so nothing that works today changes until a credential is marked leased.

## Acceptance criteria

- A client VM can be provisioned from the recipe in under an hour: agent live in the client's Slack, browser+shell working under remote approval, backup/restore drill documented and tested once.
- The hosted service runs ≥2 isolated tenants on one gateway: no cross-tenant session/memory visibility (tested), per-tenant cost accounting matches provider-reported usage within rounding, a tenant hitting its cap is stopped cleanly with a friendly message.
- A leased credential expires mid-conversation and the agent's next use fails gracefully and visibly; a delegated sub-agent's sub-lease is provably narrower (test at the `agent.delegate` seam).
- The framework monorepo contains zero Stripe/tenant-signup/product-specific code.

## Open questions

- Tenant isolation depth for v1 of the SaaS: key-prefix namespaces vs. gateway-process-per-tenant. Process-per-tenant is operationally heavier but makes isolation trivial and matches the "one runtime, many deployments" grain — decide against real tenant counts.
- Lease grants UX: who approves a lease request at runtime (Slack buttons like 03?) vs. pre-granted at provisioning. Start pre-granted; runtime grants only if client work demands it.
