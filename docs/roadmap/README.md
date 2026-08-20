# Stratus Agent Roadmap

The execution plan for the [v2 architecture](../architecture/stratus-v2.md). Each step has a one-page spec: goal, why now, scope, design sketch, acceptance criteria, and open questions.

Steps 06 and 09–12 build the capability ecosystem; the contract they share — plugins, toolsets, tools, skills — is specified once in [`plugins.md`](../architecture/plugins.md).

Steps are ordered by dependency, not by calendar. Numbers are stable identifiers — new work slots in between or after, it doesn't renumber.

## Steps

| Step | Spec | Status | Delivers |
| --- | --- | --- | --- |
| 01 | [The gateway: `stratus serve`, durable sessions, streaming + cancellation](./01-gateway.md) | Shipped | An always-on process with sessions that survive restarts |
| 02 | [Slack channel: contract package + per-agent bot identity](./02-slack-channel.md) | Shipped | Talk to your agents in Slack, each with its own avatar and presence |
| 03 | [Permission engine: allowlists, whitelists, headless + remote approval](./03-permissions.md) | Shipped — risk model and headless mode (#47), remote approval through Slack (#49), restart recovery (#51), agent ids as a validated invariant (#52); command scopes shipped with 06, where they finally had a caller | Agents can be trusted with real tools while unattended |
| 04 | [Agent SDK tool bridge: tools + real history on the subscription path](./04-agent-sdk-bridge.md) | Shipped — tool bridge and dispatcher-side persistence (#31, #51), SDK-native history and parity tests (#54, #55), streaming deltas with the watchdog's tool-phase signal (#56), clean restart for turns no process can resume (#57); two Slack-adapter follow-ups named in the spec | Claude-subscription agents get full tool calling under kernel policy |
| 05 | [Control API + web dashboard](./05-control-api.md) | Shipped — shared rules extracted from the CLI, gateway seams (turn ids, listable approvals, roster reload), `@stratusagent/control-api` with auth and the management group, and `@stratusagent/dashboard` on top of it; `/catalog/tools` landed with 06 | One API for every surface; a real chat/monitoring UI |
| 06 | [Tools: fs, shell, browser, web](./06-tool-packs.md) | Shipped — the plugin host and manifest enforcement, `tool-fs`, `tool-shell`, `tool-web`, `tool-browser`, the shared egress policy, the command scopes 03 deferred, and `/catalog/tools` with the dashboard screen | Reusable capability plugins agents opt into by allowlist |
| 07 | [macOS app: visual agent creation and management](./07-macos-app.md) | Not started | Create and manage agents without the CLI |
| 08 | [Deployment profiles: single-tenant VM, hosted multi-tenant, credential leases](./08-deployment-profiles.md) | Not started | Non-local deployments as configurations of the framework |
| 09 | [Skills: procedures an agent loads when it needs them](./09-skills.md) | Not started | Agents that know *how*, without paying for every procedure every turn |
| 10 | [Proactive agents: schedules and outbound messages](./10-proactive.md) | Not started | Agents that act without being spoken to first |
| 11 | [MCP bridge: mount any MCP server as Stratus tools](./11-mcp.md) | Not started | Every existing MCP server, under kernel policy |
| 12 | [Plugin discovery and distribution](./12-plugin-registry.md) | Not started | Finding, installing, and trusting third-party plugins |

## Phases

- **Phase 1 — the fleet is live (steps 01–02).** After the gateway and the Slack channel, agents run always-on on your own hardware and answer in Slack. This is the milestone everything else builds on.
- **Phase 2 — trusted and on subscription (steps 03–04).** The permission engine makes unattended tool use safe; the SDK bridge makes the Claude-subscription billing path a full citizen.
- **Phase 3 — surfaces and capabilities (steps 05–06, 09–10).** The control API turns the gateway into a platform; the dashboard replaces the smoke-test page; tool plugins give agents real capabilities to opt into, skills give them procedures for using those capabilities well, and schedules plus outbound messages make an always-on daemon into agents that act on their own.
- **Phase 4 — the management app (step 07).** The macOS app makes agent creation and settings a visual experience instead of a CLI one.
- **Phase 5 — deployment profiles (step 08).** The single-tenant VM and hosted multi-tenant deployments, both as configurations.
- **Phase 6 — the ecosystem (steps 11–12).** The MCP bridge makes every server anyone has already written available to a Stratus agent; discovery and distribution let third parties ship plugins of their own.

## Ground rules

- Every step lands behind the existing kernel seams (`packages/core/src/index.ts`) — new capability means a new plugin, not a bigger kernel.
- Surfaces never own an agent loop; they consume the gateway API.
- A step's spec is *light* on purpose: enough to start and to know when you're done. Design detail beyond that belongs in the PR that implements it.
