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

The file is claimed by linking an already-written file into place, so two
daemons starting together on one home agree on a token instead of the loser
authenticating against a value no client can read, and a process killed
mid-write leaves no half-created file. A token file that *is* empty is
refused with a message naming it rather than repaired: repair means replacing
a file another daemon may have just claimed, and there is no conditional
replace to do it safely. Delete it and start again.

**Session cookie** — a browser can do neither half of that: page JavaScript
cannot read the token file, and a WebSocket upgrade cannot carry an
`Authorization` header. So `stratus dashboard` mints a **one-time token** and
opens the browser at it:

```
POST /api/v1/auth/ott          → { ott, url }          (bearer only)
GET  /api/v1/auth/session?ott= → 302 /, Set-Cookie      (single use, 60s)
```

`POST /auth/ott` answers with `{ ott, url, path }`. `path` is the exchange
link with no origin on it, and a client holding the address it just reached
should prefer joining that to its own base: `url` is built from the request's
`Host` (and `x-forwarded-proto`, read for nothing else), which is right for a
LAN address or a tunnel but is still the daemon's best guess rather than the
caller's own knowledge.

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

"Exact origin" means the address the browser actually reached the daemon on,
which is routinely not the one it bound to — a wildcard bind is reached over
a LAN or Tailscale address, and a tunnel terminates TLS in front of a
loopback one. So an origin equal to the request's own `Host` is accepted,
under `http` or `https`. That is a same-origin check rather than a
concession: a browser sets `Host` from the address it connected to, never
from the page making the request, and cannot be made to send another one —
`Host` is a forbidden header name for `fetch`, `XMLHttpRequest`, forms, and
WebSockets alike. A page on another port, or another host, still fails.

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
| GET | `/agents/:id` | One agent in full: complete instructions, the raw soul markdown, its pins |
| PUT | `/agents/:id` | Edit a soul, by field or as raw markdown |
| POST | `/roster/reload` | Re-read the agents directory and the configured default soul |
| GET | `/sessions?agent=&limit=` | Durable sessions, newest first. `limit` bounds the result — the table grows for the life of an install |
| GET | `/sessions/:id` | One session, provider replay state stripped — including `usage`, the token records of every provider call it has made |
| POST | `/sessions/:id/messages` | Dispatch a message; returns `202 { sessionId, turnId }` |
| GET | `/approvals` | Calls parked on a human right now |
| POST | `/approvals` | Resolve one: `{ requestId, answer, actor? }` |
| GET | `/schedules` | Every schedule the fleet has set — cadence, prompt, pre-authorized destination, next firing. The audit list: each row with a destination is a standing permission to speak |
| DELETE | `/schedules/:id` | Cancel a schedule. Also revokes the destination grant riding on the row — a still-running firing's next send is gated normally. 404 when no such schedule exists |
| GET | `/catalog/models` | Models the stored sign-ins can actually reach, listed live |
| GET | `/catalog/tools` | Every registered tool with the risk a call will face, every skill a soul's `skills:` can name, and the plugins that contributed them |
| GET | `/credentials` | Which sign-ins exist — presence and endpoint, never a value |
| POST | `/credentials/verify` | Live-check a key before storing it: `{ provider, key, type?, baseUrl? }` |
| PUT | `/credentials/:provider` | Store an `api_key`, or an `oauth_token` for Anthropic (a Claude setup token) or Codex (a marker that the machine's `codex login` sign-in serves runs — the value is never read). A codex key refuses a `baseUrl`: the harness owns its endpoints, so a bound key could never be honored there |
| PUT | `/credentials/channels/:channel` | Store a channel's tokens (today: `slack`) |
| GET/PUT | `/config` | Settings, whitelisted to keys this API owns |

`POST /credentials/verify` reports `ok`, `rejected`, or `unreachable`, and
only an explicit 401/403 is `rejected` — a compatible endpoint with no models
route says nothing about the key. Pass `type` with it: a `oauth_token` cannot
call a models endpoint at all — a Claude subscription token, or a codex
ChatGPT sign-in that has no key to check — so it answers `unreachable`
rather than condemning a credential that works perfectly well once saved. A
codex `api_key` is an OpenAI platform key and is checked against the
platform's models endpoint. Provider names on these routes are `anthropic`,
`openai`, and `codex`.

`PUT /config` does not write the `plugins` block. `GET` returns it, and a
`PUT` carrying it back is accepted (the round trip has to work) but the value
is ignored and the file's existing block is preserved rather than deleted by
the replace. Enabling a plugin runs somebody else's code inside the daemon —
that is the boundary the whole trust model rests on, and it stays a
deliberate edit to a file rather than a settings save.

`PUT /config` **replaces** the file rather than merging into it — `GET` hands
you the whole document and `PUT` takes the whole document back, so a partial
body silently drops the keys it omits. Every accepted key is type-checked
first: the config loader ignores values of the wrong shape, so writing one
would leave the file, the response, and the running daemon disagreeing about
what was just saved.

It edits the config the *operator* chose — the file named by `--config` or
`STRATUS_CONFIG`, or the global `~/.stratus/config.json`. Never an
auto-discovered project-local `stratus.config.json`: that file ships in a
repository, and writing settings into somebody's checkout because the daemon
started there would surprise everyone (its `api` and `approvals` blocks are
ignored for the same reason).
| WS | `/events` | The live event stream |

### `GET /catalog/tools` answers three questions, not one

```jsonc
{
  "tools": [
    { "name": "demo.echo", "risk": "safe" },
    { "name": "skill.read", "risk": "safe" },
    { "name": "fs.read", "risk": "safe", "package": "@stratusagent/tool-fs", "trusted": true },
    { "name": "notes.read", "risk": "gated", "package": "stratus-plugin-notes", "trusted": false }
  ],
  "skills": [
    { "id": "code-review", "name": "Code Review",
      "description": "Use when reviewing a diff or a pull request.",
      "path": "/home/me/.stratus/skills/code-review/SKILL.md" },
    { "id": "stratus-plugin-github:pr-review", "name": "pr-review", "alias": "pr-review",
      "description": "Use for GitHub pull requests.",
      "package": "stratus-plugin-github", "path": "…/skills/pr-review/SKILL.md" }
  ],
  "plugins": [
    { "package": "@stratusagent/tool-fs", "name": "@stratusagent/tool-fs", "trusted": true,
      "tools": [{ "name": "fs.read", "risk": "safe", "package": "@stratusagent/tool-fs", "trusted": true }],
      "skills": [] },
    { "package": "stratus-plugin-typo", "error": "Cannot find package 'stratus-plugin-typo'" }
  ]
}
```

All three halves, because any alone misleads. The **tools** say what an agent
can be granted and at what risk; the **skills** say which procedures a soul's
`skills:` can name; the **plugins** say what this daemon was *asked* to load —
including one that failed, which is invisible in the other two and is usually
why somebody opened the screen.

A tool with no `package` is the kernel's, which is the honest answer for it
rather than an omission. `risk` is read from the live registry, so it is the
risk a call will actually face: a third-party package cannot declare its own
tool `safe`, and this reports the floored value rather than the manifest's
claim. A tool bridged from an MCP server shows the same way — `package:
"@stratusagent/plugin-mcp"`, and the `mcp.<server>.` prefix names whose
server it is — including one discovered after startup, on a reconnect: the
list is derived per read from the plugins' live records, never a load-time
snapshot.

A skill's `id` is the canonical form an allowlist names — bare for one the
operator installed under `~/.stratus/skills/`, qualified
`<package>:<skill>` for a plugin's. `alias` is the bare id a plugin's skill
also answers to, present only while no other package or operator skill claims
it. Skills are **descriptors only** — id, name, description, provenance;
bodies never leave the daemon except through `skill.read`, on the agent's own
turn and under the soul's allowlist.

Nothing here says which *agent* may call what — that is the soul's allowlist,
and it is per identity. `GET /agents/:id` carries it.

### `runsOn` is absent when the daemon cannot say

Each agent in `GET /agents` and `GET /health` carries `runsOn` — the provider
and model a turn as that agent would actually resolve to, normalized through
the same soul-pin rules dispatch applies.

It is **omitted** rather than defaulted when the agent's soul file cannot be
read. The gateway keeps dispatching from a cached soul when its file is
deleted or momentarily unparseable, and that soul may pin a provider, so the
daemon is still billing somewhere it can no longer name. A default of `demo`
there would be a false statement about money, made exactly when someone is
looking to find out what is running.

### The listing summarises; the single read does not

`GET /agents` carries `persona`: the agent's first instruction line, trimmed
to fit a table row. `GET /agents/:id` carries `agent.instructions` in full,
plus `soul` — the file's own bytes, which is what `PUT /agents/:id` accepts
back as its `soul` field.

The distinction matters to anything that edits. An editor seeded from the
roster's `persona` and saved would write that snippet back as the whole
persona, permanently truncating the agent to a fragment of its first sentence
the first time someone changed its name. Read the agent before editing it.

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

### The client mints the session id

There is no `POST /sessions`. A conversation begins the first time
`POST /sessions/:id/messages` is called with an id the store does not have,
and that call must carry `agentId` — there is no stored agent to recover one
from, so it answers `400 agent_required` without it. Every later message to
the same id resumes that conversation; passing an `agentId` that disagrees
with the stored one answers `409 session_agent_mismatch`, because sessions
never cross agent identities.

Mint the id the way the dashboard does — a UUID the client generates — and
keep it for the life of the conversation. The daemon does not hand one out,
so a client that waits for the server to name a session waits forever.

The consequence to design around: an id the daemon has never seen is a *new
conversation*, not a 404. A client that sends a placeholder, an undefined
variable, or a mistyped id gets `202` and a durable conversation under that
name — the dashboard shipped exactly that bug once, posting to
`/sessions/undefined/messages`. Unlike `agentId`, which is checked against the
roster and answers `404 agent_not_found` on a typo, the session id is accepted
as given.

### Usage is a set of records, never a total

`GET /sessions/:id` carries `usage`: one record per provider call, in the
order the calls completed.

```jsonc
{
  "usage": [
    { "turnId": "s-42:turn:1", "provider": "anthropic", "model": "claude-opus-5",
      "inputTokens": 40, "outputTokens": 210, "cacheReadTokens": 9100, "cacheWriteTokens": 300 },
    { "turnId": "s-42:turn:2", "provider": "openai", "model": "gpt-5.5",
      "inputTokens": 12, "outputTokens": 88 }
  ]
}
```

**Tokens, not money.** Turning these into a cost is a projection against a
price table that is per-model, per-vendor, and per-contract — one living here
would be wrong here, silently, and stale within a quarter. What this surface
owes a projection is the attribution to do the conversion correctly, which is
why nothing is summed away: a thousand tokens of one model is not a thousand
of another, the four buckets are priced differently from each other, and a
session that fell back mid-run crosses *providers*. Sum the records if you
want a total; the total is a view, and this is the stored form.

The four counts are **disjoint**: `inputTokens` is prompt input billed at the
full rate, with cache reads and cache writes counted in their own fields and
never again in it. Adapters whose vendor reports an all-inclusive prompt count
normalize to this shape, so records from two providers are comparable.

**An absent count means the provider reported none — not zero.** A local
OpenAI-compatible server that omits `usage` produces a session with no
records at all, and a turn that cost real money would look free if a consumer
read that absence as a measurement. `usage` itself is absent until something
reports.

`turnId` is the Stratus turn the tokens belong to — one pass through the
runner, which is one provider call for the API providers and several for a
harness provider running its own inner loop. It is on the record rather than
reconstructed from ordering, because ordering cannot recover the boundaries
once one turn contributes several records. It is **not** the `turnId` on an
event envelope, which is assigned per dispatch by this API.

Records are durable session state, so they survive a restart and a resumed
session adds to what it already had. A failed run keeps the tokens it spent
before it failed.

**What each provider can tell you differs, and the records say so rather than
smoothing it over.** The two API providers report one record per turn, with
the model the API says served it. The two harness providers own their own
inner loops, so one turn produces several records: `claude-code` reports one
per model the loop touched — a sub-agent on a cheaper model shows up as its
own row — and `codex` reports one per completed codex turn against the
configured model, because codex publishes no per-model breakdown. A codex
turn that *fails* reports nothing at all: its failure event carries no counts,
which is a limit of that harness rather than a claim that the turn was free.

Subscription-billed providers report tokens too, even though the operator is
not billed per token for them. That is deliberate: it is how you compare what
a run *would* cost across providers, and a session that fell back mid-run
makes that a live question rather than a hypothetical.

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

Both the roster and the runtimes come from the roster the gateway is
**serving**, with each soul re-read the way `refreshAgent` re-reads it before
every dispatch — so a pin edited on disk is reported by the same poll that the
next turn will bill it on. It is the roster, not the agents directory.

The two ways a re-read can fail are not the same answer. An **unreadable**
file keeps its cached pins, because the gateway goes on dispatching from the
soul it loaded. A file that now declares a **different agent id** contributes
no runtime at all: `refreshAgent` refuses every dispatch for the old id until
the roster reloads, so there is nothing being served under it to report. The two diverge in ordinary use: a
soul dropped on disk is not dispatchable until a reload, and a soul deleted or
left momentarily unparseable is still dispatched from the copy the gateway
loaded. Reading the directory would name a provider and model for turns the
daemon refuses to run, and omit the pins it is really billing — in the one
endpoint whose job is to say what the daemon is doing right now. `POST
/roster/reload` is what closes the gap.

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

`session.completed` carries the session's `usage` records in the same shape
`GET /sessions/:id` returns — the whole set, not just this run's, because that
is the stored form and a resumed session's earlier turns are just as real. It
is absent when nothing reported, and a client must not read that as zero. A
run that *fails* emits `session.failed` without them; its records are still
saved on the session, so read them back rather than treating a failure as
free.

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
{ "url": "http://127.0.0.1:4123", "host": "127.0.0.1", "port": 4123, "pid": 4242, "version": "0.7.0" }
```

Clients read it instead of guessing at a default the operator may have
changed. It is removed on a clean stop, and only by the process that wrote it.
