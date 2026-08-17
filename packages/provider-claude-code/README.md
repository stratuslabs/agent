# @stratusagent/provider-claude-code

The Claude **subscription** runtime for [Stratus Agent](https://github.com/stratuslabs/agent): turns run through the Claude Agent SDK (Claude Code as a library), so a Claude Pro/Max plan covers usage instead of per-token API billing.

```ts
import { createClaudeCodeProvider } from '@stratusagent/provider-claude-code';

const provider = createClaudeCodeProvider({
  authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, // from `claude setup-token`
  model: 'claude-opus-5',                          // default
});
```

- The agent's persona and long-term memory are rendered as the system prompt, and multi-turn sessions are replayed as a transcript — a Stratus agent is the same person on this runtime as on the API-key provider.
- **Kernel tools run here too.** Pass `executeTool` (the CLI wires `AgentRunner.executeHostedToolCall` automatically) and the request's tools are bridged into the Claude Code loop as an in-process MCP server: Claude calls them mid-turn, your host executes them — approval policy, agent allowlists, and `tool.called`/`tool.completed` events included — and the result feeds back into the same turn. `memory.remember` works on a subscription exactly like it does on an API key.
- The subprocess environment pins billing to the subscription in both auth modes (any ambient `ANTHROPIC_API_KEY` is cleared). With `authToken` set the setup token is used; omit it to use the machine's existing `claude` sign-in.
- Claude Code's built-in tools stay disabled — Stratus owns the tool surface.

Most users won't wire this directly — `@stratusagent/cli` routes subscription sign-ins here automatically: `stratus setup` → Providers → Claude → **Claude subscription**.
