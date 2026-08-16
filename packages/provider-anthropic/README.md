# @stratusagent/provider-anthropic

The Claude provider for [Stratus Agent](https://github.com/stratuslabs/agent), built on the official `@anthropic-ai/sdk`.

- **Multi-turn tool calling** — advertises kernel tools with wire-safe names, parses `tool_use` blocks, and replays results as `tool_result` blocks.
- **Persona and memory** — the agent's identity and long-term memory are rendered as the system prompt, so an agent is the same person on every provider.
- **Adaptive thinking, handled correctly** — `claude-opus-5` (the default) thinks adaptively; the thinking blocks that precede tool calls are persisted in session metadata and replayed verbatim, surviving tool waits, provider restarts, and resuming a session in another process. Use `redactAnthropicRawTurns(session)` before showing a session to people — replay state is never meant to be displayed.
- **Two ways to pay** — an Anthropic API key, or a Claude Pro/Max subscription via a Claude Code setup token (`authToken`).

## Usage

```ts
import { createAnthropicProvider } from '@stratusagent/provider-anthropic';

const provider = createAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,   // or authToken: <claude setup-token>
  model: 'claude-opus-5',                  // default
});
```

Pass the provider to `AgentRunner` from `@stratusagent/core` and it handles the loop: tools are executed locally and results are fed back to Claude until the model answers in plain text.

Options: `model`, `maxTokens` (default 4096), `systemPrompt`, `baseUrl`, `thinking: 'disabled'`, and an injectable `fetch` for tests.

Most users won't wire this directly — `@stratusagent/cli` sets it up from a menu: `npm i -g @stratusagent/cli && stratus setup`.
