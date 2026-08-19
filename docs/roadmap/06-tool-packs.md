# 06 — Tools: fs, shell, browser, web

## Goal

Real capabilities as optional plugins — filesystem, shell, browser, and web-fetch toolsets an agent opts into via its soul's allowlist — replacing `demo.echo` as the only thing agents can actually do.

The plugin contract this step implements against — what a plugin is, what it may contribute, how it is configured, and the trust model for third-party ones — is specified in [`plugins.md`](../architecture/plugins.md) and is not re-derived here.

## Why now

The permission engine (03) exists precisely so agents can be trusted with these, and an agent's usefulness is bounded by its tools. Existing work to fold in: `stratuslabs/tool-browser` and `stratuslabs/tool-screenshot`.

**Inherited from [03](./03-permissions.md): the command-scope allowlist.** 03 shipped the risk model and the `headless` / `interactive` modes, but deliberately left the shell-command machinery unbuilt — safe `git` scopes with flag and refspec constraints, control-operator defeat, and the persistent per-agent whitelist at `~/.stratus/agents/<id>.whitelist.json`. It has no caller until `shell.run` exists: every tool in the repo today is fixed-argv, so a parser and a scope format written earlier would have been shaped by guesses about this pack rather than by it.

That work lands here, with `@stratusagent/tool-shell`, where each rule can be tested against real invocations. The design is specified in 03 and does not need re-deriving; what this step adds is the consumer and the evidence. Until it exists, `shell.run` in a daemon is refused rather than narrowed — every gated call needs a human, which is the honest behavior but not a usable one for a shell.

## Scope

**In:**

- **The plugin convention, made real**: each of these is a package exporting a kernel `Plugin` (`{ name, setup(ctx) }`) that registers a toolset plus its own config (roots, limits). Tools carry the risk level introduced in 03 (`safe` / `gated` / `dangerous`) in their `ToolDescriptor`. Souls opt in per tool (`tools: [fs.read, fs.write]`) or per toolset (`tools: [fs.*]` — add glob support to the kernel allowlist check). Manifest validation and the third-party risk floor are specified in [`plugins.md`](../architecture/plugins.md); this step is the first consumer of both, and the first proof the contract survives contact with a real toolset.
- **`@stratusagent/tool-fs`**: `fs.read`, `fs.write`, `fs.list`, `fs.search`. Path-allowlist roots per agent — configured in the plugin's `agents` sub-block and resolved per call from `session.agent.id`, never closed over at setup, because these roots are an access boundary between agents and not a preference ([`plugins.md`](../architecture/plugins.md)) — with **symlink-safe containment** — lexical traversal checks aren't enough, since a symlink inside a root can target `~/.stratus/credentials.json`. Resolution canonicalizes the real target (and, for writes, the parent directory) and requires it inside the root, with no-follow/open-relative handling to resist symlink-swap races. Output truncation with an explicit `truncated` marker, binary detection. Reads `safe` within roots; writes `gated`.
- **`@stratusagent/tool-shell`**: `shell.run` built on the existing `LocalCommandTool` / `createLocalCommandExecutor` seam (`packages/executor-local`), with cwd pinning, timeout, and output caps. Env scrubbing requires an executor change, not just pack discipline: `createLocalCommandExecutor` today spawns with `{ ...process.env, ...invocation.env }`, so this step adds a **replacement-environment mode** (the child receives *only* explicitly granted vars — never the daemon's env, which holds credentials) and the shell pack is required to use it. Approval semantics come entirely from 03 — this pack contributes the command string and nothing else.
- **`@stratusagent/tool-browser`**: Playwright-based; `browser.goto`, `browser.read` (readability-extracted page text), `browser.screenshot`, `browser.act` (click/type by selector or text). Session-scoped browser contexts with an idle teardown; screenshots returned as file paths under a per-agent workspace dir so channels can upload them via the channel contract's file-upload operation (02). Folds in the `tool-browser` / `tool-screenshot` repos rather than starting over. Navigation/read `gated` by default; `act` `dangerous`. **Network target validation is the pack's job, not the approval dialog's**: approval covers only the requested invocation, so the pack enforces a request-level policy via Playwright interception — first a scheme allowlist (`http:`/`https:` only; `file:` and other local schemes are rejected before navigation, since Chromium runs as the daemon user and address validation cannot protect the filesystem), then resolving and checking every request (initial navigation, redirects, and subresources) and blocking **every non-global address in both IP families** by default — loopback, RFC 1918, link-local (cloud metadata endpoints, the localhost gateway), IPv6 unique-local (`fc00::/7`), and IPv4-mapped IPv6 forms — with an explicit allowlist override for trusted-workstation deployments; a range-enumeration blacklist that stops at RFC 1918 leaves the same SSRF path open on dual-stack networks. Validation must bind to the **actual connection**, not a separate lookup — resolving in the interception handler while Chromium resolves again independently is a DNS-rebinding race — so the pack pins connections to the validated address (host-resolver rules, or a pack-owned egress proxy that verifies the peer at connect time), and the VM/hosted profiles back it with network-level egress rules (08's hardening checklist). Without this, an approved public URL could redirect or rebind the browser into internal services.
- **`@stratusagent/tool-web`**: `web.fetch` — retrieve a URL and return readability-extracted text, with no browser and no Playwright. This is the capability an agent reaches for twenty times for every once it needs `browser.*`, and paying Chromium's startup and memory for it is the wrong trade. **The address policy is one implementation, shared**: the scheme allowlist and the non-global-address rejection specified for `tool-browser` above live in a module both plugins import — a second hand-rolled copy of that rule is exactly the defect `CLAUDE.md` opens with, and here it would be an SSRF hole rather than a drift. `gated`. Search is deliberately *not* here: every backend needs a vendor key and a commercial relationship, so `web.search` is the ecosystem's ([`plugins.md`](../architecture/plugins.md)).
- Gateway/CLI wiring: plugins declared in config under the `plugins` block (`"plugins": { "@stratusagent/tool-fs": { "enabled": true, "roots": [...] } }`), loaded via the existing `PluginRegistry` at startup. Keyed by package name, not by toolset, because a plugin may contribute more than tools — see [`plugins.md`](../architecture/plugins.md). CLI `stratus run`/`chat` loads the same plugins so local testing matches daemon behavior.

**Out:** MCP client support (now [11](./11-mcp.md) — the plugin convention this step proves is what it builds on), web *search* (a vendor relationship, so third-party), code-execution sandboxes, per-tool billing/metering (08 territory), and skills ([09](./09-skills.md) — a rubric for using these tools is not one of them).

## Design sketch

- These plugins depend on `core` (and `executor-local` where relevant) only — never on the gateway — so they work identically in CLI one-shots, the daemon, and future embedded uses.
- `PluginContext` today exposes `{ bus, tools }`; plugin configuration therefore flows through the package's `createPlugin(config)` factory (the module ABI in [`plugins.md`](../architecture/plugins.md)) rather than through the context — no kernel change needed for this step. The context's growth is authorized in [`stratus-v2.md`](../architecture/stratus-v2.md) and lands with the steps that need it.
- Browser lifecycle is the risky bit operationally: one Chromium per gateway, contexts per agent-session, hard cap on concurrent contexts, watchdog kills leaked pages. The plugin owns all of that; the kernel just sees tools.
- Each plugin README documents its risk model in one table (tool → risk → what approval mode does).

## Acceptance criteria

- An agent whose soul lists `fs.read` + `fs.search` can answer questions about files under its configured root, and *cannot* write (kernel allowlist gate, tested).
- Two agents with different `roots` cannot read each other's: the same `fs.read` call, run under each session, resolves to a different allowed set — the test that fails if the plugin resolves roots once at setup instead of per call.
- `shell.run` in headless mode: safe-listed command executes; a control-operator chain is denied (03 integration test through a real pack).
- A Slack agent can be asked "screenshot example.com and show me" end-to-end: browser tool runs (with approval if gated), screenshot lands in Slack.
- Env scrubbing verified: a shell tool cannot read `ANTHROPIC_API_KEY` or anything from `~/.stratus/credentials.json` via environment.
- A page redirecting `browser.goto`/`browser.read` to `http://169.254.169.254/` or the localhost gateway is blocked at the request level, not just at invocation approval, and a `file:///…/credentials.json` URL is rejected before navigation (tested).
- `web.fetch` refuses the same addresses and schemes as `browser.*`, proven by a test that runs the *same* table of hostile URLs through both — if the shared module is ever forked, that test is what fails.
- A symlink inside an allowed fs root targeting a file outside it is neither readable nor writable through `fs.*` (symlink-escape tests, including the write-through-parent case).
- Plugins are independently installable — a build with only `tool-fs` present works; nothing in gateway/CLI hard-imports any of them.

## Open questions

- Per-agent workspace directories (`~/.stratus/workspaces/<agent-id>/`) as a general convention for tool outputs — introduce here or wait for a dedicated step? (Leaning: introduce here minimally; screenshots need somewhere to live.)
- Is `web.fetch` enough of a research tool without a search backend, or does an out-of-the-box agent need one bundled? Decide with the first real research agent, not in advance.
- Playwright's install weight on target machines vs. reusing an installed Chrome via channel selection — decide in the PR with real numbers.
