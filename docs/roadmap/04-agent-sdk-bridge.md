# 04 — Agent SDK Tool Bridge: tools + real history on the subscription path

## Goal

Agents billed through a Claude subscription (the `@stratusagent/provider-claude-code` path) get full tool calling and real multi-turn history, with every tool call still flowing through the kernel's registry, approval policy, and executor.

## Why now

Agents may run on either billing path, and today they aren't equivalent: the claude-code provider passes `tools: []` with `maxTurns: 1` and flattens the session into a `Conversation so far:` prompt string, so a subscription agent can't even use `memory.remember`. This is also where the "kernel owns the loop" decision becomes enforceable: the Agent SDK must never become a side door around permissions and memory.

## Scope

**In:**

- **Kernel contract addition — a callable tool-dispatch seam.** Today `ProviderRequest.tools` carries only `ToolDescriptor` schemas, and the allowlist → approval → executor chain lives in the runner's private `executeToolCall` — descriptors alone let a provider *advertise* tools but not *execute* them. Add a `ToolDispatcher` handed to providers on the request (`request.dispatchTool(call) → ToolResult`) that runs the full kernel chain, **appends the paired tool-call/tool-result messages to the session and saves it**, and emits the standard `tool.*` events. Persistence is part of the dispatcher's contract, not a courtesy: the SDK consumes tool results internally and returns only final text, so without dispatcher-side recording a durable Stratus session would omit every SDK tool interaction — and the kernel-history replay fallback below could never reconstruct a tool-using conversation. Any provider that hosts its own inner loop needs this seam; the MCP handlers below are its first consumer.
- Rework `@stratusagent/provider-claude-code` to expose the session's kernel tools to the Claude Agent SDK as an **in-process MCP server** (the SDK supports SDK-defined MCP servers; no subprocess, no socket). Each MCP tool handler calls `dispatchTool` — the provider never reimplements or bypasses policy.
- Every SDK-initiated tool call therefore routes through the kernel chain — per-agent allowlist → `ApprovalPolicy` (03's engine, including remote approval) → `Executor` — and the result returns to the SDK. The SDK's own built-in tools (file/bash/etc.) are **disallowed** via `allowedTools`/`disallowedTools`; Stratus tools are the only capability surface.
- Real history: use the SDK's session/`resume` support instead of transcript flattening, mapping Stratus session id ↔ SDK session id in session `metadata` (same pattern as the Anthropic provider's `anthropicRawTurns`).
- Kernel events emitted faithfully: SDK tool activity surfaces as normal `tool.called`/`tool.completed` (and delta) events so Slack status lines, approvals, and the dashboard behave identically on both billing paths.
- Provider parity tests: a scripted scenario (tool call + memory write + resume) that must pass identically on `provider-anthropic` and `provider-claude-code`.

**Out:** using the SDK's own permission modes as a policy layer (kernel policy is the only policy); exposing SDK subagents/skills; any change to the API-key path.

## Design sketch

- The provider builds the MCP server per `generate` call from `ProviderRequest.tools` (the runner already resolves the agent's allowlist), so tool scope always matches the agent, including delegated sub-agents which carry their own allowlists.
- Approval blocking: an SDK tool call awaiting remote approval simply awaits the kernel promise — the SDK sees a slow tool, not a special state. The activity watchdog (01) must therefore treat "awaiting approval" as progress, not a stall. **It does, by two mechanisms, and only one of them is the watchdog:**

  - The gateway watchdog never arms on this path at all. `streamsDeltas` is `config.provider === 'anthropic' && Boolean(config.apiKey)`, and the subscription runtime is selected by `authToken && !apiKey` — so `effectiveStreams` is false, `streamingActive` starts false, and neither the initial arm nor the drain's re-arm ever fires.
  - The provider's own idle timer (10 minutes) is explicitly suspended for the whole hosted-tool window. `countedExecute` increments `activeHostedTools` and calls `suspendIdleTimer()` before awaiting the executor, and `resetIdleTimer()` returns early while that count is above zero — so the approval wait inside `executeHostedToolCall` is covered by construction, not by luck.

  **The second of those is now the only one holding it, and that is deliberate.** The subscription path streams, so `streamsDeltas` is true for it and the gateway watchdog *is* armed here — which is exactly the condition this spec previously recorded as the thing that would break the requirement. It does not, because the watchdog no longer infers a tool phase from the part count on `provider.response`:

  ```ts
  pendingTools = event.parts.filter((part) => part.type !== 'text').length;
  ```

  A provider hosting its own loop dispatches inside `generate()` and never emits that response before the call, so the count is zero for the whole hosted phase — approval wait, executor, and all. The watchdog now also tracks the kernel's own tool events, which every path emits because every path runs its tools through the same executor: `tool.approval-requested` or `tool.called` opens a phase by call id, `tool.completed` or `tool.denied` settles it, and the timer arms only when nothing is open. Opening at the approval rather than at `tool.called` matters — the wait for a human is the longest part and comes first — and holding it through the executor matters too, since `executor-local`'s `DEFAULT_MAX_TIMEOUT_MS` is 300_000 against a 120_000 idle timeout.

- **Restart survival is explicitly narrower on this path.** Step 03's checkpointed recovery is keyed to a kernel provider-response part; it cannot reconstruct the SDK's inner loop or the MCP handler awaiting the decision — that state dies with the daemon. So this provider is excluded from the resume-the-exact-call guarantee: if `stratusd` restarts while an SDK-path call awaits approval, recovery fails the turn cleanly — the pending approval prompt is expired/updated, the session is marked `failed` with an explicit reason, and the user is told to resend. Honest degradation beats a half-specified continuation protocol.
- Keep the existing billing hygiene: blank `ANTHROPIC_API_KEY` in the SDK environment, set `CLAUDE_CODE_OAUTH_TOKEN`, keep `CLAUDE_AGENT_SDK_CLIENT_APP: 'stratus-agent'`.
- If SDK sessions prove unreliable for resume-across-restarts, fall back to replaying kernel history into a fresh SDK session — correctness over cleverness; note the cost in the PR.

## Already shipped, and what it changes here

The tool half of this step landed early, in [#31](https://github.com/stratuslabs/agent/pull/31), and two later PRs moved the line again. Recorded here so the remaining work is the *actual* remaining work:

| Scope item | State |
|---|---|
| Callable tool-dispatch seam | **Shipped, in a different shape than specified.** It is `AgentRunner.executeHostedToolCall`, threaded to the provider as a `createRuntimeProvider` argument, not `request.dispatchTool` on `ProviderRequest`. So it is caller-wired rather than request-carried: both first-party callers (gateway and CLI) pass a late-bound closure into it, and any future embedder has to remember to. Worth revisiting only if a third caller appears — the seam itself is the one the spec asked for. |
| Dispatcher-side persistence | **Shipped, later than the bridge.** #31 shipped without it and named the gap; the paired `tool_use`/`tool_result` messages were added with the approval checkpoint work in #51 (`d457e05`, `abc3fe0`), which needed the same invariant. The claude-code transcript builder was taught to render both, so a bridged call now survives into the next turn's history instead of vanishing from it. |
| In-process MCP server | **Shipped.** Kernel tools become SDK MCP tools under a `stratus` server; names flattened to the MCP charset with the dotted original in the closure. |
| SDK built-ins disallowed | **Shipped.** `tools: []` plus an `allowedTools` restricted to the bridged names. |
| Kernel-faithful events | **Shipped.** Bridged calls emit the standard `tool.called` / `tool.completed` / `tool.denied`. |
| Streaming deltas | **Shipped.** `includePartialMessages` is requested only when a consumer supplied a sink, and each `stream_event` maps to the kernel's delta union the same way the API provider maps the same shapes — text, a content-free `thinking` signal, and tool-call fragments, with tool names translated back out of MCP's charset through the one helper the bridge names them with. Shipped together with the watchdog's tool-phase signal, which enabling this made load-bearing. |
| SDK-native history via `resume` | **Shipped.** A session records the SDK's session id in metadata under `SDK_SESSION_METADATA_KEY` (the treatment the Anthropic provider gives its raw turns), and later turns pass `resume` and send only the newest user message. Transcript flattening remains as the recovery path: a stored id the SDK no longer has replays kernel history into a fresh session — but only when no hosted tool has run that turn, since replaying would repeat its side effects. |
| Clean restart on this path | **Shipped.** A startup sweep fails the turns the last process was still running, with `ABANDONED_TURN_ERROR` as the reason — the state a hosted approval is in when a daemon dies, since `executeHostedToolCall` passes `recoverable: false` and so never checkpoints. Read before the channels come up (so the list is exactly what the last process left) and applied after (so the failure is emitted where surfaces can hear it); single-flight is what makes the gap safe. The criterion's other clause was corrected rather than implemented — see below. |
| Provider parity tests | **Shipped.** `packages/state/test/parity.test.ts` runs one scripted turn (tool call + memory write) on both providers and asserts the kernel-observable result — tool and arguments, memory written, `tool.*` events, paired call/result records, final text, status. It lives in `state` because that is the package depending on both providers, and it is where `createRuntimeProvider` chooses between them. The resume leg asserts a second turn lands identically on both paths and that only the subscription path carries an SDK session id — the one place they differ by design. |

The clean-restart criterion was the last one open, and working it out changed the criterion as well as the code. Two things are worth carrying forward:

- **"A daemon restart" meant a crash all along.** A graceful stop already handles this completely, and not by accident: `stop()` denies everything parked before it drains, which both retracts the Slack buttons and releases the turns to finish. So an operator restarting the daemon normally has nothing left behind. What the criterion is really about is the ungraceful death — SIGKILL, a panic, a lost machine — where nothing runs on the way out.
- **The "no orphaned buttons" clause asked this path for something no path does.** Expiring a prompt whose process is gone needs the posted message to be findable after a restart, and the Slack adapter's index of them (`approvalPosts`) is in-memory and keyed by request id; a new process starts empty. That is why the button handler already answers an unknown click with "That approval request is no longer pending" — the orphan is a known, handled state. It is equally orphaned on 03's checkpointed path, which re-asks in a *new* message and leaves the old one sitting there, so this was never an SDK-bridge property. The clause is corrected below, and the durable version is recorded as its own item rather than smuggled in here.

## Acceptance criteria

- A subscription-path agent uses `memory.remember` in Slack and recalls the fact in a later thread after a daemon restart.
- A gated tool call from the SDK path triggers the same Slack approval buttons as the API-key path, and **Deny** returns a failed tool result the model handles gracefully.
- The SDK cannot invoke any capability outside the agent's allowlist (test: an agent without `demo.echo` asks for it; call is rejected at the kernel gate, not by prompt luck).
- Parity suite green on both providers; no behavior change on `provider-anthropic`.
- A daemon restart during an SDK-path pending approval fails that turn cleanly: the session comes back `failed` with a reason that distinguishes "nobody finished this" from a provider or tool failure, and the pending call was never executed. The buttons from the lost process stay posted and answer a click by saying the request is no longer pending — retracting them needs a durable message index, which is the Slack adapter's to own and applies to the checkpointed path identically.

## Follow-ups this step named but does not own

- **A durable index of posted approval messages, in the Slack adapter.** ~~Shipped in part.~~ The cheap half is done: a click on a prompt this process never posted rewrites the message from the click's own coordinates, so the dead-end corrects itself without persisting anything. What remains is the expensive half — retracting prompts *nobody clicks*, which needs the posts to survive the process that made them. Still applies to both billing paths equally.
- ~~**Reporting a turn's failure into its thread when no renderer is live.**~~ **Shipped.** A `session.failed` with nothing rendering that session is reported where the turn was asked, routed through a new `sessionRouting` accessor on the gateway — the session's agent and the metadata the dispatching surface wrote, deliberately not the session itself, since reading a channel's own routing keys back is a different capability from reading the conversation.

## Open questions

- Streaming deltas out of the SDK: partial-message events vary by SDK version — confirm what the pinned `@anthropic-ai/claude-agent-sdk` emits and map what's available; text-only deltas are acceptable for v1 of this step.
- Where SDK session state lives on disk (the SDK manages its own storage) and whether it needs to be included in any backup/retention story from 01.
- Whether a durable continuation for the SDK inner loop is ever worth building (replay the SDK session up to the pending call on restart?) or clean failure remains the long-term answer.
