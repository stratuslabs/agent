# Setup

`stratus setup` is the whole onboarding, as a small navigable menu:

```
  1) Providers            anthropic — signed in with your Claude subscription
  2) Models               default claude-opus-5 · fallback gpt-4.1-mini
  3) Agent                ~/.stratus/agents/ava.md
  4) Plugins              tool-fs, tool-web
  5) Channels             Slack: 1 agent connected
  6) Approvals            remote — asks in Slack, approvers for 1 agent
  7) Always on            stratusd runs after setup, and at every login
  8) Test run             say hello with the current settings
  9) Save & finish
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
- **Plugins** — what your agents *can* do. The list shows each first-party
  package as installed, enabled, or neither; picking one installs it with
  `npm install -g` and enables it in the same step, writing the `plugins`
  block for you. Two things it deliberately will not do:
  - **Enable a plugin without the setting it is useless without.** `tool-fs`
    with no `roots` loads and then fails every call, so setup asks for them
    and writes nothing if you leave the answer blank — unless roots are
    already set per agent under `agents.<id>`, which is a working config and
    a narrower one than any fleet-wide answer, so that is kept as it is.
  - **Enable `plugin-mcp` from scratch.** It requires a `servers` block
    naming endpoints only you know, and a block written without one is
    refused at load. Setup says so and points at
    [Config](../reference/config.md). A block that already has `servers` is
    switched on and off like any other — the refusal is about the missing
    setting, not the package.

  Enabling is only the second of the two gates — the soul's `tools:` list is
  the other, and setup does not edit souls. What it prints depends on which
  it is: a soul with **no** `tools:` list is allowlisted for every registered
  tool, and the built-in `stratus` agent has none, so on a fresh install
  enabling a plugin makes its tools callable at the next daemon start and
  setup says exactly that, naming the agents. Where every soul has a list,
  it prints the line to paste instead. Either way `stratus plugins` shows
  who can call what. See [Tools](../guides/tools.md), and
  [github.com/stratuslabs/plugins](https://github.com/stratuslabs/plugins)
  for what else exists.
- **Channels** — put an agent on Slack without opening a file. Pick the
  agent, and setup prints the app manifest with their name already filled in,
  walks you through the two tokens (input hidden), verifies each against
  Slack before accepting it, and stores them where `stratus serve` looks. The
  list marks who is connected; picking a connected agent offers to replace
  their tokens or disconnect. See [Slack](../guides/slack.md).
- **Approvals** — what happens to a gated call with nobody watching.
  `headless` refuses it; **ask in Slack** parks the turn and asks an
  approver. Both halves are set on one screen because they are one decision:
  `remote` with nobody listed behaves exactly like `headless` — the call
  parks and the timeout denies it — so setup says that on the screen rather
  than leaving it to be discovered from a denied call. The agents offered are
  the ones **Channels** connected, since an agent Slack cannot reach is not
  one approvers can be named for. Two details it gets right so you don't
  have to:
  - **A fallback channel, not just approvers.** A turn that arrived through
    Slack is answered in its own thread, but one started by a schedule, a
    delegation, or the control API reaches the adapter with no destination
    and is denied undeliverable. Setup asks for the channel to use for those,
    and says plainly what you lose if you skip it.
  - **Inherited values stay inherited.** An agent with no list of its own
    uses the top-level `approvals.slackApprovers`, and the same goes for
    `slackChannel`; the row marks those as *(inherited)*, and keeping a
    value leaves it inheriting rather than freezing today's setting as that
    agent's own override.
  - **Clearing a list never widens one.** With a top-level list in play,
    emptying an agent's approvers writes the explicit `[]` that *excludes*
    it, rather than deleting the key and handing it the global list. The
    fallback channel has no such per-agent opt-out: clearing it moves the
    agent onto the top-level channel, and setup says so and names it
    instead of claiming the agent has no fallback.

  See [Approvals](../guides/approvals.md).
- **Always on** — whether the roster keeps answering once you close the
  terminal. On by default, because an agent you have to remember to start is
  not always-on, and every Slack app you connected above stays silent until
  `stratusd` runs. Save & finish installs it (see
  [Always on](../guides/always-on.md)); choose *do not run it for me* and
  setup removes any service it previously installed. If that install — or
  that removal — fails, setup **exits non-zero**: it still saves everything
  and prints what went wrong, but a daemon that will not come up at login,
  or one that will come up after you said not to run it, is not a successful
  setup. `stratus service install` and `stratus service uninstall` answer the
  same way for the same failures.
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
- **A failed package install never fails setup.** Your config and credentials
  are already written; you get npm's exit code and the command to run
  yourself, and setup's own exit code is unaffected. The always-on *service*
  is the exception, and the bullet above says why.

Setup only suggests `stratus dashboard` at the end when it can actually
work — a machine that skipped or failed that install is not told to run a
command that would exit with an error.

## Where everything lands

Credentials are stored in `~/.stratus/credentials.json` (owner-read-only)
and settings in `~/.stratus/config.json`, so `stratus run` works from any
directory afterwards. No env vars to export, no config files to hand-edit. A
project-local `stratus.config.json` still wins when present, and env vars
outrank both — see [Configuration](../reference/config.md).

Re-running setup **edits** that file rather than rewriting it. The keys it
has no menu for are read in and written back untouched — the `api` and
`principals` blocks, plus the `vision`, `promptCache`, and `promptCacheTtl`
preferences — so a capability you granted an agent by hand survives the next
time you change a model. It did not always: setup rebuilt the file from its
own menus, and everything it had no menu for was deleted by a run that never
mentioned it.

The `plugins` and `approvals` blocks now have menus, and those menus edit
what was read rather than replacing it: settings you wrote by hand under a
plugin setup did not ask about — `agents` overrides, `toolRisks`, a
`timeoutMs` — are still there after enabling or disabling something.
