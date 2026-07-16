# Stratus Agent

Stratus Agent is a tiny JavaScript agent runtime and CLI.

Right now, the best way to try it is a local loop in the terminal or a minimal local dashboard. You can run prompts through the CLI, watch session and tool events, and open a lightweight browser surface for local testing.

## What it includes

- `@stratusagent/core`, the runtime primitives and agent loop
- `@stratusagent/providers`, helpers for building model providers
- `@stratusagent/executors`, helpers for execution behavior
- `@stratusagent/executor-local`, a concrete local child-process executor adapter
- `@stratusagent/cli`, the local CLI entrypoint

## Current status

This repo is early, but the core loop is complete.

Today it is useful for:
- running a multi-turn agent loop locally: provider → tools → provider until the model finishes
- running real tool-calling sessions against an OpenAI-compatible provider (tools are advertised with JSON schemas, tool calls execute locally, and results are fed back to the model)
- gating tool execution with an approval policy (`--approvals always|ask|never`)
- continuing an existing session with follow-up user messages via `runner.resume()`
- opening a tiny local dashboard for browser-based smoke testing
- seeing how provider output becomes session events

It is not yet a full production agent platform: durable storage, remote executors, vendor SDK adapters, and retries/queues remain out of scope for v1 (see `docs/architecture/stratus-v1.md`).

## Local setup (fresh machine)

Stratus Agent needs **Node.js 22.6+** (the test runner uses `--experimental-strip-types`) and **pnpm 10**.

On macOS:

```bash
brew install node             # installs the latest Node, which satisfies >= 22.6
# or, to pin the Node 22 line: nvm install 22
# (avoid `brew install node@22` — it is keg-only, so node/corepack won't be on PATH without extra steps)
corepack enable && corepack prepare pnpm@10.18.3 --activate
```

On Linux, install Node 22 from your package manager or nvm, then enable corepack the same way.

Then clone and verify the toolchain end to end:

```bash
git clone https://github.com/stratuslabs/agent.git && cd agent
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test
```

If the test suite is green you're ready for the Quickstart below. To configure a provider, run the interactive walkthrough:

```bash
node packages/cli/dist/bin.js setup
```

It asks a few questions (provider, model, base URL, which env var holds your API key), writes `stratus.config.json`, and prints the exact commands to run next. Prefer doing it by hand? Copy `stratus.config.json.example` instead. Either way the file is gitignored, so your local provider settings never end up in a commit.

Once the packages are published to npm, this whole section becomes two commands:

```bash
npm install -g @stratusagent/cli
stratus setup
```

## Quickstart

### 1) Install dependencies

```bash
pnpm install
```

### 2) Build the workspace

```bash
pnpm build
```

### 3) Run the demo path

Use the built CLI directly:

```bash
node packages/cli/dist/bin.js run "say hello"
```

Or trigger the demo tool:

```bash
node packages/cli/dist/bin.js run --prompt "please use the echo tool"
```

### 4) Open the local dashboard

```bash
node packages/cli/dist/bin.js dashboard
```

The command prints the local URL, opens your default browser, and exposes a tiny `/api/echo` endpoint that the page can exercise.

### 5) Run a real provider path

With environment variables:

```bash
export STRATUS_PROVIDER=openai
export OPENAI_API_KEY=your-key
export STRATUS_MODEL=gpt-4.1-mini
pnpm cli run "say hello"
```

Or with a config file `stratus.config.json` (start from `stratus.config.json.example`):

```json
{
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

Then:

```bash
export OPENAI_API_KEY=your-key
pnpm cli run "say hello"
```

Legacy `STRATUSCLAW_*` env vars and `stratusclaw.config.json` still work for compatibility.

## What you’ll see

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
[assistant] Demo provider ready. Prompt received: say helloNo tool call was needed, so this run stays text-only. Mention “tool” or “echo” to trigger the demo tool.
```

A prompt that mentions `tool` or `echo` runs the full multi-turn loop: the provider requests a tool, the tool executes locally, and the result goes back to the provider for a final answer:

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

## CLI usage

```bash
stratus run --prompt "Use the demo tool"
stratus run "Say hello"
stratus run --provider openai --model gpt-4.1-mini "Say hello"
stratus dashboard
stratus dashboard --port 4123 --host 127.0.0.1 --no-open
```

Current options:

- `--prompt`, `-p`, pass the prompt explicitly
- `--stdin`, read the prompt from stdin
- `--provider`, choose `demo` or `openai`
- `--model`, set the model for real providers
- `--base-url`, override the OpenAI-compatible API base URL
- `--config`, load provider settings from a JSON config file
- `--format`, choose `text` or `json`
- `--no-events`, hide event logs in text mode
- `--approvals`, tool approval mode: `always`, `ask` (interactive y/N prompt), or `never`
- `--max-turns`, maximum provider turns per run (default: 8)
- `--port`, set the dashboard port
- `--host`, set the dashboard host
- `--no-open`, skip automatic browser opening
- `--help`, `-h`, show help

If you are running from the repo without installing the CLI globally, use:

```bash
node packages/cli/dist/bin.js run "Say hello"
node packages/cli/dist/bin.js dashboard
```

## Repo shape

```text
packages/
  cli/
  core/
  executor-local/
  executors/
  providers/
docs/
  architecture/
```

## Development commands

```bash
pnpm build
pnpm typecheck
pnpm test
```

## Where this is headed

Near term, Stratus Agent is aiming to stay small and understandable while the runtime pieces settle.

Expect the CLI to keep improving first. Broader provider, executor, and runtime capabilities can grow from there.

If you want the deeper design notes, see `docs/architecture/stratus-v1.md`.
