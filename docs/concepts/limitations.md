# Known limitations

What doesn't work yet, or works differently than you might assume. Each
item links to the page that owns the full story.

- **The shell is sandboxed only on macOS and Linux.** Commands run under
  `sandbox-exec` or `bwrap`. Where neither can start, the default
  (`sandbox: "required"`) refuses them, `sandbox: "auto"` runs them
  unconfined after a warning, and `sandbox: "off"` turns the sandbox off.
  The sandbox leaves the network on, so on a cloud VM, block the metadata
  service at the host. [Shell](../guides/shell.md#what-a-command-can-reach)
- **An agent remembers what it chooses to save.** Nothing is saved
  automatically when a conversation ends, and recall matches words, not
  meaning. [Memory](./memory.md)
- **Long conversations get summarized.** Once one outgrows the model, its
  oldest messages reach the agent as a summary, and details the summary
  leaves out stop reaching it.
  [Troubleshooting](../guides/troubleshooting.md#a-conversation-that-outgrows-the-model)
- **One daemon per home.** A second `stratus serve` on the same home
  refuses to start, so there's no failover to another process.
  [Always on](../guides/always-on.md#one-daemon-per-home)
- **No downgrade after a migration.** An older build refuses a home a newer
  one has migrated, so back up before you upgrade.
  [Updating](../guides/updating.md)
- **Logs aren't scrubbed.** A failed run keeps the provider's error text,
  which can quote your request. [Logs](../guides/logs.md#a-trace-not-a-transcript)
- **Slack is the only chat channel in this repo.** Others come from plugins.
  [Extending](../guides/extending.md)

Found another? [Open an issue](https://github.com/stratuslabs/agent/issues/new/choose).
Found a way around a security boundary? Report it privately, as
[SECURITY.md](../../SECURITY.md) describes.
