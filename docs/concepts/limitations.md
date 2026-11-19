# Known limitations

What Stratus doesn't do yet, or does with a catch you might not expect.
Each item links to the page that has the full story.

## Approvals

- **Out of the box, agents don't ask before they act.** The default
  posture, `open`, runs every `gated` tool without asking: writing files,
  running shell commands, sending messages, fetching pages, using the
  browser, calling an MCP server. No built-in tool is `dangerous`, so the
  only calls that still ask are to a plugin's `dangerous` tools. What bounds
  an agent instead is who may talk to it, the shell sandbox, and its file
  roots. `stratus setup` asks a new install which posture to use; an
  existing config keeps the one it has.
  [Approvals](../guides/approvals.md)
- **Under `open`, a page an agent read can steer what it does next.**
  Nothing reliably tells instructions in a web page, a search result or an
  MCP server's reply apart from content. For an agent that reads outside
  content and holds tools that write or send, use `guarded`, `review`, or
  `externalContent: "gate"`.
  [After an agent reads the web](../guides/approvals.md#after-an-agent-reads-the-web)
- **`review` is a model's judgment, not a boundary.** It changes nothing
  until a conversation reads outside content (shell output doesn't count).
  After that, your rules, a few built-in rules and a reviewer model decide
  each gated call. The built-in rules catch obvious cases only: a script
  file gets around the `curl … | sh` rule, and a command rule doesn't
  understand variables, `eval` or encoded text. The reviewer never sees tool
  output or fetched pages, it can be wrong, and each review is a model call
  on your account. Keep the shell sandbox on with it, and run it in shadow
  mode first. [The review posture](../guides/approvals.md#the-review-posture)

## Where commands run

- **The shell sandbox exists on macOS and Linux only.** Commands run under
  `sandbox-exec` on macOS and bubblewrap (`bwrap`) on Linux. Where no
  sandbox can start, including Windows and a Linux host without `bwrap`,
  the default (`sandbox: "required"`) refuses every command and says why.
  `sandbox: "auto"` runs them unconfined there and logs why, and
  `sandbox: "off"` turns the sandbox off.
  [Shell commands](../guides/shell.md#what-a-command-can-reach)
- **In a Docker container, shell commands are refused.** Docker's default
  security profiles stop bubblewrap from starting, with or without the
  shipped `compose.yaml`. For agents that run commands, run the image in a
  VM (a Fly Machine works) or install on the host under systemd.
  [Hardening checklist](../guides/deployment.md#hardening-checklist)
- **The sandbox leaves the network on.** A command can reach any address,
  including a cloud VM's metadata service and the credentials its role
  hands out. Block that at the host if the role matters.
  [Shell commands](../guides/shell.md#what-a-command-can-reach)
- **`stratus service` knows launchd and systemd only.** On other systems,
  or a Linux host that doesn't run systemd, keep `stratus serve` running
  yourself. [Always on](../guides/always-on.md)

## Time and money

- **There's no time limit and no spending limit.** A turn or a background
  task runs for as long as it keeps working, and nothing stops an agent at
  a dollar or token amount. What caps one message is `maxTurns`, the number
  of tool steps it may take (40 by default), and `autoContinue: true` lifts
  even that for an agent. Watch your provider's usage page.
  [Configuration](../reference/config.md#how-many-turns-one-message-may-spend)

## Memory and conversations

- **An agent remembers what it chooses to save.** Nothing is saved on its
  own unless a plugin runs memory passes, and recall matches words, not
  meaning. [Memory](./memory.md)
- **Long conversations get summarized.** Once one outgrows the model, its
  oldest messages reach the agent as a summary, and details the summary
  leaves out stop reaching it.
  [Troubleshooting](../guides/troubleshooting.md#a-conversation-that-outgrows-the-model)

## Running and upgrading

- **One daemon per home.** A second `stratus serve` on the same home
  refuses to start, so there's no failover to another process.
  [Always on](../guides/always-on.md#one-daemon-per-home)
- **No downgrade in place after a migration.** An older build won't write
  to a home a newer one has migrated. Going back means restoring the backup
  taken before the migration, without what was written since.
  [Updating](../guides/updating.md#going-back-to-the-version-you-had)
- **Logs can quote your requests.** Stored keys are masked in error text,
  but a provider's error often quotes the request that failed. Skim a log
  before you share it. [Logs](../guides/logs.md#a-trace-not-a-transcript)
- **Pre-1.0.** Expect breaking changes between minor versions, and read
  [Updating](../guides/updating.md) before you upgrade. Security fixes ship
  only in the latest release.
  [SECURITY.md](../../SECURITY.md#supported-versions)
- **Node 22.16+ on the 22.x line, or Node 24+.** The 23.x line won't run
  it. [Installation](../start/installation.md)
- **Slack is the only chat channel built in.** Others come from plugins.
  [Extending](../guides/extending.md#channels)

Found another? [Open an issue](https://github.com/stratuslabs/agent/issues/new/choose).
Found a way around a security boundary? Report it privately, as
[SECURITY.md](../../SECURITY.md) describes.
