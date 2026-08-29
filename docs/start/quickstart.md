# Quickstart

The fastest paths from an installed CLI to something answering. If you ran
[`stratus setup`](./setup.md), `stratus chat` already works; the paths below
need no setup at all, or show every setting spelled out.

## 1) Run the demo path — no account needed

The `demo` provider needs no account at all:

```bash
stratus run "say hello"
```

Or trigger the demo tool:

```bash
stratus run --prompt "please use the echo tool"
```

## 2) Open the local dashboard

```bash
stratus dashboard
```

The command prints the local URL and opens your default browser. With the
[control API and dashboard installed](../guides/remote-access.md) this is the
full web UI; without them it is a small smoke-test page.

## 3) Run a real provider path

`stratus setup` is the easy way in, but every setting has an env var and a
flag behind it. The flagship path is Claude via the official Anthropic SDK:

```bash
export ANTHROPIC_API_KEY=your-key
stratus run --provider anthropic "say hello"
```

The Claude provider defaults to `claude-opus-5` and handles multi-turn tool
calling, the agent's persona and memory, and adaptive thinking out of the
box.

Any OpenAI-compatible API works too:

```bash
export STRATUS_PROVIDER=openai
export OPENAI_API_KEY=your-key
export STRATUS_MODEL=gpt-4.1-mini
stratus run "say hello"
```

And so does Codex, on a ChatGPT subscription (`codex login` on the same
machine) or an OpenAI API key (`CODEX_API_KEY`) — `stratus setup` records
which. Codex is a harness with its own loop, not another chat-completions
endpoint; Stratus disables its native shell and web tools and serves the
agent's own tools to it under kernel policy
([`packages/provider-codex/README.md`](../../packages/provider-codex/README.md)
has the details):

```bash
stratus run --provider codex "say hello"
```

Or with a config file `stratus.config.json` (start from
[`stratus.config.json.example`](../../stratus.config.json.example)):

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "soul": "./examples/souls/ava.md"
}
```

Then:

```bash
export ANTHROPIC_API_KEY=your-key
stratus run "say hello"
```

## What you'll see

A run prints a short event log followed by the final session messages.

A text-only demo prompt looks like this:

```text
Starting Stratus Agent local loop with provider=demo
• session.created <id>
• session.updated running
• provider.response 1 part(s)
• session.updated completed
• session.completed <id>

Messages
[user] say hello
[assistant] Demo provider ready. Prompt received: say helloNo tool call was needed, so this run stays text-only. Mention "tool" or "echo" to trigger the demo tool.
```

A prompt that mentions `tool` or `echo` runs the full multi-turn loop: the
provider requests a tool, the tool executes locally, and the result goes back
to the provider for a final answer:

```text
• provider.response 2 part(s)
• tool.called demo.echo
• tool.completed demo.echo ok=true
• provider.response 1 part(s)
```

```text
[assistant] → tool call demo.echo({"text":"please use the echo tool"})
[tool:demo.echo] { "ok": true, "output": { "uppercase": "PLEASE USE THE ECHO TOOL", ... } }
[assistant] The demo.echo tool finished with: {"received":"please use the echo tool", ...}
```

The dashboard prints a line like this when it starts:

```text
Stratus Agent Dashboard ready at http://127.0.0.1:4123
Press Ctrl+C to stop.
Opened your default browser.
```

## Where next

- A persistent conversation: `stratus chat` — the session carries across
  turns and remembered facts accumulate ([Memory](../concepts/memory.md)).
- Run as a named identity: `stratus run --soul ./examples/souls/ava.md "hi"`
  ([Agents](../concepts/agents.md)).
- The whole roster, always on: [`stratus serve`](../guides/always-on.md) and
  [Slack](../guides/slack.md).
- Real capability — files, shell, web, browser: [Tools](../guides/tools.md).
