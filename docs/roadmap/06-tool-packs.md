# 06 — Tool Packs: fs, shell, browser

## Goal

Real capabilities as optional packages — filesystem, shell, and browser tools an agent opts into via its soul's allowlist — replacing `demo.echo` as the only thing agents can actually do.

## Why now

The permission engine (03) exists precisely so agents can be trusted with these, and an agent's usefulness is bounded by its tools. Existing work to fold in: `stratuslabs/tool-browser` and `stratuslabs/tool-screenshot`.

## Scope

**In:**

- **Pack convention**: a tool pack is a package exporting a kernel `Plugin` (`{ name, setup(ctx) }`) that registers its tools plus pack-level config (roots, limits). Tools carry the risk level introduced in 03 (`safe` / `gated` / `dangerous`) in their `ToolDescriptor`. Souls opt in per tool (`tools: [fs.read, fs.write]`) or per pack (`tools: [fs.*]` — add glob support to the kernel allowlist check).
- **`@stratusagent/tool-fs`**: `fs.read`, `fs.write`, `fs.list`, `fs.search`. Path-allowlist roots per agent (config), traversal-safe resolution, output truncation with an explicit `truncated` marker, binary detection. Reads `safe` within roots; writes `gated`.
- **`@stratusagent/tool-shell`**: `shell.run` built on the existing `LocalCommandTool` / `createLocalCommandExecutor` seam (`packages/executor-local`), with cwd pinning, env scrubbing (only explicitly granted vars — never the daemon's full env, which holds credentials), timeout, and output caps. Approval semantics come entirely from 03 — this pack contributes the command string and nothing else.
- **`@stratusagent/tool-browser`**: Playwright-based; `browser.goto`, `browser.read` (readability-extracted page text), `browser.screenshot`, `browser.act` (click/type by selector or text). Session-scoped browser contexts with an idle teardown; screenshots returned as file paths under a per-agent workspace dir so channels can upload them. Folds in the `tool-browser` / `tool-screenshot` repos rather than starting over. Navigation/read `gated` by default; `act` `dangerous`.
- Gateway/CLI wiring: packs declared in config (`tools: { fs: {roots: [...]}, shell: {}, browser: {} }`), loaded via the existing `PluginRegistry` at startup. CLI `stratus run`/`chat` can load the same packs so local testing matches daemon behavior.

**Out:** MCP client support (worth a future step of its own — the pack convention shouldn't preclude it), network/HTTP tool beyond the browser, code-execution sandboxes, per-tool billing/metering (08 territory).

## Design sketch

- Packs depend on `core` (and `executor-local` where relevant) only — never on the gateway — so they work identically in CLI one-shots, the daemon, and future embedded uses.
- `PluginContext` today exposes `{ bus, tools }`; pack configuration therefore flows through the pack's factory (`createFsPack(config)`) rather than through the context — no kernel change needed.
- Browser lifecycle is the risky bit operationally: one Chromium per gateway, contexts per agent-session, hard cap on concurrent contexts, watchdog kills leaked pages. The pack owns all of that; the kernel just sees tools.
- Each pack README documents its risk model in one table (tool → risk → what approval mode does).

## Acceptance criteria

- An agent whose soul lists `fs.read` + `fs.search` can answer questions about files under its configured root, and *cannot* write (kernel allowlist gate, tested).
- `shell.run` in headless mode: safe-listed command executes; metacharacter chain is denied (03 integration test through a real pack).
- A Slack agent can be asked "screenshot example.com and show me" end-to-end: browser tool runs (with approval if gated), screenshot lands in Slack.
- Env scrubbing verified: a shell tool cannot read `ANTHROPIC_API_KEY` or anything from `~/.stratus/credentials.json` via environment.
- Packs are independently installable — a build with only `tool-fs` present works; nothing in gateway/CLI hard-imports any pack.

## Open questions

- Per-agent workspace directories (`~/.stratus/workspaces/<agent-id>/`) as a general convention for tool outputs — introduce here or wait for a dedicated step? (Leaning: introduce here minimally; screenshots need somewhere to live.)
- Playwright's install weight on target machines vs. reusing an installed Chrome via channel selection — decide in the PR with real numbers.
