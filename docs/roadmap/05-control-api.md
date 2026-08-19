# 05 — Control API + Web Dashboard

## Goal

The gateway exposes one HTTP + WebSocket API — the only doorway any surface uses — and the placeholder dashboard becomes a real chat and monitoring UI on top of it.

## Why now

Phase 1–2 made the fleet live and trustworthy, but the only ways in are Slack and a local TTY. The control API is what turns the gateway into a platform: the web dashboard consumes it now, the macOS app (07) consumes it next, and the hosted deployment profile (08) is largely *built* on it. Today's dashboard (`startDashboardServer` in `packages/cli/src/index.ts`) is an unconnected smoke-test page — good scaffolding, no runtime access.

## Scope

**In:**

- HTTP + WS server in `@stratusagent/gateway` (bare `node:http` + `ws`-level handling; no framework unless it earns its way in), bound to `127.0.0.1` by default:
  - `GET /api/agents` — roster with soul metadata, avatar palette, provider/model resolution, memory counts (what `stratus agents` prints, as JSON).
  - `GET /api/sessions?agent=` / `GET /api/sessions/:id` — list and read durable sessions (raw provider turns redacted via the existing `redactAnthropicRawTurns` before serialization).
  - `POST /api/sessions/:id/messages` — dispatch a user message; response returns immediately with the turn id. Creating a session requires an explicit `agentId` in the body (the runner cannot start a turn without an agent, and a new session has no stored one to recover); an existing session recovers its agent from storage, and a mismatched `agentId` on an existing session is rejected — sessions never cross agent identities.
  - `WS /api/events` — the live `StratusEvent` stream (deltas included), filterable by session/agent. Frames are envelopes `{ sessionId, turnId, event }`: the turn id is assigned at dispatch and returned by the message POST, so a client that queued a message can attribute deltas, failures, and completion to *its* turn even when a session processes several in sequence — `StratusEvent` itself carries no turn identifier, so the envelope supplies it. One stream serves chat rendering, monitoring, and approval UIs alike.
  - `GET/POST /api/approvals` — list pending approvals (03) and resolve them.
  - `GET /api/health` — daemon status, uptime, provider reachability, per-agent state.
  - **Management group** (required by the macOS app in 07; usable by the dashboard): `GET /api/catalog/models` (providers/models reachable with stored sign-ins, live-listed — same logic as setup), `GET /api/catalog/tools` (installed tool packs with risk levels), agent CRUD (`POST /api/agents`, `PUT /api/agents/:id` — soul create/edit with validated frontmatter round-trip), `POST /api/credentials/verify` + `PUT /api/credentials/:provider`, `PUT /api/credentials/channels/:channel` (the gateway-owned service-credential namespace from 02 — Slack app/bot tokens live there, and the provider-credential and config endpoints deliberately cannot write it), `GET/PUT /api/config` (settings, per-agent permission mode, channel bindings), and `POST /api/roster/reload`. Without these, 07's creation and settings screens cannot be thin clients.
- **Auth**: a bearer token generated into `~/.stratus/gateway-token` (0600) for programmatic clients (CLI, macOS app), which send it as an `Authorization` header. Browsers can do neither — page JavaScript can't read the token file, and the WebSocket API can't attach headers to the upgrade — so the dashboard bootstraps differently: `stratus dashboard` opens the browser at a **one-time-token URL** (`/auth?ott=…`, single-use, short-lived), which the gateway exchanges for an HttpOnly `SameSite=Strict` session cookie; cookies ride along on the WS upgrade, so `/api/events` authenticates the same way. Every endpoint requires a valid bearer token *or* session cookie. Cookie-authenticated access additionally requires **origin binding**: `SameSite` matching ignores ports, so a page served from another port on the same host would carry the cookie automatically, and WebSockets get no CORS protection — the gateway therefore validates the handshake/request `Origin` against its own exact origin on every WS upgrade and every state-changing request made with a cookie, rejecting mismatches (bearer-token requests are exempt; they carry no ambient credential). Localhost binding is the default posture; remote access is the operator's tunnel choice (Tailscale documented as the recommended pattern for reaching a machine at home). No user accounts — that belongs to the hosted profile (08).
- **Web dashboard**: served by the gateway at `/`, replacing the smoke-test page. Single static bundle, no build-step framework lock-in decision needed in this spec — requirements are: roster view with avatars, session list + live chat view (streaming, tool status lines), pending-approvals panel, health strip. Dark, in the existing dashboard's visual direction.
- CLI: `stratus dashboard` now opens the gateway's UI (starting the gateway if needed); remote-client flags (`--gateway <url>`) for `stratus agents` as the first remote-consuming command.

**Out:** multi-user auth/accounts, TLS termination (tunnel's job), mobile layouts beyond basic responsiveness, analytics, the macOS app itself (07 — but it consumes exactly this API, so API-shape questions from that spec resolve here).

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

## Open questions

- Does the gateway serve the dashboard always, or behind a `--with-ui` flag for headless VM deployments? (Leaning: always; it's static files.)
- Session write access from the dashboard vs. read-mostly monitoring in v1 — full chat is in scope above, but if it drags, monitoring + approvals alone still unblock 07.
