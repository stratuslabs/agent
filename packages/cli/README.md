# @stratusagent/cli

The Stratus Agent CLI — create agents that feel like people, sign in to Claude or any OpenAI-compatible provider from a menu, and run real tool-calling sessions from your terminal.

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

- **Providers** — sign in to one or more. For Claude, choose how you pay: your **Claude Pro/Max subscription** (sign in through Claude Code: run `claude setup-token` and paste the token) or an **Anthropic API key**, pasted straight into the prompt (input is hidden) and verified against the live API before it is accepted. OpenAI-compatible services work the same way, including local models and proxies via a custom base URL.
- **Models** — pick a **default** and a **fallback** from the models your sign-ins can actually reach, fetched live from the provider APIs. If the default model errors mid-run, the run automatically retries on the fallback — even across providers.
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

Agents remember: facts saved with the built-in `memory.remember` tool persist to `.stratus/memory.jsonl`, keyed to the agent — so the Ava you talk to tomorrow remembers today, in any directory, on any channel.

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

Part of [Stratus Agent](https://github.com/stratuslabs/agent) — a tiny TypeScript agent runtime.
