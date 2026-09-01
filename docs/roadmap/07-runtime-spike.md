# 07 — Runtime spike: what the desktop app has to ship

Evidence behind the decisions in [07](./07-desktop-app.md). Run 2026-08-31
against `main` at 0.9.2.

**Caveat on platform.** Everything below was measured on Linux x64, not
macOS. The results that concern a *Node build* (`node:sqlite`, FTS5, module
portability) depend on how the runtime is compiled and are expected to hold
on darwin-arm64, but the numbers should be re-taken there before a release
depends on them. Nothing macOS-specific — launchd, notarization, Gatekeeper —
was exercised at all.

## The question

The daemon's session store imports `node:sqlite`, unflagged in 22.13.0 and,
on the 23.x line, not until 23.4.0 — hence the awkward
`>=22.13 <23 || >=23.4` in every `engines` field. Memory search additionally
needs SQLite built with FTS5. If the app ships a runtime, that runtime has to
supply both, and it was not obvious that Electron's embedded Node does.

## Result: both runtimes work

| | Stock Node 22.22.2 | Electron 44 (`ELECTRON_RUN_AS_NODE=1`) |
| --- | --- | --- |
| Embedded Node | 22.22.2 | 24.18.1 |
| `node:sqlite` | yes — SQLite 3.51.2 | yes — SQLite 3.53.1 |
| FTS5 virtual table | yes | yes |
| `unsupportedNodeMessage` | passes | passes (`major > 23`) |
| `stratus run` | works | identical output |
| `stratus serve` + control API | works | works |

The Electron run was the real daemon, not a proxy for it: `stratusd` reported
ready, the control API answered `GET /health` with the roster, and
`sessions.db` was created with its WAL and shm siblings.

So the risk that motivated the spike is not real. The choice between the two
is decided by other things.

## Ship stock Node anyway

Three reasons, in order of weight:

1. **It needs no change to the CLI.** `serviceDefinition` already accepts an
   `execPath` — *"absolute path of the node binary that should run the
   daemon"* — and writes it as `argv[0]`. `readServiceCommand` parses it back
   and already exists to detect *"a unit whose absolute node path (say an nvm
   version directory) no longer exists, which stops the service without
   anything saying so"* — which is exactly what an app update looks like.
   The Electron path does need a change: `launchdPlist` emits no
   `EnvironmentVariables` key, so `ELECTRON_RUN_AS_NODE=1` cannot be set at
   all.
2. **It lets the daemon be decoupled from the UI shell** — though the choice
   of runtime alone does not decouple it. The daemon outlives the app and must
   survive it being quit, moved, or updated, and `serviceDefinition` writes
   absolute paths into the plist, so a runtime left *inside* `.app` breaks the
   moment the bundle is dragged, run from a mounted DMG, or replaced by an
   update. Stock Node makes the fix available — copy the runtime to a stable
   directory outside the bundle and point the unit there — where an Electron
   helper binary would have to stay where Electron is.
3. **Size.** 48 MB for `node-v22.22.2-darwin-arm64.tar.gz` against a 216 MB
   Electron binary.

This also makes the runtime decision independent of the UI stack, which is
why 07 can choose Electron on its own merits.

## The package tree is trivially shippable

Two properties, both measured, and together they mean the app never needs a
package manager at runtime:

- **No native code and no install scripts.** Excluding the two provider
  binaries below, the installed tree contains **zero `.node` files** and
  **zero packages declaring `install` or `postinstall`**. Nothing is compiled
  against a Node ABI, so the tree is not coupled to the Node version that runs
  it, and installing executes no third-party code.
- **It relocates.** The whole tree was copied to an unrelated path and
  `stratus run` executed from it unchanged.

So CI can resolve the tree once against a lockfile and copy the result into
the app bundle. The user gets the tree that was tested rather than whatever
the registry resolves on the day they install, first run needs no network for
packages, and no install script ever executes on a customer's machine. The
cost is that a kernel fix ships as an app release.

## The finding that reframes app size

`@stratusagent/cli` depends unconditionally on `provider-codex` and
`provider-claude-code`, which pull vendor CLIs as platform binaries:

```
@openai/codex-<platform>              331 MB
@anthropic-ai/claude-agent-sdk-<plat> 205 MB
@anthropic-ai/sdk                      11 MB
@stratusagent/*                         3 MB
──────────────────────────────────────────
total                                 585 MB
```

**`npm install -g @stratusagent/cli` moves roughly 550 MB of vendor binaries
today**, for two sign-ins many users will never choose, and the framework's
own code is 3 MB of it. This is not a desktop-app problem — it is the
existing install — but it lands on the two-minute goal, and it inverts the
size conversation: an Electron shell is a rounding error beside it.

Dropping those two providers leaves **~45 MB**, which with a 48 MB Node makes
a lean bundle around **95 MB** that needs no network at all on first run.

**Dropping them is not a dependency edit, and there are two importers, not
one.** `@stratusagent/state` declares both as unconditional dependencies and
imports `createClaudeCodeProvider` and `createCodexProvider` at the top of
`src/index.ts`, and the CLI imports `state` at startup. The CLI *also* imports
them directly — `createClaudeCodeProvider`, `hasHostedToolSideEffects` and
`ClaudeCodeToolExecutor` from one, `DEFAULT_CODEX_MODEL` from the other, at
`src/index.ts:53-58`. A bare constant is enough to pull the package, so
either importer alone raises `ERR_MODULE_NOT_FOUND` at module load, before the
app could fetch the missing pack.

Making these on-demand packs therefore means a dynamic seam in `state` **and**
moving the CLI's own imports behind it, with the dependencies dropped from both
manifests. That is real work in the kernel, it is a prerequisite for the lean
bundle rather than a consequence of it, and it benefits npm users equally.

## Sign-in paths, and why none needs a terminal

The four real sign-ins are distinct credential paths, not naming variants —
`StratusProviderName` is `'demo' | 'openai' | 'anthropic' | 'codex'`:

| Sign-in | Provider | Credential | Mechanism |
| --- | --- | --- | --- |
| Claude API key | `anthropic` | `api_key` | paste, verified live |
| Claude Pro/Max | `anthropic` | `oauth_token` | `claude setup-token` |
| ChatGPT Plus/Pro | `codex` | `oauth_token` | `codex login` |
| OpenAI key billing Codex | `codex` | `api_key` | paste, verified live |
| OpenAI or compatible | `openai` | `api_key` + `baseUrl` | paste, verified live |

The two OpenAI rows are different sign-ins, not one written twice: the CLI's
Codex menu offers an API key that stores under `credentials.codex` and bills
Codex runs, and `openai` is the separate provider that accepts a `baseUrl`.

A ChatGPT subscription *is* how the `codex` provider authenticates; the stored
value is *"a subscription marker, not a secret… its value is never read or
sent anywhere."* The `openai` path is separate and, because it carries a
`baseUrl`, is also the route to any OpenAI-compatible endpoint.

The terminal in the subscription paths is not inherent to OAuth — it is a CLI
asking a human to type a command. Both vendor binaries open the system browser
themselves, so an app that spawns them as child processes and reads their
output gives the user a browser tab and nothing else. `claude setup-token` is
present and documented as *"set up a long-lived authentication token (requires
Claude subscription)"*; `codex login` additionally accepts `--with-api-key`
and `--with-access-token` on stdin.

**Not verified, and it gates the subscription paths:** whether `setup-token`
prints capturably when stdout is not a TTY, and whether it needs an
interactive terminal. Neither could be exercised here without a live
subscription. Spike it on a real Mac before committing onboarding to it.

**Do not reimplement Claude Code's OAuth client.** Anthropic does not offer
third-party OAuth applications for Claude subscriptions, so borrowing its
client id is both a terms problem and fragile — a rotated id would break every
installed copy. Spawning the official binary is the durable route.

## What the V1 scope already has, and what it does not

Covered with no new endpoints — the dashboard's client already calls all of
them: `POST /agents`, `GET /catalog/models`, `POST /credentials/verify`,
`PUT /credentials/:provider`, `PUT /credentials/channels/:channel`,
`GET,PUT /config`.

**Not covered:** template-backed creation, which is what 07's onboarding
actually uses. [16](./16-templates.md) has not started, and `control-api` has
no template endpoint of any kind. It needs two: a read, and an **atomic
apply** — `POST /agents` accepts only `instructions`, `name`, `provider`, and
`model`, so a client applying a template would write a soul and then write
config separately, which is precisely the half-configured state 16 forbids.
That makes 16 the critical path, and a wider one than a read endpoint would
be, rather than any part of the app.

## Method

- Electron 44.0.0 linux-x64, downloaded from the project's releases.
- The monorepo built from source at 0.9.2 (`pnpm install --frozen-lockfile`,
  `pnpm build`), then run under each runtime with `HOME` pointed at a scratch
  directory.
- The published packages installed with `npm install --prefix` into an empty
  directory for the size and portability measurements.
