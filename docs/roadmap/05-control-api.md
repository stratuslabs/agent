# 05 — Control API + Web Dashboard

## Goal

The gateway exposes one HTTP + WebSocket API — the only doorway any surface uses — and the placeholder dashboard becomes a real chat and monitoring UI on top of it.

## Status

**Shipped (#62).** One authenticated HTTP + WS surface, and a dashboard on top
of it. The shape changed in three places worth stating, because each was a
choice this spec left open or made differently.

**Two optional packages, not a server inside the gateway.** The spec puts the
HTTP + WS server in `@stratusagent/gateway`; it landed as
`@stratusagent/control-api` and `@stratusagent/dashboard`, both optional peers
of the CLI in the same way `@stratusagent/channel-slack` is. That is what lets
the API take a real `ws` dependency without weighting the always-on core, and
it settles the naming tension this spec creates: 07 is not a chat app and 08's
headless profile wants the API with no UI at all, so "API without UI" is *not
installing a package*, rather than a `--with-ui` flag on a server that always
contains one. Installing `@stratusagent/control-api` is the opt-in; `--no-api`
and `api.enabled: false` turn it off. `@stratusagent/control-api` holds
everything both the dashboard and the macOS app need; `@stratusagent/dashboard`
holds only assets.

- `/api/v1/...`, deciding the open question in the design sketch in favour of a
  path over a header: 07 pins against it, and a path is visible in a curl, a
  proxy log, and an address bar.
- **The shared rules moved to `@stratusagent/state` first**, in a behaviour-free
  extraction whose proof is that the existing CLI tests pass untouched:
  `applySoulPins` (out of the gateway, which re-exports it), `servedRuntimes`,
  `listAgentSummaries`, `collectAvailableModels`, `verifyProviderKey`,
  `claimSoulFile`, `declaredAgentIds`, `saveConfigFile`. The API answers the
  same questions `stratus agents`, `stratus setup`, and `stratus serve` answer,
  and this repository's most repeated defect is a second copy of a rule that
  already has one implementation.
- **Three gateway seams**, and no more: `dispatch` takes a `turnId` and
  `activeTurnId(sessionId)` reads it (see the gap below), `pendingApprovals()`
  lists the parked set as data rather than settlers, and `reloadRoster()` picks
  up souls added or removed since start — with `AgentRegistry.unregister` in
  the kernel to make removal real.

**Health is computed, never probed.** The spec asks for "provider
reachability"; `GET /health` reports uptime, the roster the daemon is actually
serving, session counts from a grouped `COUNT(*)`, pending approvals, and the
resolved runtimes with the *source* of each credential — all from what the
daemon already knows. A monitoring view polls this endpoint, and a live
provider call per poll would spend the operator's rate limit to report what
resolution already knows. Live reachability, if it is ever wanted, goes behind
`?probe=1`.

**`GET /catalog/tools` is deferred to [06](./06-tool-packs.md)**, where it is
now written into the scope and acceptance criteria rather than left as a
sentence here. Today it could only list the three kernel tools, and it needs a
`gateway.tools()` accessor — an endpoint shaped against no real tool packs
would be shaped by guesses. Everything else in the management group shipped.

**The Slack attribution gap is unblocked, not closed.** The envelope and the
turn ids exist now, so the fix described below is buildable; `packages/channel-slack`
has not been migrated onto them and still queues renderers at intake. That is a
follow-up this step enables and does not own, and it is tracked in
[04](./04-agent-sdk-bridge.md) § Follow-ups this step named but does not own,
beside the adapter's other two.

**Verified end to end** against a real daemon from a source checkout, on the
demo provider: the roster renders, opening an agent lists its sessions, and
sending a message streams deltas and tool status lines live in the browser.

The single-event-stream criterion is proven in pieces rather than in one live
run. `packages/control-api` tests that an approval parked through the gateway
appears in `GET /approvals` and that resolving it there settles the turn;
`packages/channel-slack` already tests that a request settled by something
other than a Slack click has its buttons retracted. Nothing exercises the
whole round trip against a real workspace, which would need a bound Slack app
and so cannot run in CI.

## Why now

Phase 1–2 made the fleet live and trustworthy, but the only ways in are Slack and a local TTY. The control API is what turns the gateway into a platform: the web dashboard consumes it now, the desktop app (07) consumes it next, and the hosted deployment profile (08) is largely *built* on it. (07 has since been rewritten and unscheduled — see [07](./07-desktop-app.md); the note under **Out** below records what that changed for this API.) Today's dashboard (`startDashboardServer` in `packages/cli/src/index.ts`) is an unconnected smoke-test page — good scaffolding, no runtime access.

## Scope

**In:**

- HTTP + WS server in `@stratusagent/gateway` (bare `node:http` + `ws`-level handling; no framework unless it earns its way in), bound to `127.0.0.1` by default:
  - `GET /api/agents` — roster with soul metadata, avatar palette, provider/model resolution, memory counts (what `stratus agents` prints, as JSON).
  - `GET /api/sessions?agent=` / `GET /api/sessions/:id` — list and read durable sessions (raw provider turns redacted via the existing `redactAnthropicRawTurns` before serialization).
  - `POST /api/sessions/:id/messages` — dispatch a user message; response returns immediately with the turn id. Creating a session requires an explicit `agentId` in the body (the runner cannot start a turn without an agent, and a new session has no stored one to recover); an existing session recovers its agent from storage, and a mismatched `agentId` on an existing session is rejected — sessions never cross agent identities.
  - `WS /api/events` — the live `StratusEvent` stream (deltas included), filterable by session/agent. Frames are envelopes `{ sessionId, turnId, event }`: the turn id is assigned at dispatch and returned by the message POST, so a client that queued a message can attribute deltas, failures, and completion to *its* turn even when a session processes several in sequence — `StratusEvent` itself carries no turn identifier, so the envelope supplies it. One stream serves chat rendering, monitoring, and approval UIs alike.
  - `GET/POST /api/approvals` — list pending approvals (03) and resolve them.
  - `GET /api/health` — daemon status, uptime, provider reachability, per-agent state.
  - **Management group** (required by the desktop app in 07; usable by the dashboard): `GET /api/catalog/models` (providers/models reachable with stored sign-ins, live-listed — same logic as setup), `GET /api/catalog/tools` (installed tool packs with risk levels), agent CRUD (`POST /api/agents`, `PUT /api/agents/:id` — soul create/edit with validated frontmatter round-trip), `POST /api/credentials/verify` + `PUT /api/credentials/:provider`, `PUT /api/credentials/channels/:channel` (the gateway-owned service-credential namespace from 02 — Slack app/bot tokens live there, and the provider-credential and config endpoints deliberately cannot write it), `GET/PUT /api/config` (settings, per-agent permission mode, channel bindings), and `POST /api/roster/reload`. Without these, a visual creation-and-settings surface cannot be a thin client. (That surface is now [17](./17-fleet-console.md)'s rather than 07's, and these endpoints serve it unchanged.)
- **Auth**: a bearer token generated into `~/.stratus/gateway-token` (0600) for programmatic clients (CLI, macOS app), which send it as an `Authorization` header. Browsers can do neither — page JavaScript can't read the token file, and the WebSocket API can't attach headers to the upgrade — so the dashboard bootstraps differently: `stratus dashboard` opens the browser at a **one-time-token URL** (`/auth?ott=…`, single-use, short-lived), which the gateway exchanges for an HttpOnly `SameSite=Strict` session cookie; cookies ride along on the WS upgrade, so `/api/events` authenticates the same way. Every endpoint requires a valid bearer token *or* session cookie. Cookie-authenticated access additionally requires **origin binding**: `SameSite` matching ignores ports, so a page served from another port on the same host would carry the cookie automatically, and WebSockets get no CORS protection — the gateway therefore validates the handshake/request `Origin` against its own exact origin on every WS upgrade and every state-changing request made with a cookie, rejecting mismatches (bearer-token requests are exempt; they carry no ambient credential). Localhost binding is the default posture; remote access is the operator's tunnel choice (Tailscale documented as the recommended pattern for reaching a machine at home). No user accounts — that belongs to the hosted profile (08).
- **Web dashboard**: served by the gateway at `/`, replacing the smoke-test page. Single static bundle, no build-step framework lock-in decision needed in this spec — requirements are: roster view with avatars, session list + live chat view (streaming, tool status lines), pending-approvals panel, health strip. Dark, in the existing dashboard's visual direction.
- CLI: `stratus dashboard` now opens the gateway's UI (starting the gateway if needed); remote-client flags (`--gateway <url>`) for `stratus agents` as the first remote-consuming command.

**Out:** multi-user auth/accounts, TLS termination (tunnel's job), mobile layouts beyond basic responsiveness, analytics, the desktop app itself (07).

**One thing 07's rewrite changed here, recorded rather than left to be discovered.** This spec said 07 consumes *exactly* this API, so API-shape questions from that spec resolved here. That is no longer true in one place: 07's onboarding is a [16](./16-templates.md) template picker, and this API has no template endpoint. It needs two — a read, and an **atomic apply carrying a digest of the reviewed preview**, because `POST /agents` accepts only instructions, name, provider, and model, 16 requires the soul and the configuration to commit together, and a confirmation unbound from what was confirmed is not a gate. It also needs a **sign-in capability descriptor**: `GET /credentials` reports which providers exist and what is stored, and `/catalog/models` says nothing until a credential exists, so nothing here tells a fresh-install wizard which providers take an API key, which take a subscription, or which vendor command a subscription spawns — knowledge that would otherwise be copied out of the CLI and drift. The same gap exists for **channel setup**, and the bind route hides it by looking complete: `PUT /credentials/channels/:channel` accepts `agentId`, `appToken`, and `botToken` without describing where they come from, and `GET /credentials` reports only which agents have Slack tokens — while the manifest, the bot scopes and events, the ordered steps through Slack's UI, and the `xapp-`/`xoxb-` prefix checks all live in the CLI. So the descriptor has two sides, not one. And it needs **some way to observe whether a bound channel connected** — a channel verification, or channel state on `/health` — because `PUT /credentials/channels/:channel` stores tokens without checking them, the Slack adapter treats a failed connection as survivable so that one broken app cannot take the fleet down, and `/health` reports agents, sessions, approvals, and runtimes but nothing about channels; an onboarding flow can therefore finish with every call succeeding and the chosen channel dead. Those are 07's dependencies to specify and this API's to grow; nothing else in 07 needs an endpoint that is not already here.

## Design sketch

- The API is a thin projection of gateway internals: routes call the same `dispatch`/store/roster functions the channels use. No logic lives in the HTTP layer.
- Version the API from day one (`/api/v1/...` or an `X-Stratus-Api` header — pick in the PR) since the macOS app will pin against it.
- WS protocol: JSON frames of the existing `StratusEvent` union plus a subscribe/filter envelope — no new event vocabulary.
- The dashboard is intentionally boring tech: static assets embedded in the package (same approach as today's inlined HTML, graduated to real files), `fetch` + WS, no SSR.

## Acceptance criteria

- With `stratusd` running, the dashboard shows the live roster; opening an agent shows its sessions; sending a message renders streaming deltas and tool status lines in real time.
- A pending approval raised from Slack also appears in the dashboard and can be resolved there (and vice-versa), proving the single-event-stream design.
- All endpoints (WS upgrade included) reject requests carrying neither a valid bearer token nor a valid session cookie; the token file is 0600; a one-time URL token is rejected on second use and after expiry.
- A cookie-bearing WS upgrade or state-changing request whose `Origin` is not the gateway's exact origin (e.g. a page on another port of `127.0.0.1`) is rejected.
- `stratus agents --gateway http://127.0.0.1:<port>` returns the same roster as local resolution.
- API integration tests run against an in-process gateway with the demo provider — no network, no real Slack.

## Known gap this step closes

The WS envelope's turn id is not only for clients. `StratusEvent` carries no
turn identifier today, and the Slack adapter already needs one: a renderer is
queued at intake, *before* the gateway starts the turn it belongs to, so a
message arriving while a recovery or the startup sweep is still ahead of it on
the session chain leaves that turn's events looking rendered when they are not.
Two consequences are live in `packages/channel-slack`: events from a turn the
adapter never dispatched are delivered to whichever renderer heads the queue,
and a `session.failed` from such a turn is suppressed rather than reported into
its thread. Both are attribution problems, and `{ sessionId, turnId, event }`
is what resolves them — worth landing the envelope before the dashboard needs
it, since a surface already does.

## Open questions, as settled

- *Does the gateway serve the dashboard always, or behind a `--with-ui` flag for
  headless VM deployments?* Neither: the UI is a package. A daemon serves it if
  `@stratusagent/dashboard` resolves, which makes the headless profile an
  install list rather than a flag.
- *Session write access from the dashboard vs. read-mostly monitoring in v1?*
  Full chat shipped, so this did not have to be traded away.
