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
| POST | `/skills/reload` | Re-read `~/.stratus/skills` and serve it, no restart — the `skills` half of `/catalog/tools` as the response. A skill that will not load answers `422 skills_reload_refused` naming the file, and the previous set keeps serving |
| POST | `/restart` | Announce a restart: `{ reason?, drainTimeoutMs? }` → `202 { restarting, reason?, drainTimeoutMs, inflight }`. New turns are refused from here, in-flight ones get the window, and the daemon comes back. `501 restart_unsupported` from a host that cannot bring it back |
| GET | `/sessions?agent=&limit=` | Durable sessions, newest first. `limit` bounds the result — the table grows for the life of an install |
| GET | `/sessions/:id` | One session, provider replay state stripped — including `usage`, the token records of every provider call it has made |
| POST | `/sessions/:id/messages` | Dispatch a message; returns `202 { sessionId, turnId }`. A `schedule:`-prefixed id answers `400 session_id_reserved` — those belong to scheduled firings. An optional `metadata` object is attached to a new session as given, except the keys the daemon writes for itself (`pendingApproval`, `fallbackActive`, `delegatedBy`, `rootSessionId`, `delegationDepth`, `scheduled`, `scheduleId`), which answer `400 metadata_reserved`. An existing session whose agent has since left the roster answers `404 agent_not_found` |
| GET | `/approvals` | Calls parked on a human right now |
| POST | `/approvals` | Resolve one: `{ requestId, answer, actor? }`, where `answer` is `once`, `always`, or `deny` — see [below](#always-does-not-mean-one-thing) |
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

### Reload and restart

Three things change under a running daemon without a restart, and the API
is how each takes effect: a soul (re-read before every turn; a file added
or deleted needs `POST /roster/reload`), a skill (`POST /skills/reload`),
and an MCP server's tools (discovered on reconnect). A skills reload is a
whole-catalog swap: it rebuilds what a restart would produce — operator
skills first, then each loaded plugin's, in load order, so an operator's
bare id still outranks a plugin's alias and a contested bare id stays
contested — and a file that will not load refuses the whole reload with
`422` rather than serving half a catalog. Loaded is not enabled: a reloaded
skill reaches only the agents whose souls list it.

A plugin is code, and code gets a restart — `POST /restart`, which answers
`202` at once and then refuses new turns (a `POST /sessions/:id/messages`
during the drain fails with "stratusd is restarting and will accept new work
once it is back up"), lets in-flight turns finish for `drainTimeoutMs`
(default 30 000), aborts what is still running at the end of it (the session
is saved as failed with `Run aborted: stratusd is restarting`), stops, and
comes back — this API's connections and event streams included, so a client
reconnects. `~/.stratus/gateway.json` is rewritten by the new process. What
needs a restart and what does not is tabled in
[Always on](../../docs/guides/always-on.md#what-needs-a-restart-and-what-does-not).

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
never cross agent identities. The stored agent is held to the roster on
every message too: a session whose agent's soul has since been removed
answers `404 agent_not_found`, naming the agent, rather than accepting a
turn that can only fail on the event stream.

Mint the id the way the dashboard does — a UUID the client generates — and
keep it for the life of the conversation. The daemon does not hand one out,
so a client that waits for the server to name a session waits forever.

The consequence to design around: an id the daemon has never seen is a *new
conversation*, not a 404. A mistyped id gets `202` and a durable conversation
under that name, because there is nothing to distinguish it from a client
opening its second chat. Unlike `agentId`, which is checked against the roster
and answers `404 agent_not_found` on a typo, a session id names something that
does not exist yet.

What *is* checked, on a new id only, is that it could be an address at all:
`400 invalid_session_id` for an empty id, one that is not its own trimmed
self, a leading dot, a path separator or control character, and the strings
JavaScript prints when an id was never computed — `undefined`, `null`, `NaN`,
`[object Object]`. The dashboard shipped the first of those, posting to
`/sessions/undefined/messages` and creating a durable conversation literally
named `undefined`.

Length is bounded too, at 200 characters **on top of the agent id the session
id contains**. Budgeted that way rather than flat because every convention
above embeds the agent id and agent ids have no length bound of their own — a
flat cap would cap them through the back door, leaving a long-id agent on the
roster and unable to hold a conversation. Two things keep the allowance from
becoming a loophole: it is measured against an `agentId` already checked
against the roster, and it applies only to an id that actually contains that
agent id. A bare UUID, or any id that does not embed it, is held to the flat
200 whichever agent the request names.

Shape beyond that is deliberately not enforced: the ids in circulation are
colon-joined addresses (`web:<agentId>:<uuid>`,
`<channel>:<agentId>:<team>:<conversation>:<thread>`, a bare UUID), and no
pattern admitting all of them would have excluded `undefined` anyway. **An id
already in the store is never re-judged** — it addresses a real conversation
whatever shape it is, and a rule written afterwards does not get to lock its
owner out of their own history.

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

**A turn that failed still keeps the tokens it spent.** A record is written
for every provider call that reported a count, whether or not the turn went
on to complete: a paid call that produced nothing usable, a primary attempt
that failed over to the fallback, and a stream cut before it finished — by
the idle watchdog, a cancelled turn, or a dropped connection. That last kind
always carries the input side (`inputTokens` and the cache buckets, which the
API announces when the stream opens); it carries `outputTokens` only when the
stream reached the final `message_delta` frame that reports it, and omits
the field otherwise — a stream cut earlier generated output nothing counted.

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

### `always` does not mean one thing

`POST /approvals` takes `answer` as exactly `once`, `always`, or `deny`;
anything else is `400 invalid_answer`. `actor` is optional and records who
decided — a channel-native id, such as a Slack user. A request that has
already been decided, has expired, or whose turn was cancelled answers `409
approval_not_pending` rather than silently doing nothing twice.

`once` and `deny` mean what they say, for this call. **`always` has two
different lifetimes, and which one the approver got depends on the tool:**

- For a tool whose call carries a **command** — `shell.run` today — it
  remembers a *command scope*, durable and per agent. Approving `git push
  origin main` persists `git push` minus its destructive forms, so `git push
  --force` still asks. That grant survives restarts.
- For **every other tool**, it is remembered against the tool name in memory,
  and lasts until the session ends **or the daemon restarts, whichever comes
  first**. Sessions are durable and restarts are not; a session resumed in a
  new process asks again, so this is strictly weaker than "for this
  conversation".

There is a third outcome behind the same answer: a command this daemon's
parser cannot reduce to a scope — a pipe, a subshell, an unbalanced quote —
is approved *once*, because widening to the bare tool would hand the agent
every command for the rest of the session. The call runs; the grant is not
remembered.

So one grant is written to disk beside the agent's soul and the other lives
in a `Set` for as long as the process does. A client that renders `always` as
one button is therefore promising something whose duration it cannot know —
and **nothing in this API tells it which it got**. `POST /approvals` answers `{ ok: true }`, and the
`tool.approval-resolved` event carries the `answer` that was submitted plus a
`reason` of `decided`, `timeout`, `cancelled`, or `undeliverable` — which is
why the request stopped being pending, not how long the grant lasts. The
daemon logs the difference (a remembered command scope is logged as one); an
API client cannot see it.

So word the button for the weaker guarantee. "Allow" is honest for both
lifetimes; "always allow" is only true for the command-scope case, and a
client cannot tell in advance that it is in that case.

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
