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
| `~/.stratus/gateway-token` | The bearer token clients authenticate with |
| `~/.stratus/gateway.json` | Where the daemon is reachable — url, host, port, pid — removed on a clean stop |

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

The link works once. Run the command again for another. A daemon restart
signs the browser out too, because its sessions live in memory.

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

**Localhost is the posture.** To reach a machine at home, put it behind a
tunnel (Tailscale is the pattern we recommend) rather than binding a public
interface.
