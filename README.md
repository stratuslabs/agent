# StratusClaw

StratusClaw is a tiny JavaScript agent runtime and CLI.

Right now, the best way to try it is a local demo loop in the terminal. You give it a prompt, it runs a small in-memory agent flow, and you can watch session and tool events as they happen.

## What it includes

- `@stratusclaw/core` — the runtime primitives and agent loop
- `@stratusclaw/providers` — helpers for building model providers
- `@stratusclaw/executors` — helpers for execution behavior
- `@stratusclaw/cli` — the local CLI demo

## Current status

This repo is early.

Today it is useful for:
- running a local demo agent loop
- seeing how provider output becomes session events
- seeing a simple tool call execute end to end

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

### 3) Run the CLI demo

Use the built CLI directly:

```bash
node packages/cli/dist/bin.js run "say hello"
```

Or trigger the demo tool:

```bash
node packages/cli/dist/bin.js run --prompt "please use the echo tool"
```

You can also run help:

```bash
node packages/cli/dist/bin.js --help
```

## What you’ll see

A run prints a short event log followed by the final session messages.

A text-only prompt looks like this:

```text
Starting StratusClaw local loop with provider=demo
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

## CLI usage

```bash
stratusclaw run --prompt "Use the demo tool"
stratusclaw run "Say hello"
```

Current options:

- `--prompt`, `-p` — pass the prompt explicitly
- `--provider` — currently only `demo` is supported
- `--help`, `-h` — show help

If you are running from the repo without installing the CLI globally, use:

```bash
node packages/cli/dist/bin.js run "Say hello"
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

Near term, StratusClaw is aiming to stay small and understandable while the runtime pieces settle.

Expect the local CLI demo to keep improving first. Broader provider, executor, and runtime capabilities can grow from there.

If you want the deeper design notes, see `docs/architecture/stratusclaw-v1.md`.
