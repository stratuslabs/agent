# Hosting Stratus for other people

How to run Stratus for many tenants — a hosted service where each customer
gets their own agents — using only what this repository ships. Signup,
billing, a customer-facing UI, and the control plane that ties them together
belong to the service you build around it. This page covers what that
service runs, and why it is shaped this way.

## One tenant, one cell

A **cell** is one Stratus home, served by its own daemon, in its own
container:

```text
                 your control plane (signup, billing, routing)
                  │             │             │
             member token   member token   member token
                  │             │             │
            ┌─────┴────┐  ┌─────┴────┐  ┌─────┴────┐
            │ cell acme│  │ cell bolt│  │ cell cora│   same image,
            │ stratusd │  │ stratusd │  │ stratusd │   one container each
            │ volume   │  │ volume   │  │ volume   │
            └──────────┘  └──────────┘  └──────────┘
```

Every tenant's agents, sessions, memory, grants, schedules, workspaces,
leases, usage, and API tokens live in that cell's home and nowhere else. The
daemon has no notion of a tenant, and none is needed. Nothing is filtered by
tenant id, so no query can forget the filter: a cell has no handle on
another cell's files, sockets, or event bus at all. Two tenants can name
their agents `ava` and open the same session ids without either noticing.

This is the layout the rest of the industry has converged on for mutually
untrusted tenants, and the alternative was considered and rejected on
purpose. Threading a tenant key through one shared process means keying the
roster, every session and memory store, credential resolution, grants,
workspaces, browser contexts, MCP servers, plugin state, and the event
stream. Any one of those left unkeyed is a cross-tenant leak. A cell gets
the same result from the operating system, and it reuses the per-agent
layout ([state layout](../reference/state-layout.md)) one level up.

The cost is a process per tenant: the Node runtime and whatever plugins
the cell loads. An idle cell on the hosted profile measured 65–70 MB of
memory in the drill below. For a handful to a few hundred tenants per
machine that is the cheap end of the trade. If you need more tenants than
that per host, measure before designing around it.

## What a cell runs

The image is the same one the [single-tenant VM recipe](./deployment.md)
builds. A cell differs only in its configuration: which plugins it loads,
what its agents may do unattended, what it may spend, and who holds which
API token. [`examples/profiles/hosted`](../../examples/profiles/hosted) is
the reference locked-down configuration:

- **Tools: fetch and reply.** `@stratusagent/tool-web` only. No shell, no
  filesystem tools, no browser, no MCP servers. What a tenant's agent
  produces is its reply. `web.fetch` keeps its address policy, so private
  and link-local addresses stay unreachable, and every result is labelled
  `external`. Add a `web.search` backend plugin if you have one; none ships
  here ([Tools](./tools.md#searching-the-web)).
- **`approvals.mode: headless`, with `web.fetch` set to `safe` in
  `toolRisks`.** A cell usually has no Slack approver to ask. Under
  headless, a `gated` call is refused unless a standing grant covers it, so
  the operator decides once, in the trusted config, that fetching the web
  is part of what this service does. Leave it `gated` if you would rather
  your tenants approve: a member token can answer approvals and grant
  "always" through the API or the dashboard.
- **A `budget`**, in weighted tokens per UTC day and month — see
  [Usage and budgets](./usage-and-budgets.md).
- **`maxTurns: 20`**, a tighter runaway guard than the default.
- **`api.host: 0.0.0.0`** inside the container, published only on the
  host's loopback or a private network your control plane reaches. Never
  publish it to the internet.

Everything in that list is a trusted-config key. A member token cannot
change any of it (see below), and a project-local config cannot either.

## The control plane's job, cell by cell

Per tenant, your service:

1. **Creates a volume** and writes the cell's trusted config into it
   (`/home/node/.stratus/config.json` in the image), plus any starter souls.
2. **Starts a container** from the image with the volume mounted, the
   operator's provider key in its environment (`ANTHROPIC_API_KEY`, or
   whichever provider the config selects), a published port on a private
   interface, and the resource limits you sell. The same hardening as the VM
   recipe applies: non-root, read-only root filesystem, no capabilities.
3. **Mints the tenant's API token**:
   `docker exec <cell> stratus token create web` prints a member token once.
   Store it in your own database and send it with that tenant's requests.
   Keep the cell's operator token (`/home/node/.stratus/gateway-token`) for
   your control plane alone.
4. **Routes** each authenticated user of yours to their cell's address with
   their cell's member token — or proxies the dashboard to it, since a
   browser session minted from a member token stays a member session.
5. **Sets and reads spend** with the operator token: `PUT /config` for the
   budget (read on the next model call, no restart) and `GET /usage` for
   what to bill. `GET /usage` reports tokens by agent, provider, and model,
   bucket by bucket, and never a price. The price table is yours.
6. **Upgrades** by replacing the container with one from the new image.
   The cell migrates its own home at start, and refuses to start on a home
   stamped by a newer build.

A tenant id never appears in a request to a cell. The cell *is* the tenant,
so the only question an API call can raise is which cell your router sent
it to.

## Tenant-bound tokens: what a member may do

Each cell accepts two kinds of token, and nothing issued by one cell is
accepted by another:

| Token | Held by | May |
| --- | --- | --- |
| Operator (`gateway-token`) | Your control plane | Everything |
| Member (`stratus token create`) | The tenant | Manage their roster, talk to agents, read sessions, events, and usage, answer approvals, add channel apps and named credentials, list and revoke grants and leases |

A member cannot `PUT /config` or `PUT /credentials/:provider`, check a key
against an arbitrary URL, grant a lease, or restart the daemon. Those are
the routes that could raise the tenant's budget, enable a plugin, or send
the operator's key somewhere else (`baseUrl`, `apiKeyEnv`). The route table
fails closed: a new route is operator-only until someone decides otherwise,
and a test enumerates every decision. See the
[control API roles](../../packages/control-api/README.md#roles-operator-and-member).

## Operator-held provider keys

The provider key comes from the cell's environment, supplied by your
control plane. It is never written into the tenant's home. A tenant cannot
read it back: no endpoint returns a secret, and the locked-down profile
gives agents no shell or file access that could reach the process
environment. A member also cannot redirect it, because the endpoint and
the key's variable name are trusted-config settings. Tool subprocesses
never inherit it either, since the daemon scrubs the environment it hands
to anything it spawns ([Security](../concepts/security.md)). What the key
spends is bounded by the cell's budget.

A tenant who stores their own key with `PUT /credentials/:provider` cannot
do so as a member, which keeps "whose account is this billed to" your
decision. If your service is bring-your-own-key, do that step with the
operator token on the tenant's behalf.

## Per-tenant spend

Each cell's ledger counts only that cell's calls, and its totals match the
providers' own counts call for call. When a cell reaches its budget, the
next model call is refused before it is made. The person in the
conversation sees a sentence saying which limit ran out and when it resets,
while every other cell keeps serving. See
[Usage and budgets](./usage-and-budgets.md) for the one-call overshoot and
the weighting.

## What this does not do

- **No shared ingress, billing, signup, or UI.** Those are your service.
  This repository contains none, and the boundary is the point: anything a
  local install could also use is framework, and anything only a hosted
  service needs is yours.
- **No hard isolation beyond the container.** Cells share the host kernel.
  If your threat model needs more, run each cell in a microVM (Firecracker,
  gVisor, Kata) or on its own machine. The image does not change.
- **No cross-cell anything.** Agents in different cells cannot delegate to
  each other, share memory, or share a Slack app. If a customer needs two
  teams to share agents, give them one cell.

## Trying it: two cells on one machine

This drill, run against the repository's image, proves the model end to end:

```bash
docker build -f deploy/docker/Dockerfile -t stratusd .

for cell in acme bolt; do
  docker volume create "stratus-$cell"
  docker run --rm -v "stratus-$cell:/home/node/.stratus" -v "$PWD/examples/profiles/hosted:/profile:ro" \
    --entrypoint sh stratusd -c 'cp /profile/config.json ~/.stratus/config.json && mkdir -p ~/.stratus/agents && cp /profile/researcher.md ~/.stratus/agents/'
done

docker run -d --name cell-acme -e ANTHROPIC_API_KEY -p 127.0.0.1:14101:4123 -v stratus-acme:/home/node/.stratus stratusd
docker run -d --name cell-bolt -e ANTHROPIC_API_KEY -p 127.0.0.1:14102:4123 -v stratus-bolt:/home/node/.stratus stratusd

ACME=$(docker exec cell-acme stratus token create web)
curl -s -H "authorization: Bearer $ACME" http://127.0.0.1:14101/api/v1/agents   # acme's roster
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $ACME" http://127.0.0.1:14102/api/v1/agents   # 401: not bolt's
```

Automated, the same isolation is `packages/control-api/test/tenancy.test.ts`,
which checks two cells with the same agent id and the same session id
resource by resource: sessions, the event stream, memory, grants,
workspaces, tokens, and spend.
