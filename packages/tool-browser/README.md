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
| `browser.screenshot` | `gated` | Same. Writes a PNG into the agent's workspace and returns it as `file`, which a channel delivers as an attachment. |
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

Address settings apply per agent under `agents`, and they are enforced —
including when an agent's policy is *narrower* than the default. A proxy is
chosen when Chromium launches, so a browser can only ever enforce one
address policy: agents whose policy differs get their own browser, and
agents that share a policy share one. Interception inside the browser cannot
substitute, because it does not resolve names and so cannot narrow a
hostname destination without re-opening the rebinding race the proxy closes.

The practical cost is one Chromium per distinct policy. Most deployments
have exactly one; a config that gives every agent its own posture pays for
every one of them.

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

## Screenshots come back as files, not bytes

`browser.screenshot` writes to `<workspaceRoot>/<agent-id>/screenshots/` and
returns `{ file, url, title }`. The `file` key is the channel contract's
convention for a result that refers to a local file, so a Slack thread that
asked for a screenshot gets the image posted into it rather than a path nobody
can open. Base64 in a tool result would be a transcript no human can read and
a provider bill nobody wanted.

## Lifecycle

One browser per address policy, started on the first call that needs it.
One **context** per conversation, so two conversations never share a cookie
jar or a login. A context that has been quiet longer than `idleMs` is
closed; when a browser's last conversation goes, so does the browser and its
proxy. `maxContexts` bounds how many contexts can exist at once, dropping
the least recently used.

The sweep runs on the plugin's own timer — unref'd, so it never holds a
one-shot `stratus run` open, and disarmed once no browser is left. It also
takes the current time as an argument, which is what makes the lifecycle
testable without a test that sleeps.

Shutdown is the kernel's `dispose` hook, which the gateway calls after
in-flight turns drain and `stratus run`/`chat` call when they finish. Every
context, every browser, and every proxy goes with it.
