# Browser actions

`browser.act` clicks and types on a page, and a click submits, buys, and
deletes. It is `gated`, and the permission engine then judges each call by
the **site the conversation is already on**.

**This page is about the daemon**, which is where a click happens with
nobody watching. At a terminal, `stratus run` and `stratus chat` judge the
call rather than the site, exactly as [Approvals](./approvals.md) describes:
`--approvals always` (the default) does whatever the agent asks,
`--approvals ask` shows you the page and the arguments and waits for y/N,
and `--approvals never` refuses. None of the grants below apply to a
one-shot at your own terminal, where you are the gate.

Navigating, reading, and screenshotting are `gated` and judged by their
risk alone — the address policy is what bounds them, and it is the same
policy for [`web.fetch`](./tools.md). Acting is the one that carries a
scope.

## Why a site, and not a selector

A shell command *describes its own effect*: the permission engine can tell
`git status` from `rm -rf` because the string says which it is. A CSS
selector says nothing — `click("#submit")` is equally "load more results"
and "confirm purchase" — so a scope written over selectors would mean
nothing at all, and for a long time `browser.act` was `dangerous` for
exactly that reason: not because a click is worse than a shell command
(it usually is not), but because no scope model existed for one.

What is left that an operator can read and mean is *where* the click lands.
So a grant is one origin:

```text
this agent may act on https://app.example.com
```

**This narrows the blast radius; it does not remove it.** Acting on
`app.example.com` still covers "delete the record" alongside "load more".
The claim is only that what an agent may do unattended is now something you
can name, which is what a single risk word gave up on.

## Which pages an agent may act on unattended

1. **Sites approved this session**, then
2. **the agent's whitelist** — `~/.stratus/agents/<id>.whitelist.json`, the
   same file [command scopes](./shell.md) are written to, written by
   **Always allow**.

There is no third tier, and the absence is deliberate: the shell has a
built-in safe list because `git status` is read-only wherever it runs, and
no site has that property. Whether clicking on one is harmless is a fact
about your account on it, so shipping a list would be this project guessing
at your permissions. Anything not granted asks, and in
[`headless` mode](./approvals.md) anything not granted is refused:

```text
09:14:36  —  warning: ava: browser.act was called on https://app.example.com, which no approved site covers, and nobody is available to approve it (session slack:ava:…)
```

## Granting a site

In `remote` mode, **Always allow** on a `browser.act` request persists that
origin, and it **survives a restart** — unlike the same button on an
ordinary tool, which is forgotten when the daemon stops. The prompt names
the site: the arguments are a selector and say nothing about where the
click lands, so the site is shown next to the tool name rather than left
for the approver to infer.

For a `headless` daemon nothing is ever asked, so the grant is written by
hand. The file is per agent, `0600`, and read once at startup:

```jsonc
// ~/.stratus/agents/ava.whitelist.json
{
  "version": 1,
  "scopes": [],
  "origins": [
    { "origin": "https://app.example.com" }
  ]
}
```

Restart the daemon after editing it — grants are cached once read, which is
the right way round for a file whose edits widen what runs unattended.

**An origin is scheme, host, and port, matched exactly.** That is stricter
than it looks:

```text
https://app.example.com          # granted
https://app.example.com/reports  # the same grant — a path is not part of an origin
http://app.example.com           # a different site: a different scheme
https://app.example.com:8443     # a different site: a different port
https://admin.example.com        # a different site: no subdomain wildcards
```

An origin written with a path, a query, or in mixed case is read for its
origin or dropped — `https://APP.example.com/reports` becomes
`https://app.example.com`, and `file:///…` becomes nothing. An
internationalized host is stored in its punycode form, so an approved host
has exactly one spelling and a homograph is not a second way to write it.

## What this does not cover

- **A grant is per agent**, like every other grant beside the soul. A site
  approved for `ava` is not a site `juno` may act on.
- **A page with no origin is never covered.** A conversation that has not
  navigated yet is on `about:blank`, which has no origin — so the call asks,
  and an "always" answered on it runs the call and widens nothing.
  `browser.act` never receives a tool-wide grant, on any answer: one yes to a
  page must never become a yes to every page.
- **The site is read when the call is judged**, from the page the pool holds
  for that conversation, with nothing between that read and the decision —
  not even the disk read that loads your grants, because a page redirecting
  inside *that* gap would have a grant for one site allow a click on
  another. It is read *again* after a human answers, since an approval can
  be outstanding for fifteen minutes. A conversation that moved refuses:
  nothing runs, and an "always" answered on the old page grants nothing.

  ```text
  browser.act was approved on https://app.example.com, but the conversation is on https://checkout.example.com now — it did not run, and nothing was granted
  ```

  What is left is the moment between that last check and the click itself. A
  page that navigates *itself* right there is not caught, and nothing inside
  the tool can catch it; a scope is a bound on where an agent may aim, not a
  lock on the page.
- **`allowedHosts` is a different question.** The address policy decides
  which hosts the browser may *reach* at all, including for `browser.goto`
  and every subresource ([Tools](./tools.md), and
  [`tool-browser`](../../packages/tool-browser/README.md)). An origin grant
  decides which of the pages it reached may be clicked on. A site needs to
  pass both.
