# MCP

`@stratusagent/plugin-mcp` is the bridge to the
[Model Context Protocol](https://modelcontextprotocol.io) ecosystem: any
MCP server's tools become Stratus tools under the same policy as everything
else, named `mcp.<server>.<tool>` and discovered when the server connects.

```bash
npm install -g @stratusagent/plugin-mcp
```

Like every plugin, it is enabled in a
[trusted config](../concepts/plugins.md) and granted per agent through the
soul's allowlist — `tools: [mcp.linear.*]` grants one server:

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "@stratusagent/plugin-mcp": {
      "enabled": true,
      "servers": { /* stdio or Streamable HTTP servers — see the package README */ }
    }
  }
}
```

## The posture

- **Every bridged tool is `gated`**, regardless of how the server describes
  itself — the operator's per-tool `toolRisks` entry is the only thing that
  lowers one. A server's self-description is not a security decision your
  daemon inherits.
- **A server's tool descriptions are bounded before the model sees them.**
  They are the server's prose, re-read on every reconnect, and they land
  in the tool block of every turn. Each is capped at 1024 characters with
  the cut announced, and control characters and Unicode bidi controls are
  spelled out (`\u202e`) rather than rendered — so a description that
  reads one way to a person and another to the model reads as what it is.
  The same goes for the `description`, `title` and `$comment` of every
  property in a tool's input schema, at any depth — and only those: a
  property name, an enum value, a default or an example is what the model
  sends back in a call, so it reaches the model as the server wrote it. A
  schema still longer than 16,384 characters after that, or nested more
  than 64 levels deep, is a page, not a parameter list, and so is a tool
  whose name is longer than 64 characters: that one tool is not bridged,
  the daemon log names it, and the server's other tools load.
- **A server's results are bounded too**, at 100,000 characters per call
  by default — the same cap `shell.run` puts on a command's output, and
  for the same reason: it is somebody else's program, writing as much as it
  likes. What makes it matter more here is that a tool result is
  *durable*: it is saved into the session and replayed to the provider on
  every later turn of that conversation, so one twenty-megabyte directory
  listing is not one expensive turn, it is every turn until the
  conversation ends, and it survives restarts because the transcript does.
  A cut is announced in the text the model reads, with the original size,
  so a listing that was stopped never reads as a listing that ended.
  Per server, as `maxResultChars`, for a server that legitimately returns
  large documents. Its floor is 512: below that a cap cannot hold an
  account of what it cut, and one smaller is raised to it rather than
  approximated, with the markers naming the cap that was applied. It is **one allowance for the whole result**, not one
  per field: text, a structured payload and a list of resource links are
  three places a server can put bytes in one reply, and the transcript pays
  their sum. A failing call is bounded the same way, whether it
  answers with an error or fails at the protocol level — either way the
  message is persisted and replayed exactly as output is, so failing is
  not a way around the cap. Binary content's *bytes* land in the per-agent
  workspace rather than the transcript, but the path each one returns is a
  string in the result like any other, so those are counted too; blocks
  past the allowance are not written at all, and the result says how many.
  Everything is charged as the transcript carries it, because the
  transcript is JSON: a list pays for the commas and brackets a hundred
  links or paths arrive in, and text pays for the escaping it will get, so
  a result of control characters cannot weigh six times the cap it passed.
  Ordinary prose is unaffected — a log file pays a little for its newlines
  — and the room for stratus's own account of a cut is set aside before a
  server spends anything, so explaining a truncation cannot itself push
  the result past the number you set.
- **A stdio server's environment is replaced** the way
  [`tool-shell`'s](./tools.md) is: it gets what you granted and nothing
  else, not the daemon's own environment.
- Reconnects (with backoff) keep discovered tools registered under the same
  gate; images a server returns land in the per-agent workspace.

Server settings, transports, and lifecycle are documented in the
[`@stratusagent/plugin-mcp` README](../../packages/plugin-mcp/README.md),
which is canonical for the bridge. How gating and approval work once a tool
is mounted: [Approvals](./approvals.md).
