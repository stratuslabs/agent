# Security posture

The one-page map of what protects what. Each rule is deliberate; the pages
linked own the full story.

## Secrets on disk

- `~/.stratus/credentials.json` is `0600` (owner-read-only), and so are
  `~/.stratus/gateway-token`, `~/.stratus/gateway.json`,
  `~/.stratus/logs/stratusd.jsonl`, and each agent's
  `<id>.whitelist.json`.
- **Stored sign-ins are endpoint-bound**: a credential saved for one
  endpoint is never sent to an endpoint a project-local config selects.
- **Slack channel tokens are gateway infrastructure secrets.** They live
  under `channels.slack.<agentId>` and are never resolvable through an
  agent's own credential allowlist — an agent must not be able to read the
  tokens of the transport carrying it. ([Slack](../guides/slack.md))
- **Named credentials are the opposite case, and share the file without
  sharing the door.** `search.apiKey` and its kind live under `named` and
  *are* resolved through an agent's allowlist, because they are an agent
  capability rather than the daemon's own — the agent's own entry first,
  then the fleet's shared one, then the environment. A soul that does not
  list a name cannot reach it. Channel tokens stay out of that path
  entirely; a namespace next door is not a way in.
  ([Tools](../guides/tools.md#searching-the-web))
- **The credentials file is replaced, never rewritten in place.** A named
  credential is resolved per tool call so that a rotated key needs no
  restart, which means the file has a concurrent reader — and a truncate
  followed by a write leaves a window where that reader sees an empty file.
  Each write lands in a `0600` temporary beside it and is renamed over the
  destination, so a reader sees the old document or the new one and a crash
  mid-write leaves the old credentials rather than none.
- **A credential value is never taken from the command line and never
  printed back.** `stratus credential set` reads it from stdin, because a
  secret in argv is a secret in shell history and in every `ps` on the
  machine; `stratus credentials` reports names only.

## What a cloned repo cannot decide

The `plugins`, `approvals`, and `api` config blocks are read **only from a
trusted config** — the global `~/.stratus/config.json` or a file you
passed yourself. An auto-discovered project-local `stratus.config.json`
ships in any repository; which code runs in the daemon, who may approve
its tool calls, and which interface it binds are not decisions a clone
gets to make. ([Configuration](../reference/config.md))

Nor does a clone get to decide **where your key goes, or which key it is**:

- **`apiKeyEnv` is ignored from an untrusted config.** Choosing the
  variable is choosing which of the machine's secrets this process picks
  up, and `"apiKeyEnv": "AWS_SECRET_ACCESS_KEY"` in a cloned repository is
  not a provider setting. The provider's own default variable is used
  instead. `STRATUS_API_KEY_ENV` still names one — the environment is
  yours.
- **No key is sent to a `baseUrl` an untrusted config chose.** This held
  for a stored sign-in from the start; it now holds for an exported key
  too. A project pointing at a local model is a real setup, so the run is
  refused rather than quietly redirected to the official API — trust the
  file with `--config <path>`, or move the base URL into
  `~/.stratus/config.json`.

## What an agent can reach

- **A plugin resolves only the credentials its own manifest declares.**
  Installing two plugins does not let one read the other's key, even when
  the same agent allowlists both — the resolver a plugin is handed is bound
  to its manifest, and the agent's soul list applies behind it.
- **Two gates on every plugin-provided capability**: a trusted config
  enables the plugin, and the agent's own soul lists what it may call.
  The built-ins (echo, memory, delegation, schedules) register without a
  plugin, and a soul that omits `tools:` gets every registered tool — an
  empty `plugins` block is not an empty toolbox.
  ([Plugins](./plugins.md), [Tools](../guides/tools.md))
- **The daemon runs only `safe` tools unattended**; everything else is
  refused or asked of a configured human. ([Approvals](../guides/approvals.md))
- **Shell commands are judged individually**, control operators disqualify
  a command outright, and "Always allow" persists a scope minus its
  destructive forms. ([Shell commands](../guides/shell.md))
- **Network tools refuse local addresses** — loopback, RFC 1918,
  link-local, IPv6 unique-local, and their IPv4-mapped and NAT64
  spellings — validated on the connection, so a redirect or DNS answer
  cannot walk an agent into a metadata endpoint. ([Tools](../guides/tools.md))
- **Third-party text is labelled as such.** `web.search` results — titles
  and snippets written by whoever owns the page, selected by a ranker —
  come back in an envelope that says so. It is a label, not a defence
  against prompt injection, and it does not make acting on that text safe.
  ([Tools](../guides/tools.md#searching-the-web))
- **`tool-shell` and stdio MCP servers get a replaced environment**: the
  daemon's own env vars, where API keys live, are not there to read.

## What is written down

- **The daemon log is a trace, not a second transcript**: tool names,
  session ids, and memory entry ids — never prompts, replies, tool inputs,
  or shell command text. The one qualification: a failed session records
  the provider's error text verbatim, and providers quote the failing
  request — so skim a log before sharing it. ([Logs](../guides/logs.md))
- **No control API endpoint returns a secret.** Credential reads report
  presence, type, and bound endpoint; session reads strip the Anthropic
  raw-turn cache. Named credentials are not on that API at all yet — the
  CLI is the only way to add one. ([Control API](../../packages/control-api/README.md))
- **The daemon log records that a search ran and against which backend,
  never the query** — a query is user content, and the log is a trace
  rather than a second transcript.

## The network posture

The control API binds `127.0.0.1` and exists only when its package is
installed. Cookie-authenticated requests are origin-bound; bearer ones are
not, because a browser never attaches a bearer token on a page's behalf.
Reaching a machine from outside goes through a tunnel, not a public bind.
([Remote access](../guides/remote-access.md))
