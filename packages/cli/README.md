# @stratusclaw/cli

Thin local entrypoint for exercising the StratusClaw kernel without pulling product UI concerns into the runtime.

## Local usage

From the repo root:

```bash
pnpm install
pnpm cli run "say hello"
pnpm cli run --prompt "please use the echo tool"
echo "please inspect this with the echo tool" | pnpm cli run --stdin
pnpm cli run --prompt "please use the echo tool" --format json
```

## Real provider usage

You can now run the CLI against an OpenAI-compatible API instead of only the demo provider.

### Environment-only setup

```bash
export STRATUSCLAW_PROVIDER=openai
export OPENAI_API_KEY=your-key
export STRATUSCLAW_MODEL=gpt-4.1-mini
pnpm cli run "Say hello"
```

Optional:

```bash
export STRATUSCLAW_BASE_URL=https://openrouter.ai/api/v1
```

### Config file setup

Create `stratusclaw.config.json` in the repo root, or pass `--config`:

```json
{
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

Then run:

```bash
export OPENAI_API_KEY=your-key
pnpm cli run "Say hello"
```

## What it does today

- runs a single local session against either the demo provider or an OpenAI-compatible provider
- shows event progress in text mode
- executes the built-in `demo.echo` tool in demo mode
- can emit the full session as JSON for scripts and fixtures

## Notes

- `pnpm cli ...` runs the TypeScript source directly, so local testing does not require a pre-build step
- `pnpm demo` is still the quickest smoke test for the demo path
- real provider mode is text-only for now, it does not expose tool calling yet
