# Release smoke check

One command, run before a release PR merges:

```sh
pnpm install --frozen-lockfile
pnpm smoke:release
```

It builds this checkout, packs every publishable package the way npm
would publish it (`deploy/docker/pack.mjs`), installs the tarballs into a
temporary prefix, and starts `stratus serve` against a scratch home shaped
like a real host. Then it checks:

| Check | What it would have caught |
| --- | --- |
| Every package tarball contains `LICENSE`, and an Apache-2.0 one also `NOTICE` | A package whose `files` leaves out the NOTICE, so the Apache 2.0 attribution never reaches npm |
| The daemon starts with no startup warnings, and `stratus doctor` passes | A default that leaves a host-shaped config warning or broken |
| A sandboxed `shell.run` runs a tool from the agent's `~/.stratus/integrations/<id>/toolchain/bin`, reads its git config there, and runs `node` | 0.13.0's sandbox, which denied that directory even when `readablePaths` named it, so git and gh failed in every command |
| A named credential stored with `stratus credential set` reaches the plugin tool that declares it | A break in the credential allowlist or the plugin seam |
| `schedule.every` creates a schedule, `stratus schedules` lists it, and it fires a turn | A scheduler or schedule store that no longer loads or fires |

The turns are driven over the control API by a test-only plugin in
`plugin/`: a scripted `smoke` provider that makes exactly the tool call a
message names, and a `smoke.credential` tool that reports a hash of the
credential, never its value. No model, no network beyond the npm registry
for the install, and no real secrets. Every command runs with `HOME` set to
the scratch home, so the real `~/.stratus` is not read or written.

## Reading the result

Each check prints `PASS`, `FAIL` or `NOT RUN`, then a summary line.

- Exit `0`: every check passed.
- Exit `1`: a check failed. The daemon's output follows the failures.
- Exit `2`: nothing failed, but a check could not run. This is not a pass.
  The usual cause is a shell that is itself sandboxed, such as an agent's
  `shell.run`: macOS cannot start a sandbox inside another one. Run it
  from a plain terminal.

`--repo <dir>` checks another checkout, such as a tag's worktree, with this
copy of the script. A checkout with no `node_modules` gets
`pnpm install --frozen-lockfile` first. `--no-build` skips `pnpm build`.
`--keep` leaves the scratch directory behind and prints where it is.

## What it does not cover

- **Slack.** It connects no channel, so it does not prove an agent admits
  its listed principals in Slack. `stratus doctor` warns when a Slack agent
  has nobody listed; the canary below covers the live path.
- **Linux.** It runs on Linux, but it needs `bwrap` for the shell check, and
  CI does not install it yet.
- **The real hosts' configs.** The scratch home has their shape, not their
  contents.

## After tagging: the canary

Update one host first and leave the others on the previous version. Run
about an hour of normal work on it: Slack replies, at least one schedule
firing, and a sandboxed `shell.run` that uses git and gh. Update the next
host only once that is clean. The release PR template
(`.github/PULL_REQUEST_TEMPLATE/release.md`) asks for both results.
