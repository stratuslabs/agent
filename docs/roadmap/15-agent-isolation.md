# 15 — Agent isolation: per-agent state, process-per-agent, containerized execution

## Goal

Make the agent a *boundary*, not a row: an agent's sessions, memory,
credentials, workspace, and command execution are structurally its own, so a
bug — or a prompt-injected agent — cannot reach another agent's state or the
daemon's, because the handle does not exist in its process rather than
because a filter remembered to exclude it — with the OS-enforced wall
available as configuration, not a rewrite, where a threat model demands it.

## Why now

The v2 architecture called its safety posture **policy before isolation**
(decision 6 in [`stratus-v2.md`](../architecture/stratus-v2.md)) and said
outright what would upgrade policy to a boundary: "worker or process
isolation with a scrubbed environment … and it is not built." Steps 01–14
built the policy: risk levels that fail closed, command scopes,
`envMode: 'replace'`, canonicalized fs roots, remote approval. This step
builds the boundary under it, and the order was right — policy is what makes
an isolated agent *useful*; isolation is what narrows the blast radius when
the policy layer fails.

It is due now because the fleet acts unattended. After
[10](./10-proactive.md), agents fire on schedules with nobody watching;
after [06](./06-tool-packs.md), a turn can touch the filesystem, the shell,
and the web. The realistic failure is not a malicious plugin — it is one
agent, talked into something by a page it fetched, running in a process that
holds every agent's provider keys and one shared `sessions.db`. Today the
blast radius of one compromised agent is the fleet.

The neighbors have staked out the corners of this space. OpenClaw is the
shared-process, app-level-checks model — where Stratus is today, with
tighter policy. NanoClaw is container-first: the whole agent lives in a
container and sees only what is mounted. Hermes sits between: profiles give
each agent instance its own process, config, and memory, with pluggable
execution backends from local to Docker. This step lands Stratus at the
Hermes point *with one gateway still coordinating the fleet* — which
profiles-as-separate-installs cannot do — and makes the NanoClaw posture a
configuration rather than a rewrite.

It also pre-decides half of [08](./08-deployment-profiles.md): the hosted
profile's open question — key-prefix namespaces vs. process-per-tenant —
gets much easier once process-per-*agent* exists, because a tenant boundary
becomes a grouping of boundaries that are already real.

## Scope

Three layers, deliberately separable — the first is cheap and delivers most
of "sessions never cross" on its own; each later layer hardens the one
before it.

**In:**

### A. Per-agent state layout

- Every per-agent durable resource moves under the agent's own directory,
  `~/.stratus/agents/<id>/`: `sessions.db`, `memory.jsonl` (and its FTS
  index), the workspace from `~/.stratus/workspaces/<id>`, and the command
  whitelist from `~/.stratus/agents/<id>.whitelist.json` beside the soul.
  Nothing is in per-agent-directory form today — the whitelist is the
  closest, a per-agent *file* in the shared directory — so all four move.
  Agent ids are already validated as single, path-safe
  segments precisely so they can key paths — this step is why that
  validation exists — but the invariant is path *safety*, not the slug
  shape ids are minted in: `isValidAgentId` deliberately accepts the
  legacy `Ava_1`, `team.alpha`, and `AVA` that key real data today, and
  its own comments say why holding them to `AGENT_ID_PATTERN` on upgrade
  would strand their agents. So the layout and the migration walk the
  validated roster's actual ids, never a pattern.
- Directories are `0700`, same posture as `credentials.json`.
- One migration, alias-aware like the legacy memory merge, covering all
  four resources: the shared `sessions.db` and `memory.jsonl` split by
  agent id on first start; the per-agent workspace directory and whitelist
  file move whole. Originals are left in place renamed, never deleted —
  repointing a store constructor at a path the migration did not populate
  is how workspace contents and persistent approvals would silently
  vanish, which is exactly the defect class this layer exists to end.
- **Schedules deliberately do not shard.** A schedule row is fleet
  infrastructure, not agent state: the scheduler ticks in the gateway,
  `GET /schedules` is by its own comment the *fleet's* audit list, and
  `DELETE /schedules/:id` addresses a bare schedule id whose cancellation
  revokes the standing destination grant riding on the row. Scatter the
  rows across per-agent databases and a schedule outside whichever file
  happens to be open neither fires, nor appears in the audit, nor can be
  cancelled — a standing grant outliving its operator's reach, which is
  the precise failure [10](./10-proactive.md) built that surface to
  prevent. The rows migrate to a fleet-level store the gateway — later,
  the supervisor — owns, keyed by agent id exactly as today.
- **One session index survives the sharding.** Session ids are
  caller-chosen, and the control API resolves them *without* an agent id —
  `GET /sessions/:id`, a message to an existing session — which is
  unambiguous today only because the shared database's global primary key
  makes a duplicate id unrepresentable; event attribution and
  single-flight locking lean on the same uniqueness. Per-agent stores
  therefore come with a supervisor-wide session → agent index, written at
  create (where a duplicate is refused), consulted by every lookup that
  arrives without an agent. Without it, sharding quietly turns "which
  conversation" into a guess.
- The gateway may still be one process after this layer alone — the win is
  that cross-agent reads become *impossible to write accidentally*: a store
  is opened on an agent's path, so there is no query that could return
  another agent's rows.

### B. Agent runtime as a child process

- The gateway becomes a small supervisor plus N agent runtimes. The
  supervisor keeps what is fleet-infrastructure: the control API, the
  channel adapters (Slack tokens are gateway secrets an agent must never
  read — parenting them enforces the invariant that today is a resolver
  rule), the roster, the scheduler tick, and approval routing. An agent
  runtime is the kernel loop, the provider, the tool registry and
  executors, and that agent's stores from layer A.
- **The gateway API does not change.** Surfaces never owned an agent loop
  (ground rule since [01](./01-gateway.md)); they consume the same API
  whether it is backed by closures or by IPC to a child. The typed event
  stream is already the one contract every consumer uses — it becomes the
  wire format between runtime and supervisor instead of only between
  gateway and surfaces.
- Each runtime's environment holds **only that agent's credentials**,
  resolved by the supervisor at spawn. `envMode: 'replace'` protected
  child *commands*; this protects the agent process itself — agent A's
  address space never contains agent B's keys, or the Slack tokens. The
  credential store stays supervisor-only: a runtime is handed resolved
  values — or, once [08](./08-deployment-profiles.md)'s per-request
  credential source exists, an opaque handle over IPC — never the path to
  `~/.stratus/credentials.json` or a resolver over it. Spawn-time env is
  not the whole contract: the gateway today re-resolves configuration per
  dispatch, so a rotated credential selects a new runner on the next turn
  — `runnerKeyFor`'s comment says exactly this — and a runtime keeping a
  revoked key until someone thought to restart it would regress that. So
  the supervisor re-resolves on each dispatch and the dispatch carries
  the agent's current credentials (the same shape 08's per-request source
  wants); a credential changed through the control API reaches the
  affected runtime before its next turn, by that handoff or by a runtime
  restart.
- **The limit of same-user processes, stated so no doc can overclaim it:**
  runtimes sharing the supervisor's OS user are a real fault boundary and
  a real partition of memory and environment, but not a filesystem
  boundary — the OS sees one user, so a runtime that fully escaped both
  the policy layer and its own tool surface could still open the
  credential store or a sibling's directory. Layer B narrows what a
  compromised runtime *holds* and touches by default; denying what it can
  *reach* is precisely the deferred hardening (per-agent OS users,
  `sandbox-exec`) or an `isolation: container` third mode that runs the
  whole runtime — not just its commands — inside layer C's container with
  only `agents/<id>/` mounted. That mode is the NanoClaw posture as one
  more value of the same knob; it is held in the open questions rather
  than promised here, and the documentation this step lands must draw
  this line exactly where the mechanism does.
- Per-agent crash containment: a runtime that OOMs or wedges is killed and
  restarted alone, with [03](./03-permissions.md)'s restart recovery
  scoped to that agent; the fleet does not notice.
- `isolation: shared | process` per soul, defaulting to `process`. `shared`
  keeps the current in-process path for constrained machines and for tests
  — it is a supported mode, not a deprecated one, which is also what keeps
  the seam honest: both modes run the same parity suite.

### C. Containerized command execution

- `@stratusagent/executor-container`: the `Executor` contract from
  `@stratusagent/executors`, implemented over Apple `container` (macOS) or
  Docker/Podman (Linux) instead of `node:child_process`. What
  `executor-local` spawns on the host, this runs in a per-agent container
  whose mounts are exactly the agent's fs roots plus its workspace —
  agent-composed commands see what the agent was granted and nothing else.
- Opt-in per agent (`executor: container` in the tool-shell plugin
  config), recommended in the docs wherever a runtime is available.
  **Container isolation as a *default* stays out of scope** — that is a
  standing v2 decision this step does not reverse; it makes the posture a
  config value so a deployment whose threat model demands it writes one
  line instead of forking.

**Out:** separate OS users per agent and `sandbox-exec` profiles (the
process boundary is what makes them *possible*; adding them is hardening a
later step or a deployment recipe can take up); VM-per-agent; moving
in-process tools (`tool-fs`, `tool-web`, `tool-browser`, memory) behind the
executor seam — they run in the runtime process and stay contained by
policy, exactly as Hermes's non-terminal tools do, and pretending layer C
covers them would be a false promise; any change to kernel contracts —
`Executor`, `Tool`, and the event stream already carry everything this
step needs, which is the evidence the seams were right.

## Design sketch

- **Supervisor/runtime split follows one rule**, the same shape 08 uses for
  framework/downstream: what serves the *fleet* (surfaces, transport
  secrets, approval routing, the scheduler's clock) lives in the
  supervisor; what serves *one agent* (loop, provider, tools, stores)
  lives in its runtime. Anything that wants to live in both is probably a
  rule that belongs exported from `@stratusagent/state`.
- **IPC is the event stream plus a dispatch call.** A runtime is close to a
  gateway with a roster of one; the supervisor dispatches a turn and
  subscribes to events, over a local socket per runtime. No new
  serialization format — the events are already JSON, already typed,
  already the only side-channel-free surface.
- **Approvals evaluate in the runtime, resolve in the supervisor.** The
  permission engine runs where the tool call is (the runtime — it needs the
  tool, the input, and `commandFor`), but a `gated` call that needs a human
  parks and asks *through* the supervisor, which owns the Slack approvers.
  This is the same park-and-resume the engine already does across daemon
  restarts, pointed at a socket instead of a store.
- **Scheduler stays in the supervisor**, consuming slots before dispatch
  exactly as [10](./10-proactive.md) built it; a firing becomes a dispatch
  to the agent's runtime. Double-run protection does not change — the
  schedule row was always the lock.
- **`agent.delegate` crosses the boundary through the supervisor**, which
  is where it must go anyway for 08's sub-leases: the supervisor is the
  only party that can hand a delegated runtime a *narrower* credential set
  than the parent's, because it is the only party holding any.
- **Layer A ships without layer B.** The store constructors already take
  paths; layer A is changing what path each agent's stores open, plus the
  migration. It must not wait for the supervisor work.
- The Node version floor is unaffected: runtimes are the same Node, and
  `node:sqlite` moves with the store.

## Acceptance criteria

- **The test claims what the mode provides — non-possession, not
  inability.** With two agents under `process` isolation, nothing hands
  agent A's runtime any of agent B's state or the fleet's secrets: the
  test fails if another agent's path, a fleet-wide credential, or the
  credential store's location reaches the runtime's env, argv, or
  spawn-time configuration, and credential resolution is shown
  supervisor-only at the seam — no runtime code path opens the credential
  store, and the runtime package carries no dependency on the resolver
  that can. Proving the OS *denies* an escaped runtime the read belongs to
  the hardened modes (OS users, a containerized runtime) and lands as
  their acceptance test when they do — a same-user process cannot pass it,
  and this criterion does not pretend otherwise.
- Caller-chosen session ids stay globally unique across the sharded
  stores: creating a session under one agent with an id another agent's
  store already holds is refused at the create seam, and
  `GET /sessions/:id` — no agent in hand — resolves through the index to
  the right store, identically in both isolation modes. A migration that
  surfaces a pre-existing duplicate fails loudly at startup, naming both
  agents, rather than picking one.
- With state sharded, the fleet-wide schedule surface is unchanged: every
  agent's schedules still fire, all appear in `stratus schedules`, and a
  bare-id cancel still lands — destination-grant revocation included —
  exactly as against the shared database.
- `kill -9` on one agent's runtime mid-turn: the turn fails honestly (the
  abandoned-turn sweep already reports this), the agent restarts, its
  parked approvals recover, and a concurrent turn on another agent
  completes unaffected.
- The same scripted conversation — tool call, gated approval via Slack,
  streamed reply, a credential rotated through the control API taking
  effect on the next turn, restart, resume — passes identically under
  `isolation: shared` and `isolation: process`. The parity suite from
  [04](./04-agent-sdk-bridge.md) is the model: one behavior, two
  transports.
- Migration drill: a `~/.stratus` with shared `sessions.db` and
  `memory.jsonl`, populated `workspaces/<id>` directories, and
  `agents/<id>.whitelist.json` files starts under the new layout; every
  agent finds its history, memories, workspace contents, and persistent
  approvals; the originals are preserved; and a second start does not
  re-migrate.
- A command run under `executor-container` cannot read a host path outside
  the agent's roots and workspace (tested with a real runtime on macOS via
  Apple `container` and on Linux via Docker); the same soul with
  `executor: local` still passes the tool-shell suite unchanged.
- Docs land with the change, per the repo rule: the layout move and
  `isolation`/`executor` config in the CLI README, the supervisor split in
  the control-api README where it touches event delivery, and the v2
  decision-6 paragraph updated from "it is not built" to a pointer here.

## Open questions

- **IPC transport**: `node:child_process` IPC channel (free, already
  framed) vs. a unix socket speaking the control API's own envelope
  (uniform with every other consumer, and a runtime becomes debuggable
  with the same tools as a gateway). Lean socket — one envelope everywhere
  has been the payoff of every "one contract" decision so far — but the
  child IPC channel is acceptable v1.
- **Where the provider lives** for the Claude-subscription path: the SDK
  bridge holds per-agent auth state; confirm it moves into the runtime
  cleanly or name what the supervisor must broker.
- **Per-agent OS users, and `isolation: container`**: both out of scope
  here, but both must stay reachable. The recipe shape for users (a
  `runAs` on the soul, supervisor spawns with it) should be sketched in
  this step's PR so nothing in the IPC design forecloses it — and a
  containerized *runtime* (the whole of layer B's child inside layer C's
  container, only `agents/<id>/` mounted) forecloses the child-IPC
  transport outright, since a socket crosses a container boundary and an
  inherited IPC channel does not cheaply. That is a real argument in the
  transport question above, not a separate decision.
- **Does 08's process-per-tenant collapse into this?** A tenant as a set
  of agent runtimes plus a namespaced supervisor looks strictly simpler
  than a parallel mechanism — decide when 08 starts, against real tenant
  counts, but this step should leave a note in `08-deployment-profiles.md`
  when it lands.
