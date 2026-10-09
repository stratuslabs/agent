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
    "port": 4123,
    // Optional: where you reach this daemon from elsewhere. Credential
    // links are built on it; see "Adding a credential from a link" below.
    "publicUrl": "https://mac-mini.example.ts.net"
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

**Localhost is the posture.** To reach a machine at home, put it behind a
tunnel (Tailscale is the pattern we recommend) rather than binding a public
interface.

## Adding a credential from a link

An agent that needs a key it does not hold asks for it with
`credential.request`. Where its conversation can show a form, that is a
[Slack form](./slack.md#adding-a-credential-from-slack). Where it cannot (a
scheduled or HTTP turn, a direct message with someone who is not an
approver, a private channel with no approver in it), or where the agent is
asked for one with `via: "link"`, the control API issues a **one-time link**
instead, and the agent is handed it to pass on. Every agent can ask through
a form, but a link only goes to an agent whose soul lists
`credential.request` under `tools:` (or has no `tools:` key), because the
link is a bearer credential:

```
https://mac-mini.example.ts.net/api/v1/credential-links/<token>
```

Opening it shows what is asked for, whose it would be, and the agent's
reason, with one field. What a submission does is what the Slack form does:
the value is stored **add-only** (a name already stored, or supplied by the
daemon's environment, is refused), the name is granted in the requesting
agent's soul and in no other agent's, and the value goes to
`~/.stratus/credentials.json` and nowhere else, never into the conversation,
the model, the event stream, or the daemon log.

- **The link is the credential.** No sign-in is asked for: whoever opens it
  can answer that one request, once. It sits in the conversation the agent
  passes it on in, so anyone who can read that conversation can use it
  first. They can only add a key under that one name for that one agent,
  never replace one, but the key they add is one they chose, so send the
  link only to the person who should fill it in.
- **It is short-lived.** It works until the request is answered, or can no
  longer be (the name was stored since, the agent's soul moved), and for 30
  minutes at most. Links live in the daemon's memory, so a restart ends
  them; the agent asks again.
- **Opening it spends nothing.** Only a submission does, so a chat app
  previewing the link does not use it up, and an empty value can be
  corrected and sent again.
- **It points at `api.publicUrl`.** Set that to the address you reach this
  daemon on from elsewhere, such as its Tailscale name. Without it, links
  use the address the API bound (`http://127.0.0.1:4123` by default), which
  works only on the machine itself, and the agent is told to say so. The key is read only from a trusted
  config, like the rest of the `api` block, and has to be an `http(s)`
  address with no query, fragment, or username and password: every link is
  built on it and shown to the agent.
- **No control API, no link.** A daemon started with `--no-api`, or without
  `@stratusagent/control-api` installed, has nothing to serve one from; the
  agent is told to have its operator run `stratus credential set`.
