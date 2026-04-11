# @stratusagent/cli

Thin local entrypoint for exercising the Stratus Agent kernel without pulling product UI concerns into the runtime.

## Local usage

From the repo root:

```bash
pnpm install
pnpm cli run "say hello"
pnpm cli run --prompt "please use the echo tool"
echo "please inspect this with the echo tool" | pnpm cli run --stdin
pnpm cli run --prompt "please use the echo tool" --format json
pnpm cli dashboard
pnpm cli dashboard --port 4123 --no-open
```

## Real provider usage

You can run the CLI against an OpenAI-compatible API instead of only the demo provider.

### Environment-only setup

```bash
export STRATUS_PROVIDER=openai
export OPENAI_API_KEY=your-key
export STRATUS_MODEL=gpt-4.1-mini
pnpm cli run "Say hello"
```

Optional:

```bash
export STRATUS_BASE_URL=https://openrouter.ai/api/v1
```

### Config file setup

Create `stratus.config.json` in the repo root, or pass `--config`:

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

Legacy `STRATUSCLAW_*` env vars and `stratusclaw.config.json` are still accepted.

## Dashboard

`stratus dashboard` starts a small local server, prints the URL, opens your browser, and serves:

- `GET /`, a simple Stratus Agent dashboard page
- `GET /api/status`, a basic status payload
- `POST /api/echo`, a tiny local test endpoint used by the page

This is intentionally dependency-light and built on Node standard library primitives.

## What it does today

- runs a single local session against either the demo provider or an OpenAI-compatible provider
- shows event progress in text mode
- executes the built-in `demo.echo` tool in demo mode
- can emit the full session as JSON for scripts and fixtures
- serves a minimal dashboard for browser-based local smoke tests

## Notes

- `pnpm cli ...` runs the TypeScript source directly, so local testing does not require a pre-build step
- `pnpm demo` is still the quickest smoke test for the demo path
- real provider mode is text-only for now, it does not expose tool calling yet
