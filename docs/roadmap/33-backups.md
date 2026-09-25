# 33 — Backups: a nightly, model-free copy of a home somewhere else

## Goal

An operator can name a private git repository once, and every night the
parts of `~/.stratus` worth keeping (souls, skills, memory, schedules, and
optionally conversations) are committed and pushed there. A script does
the work, not a model. No secret is ever pushed, and a lost machine can be
restored from the repository with one command. The feature is off by
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
  | `agents/<id>.md` souls, `skills/`, `config.json` (sensitive values redacted, below), `state.json`, per-agent `memory.jsonl` and `whitelist.json`, the `schedules` table from `fleet.db` | `sessions.db` per agent and the session index (`sessions`), `workspace/` per agent (`workspaces`) | `credentials.json`, `gateway-token`, `gateway.json`, `stratusd.lock`, `logs/`, `memory.jsonl.index` (it is derived and can be rebuilt), any `-wal`, `-shm`, or `-journal` file |

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
  `init` refuses either opt-in without one. Unchanged files keep their
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
  paraphrased has moved it past any scanner. Encrypting memory by
  default would close that and cost the main reason to back up to git,
  readable history of what an agent believed. So `encrypt: "all"` is an
  option for an operator who wants the stronger guarantee instead, and
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
    where it came from. `enable` writes the timer with the same
    `--config` or `STRATUS_CONFIG` the service runs with, **and the
    same working directory**, because a config may hold relative paths
    (a `soul`, a database, a workspace root) and those resolve against
    the process's working directory, which the service definition sets
    on purpose. The manifest records every such path as it resolved, so
    a snapshot says exactly which files it came from.
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
    file outside `agents/`. It is copied into the snapshot under
    `external/`, and the snapshot's manifest records the original path.
  - **A configured `workspaceRoot`.** `tool-fs`, `tool-shell`,
    `tool-browser`, and `plugin-mcp` accept one, and it wins over
    `agents/<id>/workspace/`. With `workspaces` opted in, `now` snapshots
    the root each agent actually resolves to, through the same resolver
    the plugins use rather than by reading the setting, under
    `external/`. The directories an agent is merely allowed to work in
    (`tool-fs` roots) are the operator's own files, not agent state, and
    stay out.

  Restore never writes outside the directory it was given (see
  [Restore](#restore)).
- **Every soul's resolved agent id.** A soul that declares no `name` or
  `id` gets a generated identity seeded from its **absolute path**, which
  is true of ordinary `agents/*.md` souls as well as a config-only one.
  Memory, sessions, grants, and schedules are all keyed by that id, so
  the same file restored under another home directory, another username,
  or `<dir>` itself comes back as a stranger to its own state. The
  manifest records the id every soul resolved to, and restore writes it
  into the frontmatter of each soul that did not declare one, printing
  each soul it changed.
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
- **Supported links are materialized; no link is ever committed.** Three
  kinds of link are legitimate in a home. A soul file in `agents/` may be
  one, which is how a template's soul stays edited in its own checkout.
  It is copied as a regular file, and its identity is preserved like any
  other soul's (see "Every soul's resolved agent id"). An unnamed linked
  soul is seeded from the path it resolves through, so the id recorded
  is the one the daemon actually used. `agents/<id>/workspace/` may be
  one, because the state layout lets an operator put an agent's output on
  another volume. And a skill may contain relative links between
  its own files, which `skill add` validates for containment and keeps.
  `now` copies what each of these points at into the snapshot as real
  files and directories. For skill links it uses the same containment
  check `skill add` runs (`findEscapingSymlink`, which is private to
  `state` today and gets exported for its second consumer) rather than
  a second copy of it. A link that reaches outside its own skill or workspace fails the
  run and names the path. Because nothing committed is a link, restore's
  refusal of every link (below) never rejects a snapshot `now` made.

Databases are never copied as files: a live WAL-mode database copied
byte for byte can be torn. Each one is snapshotted with `VACUUM INTO` a
temporary path, which is consistent while the daemon is writing, and then
fsynced and renamed. `node:sqlite`'s `backup()` is not available across
the supported range: it arrived in 22.16 and 23.8, and the floor is
`>=22.13 <23 || >=23.4`. The snapshot is then written as `schema.sql` plus
one JSONL file per table, rows ordered by primary key, so that:

- a night where nothing changed makes **no commit at all**;
- a night where one conversation grew adds one diff, not a new copy of a
  multi-megabyte blob;
- a table can be left out or redacted by name.

The local clone lives at `~/.stratus/backup/`. It must never live under
`agents/`, because the startup sweep treats any validly named directory
there that holds a `sessions.db` as an agent.

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

   The run has to see the environment the daemon sees, or the list is
   short exactly where it matters. So `enable` writes the timer with the
   same environment the service definition carries, and a declared name
   that resolves to nothing at backup time is reported in `status`.

   Values that live in configuration rather than in a credential store
   join the same set. That is every config property a manifest marks
   `writeOnly` (below). It is also, by shape and at any depth of the
   trusted config, every string under an `env` or `headers` object and
   the value of every variable a `passEnv` list names. That covers
   `provider-openai`'s headers, `tool-shell`'s environment, and each
   `plugin-mcp` server's `env`, `headers`, and `passEnv`. The last sits
   inside an opaque `servers` object that no manifest annotation reaches,
   which is why the rule is structural rather than a list of packages.
   A tool can echo any of these values into a session or a memory, where
   it is no different from a stored key. Redacting them only inside
   `config.json` would leave every other copy in place.

   **A secret too short to replace safely stops the run.** Named
   credentials accept any non-blank value, and replacing every occurrence
   of `a` or `test` across a home would corrupt the snapshot beyond use.
   A value below a floor (on the order of 12 characters) fails the run
   and names the credential, instead of silently rewriting common text or
   silently skipping a secret.

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
lives with the package that knows, not in a list here.

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
but it usually reaches every repository its owner has.

### A backup that faithfully saves the damage

A nightly job will back up a wiped memory file as faithfully as a good
one, and the next night that is the only copy at the tip. Git history is
the defence, so the feature never force-pushes, never prunes, and never
rewrites. On top of that:

- **Shrinkage warns loudly.** If memory lines, sessions, or souls drop by
  more than half since the last snapshot, `now` still commits (the
  history holds the good copy either way) but exits non-zero and says what
  shrank. That puts the problem in front of someone while the good copy
  is one day back rather than ninety.
- **A failed push keeps the local commit** and exits non-zero. The next
  run rescans every unpushed commit against the **current** secret set
  before pushing anything. A secret learned since, such as a credential
  added after the failed run, would otherwise go out in the older
  commit. If the rescan hits, the unpushed commits are dropped and
  rebuilt from the current tree. They were never published, so this
  rewrites nothing anyone else has.
- **A partial snapshot is a failure.** If one database could not be read,
  the run exits non-zero, so the timer never reports a half backup as
  success.
- **`stratus backup status`** shows the last success, the last push, and
  the last warning. With the package configured, `stratus doctor` warns
  when the last success is more than a few days old.

### Restore

`stratus backup restore <remote|path> --into <dir>` refuses any directory
that is not empty. It rebuilds each database from its JSONL, rebuilds `memory.jsonl.index` on first use (which already happens),
and prints the list of credentials to re-enter.

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
are restored `0700`, still owner-only.

**Every write lands inside `<dir>`.** An external soul, a `memory-sqlite`
database, and a configured workspace root are restored under
`<dir>/external/`, and the
restored config is rewritten to point at them there, with each rewrite
printed beside the path it replaced. A path recorded in the manifest is
information for the operator, never a place restore writes to: the
repository is input that someone other than the operator may have
changed, and following its paths would let a modified backup create
files anywhere the operator can write. Putting a file back at its
original location, or pointing `--config` at the restored config, is the
operator's move, the same as moving the directory into place with the
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
- A config-only `soul` outside `agents/` is in the snapshot. Restore puts
  it under `<dir>/external/` and rewrites the restored config to match.
- With `workspaces` opted in and a `workspaceRoot` configured, the files
  under that root are the ones backed up and restored.
- A credential containing a quote, a backslash, and a newline, pasted
  into memory and a session, appears in the pushed tree in no form, raw
  or escaped.
- A repository whose `schema.sql` carries an `ATTACH` or `VACUUM INTO`
  restores without executing it and writes nothing outside `<dir>`.
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
- Under a `022` umask, a restored home has the same `0700` and `0600`
  modes a fresh one has, and a skill script that was executable still is.
- A value in a `plugin-mcp` server's `env` or `headers`, echoed into
  memory, is not in the pushed tree. A workspace that
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
