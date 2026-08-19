# @stratusagent/control-api

One authenticated HTTP + WebSocket surface over a running `stratusd`. It is
the only doorway any surface uses: the web dashboard consumes it, the macOS
app consumes it, and a hosted deployment is largely built on it.

Optional on purpose. `stratusd` runs without it, and installing it is how you
say you want a port open — which is also what lets it carry a real WebSocket
dependency without weighting the always-on core.

```bash
npm install -g @stratusagent/control-api
stratus serve                       # binds http://127.0.0.1:4123
```

The **web UI is a separate package** (`@stratusagent/dashboard`). This one
serves `/api/v1` and nothing else, because its other two consumers — the
macOS app and a headless VM — want the API and not a web page.

## Authentication

Two credentials, one check. Every endpoint requires one of them.

**Bearer token** — generated into `~/.stratus/gateway-token` (0600) the first
time the API binds. Programmatic clients read the file and send it:

```bash
curl -H "Authorization: Bearer $(cat ~/.stratus/gateway-token)" \
  http://127.0.0.1:4123/api/v1/agents
```

**Session cookie** — a browser can do neither half of that: page JavaScript
cannot read the token file, and a WebSocket upgrade cannot carry an
`Authorization` header. So `stratus dashboard` mints a **one-time token** and
opens the browser at it:

```
POST /api/v1/auth/ott          → { ott, url }          (bearer only)
GET  /api/v1/auth/session?ott= → 302 /, Set-Cookie      (single use, 60s)
```

The cookie is `HttpOnly`, `SameSite=Strict`, and rides along on the WebSocket
upgrade, so `/api/v1/events` authenticates the same way. It carries no
`Secure` flag: the gateway serves plain HTTP on loopback, and a `Secure`
cookie would simply never be sent back — the flag would read as hardening
while breaking every request. TLS is a tunnel's job.

Sessions live in memory, so restarting the daemon signs the browser out. Run
`stratus dashboard` again.

**Origin binding.** `SameSite` matching ignores ports, so a page served from
another port on the same host counts as the same site and its requests carry
the cookie automatically — and WebSockets get no CORS protection at all. So
every WS upgrade and every state-changing request *made with a cookie* is
checked against this gateway's exact origin, port included. Bearer requests
are exempt: nothing attaches that header on a page's behalf, so there is no
ambient authority to forge.

Localhost binding is the posture. Remote access is the operator's tunnel
decision — Tailscale is the pattern we recommend for reaching a machine at
home. There are no user accounts; that belongs to a hosted deployment.

## Endpoints

Everything is under `/api/v1`. A path prefix rather than a header, because
the macOS app pins against it and a version you can see in a curl, a proxy
log, and an address bar is one that gets noticed when it changes.

| Method | Path | What |
| --- | --- | --- |
| GET | `/health` | Uptime, roster, session counts, pending approvals, resolved runtimes |
| GET | `/agents` | The roster as data — soul metadata, avatar palette, resolved provider/model, memory counts, activity |
| POST | `/agents` | Create an agent: writes a soul file and reloads the roster |
| PUT | `/agents/:id` | Edit a soul, by field or as raw markdown |
| POST | `/roster/reload` | Re-read the agents directory and the configured default soul |
| GET | `/sessions?agent=&limit=` | Durable sessions, newest first. `limit` bounds the result — the table grows for the life of an install |
| GET | `/sessions/:id` | One session, provider replay state stripped |
| POST | `/sessions/:id/messages` | Dispatch a message; returns `202 { sessionId, turnId }` |
| GET | `/approvals` | Calls parked on a human right now |
| POST | `/approvals` | Resolve one: `{ requestId, answer, actor? }` |
| GET | `/catalog/models` | Models the stored sign-ins can actually reach, listed live |
| GET | `/credentials` | Which sign-ins exist — presence and endpoint, never a value |
| POST | `/credentials/verify` | Live-check a key before storing it |
| PUT | `/credentials/:provider` | Store an `api_key` or `oauth_token` |
| PUT | `/credentials/channels/:channel` | Store a channel's tokens (today: `slack`) |
| GET/PUT | `/config` | Settings, whitelisted to keys this API owns |

`PUT /config` **replaces** the file rather than merging into it — `GET` hands
you the whole document and `PUT` takes the whole document back, so a partial
body silently drops the keys it omits. It edits the config the operator chose:
the file the daemon was pinned to with `--config`, or the global
`~/.stratus/config.json`. Never an auto-discovered project-local
`stratus.config.json` — that file ships in a repository, and writing settings
into somebody's checkout because the daemon started there would surprise
everyone.
| WS | `/events` | The live event stream |

`GET /catalog/tools` is deliberately absent until tool packs exist
([06](../../docs/roadmap/06-tool-packs.md)); today it could only list the
three kernel tools.

### Activity, for a roster that shows who is busy

Each entry in `GET /agents` carries `activeSessions` (turns running or parked
on a human right now) and, once the agent has done anything, `lastActiveAt`.

Both, because neither is sufficient. A timestamp alone reads a turn parked on
an approval as idle — the save that recorded the park is the last thing that
touched the row, and a turn waiting twenty minutes on a person is exactly when
you want the agent lit. A count alone loses an agent that finished a moment
ago.

What counts as "recently active" is the client's decision, so this reports a
timestamp and a count and never a verdict. A daemon that baked a window in
would need upgrading to change it.

### Two invariants worth stating

- **Channel tokens have their own door.** Slack app and bot tokens are
  gateway infrastructure secrets, not agent capabilities. Only
  `PUT /credentials/channels/:channel` writes them; the provider-credential
  and config endpoints cannot reach that namespace.
- **No endpoint returns a secret.** Credential reads report presence, type,
  and bound endpoint. Session reads strip the Anthropic raw-turn cache, which
  exists for replay and carries raw model turns.

### Health does not probe

`GET /health` reports what resolution already knows: uptime, the roster, each
agent's resolved provider and model, session counts by status, pending
approvals, and the distinct runtimes the daemon would serve with how each got
its credentials. It makes **no** network call — a monitoring view polls this,
and a live call per poll would spend the operator's rate limit to say
something resolution can answer for free.

## The event stream

`WS /api/v1/events`, filterable at connect (`?session=`, `?agent=`) or with a
frame:

```json
{ "type": "subscribe", "sessionId": "…", "agentId": "…" }
```

Frames are envelopes:

```json
{ "sessionId": "…", "turnId": "…", "event": { "type": "provider.delta", … } }
```

The `event` is the existing `StratusEvent` union, unchanged — no new
vocabulary. The **turn id lives on the envelope** because `StratusEvent`
carries none and should not grow one: a session processes several messages in
sequence, and without this a client that queued one has no way to tell its own
deltas from the next caller's. The id is assigned at dispatch and returned by
`POST /sessions/:id/messages`.

Deltas are dropped for a client whose socket has backed up past 1 MB, and only
deltas: losing a token from a reply is a cosmetic gap, while losing a
completion, a failure, or an approval leaves a UI stuck on a turn that already
ended. A `{ "type": "dropped", "deltas": n }` frame says when it happened.

## Configuration

```jsonc
{
  "api": {
    "enabled": true,        // false, or `stratus serve --no-api`, to turn it off
    "host": "127.0.0.1",
    "port": 4123
  }
}
```

While it is serving, `~/.stratus/gateway.json` (0600) says where:

```json
{ "url": "http://127.0.0.1:4123", "host": "127.0.0.1", "port": 4123, "pid": 4242, "version": "0.4.0" }
```

Clients read it instead of guessing at a default the operator may have
changed. It is removed on a clean stop, and only by the process that wrote it.
