# 07 — Desktop app: install to a running agent without a terminal

## Goal

A signed, notarized macOS download that takes someone from *nothing* to a
running agent in under two minutes, without a terminal at any point. The app
is a **distribution and lifecycle vehicle**, not a second management surface:
it owns installation, the daemon's life, sign-ins, and updates, and it renders
its own UI against the control API ([05](./05-control-api.md)).

The bundle holds two artifacts and the distinction is load-bearing: the
**app** — the UI, the bootstrap, the updater — and the **daemon payload**, the
kernel's package tree vendored unmodified. The app contains no agent loop, no
provider, and no tool code; the payload is nothing but those, and is never
edited here. Every rule below about "no runtime" is about the app.

## Why now

This step was **Not planned**, and the reasoning was sound for the app it then
described: *"its stated job — creating and managing agents visually — is what
[17](./17-fleet-console.md) delivers, sooner and on every platform."* That
objection stands, and this rewrite does not argue with it. It changes what the
step is for.

It stays unscheduled. What this rewrite buys is a step that is *scoped* — one
whose runtime questions are answered and whose remaining blockers are named —
so that choosing it becomes a decision about priority rather than the start of
a research project.

The job is not "manage agents visually." It is **reach the people who will
never run `npm install -g`.** Everything the product does today is gated behind
a terminal: installing Node, installing the CLI, `stratus setup`, and — for the
Claude subscription path — `claude setup-token`. 17 makes the *management*
surface reachable; nothing makes the *product* reachable. A web console served
by a daemon you cannot install is a door with no building attached.

So this step does not compete with 17 and does not duplicate it. 17 remains the
management surface, on every platform. This is the thing that gets a daemon
running so there is something to manage.

Two supporting facts, both established by the runtime spike
([07-runtime-spike.md](./07-runtime-spike.md)):

- **The V1 credential and agent-creation surface already exists.** `POST
  /agents`, `/catalog/models`, `/credentials/verify`, `PUT /credentials/:provider`,
  and `PUT /credentials/channels/:channel` cover it with no new endpoints.
- **The kernel is trivially shippable.** Its dependency tree has zero native
  modules and zero install scripts, and runs unchanged from a relocated path.
  A prebuilt tree inside the app bundle is a copy, not a build.

## Scope

**In:**

- **First-run onboarding.** Pick a template ([16](./16-templates.md)), choose a
  provider and sign in, name the agent, and watch one verification turn
  succeed — a single dispatched message and its reply, shown as the closing
  step of the wizard. That is how "it works" is proved without shipping a chat
  surface, and it is deliberately not one: no history, no second message, no
  session list.
  The template's model is a default the user may change; the model, name, and
  channel are theirs to pick. This is the one screen worth designing bespoke.
- **Silent bootstrap.** The app ships its own Node and a prebuilt package tree,
  writes the LaunchAgent, starts `stratusd`, and health-checks it. No npm at
  runtime, no network needed for packages, nothing for the user to install.
- **Provider sign-in without a terminal**, across the four real paths — a
  Claude API key, a Claude subscription, a ChatGPT subscription, and an
  OpenAI-compatible key. Subscription sign-ins spawn the vendor CLI as a child
  process, so the browser opens and the terminal never does.
- **Daemon lifecycle.** Menu-bar presence with health, start/stop/restart,
  install/uninstall the LaunchAgent, and an honest state when the daemon is
  down.
- **Updates.** Signed, notarized, auto-updating, with the package tree updated
  as part of the app rather than separately.

**Out:**

- **Any runtime in the app.** No agent loop, no provider, no tool, no policy
  in the app's own code, and its only network calls are the control API, the
  vendor sign-in CLIs, the update feed, and the provider packs. The daemon
  payload is exempt by definition — it *is* the runtime — which is why the two
  are named separately above and why the check below is scoped to the app.
- **Chat as a surface.** The verification turn above is a wizard step, not a
  conversation the user can continue; talking to an agent stays the CLI's,
  Slack's, and 17's. Sessions, approvals, memory, schedules, and cost too — all
  of it is 17's,
  and all of it is deliberately deferred here — not because the app should
  never have it, but because a first version that also has it ships later and
  proves less. The API makes each one additive.
- **Reusing `@stratusagent/dashboard`.** The app has its own UI in its own
  repository. `dashboard` keeps its no-build-step, no-dependency posture, which
  a desktop UI would otherwise erode.
- **Windows and Linux.** Electron makes both cheap later; neither is V1.
- **A second copy of any rule.** Every screen resolves through the control API,
  which resolves through `@stratusagent/state`. Same constraint 17 carries, and
  the app is now the third consumer that would break it.

## Design sketch

- **Repository: `stratuslabs/desktop`.** Separate, pinned to a control-API
  version rather than to a monorepo commit — which is what `/api/v1` being a
  visible path prefix already exists for. Named for the platform it will grow
  into rather than the one it starts on.
- **Electron.** The team is TypeScript; a native rewrite shares nothing with
  the web surface and a Rust shell adds a language for roughly the amount of
  code that opens a window and spawns a process. The Swift app in
  `stratuslabs/os` is not a starting point — 36 of its 56 UI files import its
  own Swift runtime, and it has no client for this API at all.
- **The app bundle is the installer.** CI resolves the package tree against a
  lockfile and copies it into the bundle; the app never runs a package manager.
  This buys determinism — the user gets the tree that was tested, not whatever
  the registry resolves that day — and costs a release to ship a kernel fix.
- **The daemon runs on a Node the app ships**, passed as `execPath` to the
  existing `serviceDefinition`. Not because the kernel stops being JavaScript,
  but because a background daemon cannot depend on a Node that may be absent,
  too old, or an nvm directory that disappears — a failure `readServiceCommand`
  already exists to detect.
- **Auth is the bearer token, and the main process is the only thing that
  holds it.** A desktop app can read `~/.stratus/gateway-token`, which a
  browser cannot, so it skips the one-time token exchange entirely — but the
  *renderer* cannot use it. A packaged renderer's origin is not the daemon's,
  so an `Authorization` header makes every call a preflighted cross-origin
  request, and the control API has no `OPTIONS` route and emits no
  `Access-Control-*` headers: the preflight fails and onboarding never reaches
  the API at all. So **every** control API call — HTTP and WebSocket alike —
  is made from the main process, and the renderer reaches it over IPC.
  Relaxing the API's origin posture instead would be the wrong repair: that
  posture is a deliberate security invariant, and this one is not a browser.
  Keeping the token in the main process is the better outcome anyway — it
  never enters a web context.
- **Heavy providers are on-demand packs, and that needs a seam first.** The
  Codex and Claude Code SDKs carry ~536 MB of platform binaries between them
  for sign-ins most users will not choose, so they are fetched and
  hash-verified only when picked. Dropping them from `@stratusagent/cli` is not
  enough to make that work: `@stratusagent/state` declares both as
  unconditional dependencies and imports `createClaudeCodeProvider` and
  `createCodexProvider` at module top level, and the CLI imports `state` at
  startup — so an absent pack is `ERR_MODULE_NOT_FOUND` before anything can
  fetch it. Provider construction has to move behind a dynamic seam in `state`,
  and the transitive dependencies drop with it. That is a prerequisite of the
  lean bundle rather than a detail of it.

## Acceptance criteria

- On a Mac with no Node, no CLI, and no Homebrew: download, open, and see the
  first agent answer its verification turn in under two minutes, measured end
  to end, with no terminal opened.
- First run completes with the network unplugged after download, up to the
  point where a provider sign-in needs it.
- Every file the app writes is byte-compatible with the CLI: `stratus agents`
  lists the agent the app created, and the two can be used interchangeably
  without either corrupting the other's state.
- The daemon survives logout and log back in, and the menu bar reflects a
  daemon killed out of band within seconds. **After a reboot it returns at the
  next login, not at power-on** — a LaunchAgent is tied to a login session, as
  `installService` already tells the operator, so unattended reboot recovery
  needs automatic login and the app must say so rather than implying the
  daemon is always up.
- Each of the four sign-in paths completes without a terminal, and a key is
  verified before it is stored.
- The app's own code contains no provider, tool, or loop code, and imports
  none — asserted against the app artifact, not the bundle, which necessarily
  ships the kernel as its daemon payload.
- A downloaded, notarized build opens on a clean Mac with no Gatekeeper
  warning.

## Depends on

- **[16](./16-templates.md)** — the onboarding is a template picker, and the
  format does not exist yet. This is the long pole, not the app.
- **Two template endpoints in `control-api`, not one.** There are none today.

  **A read**, because 16 computes the summary in `@stratusagent/state`
  precisely so the CLI and 17 can both render it, and this app is the third
  renderer and needs it over HTTP.

  **An atomic apply**, because the client cannot assemble one out of the calls
  that exist. `POST /agents` takes `instructions`, `name`, `provider`, and
  `model` and nothing else — no `tools`, `skills`, or `credentials`, and no
  `plugins` configuration — so applying a template would mean a soul write
  followed by a separate config write, from a client, with a window between
  them. 16 requires the opposite in as many words: soul and configuration
  commit together or not at all, and concurrent creations serialize on the
  same lock. A client-side pair satisfies neither, and this spec also forbids
  the app writing `~/.stratus` behind the API's back — so the operation that
  previews a template and applies it as one committed unit has to live on the
  server, next to the computation 16 already puts there.

## Open questions

- **Two installs, one `~/.stratus`.** Someone who has the app and later runs
  `npm install -g @stratusagent/cli` gets two versions over one state
  directory. The token file already survives two daemons racing; a `sessions.db`
  schema difference does not. This is what makes the state-file compatibility
  contract (`docs/architecture/state-files.md`, still unwritten) load-bearing
  rather than nice to have.
- **Does onboarding lead with the demo provider?** Landing on a working
  conversation before asking for a sign-in is the only version of the
  two-minute claim that does not depend on a vendor's console. The cost is that
  the first thing a user sees is deliberately not the real product.
- **Where do provider packs live?** Hosting signed tarballs is more work than
  reusing npm and is the only way the on-demand path stays offline-verifiable.
- **Does the app ever bundle 17 rather than its own screens?** Deferred rather
  than answered: the moment chat and sessions land here, the duplication
  argument that killed this step the first time comes back, and it should be
  answered then with a real console to compare against.
