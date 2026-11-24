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

The control API has three consumers and only one of them is a web page. A
desktop app would ship its own UI, and a headless VM deployment
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
  fonts/            Geist and Geist Mono (SIL OFL 1.1)
  lib/              dom helpers, the API client, avatars, icons, and the
                    pure helpers the tests cover (status, sources, cadence…)
  views/            home, agent (chat and settings), new agent, schedules,
                    tasks, permissions, tools, settings
```

## What the screens do

**Home** — how many agents are working and how many need you, every
waiting approval with its three answers (and what *Always allow* would
remember), one card per agent with its state (Working, Needs you, Idle, or
Can't reach provider), recent conversations, and the schedules coming up.
An approval answered somewhere else while the page was open says so for a
couple of minutes instead of vanishing. When the daemon stops answering, a
banner says since when and the rest of the page dims.

**Agent** — one agent, two tabs. *Chat* streams a conversation as it
happens: text arrives token by token, each tool call is one row with where
it got to, the permission decision beside it, and its input and output a
click away, and an approval this conversation is waiting on shows inline.
The transcript is re-read from the daemon when the turn settles so the page
never quietly disagrees with what is stored. It is re-read the same way when a message an agent overheard lands in the conversation with no turn at all — `session.observed` is the only sign of it. The drawer lists the
agent's conversations by day, with a search over their titles. *Settings*
edits the soul — name, persona and model — through a validated round-trip,
beside its Slack connection, memory count and schedules.

**New agent** — a name, what it should do, and a model, written as a soul
file by `POST /agents`.

**Schedules** — every schedule, soonest first, with its cadence in words and
a Remove that asks once. **Tasks** — background work one agent handed to
another, with Stop for what is still running. **Permissions** — every
standing grant by kind, with Revoke. **Tools** — the built-in tools and the
plugins the daemon was configured to load, including any that failed.

**Settings** — provider sign-ins (with a live key check before storing),
the default model listed from what those sign-ins can actually reach, Slack
tokens per agent, and the approval posture.

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
