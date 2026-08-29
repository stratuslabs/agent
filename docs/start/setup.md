# Setup

`stratus setup` is the whole onboarding, as a small navigable menu:

```
  1) Providers            anthropic — signed in with your Claude subscription
  2) Models               default claude-opus-5 · fallback gpt-4.1-mini
  3) Agent                ~/.stratus/agents/ava.md
  4) Channels             Slack: 1 agent connected
  5) Always on            stratusd runs after setup, and at every login
  6) Test run             say hello with the current settings
  7) Save & finish
```

Menus are keyboard-driven — arrow keys (or `j`/`k`) to move, Enter to pick,
digits to jump, Esc to go back.

- **Providers** — sign in to one or more. For Claude, choose how you pay: a
  **Claude Pro/Max subscription** (run `claude setup-token`, paste the token —
  runs route through the Claude Code runtime, so your plan covers usage;
  requires Claude Code installed and signed in. Tool runs and memory work
  there too, so it's the same agent as on an API key) or an **Anthropic API
  key**, pasted straight into the prompt (input is hidden) and checked
  against the live API when the endpoint supports it — a rejected key is
  refused; an unreachable endpoint saves the key and verifies it on your
  first run. OpenAI-compatible services work like API keys, including local
  models and proxies via a custom base URL. **Codex (ChatGPT)** works either
  way too: pick the ChatGPT subscription (uses this machine's own
  `codex login` sign-in — Stratus records the choice and never touches
  codex's tokens) or paste an OpenAI API key, verified against the platform
  and passed to codex as `CODEX_API_KEY`. Runs route through the Codex
  harness with its native shell and web tools disabled, so it is the same
  agent under the same kernel policy as every other provider.
- **Models** — pick a **default** and a **fallback**, listed live from the
  provider APIs where possible (subscription sign-ins and offline setups fall
  back to the known Claude lineup, and codex always lists its known harness
  lineup — no endpoint serves it). If the default model errors mid-run, the
  run automatically retries on the fallback — even across providers.
- **Agent** — name your agent (or accept a generated identity), describe
  their personality, and their soul file lands in `~/.stratus/agents/`, ready
  to edit. See [Agents](../concepts/agents.md) for what a soul is.
- **Channels** — put an agent on Slack without opening a file. Pick the
  agent, and setup prints the app manifest with their name already filled in,
  walks you through the two tokens (input hidden), verifies each against
  Slack before accepting it, and stores them where `stratus serve` looks. The
  list marks who is connected; picking a connected agent offers to replace
  their tokens or disconnect. See [Slack](../guides/slack.md).
- **Always on** — whether the roster keeps answering once you close the
  terminal. On by default, because an agent you have to remember to start is
  not always-on, and every Slack app you connected above stays silent until
  `stratusd` runs. Save & finish installs it (see
  [Always on](../guides/always-on.md)); choose *do not run it for me* and
  setup removes any service it previously installed.
- **Test run** — say hello with the current settings before saving anything.
- **Save & finish** — writes everything, offers any optional package your
  choices imply, then installs the always-on service.

## What Save & finish offers

The CLI ships no transport and no open port, so a fresh machine finishes
setup missing the packages its own answers just asked for. Setup knows that
before the daemon does — it stored the Slack tokens itself — so
**Save & finish** names what is missing and offers to install it:

```text
2 optional packages are not installed:
  @stratusagent/channel-slack
    Slack tokens are stored for 1 agent(s), but nothing connects to Slack without it.
  @stratusagent/control-api @stratusagent/dashboard
    `stratus dashboard` needs it, and it opens an authenticated port on 127.0.0.1.

Install now with npm install -g?
> Install all of them now
  Install the Slack channel only
  Install the Web dashboard only
  Skip
```

Three things about it worth knowing:

- **It asks, and anything left uninstalled prints its command** — whether you
  skipped the offer entirely or took only one of the two, since choosing one
  group is not a decision about the other. The control API binds a port, and
  installing it is how an operator says they want one open, so this stays a
  question rather than a default.
- **It runs before the service install**, so the LaunchAgent comes up with
  those packages already present. A package installed *after* a daemon starts
  is invisible to it; that ordering is the whole reason the offer lives here
  rather than in a closing hint.
- **A failed install never fails setup.** Your config and credentials are
  already written; you get npm's exit code and the command to run yourself.

Setup only suggests `stratus dashboard` at the end when it can actually
work — a machine that skipped or failed that install is not told to run a
command that would exit with an error.

## Where everything lands

Credentials are stored in `~/.stratus/credentials.json` (owner-read-only)
and settings in `~/.stratus/config.json`, so `stratus run` works from any
directory afterwards. No env vars to export, no config files to hand-edit. A
project-local `stratus.config.json` still wins when present, and env vars
outrank both — see [Configuration](../reference/config.md).
