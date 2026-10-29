# Events

An agent normally acts when a person writes to it or a schedule fires. The
events listener lets a service tell the daemon that something happened (a
review on a pull request, a card moving on a board), so an agent can be woken
for it rather than polling.

The operator configures the listener and its sources: what the daemon accepts,
and how it checks who sent it. An agent sets a **trigger** with
`schedule.on`, which a person approves once. Each delivery is checked,
deduplicated, matched against triggers and logged before any model runs.

## Turn it on

The listener is part of `@stratusagent/control-api` and runs only once the
config names at least one source. Add an `events` block to
`~/.stratus/config.json`, or to a file passed with `--config`. A project-local
`stratus.config.json` can't set it: who may wake your agents is not a cloned
repository's decision.

```json
{
  "events": {
    "listen": { "host": "127.0.0.1", "port": 4124 },
    "maxBodyBytes": 1048576,
    "sources": {
      "github": { "verify": "github", "secrets": ["events.github"] },
      "board": { "verify": "standard-webhooks", "secrets": ["events.board"] }
    }
  }
}
```

| Key | What it sets |
| --- | --- |
| `listen.host` | Interface to bind. Default `127.0.0.1`. `stratus serve --events-host <host>` overrides it |
| `listen.port` | Port to bind. Default `4124` |
| `maxBodyBytes` | The largest body accepted. Default 1 MiB, at most 16 MiB |
| `sources` | Sources by id. A source's URL is `/events/<id>`. Ids are lowercase letters, digits, `-` and `_` |
| `sources.<id>.verify` | `github` for GitHub webhooks, or `standard-webhooks` for anything that signs the [Standard Webhooks](https://www.standardwebhooks.com/) way |
| `sources.<id>.secrets` | Names of stored credentials holding the signing secret. Several names let a secret rotate with no downtime |

The listener is its own port. The control API's port never serves events, so
you can expose `/events/*` through a tunnel or a proxy while `/api/v1` stays
on loopback. A restart picks up a change to the `events` block.

## Store the secret

A source's secret is a credential, never a value in the config. On the
daemon's host:

```sh
SECRET=$(openssl rand -hex 32)
printf %s "$SECRET" | stratus credential set events.github
```

Then paste the same value into the sender's secret field. The daemon reads
the stored value on every delivery, so storing or rotating it needs no
restart. The value comes from the shared store, then from an environment
variable of the same name, which is how a container supplies it. A key
stored for one agent with `--agent` is that agent's, and the listener doesn't
read it. Until a source's secret is set, its deliveries get `503` with the
command to run.

## What the listener accepts

`POST /events/<source>` and nothing else. Each request is checked in this
order:

| What happened | Answer | Recorded |
| --- | --- | --- |
| No source has that id | `404` | one counter for every unknown path |
| Body over `maxBodyBytes` | `413` | counted for the source |
| The source's secret is not set | `503` | counted for the source |
| Missing or wrong signature, or a Standard Webhooks timestamp more than 5 minutes off | `401` | counted for the source, with the reason |
| Over 120 signed requests a minute | `429` | counted for the source |
| A content type the source doesn't take | `415` | a `refused` delivery, with the reason |
| Signed, but not a valid event | `400` | a `refused` delivery, with the reason |
| Seen before (same source and id within 7 days) | `200` | a `duplicate` delivery |
| Otherwise | `200` | an `unmatched` or `matched` delivery |

Only a request with a good signature leaves a delivery record, and only
signed requests count toward the rate limit. Someone who finds the URL can't
fill the log or use up a sender's quota. A refused delivery leaves no dedup
record, so the sender can fix it and send the same id again. Refusals are
logged at most once per source every 10 minutes.

### GitHub

Point an organization or repository webhook at `https://<your host>/events/github`.
Set **Content type** to `application/json`: GitHub's default, `form`, is
refused with `415`. Turn on SSL verification, and pick only the events you
want. The listener checks `X-Hub-Signature-256` and turns each delivery into
an event:

- **type:** `com.github.<event>.<action>`, e.g. `com.github.pull_request_review.submitted`
- **subject:** `pull/<n>` for anything on a pull request, including a comment
  on one, and `issues/<n>` for an issue
- **actor:** who acted
- **author:** who owns the pull request or issue

GitHub doesn't retry a failed delivery. One sent while the daemon is
restarting shows as failed in the webhook's **Recent Deliveries**, where you
can redeliver it for 3 days.

### Standard Webhooks and CloudEvents

A `standard-webhooks` source checks `webhook-id`, `webhook-timestamp` and
`webhook-signature` (`v1`, HMAC-SHA256 with a `whsec_` secret). The body is
either a [CloudEvent](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
(`application/cloudevents+json`, with `id` equal to `webhook-id`), or a plain
`{ "type": …, "timestamp": …, "data": … }` payload, whose id is `webhook-id`.
Events are JSON: `data_base64` is refused.

## Triggers

An agent registers a trigger with `schedule.on`. It's a schedule whose cadence
is an event, so it's approved, listed, reported and cancelled like any
schedule (`schedule.list`, `schedule.cancel`, `stratus schedules`,
`GET /api/v1/schedules`).

```json
{
  "source": "github",
  "filter": { "all": [
    { "exact": { "actor": "chatgpt-codex-connector[bot]", "author": "atlasatstratuslabs[bot]" } },
    { "prefix": { "type": "com.github.pull_request_review.submitted", "data.review.body": "<!-- codex-review-receipt:v1 -->" } }
  ] },
  "prompt": "Codex reviewed one of your PRs. Handle it.",
  "destination": { "channel": "slack", "to": "C0123456789" },
  "quietHours": { "from": "22:00", "to": "07:00", "timeZone": "America/New_York" },
  "maxPerHour": 12
}
```

- **The filter** uses the six [CloudEvents Subscriptions](https://github.com/cloudevents/spec/blob/main/subscriptions/spec.md#3241-filter-dialects)
  dialects: `exact`, `prefix`, `suffix`, `all`, `any` and `not`, matched
  case-sensitively against attributes such as `type`, `subject`, `actor` and
  `author`. A key starting with `data.` is a path into the event's JSON data
  and matches only a string there. Anything else is refused when the trigger
  is set. No model runs to decide a match.
- **The source** must be one the operator configured, or one a loaded plugin
  feeds (see [Sources a plugin feeds](#sources-a-plugin-feeds)).
  `schedule.on` refuses any other.
- **What the agent sees:** the trigger's prompt, then the event (its
  attributes and data as JSON, at most 16 KB, with a note when it's cut).
  Every event on one subject (one pull request, say) continues one
  conversation.
- **Trust:** the event came from outside. A valid signature proves who
  delivered it, not who wrote it (anyone can comment on a pull request). So
  the turn runs labeled `external`, as after reading a web page.
- **Unattended:** a firing runs under the agent's existing grants. Its
  destination is pre-authorized like a schedule's, and anything else is
  gated as usual.
- **Limits:**
  - An agent runs one event firing at a time, apart from its timed
    schedules, so a review never waits behind a long work-loop firing. A
    second waits its turn.
  - A trigger starts at most `maxPerHour` turns an hour (default 12, at most
    120). Past that, the newest event per subject waits for the hour to
    allow it, and older ones are dropped as `superseded`.
- **Quiet hours and paused intake** hold firings. When the window ends,
  each subject goes out once with all its held events. A subject keeps at
  most its 5 newest held events, and a hold older than 24 hours expires.
  Cancelling a trigger expires what it was holding.
- **Never twice:** each firing carries an idempotency key. A repeated
  delivery is a `duplicate`, and a firing caught by a restart, a crash or
  a graceful stop that cut its turn short, goes out again under the same
  key, so a turn that already started continues once instead of running a
  second time.

## Seeing what happened

`stratus events` asks the running daemon what each source has been doing:

```
github
  last delivery: 2026-10-28T02:59:00.000Z com.github.pull_request_review.submitted stratuslabs/agent#474 (matched)
  last refusal: 2026-10-28T02:10:00.000Z missing or wrong X-Hub-Signature-256 signature
  last 24h: 3 matched, 9 unmatched, 1 refused; firings: 2 fired, 1 failed
  refused before a row since the daemon started: 4 bad signature
```

- **Last refusal** is the newest of either kind: a signed delivery refused
  with a reason, or a request refused before it could leave a record (a
  wrong secret, too large, over the rate, or no secret stored). The second
  kind is counted only by the running daemon, so those counts start again at
  a restart.
- **Last 24 hours** counts deliveries by what became of them, and firings by
  where they stand. A firing still waiting (`pending`, `held`,
  `rate_limited`) counts however old it is.
- A **failed** firing is handled like a failed timed firing: the daemon log
  says why (`event trigger <id> firing failed: ...`), and a turn that failed
  partway leaves its session marked failed. Nothing is posted to the
  trigger's destination.
- `stratus schedules` shows each trigger's last firing, and `--format json`
  gives the whole summary.

`GET /api/v1/health` carries the same summary under `events` when a source
is configured, so a monitor sees refusals climb. `GET /api/v1/events/deliveries`
lists the delivery records themselves, which never hold a body.

## Sources a plugin feeds

A daemon that can't take deliveries from the internet, or a service with no
webhooks, can still wake triggers: a plugin polls, or holds a stream open,
and feeds what it finds as events. Its manifest declares the source ids it
feeds (`"contributes": { "eventSources": [{ "name": "github" }] }`), and
enabling the plugin in the `plugins` block is all the operator does: there is
no `events.sources` entry and no secret, and nothing listens. Those events go
through the same limits, dedup, filter and firings as a signed delivery, and
`schedule.on` takes the plugin's source like a configured one. A trigger
names only the source id, so a source that moves from a poller to a webhook
keeps its triggers: disable the plugin, then configure the same id here.

A plugin can't take a source id the `events` block already configures, and
two plugins can't feed one id; the second is refused at load, naming the
first. A plugin's source is never a path on the events port: a request to it
is a 404, like any unknown source. `stratus events` lists it as
`<id> (fed by plugin <package>)`. See
[`docs/architecture/plugins.md`](../architecture/plugins.md) for what a
plugin author writes.

## Reaching a daemon behind NAT

The listener binds loopback by default. To take deliveries from the
internet, front the events port with a tunnel (Tailscale Funnel, Cloudflare
Tunnel) or a reverse proxy that terminates TLS. Expose only the events port.
In the container image, `--events-host 0.0.0.0` is already in its command,
so publish the port on the host's loopback (`-p 127.0.0.1:4124:4124`, or
uncomment that line in `deploy/docker/compose.yaml`) and put the tunnel or
proxy in front. Under the system unit the listener stays on loopback, and the
tunnel or proxy points at `127.0.0.1:4124`.
