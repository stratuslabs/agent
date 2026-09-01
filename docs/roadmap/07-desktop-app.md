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

- **The sign-in surface exists for *performing* a sign-in, not for describing
  one.** `/credentials/verify`, `PUT /credentials/:provider`, and
  `PUT /credentials/channels/:channel` store and check a credential once the
  wizard knows what to ask for, and `POST /agents` creates a plain agent.
  Nothing says *what to ask for*: `GET /credentials` reports only which
  providers exist and what is already stored, and `/catalog/models` skips a
  provider with no credential at all — `if (!apiKey && !credential) continue`
  — so a fresh install learns nothing from it. Which providers take an API key
  versus a subscription, and which vendor command a subscription spawns, is
  knowledge only the CLI holds today, and an app that hardcoded it would be
  the second copy this step's Out list forbids. That descriptor is in
  [Depends on](#depends-on). What they also do **not** cover is
  template-backed creation, which is the flow this step's onboarding actually
  uses — see [Depends on](#depends-on). Read the two together: connecting
  accounts needs no API work, and creating an agent from a template needs two
  endpoints that do not exist.
- **The kernel is trivially shippable.** Its dependency tree has zero native
  modules and zero install scripts, and runs unchanged from a relocated path —
  which is what lets the app install it by copying rather than building.

## Scope

**In:**

- **First-run onboarding**, as a [16](./16-templates.md) template picker: pick
  a template, choose a provider and sign in, name the agent, review what the
  bundle grants, and land on a created, running agent. The template's model is
  a default the user may change; the model, name, and channel are theirs to
  pick. This is the one screen worth designing bespoke.

  **That override is a change to 16's contract, not a liberty this step
  takes.** 16 renders exactly two per-agent values — the id and the display
  name — and keeps everything else literal *"so what the operator reviewed is
  what lands on disk"*. A model the user picked is neither literal nor one of
  those two, so it has to become an **explicit reviewed input**: carried into
  the preview, shown in the summary, and covered by the digest the apply
  refuses on. Otherwise the operator approves one bundle and installs
  another, which is the property 16's literalness exists to protect. Listed
  in [Depends on](#depends-on); picking a model in a wizard is not worth
  weakening that rule for, and does not have to.

  **The sequence is deliberately left unspecified here.** An earlier revision
  of this step specified it in detail and was wrong repeatedly — thirteen
  review rounds, four of them finding defects in the fix for the round before,
  including one that would have had the wizard auto-approve a tool invocation
  no human had seen. What that review did establish is a set of constraints
  the real design has to satisfy, and those are recorded below because they
  are the durable part. Writing the flow itself is work for whoever schedules
  this step, with the constraints in hand.

- **Silent bootstrap.** The app carries its own Node and a prebuilt package
  tree, **installs both to a stable path outside the app bundle**, writes the
  LaunchAgent against that path, starts `stratusd`, and health-checks it. The
  tree vendors **every plugin the shipped templates name** — [16](./16-templates.md)
  aborts creation when a template names a plugin that is not installed, and an
  onboarding wizard has nowhere to send someone holding an install command. A
  template whose plugin is too heavy to vendor is either not offered on first
  run or its plugin is fetched as a pack first, on the provider-pack path.

  **The health check has to identify the process, not just the port.** A
  `stratus serve` someone started by hand owns the same default port, the same
  `~/.stratus`, and the same gateway token, and `installService`'s
  `launchctl bootout` clears a previous launchd *job*, not a process nobody
  registered. The API's `listen` rejects on `EADDRINUSE`, so the app's own job
  dies on start and `KeepAlive` retries it — while `/health` answers happily
  from the other process, carrying no pid and no executable path to tell the
  two apart, and `~/.stratus/gateway.json` already points there. Bootstrap
  would report success over a crash-looping job, and every later start, stop,
  and restart would aim at something else. So the app correlates what answers
  with what it launched, and adopts or refuses a foreign daemon deliberately.

  **Every optional peer of the CLI is a payload decision, and each absence is
  silent by design.** A rule separate from the plugins above, and missed for
  the same reason: a payload resolved from the CLI's dependency tree plus what
  the templates name gets *none* of them, because that is what optional means. `package.json`
  declares three, and they fail differently:

  - **`@stratusagent/control-api` — required, and its absence is the worst
    failure in this list.** `runServe` defaults `apiWanted` to true but only
    warns when someone asked for the API *explicitly*
    (`command.api === true || apiConfig.enabled === true`). The app never
    passes `--api`, so on its path `loadControlApi()` returns undefined and
    the daemon starts serving no HTTP and no WebSocket, **saying nothing at
    all**. Every design decision below routes through this API from the main
    process, so a payload without it produces an app whose health check has
    nothing to reach and whose onboarding calls have nowhere to go.
  - **`@stratusagent/channel-slack` — required for any channel the app
    offers.** `loadSlackAdapter` returns undefined when it is absent and
    `stratus serve` skips Slack without failing, so a user who picked Slack
    ends up with tokens stored and nothing carrying them. `stratus doctor`
    already reports exactly this state — *"Slack tokens are stored for N
    agent(s) but @stratusagent/channel-slack is not installed"* — which is
    the sign it is a trap the product has hit before.
  - **`@stratusagent/dashboard` — a real choice, not an oversight.** The app
    has its own UI and does not serve this page; the CLI treats the pair as
    "the control API is the port and the dashboard is the page served on it",
    so omitting it means `stratus dashboard` cannot work from the app's tree.
    Whichever way it goes, it is decided here rather than falling out of how
    the payload happened to resolve.

  **Vendoring a plugin is not the same as making it work**, and
  `tool-browser` is the case that separates them. It is *cheap* to vendor —
  `playwright-core` is a few megabytes and, as its README says, "downloads no
  browser" — so the package sails through 16's installed check and every
  `browser.*` call then fails anyway, because the browser is one the operator
  already has, one they name with `executablePath`, or one they fetched with
  `npx playwright install chromium`. A browser-backed template therefore needs
  the pack to carry and configure an executable, or detection of a supported
  installed browser, or not to be offered on first run. No npm at runtime, no
  network needed for packages, nothing for the user to install.
- **Provider sign-in without a terminal**, across the five real paths — a
  Claude API key, a Claude subscription, a ChatGPT subscription, an OpenAI
  API key billing the *Codex* harness, and an OpenAI-compatible key on the
  `openai` provider. The last two are distinct sign-ins, not one: the CLI's
  Codex menu offers an API key that stores under `credentials.codex` and
  bills Codex runs, while `openai` is the separate provider that takes a
  `baseUrl`. An app offering only four of these removes an authentication
  mode that works today. Subscription sign-ins spawn the vendor CLI as a child
  process, so the browser opens and the terminal never does.
- **Daemon lifecycle.** Menu-bar presence with health, start/stop/restart,
  install/uninstall the LaunchAgent, and an honest state when the daemon is
  down.

  **Including removal, which on macOS means dragging the app to the Trash and
  running no code at all.** The menu's uninstall action only exists while the
  app does. And the decision that makes moves and updates safe — runtime,
  payload, and LaunchAgent all live *outside* the bundle — is exactly what
  makes removal leak: launchd keeps running a daemon that still holds provider
  credentials and still answers in Slack, for a product the user believes they
  deleted. So this step owes an uninstall contract, and the honest options are
  few: a launchd job that notices its payload is gone and unloads itself, or a
  visible uninstaller the app points at, or an explicit decision that removal
  is a menu action and the app says so before it is ever dragged anywhere. No
  contract at all is the one answer that is wrong.
- **Updates.** Signed, notarized, auto-updating, with the package tree updated
  as part of the app rather than separately.

**Out:**

- **Any runtime in the app.** No agent loop, no provider, no tool, no policy
  in the app's own code, and its only network calls are the control API, the
  vendor sign-in CLIs, the update feed, and the provider packs. The daemon
  payload is exempt by definition — it *is* the runtime — which is why the two
  are named separately above and why the check below is scoped to the app.
- **Chat as a surface.** Talking to an agent stays the CLI's, Slack's, and
  17's. Sessions, memory, schedules, and cost too — all of it is 17's, and all
  of it is deliberately deferred here: a first version that also has it ships
  later and proves less. The API makes each one additive.
- **Reusing `@stratusagent/dashboard`.** The app has its own UI in its own
  repository. `dashboard` keeps its no-build-step, no-dependency posture, which
  a desktop UI would otherwise erode.
- **Windows and Linux.** Electron makes both cheap later; neither is V1.
- **A second copy of any rule.** Every screen resolves through the control API,
  which resolves through `@stratusagent/state`. Same constraint 17 carries, and
  the app is now the third consumer that would break it.

## Constraints the onboarding design must satisfy

Not a design. These are facts about the system this step runs on, each one
established by reading the code rather than by reasoning about it, and each
one something a plausible-looking onboarding flow gets wrong. Whoever
specifies the sequence should start here.

- **The allowlist and the invocation are separate gates.** 03 states it:
  *"the kernel's per-agent tool allowlist stays the first gate; this engine
  governs invocations of allowed tools."* `PendingApproval` carries
  `call.input` so a human sees the concrete arguments. Approving a template's
  grant is not approving a command the model has not yet chosen, and nothing
  in this app may answer a parked request on the operator's behalf.
- **A fresh daemon is `headless`, which refuses gated calls outright** rather
  than parking them — *"nobody is available to approve it"*. Every template
  worth shipping grants gated tools, so any flow that exercises a template's
  capability has to account for this. `remote` is the mode that parks a call
  for a client to answer, and `runServe` resolves the mode once at startup, so
  changing it is a restart rather than a toggle.
- **A turn can park more than once.** `runToolCalls` iterates every call in a
  response and applies the policy to each, and it runs at more than one point
  in the turn loop, so later model iterations park again. Any approval
  handling is a loop until the session completes, not a single answer.
- **A daemon left in `remote` with nobody watching is a broken install.**
  Whatever changes the mode has to restore it on *every* exit — cancelled,
  crashed, or abandoned — and recover on next start, not only on success.
- **Channel credentials are a startup snapshot too, and binding one is
  ordered after creation.** `PUT /credentials/channels/slack` refuses an agent
  that is not already on the roster — deliberately, so a typo cannot store real
  Slack secrets against an agent that never comes online — so the bind can only
  happen after the agent exists. By then the running daemon has already read
  `loadChannelCredentials` once and built its Slack adapter from that snapshot,
  so storing the tokens does not connect the new agent. A flow that offers a
  channel during onboarding has to account for the reconnect, the same way it
  accounts for a newly enabled plugin.
- **Storing a channel token is not verifying it, and nothing reports whether
  the channel came up.** The bind route checks that three fields are strings
  and writes them; there is no channel equivalent of `/credentials/verify`.
  The adapter then treats a failed connection as survivable *by design* —
  `socket.start()` throwing is caught and warned past, so that "one broken app
  must not take the rest of the fleet down" — and `/health` reports agents,
  sessions, approvals, and runtimes, and nothing about channels. So a wrong or
  under-scoped token ends onboarding with the daemon healthy, the agent
  created, and the chosen channel silently dead. A flow that offers a channel
  either verifies it or stops claiming it is connected; what it cannot do is
  infer either from the calls succeeding.
- **Plugins are a startup snapshot; souls are not.** `runServe` reads the
  plugin config once and hands it to `createGateway`, while
  `POST /roster/reload` re-reads agents — which is why a new agent is
  dispatchable immediately and a newly enabled plugin is not.
- **A missing plugin is not a restart away.** 16 refuses to create anything
  when a template names an uninstalled plugin, and no restart makes an absent
  package resolvable, so the payload has to carry what the shipped templates
  name.
- **The review is bound to what it reviewed.** 16's lock serializes the write,
  not the minutes a person spends reading, so an apply has to carry a digest
  of the previewed inputs and be refused when they have changed.

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
  at module top level.

  **The seam is every runtime import, not every provider construction.** A
  bare constant pulls the package just as surely as a factory does, and both
  files have one: `state` imports `DEFAULT_CODEX_MODEL` alongside
  `createCodexProvider` and resolves default models with it. So deferring
  construction while leaving the constant behind changes nothing — the daemon
  still fails at load. Either both packages lose *every* runtime import from
  `state` and the CLI, or the defaults move into a package that stays
  bundled. That is a prerequisite of the lean bundle rather than a detail of
  it. (`provider-anthropic` is unaffected: it stays bundled, so
  `DEFAULT_ANTHROPIC_MODEL` can keep its ordinary import.)

## Acceptance criteria

- On a Mac with no Node, no CLI, and no Homebrew: download, open, and reach a
  created, running agent in under two minutes, measured end to end, with no
  terminal opened. What "running" is demonstrated *by* is the onboarding
  design's to settle; the budget is not.
- First run completes with the network unplugged after download, up to the
  point where a provider sign-in needs it — which means **every template
  offered on first run has its plugins, and any browser executable they need,
  in the payload**, and **the payload carries every optional peer the app
  needs — `control-api` first, then the adapter for every channel it offers**,
  which is not a per-template question. Asserted by building the payload and
  starting the daemon from it, not by reading the build: an absent control API
  produces a daemon that serves nothing and warns about nothing, so what is
  asserted is that the app's own health check reaches it. The fetch-as-a-pack
  path exists for what is too heavy to bundle, and a template depending on it
  is not a first-run template: offering one would trade the offline guarantee
  for a menu entry.
- Every file the app writes is byte-compatible with the CLI **at the same
  state schema version**: `stratus agents` lists the agent the app created,
  and the two can be used interchangeably **for reading and writing state**.
  Across versions they cannot, by design — the build with the newer `STATE_SCHEMA_VERSION` migrates
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

  **Lifecycle commands are a separate question, and they are not
  interchangeable at all.** There is one LaunchAgent: `service.ts` writes
  `~/Library/LaunchAgents/com.stratusagent.stratusd.plist` under the fixed
  label `com.stratusagent.stratusd`, `installService` boots out and replaces
  whatever job is already there, and `uninstallService` removes the unit
  outright. So `stratus service install` or `stratus update` from a global
  CLI silently repoints the daemon at that CLI's Node and entrypoint, and an
  app update or uninstall can remove a unit the CLI installed. Schema fencing
  does not touch this: it is an ownership collision over a single shared
  resource, not a versioning one. Who owns the unit when both are installed
  has to be decided — the criterion here is only that the app never silently
  takes it, and says what it found when the unit is not the one it wrote.
- The daemon survives logout and log back in, and the menu bar reflects a
  daemon killed out of band within seconds. **After a reboot it returns at the
  next login, not at power-on** — a LaunchAgent is tied to a login session, as
  `installService` already tells the operator, so unattended reboot recovery
  needs automatic login and the app must say so rather than implying the
  daemon is always up.
- Each of the five sign-in paths completes without a terminal, and a key is
  verified before it is stored — **except that the Claude subscription path
  holds this only if the unrun spike in `Depends on` says it can.** The
  criterion is conditional on that spike rather than asserted over it: if
  `setup-token` demands a terminal, it is four paths and an honest message on
  the fifth.
- Onboarding does not report a running daemon on the strength of a healthy
  port. Asserted with a hand-started `stratus serve` already holding it: the
  app must notice that the daemon answering is not the one its LaunchAgent
  launched — and adopt it or refuse — rather than proceeding while its own job
  crash-loops behind a green check.
- Removing the app stops the daemon, or tells the user plainly how to. Asserted
  by dragging `Stratus.app` to the Trash and confirming that nothing is left
  connected to Slack and answering on the API port, since no app code runs on
  that path.
- Moving `Stratus.app` to another folder, and updating it, both leave the
  daemon running and restartable — because no path in the LaunchAgent points
  inside the bundle. Asserted by moving the app and rebooting, not by reading
  the plist. **An install that fetched anything on demand stays working across
  that update too** — a provider pack, a template's plugin pack, or a browser
  executable a `browser.*` template needed. The update installs a new
  versioned runtime directory, so any of them left in the old tree leaves the
  daemon unable to resolve something the persisted config still names, and the
  agent without capabilities its operator reviewed and approved. Retained,
  migrated, or refetched is a choice — having no answer is not, and it is part
  of where packs live below.
- A template whose effective result changed between preview and confirmation
  is refused, and the operator is shown the new summary rather than the old
  one being applied — asserted by mutating the config between the two calls.
- Onboarding cannot apply a template without the operator confirming a
  summary that lists every tool with its resolved risk, every credential
  requested, and every plugin change — and the summary the app shows is
  identical to what `stratus agent new --template X` prints for the same
  overrides on the same
  template on the same host, because it is the same computation.
- A template naming a plugin the payload does not carry never reaches
  onboarding, because 16 would refuse to create anything from it.
- The app's own code contains no provider, tool, or loop code, and imports
  none — asserted against the app artifact, not the bundle, which necessarily
  ships the kernel as its daemon payload.
- A downloaded, notarized build opens on a clean Mac with no Gatekeeper
  warning.

## Depends on

- **[16](./16-templates.md)** — the onboarding is a template picker, and the
  format does not exist yet. This is the long pole, not the app.
- **16's contract extended to carry provider and model overrides** as explicit
  reviewed inputs. Today it renders only the id and the display name and keeps
  the rest literal, which a wizard offering a model picker contradicts. The
  extension is small and keeps the property intact — the override is previewed,
  summarised, and digest-bound like everything else — but it is a change to
  another step's format, not something this one can assume.
- **A migration fencing protocol in the CLI**, not only in this app. A newer
  CLI migrates state from its general startup path, and only `stratus update`
  stops the service first — so an ordinary command from a separately
  installed newer build stamps the state while this app's older daemon keeps
  running and writing the previous schema. Nothing the app can do alone
  prevents that, because the app is not the process doing the migrating.

  **And the daemon is not the only writer.** The version guard runs once, at
  startup, so a `stratus chat` or `stratus run` that was already going when a
  newer build migrated keeps writing the format it started with — the same
  hazard, in a process no service manager owns and nothing can restart. The
  protocol has to fence *every* active state-writing process, not just
  `stratusd`. Without it, the acceptance criterion above forbids a corruption
  the stated dependencies still permit.
- **A sign-in capability descriptor in `control-api`.** The wizard has to know
  which providers accept an API key, which accept a subscription, and which
  vendor command a subscription sign-in spawns. No endpoint answers that:
  `GET /credentials` reports presence and stored type, `/catalog/models` needs
  a credential before it says anything, and the rest of the knowledge lives in
  the CLI's setup menus. Either it becomes a descriptor both surfaces read, or
  the app carries a copy that drifts the first time a provider gains an auth
  method — which is the failure this step's Out list names.
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
- **Some way to observe whether a bound channel connected** — a channel
  verification the app can call, or channel state on `/health`; which of the
  two is the API's decision, not this step's. Nothing today distinguishes a
  working Slack app from a wrong token: the bind stores without checking, the
  adapter survives a failed connection on purpose, and `/health` carries no
  channel field. Only the branch that promises a *connected* channel needs
  this. A flow that stores the tokens and says plainly that it has done no
  more than that is unblocked — and is the fallback if this does not land.
- **A spike this container could not run: whether `claude setup-token` prints
  capturably when stdout is not a TTY.** It gates the Claude subscription
  path, one of the five, and it needs a real Mac and a live subscription.

  **A TTY requirement is not a small fix, which is why this is a dependency
  rather than a detail.** Node has no built-in pty, so giving the child one
  means a native addon — and that costs precisely the property the payload
  rests on: the spike measured **zero `.node` files** in the tree and
  concluded *"nothing is compiled against a Node ABI, so the tree is not
  coupled to the Node version that runs it."* A pty would couple it, and the
  relocation and signing results would have to be re-established against the
  exact Node build shipped.

  So the fallback is stated rather than discovered: if `setup-token` needs a
  terminal, the Claude *subscription* path is not terminal-free in V1 and the
  app says so, offering the Claude API key path — which works today and is
  already one of the five. Losing an authentication mode is bad; a native
  addon smuggled into the payload to save it is worse, and quietly breaking
  the two-minute claim is worst.

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
