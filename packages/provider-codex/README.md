# @stratusagent/provider-codex

ChatGPT/Codex runtime for Stratus Agent: runs turns through the OpenAI Codex
harness (`@openai/codex-sdk`), so a ChatGPT subscription covers usage — or an
OpenAI API key, when one is configured. The third provider shape in the stack:
a harness with its own inner loop, alongside the stateless OpenAI-compatible
adapter and the Claude Agent SDK runtime.

## What it does

- Runs each turn as a codex thread (`startThread`/`resumeThread` +
  `runStreamed`), recording the thread id in session metadata so later turns
  resume instead of replaying the transcript — the same treatment
  `provider-claude-code` gives its SDK session id, with the same recovery: a
  thread codex no longer has replays kernel history into a fresh one, unless a
  hosted tool already ran that turn.
- Renders the agent's persona, memory, and skills through the kernel's shared
  `renderSystemPromptSections` and hands them to codex as
  `developer_instructions`.
- Serves the session's kernel tools to the codex subprocess over a
  **loopback MCP endpoint** (streamable HTTP on `127.0.0.1`, ephemeral port),
  when the host supplies `executeTool`. Every tool call comes back through the
  kernel's registry → approval policy → executor chain and is recorded in
  session history; codex never executes anything itself.
- Streams item snapshots as kernel deltas: agent-message suffixes as text,
  reasoning as content-free `thinking` progress, MCP tool starts as
  `tool-call` — with wire names translated back to the kernel's own naming.
- Aborts a wedged subprocess on an inactivity timeout (default 10 minutes),
  suspended while a hosted tool or approval wait is legitimately silent.
- Enforces the kernel's `maxTurns` as a hosted-tool budget (default 8):
  codex has no native turn cap, so a call past the budget is refused at the
  tool endpoint — a tool error, nothing executed — and the loop finishes
  with what it has.

## Stratus stays authoritative over tool execution

Codex ships its own shell, file editing, web search, and approval policy.
None of that is allowed to act here — the kernel chain is the only gate:

- `features.shell_tool = false` removes codex's exec tools entirely (and with
  them file edits, which ride the shell in current codex); `view_image`,
  `sleep_tool`, and lifecycle `hooks` are off; `web_search = "disabled"`; the
  plan tool is off.
- The sandbox is pinned `read-only` and the approval policy `never`, as belt
  and braces under the disabled tools.
- `project_doc_max_bytes = 0`: an AGENTS.md in the daemon's working directory
  is repository content, not agent instructions.

## The loopback MCP endpoint

Codex takes MCP servers as a spawned command or a streamable-HTTP URL; the
daemon hosts the URL form, so nothing is spawned and tool calls arrive back
in-process. What authenticates the socket:

- a fresh 256-bit bearer token per turn, carried to the codex subprocess only
  through its environment (`bearer_token_env_var`), never in configuration or
  argv;
- every request must present it (constant-time comparison), and non-loopback
  connections are refused outright;
- the server exists only for the duration of the turn and serves only that
  turn's session and tool allowlist, so a leaked URL is useless once the turn
  ends. Reading the token would take reading the subprocess's environment,
  which is owner-only — the same trust boundary as `~/.stratus` itself.

## Billing

- **ChatGPT subscription** (default): no `apiKey` configured. The codex
  binary uses the machine's own `codex login` sign-in from its auth store
  under `~/.codex`; Stratus never reads or stores those tokens. An ambient
  `CODEX_API_KEY` is scrubbed from the subprocess in this mode so a
  subscription run can never silently become metered.
- **OpenAI API key**: pass `apiKey` (an OpenAI platform key); it reaches the
  binary as `CODEX_API_KEY`, which codex's exec mode honors above any other
  auth.

## Usage

```ts
import { createCodexProvider } from '@stratusagent/provider-codex';

const provider = createCodexProvider({
  // apiKey: 'sk-…',            // omit to use the machine's codex login
  model: 'gpt-5.5',
  executeTool: (session, call, context) =>
    runner.executeHostedToolCall(session, call, context),
});
```

Most hosts never construct it directly: `createRuntimeProvider` in
`@stratusagent/state` selects it for `provider: "codex"`, and `stratus setup`
stores the sign-in.

Requires the codex binary, which `@openai/codex-sdk` bundles per platform
(`codexPathOverride` points at a different one). The `runTurn` option is the
test seam — inject a fake to drive the provider, MCP endpoint included,
without launching codex.
