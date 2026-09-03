# @stratusagent/dashboard

The Stratus web dashboard: the roster, live chat with your agents, pending
approvals, and settings — served by `@stratusagent/control-api` at `/`.

```bash
npm install -g @stratusagent/control-api @stratusagent/dashboard
stratus dashboard
```

`stratus dashboard` finds a running daemon (or starts one), mints a
single-use sign-in link, and opens your browser at it.

## Why it is a separate package

The control API has three consumers and only one of them is a web page. The
desktop app (roadmap step 07) ships its own UI, and a headless VM deployment
wants the API with no UI at all. Keeping the UI here means both of those
install the API alone, and this package can grow without weighting them.

The API auto-loads it: if this package resolves, the dashboard is served. Pass
`ui: false` to `createControlApi` to run the API bare on a machine that has it
installed anyway.

## No build step

The `ui/` directory is what ships: hand-written HTML, CSS, and ES modules, no
bundler and no framework. What a contributor edits is exactly what a user
loads, and there is no build output to go stale against the source.

That is a real constraint, not a preference — it is why the rendering layer is
a hundred lines of `el()` in `ui/lib/dom.js` rather than a dependency, and why
every string reaches the DOM as a text node. There is deliberately no
`innerHTML` helper in this package.

```
ui/
  index.html        the shell
  styles.css        tokens, light and dark
  app.js            store, router, live stream, sidebar
  lib/              dom helpers, the API client, avatars
  views/            dashboard, agent, settings, plugins
```

## What the screens do

**Dashboard** — quick stats from `GET /health` (agents, running turns, stored
sessions, waiting approvals, uptime, and what the daemon is serving with
which credentials), the approvals panel when anything is parked, recent
conversations, and a live activity feed.

**Agent** — one agent, three tabs. *Chat* streams a conversation as it
happens: text arrives token by token, tool calls appear as status lines, and
the transcript is re-read from the daemon when the turn settles so the page
never quietly disagrees with what is stored. *Activity* is the same event
stream filtered to that agent. *Settings* edits the soul — name, persona,
provider and model pins — through a validated round-trip.

**Settings** — provider sign-ins (with a live key check before storing),
the default model listed from what those sign-ins can actually reach, and
Slack channel tokens.

**Plugins** — an honest placeholder. Tool packs are roadmap step 06.

## Two things the page will not do

- **It never renders a secret.** `GET /credentials` reports that a sign-in
  exists, its type, and its endpoint. There is nothing to show and nothing to
  leak.
- **It only talks to its own origin.** The page is served with a
  `default-src 'self'` content security policy — no external scripts, styles,
  images, or connections. A local dashboard holding a live session against
  your daemon is not a place to be relaxed about that.

## When the daemon restarts

Sessions live in the daemon's memory. An announced restart (`stratus
restart`) hands them to the replacement, so the page reconnects and stays
signed in; a crash or a plain stop-and-start signs the browser out, and the
page says so rather than rendering an empty roster that looks like a fleet
that vanished. Run `stratus dashboard` again. If the socket drops without
the daemon dying, the page reconnects on its own with a backoff and re-reads
everything it missed — and it re-reads the moment the socket drops too, so
an outage shows as the banner rather than as last-known numbers under a
"reconnecting" dot.

Refreshes that overlap settle latest-wins: one already in flight when a
newer one starts is discarded when it lands, so a burst of events cannot
leave the page holding an older answer. That is how an approval request
went missing once — the refresh a `session.created` started was sent before
the call was parked, and landed after the approval event's own refresh.
