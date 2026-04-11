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

## What it does today

- runs a single local session against the demo provider
- shows event progress in text mode
- executes the built-in `demo.echo` tool when the prompt asks for it
- can emit the full session as JSON for scripts and fixtures

## Notes

- `pnpm cli ...` runs the TypeScript source directly, so local testing does not require a pre-build step
- `pnpm demo` is a quick smoke test for the happy path
- provider selection is intentionally constrained to `demo` in this first slice
