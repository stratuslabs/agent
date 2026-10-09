---
name: stratus
description: Use whenever someone asks how Stratus itself works or how to set something up in it, such as where a config, credential, soul, log, or workspace lives, how to give you an API key or a new tool, why you can or cannot do something, what you remember and how to make you forget it, why a reply stopped partway or came from another model, which version is running, which stratus command does what, or how Slack, approvals, plugins, or the daemon behave. Read it before you search files or guess.
---

# How Stratus works

You run inside Stratus: a daemon (`stratusd`, started by `stratus serve`) that hosts a roster of agents, connects them to channels like Slack, and runs their tools. This is the map of that system, so you can answer questions about your own setup accurately and ask your operator for exactly the right thing.

Check your instructions first. They name your id, your soul file, your workspace, the model answering as you, the credentials you hold (by name), the tools you have, and the room you are talking in. Those facts are about *you*, now, and they beat anything general below.

Four rules for using what follows:

- **Say what you can check, and check it.** When a question is about this install (is a plugin enabled, is a key stored, why a setting isn't taking), the answer is in a command your operator can run. Give the command rather than a guess, and never promise an ability you do not have yet: say what you will be able to do once the step is done.
- **Never ask anyone to paste a secret into a conversation**, and never offer to store one you were given in chat. If someone pastes one anyway, do not repeat it and never `memory.remember` it. Tell them it is now in the conversation, your transcript, and the model provider's request, so it should be rotated, and give them the safe way to store the new one.
- **Mind the room.** Your instructions say whether this is a direct message or a channel, and everyone in a channel reads what you post. A credential link, someone's private settings, or anything else meant for one person never goes into a shared channel. You cannot open a direct message yourself, so ask the person to message you directly and give it to them there.
- **Your tools run on the machine the daemon runs on**, not necessarily the computer of the person you are talking to. You cannot tell which from inside, so ask before promising access to "my laptop" or "my files".

## Where things live

Everything is under `~/.stratus/` on the daemon's machine:

| Path | What it is |
| --- | --- |
| `config.json` | The global config, and the trusted one (see "Config"). `0600`, because a plugin's config in it can hold secrets such as `tool-shell`'s `env`, and every save keeps it that way; `stratus doctor` flags one other users can read |
| `credentials.json` | Provider sign-ins, channel secrets (Slack's tokens and any channel plugin's, under `channels.<kind>.<agentId>`), and named credentials. `0600`, and kept that way by Stratus, which is why it is edited with `stratus credential set` and `stratus channel set` rather than by hand |
| `agents/<file>.md` | A soul: one agent's identity and allowlists. The file name is not the id; the id is the soul's `id:`, or derived from its `name:`. Use the id your instructions give |
| `agents/<id>/` | That agent's state: `sessions.db`, `memory.jsonl`, `whitelist.json` (its standing approvals), and `workspace/` |
| `agents/<id>/workspace/` | The agent's own working directory, where `shell.run` starts by default |
| `fleet.db` | Schedules, and the index of every session |
| `skills/<id>/SKILL.md` | Skills the operator installed |
| `plugins/<package>/` | What a plugin keeps across restarts, such as a channel's read position. `0700` |
| `logs/stratusd.jsonl` | The daemon's structured log, read with `stratus logs` |
| `gateway.json`, `gateway-token` | Where the control API is listening, and its bearer token. `0600` |
| `stratusd.lock` | The running daemon's claim on this home: one daemon per home |

Deleting a soul file takes the agent off the roster but keeps its `agents/<id>/` state, its standing approvals included (a new agent given the same id inherits them), and its schedules in `fleet.db`. Deleting `agents/<id>/` erases its history, memories, grants, and files.

## Your soul

A soul is a markdown file: frontmatter for identity and allowlists, then the persona as prose.

- `name`; `id` (derived from the name when absent, so renaming a soul with no `id:` changes it too; a changed id starts the agent fresh, and its old history, memories, and grants stay under the old id); `provider` and `model`; `language` (for example `en-GB`); `listens` (see "Slack").
- `tools:` is the allowlist of what you may call: exact names (`fs.read`) or toolset globs (`fs.*`). Omitted means every registered tool and `tools: []` means none. When you lack a tool, ask for that one name to be added. Never suggest deleting the list to fix it, because that grants every tool, the shell included.
- `skills:` enables skills. Omitted means none, except built-in skills like this one, which every agent has.
- `credentials:` names the credentials you may use. Omitted means none.
- `delegates:` names the agents `agent.delegate` may hand work to (`*` for anyone). Omitted means nobody.

Under `stratus serve` the daemon reads your soul again before every turn, so an edit reaches your next reply with no restart. Its contents are already in your instructions; there is nothing to open. A *new* soul file, or a deleted one, needs the roster reloaded: the dashboard and the control API do it (`POST /api/v1/roster/reload`), and so does `stratus restart`.

## Config

The config decides which provider and model run, which plugins load, and how approvals work. The file is the one `--config` or `STRATUS_CONFIG` names, else a `stratus.config.json` in the directory the daemon started in (for the service, wherever `stratus service install` ran), else `~/.stratus/config.json`.

Which provider and model a turn uses: for `stratus run` and `stratus chat`, command-line flags beat `STRATUS_*` environment variables, which beat the soul's `provider`/`model`, which beat the file. Under `stratus serve` a soul's `provider`/`model` beats all of those, because each agent in a roster runs on its own. A changed `provider` or `model` in the config reaches the next turn without a restart.

A project-local `stratus.config.json` ships inside repositories, so it is **untrusted**. It cannot set `plugins`, `approvals`, `principals`, `slack`, `api`, `maxTurns`, `agentMaxTurns`, `apiKeyEnv`, `soul`, `systemPrompt`, `executor`, or `memoryStore`. Those are read only from `~/.stratus/config.json` or a file named by `--config` or `STRATUS_CONFIG`. A project-local file that sets one of them has it ignored, with a warning. For `principals`, `slack`, `maxTurns`, `executor`, and `memoryStore` the daemon uses `~/.stratus/config.json`'s instead; for `plugins`, `approvals`, and `api` it uses none. A project-local file that says nothing about one of those eight leaves the global one in force.

When a setting "isn't taking", these say why:

- `stratus doctor` shows what `stratus run` and `stratus chat` would use, and which file or variable decided each value.
- `stratus agents` shows what each agent on the roster runs on.
- `stratus plugins` shows what the config's approvals mode does with each tool. `stratus serve --approvals` overrides that mode. A daemon in `remote` logs an `approvals: remote` line at startup, so a `stratus logs` with no such line since the last start means `headless`.

## Credentials and API keys

This is the question you will be asked most. A secret reaches Stratus in one of four ways, and which one depends on what uses it:

- **Provider sign-ins** (the model's own key or subscription): `stratus setup` → Providers, or the dashboard. There is no `stratus login`.
- **Channel tokens** (a Slack app's tokens): `stratus setup` → Channels, or the dashboard. No agent can read them, yours included.
- **Named credentials**, such as `search.apiKey`, are for tools whose plugin declares that name. A web search backend is the common one: its key is always `search.apiKey`, whatever the vendor. These are the only secrets you can ask for yourself.
- **A shell command's or an MCP server's token** is not a named credential: `shell.run` and MCP servers never read the credential store. Your operator puts it in the trusted config at the machine, and the daemon needs a restart:
  - for the shell, in `@stratusagent/tool-shell`'s `env`, under `agents.<id>` to keep it to one agent (whose commands can then read it). An agent's `env` is added to the shared one rather than replacing it, its own names win, and a name set to `null` there is withheld from that agent;
  - for an MCP server, in `servers.<name>.headers` (HTTP) or `servers.<name>.env` (stdio), which every agent granted `mcp.<name>.*` uses. Its replies are labelled `external`, and so is everything you remember after reading them, unless the operator sets `servers.<name>.outputTrust` to `agent` (or `unknown`) for a server they run; never `user`.

  `passEnv` beside them forwards variables, values included, from the daemon's own environment, and only ones that are not secret belong on it.

For a named credential to reach you, three things must all be true. It is **stored**, your soul's `credentials:` **lists its name**, and a tool you have **declares it**. Storing grants nothing by itself. You never see the value, and there is no file or variable for you to look in. Stored entries are read before an environment variable of the same name, and your own entry before a shared one.

When you need a named credential you do not hold, first make sure a tool you have uses that name. A key no tool reads does nothing once stored; if what you need is a tool, say which plugin or tool is missing instead. Then:

1. **Ask with `credential.request`**, if your `tools:` covers it (a daemon tool; the built-in `stratus` agent, which has no soul, cannot use it). Give the `name` the tool expects, a one-sentence `reason`, and a `scope`: `agent` (yours alone, the default) or `shared` (one value stored for the whole fleet, but still granted only to you; another agent needs the name in its own soul).
   - **A form**, in Slack, goes up in this conversation when one of `approvals.slackApprovers` can see it: a public channel, a private one with an approver in it, or a direct message with an approver.
   - **A link** comes back otherwise, or when you pass `via: "link"`. It needs the control API, and without `api.publicUrl` it opens only on the daemon's machine. Anyone who has the link can set the key, once, within 30 minutes, with no approver involved, and opening it spends nothing. So give it only to your operator. In a shared channel, or a direct message with anyone else, do not post it: ask your operator to message you directly, and ask again there. Pass `via: "form"` to get a form or nothing.
   - Either way the key goes straight to the store and the name into your soul, and you can use it from your next reply. A restart cancels a request still waiting.
2. **Otherwise, ask your operator to run, on the machine:**

   ```
   read -rs KEY && printf %s "$KEY" | stratus credential set <name> --agent <your id>
   ```

   (leave out `--agent` for a shared one), and to add `<name>` to `credentials:` in your soul.

Away from the machine, named credentials are **add-only**: the control API, the Slack form, and the link can add a name nobody has stored, and refuse one already stored or supplied by the daemon's environment. Replacing or removing one is `stratus credential set` or `stratus credential remove` at the machine, because a replaced shared key moves every agent using it onto another account. `stratus credentials` lists the names stored, shared and per agent, never the values.

A stored named credential or provider key takes effect on the next turn, with no restart. One that comes from an environment variable is fixed when the daemon starts, and the background service does not read a shell profile.

When a stored key "isn't found", check in this order:

1. Is the name in your `credentials:`?
2. Does a tool you have use it? The plugin's README names what it reads.
3. Is it stored under that exact name, shared or for you (`stratus credentials`)?

## Tools, plugins, and approvals

- **Built in everywhere:** `memory.*` (remember, recall, forget, pin) and `skill.read`, which every agent has because this skill counts. **Only under the daemon:** `schedule.*`, `message.send`, `message.read`, `agent.delegate`, and `credential.request`, so `stratus run` and `stratus chat` cannot call them.
- **Plugins** add the rest, each installed with `npm install -g <package>` and enabled under `plugins` in the trusted config:
  - `@stratusagent/tool-fs` gives `fs.*`, inside configured roots only, so with no roots there is no filesystem. Whatever the roots, `fs.*` never reaches `~/.stratus` outside the agents' workspaces (credentials, config, logs, sessions, memories, souls, skills, grants), so a refusal there is by design, not a roots problem. Roots go in `"@stratusagent/tool-fs": { "enabled": true, "roots": ["~/notes"] }`, or under `"agents": { "<id>": { "roots": [...] } }` for one agent.
  - `@stratusagent/tool-shell` gives `shell.run`.
  - `@stratusagent/tool-web` gives `web.fetch`. `web.search` is not first-party: it comes from a search backend plugin someone else publishes, and needs `search.apiKey`.
  - `@stratusagent/tool-browser` gives `browser.*`.
  - `@stratusagent/plugin-mcp` gives an MCP server's tools as `mcp.<server>.<tool>`.
- `stratus setup` → Plugins installs, enables, and asks for settings like roots in one step.
- Enabled is not granted: your soul's `tools:` must also cover a plugin's tools. `stratus plugins` walks the whole chain for each tool (installed, enabled, granted to which agents, and what approvals do with a call), so it answers "why can't you use X" in one command.
- **Risk.** Every tool is `safe`, `gated`, or `dangerous`. The daemon runs `safe` tools unattended, among them `memory.*`, `skill.read`, `credential.request`, `agent.delegate`, `schedule.list`, `schedule.cancel`, and `fs.read`, `fs.list`, and `fs.search`. Gated tools include:
  - `web.fetch`, `fs.write`, `shell.run`, `browser.*`, and `mcp.*`;
  - `schedule.every`, `schedule.at`, `message.send`, and `message.read` (which reads a channel your Slack app is in, never a DM, and labels what it returns `external`);
  - every third-party tool, `web.search` included.
  - What happens to a gated call depends on the approvals mode. Under `headless` (the default) it is refused. Under `remote` the people in `approvals.slackApprovers` are asked in Slack (or through the control API's `/approvals`) with **Allow once**, **Always allow**, and **Deny**. Under `remote` with nobody to ask, it is refused too.
  - Either way, what was already approved still runs unattended. For `shell.run` that is a command scope plus a built-in safe list of read-only commands (`git status`, `git log`, `git diff`, `pwd`, and a few more; not `ls`), plus `grep`, `head`, `tail`, `wc`, `sort`, and `uniq` as filters that are never handed a path. A pipeline runs unattended when every stage would on its own (`git log | grep fix | head -n 20`); `||`, `;`, `&`, redirection, and `$( )` still mean asking. For `browser.act` and `web.fetch` it is an approved site (a `web.fetch` redirect to another site is reported as `redirectedTo`, not followed), and for other gated tools a standing grant.
  - The exception is `approvals.externalContent: "gate"`, set for every agent or per agent under `approvals.agents.<id>`. Once your conversation has read external content (`web.fetch`, `browser.*`, `web.search`, or an `mcp.*` tool), no grant applies for the rest of it: every gated call is asked or, headless, refused, and **Always allow** is not offered. `safe` tools, the built-in read-only commands, and a schedule's pre-authorized destination still run. Your next conversation starts with its grants again.
  - **Always allow** writes one of those to `agents/<id>/whitelist.json`, except for a tool that names a destination, such as `message.send`, where it lasts for the conversation. A `dangerous` call is never offered it.
  - `stratus grants <id>` lists the grants, and `stratus grants revoke <id> --tool|--scope|--origin` takes one back. There is no command to add one: a headless daemon asks nobody, so it never creates a grant, and a call nobody has approved yet needs `remote` mode first.

## Memory

- **What you have.** Every turn carries the facts you pinned, an index of the topics you know about, and a short tail of what you learned most recently. Everything else is reachable with `memory.recall`. `memory.remember` writes a fact, `memory.forget` retires one by id, and `memory.pin` keeps one in your instructions every turn (pins share a 2 KiB budget and are refused past it, never evicted).
- **Where it lives.** By default `agents/<id>/memory.jsonl`, one agent's own. A forgotten fact stops reaching you and recall, but its line stays in the file as a record. A trusted config can select another store (`memoryStore`, from a plugin), and then the memories live wherever that store keeps them.
- **Making you forget something.** Recall it to find its id and `memory.forget` it, then say you did. Your operator can do the same at the machine with `stratus memory list <id>` and `stratus memory forget <id> <entry>`, for the default store only: with another `memoryStore` selected, `stratus memory` refuses, and that store's own tooling is the way. Never claim a fact is gone without having forgotten it.
- **Trust labels.** Every fact carries who wrote it: `user` (your operator at a local terminal, or a Slack sender named under `principals`, said it), `agent` (your own work in a conversation of trusted content), `unknown` (no recorded origin, or written after a message from someone not a principal, or after `shell.run`), or `external` (written after you read a web page, a search result, or an MCP reply). Label facts by what they are when you repeat them: an `external` or `unknown` one may be a stranger's words.
- A label only ever goes down within a conversation, and only your operator can raise one, with `stratus memory reassert` at the machine. No tool can.

## Slack

- **One Slack app per agent**, each with its own tokens, connected over Socket Mode, so no public address is needed. Set up with `stratus setup` → Channels, which prints the app manifest and checks the tokens.
- **"Sending messages to this app has been turned off"** in a DM is a Slack setting, not Stratus. In the app's settings go to App Home → Messages Tab, turn on *Allow users to send Slash commands and messages from the messages tab*, then reopen the DM.
- **What reaches you.** In a DM, every message. In a channel, a message that mentions you, which starts a thread. In that thread, what happens to a reply that does not name you depends on your soul's `listens:`:
  - `thread`, the default, hears every such reply.
  - `mentions` answers only messages that name you, though it still hears the rest of the thread.
  - `judge` hears them and decides whether to answer.
- With several agents in one thread, an untagged reply goes to whoever spoke last. Mentioned partway into a thread, your first turn opens with what was said before it (the parent and the newest earlier messages, marked as overheard). Mentioned at the top of a channel, it opens with the channel's 20 most recent messages. Both need the Slack app's history scopes. Without them you hear the thread from the mention onward only. Your prompt gives the channel's id, never its name. A stranger or another bot among those earlier messages lowers the conversation's trust as if they had spoken to you.
- **Answering only when mentioned**, never to thread replies, has three causes, and they are worth checking in this order:
  1. `listens: mentions` in your soul.
  2. Another agent spoke last in that thread.
  3. The app is missing the history scopes (`channels:history`, `groups:history`, `mpim:history`) and their `message.*` events, which means adding them and reinstalling the app.

  Not answering at all also happens when the daemon is down, the app was removed from the channel, or `admit: "principals"` turned the person away.
- **Another agent on Slack** needs its own soul on the roster first, then its own Slack app through `stratus setup` → Channels, and a restart to connect it.
- **Who counts as your operator** is `principals.slackUsers` in the trusted config. Everyone else's messages reach you labelled as from someone unknown, and `admit: "principals"` turns them away entirely.
- **Images** need the `files:read` scope. Text files are read up to a size limit, and anything else reaches you by name only, with the reason. The message says which.

## The daemon

- **Running it.** `stratus serve` runs the daemon in the foreground. `stratus service install` keeps it always on, with `stratus service start|stop|status|uninstall`. There is no top-level `stratus start`, `stop`, or `status`, and no `stratus service restart`.
  - On macOS it is a LaunchAgent, started at login, not at power-on. `--no-login` also gives up restarts after a crash.
  - On Linux it is a systemd user unit, which needs `loginctl enable-linger` to run while nobody is logged in.
  - It will not start while the trusted config (`~/.stratus/config.json`, or the file `--config` names) fails to parse or validate. The error goes to stderr, not `stratus logs`: on Linux the unit then shows as failed until the file is fixed and `stratus service start` is run; on macOS launchd keeps retrying until the file is fixed. A daemon already running keeps its last good config, and `stratus service start`, `stratus update`, and `stratus restart` refuse up front with the same error rather than restart into it.
- **`stratus restart`** drains in-flight turns and restarts, and needs the control API. Without the API, use `stratus service stop` then `stratus service start`.
  - A restart is needed after a change to `plugins` (a plugin's `env` included), `approvals`, `api`, `principals`, `slack`, `maxTurns`, `executor`, or `memoryStore`, and after new channel secrets (Slack's tokens or a channel plugin's).
  - It is not needed for soul edits, stored credentials and keys, the config's `provider`/`model`, or skills (`stratus skill reload`).
  - `stratus update` stops and starts the service itself. Only a daemon someone started with `stratus serve` needs restarting by hand.
- In a container or under a system unit, `stratus serve --log-format json` also writes the log's records to stdout, for `docker logs`, journald, or a log shipper. `stratus health` is the probe.
- **`stratus logs`** (`-f` to follow, `--agent`, `--session`) reads the structured log. It records that tools ran and sessions finished, never prompts or replies. One exception: a failed session keeps the provider's error text, so skim a log before sharing it.
  - A daemon that fails *before* it starts serving writes nothing there. Its error is in `~/.stratus/logs/stratusd.err.log` on macOS, in `journalctl --user-unit=stratusd.service` on Linux, or on the terminal that ran `stratus serve`.
- **The control API** is a separate install, `@stratusagent/control-api`, serving `/api/v1` on `127.0.0.1:4123`. The web dashboard is another, `@stratusagent/dashboard`, opened with `stratus dashboard`, which starts a daemon if none is running.
  - From another device, the recommended path is a tunnel such as Tailscale, with `api.publicUrl` set to that address so credential links open there.

## When a reply stops or changes model

- **"Out of steps."** One message may take `maxTurns` rounds of tool calls (default 40, set in the trusted config, restart to change). Past that you are told you are out of steps, get one last call with no tools, and answer with what you did and what is left. Replying "continue" carries on with a fresh allowance. An agent that does long work should have its own budget raised with `agentMaxTurns: { "<id>": 300 }` in the trusted config (restart to change), which leaves the rest of the fleet on `maxTurns`.
- **Stopped with no reply.** On a provider that streams (Anthropic, Codex, and plugin providers that say they stream), the daemon's watchdog aborts a turn when the model reports nothing for `--idle-timeout` seconds (default 120). On one that does not, such as an OpenAI-compatible endpoint, there is no watchdog, and a silent request ends only when the provider's own request fails or times out, so `--idle-timeout` neither explains nor fixes it. The session ends failed, with `no activity for 120000ms`, and `stratus logs --agent <id>` names the last thing it heard. A tool that is running, or a call waiting on an approval, never trips it.
- **Cut off at the output cap.** A reply longer than the model may write in one turn fails rather than being posted half-finished, and the error says so. With an Anthropic API key that cap is `maxTokens` in the config (default 16000); a Claude subscription run does not take that setting, so raising it changes nothing there. Offer a shorter answer, or, on an API key, ask for the cap to be raised. Never ask for a longer timeout.
- **Answering on another model.** When the configured model fails a request and a `fallbackModel` is set, that conversation switches to the fallback and stays on it, even across restarts, so it never silently swaps back. Not every failure switches: a conversation too long for the window is trimmed and retried on the same model, a cancelled turn just stops, and a Codex or Claude subscription turn that fails after its tools already ran surfaces the error instead, since a retry elsewhere would run them twice. Those leave the conversation on the configured model, with nothing to roll over. Your instructions say when you are on the fallback. `stratus logs` shows the error that caused the switch, and `stratus session rollover <session id>` starts the conversation over on the configured model.
- When asked why a reply stopped, look before you answer if you can: with `shell.run` you can run `stratus logs --agent <your id>` (it is gated, so it needs approval or a granted scope), and an `fs` root covering `~/.stratus/logs/` lets you read the file. Without either, give the likely cause from what your transcript shows (an out-of-steps answer, a message with no reply, a request for a very long answer) and the log command that confirms it, rather than a certain answer.

## Commands

| Command | What it does |
| --- | --- |
| `stratus setup` | The menu: providers, models, an agent, plugins, channels (Slack, and any channel an enabled plugin contributes), approvals, always-on |
| `stratus chat` / `stratus run` | Talk to an agent in the terminal, as a conversation or one prompt |
| `stratus serve` | Run the daemon in the foreground |
| `stratus service install\|uninstall\|start\|stop\|status` | Keep the daemon running as a background service |
| `stratus restart` | Announced drain-and-restart of the running daemon |
| `stratus logs` | Read the daemon's log |
| `stratus health` | Whether the running daemon is serving: exit 0 if so, for a container healthcheck or a probe |
| `stratus doctor` | What a run would use, and why |
| `stratus update` | Update Stratus and its companion packages (`--check` to look first) |
| `stratus dashboard` | Open the web dashboard with a one-time sign-in link |
| `stratus agent new` / `stratus agents` | Create an agent / list the roster |
| `stratus template add <path\|owner/repo>` | Install a packaged agent: soul, skills, and plugin config |
| `stratus skill add` / `stratus skill validate` / `stratus skill reload` | Install skills, check a skill directory, and have the running daemon re-read them |
| `stratus skills` | List skills and which agents enable each |
| `stratus plugins` | Every tool, its plugin, who is granted it, and what approvals do |
| `stratus credential set` / `stratus credential remove` / `stratus credentials` | Store (value on stdin) or remove a named credential; list the names |
| `stratus channel set` / `stratus channel remove` / `stratus channel list` | Store (values prompted without echo, or one per stdin line) or remove a channel's secrets for one agent; list which agents have them. A channel's secrets are never yours to read, and a running daemon picks them up at its next start |
| `stratus grants <id>` / `stratus grants revoke <id>` | An agent's standing approvals, and taking one back |
| `stratus schedules` / `stratus schedules cancel <id>` | Scheduled turns, and cancelling one |
| `stratus memory list` / `stratus memory search` / `stratus memory audit` | An agent's live memories with their trust labels, searched as the agent does, and every entry ever written |
| `stratus memory forget` / `stratus memory pin` / `stratus memory unpin` | Retire entries, or keep them in the agent's instructions every turn |
| `stratus memory export` / `stratus memory import` | Move an agent's memories to and from JSONL |
| `stratus memory reassert` | Re-label memories' trust as the operator; no tool can |
| `stratus session rollover <id>` | Start a long conversation over under the same id, keeping the old transcript |
| `stratus version` / `stratus help` | The version, and the full reference for every flag |

## What you can do, and what to ask for

You can use the tools your soul grants, remember and recall, delegate to the agents you may delegate to, schedule turns and send messages if you have those tools, read your enabled skills, and ask for a named credential.

Your operator can do more from anywhere they reach the dashboard or the control API:

- **From the dashboard:** edit souls (your `tools:`, `credentials:`, and `listens:` included), create agents, answer approvals, change the provider, model, and other settings, and store provider sign-ins and Slack tokens.
- **Through the control API as well:** restart the daemon, revoke a grant, cancel a schedule, add a named credential, and edit `approvals`, `principals`, and `api`.

Only at the machine can someone:

- enable or configure a plugin (its `env` and `headers` included), or choose an executor or memory store;
- install or update packages;
- replace or remove a named credential;
- raise a memory's trust (`stratus memory reassert`).

When you need one of those, ask for it precisely, once: the exact command, the file and the line to change, and what it will let you do. For example: "Run `stratus credential set search.apiKey --agent kai` with the key on stdin, and add `search.apiKey` under `credentials:` in my soul. Once a search plugin is enabled, `web.search` is in my `tools:`, and approvals let it run, I can search." Not a list of possibilities, and not a guess presented as a step.

## Going further

**Which version.** You are not told which version of Stratus is installed. `stratus --version` says, and `stratus update --check` says whether a newer one exists. This skill ships with the installed version, so it describes what is running.

The full documentation is at <https://github.com/stratuslabs/agent/tree/main/docs>. It follows the latest code, which can be ahead of what is installed, so where a page and this skill disagree, this skill describes this install. Link a person to the page that answers their question rather than reciting it:

- [Tools](https://github.com/stratuslabs/agent/blob/main/docs/guides/tools.md)
- [Shell](https://github.com/stratuslabs/agent/blob/main/docs/guides/shell.md)
- [Slack](https://github.com/stratuslabs/agent/blob/main/docs/guides/slack.md)
- [Approvals](https://github.com/stratuslabs/agent/blob/main/docs/guides/approvals.md)
- [Always on](https://github.com/stratuslabs/agent/blob/main/docs/guides/always-on.md)
- [Memory](https://github.com/stratuslabs/agent/blob/main/docs/concepts/memory.md)
- [Remote access](https://github.com/stratuslabs/agent/blob/main/docs/guides/remote-access.md)
- [Troubleshooting](https://github.com/stratuslabs/agent/blob/main/docs/guides/troubleshooting.md)
