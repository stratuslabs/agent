# Stratus

Stratus is a tiny JavaScript agent runtime and CLI.

Right now, the best way to try it is a local loop in the terminal or a minimal local dashboard. You can run prompts through the CLI, watch session and tool events, and open a lightweight browser surface for local testing.

## What it includes

- `@stratuslabs/core`, the runtime primitives and agent loop
- `@stratuslabs/providers`, helpers for building model providers
- `@stratuslabs/executors`, helpers for execution behavior
- `@stratuslabs/cli`, the local CLI entrypoint

## Current status

This repo is early.

Today it is useful for:
- running the demo agent loop locally
- running a single text-only session against a real OpenAI-compatible provider
- opening a tiny local dashboard for browser-based smoke testing
- seeing how provider output becomes session events
- seeing a simple tool call execute end to end in demo mode

It is not yet a full production agent platform.

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

Or with a config file `stratus.config.json`:

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
Starting Stratus local loop with provider=demo
• session.created <id>
• session.updated running
• provider.response 1 part(s)
• session.updated completed
• session.completed <id>

Messages
[user] say hello
[assistant] Demo provider ready. Prompt received: say helloNo tool call was needed, so this run stays text-only. Mention “tool” or “echo” to trigger the demo tool.
```

A prompt that mentions `tool` or `echo` will also show tool events and a tool message in the session:

```text
• provider.response 3 part(s)
• tool.called demo.echo
• tool.completed demo.echo ok=true
```

The dashboard prints a line like this when it starts:

```text
Stratus Dashboard ready at http://127.0.0.1:4123
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

Near term, Stratus is aiming to stay small and understandable while the runtime pieces settle.

Expect the CLI to keep improving first. Broader provider, executor, and runtime capabilities can grow from there.

If you want the deeper design notes, see `docs/architecture/stratus-v1.md`.
