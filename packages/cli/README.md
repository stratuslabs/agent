# @stratusagent/cli

Stratus Agent CLI — create always-on agents that get smarter over time. Quickly set up Stratus Agent on your machine, create new agents, connect AI providers, and configure channels.

## Install

```bash
npm install -g @stratusagent/cli
stratus setup
```

`stratus setup` is the whole onboarding, as a small navigable menu:

```
  1) Providers            anthropic — signed in with your Claude subscription
  2) Models               default claude-opus-5 · fallback gpt-4.1-mini
  3) Agent                ~/.stratus/agents/ava.md
  4) Test run             say hello with the current settings
  5) Save & finish
```

- **Providers** — sign in to one or more. For Claude, use an **Anthropic API key**, pasted straight into the prompt (input is hidden) and checked against the live API when the endpoint supports it — a rejected key is refused; an unreachable endpoint saves the key and verifies it on your first run. A **Claude Pro/Max subscription** sign-in (via `claude setup-token`) can be stored today, but subscription-billed runs arrive with the Claude Code integration ([#25](https://github.com/stratuslabs/agent/issues/25)) — until then, runs need an API key. OpenAI-compatible services work like API keys, including local models and proxies via a custom base URL.
- **Models** — pick a **default** and a **fallback**, listed live from the provider APIs where possible (subscription sign-ins and offline setups fall back to the known Claude lineup). If the default model errors mid-run, the run automatically retries on the fallback — even across providers.
- **Menus are keyboard-driven** — arrow keys (or `j`/`k`) to move, Enter to pick, digits to jump, Esc to go back.
- **Agent** — name your agent (or accept a generated identity), describe their personality, and their soul file lands in `~/.stratus/agents/`, ready to edit.
- **Test run** — say hello with the current settings before saving anything.

Credentials are stored in `~/.stratus/credentials.json` (owner-read-only) and settings in `~/.stratus/config.json`, so `stratus run` works from any directory afterwards. No env vars to export, no config files to hand-edit.

## Usage

```bash
stratus run "say hello"
stratus run --soul ./ava.md "introduce yourself"
stratus run --provider anthropic --model claude-opus-5 "hello"
stratus run --prompt "use the echo tool" --format json
stratus agent new                      # generate an agent identity
stratus agent new --format soul > ava.md
stratus dashboard                      # local browser dashboard
```

## Agents are people

An agent's identity lives in a **soul file** — markdown with frontmatter for the structured parts (name, provider, model, tool allowlists) and prose for the personality:

```markdown
---
name: Ava
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
  - memory.remember
---

You are a sharp, warm generalist. Answer first, explain second...
```

Agents remember: facts saved with the built-in `memory.remember` tool persist to `~/.stratus/memory.jsonl`, keyed to the agent — so the Ava you talk to tomorrow remembers today, from any directory.

## Options

| Flag | Purpose |
| --- | --- |
| `--soul <file>` | Run as the agent defined by a soul file (also `STRATUS_SOUL` / config `soul` key) |
| `--provider` | `anthropic`, `openai`, or `demo` (offline, no account) |
| `--model` | Model for real providers (anthropic default: `claude-opus-5`) |
| `--base-url` | Override the provider API base URL |
| `--config <file>` | Load settings from a specific config file |
| `--approvals` | Tool approval mode: `always`, `ask`, or `never` |
| `--max-turns` | Max provider turns per run (default 8) |
| `--format` | `text` or `json` |

Precedence: flags → `STRATUS_*` env vars → soul file hints → config file. Project-local `stratus.config.json` outranks the global `~/.stratus/config.json`; stored sign-ins are endpoint-bound and never sent to endpoints a project config selects.

Today the CLI covers setup, one-shot runs, agent creation, and the local dashboard; channels and the always-on agent service are the next milestones.

Part of [Stratus Agent](https://github.com/stratuslabs/agent) — a tiny TypeScript agent runtime.
