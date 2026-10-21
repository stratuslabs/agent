## Release

<!-- Version, from what, and whether it is a patch or a minor and why.
     List every default change and contract change a host must read
     before upgrading, then the rest of what merged since the last tag. -->

## Release smoke check

<!-- Required before merge. Run from a plain terminal on macOS, not from a
     shell that is itself sandboxed (an agent's shell.run is), at this
     PR's head:

       pnpm install --frozen-lockfile
       pnpm smoke:release

     Paste the summary line and every FAIL or NOT RUN line. Exit 0 is the
     only pass; NOT RUN means a check could not run there, so run it
     somewhere it can. See scripts/release-smoke/README.md. -->

- Ran on (OS, Node, commit):
- Result:

## After tagging: canary

<!-- Update one host first and leave the others on the previous version.
     Run about an hour of normal work on it: Slack replies, at least one
     schedule firing, a sandboxed shell.run that uses git and gh. Update
     the next host only once that is clean. Record the outcome here or in
     a comment, with the host's `stratus --version`. -->

- Canary host and version:
- Outcome:
