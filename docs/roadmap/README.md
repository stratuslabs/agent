# Stratus Agent Roadmap

The execution plan for the [v2 architecture](../architecture/stratus-v2.md). Each step has a one-page spec: goal, why now, scope, design sketch, acceptance criteria, and open questions.

Steps are ordered by dependency, not by calendar. Numbers are stable identifiers — new work slots in between or after, it doesn't renumber.

## Steps

| Step | Spec | Status | Delivers |
| --- | --- | --- | --- |
| 01 | [The gateway: `stratus serve`, durable sessions, streaming + cancellation](./01-gateway.md) | Not started | An always-on process with sessions that survive restarts |
| 02 | [Slack channel: contract package + per-agent bot identity](./02-slack-channel.md) | Not started | Talk to your agents in Slack, each with its own avatar and presence |
| 03 | [Permission engine: allowlists, whitelists, headless + remote approval](./03-permissions.md) | Not started | Agents can be trusted with real tools while unattended |
| 04 | [Agent SDK tool bridge: tools + real history on the subscription path](./04-agent-sdk-bridge.md) | Not started | Claude-subscription agents get full tool calling under kernel policy |
| 05 | [Control API + web dashboard](./05-control-api.md) | Not started | One API for every surface; a real chat/monitoring UI |
| 06 | [Tool packs: fs, shell, browser](./06-tool-packs.md) | Not started | Reusable capability packages agents opt into by allowlist |
| 07 | [macOS app: visual agent creation and management](./07-macos-app.md) | Not started | Create and manage agents without the CLI |
| 08 | [Deployment profiles: single-tenant VM, hosted multi-tenant, credential leases](./08-deployment-profiles.md) | Not started | Non-local deployments as configurations of the framework |

## Phases

- **Phase 1 — the fleet is live (steps 01–02).** After the gateway and the Slack channel, agents run always-on on your own hardware and answer in Slack. This is the milestone everything else builds on.
- **Phase 2 — trusted and on subscription (steps 03–04).** The permission engine makes unattended tool use safe; the SDK bridge makes the Claude-subscription billing path a full citizen.
- **Phase 3 — surfaces and capabilities (steps 05–06).** The control API turns the gateway into a platform; the dashboard replaces the smoke-test page; tool packs give agents real capabilities to opt into.
- **Phase 4 — the management app (step 07).** The macOS app makes agent creation and settings a visual experience instead of a CLI one.
- **Phase 5 — deployment profiles (step 08).** The single-tenant VM and hosted multi-tenant deployments, both as configurations.

## Ground rules

- Every step lands behind the existing kernel seams (`packages/core/src/index.ts`) — new capability means a new package, not a bigger kernel.
- Surfaces never own an agent loop; they consume the gateway API.
- A step's spec is *light* on purpose: enough to start and to know when you're done. Design detail beyond that belongs in the PR that implements it.
