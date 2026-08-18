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

- **Node 22.13+.** The gateway's session store uses `node:sqlite`, which
  is unflagged from 22.13. Do not raise or lower this casually.
- Tests run under `node --test --experimental-strip-types`. Type
  stripping means **no TypeScript parameter properties** (`constructor(private x)`)
  and no enums — write the assignment out.
- New behavior needs a test that fails without the change. Verify that it
  does; a test that passes both ways is worse than none, because it reads
  as covered.
- **Never assert timing.** A test that sleeps and then checks state is a
  race against the CI runner. Gate on the event you actually mean, and
  give the gate a way to lose so a regression fails the assertion instead
  of hanging a suite that has no timeout.

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
