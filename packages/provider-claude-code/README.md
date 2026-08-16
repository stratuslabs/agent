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
- With `authToken` set, the subprocess environment pins billing to the subscription (any ambient `ANTHROPIC_API_KEY` is cleared). Omit it to use the machine's existing `claude` sign-in.
- Claude Code's built-in tools are disabled — Stratus owns the tool surface.

**Current scope:** text conversations. Stratus kernel tools (like `memory.remember`) are not yet bridged into the Claude Code loop from this provider; use `@stratusagent/provider-anthropic` with an API key when a run must execute tools.

Most users won't wire this directly — `@stratusagent/cli` routes subscription sign-ins here automatically: `stratus setup` → Providers → Claude → **Claude subscription**.
