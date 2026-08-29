# Working in this repo

Conventions that are easy to get wrong here, and the reasons behind them.
Read before making changes.

## Documentation lands with the change

A user-visible change is not done until it is documented in the same PR.
That means a new command or flag, a changed default, a new file the CLI
writes, a changed setup menu — anything someone could notice without
reading the source.

Where things are documented:

- `docs/` — the detailed surface, one home per fact. A command or flag
  lands in `docs/reference/cli.md` *and* the guide that owns its behavior
  (`docs/guides/…`); a config key in `docs/reference/config.md` plus its
  guide; a new file the CLI writes in the guide that owns that area.
  `docs/README.md` is the index — a new page gets a row there.
- `README.md` (root) — the pitch: quickstart, the feature table, the docs
  table. Links, never depth: a fact documented in `docs/` is not restated
  here, because the restated copy is the one that drifts.
- `packages/cli/README.md` — the npm page: install, the command and
  options tables, links into `docs/`. Same rule — link, don't restate.
  Links and images here must be **absolute** `github.com` /
  `raw.githubusercontent.com` URLs: npm does not resolve monorepo-relative
  paths, and it renders this file only on publish.
- `HELP_TEXT` in `packages/cli/src/index.ts` — every command and flag.
- `packages/channel-slack/README.md` — the Slack app setup.
- `packages/control-api/README.md` — the HTTP + WS surface: every endpoint,
  the auth model, the event envelope, the `api` config block. Both other
  surfaces (the macOS app, a hosted deployment) are written against this
  document, so an endpoint that changes shape changes here first.

Deferring is allowed when a PR is already large. Say so in the PR body
and say when it lands — three commands shipped undocumented across #39,
#40, and #41 because each PR deferred it and nothing tracked the debt.

## Vocabulary

One word per thing, because the ecosystem reads these docs before it reads the
code. Specified in `docs/architecture/plugins.md`; do not coin a synonym.

- **Plugin** — one package, the unit of distribution and installation. It
  *contributes* tools, skills, providers, channels, memory stores, executors,
  or hooks. This is what `Plugin` in `packages/core` already means.
- **Tool** — a callable action, named `namespace.verb` (`fs.read`).
- **Toolset** — the namespace a group of tools shares (`fs`), and what
  `tools: [fs.*]` globs over.
- **Skill** — markdown that teaches an agent a procedure. Not code; a skill
  that needs to *do* something is a plugin contributing a tool.
- **Soul** — the markdown file defining an agent: persona plus the `tools`,
  `skills`, and `credentials` it may use.

"Tool pack" is retired — it was 06's word and has no extension to providers,
channels, or memory. `@stratusagent/tool-fs` is a plugin contributing the `fs`
toolset.

## Do not re-derive rules that live somewhere else

The single most repeated defect in this codebase's review history. Config
resolution, credential selection, and soul-pin demotion have exactly one
implementation each, and a second hand-rolled copy drifts from it
immediately:

- What a run would use → `resolveRuntimeConfig` from `@stratusagent/state`.
  Never re-implement the precedence chain.
- Which env var holds the key → `apiKeyEnvNameFor` / `resolveEnvApiKey`.
- What a pinned soul demotes → `applySoulPins`, exported from
  `@stratusagent/state` (and re-exported by `@stratusagent/gateway`, which is
  where it used to live).
- What a run as an agent resolves to → `servedRuntimes`; the roster as data →
  `listAgentSummaries`; which models a sign-in can reach →
  `collectAvailableModels`; whether a key works → `verifyProviderKey`. All in
  `@stratusagent/state`, all previously private to the CLI, all now with two
  consumers.

If you need a rule that is not exported, export it. Do not copy it.

## Code shape

There is no linter and no formatter — `pnpm build && pnpm typecheck &&
pnpm test` is the whole automated gate — so everything below is held by
hand and by review:

- **ESM, named exports, one entry per package.** `src/index.ts` is the
  only public surface, re-exporting **by explicit name** — no `export *`,
  no `export default`. Adding a symbol to the barrel is an API decision;
  make it deliberately.
- **Relative imports end in `.ts`** (`from './paths.ts'`) — package
  tsconfigs set `rewriteRelativeImportExtensions`, and tests import
  `../src/index.ts` under type stripping. Cross-package, use the bare
  `@stratusagent/<pkg>` specifier, never a deep path.
- **Arrow consts, never `function` declarations.** Classes are the
  exception, kept for stateful long-lived objects — the kernel
  registries and stores, runners and executors (`AgentRunner`,
  `LocalCommandExecutor`, `BrowserSessionPool`) — and for error types:
  an error is `class X extends Error` that sets `this.name` in its
  constructor and is exported from the barrel. Plain values and
  stateless behavior come from a `create*` (construct a live thing) or
  `define*` (canonicalize a definition literal) factory returning a
  plain object.
- **The strict flags are load-bearing.** `exactOptionalPropertyTypes`
  means an optional property is added with a conditional spread —
  `...(x !== undefined ? { x } : {})` — never assigned `undefined`.
  Check against `undefined`, not truthiness, unless dropping the falsy
  values is the point: `0` and `false` are real settings here (`--api-port 0`
  asks for any free port). `any` appears nowhere in src; narrow from
  `unknown` instead.
- **Tools throw plain `Error`s; the executor converts.** In any package
  that can depend on `@stratusagent/executors`, build `ToolResult`s
  through its `successResult`/`failureResult`, never hand-rolled
  `{ ok, error }` — `core` is the one exception, since `executors`
  depends on it and core stays dependency-free. HTTP failures throw
  `ApiError(status, code, message)`. Error text a user
  will read is a full sentence that names the fix:
  `No schedule of yours has id ${id}. schedule.list shows what exists.`
- **Comments explain why, and cite the incident when there is one.**
  About a quarter of src is comments, and they are how a rule survives
  the next refactor — tool-fs resolving per-agent config on every call
  carries the reason ("caching at setup would hand every agent the first
  agent's roots") in place. A comment narrating what the next line does
  is not house style; delete it.

## Refactoring: where code goes

- **New capability is a plugin behind the kernel seams, never a bigger
  kernel.** The seams are the optional `AgentRunnerOptions` slots —
  `SessionStore`, `Executor`, `ApprovalPolicy`, `ModelProvider`,
  `AgentMemoryStore`, `Plugin` — interfaces with permissive in-memory
  defaults. Extend one with an optional, defaulted method plus a JSDoc
  note on what a host that omits it gives up; never by subclassing.
- **Split a file when a concern is separately testable or separately
  shared, not by line count.** `state` grew `memory.ts` and `gateway`
  grew `schedules.ts` that way; a large `index.ts` that is one coherent
  surface stays one file.
- **`core`, `egress`, and `dashboard` carry no dependencies on
  purpose.** Keep them that way — a dependency added to `core` lands in
  every install of everything.
- The moment a private rule gets a second consumer, move it to the
  shared package and **re-export it from its old home** (the way
  `gateway` still exports `applySoulPins`) — a refactor that moves a
  symbol should break no importer.

## Runtime and tests

- **Node `>=22.13 <23 || >=23.4`.** The gateway's session store uses
  `node:sqlite`, which was unflagged on each release line separately —
  22.13.0 and 23.4.0 — so 23.0 through 23.3 are newer than the 22.x floor
  and still ship it behind a flag. Write the range, never a bare `>=22.13`,
  and do not raise or lower it casually.
- Tests run under `node --test --experimental-strip-types`. Type
  stripping means **no TypeScript parameter properties** (`constructor(private x)`)
  and no enums — write the assignment out.
- Tests are flat `node:test`: `import test from 'node:test'` and
  `import assert from 'node:assert/strict'`, top-level
  `test('a sentence describing the behavior', …)` — no `describe`/`it`,
  no assertion or mocking libraries. Files live in
  `packages/<pkg>/test/`, never beside src. Fakes are hand-written typed
  object literals (`const provider: ModelProvider = { … }`), named
  `create*`/`fake*`/`stub*` at the top of the test file; reach for
  `t.mock` only to fake timers.
- New behavior needs a test that fails without the change. Verify that it
  does; a test that passes both ways is worse than none, because it reads
  as covered.
- **`pnpm typecheck` covers test files too.** Each package's
  `tsconfig.test.json` exists for that, and it has to re-declare
  `"exclude": ["dist"]` — the package tsconfig excludes `test` so a build
  never emits it, and `exclude` filters whatever `include` matched, so an
  inherited one silently drops every file the config was written to check.
  It did exactly that until #50, hiding a stale `GatewayLike` stub and a
  `Session.agent` type the runner was already casting past.
- **Never assert timing.** A test that sleeps and then checks state is a
  race against the CI runner. Gate on the event you actually mean, and
  give the gate a way to lose so a regression fails the assertion instead
  of hanging a suite that has no timeout.

  Two real gates already exist, and a sleep in front of either is only
  guessing at what it already guarantees: `adapter.stop()` and
  `gateway.stop()` each await the work they had in flight when they were
  called. Gate on one for work your test has *already caused* — the whole
  point is that the action is complete before the gate, so the gate has
  something to wait for. Prove a gate is the gate by removing it: the
  assertion should fail, not pass more slowly.

  Neither is a general quiescence barrier, and do not write one up as
  though it were. Both drain a **one-time snapshot** of their in-flight
  set, and the Slack adapter unsubscribes from the bus only *after* that
  drain — so a turn still finishing can emit an event whose subscriber
  tracks new work the snapshot never saw. That is a real gap on shutdown,
  not only in tests: the work at risk is exactly the approval retraction
  the drain exists to deliver.

  A wall-clock number that *must* stay a wall-clock number — the watchdog
  tests, where the point is that a phase outlasts the idle timeout —
  belongs far above the work inside its own armed window, not just above
  it. That window holds soul loading, the session write, and building the
  provider: single milliseconds locally, an order of magnitude more on a
  loaded runner. The convention is `IDLE_MS = 500` with the slow phase at
  `IDLE_MS * 2`. A 100ms budget lost that race in CI and cost a cycle.

## Git

- **Merge, never rebase a branch that has been pushed.** Never
  `--amend` a pushed commit. Every push should be a fast-forward — force
  pushes destroy review context and are not wanted here.
- One PR at a time, based off `main`, not stacked on another branch.
- Never push to a branch other than the one you were asked to work on.

## Before you push

What review here actually catches, in the order to check it yourself:

1. `pnpm build && pnpm typecheck && pnpm test` green — the whole CI gate;
   no linter backstops what these miss.
2. Re-read your own diff adversarially: what would make a reviewer reject
   it? Fix that now, not in the follow-up commit.
3. The new-behavior test fails without the change — actually verify it
   does (see Runtime and tests).
4. Everything user-visible has a docs change in this same PR, in the file
   the map at the top names.
5. The diff is minimal: no drive-by reformatting, no widening beyond what
   the change needs. A small PR that lands beats a broad one that stalls.
6. Nothing in the diff re-derives a rule another package already exports.

## Security invariants

These are deliberate. Changing one is a decision, not a refactor.

- `~/.stratus/credentials.json` is `0600`, and so is
  `~/.stratus/logs/stratusd.jsonl` — with an explicit `chmod` before
  every append, because `appendFile`'s mode only applies on create.
- **Slack channel tokens are gateway infrastructure secrets.** They live
  under `channels.slack.<agentId>` and are never resolved through the
  agent-scoped `CredentialResolver` — an agent must not be able to read
  the tokens of the transport carrying it.
- **The daemon log is a trace, not a second transcript.** It records that
  a tool ran and that a session completed. Prompts, replies, and tool
  inputs stay out of it — keep it that way when adding events. The one
  gap today is `session.failed`, which persists the provider's error text
  verbatim, and providers quote the failing request; do not document the
  log as safe to share without qualifying that.
- A stored sign-in is endpoint-bound: a credential saved for one endpoint
  is never sent to an endpoint a project-local config selects.
- **The control API's token file is `0600`, and so is `~/.stratus/gateway.json`.**
  Same reason as the credentials file, same explicit `chmod` after every
  write — `writeFile`'s mode only applies when it creates the file, so an
  upgrade over a looser install would keep the old permissions.
- **Cookie-authenticated API requests are origin-bound; bearer ones are not.**
  `SameSite` matching ignores ports, so a page on another port of the same
  host is "same site" and its requests carry the cookie automatically, and a
  WebSocket upgrade gets no CORS protection at all. A bearer token is never
  attached by a browser on a page's behalf, so there is no ambient authority
  to forge and an origin check there would only reject honest clients.
- **The `api` and `approvals` config blocks are read only from a trusted
  config.** An auto-discovered project-local `stratus.config.json` ships in
  any repository; which interface a daemon binds, and who may approve its
  tool calls, are not decisions a cloned repo gets to make.
- **No endpoint returns a secret.** Credential reads report presence, type,
  and bound endpoint. Session reads strip the Anthropic raw-turn cache
  (`redactAnthropicRawTurns`), which exists for replay and carries raw model
  turns.

## Two asymmetries that documentation keeps getting wrong

- **`--no-login` gives up crash restarts on macOS, not on Linux.** launchd
  ties `KeepAlive` to `RunAtLoad`, so a LaunchAgent that must not start at
  login cannot ask to be revived either; systemd's `Restart=on-failure` is
  independent of enablement. Do not write an unqualified crash-restart
  guarantee.
- **A daemon that fails before it starts serving writes nothing to the
  structured log.** Those errors reach stderr, and `stratus logs` cannot
  show them — so anything describing the JSONL as the whole record of a
  run is wrong for exactly the case someone is debugging. Where they land
  is the service manager's business and differs by platform: the
  LaunchAgent redirects both streams to `~/.stratus/logs/stratusd.{out,err}.log`
  (which is why `truncateRedirectLogs` exists, and why it is macOS-only in
  practice), while the systemd unit sets no `StandardOutput` and its
  output goes to the journal — `journalctl --user-unit=stratusd.service`.

## Commands

```bash
pnpm build && pnpm typecheck && pnpm test    # what CI runs
node packages/cli/dist/bin.js <command>      # the CLI from a source checkout
```
