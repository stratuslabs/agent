# 04 — Agent SDK Tool Bridge: tools + real history on the subscription path

## Goal

Agents billed through a Claude subscription (the `@stratusagent/provider-claude-code` path) get full tool calling and real multi-turn history, with every tool call still flowing through the kernel's registry, approval policy, and executor.

## Why now

Agents may run on either billing path, and today they aren't equivalent: the claude-code provider passes `tools: []` with `maxTurns: 1` and flattens the session into a `Conversation so far:` prompt string, so a subscription agent can't even use `memory.remember`. This is also where the "kernel owns the loop" decision becomes enforceable: the Agent SDK must never become a side door around permissions and memory.

## Scope

**In:**

- **Kernel contract addition — a callable tool-dispatch seam.** Today `ProviderRequest.tools` carries only `ToolDescriptor` schemas, and the allowlist → approval → executor chain lives in the runner's private `executeToolCall` — descriptors alone let a provider *advertise* tools but not *execute* them. Add a `ToolDispatcher` handed to providers on the request (`request.dispatchTool(call) → ToolResult`) that runs the full kernel chain and emits the standard `tool.*` events. Any provider that hosts its own inner loop needs this seam; the MCP handlers below are its first consumer.
- Rework `@stratusagent/provider-claude-code` to expose the session's kernel tools to the Claude Agent SDK as an **in-process MCP server** (the SDK supports SDK-defined MCP servers; no subprocess, no socket). Each MCP tool handler calls `dispatchTool` — the provider never reimplements or bypasses policy.
- Every SDK-initiated tool call therefore routes through the kernel chain — per-agent allowlist → `ApprovalPolicy` (03's engine, including remote approval) → `Executor` — and the result returns to the SDK. The SDK's own built-in tools (file/bash/etc.) are **disallowed** via `allowedTools`/`disallowedTools`; Stratus tools are the only capability surface.
- Real history: use the SDK's session/`resume` support instead of transcript flattening, mapping Stratus session id ↔ SDK session id in session `metadata` (same pattern as the Anthropic provider's `anthropicRawTurns`).
- Kernel events emitted faithfully: SDK tool activity surfaces as normal `tool.called`/`tool.completed` (and delta) events so Slack status lines, approvals, and the dashboard behave identically on both billing paths.
- Provider parity tests: a scripted scenario (tool call + memory write + resume) that must pass identically on `provider-anthropic` and `provider-claude-code`.

**Out:** using the SDK's own permission modes as a policy layer (kernel policy is the only policy); exposing SDK subagents/skills; any change to the API-key path.

## Design sketch

- The provider builds the MCP server per `generate` call from `ProviderRequest.tools` (the runner already resolves the agent's allowlist), so tool scope always matches the agent, including delegated sub-agents which carry their own allowlists.
- Approval blocking: an SDK tool call awaiting remote approval simply awaits the kernel promise — the SDK sees a slow tool, not a special state. The activity watchdog (01) must therefore treat "awaiting approval" as progress, not a stall.
- **Restart survival is explicitly narrower on this path.** Step 03's checkpointed recovery is keyed to a kernel provider-response part; it cannot reconstruct the SDK's inner loop or the MCP handler awaiting the decision — that state dies with the daemon. So this provider is excluded from the resume-the-exact-call guarantee: if `stratusd` restarts while an SDK-path call awaits approval, recovery fails the turn cleanly — the pending approval prompt is expired/updated, the session is marked `failed` with an explicit reason, and the user is told to resend. Honest degradation beats a half-specified continuation protocol.
- Keep the existing billing hygiene: blank `ANTHROPIC_API_KEY` in the SDK environment, set `CLAUDE_CODE_OAUTH_TOKEN`, keep `CLAUDE_AGENT_SDK_CLIENT_APP: 'stratus-agent'`.
- If SDK sessions prove unreliable for resume-across-restarts, fall back to replaying kernel history into a fresh SDK session — correctness over cleverness; note the cost in the PR.

## Acceptance criteria

- A subscription-path agent uses `memory.remember` in Slack and recalls the fact in a later thread after a daemon restart.
- A gated tool call from the SDK path triggers the same Slack approval buttons as the API-key path, and **Deny** returns a failed tool result the model handles gracefully.
- The SDK cannot invoke any capability outside the agent's allowlist (test: an agent without `demo.echo` asks for it; call is rejected at the kernel gate, not by prompt luck).
- Parity suite green on both providers; no behavior change on `provider-anthropic`.
- A daemon restart during an SDK-path pending approval fails that turn cleanly: the approval prompt is expired (no orphaned buttons), the session shows a distinguishable failure reason, and the pending call was never executed.

## Open questions

- Streaming deltas out of the SDK: partial-message events vary by SDK version — confirm what the pinned `@anthropic-ai/claude-agent-sdk` emits and map what's available; text-only deltas are acceptable for v1 of this step.
- Where SDK session state lives on disk (the SDK manages its own storage) and whether it needs to be included in any backup/retention story from 01.
- Whether a durable continuation for the SDK inner loop is ever worth building (replay the SDK session up to the pending call on restart?) or clean failure remains the long-term answer.
