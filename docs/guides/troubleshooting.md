# Troubleshooting

`stratus doctor` answers one question — *what would a run use right now,
and who decided that?* Every setting is shown with the file or environment
variable it came from, because the answer is usually that something
outranks what you thought you configured:

```bash
stratus doctor
stratus doctor --format json
```

```text
Stratus Agent — what a run would use right now

  provider  anthropic
            from ~/.stratus/agents/ava.md (soul frontmatter)
  model     claude-opus-5
            from ~/.stratus/agents/ava.md (soul frontmatter)
  soul      ~/.stratus/agents/ava.md
            from ~/.stratus/config.json
  agent     Ava (ava)

Files
  config    ~/.stratus/config.json
  agents    1 soul file

Sign-ins
  anthropic Claude subscription (Pro/Max) — runs go through the Claude Code runtime
  openai    not signed in

Channels
  slack     no agents connected
            @stratusagent/channel-slack installed

1 problem found:
  ! A fallback model (gpt-4.1-mini) is configured but could not be resolved — usually
    no sign-in for its provider. A failing primary model has nothing to retry on.
```

It resolves the config exactly the way a run does rather than re-deriving
the rules, so what it prints is what you would get. It exits non-zero when
it finds a problem, and it is the fastest answer to the two most common
surprises: a run that turns out to be on the `demo` provider, and an
`ANTHROPIC_API_KEY` in the environment quietly demoting a Claude
subscription sign-in to per-token billing.

## The usual suspects

- **"Why is this using the demo provider?"** — run `stratus doctor`; some
  file or env var outranks what you set. The
  [precedence chain](../reference/config.md) is: flags → `STRATUS_*` env
  vars → soul file hints → config file.
- **The agents stopped answering after a node upgrade** — the service unit
  points at an interpreter that no longer exists. `stratus update` repairs
  it; [Updating](./updating.md) explains why.
- **`stratus logs` shows nothing, but the daemon won't start** — a daemon
  that fails before it starts serving never opens the structured log. See
  [When the log is empty](./logs.md#when-the-log-is-empty) for where those
  errors actually land on each platform.
- **A Slack app is silent** — the daemon isn't running
  ([Always on](./always-on.md)), or the channel package isn't installed
  (`stratus serve` names it at startup).
- **A gated tool call was refused overnight** — that is the daemon's
  honest default. [Approvals](./approvals.md) covers asking a human in
  Slack instead.
