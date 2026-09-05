# @stratusagent/plugin-mcp

The MCP bridge: mount any [Model Context Protocol](https://modelcontextprotocol.io)
server's tools as Stratus tools — under the same allowlists, the same risk
model, and the same approval policy as a tool written for Stratus. Every MCP
server anyone has already written becomes available to an agent whose soul
opts in, without that server's author knowing Stratus exists.

## Install and enable

```bash
npm install -g @stratusagent/plugin-mcp
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/plugin-mcp": {
      "enabled": true,
      "servers": {
        // A subprocess server, spoken to over stdio:
        "linear": {
          "command": "npx",
          "args": ["-y", "@linear/mcp-server"],
          "env": { "LINEAR_API_KEY": "lin_api_…" }
        },
        // A remote server, spoken to over Streamable HTTP:
        "docs": {
          "url": "https://mcp.example.com/mcp",
          "headers": { "Authorization": "Bearer …" }
        }
      }
    }
  }
}
```

Then allowlist the tools in a soul, exactly as for any other toolset:

```markdown
---
id: ava
tools: [mcp.linear.*, fs.read]
---
```

## Naming: `mcp.<server>.<tool>`

Tools register namespaced by the server's config key: the Linear server's
`create_issue` becomes `mcp.linear.create_issue`. A soul grants a whole
server with `mcp.linear.*` (or every bridged server with `mcp.*`), and an
operator reading a tool list sees at a glance which tools are somebody
else's code. Server keys become name segments, so they must be lowercase
`[a-z0-9_-]`; a discovered tool name is folded to the same shape
(`createIssue` → `mcp.linear.createissue`), and two names that fold to the
same segment refuse the server rather than letting one silently answer for
the other.

## Risk: ours, not the server's

MCP has no risk vocabulary, and a remote server's self-description is
exactly the input the trust model says not to take at face value. So
**every bridged tool registers `gated`** — a human decides when nobody is
watching — even when the server describes it as read-only. The package's
manifest declares the namespace (`toolsDiscovered: [{ "namespace": "mcp.*",
"risk": "gated" }]`) and the plugin host enforces it at registration, on
first connect and identically on reconnect.

Provenance is a different question with one answer: whatever a bridged tool
returns is the server's text, so every bridged result is labelled
`external`, and the session that read it — and every fact it remembers
afterwards — carries the label
([Memory](../../docs/concepts/memory.md#where-a-fact-came-from)). No
override lowers that; it is a statement about who wrote the bytes, not
about how risky the call was.

What a server *advertises* — its tool names, descriptions, and input
schemas — is not labelled. It reaches the model as part of the tool
definitions on every turn, and the operator put it there: mounting a server
in a trusted config vouches for its tool surface the way installing a plugin
vouches for the descriptions that plugin ships, and labelling text inside the
prompt is what the provenance step rules out. Only what a call *returns* is
content the operator did not choose. A server whose descriptions you would
not want in front of your agent is a server not to mount.

The override is the operator's, explicit and per tool, through the host's
`toolRisks` key — sibling to `enabled`, applied by the host rather than by
this package's code:

```jsonc
"@stratusagent/plugin-mcp": {
  "enabled": true,
  "servers": { "linear": { … } },
  "toolRisks": {
    "mcp.linear.get_issue": "safe",      // you read the server; it only reads
    "mcp.linear.delete_issue": "dangerous"
  }
}
```

## Server settings

| Setting | Applies to | Meaning |
| --- | --- | --- |
| `command`, `args`, `cwd` | stdio | The subprocess to spawn. Exactly one of `command` / `url` per server. |
| `env` | stdio | Variables set outright, name to value — where a server's API key goes. |
| `passEnv` | stdio | Names forwarded from the daemon's environment. Defaults to `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`. |
| `url` | HTTP | The Streamable HTTP endpoint. |
| `headers` | HTTP | Headers sent with every request — where a bearer token goes. |
| `connectTimeoutMs` | both | One budget for the connect handshake *and* the whole tool-discovery walk (default 15000), so a server can stall startup neither by being unreachable nor by paginating slowly. |
| `callTimeoutMs` | both | Per-call budget (default 60000). |

A setting on the wrong transport kind — `headers` on a stdio server, `env`
on an HTTP one — is refused at load rather than silently ignored, and so is
a `passEnv` that is not an array of names: a grant an operator believes is
in effect must never quietly be nothing.

**The stdio environment is replaced, not extended.** A subprocess MCP
server is a subprocess, and gets the same treatment `tool-shell`'s commands
do: exactly what this config granted — the harmless default inheritance,
`passEnv` names, `env` values — and nothing else. The daemon's environment,
where `ANTHROPIC_API_KEY` and every other exported key lives, is not there
to read.

That includes the transport's own idea of what a server needs. The MCP
SDK's stdio client spawns with a default set of its own (`HOME`, `LOGNAME`,
`PATH`, `SHELL`, `TERM`, `USER` on POSIX) merged under whatever it is
handed, so the bridge refuses each of those names explicitly unless this
config granted it — otherwise `passEnv: []` would still hand a third-party
server the account the daemon runs as. **Consequence for a narrowed
`passEnv`:** a `command` without a `/` is resolved against the child's
`PATH`, and the child's `PATH` is only what this config granted — so a
server whose `passEnv` omits `PATH` **must give `command` as an absolute
path**, and one that does not is refused at load with a message saying so,
rather than failing at connect as a bare `ENOENT` that reads like a missing
binary. An **empty** grant does not count either: `which` treats a falsy
search path as none and falls back to the daemon's own, so `PATH: ""` would
resolve a bare command against exactly the environment the config declined
to grant.

Grants are spelled the way the platform spells them — `Path` counts on
Windows, where environment names are case-insensitive, and does not on
POSIX, where only `PATH` drives lookup. On Windows every name the transport
would inherit is canonicalized onto the transport's own spelling before its
defaults are merged under it, which is what stops the daemon's uppercase
copy from shadowing a mixed-case grant: **for each of those names, exactly
one entry leaves this package, carrying the granted value or nothing.** That
applies to `USERPROFILE`, `APPDATA` and the rest as much as to `PATH` — a
grant that only half-applies is the failure this is guarding.

Refused rather than diagnosed at runtime because the runtime signal cannot
be trusted to mean what it says. On Windows the SDK spawns through
`cross-spawn`, whose resolver hands an absent `PATH` to `which`, and `which`
falls back to `process.env.PATH` — the daemon's own. A bare command would
resolve against exactly the environment this config declined to grant. Same
rule as a malformed `passEnv`: a grant an operator believes is in effect
must never quietly be nothing.

**A bare `command` is resolved here, not by the spawn.** The granted `PATH`
is searched in order and the transport is handed the path that came back,
because the resolver underneath it does not search only what was granted:
`cross-spawn` puts `process.cwd()` at the front on Windows — "windows always
checks the cwd first", says `which`'s own comment — and an empty `PATH`
entry means the current directory on either platform. The daemon's working
directory is not a grant, and an `npx.cmd` dropped into it would run in
place of the one on the granted `PATH`. So an empty entry is dropped rather
than searched, and the resolution runs on every platform rather than behind
a Windows branch — the lookup Windows depends on is then the one the tests
exercise. A `command` that names a path (`/opt/bin/srv`, `.\srv.exe`) is
taken as written and searched for nowhere.

Everything else about the Windows search follows `which`, because replacing
a lookup is not an occasion to change what it finds. Quotes come off an
entry only as a **balanced pair** — a lone one is a malformed entry, and
stripping it would search a directory the granted string does not name.
`PATHEXT` decides what is runnable, read from the grant and otherwise from
`which`'s own fallback, `.EXE;.CMD;.BAT;.COM`; the daemon's `PATHEXT` is
never read, for the same reason `PATH: ""` does not count as a grant, and
Windows' wider default is not used either, since it would make a bare
command resolve to file types that resolve to nothing today. A `command`
that already carries an extension is tried as written first, but only when
`PATHEXT` permits that extension — otherwise a `srv.js` under
`PATHEXT: ".EXE"` would mask the `srv.js.EXE` beside it that Windows would
actually run. One deliberate difference: an empty entry *inside* `PATHEXT`
(`".EXE;"`) makes `isexe` treat every extension as executable, and does not
here. A grant is not widened by the punctuation that ends it.

A **relative** entry is honoured, and it means what it has always meant:
`PATH: "bin"` on a server with a `cwd` is `<cwd>/bin`, the shape running
`npx` out of a project checkout takes. It is resolved against the directory
the server will actually run in — its `cwd`, or the daemon's when it sets
none — and what the transport is handed is absolute, so the file this
package checked and the file the spawn starts are the same file. That is a
different call from the empty entry, deliberately: `./node_modules/.bin` is
a directory somebody chose, while a zero-length entry is what a stray colon
leaves behind — and the default grant, `passEnv: ["PATH"]`, copies the
daemon's own `PATH` verbatim, trailing colon included.

A bare command the granted `PATH` does not contain is **not** a config
failure: the daemon goes on serving every other agent and the server is
retried like any other one that is not up, because a package still
installing is not a broken config. Only a config that cannot become correct
— a bare command with no `PATH` granted at all — is refused at load.

OAuth-authenticated HTTP servers are not modeled yet; a static bearer in
`headers` is what exists today.

## Lifecycle

- **Connect at startup, degrade when down.** A server that is unreachable
  leaves the daemon serving everything else, with a log line naming the
  server and the config block to check; its tools appear when it comes back.
  Reconnection backs off from one second to a minute.
- **Discovery is per connect.** Tool descriptors are cached from connect to
  connect; a server that changes its list mid-run is picked up on
  reconnect. A tool discovered only then registers normally; one no longer
  advertised is unregistered — both logged, because an agent's allowlist
  may no longer mean what it meant.
- **While a server is down**, calls to its tools fail with a "not
  connected" error rather than hanging.
- **A transport error is logged and named.** The SDK's stdio reader
  refuses a single message over 10 MB and closes the connection, which a
  call in flight would otherwise see only as "Connection closed"; the call's
  error and the log line both say a reply was too large, so the fix is the
  server's result size and not the network.
- **All of these lines are in the daemon's log** — `stratus logs` — under
  the daemon, and on stderr in a one-shot `stratus run`.

## Results

Tool results normalize into plain values:

- Text content comes back as a string (or under `text` when there is more).
- `structuredContent` passes through as `structured`.
- **Images, audio, and binary resources are written into the agent's
  workspace** (`~/.stratus/workspaces/<agent>/mcp/<server>/`) and returned
  under `files` — the key channels deliver as attachments, so an image from
  a bridged tool reaches Slack like a screenshot does.
- Resource links pass through under `resources`.
- A result the server marks `isError` fails the call, like any failing tool.

## What this is not

Stratus does not become an MCP *server* here (exposing its tools to other
clients is a different step with a different threat model), and MCP prompts,
resources, and sampling are out of scope beyond what tool results need.
