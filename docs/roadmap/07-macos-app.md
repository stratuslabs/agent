# 07 — macOS App: visual agent creation and management

## Goal

A native SwiftUI app whose job is the thing the CLI is worst at: creating and managing agents through an interface. Create an agent visually, edit its soul, manage settings, models, and credentials, and control the local daemon — without touching a terminal.

## Why now

By this point the runtime story is complete (gateway, Slack, permissions, tools, API). The remaining friction is onboarding and management ergonomics: `stratus setup` and soul-file editing work, but they're CLI experiences. The app makes agent creation the product's front door for non-terminal users — and it is deliberately **not a chat app**.

## Scope

**In:**

- **Agent creation flow**: the visual equivalent of `stratus agent new` + setup — name (or generate one), personality/instructions editor with the generated avatar preview (same deterministic palette the kernel computes), provider/model pickers populated live from the control API, tool allowlist as checkboxes sourced from installed packs, credential allowlist. Output is a standard soul file in `~/.stratus/agents/` — the app writes nothing the CLI can't read.
- **Roster management**: list agents with avatars/status, edit souls (form view + raw markdown view of the same file), duplicate, archive/delete.
- **Settings management**: default/fallback provider and model, credential entry (validated against the live API the same way `stratus setup` verifies keys), per-agent permission mode and approver (03), channel bindings (which Slack app/token pair an agent uses, 02).
- **Daemon control**: start/stop/restart `stratusd`, install/uninstall the launchd plist, health and uptime from `GET /api/health`, a live activity feed from the WS event stream (read-only monitoring, not chat).
- Distribution: signed + notarized DMG with auto-updates (Sparkle).

**Out:** chat UI (explicitly — the dashboard covers it, and the API makes it easy to add here later if ever wanted); iOS (dropped from the roadmap entirely); editing memory contents; any agent-loop or provider code in Swift. The app must contain **zero runtime**.

## Design sketch

- **Two access paths, one source of truth.** When the daemon runs, the app uses the control API (05) with the token from `~/.stratus/gateway-token`. For state that must be editable while the daemon is down (souls, config, credentials), the app reads/writes the same `~/.stratus` files the CLI uses — the file formats (`config.json`, `credentials.json` 0600, `agents/*.md` soul frontmatter) are the compatibility contract, so this step includes documenting them as such in the repo (`docs/architecture/state-files.md`, referenced from both CLI and app).
- Soul frontmatter parsing exists once in TypeScript (`parseSoul` in `packages/agents`); the Swift side needs a parser for the same minimal dialect — keep the dialect frozen or expose a validation endpoint on the API so the app can round-trip safely. (Bias: validate via API when daemon is up; conservative writer in Swift regardless.)
- Menu bar presence with the roster at a glance; main window for creation/editing.
- Credentials go into `~/.stratus/credentials.json` to stay CLI-compatible (not Keychain-only), preserving its 0600 posture; Keychain migration is a possible later hardening once both consumers can read it.

## Acceptance criteria

- On a clean Mac with the CLI installed: open app → create an agent (name, personality, model, tools) → the agent appears in `stratus agents` output unchanged, and answers in Slack once its token is bound — no terminal use beyond installing the app/CLI.
- Edit a soul in the app while the daemon runs; the next conversation turn uses the updated instructions — including in *existing* sessions, since gateway dispatch re-resolves the agent definition from the roster each turn (01) after 05's `POST /api/roster/reload` picks up the file change.
- Daemon control works: install launchd plist, stop/start, health reflects reality; killing the daemon out-of-band shows unhealthy within seconds.
- Every file the app writes is byte-compatible with the CLI: `stratus setup` and the app can be used interchangeably without either corrupting the other's state.
- App contains no provider/tool/loop code (review-level check, but real: the only network calls are to the control API and Apple/Sparkle endpoints).

## Open questions

- Repo home: this monorepo (a `apps/macos/` Swift package alongside `packages/`) vs. a separate repo. Bias: separate repo pinned to a control-API version, since toolchains and release cadence differ.
- Does the app bundle the CLI/daemon (single download) or require installing `@stratusagent/cli` separately? Bundling is the better product answer but drags Node distribution along — decide when 05's API is stable.
