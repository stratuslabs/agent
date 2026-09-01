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

- **The sign-in surface already exists.** `/catalog/models`,
  `/credentials/verify`, `PUT /credentials/:provider`, and
  `PUT /credentials/channels/:channel` cover every sign-in this step needs,
  and `POST /agents` creates a plain agent. What they do **not** cover is
  template-backed creation, which is the flow this step's onboarding actually
  uses — see [Depends on](#depends-on). Read the two together: connecting
  accounts needs no API work, and creating an agent from a template needs two
  endpoints that do not exist.
- **The kernel is trivially shippable.** Its dependency tree has zero native
  modules and zero install scripts, and runs unchanged from a relocated path —
  which is what lets the app install it by copying rather than building.

## Scope

**In:**

- **First-run onboarding.** Pick a template ([16](./16-templates.md)), choose a
  provider and sign in, name the agent, **approve what the template grants**,
  and watch one verification turn succeed — a single dispatched message and
  its reply, shown as the closing step of the wizard. That is how "it works" is proved without shipping a chat
  surface, and it is deliberately not one: no history, no second message, no
  session list.
  The template's model is a default the user may change; the model, name, and
  channel are theirs to pick. This is the one screen worth designing bespoke.

  **The grant review is not a step the wizard may skip.** 16 calls it the
  product: before anything is written, the operator sees every tool with its
  resolved risk, every credential the bundle will ask for, and every plugin it
  enables — as the diff against the configuration that exists, not the
  template's requested values — and confirms. A wizard that applied a template
  without it would delete the gate 16 exists to preserve while keeping its
  name, which is the one outcome that spec rules out. So the apply endpoint
  takes a confirmation, the app renders the summary rather than computing one
  (16 owns the computation in `@stratusagent/state`; the CLI, [17](./17-fleet-console.md),
  and this app are three renderers of it), and there is no `--yes` equivalent
  here — that flag exists for scripting, and a first-run wizard is the
  opposite of scripting. Whatever 16 decides about disclosing a glob as a
  glob, this renders that decision; it does not re-derive it.

  **The confirmation is bound to the summary it answers.** A review is an
  interactive pause, and no server holds a creation lock across one — 16's
  lock serializes the *write*, not the minutes a person spends reading. So
  between preview and apply, another client can enable a plugin, change its
  settings, or install one, and a bare "yes" would then commit an effective
  result the operator never saw. The apply request therefore carries a digest
  of the inputs the preview was computed from, and the server recomputes and
  **refuses with a fresh summary** when they no longer match, rather than
  applying. Without that, the mandatory review is defeated by timing rather
  than by bypass — which is the same gate deleted more quietly.

  **A template that turns on a plugin needs the daemon restarted before that
  turn, and the app is what restarts it.** Souls hot-reload — `POST
  /roster/reload` is why a new agent is dispatchable immediately — but plugins
  do not: `runServe` reads the `plugins` config once and hands that snapshot
  to `createGateway`, and [27](./27-live-reload.md) keeps the plugin restart
  deliberately. So a fresh install whose template enables a plugin would run
  its verification turn against a daemon that has never registered the tools
  the template just granted, and the turn would fail on the exact capability
  it exists to prove. The wizard therefore restarts the daemon and waits for
  health after applying a template that changed plugin configuration, before
  dispatching.

  **The verification turn runs under `remote`, and the wizard answers the one
  approval it parks.** A fresh daemon runs `headless`, which rejects a
  `gated` call outright — *"nobody is available to approve it"* — and the
  templates worth shipping grant gated tools: a research agent's `web.fetch`,
  an operator agent's `shell.run`. So the promised turn would fail on every
  template that does something.

  Wanting the wizard to "just answer it" is not enough, because `headless`
  returns false directly and never parks anything for a client to resolve.
  The mode that does is `remote`: the call parks on a published request, and
  `GET`/`POST /approvals` — which 05 already ships, and which
  [17](./17-fleet-console.md) is built on for exactly the case where the
  approver is not in Slack — lists and answers it. `runServe` resolves the
  mode once at startup, so this is a restart rather than a toggle, and it
  composes with the restart the template already forces: the wizard brings
  the daemon up in `remote` for the verification turn, **shows the operator
  the parked call and takes an explicit Allow once / Deny**, and then
  **restores `headless`**. Onboarding must not leave a daemon that asks a UI
  nobody has open.

  **The wizard must not answer that call on the operator's behalf, and the
  reason is the whole design of 03.** The allowlist and the invocation are
  *separate gates* — "the kernel's per-agent tool allowlist stays the first
  gate; this engine governs *invocations* of allowed tools" — and
  `PendingApproval` carries `call.input`, the concrete arguments, precisely
  so a human sees what is about to run. The grant summary approved a
  capability; it did not approve a command the model had not yet chosen. An
  auto-answered request would execute a model-selected `shell.run` or
  `web.fetch` that nobody saw, which is the same gate-deleted-while-keeping-
  its-name failure the review step exists to prevent — committed here in the
  one place a human is definitely watching. So the wizard renders the
  invocation the way the Slack adapter does and waits.

  `headless` is the right default and the wrong description of this one
  moment: it means nobody is present to ask, and during onboarding somebody
  demonstrably is, one step after approving the grant summary. The exception
  is deliberate and bounded to that turn — not the approvals queue, which
  stays 17's. The alternative is worse: a first-run demo restricted to
  capabilities that need no permission, which is a demo of nothing the
  product is for. Owning that restart is this step's job rather than an
  imposition on it — no other surface can do it. A restart re-reads
  configuration; it cannot make an absent package resolvable, which is why the
  payload vendors the templates' plugins rather than relying on this.
- **Silent bootstrap.** The app carries its own Node and a prebuilt package
  tree, **installs both to a stable path outside the app bundle**, writes the
  LaunchAgent against that path, starts `stratusd`, and health-checks it. The
  tree vendors **every plugin the shipped templates name** — [16](./16-templates.md)
  aborts creation when a template names a plugin that is not installed, and an
  onboarding wizard has nowhere to send someone holding an install command. A
  template whose plugin is too heavy to vendor is either not offered on first
  run or its plugin is fetched as a pack first, on the provider-pack path;
  `tool-browser` is the one that forces that choice, since it pulls
  `playwright-core` and a browser download behind it. No npm at
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
  Slack's, and 17's. Sessions, memory, schedules, and cost too — all
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
- **The app bundle is the installer, and installing is not the same as
  carrying.** CI resolves the package tree against a lockfile and copies it
  into the bundle; the app never runs a package manager. But the bundle is a
  thing a user drags between folders, runs once from a mounted DMG, and
  replaces wholesale on update, while `serviceDefinition` writes the
  interpreter and entrypoint into the plist as **absolute paths**. A daemon
  pointed inside the bundle therefore breaks on any of those. So first run
  copies the runtime out to a stable versioned directory under
  `~/Library/Application Support/`, and the LaunchAgent names that — never a
  path inside `.app`. An update installs the new runtime beside the old one
  and rewrites the unit, which is the operation `stratus update` already
  performs and `readServiceCommand` already exists to make safe.
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
  fetch it. **And `state` is not the only importer:** `cli/src/index.ts`
  itself imports `createClaudeCodeProvider`, `hasHostedToolSideEffects`, and
  `ClaudeCodeToolExecutor` from one and `DEFAULT_CODEX_MODEL` from the other,
  at module top level — a bare constant is enough to pull the package. So the
  seam has to cover both: provider construction moves behind a dynamic import
  in `state`, the CLI's own direct imports move with it, and the
  dependencies drop from both manifests. That is a prerequisite of the lean
  bundle rather than a detail of it.

## Acceptance criteria

- On a Mac with no Node, no CLI, and no Homebrew: download, open, and see the
  first agent answer its verification turn in under two minutes, measured end
  to end, with no terminal opened.
- First run completes with the network unplugged after download, up to the
  point where a provider sign-in needs it.
- Every file the app writes is byte-compatible with the CLI **at the same
  state schema version**: `stratus agents` lists the agent the app created,
  and the two can be used interchangeably. Across versions they cannot, by
  design — the build with the newer `STATE_SCHEMA_VERSION` migrates
  `~/.stratus` and stamps it, and the older one refuses to *start* against
  state it does not understand.

  **Refusing to start is not the same as stopping, and the gap is the
  dangerous case.** Migrations run from the CLI's general startup path, not
  only from `stratus update` — which is deliberate, since state that migrates
  only sometimes is worse than state that never migrates — and only `update`
  stops the service first. So any command from a newer CLI can stamp the
  state while the app's older daemon is still running, and that daemon keeps
  serving and keeps writing in the schema it knows. The next-startup refusal
  never fires, because it never restarts. So the criterion is two things: the
  coordination must **stop or fence a running older daemon before migrating**
  rather than relying on its next start, and the app must **detect and
  explain** the resulting state, naming which install is behind — a user who
  upgraded their CLI must not be left with a silently divergent daemon, nor
  with a dead one and an app that cannot say why.
- The daemon survives logout and log back in, and the menu bar reflects a
  daemon killed out of band within seconds. **After a reboot it returns at the
  next login, not at power-on** — a LaunchAgent is tied to a login session, as
  `installService` already tells the operator, so unattended reboot recovery
  needs automatic login and the app must say so rather than implying the
  daemon is always up.
- Each of the four sign-in paths completes without a terminal, and a key is
  verified before it is stored.
- Moving `Stratus.app` to another folder, and updating it, both leave the
  daemon running and restartable — because no path in the LaunchAgent points
  inside the bundle. Asserted by moving the app and rebooting, not by reading
  the plist.
- A template whose effective result changed between preview and confirmation
  is refused, and the operator is shown the new summary rather than the old
  one being applied — asserted by mutating the config between the two calls.
- Onboarding cannot apply a template without the operator confirming a
  summary that lists every tool with its resolved risk, every credential
  requested, and every plugin change — and the summary the app shows is
  identical to what `stratus agent new --template X` prints for the same
  template on the same host, because it is the same computation.
- A template granting a `gated` tool completes its verification turn on a
  fresh install — the case that fails outright under the `headless` default a
  new daemon starts with — and the daemon is back in `headless` when
  onboarding finishes, asserted rather than assumed.
- A template that turns on a plugin **vendored but not yet enabled** still
  produces a passing verification turn *using a tool that plugin contributed*
  — the case that fails if the daemon is not restarted between apply and
  dispatch. A template naming a plugin the payload does not carry never
  reaches onboarding at all, because 16 would refuse it.
- The app's own code contains no provider, tool, or loop code, and imports
  none — asserted against the app artifact, not the bundle, which necessarily
  ships the kernel as its daemon payload.
- A downloaded, notarized build opens on a clean Mac with no Gatekeeper
  warning.

## Depends on

- **[16](./16-templates.md)** — the onboarding is a template picker, and the
  format does not exist yet. This is the long pole, not the app.
- **A migration fencing protocol in the CLI**, not only in this app. A newer
  CLI migrates state from its general startup path, and only `stratus update`
  stops the service first — so an ordinary command from a separately
  installed newer build stamps the state while this app's older daemon keeps
  running and writing the previous schema. Nothing the app can do alone
  prevents that, because the app is not the process doing the migrating. The
  migrating build has to stop or fence an active daemon first, whoever owns
  it. Without this, the acceptance criterion above forbids a corruption the
  stated dependencies still permit.
- **Two template endpoints in `control-api`, not one.** There are none today.

  **A read**, because 16 computes the summary in `@stratusagent/state`
  precisely so the CLI and 17 can both render it, and this app is the third
  renderer and needs it over HTTP.

  **An atomic apply that takes the reviewed digest**, because the client
  cannot assemble one out of the calls that exist — and because a confirmation
  unbound from what was confirmed is not a gate. `POST /agents` takes `instructions`, `name`, `provider`, and
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

- **Two installs, one `~/.stratus`, and this one is not hypothetical.**
  Someone who has the app and later runs `npm install -g @stratusagent/cli`
  gets two builds over one state directory, and `@stratusagent/state` already
  decides what happens: whichever build is newer migrates and stamps the
  state, and the older one throws rather than starting, because *"the daemon
  refuses to run against a HIGHER version than it understands"*. That is the
  right behavior — it refuses instead of corrupting — but it means the two
  installs are only interchangeable while their schema versions agree, and
  nothing today coordinates that.

  **No app-only choice closes this**, which is why it is a dependency below
  rather than an open question here. A newer CLI migrates from its general
  startup path on an ordinary command, before this app is asked anything, so
  pinning the payload, refusing to install over newer state, or offering to
  update all fail the same way: the older daemon is already running and keeps
  writing its schema. Fencing has to happen on the side doing the migrating.
  What remains genuinely open is only where the protocol is written down —
  most likely `docs/architecture/state-files.md`, still unwritten, which is
  why that document keeps turning up as load-bearing.
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
