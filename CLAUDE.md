# Working in this repo

Conventions that are easy to get wrong here, and the reasons behind them.
Read before making changes.

## Documentation lands with the change

A user-visible change is not done until it is documented in the same PR.
That means a new command or flag, a changed default, a new file the CLI
writes, a changed setup menu — anything someone could notice without
reading the source.

Where things are documented:

- `packages/cli/README.md` — the CLI's own surface: setup, every command,
  the options table. This is the detailed one.
- `README.md` (root) — what the project is, what is included versus
  optional, and a usage block that points at the CLI README rather than
  duplicating it.
- `HELP_TEXT` in `packages/cli/src/index.ts` — every command and flag.
- `packages/channel-slack/README.md` — the Slack app setup.

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
  `@stratusagent/gateway`.

If you need a rule that is not exported, export it. Do not copy it.

## Runtime and tests

- **Node `>=22.13 <23 || >=23.4`.** The gateway's session store uses
  `node:sqlite`, which was unflagged on each release line separately —
  22.13.0 and 23.4.0 — so 23.0 through 23.3 are newer than the 22.x floor
  and still ship it behind a flag. Write the range, never a bare `>=22.13`,
  and do not raise or lower it casually.
- Tests run under `node --test --experimental-strip-types`. Type
  stripping means **no TypeScript parameter properties** (`constructor(private x)`)
  and no enums — write the assignment out.
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
