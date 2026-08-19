# @stratusagent/tool-browser

`browser.goto`, `browser.read`, `browser.screenshot`, `browser.act`: a real
browser, one per daemon, with a page per conversation and every request
pinned through a proxy this plugin owns.

Reach for [`@stratusagent/tool-web`](../tool-web) first. `web.fetch` is what
an agent wants twenty times for every once it needs this, and it costs no
Chromium.

## Install

```bash
npm install @stratusagent/tool-browser
```

The dependency is **`playwright-core`** — a few megabytes, and it downloads
no browser. Installing this plugin costs you nothing you did not ask for;
the browser is one you already have, or one you fetch deliberately:

```bash
npx playwright install chromium      # ~150 MB, if you want a dedicated one
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/tool-browser": {
      "enabled": true,
      "channel": "chrome"            // or "executablePath": "/path/to/chrome"
    }
  }
}
```

Nothing here is loaded until a `browser.*` tool is actually called, so a
daemon with the plugin enabled and no browser installed runs normally and
fails that one call with a message naming the fix.

## Risk model

| Tool | Risk | What approval mode does |
| --- | --- | --- |
| `browser.goto` | `gated` | `interactive` asks, `remote` asks in Slack, `headless` refuses. |
| `browser.read` | `gated` | Same. Navigating and reading reach a service outside Stratus. |
| `browser.screenshot` | `gated` | Same. Writes a PNG into the agent's workspace. |
| `browser.act` | `dangerous` | Always a human, in every mode. A click submits, buys, and deletes — navigating somewhere else undoes a `goto`, and nothing undoes a click. |

## Settings

| Key | Default | What |
| --- | --- | --- |
| `channel` | none | Use an installed browser: `chrome`, `msedge`. |
| `executablePath` | none | Use the browser at this path. |
| `headless` | `true` | Set `false` to watch it work. |
| `allowedHosts` | none | Hosts exempt from the address check. |
| `allowPrivateAddresses` | `false` | Reach non-global addresses. The trusted-workstation posture. |
| `idleMs` | `300000` | Close a conversation's context after this much quiet. |
| `maxContexts` | `4` | Contexts at once; the least recently used goes first. |
| `maxTextBytes` | `100000` | Cap on `browser.read`, then a `truncated` marker. |
| `navigationTimeoutMs` | `30000` | Per navigation and per action. |
| `workspaceRoot` | supplied by the daemon | Where screenshots go: `<root>/<agent-id>/screenshots`. |

Address settings apply per agent under `agents`. **The proxy does not**: a
browser is one process shared by every conversation, so it is launched with
the top-level policy. Two genuinely different network postures want two
daemons, not one browser you believe is enforcing both.

## Why a proxy rather than request interception

Playwright can intercept requests, and this plugin does — but interception
happens *in the browser*, and Chromium resolves names for itself afterwards.
Validating an address there and letting Chromium resolve it again is DNS
rebinding with one more process in the way: the attacker's DNS answers
`93.184.216.34` for the check and `169.254.169.254` for the connection.

So every connection goes through a proxy this plugin starts on loopback,
which resolves the name, checks the address, and dials **that address**.
Redirects and subresources come back through it too, because every request
does. The launch carries `--proxy-bypass-list=<-loopback>`, without which
Chromium would bypass the proxy for exactly the addresses it exists to
refuse.

Interception still does the half a proxy cannot: `file:`, `data:`, and
other local schemes never reach a proxy at all, and this process can read
the files they name. Those are refused before navigation and again on every
request the page makes.

The address policy itself is [`@stratusagent/egress`](../egress) — the same
module `tool-web` uses, tested against the same table of hostile URLs. A
second copy would not drift into a style difference; the stale one would be
an SSRF hole.

## Lifecycle

One browser per plugin, started on the first call. One **context** per
conversation, so two conversations never share a cookie jar or a login. A
context that has been quiet longer than `idleMs` is closed; when the last
one goes, so does the browser. `maxContexts` bounds how many can exist at
once, dropping the least recently used.

The daemon sweeps on a timer and closes everything on shutdown. The sweep
takes the current time as an argument rather than reading the clock, which
is what makes the lifecycle testable without a test that sleeps.
