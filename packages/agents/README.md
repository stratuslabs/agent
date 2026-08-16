# @stratusagent/agents

Agent identities for Stratus Agent — designed so an agent feels like a person, not a stateless bot.

```ts
import { defineAgent } from '@stratusagent/agents';

const scout = defineAgent({ instructions: 'You research things thoroughly.' });
// scout.name → "Arlo", scout.avatar → stratus-style palette derived from the name
```

- `defineAgent` — one-call creation with a generated human-ish first name and a deterministic avatar theme
- `parseSoul` / `formatSoul` — **soul files**: agents defined as markdown (frontmatter for name/provider/model/tools, prose for the personality), round-tripped to and from `AgentDefinition`
- `createRememberTool` — agent-scoped long-term memory that follows the agent across every channel, thread, and session
- `createDelegateTool` — orchestrator primitive: hand a task to another agent and get their reply back
- `createAgentRouter` — route channels/mentions/messages to the right agent
- Per-agent tool and credential allowlists enforced by the kernel

See the [repository README](https://github.com/stratuslabs/agent) for the full picture.
