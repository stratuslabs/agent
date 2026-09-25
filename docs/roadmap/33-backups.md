# 33 — Backups: a nightly, model-free copy of a home somewhere else

## Goal

An operator can name a private git repository once, and every night the
parts of `~/.stratus` worth keeping (souls, skills, memory, schedules, and
optionally conversations) are committed and pushed there. A script does
the work, not a model. No value the home knows to be secret is pushed in
any form the scan recognizes. Conversations and workspace files, where
arbitrary tool output lands, go up only as ciphertext. Plaintext memory,
and the prompts of schedules an agent created, carry the scan's
guarantee and no more: a secret an agent rewrote into
a form nothing recognizes is not caught (see
[Secrets](#secrets-three-layers-because-one-is-not-enough) for exactly
where that line is). A lost machine can be restored from the repository
with one command. The feature is off by
default and ships as a package you have to add.

## Why now

A roster exists to accumulate things: memory ([14](./14-memory.md),
[29](./29-memory-quality.md)), standing grants ([28](./28-standing-grants.md)),
schedules ([10](./10-proactive.md)), and conversations that never have to
end ([32](./32-context-management.md)). All of it lives on one disk.
[State layout](../reference/state-layout.md#moving-or-backing-up-a-home)
tells an operator to copy the directory with the daemon stopped, which is
correct and which nobody does on a schedule. So the longer a fleet runs,
the more a single disk failure, a bad migration, or a mistaken `rm` costs.

It is also small and has no dependency on anything unshipped. The layout it
reads was settled by [15](./15-agent-isolation.md) Layer A. It carries
[08](./08-deployment-profiles.md)'s "backup of `sessions.db` + memory +
souls" line, and it makes that step's "backup/restore drill" something to
run rather than something to write.

## Scope

**In:**

- **An optional package, `@stratusagent/backup`.** It is a companion
  package like `control-api` and `dashboard`, not a plugin. It contributes
  no tool, skill, provider, channel, memory store, or executor, and calling
  it a plugin would stretch the word ([plugins.md](../architecture/plugins.md)).
  No agent can reach it: backing up the fleet is the operator's act, never
  something a soul can list.
- **`stratus backup init <remote>`, `now`, `status`, `restore`, `enable`,
  `disable`.** `now` is the whole feature, and everything else schedules,
  reports, or reverses it.
- **A git target first.** The operator supplies a repository, almost
  always a private GitHub one. The package commits a snapshot and pushes
  it.
- **What goes in:**

  | Default | Opt-in | Never |
  | --- | --- | --- |
  | `agents/<id>.md` souls, `skills/`, `config.json` (sensitive values redacted, below), `state.json`, per-agent `memory.jsonl` and `whitelist.json`, the provenance ledger (`fs-provenance.jsonl`, below), the `schedules` table from `fleet.db` | `sessions.db` per agent and the session index (`sessions`), `workspace/` per agent (`workspaces`) | `credentials.json`, `gateway-token`, `gateway.json`, `stratusd.lock`, `logs/`, `memory.jsonl.index` (it is derived and can be rebuilt, except for its `usage` table, below), the `-wal`, `-shm`, and `-journal` sidecars of the databases it snapshots (only those: a workspace file that happens to be named `cache-wal` is copied like any other) |

  Sessions are opt-in because they are the largest and most sensitive
  thing in a home: whole conversations, tool inputs, and command output.
  Workspaces are opt-in because they hold binaries that git stores badly.

  **On the git target, both opt-ins are encrypted, not optional extras.**
  They are where arbitrary tool output lands, and a tool can write a
  secret in a form no scan can recognize: `base64`, hex, a compressed
  archive, an image. Redaction (below) still runs on them. It also checks
  the base64, hex, and URL-encoded forms of every known value, because
  those are cheap. But it cannot promise to find a secret after an
  arbitrary transformation, so the promise for this content is
  ciphertext. `sessions` and `workspaces` are committed as per-file age
  ciphertext under a key the operator holds outside the backup, and
  `init` refuses either opt-in without one. **Names are encrypted along
  with contents.** A workspace filename is tool output too, and git
  publishes it in the tree. So each encrypted file is committed under an
  opaque name (a keyed hash of its path), and the real paths live in an
  encrypted index beside them. Without that, a secret written into a
  filename in a form no scan recognizes would be published even though
  the file's contents are ciphertext. Unchanged files keep their
  previous ciphertext. age output is randomized, so re-encrypting an
  unchanged file would rewrite every blob every night, defeating
  "no change, no commit" and growing the repository without bound. `now`
  keeps a local map from a keyed hash of each file's plaintext to the
  ciphertext it last committed. The map lives beside the clone and is
  never committed. A file whose hash has not changed is staged with its
  old ciphertext. The map's key also includes the recipient's
  fingerprint and the encryption policy, so rotating the key or changing
  `encrypt` re-encrypts everything on the next run. Otherwise, a
  snapshot taken after a rotation could still hold blobs only the
  retired key opens.

  Souls, skills, config, and memory stay plaintext and diffable, and the
  guarantee there is stated as exactly what it is: **no value the home
  knows to be secret, in any form the scan checks** (raw, JSON-escaped,
  base64, hex, URL-encoded), and nothing shaped like a well-known key.
  It is not "no secret, whatever an agent did with it". Memory is
  model-authored text, and a model that stores a key ROT13'd or
  paraphrased has moved it past any scanner. So is the prompt of a
  schedule an agent created with `schedule.every` or `schedule.at`. It
  sits in the `schedules` row, it is in the same class as memory, and
  the same limit and the same option cover it. Encrypting memory by
  default would close that and cost the main reason to back up to git,
  readable history of what an agent believed. So `encrypt: "all"` is an
  option for an operator who wants the stronger guarantee instead,
  covering memory and schedule bodies together, and
  the documentation says plainly which one the default makes.
- **Only a fully migrated home is backed up.** An upgraded home whose
  exclusive migration has not run yet still keeps its grants at
  `agents/<id>.whitelist.json`, and its sessions and schedules in the
  shared root `sessions.db`. A snapshot of the new layout would silently
  miss them. `now` checks `pendingStateMigrations` first and fails with
  the fix (`stratus update`, or starting the daemon once) rather than
  learning the old layout a second time.
- **Everything the trusted config points at, not only what sits under
  `~/.stratus`.** A snapshot that restores a config referring to a file
  it never saved is a broken restore. Four cases exist today:
  - **The trusted config itself.** `--config` and `STRATUS_CONFIG` both
    move it out of `~/.stratus`, so the snapshot takes the file
    `resolveConfigLocation` resolves, never `config.json` by assumption,
    and saves it as the snapshot's `config.json`. The manifest records
    where it came from. The effective configuration can come from two
    files at once. When the daemon's working directory holds an
    auto-discovered `stratus.config.json`, that untrusted file is the
    one selected, and `readTrustedConfigBlock` still reads every
    trusted-only block the project file omits from
    `~/.stratus/config.json`. So in that case both files are saved, both
    redacted, and the manifest records which is which. Restore puts the
    global file at `<dir>/config.json`, puts the project file under
    `external/`, and prints where it came from. Saving only the selected
    file would drop the plugins, memory store, principals, and channels
    the daemon was actually running with. `enable` writes the timer with the same
    `--config` or `STRATUS_CONFIG` the service runs with, **and the
    same working directory**, because a config may hold relative paths
    (a `soul`, a database, a workspace root) and those resolve against
    the process's working directory, which the service definition sets
    on purpose. The manifest records every such path as it resolved, so
    a snapshot says exactly which files it came from.

    **The daemon records its own resolution context, at every start.**
    That context is the working directory, which config was selected
    and by what (`--config`, `STRATUS_CONFIG`, or the default), and which
    soul was selected and by what (`STRATUS_SOUL` or the config). None of
    it can be read back later from outside. The service definition does
    not carry `STRATUS_SOUL`, and a daemon started by hand, or
    reinstalled with another `--config`, has an environment the timer
    never sees. So every daemon start writes that record into the
    backup directory, through the same shared writer and under the same
    secret-set lock and generation as a config save, since a new context
    can bring new secrets with it. Every `now` resolves from the latest
    record,
    including a `now` typed by hand in some other directory. A restart
    with a different config, working directory, or `STRATUS_SOUL`, or
    without one, is followed from that start. A daemon that was already
    running when `init` ran has written no record yet. So `init` asks a
    running daemon for its context over the control API, and without
    the API it refuses until the daemon restarts, saying so. What the
    record does not pin is the *content* of the config: a soul or root
    the config names is re-read from the current file on every run, so
    an edit to `soul` is followed the same night. A manual run and the
    nightly one therefore snapshot the same tree.
  - **The selected memory store.** With `@stratusagent/memory-sqlite`
    selected, the memories live in one database at the path its config
    names, and the per-agent `memory.jsonl` files are unused. `now`
    snapshots whichever store is selected: the JSONL files for the
    default, and the configured database (by `VACUUM INTO`, like every
    other) for `memory-sqlite`. A store contributed by any other plugin
    fails the run with the store's name, until `MemoryStoreContribution`
    grows an optional, defaulted export and import pair (a store that
    omits it cannot be backed up, and says so) rather than having the
    backup guess at its storage.
  - **A config-only default `soul`.** The trusted config may name a soul
    file outside `agents/`, and so may `STRATUS_SOUL`, which outranks
    it. `now` takes the one `resolveConfiguredSoul` resolves in the
    service's environment, whichever selector chose it. It is copied
    into the snapshot under `external/`, and the snapshot's manifest
    records the original path and the selector. Restore rewrites a
    config selection in place. An environment variable is not
    something restore can write, so for one chosen by `STRATUS_SOUL`
    it prints the new path to export.
    An external resource that lies inside a tree the snapshot already
    copies in plaintext, such as a soul at `skills/example/SOUL.md`, is
    not copied a second time. It is recorded as a subpath of that tree,
    and restore points the config at the restored file inside it, so an
    edit through the skill still changes the soul the daemon serves.
    The config file and a `memory-sqlite` database are the exceptions.
    The config is committed *redacted*, and a database is committed as
    a `VACUUM INTO` export. Either way, the tree around it would carry
    the raw live file, so one blob cannot be both. A config or database
    inside a copied tree (`skills/`, say) makes `now` refuse and say to
    move it out.
  - **Where the workspaces are.** Every plugin that writes files finds
    an agent's workspace through `workspaceResolver` in
    `@stratusagent/plugins`. An operator-configured `workspaceRoot`
    wins, and relocating a workspace by writing one down is documented.
    Otherwise the host's seam answers with `agents/<id>/workspace/`,
    which may itself be a link to another volume (a supported link,
    below). So under one daemon, `tool-shell` output can land under a
    configured root while `plugin-mcp` output lands in the seam
    workspace. `tool-fs`'s provenance ledger always follows the seam.
    "Each agent" here means every agent with state on disk, not every
    soul in the roster. An agent whose soul was deleted keeps its
    `agents/<id>/` directory: its memories, grants, sessions, and
    workspace are still there, and the state layout keeps them on
    purpose. So `now` enumerates agents the way the host does, through
    `allAgentWorkspaces` and the valid agent directories on disk, and a
    configured root contributes every agent directory under it. With
    `workspaces` opted in, `now` asks `workspaceResolver` for each
    plugin block in the config, enabled or disabled, and each such agent. A
    disabled plugin's output is still durable output, and turning the
    plugin off does not delete it. It asks with the same `(seam, workspaceRoot)`
    pair that plugin receives or would receive. It never re-derives the
    precedence. The
    seam workspace, `agents/<id>/workspace/`, is always included as
    well, even when every enabled plugin has a configured root. It is
    the agent's state-owned output directory, it holds the `tool-fs`
    ledger, and it keeps files written before a plugin was relocated or
    disabled. A root seen once stays in the set. Changing a plugin's
    `workspaceRoot` does not delete what the old root holds, so `now`
    records every root it has enumerated, beside the clone. It keeps
    backing up each one that still exists until the operator retires it
    with `stratus backup forget-root <path>`. `status` lists the roots
    still carried only because of that record. The record also travels
    in each signed manifest, so losing the clone does not lose it.
    Restore reseeds it on the new machine, and so does `init` when it
    adopts an existing branch.
    Roots that coincide are one tree. A root nested inside another is
    recorded as a subpath of the outer tree rather than copied twice. A
    resource the snapshot commits in plaintext is never inside any of
    them: an external soul, a `memory-sqlite` database, or the trusted
    config file wherever `resolveConfigLocation` found it. The
    writable-root guard below refuses that layout and says to move the
    file out. The directories an agent is merely allowed to work in
    (`tool-fs` roots) are the operator's own files, not agent state, and
    stay out.

  Restore never writes outside the directory it was given, apart from
  the staging directory it creates beside it (see
  [Restore](#restore)).
- **The memory index's `usage` table.** The index is derived from
  `memory.jsonl` in every table but one. `usage` holds recall counts and
  last-recalled times, and nothing else records them. So `now` exports
  that table as JSONL beside the memory it describes, and restore loads
  it into the rebuilt index. Otherwise a restore would silently reset
  what the agent had learned about which memories it uses.
- **Every soul's resolved agent id.** A soul that declares no `name` or
  `id` gets a generated identity seeded from its **absolute path**, which
  is true of ordinary `agents/*.md` souls as well as a config-only one.
  Memory, sessions, grants, and schedules are all keyed by that id, so
  the same file restored under another home directory, another username,
  or `<dir>` itself comes back as a stranger to its own state. The
  manifest records the whole generated identity every soul resolved to
  (id, name, and avatar). Restore writes whichever of those a soul did
  not declare into its frontmatter, printing each soul it changed. The
  id alone is not enough, because the name and avatar are seeded from
  the same path and would come back as a stranger's.
- **Secret replacement before every commit** (design sketch). This is the
  part that must be right the first time, because git history is forever.
- **A scheduled run every night**, installed next to the service unit
  `stratus service` already writes.
- **Restore into an empty home only.** It never writes over live state.

**Out:**

- **Continuous replication.** A nightly snapshot is the goal. A fleet that
  cannot afford to lose a day of conversations should run a replication
  tool (see [Other targets](#other-targets-and-why-git-is-first)), and this
  step does not need to become one.
- **Retention and pruning on the git target.** History is append-only.
  The feature never rewrites history or force-pushes (see
  [A backup that faithfully saves the damage](#a-backup-that-faithfully-saves-the-damage)).
- **Backing up credentials.** Not even encrypted, not even behind a flag,
  in the first version. Credentials are re-entered on a new machine
  through `stratus setup`, which is a few minutes. A leaked Slack token
  costs a great deal more (see [Open questions](#open-questions)).
- **Syncing between two live machines.** A backup has one writer. Two
  daemons committing to one repository is multi-master replication, not a
  backup.
- **Project-local configuration.** It belongs to whichever repository it
  came from.

## Design sketch

### Where it runs

The scheduler in `fleet.db` only runs agent turns: every record carries an
`agentId` and a `prompt`, and firing one dispatches a model turn. A
`Plugin` has only `setup` and `dispose`, with no slot for a background job,
and `stratus run` loads plugins too. So a timer started in `setup` would
also fire in a one-off CLI run.

So the nightly run is **the OS's timer calling `stratus backup now`**: a
systemd `.timer` next to `stratusd.service` on Linux, and a LaunchAgent
with `StartCalendarInterval` on macOS. `stratus backup enable` installs it
and `disable` removes it. This needs no kernel change. It runs when the
daemon is down, which is exactly when a backup is most wanted, and it
fails in the service manager's log (the journal, or the redirected stderr
file on macOS), where the daemon's own failures already land.

Adding a model-free job kind to the daemon's scheduler is the alternative
(see [Open questions](#open-questions)).

### The snapshot is a tree, not an archive

`now` builds a staging tree that mirrors `~/.stratus`, commits it to a
local clone, and pushes. Files that are already text (souls, skills,
`memory.jsonl`, `whitelist.json`, config) are copied after redaction.

The staging tree holds **plain files only**, and the git target commits
all of them, because what the source directories contain is not the
snapshot's business to interpret:

- **Nested repository metadata is dropped.** A skill installed by
  `stratus skill add` from a repository, or a workspace that is itself a
  repository, carries a `.git` directory. Copied as-is, the outer
  `git add` records it as an embedded repository (a gitlink), and a clone
  of the backup holds none of its files. So `.git` is never copied. The
  files are staged as ordinary files, and the manifest records where the
  skill came from.
- **Empty directories are kept.** Git records no tree for a directory
  with nothing in it, and tooling that expects a pre-created `out/` or
  `fixtures/` would break after a restore. Every directory is listed:
  in the signed manifest for plaintext trees, and in the encrypted
  index for workspaces. Restore recreates them.
- **Only regular files and directories are copied.** A check made on a
  path and then acted on through the path again is a race: an agent
  still writing into its workspace can swap a checked file for a FIFO or
  a link in between. So every leaf is opened with `O_NOFOLLOW` and
  `O_NONBLOCK`, and the *descriptor* is checked with `fstat` before a
  byte is read. A FIFO would block the read
  forever, a socket cannot be read at all, and a device file is not
  state. So sockets, FIFOs, and devices (a development server's
  leftovers, usually) are skipped rather than letting one stop or hang
  the night's run. The skipped paths are recorded where the other paths
  of their tree are. A skipped path in a skill goes in the manifest. A
  skipped path in an encrypted workspace goes in the encrypted index,
  because its name is tool output like any other.
- **A hard link is not containment.** `O_NOFOLLOW` stops a symlink, but
  a hard link to a file outside the tree is an ordinary regular file to
  every check above. It would copy an inode that is on neither the
  Never list nor in the secret set. It would also let a swapped entry
  point anywhere on the same filesystem. So a regular file whose
  descriptor reports `st_nlink > 1` is skipped and recorded like a
  FIFO, and `now` names it, when it is optional content: a file in a
  skill or a workspace. Links there are rare, and refusing all of them
  costs less than proving where the other name lives. A workspace's
  `fs-provenance.jsonl` is not optional content. Two workspaces may
  share one ledger through a hard link, a layout the state code
  recognises by inode. So a ledger is compared by device and inode,
  stored once, and restored with the same sharing, from restore's own
  record. A *required*
  state file with a second link fails the run instead, because a
  snapshot without it is not a usable backup. *Required* means every
  file the Default column backs up that is not skill content: the
  selected config, `state.json`, each soul, each `memory.jsonl` and
  `whitelist.json`, and each workspace's `fs-provenance.jsonl`. The one
  list serves every rule that distinguishes required from optional, so
  a file cannot be required for one and optional for another. The error
  names the file and says to break the link.
- **Nothing in the tree gets to change how git stores it.** A skill or
  workspace can carry a `.gitignore` that would hide durable files, or a
  `.gitattributes` whose clean filter (Git LFS, say, if the user has it
  installed globally), encoding, or line-ending rule would commit
  something other than the bytes on disk. So staging does not go through
  `git add` at all. Each file is written with `git hash-object -w
  --no-filters` and placed in the index directly, with the repository's
  own `core.autocrlf` off and no exclude or attribute files consulted.
  The backup's own "Never" list is the only exclusion. A check after
  staging compares each indexed blob with the staged file byte for byte.
  The commit is built with plumbing too (`write-tree` and `commit-tree`,
  never `git commit`), with `core.hooksPath` pointed at an empty
  directory. So no global or templated hook can mutate the index, apply
  filtered staging, or fail every unattended night. The tree that is
  signed and pushed is the tree that was verified.
- **Supported links are materialized; no link is ever committed.** Four
  kinds of link are legitimate in a home. The trusted config file may
  be one, whether it is `~/.stratus/config.json` or a file that
  `--config` or `STRATUS_CONFIG` names, because the runtime reads it
  through the link. It is read through the same check, open, and
  recheck protocol, and committed as the regular, redacted
  `config.json`. A soul file may be one,
  whether it sits in `agents/` or is the config-only default soul, which is how a template's soul stays edited in its own checkout.
  It is copied as a regular file, and its identity is preserved like any
  other soul's (see "Every soul's resolved agent id"). An unnamed linked
  soul is seeded from the path it resolves through, so the id recorded
  is the one the daemon actually used. `agents/<id>/workspace/` may be
  one, because the state layout lets an operator put an agent's output on
  another volume. And a skill may contain relative links between
  its own files, which `skill add` validates for containment and keeps.
  `now` copies what each of these points at into the snapshot as real
  files and directories. Two agents' workspace links can point at the
  same directory. The state layout allows that, and the ledger
  tolerates it. So workspaces are compared by device and inode, and a
  shared one is stored once, with the manifest recording which agents
  share it. Restore makes it a real directory under the first agent and
  links each other agent's `workspace` to it. That link is the only one
  restore ever creates, and it comes from restore's own record, never
  from a tree entry. The ledger's old-to-new mapping then has one
  target per old path. For skill links it uses the same containment
  check `skill add` runs (`findEscapingSymlink`, which is private to
  `state` today and gets exported for its second consumer) rather than
  a second copy of it. That check is a preflight, and the copy does not
  act on its answer by path.

  **Node has no `openat`**, so the walk cannot hold each directory open
  and descend from it. `tool-fs` names the same limit in
  `openContained`. The copy uses a check, open, and recheck protocol
  instead, shared with `tool-fs` rather than written twice. Descending
  records each ancestor's device and inode from `lstat`. The leaf is
  opened with `O_NOFOLLOW` and read from its descriptor. After the
  read, every ancestor is `lstat`ed again, along with the leaf's path.
  If any of them is now a link or a different inode, the bytes are
  discarded and the run fails and names the path. An agent can also
  rewrite a file in place while it is read, which keeps the inode and
  path the same. So the leaf's size, `mtime`, and `ctime` from `fstat`
  are compared before and after the read. On a change the read is
  retried a few times. If the file never holds still, the previous
  snapshot's copy is kept and the file is reported. A file with no
  previous copy, because it is new or this is the first run, is skipped
  and recorded like a FIFO, and the report names it. Both fallbacks are
  for optional content only, meaning skill and workspace files, the
  same split the hard-link rule makes, with the same list of required
  files. A required state file that never holds still fails the run.
  A stale ledger beside newer workspace files
  would restore those files without their labels. An old copy of the config
  beside resources its new contents selected would be a snapshot of no
  moment that ever existed. A torn file is
  never signed as a good one. A link the snapshot
  materializes is resolved the same way, one component at a time. What
  this cannot close is a swap that is made and undone again inside a
  single open. The spec states that residual rather than claiming
  `openat` semantics Node lacks. Its reach is also narrow, and made so
  on purpose. `now` refuses any overlap, in either direction, between
  an agent-writable root (a `tool-fs` root or a workspace root) and
  anything it commits in plaintext. That means the plaintext *leaves*:
  `skills/`, each soul file, each agent's `memory.jsonl` and
  `whitelist.json`, the config file, an external soul, and a
  `memory-sqlite` database. It does not mean `agents/` as a whole,
  because `agents/<id>/workspace/` is the default workspace, and it is
  the encrypted or omitted side. A root that
  contains one of them is refused. So is a root that lies *inside* one,
  such as `skills/example/output/`, because the plaintext traversal
  would commit whatever an agent wrote there. The refusal names the
  path and the fix, which is to move one of the two. Otherwise an agent
  could swap a soul it can write for a link to another file, and
  materialization would commit that file's contents. It uses the same
  per-agent resolution as the backup-directory check. So the only trees
  an agent can race are workspaces. On the git target those are only
  ever committed as ciphertext, and a file pulled in by such a race
  lands encrypted, never in plaintext. A process running as the same
  user outside any agent can already read everything the backup can,
  so it is out of scope. A native helper with real `openat`
  (and `openat2(RESOLVE_BENEATH)` on Linux) is the follow-up that
  would close the residual. It is listed under open questions, not
  assumed. A link that reaches outside its own skill or
  workspace fails the run and names the path. So does a cycle: a
  contained link such as `loop -> .` passes containment but has no
  finite copy. The copy tracks the real directories on its *current
  path*, pushing each on the way down and popping it on the way back
  up. It fails only when it would enter one of its own ancestors. An
  alias such as `alias -> shared` beside `shared/` is finite and is
  copied twice, not refused. Because nothing committed is a link, restore's
  refusal of every link (below) never rejects a snapshot `now` made.

Databases are never copied as files: a live WAL-mode database copied
byte for byte can be torn. Each one is snapshotted with `VACUUM INTO` a
temporary path, which is consistent while the daemon is writing, and then
fsynced and renamed. `node:sqlite`'s `backup()` is not available across
the supported range: it arrived in 22.16 and 23.8, and the floor is
`>=22.13 <23 || >=23.4`. Each database is consistent on its own, but
together they are not, so the order matters. Every agent's
`sessions.db` is snapshotted first, and `fleet.db` last. The scheduler
spends a slot in `fleet.db` (`claimSlot`) before it dispatches the
firing's session, so any scheduled session the snapshot captured was
claimed earlier still, and the later `fleet.db` snapshot shows that
slot spent. A restored home can lose a firing that was in flight, but
it can never hold a still-due slot beside its completed session, which
would replay the action on the first tick. The snapshot is then written as `schema.sql` plus
one JSONL file per table, rows ordered by primary key, so that:

- a night where nothing changed makes **no commit at all**;
- a night where one conversation grew adds one diff, not a new copy of a
  multi-megabyte blob. For encrypted content this depends on the
  export's granularity, because any change to a file's plaintext means
  a whole new ciphertext for that file. So the session store is
  exported one file per session, not one file per table. The same
  applies to that session's row in the fleet session index, since
  saving a conversation touches both. The transcript and its index row
  go into **one encrypted unit** per session. A night that touched one
  conversation therefore commits exactly one new blob;
- a table can be left out or redacted by name.

The local clone lives at `~/.stratus/backup/`. It must never live under
`agents/`, because the startup sweep treats any validly named directory
there that holds a `sessions.db` as an agent. Everything else the
backup keeps also lives in that directory: the ciphertext map, the
retired list, the late-credential record, the signing key, the saved
working directory, and the lock. So **no traversal ever enters it.**
Any root an agent can read that contains it is refused by `now` with
the reason, rather than quietly pruned. For example, `~/.stratus`
itself or the home directory. That covers workspace roots, and also
every `@stratusagent/tool-fs` `roots` entry, resolved per agent through
the same resolver `fs` uses. `fs.read` is ungated inside its roots,
so a root above the backup directory would hand every agent the
signing key, and the `0700` mode cannot stop a process running as the
same user. Pruning alone would leave the next ancestor-rooted
tool a way to read the signing key. Every traversal also skips that
directory by device and inode, as defence in depth.

A check in `now` runs at night, though, and a config edited at noon
would expose the key all afternoon. So the refusal is also enforced
where the read happens. `tool-fs` already resolves its roots on every
call. With this change it also refuses any path that resolves inside
`~/.stratus/backup/`, whatever its roots say, and it compares by device
and inode so that a link cannot route around the check. Refusing the
path rather than the root keeps an honest `roots: ["~"]` working, and
it holds from the moment the config changes, with no run in between. The
check in `now` stays, as the early report. A gated tool such as
`shell.run` can still read the key when the operator approves the
call; that approval is the operator's decision, and the spec says so.

The signing key need not live in the backup directory. When `init`
takes git's own `user.signingkey`, it is usually under `~/.ssh`. So
the protected set is the backup directory **plus the resolved private
signing key and the private deploy key, wherever they are**. The
deploy key is the one the pinned `core.sshCommand` names. It cannot
forge a snapshot, but it reads and writes the whole repository, plain
memory and soul history included. `init` records each key's path,
device, and inode beside the clone. `tool-fs` refuses a read of either
file exactly as it refuses the backup directory. `now` refuses a root that
contains it, and reports the refusal.

**The backup directory is owner-only, whatever the home's mode is.**
`~/.stratus` itself can be traversable on a multi-user host: it is
created without an explicit mode, so a `022` umask leaves it `0755`.
Git writes its object store under the umask, so an untightened clone
would expose the plaintext memory and whitelist blobs to every local
user. `init` creates `~/.stratus/backup/`, the clone, and any staging
directory `0700`, with an explicit `chmod` after creation, because
`mkdir`'s mode is filtered by the umask. It sets
`core.sharedRepository=false` in the clone. Every run re-tightens the
directory before it writes anything, so an install made before this
rule, or a directory a user loosened, is repaired on the next run
rather than trusted.

**One run at a time.** A manual `now` can overlap the timer's run, and
both would work on the same clone, index, and ciphertext-reuse map.
Git's per-command index lock does not cover a whole build, commit, and
push, so two snapshots could interleave into a mixed tree. `now` holds
an exclusive lock on the clone for the entire run, from staging through
the push and the map update. A second run that finds the lock held
exits with a distinct "already running" status rather than waiting or
failing silently.

The secret set can also change *during* a run: `stratus credential
set`, or the runtime recording a late environment credential, can land
after `now` collected its set but before it committed. Every change to
the secret set increments a **generation number**, kept beside the
credential store: credential writes, the recorder, and a retired value
(below). `now` reads the generation when it starts. For the final
step, it then takes the **secret-set lock** that every one of those
writers also takes: re-read the generation, commit, push. The push
under the lock is **bounded**, five minutes by default and
configurable, and so is every other git subprocess `now` starts,
`git credential fill` included, since a locked keychain can block
before the push begins. A stalled remote or credential helper aborts the push,
releases the lock, keeps the local commit (rescanned before the next
push, as above), and exits non-zero. A writer waiting on the lock
therefore waits at most that long, not until the network recovers. So no
credential can become known between that check and the moment the
commit is published. A writer that arrives during the push waits a few
seconds. If the generation moved before the lock was taken, `now`
releases the lock, discards the staging tree, and starts over instead
of committing text redacted against a stale set. A credential first
learned after a push finishes was never known to any run, and is
the pattern scan's to catch or no one's.

Configuration is a source of secrets too (`env`, `headers`, URL
parameters, `writeOnly` properties), so it takes part in the same
protocol. The lock and the generation live inside the shared writers
in `state` (the config-file save, the credential-store save, and the
soul save that `PUT /agents/:id` and `stratus agent` use, since a
soul's `credentials:` list is a secret-set input too), not
in each caller. So every cooperative writer takes part without being
listed: `stratus setup`, `plugins`, `template add`, and the control
API's `PUT /v1/config`. A new writer can only bypass it by skipping
`state`, and the "Do not re-derive rules" convention already forbids
that.
A hand edit cannot take a lock. So under the lock, `now` also compares
a hash of every file-backed input to the secret set against the hash
it took at collection. That covers config files, souls, the plugin
manifests whose `credentials` it collected, `credentials.json`, and
`gateway-token`. Pasting a token straight into `credentials.json` is a
documented setup path for a Slack channel. It also covers the daemon's
recorded resolution context, and the backing
file of an accepted `store --file` git helper, and the source files of
the deploy key and the signing key. The run uses frozen copies of the
keys, but a source replaced mid-run is still new secret material the
commit was never scanned against. A change starts the run over, exactly like a generation
change. A hand edit during the few seconds of the push itself cannot
be locked out, because nothing makes an editor wait. So it is detected
immediately afterwards instead. Once the push returns, `now` re-hashes
every input the pre-push check hashed, the credential store and the
gateway token included. The push's own credential cannot drift the same
way, because it is frozen at collection. The HTTPS token `now` collected
reaches git through a one-shot helper that returns exactly that value.
The SSH key is read once into a private `0600` copy inside the backup
directory, and `-i` names that copy. The signing key is frozen the same
way, and the manifest is signed from its copy. A keychain that rotates mid-run,
or a deploy key edited in place, cannot put a credential on the wire
that the scan never saw. A signing key replaced mid-run cannot sign a
tip that fails verification. If any of them changed, it recollects the secret set from
all of them and rescans the commit it just published against it. A hit is reported at once and
loudly, naming the credential to rotate, because a pushed commit is
not taken back. This is the one place the design detects rather than
prevents, and the spec says so.

### Secrets: three layers, because one is not enough

1. **Files that are secrets never enter the staging tree** (the "Never"
   column above).
2. **Values that are secrets are replaced everywhere.** Keys leak into
   conversations and memory: an operator pastes one to debug a
   provider, and a tool echoes an environment dump. So excluding
   `credentials.json` does not keep its contents out of the backup.
   Before committing, every file is scanned for the exact values the home
   knows to be secret, and each one is replaced with
   `‹redacted:<which>›`. That is **every value a run could resolve as a
   credential**, not only what is stored:
   - everything in `credentials.json`: provider keys, OAuth tokens,
     channel tokens, and named credentials;
   - every provider key the environment could supply: the generic
     `STRATUS_API_KEY`, the variable an `apiKeyEnv` selection or
     `STRATUS_API_KEY_ENV` names, and each provider's own default
     variable. `resolveEnvApiKey` answers with only the variable that
     wins, while redaction needs every candidate, because the loser is
     still a live key (a fallback provider reads its own). So
     `@stratusagent/state` exports the candidate list that
     `resolveEnvApiKey` already walks, and both consume it, rather than
     the backup re-deriving the precedence chain.
   - every named credential the roster and the installed plugins declare
     (each soul's `credentials:` list and each manifest's `credentials`),
     resolved through the same `CredentialResolver` a tool call uses. That
     resolver falls back to the environment, so a name a soul declares
     and a shell exports is a secret here even though nothing stores it.
   - the token the backup's own git pushes with, whichever accepted
     helper holds it: a keychain helper or a `store --file`. `now` asks
     for it through git's own credential protocol (`git credential
     fill` against the remote, in the isolated configuration). So a
     keychain token is collected the same way as a file-backed one. A
     value `now` itself resolves is a credential like any other, and it
     is retired when it changes.
   - the private deploy key and the private signing key. The value set is
     each key file's whole contents plus its base64 body, meaning the
     key material without the PEM or OpenSSH wrapper, since a pasted key
     often loses its wrapper. Both go through the same encoded forms as
     every other value. A key replaced by `init --rotate-signing-key` or
     a new deploy key is retired.
   - the control API's bearer token: the contents of `gateway-token`,
     and `STRATUS_GATEWAY_TOKEN` when the environment sets it. Leaving
     the file out of the tree does not keep out a copy that someone pasted
     into a conversation. The token is random base64url, so no
     provider-key pattern would catch it. Deleting the file is how the
     token is rotated, and a run-to-run comparison would miss a token
     that lived only between two nights. So `ensureGatewayToken` records
     every token it generates in the retired list at the moment it
     publishes it, the same way the shared credential writer does for
     other credentials.

   The run has to see every value it is meant to redact, or the list is
   short exactly where it matters. The timer does not have the
   operator's shell. The service definition passes on `PATH` and little
   else, so a credential that exists only as an exported shell variable
   is invisible to the nightly run, however visible it was to a
   `stratus run` that echoed it into memory. So `enable` resolves every
   environment credential candidate twice. That means the declared
   names, and also the provider key variables (`STRATUS_API_KEY`
   included) and the credential-named `passEnv` variables. Each is
   resolved once in the operator's shell, and
   once in the environment the timer will have. It refuses when a name
   resolves in the first and not in the second, and names the credential
   and the fix: `stratus credential set <name>`, which puts it where
   every run can read it. A gap can also open after `enable`, when a
   variable is exported later for a single `stratus run`. The timer
   never sees that shell, so from `init` on (whether or not the timer is enabled), the runtime
   records the *name* (never the value) of any credential-classed
   variable it read from the environment alone, and a keyed
   fingerprint of the *value* it read (an HMAC under a local key that
   never leaves the machine). The record keeps **every** fingerprint
   seen for a name, not only the latest. Two one-off runs with values A
   and B leave both, because A may already be echoed into memory while B
   is the one still exported. That covers declared
   credentials resolved through the `CredentialResolver`, provider keys
   read through `resolveEnvApiKey` (`STRATUS_API_KEY`, the variable
   `STRATUS_API_KEY_ENV` names, and each provider's default), and also each
   credential-named variable a `passEnv` list copies straight from
   `process.env` in `tool-shell` or `plugin-mcp`. Both go through one
   shared recording helper that `state` exports, and the two plugins
   call it. The record goes in a `0600` file
   beside the clone. The next `now` resolves each recorded name and
   compares fingerprints. It fails before committing, with the same
   fix, when the name does not resolve. It also fails when the name
   resolves to a *different* value, which happens when the credential
   was rotated or mistyped before being stored. That is because the value
   that was used, and may have been echoed, is the one it cannot redact.
   Each fingerprint is checked on its own. A fingerprint is cleared when
   the matching value is in the credential store or on the retired list,
   since then it is redacted. It is also cleared by an explicit
   `stratus backup acknowledge <name>`, which clears every fingerprint
   for that name and is for an operator who has checked that nothing
   holds any of them. The block lifts only when no fingerprint for the
   name is left. A value it
   cannot see is a value it cannot redact, so it does not push past it.

   **A retired value stays in the set.** Rotating or removing a
   credential does not remove the old value from memories and
   transcripts that already hold it, and the next rebuild of the staging
   tree would copy it through unredacted. So from `init` on, the
   retiring happens inside the shared credential-store writer in
   `state`, the same place as the lock. Every save diffs the old store
   against the new one, whichever caller made it (`credential set`,
   `credential remove`, a provider sign-in, or a channel's transport
   secrets). Concretely, a value
   that `stratus credential set` overwrites or `credential
   remove` deletes is moved to a retired list rather than dropped. The
   list is `0600` beside the clone, with the same protection as the
   credential store, and is never committed. It serves only as
   redaction input. `stratus backup forget-retired` clears it once the
   operator has purged the content that held those values. Values from
   configuration retire the same way. `init` records the first secret
   set, from every source, as the baseline, so a value removed before
   the first `now` has something to be compared with. When `init`
   adopts a branch that already has history (a replacement machine, or
   a clone whose local state was lost), nothing records what that
   history was scanned against. So it runs the full plaintext-history
   scan, over blobs and paths, against the whole current secret set and
   the current scan policy before its first push. Each `now`
   compares its secret
   set with the previous run's, from every source: config `env`,
   `headers`, URL parameters, `writeOnly` properties, and stored
   credentials. Any value that has dropped out goes onto the retired
   list. So a header rotated by editing `config.json` stays redacted
   just like a credential rotated through `credential set`. A value
   that lives in config only between two runs is still seen, by the
   runtime rather than by `now`. When a run consumes a credential from
   any source, it adds the value to the retired list, the same `0600`
   list that is never committed. That covers a config-derived credential
   (a header sent, an `env` entry passed, a URL used) and a value read
   from `credentials.json` through the `CredentialResolver` or a
   provider sign-in. It also covers a gateway token presented to the
   API. A header added for an afternoon and removed before nightfall is
   therefore still redacted. So is a token pasted into
   `credentials.json` by hand, used once, and deleted by hand. Tracking
   follows the configured target, not the timer: `disable` stops the
   nightly run but not the retiring, and tracking ends only when the
   target itself is removed. A value rotated *before* `init` is
   something no run ever saw. The first `now` therefore says that
   plainly, and names the one tool that covers it: the pattern scan.

   Values that live in configuration rather than in a credential store
   join the same set, and **the entry's name decides, not the field it
   sits in**. An `env`, `headers`, or `passEnv` entry carries a
   credential as often as a setting. `NODE_ENV=production` and
   `Content-Type: application/json` are ordinary. Redacting them would
   fail the short-value floor or break the restored config.
   `Authorization` and `GITHUB_TOKEN` are not ordinary. So at any depth
   of the trusted config, and including each `plugin-mcp` server inside
   an opaque `servers` object no manifest annotation reaches, an entry
   under `env` or `headers` joins the set when its name marks it as a
   credential: `Authorization`, `Cookie`, `Proxy-Authorization`, or a
   name with `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`,
   or `AUTHENTICATION` as a whole component, splitting on `_`, `-`, and case changes. So
   `GITHUB_TOKEN`, `apiKey`, and `X-Api-Key` match, and `MONKEY` and
   `KEYBOARD_LAYOUT` do not. Conventional fused spellings count too,
   because nobody splits them: a component equal to `APIKEY`,
   `ACCESSKEY`, `SECRETKEY`, `PRIVATEKEY`, `AUTHTOKEN`, `ACCESSTOKEN`,
   `CLIENTSECRET`, or `PASSWD` matches, so `X-APIKEY` does. A list of
   fused names never ends, so a component that *ends* in `PASSWORD`,
   `PASSWD`, `TOKEN`, or `SECRET` also matches: `PGPASSWORD`,
   `GHTOKEN`, `DBSECRET`. The suffix rule deliberately leaves out `KEY`,
   because `MONKEY` and `TURKEY` are what it would catch. Fused `KEY`
   names stay on the explicit list. A structured value is split into the parts
   a tool would actually repeat. An `Authorization` or
   `Proxy-Authorization` header contributes
   its token after the scheme (`Bearer`, `Token`, and so on). For
   `Basic` it also contributes the decoded `user:password` and each
   half of it, because an API key is as often sent as the username with
   an empty password. Empty parts are dropped before the length floor
   applies, so `key:` contributes `key` and `key:` and nothing empty.
   A `Cookie` contributes each
   cookie's value. The whole header value is added as well. The same holds for each variable a `passEnv` list
   names, and a `passEnv` value is checked by *content* as well as by
   name. A value that parses as a URL goes through the URL rule below
   whatever its variable is called, so `DATABASE_URL`'s password
   joins the set. The late-use record fingerprints it the same way. So does any property a manifest marks `writeOnly` (below).
   **So does a credential carried in a URL.** An HTTP MCP server can
   authenticate as `https://host/mcp?access_token=…`, and the plugin
   passes the URL to the transport as it is. Every URL-valued string in
   the trusted config is parsed. Its userinfo, and any query parameter
   whose name marks it as a credential by the same rule (`token`, `key`,
   `secret`, `password`, `sig`, `access_token`, and so on), join the set.
   Inside `config.json`, those entries are replaced and listed for
   re-entry on restore, like any credential. Ordinary entries are copied
   verbatim. A tool can echo a secret entry into a session or a memory,
   where it is no different from a stored key, which is why it joins the
   global set rather than being redacted in `config.json` alone. The
   name list will miss a credential kept under an innocent name. That is
   a known gap the pattern scan partly covers, and `writeOnly` is the
   way to close it for good.

   **A secret too short to replace safely stops the run.** Named
   credentials accept any non-blank value, and replacing every occurrence
   of `a` or `test` across a home would corrupt the snapshot beyond use.
   A value below a floor (on the order of 12 characters) fails the run
   and names the credential, instead of silently rewriting common text or
   silently skipping a secret. **Not every stored value is a secret,
   either.** A Codex sign-in stores the marker `chatgpt` as its
   `oauth_token`. The real tokens live in Codex's own store, and the
   marker is never sent anywhere. Collecting it would fail every Codex
   user's backup on the floor and rewrite the word everywhere. So
   `state` exports the rule for which stored credentials hold a secret,
   next to the comment that already says so, and the backup asks that
   rule instead of listing providers itself.

   **Replacement works on values, not on bytes.** A credential can hold
   a quote, a backslash, or a newline, and once it is inside a JSONL line
   or a session row (a JSON body inside a table exported as JSON) it is
   stored escaped, once or twice, and a byte-level search for the raw
   value misses it. So every record is decoded before it is staged:
   JSONL lines and database rows are parsed, embedded JSON strings are
   parsed in turn, and replacement runs on each string value before the
   record is serialized again. The byte-level scan still runs afterwards,
   for the raw value and its JSON-escaped forms, as a backstop over
   everything the decoder did not cover, such as souls and skills.
   Exact-match replacement is deterministic, needs no model, and cannot
   miss a key it knows about. It cannot know about a key nothing
   declares, which is what the next layer is for.
3. **Anything that still looks like a secret stops the push.** A pattern
   scan for the shapes of well-known keys runs over the staged tree.
   **Pathnames are content too.** Git records every filename in its
   trees, and a command that writes `$TOKEN.log` into a workspace puts a
   secret in a path. So the exact-value check and the pattern scan both
   run over every staged relative path as well as over file contents. A
   hit in a path fails the run and names the file, because renaming it
   would restore a file under a name nothing expects. A
   hit fails the run with the file and line and commits nothing. A false
   positive costs one night and an allowlist entry. A true positive
   pushed would cost rotating a key and rewriting a repository's history.

`config.json` needs one more rule. A plugin's config block can hold
secret-ish values (`provider-openai`'s `headers` and `tool-shell`'s `env`)
that live in no credential store. Those keys are redacted by name. The
general answer is for a plugin manifest's `config` schema to mark a
property `writeOnly`, which JSON Schema already defines. Then the rule
lives with the package that knows, not in a list here. A block whose
manifest cannot be read has no schema to consult. That happens with a
disabled plugin left in the config after its package was removed,
which the config accepts and the loader skips. Every plugin-owned leaf
value in such a block is then treated as a credential. The host-owned
structural fields, `enabled` and `agents`, keep their types, because a
restored config must still parse. Each plugin-owned value is
redacted, added to the secret set, and listed for re-entry on restore. `status` names the
block and says to reinstall the package or delete the block. A block
nobody can inspect is never copied through as if it were known to be
harmless.

The manifest committed with each snapshot records what was left out and
what was redacted, so a snapshot is never mistaken for a complete copy.

### Configuration is trusted-only

The `backup` block (remote, what to include, schedule) is read **only from
the trusted config**, like `api` and `approvals`. A cloned repository's
auto-discovered `stratus.config.json` must not be able to point your
backups at its own remote. That would turn this feature into a way to
exfiltrate your fleet.

**The remote carries no credential.** `init` refuses a URL with userinfo
(`https://user:token@host/…`), and `now` refuses to run if a hand-edited
config has one. That config is committed with every snapshot, and a
password in a URL is neither a value the credential store knows nor
reliably key-shaped, so neither redaction layer is guaranteed to catch
it.

### Authentication

The package holds no credential of its own. It pushes with whatever git
already uses. The recommended setup is a **deploy key with write access
to the one backup repository**, so a stolen key reaches that repository
and nothing else. A personal access token in a credential helper works,
but it usually reaches every repository its owner has. So its storage
has to be as far from agents as the deploy key is. `init` accepts the
OS keychain helpers (`osxkeychain`, `libsecret`, `manager`), which no
file read reaches. It also accepts a `store --file` whose file is
inside `~/.stratus/backup/`. It refuses any other file-backed helper,
such as the default `~/.git-credentials` or a `--file` elsewhere,
and names the fix, because a token in a plain file is one `fs.read`
away from an agent whose root covers it.

Enumerating credential sources one at a time never ends. A token can
also arrive through `http.extraHeader`, an `includeIf`, or a URL
rewrite, and each lives in some config file. So the backup's git reads
**no configuration but the clone's own**. Every git call runs with
`GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, in an
environment built from scratch rather than inherited. Every other
`GIT_*` variable is dropped: `GIT_CONFIG_COUNT` with its
`GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`, `GIT_CONFIG_PARAMETERS`,
`GIT_SSH_COMMAND`, `GIT_ASKPASS`, and the rest. Those inject
configuration per command, and they would bypass both variables above.
The clone's
config lives inside the protected backup directory, and `init` writes
into it everything the run needs: the pinned `core.sshCommand`, the
helper, and the signing key it read from the operator's own config
once. Whatever authenticates the push is then named in a file no agent
can read. A credential the operator's global config would have
supplied is simply absent, and the unattended probe says so.

That isolation is for the commands that run unattended beside agents:
`init`, `enable`, and `now`. Restore is the other case. It runs on a
replacement machine with no home yet, no protected clone, and no agent
running, and the operator is at the keyboard. So a remote restore
fetches with the operator's own git configuration. For a dedicated
deploy key it also takes `--ssh-key <file>`, pinned the same way
(`IdentitiesOnly=yes -F /dev/null`). A restore from a local path needs
neither.

**Whatever it is, it has to work with nobody there.** An SSH agent
socket, a passphrase prompt, or an interactive credential helper
authenticates `init` from the operator's shell and then fails every
night. `init` and `enable` therefore run a real probe, `git push
--dry-run` to the remote, from the timer's own environment with
`GIT_TERMINAL_PROMPT=0` and SSH in batch mode. They refuse a setup that
only works interactively. The deploy-key setup pins its key in the
clone's own `core.sshCommand` so that it does not depend on an agent.
The pin is exact: `-i <key> -o IdentitiesOnly=yes -F /dev/null`. So no
default identity and no `IdentityFile` from the user's SSH config can
authenticate in its place, and the key the protected set records is
the only key that can. An SSH remote without that pin is refused.

### A backup that faithfully saves the damage

A nightly job will back up a wiped memory file as faithfully as a good
one, and the next night that is the only copy at the tip. Git history is
the defence, so the feature never force-pushes, never prunes, and never
rewrites. On top of that:

- **Shrinkage warns loudly.** If memory lines, sessions, or souls drop by
  half or more since the last snapshot, `now` still commits (the
  history holds the good copy either way) but exits non-zero and says what
  shrank. That puts the problem in front of someone while the good copy
  is one day back rather than ninety.
- **A failed push keeps the local commit** and exits non-zero. The next
  run rescans every unpushed commit against the **current** secret set
  before pushing anything. A secret learned since, such as a credential
  added after the failed run, would otherwise go out in the older
  commit. If the rescan hits, the unpushed commits are dropped and
  rebuilt from the current tree. They were never published, so this
  rewrites nothing anyone else has. Ciphertext cannot be rescanned,
  because `now` holds only the age recipient and never the identity. So
  each unpushed commit also records a keyed fingerprint of the secret
  set it was redacted against, together with the version of the
  redaction and scan policy: patterns, encoded forms, and name rules.
  If either has changed since, because a credential was added or an
  upgrade taught the scanner a new shape, every
  unpushed commit that holds ciphertext is dropped and rebuilt without
  inspection.
- **Published history is rescanned when the secret set or the scan
  policy grows.** A value
  can be committed in plaintext before anyone knows it is a secret:
  pasted into a memory first, stored as a credential a week later.
  Redaction only covers snapshots from then on, and published history
  is never rewritten. So whenever the secret set gains a value, `now`
  scans everything already pushed in plaintext for it. That covers
  every blob, and every path in every pushed tree, because a filename
  carries a secret as well as a file does. An upgrade that
  teaches the scanner a new shape triggers the same scan of every
  pushed blob and path against the new rule, because the value it now
  recognizes may be gone from the live home. A hit fails the
  run and names the credential to rotate, since rotation is the only
  remedy for a published secret.
- **A partial snapshot is a failure.** If one database could not be read,
  the run exits non-zero, so the timer never reports a half backup as
  success.
- **`stratus backup status`** shows the last success, the last push, and
  the last warning. With the package configured, `stratus doctor` warns
  when the last success is more than a few days old.

### Restore

`stratus backup restore <remote|path> --into <dir> --verify-key <file> [--identity <file>]`
refuses any directory that is not empty. When the snapshot holds
ciphertext, the age identity comes from `--identity`, or from
`STRATUS_BACKUP_IDENTITY` naming a file. It is never taken from the
repository and never stored by restore. With no identity, or the wrong
one, restore stops before writing anything and says which. A restore
that silently left out the encrypted half would look complete and not
be. **It reads the snapshot from git's objects, never from a checkout.**
A clone or checkout on the replacement machine runs whatever smudge
filter or line-ending rule a committed `.gitattributes` names and that
machine has installed. The bytes it wrote would then differ from the
signed manifest, and a valid snapshot would fail to restore. Every blob
is read with `git cat-file` and verified against the manifest before it
is written. It rebuilds each database from its JSONL, rebuilds `memory.jsonl.index` on first use (which already happens),
and prints the list of credentials to re-enter.

**A snapshot is verified before it is trusted.** Every check above
keeps a hostile repository from writing *outside* `<dir>`. None of them
stops it from writing a runnable home *inside* it: a changed soul, an
edited skill script, a new schedule with the grant that lets it run
unattended. Git's hashes do not help, because anyone who can push can
make a new commit. So each snapshot's manifest lists every file's
path, a hash of its content, and its normalized mode (executable or
not), **plus the hash of the previous snapshot's signed manifest and a
sequence number**. A signature on content alone does not say *when*.
Someone with push access could append a commit that carries an older,
validly signed snapshot, and bring back grants and schedules that were
revoked since. Restore walks the chain from the tip, and refuses a
snapshot whose signed predecessor is not the manifest of its parent
commit. It prints the sequence number and signing time of what it is
about to restore.

**The chain has a root.** A remote that already has history, such as a
GitHub repository created with a README, would give the first signed
snapshot an unsigned parent, and the walk would refuse it forever. So
`init` never builds on existing history. It writes to a dedicated
branch, `stratus-backup` by default. If that branch does not exist, the
first snapshot is an orphan commit whose manifest declares itself
the root, at sequence 0. If the branch exists and its tip is not a
signed snapshot, `init` refuses and names it. Restore stops its walk at
the declared root and never needs to read further back.

A chain proves order, not freshness. Someone who can force-push can
move the branch back to an older tip that is authentic and correctly
chained. Nothing inside the repository can tell that apart from the
real latest backup, so the anchor has to come from outside it:
- **The remote refuses rewrites.** `init` checks whether the branch is
  protected against force-pushes and deletion. On GitHub it offers to
  set that protection with the operator's own credentials; the deploy
  key has no such right. `status` warns while the protection is absent.
- **`now` builds only on its own tip.** Each run records the last
  sequence number and commit it pushed, beside the clone. A remote tip
  older than that is a rewind, and stops the run with a warning. A
  remote tip that has moved *forward* stops it too. A backup has one
  writer, and snapshots replace rather than merge, so a foreign tip is
  never adopted automatically: two machines alternating on one branch
  would leave the latest tip showing whichever ran last. Taking over is
  a deliberate `now --takeover`. The takeover verifies every new commit
  first, meaning a valid signature from the configured key, a link to
  its parent's manifest, and the next sequence number. It refuses an
  unsigned or mis-chained commit, because building on one would leave
  every later tip unrestorable once the restore walk reached it.
  A tip that is exactly this writer's own retained commit is not
  foreign. That happens when a push landed but the connection dropped
  before git reported success. The run recognizes the commit by its
  hash, records it as pushed, and carries on.
- **Restore always asks for a checkpoint.** A replacement machine does
  not have the sequence number `now` recorded, and yesterday's tip is
  as dangerous as last month's when a grant was revoked this morning.
  So restore shows the tip's sequence number and signing time, and
  every restore requires either `--expect-after <date>` /
  `--expect-sequence <n>` or an interactive confirmation of those two
  values. The operator's own knowledge, such as "my last backup was
  last night", is the external checkpoint. Only the age of the tip
  changes the wording of the prompt. It never decides whether the
  prompt is shown.

`now` signs the manifest with a key held outside the
repository: an SSH signing key, the same kind git itself signs with.
`init` asks for it, defaulting to git's own `user.signingkey` when that
is an SSH key, and refuses to set up a target without one. **The key has
to work unattended.** The timer runs with no terminal and, as the
service definition stands, no SSH agent socket. A passphrase-protected
key, or one that lives only in an interactive agent, would sign in
`init` and fail every night after. So `init` makes a test signature
the way the timer will, from a clean environment with only what
`enable` will pass on. It refuses a key that cannot sign there, and
suggests a dedicated passphrase-less key kept `0600` beside the clone.
That key's only power is to sign backups.
Restore verifies that signature before writing anything, and refuses a
snapshot it cannot verify. **The key it verifies against never comes
from the repository**, because someone who can replace the snapshot
can replace a key stored beside it. Nor does it come from the signature
itself, which names whatever key made it. It comes from
`--verify-key <file>` (a public key or an `allowed_signers` file) or
from `STRATUS_BACKUP_VERIFY_KEY`. `init` prints the public key and says
to keep it with the age identity. For an operator who signs git commits
with the same SSH key, there is also a source that survives losing the
machine entirely: the key already published on their GitHub account.

**The signing key has to survive the machine too**, or backups cannot
resume after the restore they exist for. A dedicated key lives in
`~/.stratus/backup/`, which no snapshot contains. So `init` says to
keep its *private* half with the age identity, in the same offline
place. When it is lost anyway, `init --rotate-signing-key` on the
restored machine starts a new chain. The first manifest under the new
key records the last sequence number and manifest hash of the old
chain, and its signature says it starts a new chain. Restore accepts
that step only when `--verify-key` names both keys, and it verifies
the earlier history with the old public key. Rotation never needs the
lost private key. It needs only the operator's deliberate choice, and
that choice is what the restore checkpoint already asks for.
`--unverified` exists for an operator who has lost the signing key and
accepts the risk. It restores, but leaves out every schedule and the
**whole** `whitelist.json` of every agent: command scopes and approved
origins as well as standing tool grants, since all three let a later
call skip its prompt. A schedule has no paused state: an empty next-fire
time is how a spent one-shot looks, and nothing resumes it. So the
schedules are written as a readable list in the restored directory
(agent, cadence, prompt, destination) for the operator to re-create
deliberately. **Plugin configuration is left switched off too.** A
restored `plugins` block can start code without any schedule or grant:
an MCP server's stdio command runs as soon as the daemon loads the
plugin. So every plugin entry is restored with `enabled: false`, and
its original block is kept in the same readable list for review. Every
selection that names a plugin's contribution (the `memoryStore`, the
`executor`, a plugin-contributed provider) is reset to the built-in
default and listed with its original value. Otherwise the daemon would
refuse to start on a selection nothing registers. A `memory-sqlite`
home restored this way starts on the file store, with its database
restored and waiting. Once the operator has reviewed and re-enabled
the plugin, the original selection points at it again.
**Parked turns do not resume.** With `sessions` restored, a session
parked at `pending_approval` carries queued tool calls. On startup, the
gateway's recovery denies the stale checkpoint and then runs the rest
of the queue, including safe tools that need no grant. So an
unverified restore marks every such session failed and drops its
pending checkpoint and queue, and it lists each one it changed.
Together these are every way restored state acts on its own. The
printout says what it dropped or disabled.

**The packages the home ran on come first.** Rebuilding a store needs
the package that owns its schema, and serving the restored config needs
every plugin it enables. On a fresh machine with only the CLI and this
package, `memory-sqlite` or any other optional plugin may simply be
absent. So the manifest records each enabled plugin package, the
selected memory store, and every companion package the config turns on
(`control-api` for an enabled `api` block, `dashboard`, and
`channel-slack` for a configured Slack channel), each with its version.
Companions never appear in a `plugins` block. Without that record, a
daemon would start with only a warning, missing a surface its config
asks for. Restore checks them first.
If one is missing or incompatible, restore writes nothing and prints
the install command, instead of producing a home the daemon will refuse
to start. In `--unverified` mode, where every plugin comes back
disabled, restore requires only the packages the rewritten home
actually needs: those that own a store to rebuild, such as
`memory-sqlite`, and the companions its config still turns on. A
missing MCP plugin that will restore disabled blocks nothing.
The same preflight covers Stratus itself. The manifest records the
`state.json` schema version and the CLI version that wrote it. If that
schema is newer than the `STATE_SCHEMA_VERSION` the restoring build
exports, restore writes nothing and prints the upgrade command. It
uses the same message `assertStateCompatible` gives, rather than
building a home that startup would refuse on first contact.

**The repository's SQL is never executed.** Each database is created
from the schema the owning store ships for the snapshot's recorded
schema version (the same statements a fresh home runs), and rows are
inserted with bound parameters only. A table or column the known
schema does not have is refused rather than created, because an
identifier cannot be a bound parameter. The snapshot's `schema.sql` exists
for a person reading the repository and for a check that it matches.
Executing it would hand the repository `ATTACH` and `VACUUM INTO`, which
are file writes anywhere, and it would bypass everything below.

**No write passes through a link.** A git tree can carry symlinks, and a
modified repository could make `agents/` or `external/` one, so that the
next file restored beneath it lands outside `<dir>`. Restore refuses a
snapshot containing any symlink entry, and it walks every target path
with `lstat` so that no component it follows is a link. This is the
[state layout](../reference/state-layout.md)'s rule that no path Stratus
derives passes through a link, applied to the one command that builds a
home from somebody else's input.

**No path climbs out.** Every *destination* path the snapshot names is
checked as a string before any filesystem access at all. That means
every path restore will write to or address a git object by, whether
it comes from the tree, the manifest, or the decrypted index. Source
paths are a different field. The original location of an external
resource, and the absolute paths a provenance ledger is keyed by, are
absolute on purpose. They are never used to write. Restore only maps
them through the old-to-new table. Where the result names a file
restore creates, it is a destination under `<dir>` and checked like
one. Otherwise it is only text written into a restored file, such as
a ledger record for a file on the operator's own disk. A destination path
must be relative and already normalized: no leading `/`, no empty, `.`, or `..` component, and no
NUL. Anything else refuses the whole restore. A backslash is an
ordinary character in a POSIX filename, so it is allowed where restore
runs on POSIX, which is every platform the service supports. On a
platform where a backslash is a separator, a name containing one is
refused like `..`. None of
these forms can occur as a real filename, so an honest `now` never
produces a snapshot this check refuses. Without
this check, a modified repository restored with `--unverified` could name
`../../victim`, and the staging build would write outside both `<dir>`
and the staging directory before promotion ever ran. The `lstat` walk
cannot catch that, because it only proves that no component is a link.

**Modes are set, not inherited.** Git keeps no distinction between
`0600` and `0644`, and a restore under an ordinary `022` umask would
leave decrypted sessions, memory, and grants readable by other local
users. The restored `state.json` also says the permission migration has
already run, so startup will not fix it. Restore therefore creates every
directory the state layout makes `0700` as `0700`, and every file it
makes `0600` as `0600`. That includes `config.json`, the per-agent
stores, `whitelist.json`, `memory.jsonl`, and everything under a
workspace. The one bit kept from the source is execute. A skill's
`scripts/` or a workspace's tooling has to run after recovery, so the
snapshot records which files were executable (the git mode for
plaintext, the encrypted file's metadata for ciphertext). Those files
are restored `0700`, still owner-only. The bit restore applies is the
one in the signed manifest, and a git mode that disagrees with it fails
verification. Otherwise a commit that only flips a mode would pass a
content-only signature.

**No two paths may land on one file.** A snapshot taken on a
case-sensitive filesystem can hold `skills/Foo/` and `skills/foo/`, and
a default macOS volume reads those as one directory. So can two
spellings of one accented name under Unicode normalization. Restore
folds every path it is about to write by the target filesystem's rules
(case and normalization, the same equivalence the state layout already
applies to agent ids). It refuses a collision before writing anything,
rather than letting the second write replace the first.

**Nothing is promoted until everything verifies.** Restore works in
two phases. First it reads, decrypts, and verifies every blob, mode,
directory, and database record against the signed manifest, building
the home in a staging directory that restore creates itself. That
directory sits beside `<dir>`, on the same filesystem, with a random
name, created exclusively, and it carries a marker saying whose it is.
Only when all of it has verified is it promoted, with a **single
rename** onto `<dir>`, which must be empty or absent. Before the
rename, every staged file and directory is `fsync`ed. After it, the
parent directory is `fsync`ed too, because a rename alone does not
make the data it points at durable. A crash at any point, power loss
included, therefore leaves either the old empty `<dir>` or the
complete home, never a half-promoted mix or a complete-looking home
with truncated files. A rerun recognizes an abandoned
staging directory by its marker and removes it before starting. No
check comes after the first file lands where the operator will look.

**Provenance follows the files.** Each workspace's
`fs-provenance.jsonl` ledger is keyed by absolute path, so a restored
workspace under a new home, or relocated under `external/`, would find
no labels for its own files. Content that came from outside would then
read back as the agent's own, which is the one thing
[30](./30-provenance.md) exists to prevent. Restore rewrites every
ledger record through the same old-to-new mapping it applies to the
config. The ledger is backed up **by default, not only with
`workspaces`**, because it also labels files outside any workspace:
under `tool-fs` roots, which are the operator's own directories and
are deliberately not copied. Those files usually survive the lost
machine on their own mount, and without the ledger they would come
back unlabelled. **No ledger record is ever plaintext.** Every path in
it was chosen by an agent's write, whether inside a workspace or under
a `tool-fs` root, so it is arbitrary tool output, like a workspace
filename. The exact-value and pattern scans cannot catch a secret an
agent transformed. With an age recipient configured, a record travels
encrypted: in its workspace's index when that workspace is backed up,
and otherwise in an encrypted ledger unit. Without a recipient, a
record is omitted only when its file does not come back either: a file
inside the home that the snapshot leaves out. A record whose file
survives makes `now` refuse to run and name the fix,
`init --recipient`. A file survives when it lies outside the home, or
when the snapshot itself carries it, such as a tainted file an old
`tool-fs` root once wrote under `skills/`. Records are never
redacted: a ledger is looked up by exact path, so a rewritten path
would silently strip the label from the real file.

The ledger is **read last**, after every workspace file has been
copied. `fs.write` records a label before it writes the bytes, so a
file the traversal copied already has its label in the ledger by the
time the ledger is read. A tainted write that overlaps the run can
never land in the snapshot without its record. On restore, a record whose root the restored config still
references is written back unchanged. A record for a relocated root is
mapped. Only a record whose root the restored config no longer
references is kept aside and listed. When in doubt the label errs
toward `external`, never toward trusted.

**Every write lands inside `<dir>` or its own staging directory.** An external soul and a `memory-sqlite`
database are restored under `<dir>/external/`, and the
restored config is rewritten to point at them there, with each rewrite
printed beside the path it replaced. A configured `workspaceRoot` is
restored the same way, under `<dir>/external/`, with the plugin's
setting rewritten, and a root nested in another stays nested. A seam
workspace needs no setting. It is restored where the host resolves it,
at `agents/<id>/workspace/`, as a real directory. A path recorded in the manifest is
information for the operator, never a place restore writes to: the
repository is input that someone other than the operator may have
changed, and following its paths would let a modified backup create
files anywhere the operator can write. Putting a file back at its
original location, or pointing `--config` at the restored config, is the
operator's move. The one exception is a project-local
`stratus.config.json`. Passing it through `--config` would make it
trusted, and blocks the original daemon ignored as untrusted would take
effect. So restore never suggests `--config` for it. It restores the
file as `stratus.config.json` inside a directory of its own under
`external/`, and says to start the daemon from that directory, where
auto-discovery leaves it untrusted as it was. The rest is the operator's move, the same as moving the directory into place with the
daemon stopped. Restoring is
deliberately not an in-place operation: it winds approvals, grants, and
schedules back to last night, and that is a decision to make with the
daemon off.

A backup repository's layout is close to a [16](./16-templates.md)
template (`config.json`, `agents/*.md`, `skills/`), but restore is not
`template add`. A template merges into a live home and carries no state.
A restore replaces a home and carries all of it.

## Other targets, and why git is first

Git is first because most operators already have somewhere private to put
a repository. The history is the retention policy, souls and memory diff
readably, and "what did my agent believe last Tuesday" is a `git log`. Its
weaknesses are real, and the design keeps a second target possible rather
than building one now:

| Option | What it is good at | Where it falls short here |
| --- | --- | --- |
| **restic** | Encrypted by default (AES-256 plus Poly1305), content-addressed deduplication, many backends (S3, B2, SFTP, a local disk, and more through rclone), and retention (`forget --keep-daily 7 --keep-weekly 4`). `--password-file` or `--password-command` keeps the key out of the config. | A binary repository, so there is no browsing a soul's history on GitHub. The operator installs and keys it. |
| **Borg** (with borgmatic) | The same shape as restic: encrypted, deduplicated, and pruned, with a mature scheduler wrapper. | Wants SSH to a host that runs Borg, so it has fewer cloud backends than restic. |
| **Kopia** | restic's model plus a UI and built-in scheduling policies. | Another daemon to run beside ours. |
| **rclone** (with a `crypt` remote) | Syncs a staged tree to almost any storage, with filename and content encryption. | A sync, not a history: without `--backup-dir` a bad night overwrites a good one. |
| **Litestream** | Continuous WAL streaming of SQLite to object storage, with a recovery point in seconds rather than a day. | SQLite only, so souls, skills, and memory JSONL need a second path. Its built-in encryption was removed, so it relies on bucket-side encryption. |
| **`sqlite3_rsync`** | Page-level deltas of a live database over SSH. | The same SQLite-only scope, and it needs a host on the other end. |
| **age, git-crypt, or transcrypt on the git target** | Makes the git target safe for sessions: each file is encrypted before it is committed, and the repository holds ciphertext. | Ciphertext does not diff, so it gives up git's main advantage for exactly the files encrypted. A lost key is a lost backup. |
| **Filesystem snapshots** (Time Machine, ZFS, Btrfs) | Already running on many machines, and they cover `~/.stratus` for free. | They copy live WAL databases byte for byte, which can be torn (the reason `now` uses `VACUUM INTO`), and they usually stay on the same site. |

Two things follow for the design:

- **The staging tree is the seam.** Building a redacted, consistent tree
  is the hard part and is target-independent. A git target commits it. A
  restic target would be `restic backup <staging tree>`, where a VACUUMed
  database file is fine as is, because restic deduplicates chunks and does
  not need JSONL to be efficient. Keep the tree builder separate from the
  target so the second target is a small addition, not a fork.
- **Encryption is the answer for sessions, not a private repository.** A
  private repository is one visibility toggle or one leaked token away
  from public, and secret scanning on push is a paid feature for private
  GitHub repositories, so it is not a backstop. That is why the git
  target encrypts `sessions` and `workspaces` with age, per file. An
  operator who wants transcripts with deduplication and retention rather
  than git history is better served by restic, whose whole repository is
  encrypted.

## Acceptance criteria

- With the package installed and `backup` unset, nothing runs and nothing
  is written. `stratus backup now` says how to enable it.
- `init`, then `now`, against a fresh private repository pushes souls,
  skills, redacted config, memory, grants, and schedules. A second `now`
  with no changes makes no commit.
- A key present in `credentials.json` and pasted into a memory entry and a
  session appears nowhere in the pushed tree, including git history. The
  test seeds the value and greps the clone. The same holds for a value
  held only in `STRATUS_API_KEY`, and for one held only in an environment
  variable a soul's `credentials:` list names, neither shaped like a
  known key.
- With `memory-sqlite` selected, a restore brings back its memories. With
  a third-party memory store that has no export, `now` fails and names it.
- A daemon whose working directory has a project `stratus.config.json`
  that omits `plugins` backs up the global `config.json` too, and the
  restored home runs with the plugins the daemon had. The restored
  project file is never offered as `--config`, and a trusted-only block
  in it stays ignored.
- An agent whose soul was deleted but whose `agents/<id>/` remains is
  still backed up, memories and workspace included.
- A config-only `soul` outside `agents/` is in the snapshot. Restore puts
  it under `<dir>/external/` and rewrites the restored config to match.
- With `workspaces` opted in, every root `workspaceResolver` gives an
  enabled plugin is backed up. A daemon whose `tool-shell` has a
  `workspaceRoot` while `plugin-mcp` uses the seam backs up both, and
  restore rewrites the shell setting. When one root is nested in the
  other, the nested files are stored once and stay shared. With every
  enabled plugin relocated, `agents/<id>/workspace/` is still backed
  up. Disabling a plugin whose root is `/data/shell` still backs up
  `/data/shell/<id>`. When
  `agents/<id>/workspace` is a link to another volume, the files on the
  far side are backed up and restore a real directory.
- A channel token replaced through a provider or channel sign-in
  between two runs stays redacted afterwards. So does the token from a
  `Proxy-Authorization: Bearer …` header.
- A workspace file named `research-journal` is backed up.
- A config credential removed after `init` but before the first `now`
  is still redacted.
- A credential containing a quote, a backslash, and a newline, pasted
  into memory and a session, appears in the pushed tree in no form, raw
  or escaped.
- A repository whose `schema.sql` carries an `ATTACH` or `VACUUM INTO`
  is refused, because the schema does not match the one the store
  ships. Nothing in it is executed, and nothing is written anywhere.
- A repository in which `agents/` or `external/` is a symlink is refused
  before anything is written.
- A file in a workspace whose name contains a credential value fails the
  run before anything is committed.
- On the git target, `sessions` and `workspaces` are committed only as
  ciphertext, and `init` refuses either without a key. A known credential
  written base64-encoded into memory is replaced.
- A credential added after a failed push is absent from every commit the
  next run pushes, including the retained one.
- A home with a pending layout migration fails `now` and names the fix.
- A soul in `agents/` that is a symlink is backed up as a regular file and
  restores with the same agent id.
- A skill with a relative link between its own files backs up and
  restores (as a plain file). A skill link that reaches outside the skill
  fails the run.
- A skill installed from a repository (with `.git`), a workspace holding
  a `.gitignore`, and a skill whose `.gitattributes` names an LFS filter
  are all restored byte for byte.
- Two runs with `sessions` enabled and nothing changed make one commit,
  not two. After the age recipient changes, the next run re-encrypts
  every opted-in file for the new key.
- With `~/.stratus` at `0755`, another local user can read nothing
  under `~/.stratus/backup/`, including after a run over a clone
  someone loosened.
- A pasted gateway token is redacted, whether it is current, rotated
  once, or rotated twice between two nights.
- A workspace file named `notes\draft` backs up and restores.
- `restore --unverified` of a repository whose index names
  `../outside` as a destination refuses before writing anything. A
  snapshot with an external soul and provenance records, whose source
  paths are absolute, restores.
- Under a `022` umask, a restored home has the same `0700` and `0600`
  modes a fresh one has, and a skill script that was executable still is.
- A value in a `plugin-mcp` server's `env` or `headers`, echoed into
  memory, is not in the pushed tree.
- With `workspaces` enabled on the git target, no workspace filename
  appears in the pushed tree.
- A restore of a snapshot with encrypted content refuses before writing
  anything when no identity is given, and again when the wrong one is.
- A snapshot with one soul edited after signing is refused before
  anything is written. So is one whose last blob fails verification,
  and `<dir>` is empty afterwards. So is a snapshot validly signed by a different
  key than `--verify-key` names, and restore with no verify key at
  all. With `--unverified`, it restores with no schedules and no
  standing grants, and lists the schedules for re-creation.
- An `--unverified` restore of a config with an MCP server enabled
  restores it disabled, and the daemon starts no server process. An
  `--unverified` restore of a `memory-sqlite` home starts, on the
  built-in store, with the original selection listed.
- An MCP header named `X-Auth` is treated as a credential.
- An `--unverified` restore brings back no command scope, origin, or
  tool grant, and a session parked at `pending_approval` comes back
  failed, with nothing queued, so the first `stratus serve` runs no
  restored tool call. It succeeds on a machine lacking a plugin that it
  restores disabled anyway.
- With `workspaces` off, no provenance record for a file inside any
  agent workspace appears in plaintext in the repository.
- A tainted file under `skills/` with no recipient configured makes
  `now` refuse, even after the `tool-fs` root that wrote it is gone.
- With a `tool-fs` root outside the home and no recipient, `now`
  refuses. With a recipient, no ledger path appears in plaintext.
- A workspace directory swapped for a link between descent and the
  post-read recheck fails the run, and no byte from the far side is
  committed.
- Two workspaces sharing one hard-linked `fs-provenance.jsonl` restore
  still sharing it, and every label survives.
- A deploy key file replaced during the push triggers the post-push
  rescan against the new key.
- A keychain helper that blocks on a locked keychain times out, releases
  the lock, and does not stop the next night's run.
- A schedule that fires while `now` snapshots, with `sessions` on,
  restores either not yet fired or fired and spent, never still due
  beside its completed session.
- A keychain token rotated between collection and push is not the one
  the push uses, and a signing key replaced mid-run does not sign.
- Moving a plugin's `workspaceRoot` from `/data/a` to `/data/b` keeps
  `/data/a/<id>` in the snapshot until `forget-root /data/a`, including
  after a restore onto a replacement machine.
- A disabled plugin block whose package is uninstalled has every
  plugin-owned value redacted and listed for re-entry, keeps
  `enabled: false` as a boolean, and restores into a config that
  parses. `status` names it.
- A ledger rewritten through every retry fails `now` rather than being
  kept stale or skipped.
- `init` run beside a daemon that is already serving a `STRATUS_SOUL`
  soul backs that soul up on the first night.
- A hard-linked `state.json` fails `now` with the path, rather than
  producing an unversioned snapshot.
- A hard-linked `memory.jsonl` fails `now` with the path, rather than
  producing a snapshot without memories, and so does a `config.json`
  rewritten continuously through every retry.
- On a fresh machine, `restore git@github.com:me/backup.git --ssh-key
  ~/deploy_key` fetches the private repository.
- A workspace file hard-linked to `~/.ssh/id_ed25519` is skipped,
  never copied.
- Restoring a snapshot written by a newer state schema on an older
  CLI writes nothing and prints the upgrade command.
- A workspace file rewritten continuously during `now` is never
  committed torn. Its previous copy is kept, or, when it has none, it
  is skipped and named in the report.
- A named credential added to `credentials.json` by hand, used by one
  run, and removed by hand before the next `now` is still redacted
  from the memory it was echoed into.
- A token pasted into `credentials.json` by hand during `now` restarts
  the run, and one pasted during the push triggers the post-push
  rescan.
- A default soul at `skills/example/SOUL.md` is stored once, and after
  restore an edit through the skill changes the soul the daemon serves.
  A config selected at `skills/example/config.json`, or a
  `memory-sqlite` database inside `skills/`, makes `now` refuse.
- Adding a credential whose value an earlier, already-pushed snapshot
  holds in plaintext makes the next `now` fail and name it for rotation.
- `init` against an SSH remote refuses unless the key is pinned with
  `IdentitiesOnly=yes`, and `~/.ssh/id_ed25519` never authenticates a
  backup push.
- `init` with `credential.helper='store --file /srv/shared/git-creds'`
  refuses and names the fix. The token in an accepted helper, whether
  `store --file` or `osxkeychain`, pasted into a memory, is redacted. A token in
  `http.extraHeader` in
  `~/.config/git/config` is never used by the backup's git.
- `init` on a replacement machine, adopting the existing branch with a
  credential re-entered first, finds that credential in older pushed
  snapshots and names it for rotation.
- After an upgrade adds a scan pattern, a pushed snapshot holding a
  value of that shape, in content or in a filename, makes the next
  `now` fail and name it.
- `now` under `GIT_CONFIG_COUNT=1` with an injected `http.extraHeader`
  pushes without that header.
- A home with an agent workspace at `agents/<id>/workspace/` backs up;
  the overlap guard does not treat it as inside a plaintext tree.
- The body of the deploy key, pasted into a memory without its
  `BEGIN` and `END` lines, is redacted.
- With `user.signingkey` at `~/.ssh/backup_ed25519` and a deploy key
  at `~/.ssh/stratus_deploy`, `fs.read` of either file under a
  `tool-fs` root of `~/.ssh` is refused.
- Changing `soul` in the config after `init` backs up the new soul the
  same night. Reinstalling the service with a different `--config` or
  working directory changes what the next `now` backs up, and a daemon
  restarted onto another config in the middle of a run makes that run
  start over.
- Two agents whose workspaces link to one directory restore sharing one
  directory and one ledger.
- A daemon whose default soul comes from `STRATUS_SOUL` backs that soul
  up, from the timer as well as by hand, and restore prints the new
  path to export. Restarting the daemon with a different `STRATUS_SOUL`
  changes the soul the next `now` backs up, and restarting it without
  `STRATUS_SOUL` returns the next `now` to the config's soul.
- A `tool-fs` root of `~/.stratus/skills`, or a workspace root at
  `~/.stratus/skills/example/output`, makes `now` fail with the
  reason.
- After a restore without the old private signing key,
  `init --rotate-signing-key` lets `now` resume. A later restore that
  names both public keys verifies across the rotation, and one that
  names only the new key refuses the older history.
- A `tool-fs` root of `~` for any agent makes `now` fail with the
  reason, and `fs.read` of the signing key under that root is refused
  before any `now` runs.
- A restore of a force-pushed, day-old, correctly signed tip does not
  proceed without `--expect-after`, `--expect-sequence`, or a
  confirmation.
- An `agents/<id>/workspace` linked to `~/.stratus` or `~` makes `now`
  fail with the reason, and no file from the backup directory is ever
  staged.
- Two `stratus run` invocations that export `GITHUB_TOKEN` with
  different values before one `now` leave both fingerprints, and `now`
  stays blocked until both are stored, retired, or acknowledged.
- A `passEnv` entry `DATABASE_URL=postgres://u:long-password@host/db`
  echoed into memory is redacted, although its name is not
  credential-shaped.
- An MCP header named `X-APIKEY` is treated as a credential, and so is
  a `passEnv` entry named `PGPASSWORD`, while `MONKEY` still is not.
- A config-only soul reached through a symlink backs up as a regular
  file, and so does a `config.json` that is a symlink into a dotfiles
  checkout.
- A config file (selected by `--config` or `STRATUS_CONFIG`), an
  external soul, or a `memory-sqlite` database inside a workspace or
  `tool-fs` root makes `now` refuse, name the file, and say to move it.
- `stratus backup now` run by hand from another directory, with a
  config holding a relative `soul`, backs up the same soul the daemon
  serves.
- An unnamed soul restored under another home keeps its name and avatar
  as well as its id.
- A global `pre-commit` hook that rewrites the index, or that always
  fails, has no effect on a backup run.
- A soul hand-edited during the push to declare a credential already
  staged in memory is reported right after the push, naming it.
- A `PUT /agents/:id` that adds a credential to a soul between
  collection and commit makes the run start over.
- A skill with an empty `out/` directory restores with that directory.
- A workspace file labelled `external` before the backup still reads
  back as `external` after a restore into a different home, and after
  a workspace link that pointed at another volume is restored. With `workspaces` left off, a file
  under a surviving `tool-fs` root that was labelled `external` is
  still `external` after restore. So is a file whose tainted write
  overlapped the backup run.
- A `tool-fs` file whose path contains a credential value fails the run
  and names the path.
- `enable` with a `STRATUS_API_KEY` exported only in the operator's
  shell is refused.
- A credential exported for one `stratus run` after `enable` makes the
  next `now` fail before committing.
- A value copied by `tool-shell`'s `passEnv` from a variable exported
  after `enable`, and a `STRATUS_API_KEY` exported for one run after
  `enable`, each make the next `now` fail before committing. So does
  storing a different value under the same name afterwards.
- A workspace FIFO's name does not appear in the pushed tree.
- With `sessions` enabled, a night that changed one of a hundred
  sessions commits one new ciphertext blob, not a hundred.
- A credential rotated after its old value was written into memory:
  the old value is still replaced in every later snapshot. This holds
  when the rotation happened while backups were disabled too.
- A `PUT /v1/config` that lands during the push waits for it to finish.
  Against a remote that never answers, the push times out, the lock is
  released, and the waiting write completes.
- A restore killed mid-way leaves `<dir>` empty or complete, and a
  rerun succeeds.
- A `credential set`, or a hand edit to `config.json` adding a header,
  that lands between collection and commit makes the run start over, and the new value is redacted in what it commits. A
  `credential set` issued during the push waits for it to finish. A hand
  edit during the push is reported immediately afterwards, naming the
  credential to rotate.
- A header added to config, used in one run, and removed before the
  next `now` is still redacted.
- A skill with `alias -> shared` beside `shared/` backs up. One with
  `loop -> .` fails.
- A signed snapshot in which only a file's git mode was changed is
  refused. So is a new commit that replays an older, validly signed
  snapshot.
- A snapshot holding `skills/Foo/` and `skills/foo/`, restored onto a
  case-insensitive volume, is refused before anything is written.
- After a credential is added, or after an upgrade that changes the scan
  policy, an unpushed commit holding ciphertext is rebuilt before the
  next push.
- `now` against a remote whose tip was rewound below the last pushed
  sequence refuses to run. So does `now` against a tip that another
  writer advanced, until `--takeover`, and a takeover refuses a tip
  that advanced with an unsigned commit.
- A push that the remote accepted but git reported as failed is
  recognized on the next run as this writer's own, not a foreign tip.
- `init` against a repository that has only a README commit creates the
  orphan `stratus-backup` branch, and restore verifies its first
  snapshot as the chain root.
- Restoring a home with `api.enabled` on a machine without
  `control-api` writes nothing and prints the install command.
- `init` with a passphrase-protected signing key is refused, with the
  reason. So is a remote that authenticates only through an SSH agent
  the timer will not have.
- `enable` with a credential that exists only as a shell variable is
  refused, and names `stratus credential set`.
- A snapshot containing a `.gitattributes` with a smudge filter
  restores byte for byte on a machine that has the filter installed.
- A workspace containing a FIFO and a socket backs up without hanging,
  and the encrypted index lists both as skipped. The plaintext manifest
  names neither.
- A `now` started while another is running exits with the
  "already running" status and changes nothing.
- `env: { MONKEY: "banana" }` backs up verbatim.
- An API key sent as the username in `Basic` auth (`key:`), and a header
  value rotated by editing `config.json`, are both replaced in later
  snapshots.
- The bare token from an `Authorization: Bearer …` header, and one
  cookie value from a multi-cookie `Cookie` header, written into memory
  are replaced.
- An MCP server URL carrying `?access_token=…` backs up with the token
  replaced and listed for re-entry.
- `env: { NODE_ENV: "production" }` and a `Content-Type` header back up
  verbatim. `env: { GITHUB_TOKEN: … }` and an `Authorization` header are
  replaced, and the restore lists them for re-entry.
- A memory recalled five times before the backup still has five recalls
  after restore.
- A home signed in to Codex backs up. The `chatgpt` marker is neither
  collected as a secret nor rewritten.
- Restoring a `memory-sqlite` home on a machine without that package
  writes nothing and prints the install command. After installing it,
  the same restore succeeds.
- A skill containing a link cycle fails the run promptly and names the
  link, rather than running without end. A workspace that
  is a symlink to another volume is backed up and restored as a real
  directory.
- An unnamed soul in `agents/` restored under a different home directory
  keeps its agent id and its memory.
- A value `tool-shell` passes through `env` or `passEnv`, echoed into a
  session, is not in the pushed tree.
- A named credential shorter than the floor fails the run and names the
  credential.
- With the service's config holding a relative `soul` path, the timer's
  run backs up the same soul the daemon serves.
- A planted key-shaped string that no credential store knows about fails
  the run before anything is committed.
- A backup taken while the daemon is mid-turn restores to a database that
  opens and passes `PRAGMA integrity_check`.
- A project-local `stratus.config.json` carrying a `backup` block has no
  effect.
- A daemon run with `--config` pointing outside `~/.stratus` is backed up
  from that file, and the restored home runs the same roster and memory
  store.
- `init` with a remote URL that carries userinfo is refused, and so is
  `now` with one in the config.
- A restore from a repository whose manifest names paths outside `<dir>`
  writes nothing outside `<dir>`.
- Deleting half of an agent's memory and running `now` commits, exits
  non-zero, and names what shrank.
- `restore --into` a non-empty directory refuses. Into an empty one it
  produces a home the daemon serves, with the same roster, memory, and
  schedules, and it lists the credentials to re-enter.
- `enable` then `disable` leaves no timer behind, on both service
  platforms.
- Documented in the places [CLAUDE.md](../../CLAUDE.md) names: a guide, the
  CLI and config references, and the state-layout page's
  [backing-up section](../reference/state-layout.md#moving-or-backing-up-a-home).

## Open questions

- **A native helper for descriptor-relative traversal?** Node exposes
  no `openat`, so the copy's check, open, and recheck protocol leaves a
  swap that is made and undone inside one open. A small native addon,
  or a prebuilt helper binary, would close it for both `backup` and
  `tool-fs`. The price is a native build step in two packages that
  ship none today.

- **An OS timer or a daemon job kind?** The OS timer is proposed because it
  needs no kernel change and runs when the daemon is down. A daemon job
  kind would appear in `stratus schedules` beside everything else and would
  work in a container with no service manager, which is
  [08](./08-deployment-profiles.md)'s shape. That argues for the scheduler
  eventually growing model-free jobs. Is that worth doing for one caller?
- **Encrypted credentials, ever?** Restoring a fleet with its Slack tokens
  intact is a real convenience. The price is a key the operator must keep
  somewhere that is not the backup. Probably never for the git target, and
  possibly for restic, whose repository is already encrypted with a key
  the operator holds.
- **The provider replay cache in `sessions.db`.** The control API strips
  the raw-turn cache (`redactAnthropicRawTurns`) on every read. A backup is
  not a read, since it has to restore a conversation that resumes. But does
  a restored session need the cache, or does it only cost one uncached
  turn? If the latter, leave it out; it is the least reviewed text in a
  home.
- **Where the pattern scan's rules come from.** Hand-maintained key shapes,
  or an optional external scanner if one is on `PATH`? The first is
  dependency-free and will miss things, while the second is better but is
  not ours to ship.
- **One repository per home, or a branch per machine?** An operator with a
  laptop and a VM may want both in one repository. Branch-per-home keeps
  one writer per branch and costs little, and it should be decided before
  the first repository layout is fixed.
