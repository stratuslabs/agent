# Remote access: the control API and the dashboard

Every non-terminal surface — the web dashboard, the macOS app, a headless
VM — talks to one authenticated HTTP + WebSocket API over a running daemon,
and nothing else. Both are optional packages, and the split is deliberate:
the API has three consumers and only one of them is a web page.

```bash
npm install -g @stratusagent/control-api @stratusagent/dashboard
```

Install `@stratusagent/control-api` alone for a headless machine; add
`@stratusagent/dashboard` and the API serves the web UI at `/` as well.
With the API present, `stratus serve` also serves it on `127.0.0.1:4123`.
Its full reference — endpoints, auth, the event envelope — lives in
[its own README](../../packages/control-api/README.md), which the other
surfaces are written against.

**Installing it is how you say you want a port open.** The CLI ships no
open port, so presence of this package is the operator's declaration — and
`--no-api` or config is how you take it back:

```jsonc
// ~/.stratus/config.json
{
  "api": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4123
  }
}
```

Like `approvals`, this block is read **only** from a config you chose
yourself — the global `~/.stratus/config.json` or one passed with
`--config`. An auto-discovered project-local `stratus.config.json` ships in
any repository, and which interface a daemon binds is not a decision a
cloned repo gets to make; one that tries is ignored, loudly.

Two files appear while it is serving, both `0600`:

| File | What |
| --- | --- |
| `~/.stratus/gateway-token` | The operator's bearer token — the whole API |
| `~/.stratus/gateway.json` | Where the daemon is reachable — url, host, port, pid — removed on a clean stop |

`~/.stratus/api-tokens.json` (also `0600`) appears once you create a
[member token](#member-tokens).

A third, `~/.stratus/stratusd.lock`, is the daemon's exclusive claim on the
home for as long as it runs; see [One daemon per home](./always-on.md#one-daemon-per-home).

## The dashboard

```bash
stratus dashboard
```

It finds a running daemon through `~/.stratus/gateway.json`, or starts one
in the foreground when there is none (and says which it did). Then it mints
a **single-use, short-lived sign-in link** and opens your browser at it —
the one thing a browser cannot do for itself, since page JavaScript cannot
read `~/.stratus/gateway-token` and a WebSocket upgrade cannot carry a
header.

The link works once. Run the command again for another.

A signed-in page stays signed in across `stratus restart`: the stopping
daemon hands its live browser sessions to the one replacing it, in memory
and over the channel between them, and nothing is written to disk. A crash
or a plain stop-and-start still signs the page out — the process that
vouched for it is gone, and no file says otherwise — so that is when the
link is needed again. So does rotating `~/.stratus/gateway-token`: a handed
session is adopted only under the token it was minted with.

What you get: the roster with live activity, streaming chat with tool
status lines, an approvals panel that resolves calls parked from anywhere,
a Plugins screen rendering the daemon's tool catalog, and settings for
sign-ins, models, and Slack.

## Talking to a daemon from another machine

`stratus agents --gateway <url>` reads the roster from a running daemon
instead of resolving it locally — the same listing, answered by the API:

```bash
stratus agents --gateway http://127.0.0.1:4123
```

Locally that needs nothing else: the token comes from
`~/.stratus/gateway-token`. A daemon reached through a tunnel has its own
token, so pass it with `--token` or `STRATUS_GATEWAY_TOKEN`.

## Member tokens

`~/.stratus/gateway-token` is the **operator** token: everything the API
can do, including rewriting the config and the provider sign-ins every agent
bills to. Handing it to a teammate, a CI job, or a hosted tenant hands them
all of that. A **member** token is the least-privileged alternative:

```bash
stratus token create alice        # prints the token once, on stdout — store it now
stratus token list                # id, name, role, created; never the token
stratus token revoke alice        # by id or name
```

A member may manage the roster, talk to agents, read sessions, usage, and
the event stream, answer approvals, and bind a channel app or add a named
credential (both add-only). It may not change the config, store or check a
provider sign-in, grant a credential lease, restart the daemon, or give a
soul a key that is not that agent's own — those answer `403
operator_required`. The full split is in the
[control API reference](../../packages/control-api/README.md#roles-operator-and-member).

A member can have any agent use any tool the operator loaded, since it
edits souls and answers approvals. Where `tool-shell` or `tool-fs` is
loaded, that reaches the machine — the operator's token file included — so
a member token there is a convenience for someone you already trust with
those tools, not a boundary against them.

Only each token's sha256 is kept, in `~/.stratus/api-tokens.json`
(`0600`), so a lost token is revoked and replaced, never recovered. The
daemon reads that file on every member request, so a new token works and a
revoked one stops — along with every dashboard session and event stream it
opened — **without a restart**. `stratus dashboard` always signs in as the
operator; a member opens its own browser session with `POST
/api/v1/auth/ott`, and that session stays a member. Approvals a member
answers are recorded under its token's name (`api:alice`).

In a hosted deployment, run one home and one daemon per tenant and give
each tenant a member token for its own daemon: every token a daemon accepts
was issued by that daemon's home, so it can reach nothing else.

**Localhost is the posture.** To reach a machine at home, put it behind a
tunnel (Tailscale is the pattern we recommend) rather than binding a public
interface.
