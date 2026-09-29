# Hosted profile: one locked-down cell

The reference configuration for one tenant's cell in a hosted, multi-tenant
deployment — see [Hosting](../../../docs/guides/hosting.md) for the model and
the control plane's part.

| File | Goes to | What it decides |
| --- | --- | --- |
| `config.json` | `~/.stratus/config.json` in the cell (`/home/node/.stratus/config.json` in the image) | The trusted config: fetch-only tools, headless approvals, a budget, the API bind |
| `researcher.md` | `~/.stratus/agents/researcher.md` | A starter agent that fetches, remembers, and replies |

What it allows, and why each line is there:

- **`@stratusagent/tool-web` only.** `web.fetch` keeps its address policy
  (no private, loopback, or link-local addresses) and labels everything it
  returns `external`. No shell, no filesystem tools, no browser, no MCP: an
  agent's output is its reply.
- **`toolRisks: { "web.fetch": "safe" }` under `approvals.mode: headless`.**
  A cell usually has no Slack approver, and headless refuses every `gated`
  call without a standing grant — so the operator decides, once, that
  fetching is part of the service. Remove the override to make tenants
  approve fetches themselves (a member token can answer approvals).
- **`budget`** in weighted tokens, with weights at typical price ratios so
  a limit means roughly "input-token-equivalents". Your control plane sets
  each tenant's with `PUT /config` using the cell's operator token.
- **`maxTurns: 20`**, tighter than the default 40.
- **`api.host: 0.0.0.0`** because the API is reached through the
  container's published port. Publish it on a private interface only.

The provider key is not here: it comes from the container's environment
(`ANTHROPIC_API_KEY`), held by the operator.
