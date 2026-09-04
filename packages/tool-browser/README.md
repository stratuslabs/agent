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
| `browser.act` | `gated`, then judged per site | `interactive` and `remote` ask, naming the site; `headless` runs it only on an origin the agent has been granted. See below. |

### Acting is scoped by origin

A click submits, buys, and deletes: navigating somewhere else undoes a
`goto`, and nothing undoes a click. `browser.act` was `dangerous` for that
reason for a long time — a human every time, in every mode, which in
`headless` meant a flat refusal and an installed service that could never
click anything at all.

That position was hard to defend on its own terms. A shell command can be
far more destructive than a click and *is* allowed unattended inside
command scopes; the difference was never the blast radius, it was that a
command string describes its own effect and a CSS selector does not.
`click("#submit")` is equally "load more results" and "confirm purchase",
so `dangerous` was standing in for **no scope model exists for this**.

There is one now, and it is the vocabulary the address policy already
speaks: the **origin of the page the conversation is on**.

```jsonc
// ~/.stratus/agents/ava.whitelist.json — beside the agent's soul, 0600
{ "version": 1, "scopes": [], "origins": [{ "origin": "https://app.example.com" }] }
```

`Tool.originFor` is how the tool answers, and it is deliberately **not**
given the call's input. An origin parameter would be the model's claim
about where it is, which is precisely what a grant must not take on trust;
the pool already tracks a page per conversation, so the origin comes from
there. A conversation that has not navigated has no origin, so nothing
covers the call and it asks — and `browser.act` never receives a tool-wide
grant on any answer, so one yes to a page is never a yes to every page.

**A per-origin scope does not make a click safe.** Acting on
`app.example.com` still covers "delete the record" alongside "load more".
It makes the blast radius *nameable*, which is what one risk word gave up
on. Two things it does not cover:

- The origin is read when the call is judged, again as the last thing
  before the call is allowed, once more by the kernel immediately before
  the tool is dispatched, and a fourth time inside `browser.act` after its
  page is opened — so none of the waits in between can have a yes given for
  one site land on another: a human's fifteen minutes, the write that
  persists a grant, the session-store checkpoint, a `tool.called`
  subscriber, or the browser launch that opening a page can trigger. A
  grant already written names the site the approver read, never the one the
  page moved to. What is left is Playwright's own wait for the selector
  (`navigationTimeoutMs`), which nothing outside the browser can close.
- It is checked in this process, where the pool holds the page. A browser
  driven somewhere else would need the check to happen where a compromised
  runtime cannot skip it — the concern the egress proxy already carries for
  addresses.

[Browser actions](../../docs/guides/browser.md) is the operator-facing
version of all of this.

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
| `maxTextBytes` | `100000` | Cap on `browser.read`, then a `truncated` marker. A call's own `maxBytes` may ask for less, never more. |
| `navigationTimeoutMs` | `30000` | Per navigation, per action, and on reading a page — one whose script never yields is given up on, its context closed, and the next call opens a fresh page. |
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

Each conversation's context browses through a proxy of its own, under the
same policy as the browser's. What was refused is reported once, as
`blockedRequests` on the next result of the conversation whose page was
browsing — never to another conversation, however alike their policies,
never to one that began after it, and never twice. A proxy keeps its last
hundred refusals for that, so a page refused something on every load does
not grow the daemon's memory.

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
