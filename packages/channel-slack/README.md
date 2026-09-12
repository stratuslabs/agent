# @stratusagent/channel-slack

Slack adapter for Stratus agents. **One Slack app per agent** — Slack has no way to give a single bot several identities with real avatars, presence, and DMs, so each agent gets its own app, and the adapter runs one Socket Mode connection per agent (no public ingress needed; Mac Minis behind NAT are fine).

- **Resumable conversations**: session keys are `slack:<agent>:<team>:<channel>:<thread_ts ?? ts>` (DMs: the DM channel id) — a thread is a conversation, it survives daemon restarts, and two agents sharing a thread keep fully separate sessions. A turn parked on a human when the daemon died is re-asked after the restart, and when it finishes its reply is posted into the thread as a fresh message — the placeholder it would have edited belonged to the old process.
- **Streaming replies**: post a placeholder, edit as deltas arrive (throttled for `chat.update` limits), show `⚙ tool…` status lines, finalize with the full reply — split across messages when it outgrows one.
- **Markdown is translated to Slack's mrkdwn** on the way out — `**bold**` to `*bold*`, `*italic*` to `_italic_`, `~~struck~~` to `~struck~`, `[text](https://…)` to `<https://…|text>`, and a `#` heading to a bold line, since mrkdwn has no headings — unless the heading already carries an asterisk of its own, which is left as it is: Slack has one bold delimiter and no way to nest it, so a second pair would print rather than render. Code spans and fences are left exactly as written, an unclosed fence included, so a `**` inside a snippet stays part of the snippet — a run of N backticks opens code and only a run of exactly N closes it, which is what lets ``a span with a ` in it`` and a ````-fence holding a ```-fence work. One or two unmatched backticks are literal text, as they are in Markdown. A run that has code inside it is still one run — ``**the `fs.read` tool**`` is bold around a snippet, not four literal asterisks — because the whole reply is rewritten at once, with the code held out of the rewrite rather than cut out of the text. Anything whose spelling already matches — lists, block quotes, inline code — is untouched. A marker still being streamed stays literal until its closing half arrives.
- **Mention to start, then it stays in the thread.** A mention opens a conversation; every reply in that thread reaches the agent without tagging it again, and free-form DMs are unchanged. Who an untagged reply is for is decided by [Who a message is for](#who-a-message-is-for). Inbound mentions of other users are humanized to `@Display Name` for the model; redeliveries are deduped so a slow turn never runs twice.
- **Approval buttons** for the gateway's `remote` permission mode: a gated tool call parks the turn and asks in its thread with **Allow once** / **Always allow** / **Deny**. See [Approving tool calls](#approving-tool-calls) — clicks are authorized by *who clicked*, never by who can see the message, and **Always allow** is offered only where the daemon would actually remember it.
- **Tokens are gateway infrastructure secrets**, stored in the `channels` namespace of `~/.stratus/credentials.json` — never in an agent's credential allowlist:

```json
{
  "channels": {
    "slack": {
      "ava": { "appToken": "xapp-…", "botToken": "xoxb-…" }
    }
  }
}
```

## Who a message is for

A mention is how a conversation starts. After that, the thread is the
address — replying in it reaches the agent the way replying to a colleague
reaches them, with no `@` and no ceremony. Four rules decide the rest, and
they are the whole model:

1. **A mention is always for whoever is named.** In a thread or out of one,
   naming an agent hands it the question.
2. **Inside a thread it is already in, an agent listens without being
   named.** "Already in" means a session exists under that thread's key —
   which happens only because somebody mentioned it there — so an agent
   follows conversations it was brought into and nothing else. That record
   is durable, so a daemon restart mid-thread forgets nothing.
3. **The room is not a conversation.** A channel message outside any thread
   is never a follow-up, however much of the channel the app can see. An
   agent that has not been spoken to does not join in.
4. **In a thread with several agents, an untagged reply goes to whoever
   spoke last.** The same rule people use: you are answering the voice that
   just answered you. Naming another agent moves the conversation to them —
   so a handover is one `@`, and it takes effect the moment it is sent, not
   whenever the turn it starts gets around to answering: an addendum typed
   straight after it reaches the agent you just named, and the agent that
   *had* the thread stands down at the same instant rather than whenever its
   own app next catches up.
5. **Standing down is not leaving.** An agent in a thread hears what is
   said to the other agent in it — the question that named its colleague,
   the untagged replies that were the colleague's to answer — into its own
   session, with no turn run and nothing posted. The next time it is
   asked, it answers as someone who followed the conversation rather than
   one who stepped out of the room. What it hears is marked as said to
   somebody else, so a stranger's words in a shared thread never read to
   it as an instruction; and a stranger overheard lowers its session's
   trust label exactly as one who addressed it would, since their text is
   in the transcript either way.

Everyone in the thread is talking to the same agent — a reply from a second
person is a follow-up like any other, and channel messages reach the model
prefixed with the speaker's display name so it knows who said what. A reply
carrying a file, or one the author also broadcast to the channel, is a
follow-up too; what Slack marks as bookkeeping — an edit, a deletion, a
join — is not, and nothing answers it. **Images are shown to the model.**
A PNG, JPEG, GIF, or WebP attached to a message is downloaded with the
bot token and sent with the message — a screenshot alone, with nothing
typed, is a question in its own right and gets an answer. That needs the
`files:read` scope, which the shipped manifest asks for; an app installed
without it should have the scope added under **OAuth & Permissions** and be
reinstalled once, and until then `stratus serve` warns, naming the scope,
each time an image arrives. An image over 5 MB or 8000 pixels a side (the
model API's limits) is not kept, and one message's images stop at 20 MB
together — a request has a size limit too, and images past it are named as
unreadable; send them in a message of their own. The same 20 MB — and 20
images — is what a whole thread's images may take on one request, spent
newest first — and the request as a whole has a limit too, so when the
rest of the conversation needs the room the oldest images give way to it.
Once a thread's images pass a limit the oldest are let
go of — the model is told an image was there and what it was called, and
the session keeps that record rather than the pixels, so a busy thread's
row stays bounded. A message's downloads share one 30-second deadline,
after which whatever has not arrived is named as unreadable, so a slow
link cannot hold the thread. And an image the model API itself refuses —
the adapter checks that a file opens and closes like the image it claims
to be, but that is not a decode — is dropped from the session and the turn
retried without it, so one bad file cannot fail every later turn of a
thread.
An OpenAI-compatible model that takes only text needs `"vision": false` in
config, which turns every image into that note; see the
[Slack guide](../../docs/guides/slack.md#sending-an-image). Whether the model actually *sees* the image depends on the
agent's runtime: the Anthropic API and OpenAI-compatible providers send it
as image content; the Claude Code and Codex harnesses take a text prompt,
so there the agent is told the image's name and that it cannot see it.
**Every other attachment is unreadable** — a log, a PDF, an image that was
too large — so the message reaches the agent naming those files and saying
they cannot be opened, which is what lets it answer honestly instead of as
though it had read the log. Such a file dropped in with nothing said is not
a question, and gets no reply. 
Sessions are still per agent: an agent hears a thread from the mention
that brought it in, and what was said before that — to the other agent, or
by it — is not backfilled ([#147](https://github.com/stratuslabs/agent/issues/147)).
Bring it up to speed in the message that tags it. What the *other agent*
replied is not overheard yet either — only what people say — so an agent
that followed a thread knows the questions its colleague was asked and not
the answers; that is the next step of
[31](../../docs/roadmap/31-reading-the-room.md).

Three edges worth knowing. An agent whose app was installed before the
history scopes below is told about mentions only, and behaves exactly as it
always did — the workspace's grant is the switch, per app. Where a thread's
several agents cannot be ordered — a host whose session routing carries no
timestamps — an untagged reply is left alone rather than answered twice;
mention the one you want.

A named agent whose app is down answers nothing, and nothing answers in its
place: being tagged is a decision about who is being asked, and an agent
that has been handed the question elsewhere does not take it back because
the other one is offline. That silence is the same signal a mention has
always given when an app is down.

And the rules above are mechanical, which shows in a thread where people are
mostly talking to *each other*: an agent invited into one answers every
untagged reply in it, including the ones meant for somebody else. Give the
side conversation its own thread. It can now *hear* a thread it is not
answering; teaching it to choose — to answer only when it has something to
add, and to let "thanks, we've got it" be a sentence it read — is the rest
of [roadmap step 31](../../docs/roadmap/31-reading-the-room.md).

## Installing

This package is an **optional peer** of the CLI — `stratus` ships without any
transport, so installs that never use Slack do not carry the Slack SDKs
(~9 MB). Add it alongside the CLI to enable the channel:

```sh
npm install -g @stratusagent/channel-slack
```

`stratus serve` picks it up automatically for every roster agent with stored
Slack tokens. Without it, tokens are reported at startup with an install
hint and the daemon serves every other channel as usual.

## Setting up an agent's Slack app (~2 minutes)

**The easy way:** run `stratus setup` → **Channels**. It prints the manifest with
the agent's name already filled in, takes both tokens without echoing them,
verifies each against Slack, and stores them under the right agent id — no
editing `credentials.json` by hand.

The manual equivalent, if you prefer:

1. https://api.slack.com/apps → **Create New App → From a manifest** → paste `manifest/stratus-agent.manifest.json` with `NAME` replaced by the agent's name.
   The manifest asks for the `channels:history` / `groups:history` / `mpim:history` scopes and the matching `message.*` events, which is what lets an agent [stay in a thread](#who-a-message-is-for) instead of needing a mention every time, and for `files:read`, which is what lets it [see an attached image](#who-a-message-is-for). An app created before those shipped needs them added under **OAuth & Permissions** and **Event Subscriptions** and reinstalled once; leave the history scopes off and it answers mentions and DMs, exactly as it did before; leave `files:read` off and it hears about attachments by name only.
2. **Basic Information → App-Level Tokens** → generate a token with `connections:write` (that's the `appToken`, `xapp-…`).
3. **Install App** to the workspace → copy the **Bot User OAuth Token** (that's the `botToken`, `xoxb-…`).
4. Upload the agent's avatar under **Display Information**.
5. Add both tokens under `channels.slack.<agentId>` in `~/.stratus/credentials.json` and restart `stratus serve` — the log will show `slack: <agentId> connected`.

## Approving tool calls

When `stratus serve` runs with `approvals.mode: "remote"`, a gated tool call
parks the turn and the adapter asks here. The question goes to the thread the
turn is happening in; a turn with no Slack conversation of its own (scheduled
work, a delegate) asks in the configured `slackChannel`.

The request names the **site** for a call judged by one (`browser.act`),
because its arguments are a CSS selector and say nothing about where a click
lands — and that site is what **Always allow** widens.

**Always allow** is left off entirely where the daemon would remember
nothing: a `dangerous` tool, which asks every time whatever is answered; a
browser action whose conversation has no page to grant; and a shell command
the parser cannot reduce to a scope. The prompt says so instead, because a
button that does exactly what **Allow once** does, under a label promising a
standing grant, is worse than no button.

Where it is offered, a line beside the buttons says what it would do,
because that differs by tool and is the half of the question the button
widens: for most gated tools it is a **standing grant** to the agent that
lasts until an operator revokes it (`stratus grants <agent>` lists and
revokes; see [Approvals](../../docs/guides/approvals.md)); for a shell
command it is that command's scope; for a browser action it is the site;
and for a send outside a schedule it is the rest of this session.

The resolved message describes what the daemon did rather than which button
was pressed — `POST /approvals` accepts `always` whatever this channel
rendered, so the answer can arrive from somewhere else — and names the grant
that was made, since the request said in advance which kind it would be.
The one thing it cannot promise is the disk write: a daemon that could not
read the whitelist does not write over it, and by then the message is sent.
`stratus logs` has the exact line.

Who may answer is configured per agent, in `~/.stratus/config.json`:

```jsonc
{
  "approvals": {
    "mode": "remote",
    "slackChannel": "C07OPS",
    "agents": {
      "ava": { "slackApprovers": ["U01DYLAN", "U01OPS"] }
    }
  }
}
```

That block is only read from a config you chose — `--config`,
`STRATUS_CONFIG`, or the global `~/.stratus/config.json`. A project-local
`stratus.config.json` cannot appoint approvers, since it can be checked into
any repository.

**Clicks are authorized by actor, not by delivery.** Everyone in a thread can
see the request; only the ids listed for that agent can decide it. Anyone
else's click is refused with a notice only they see, and the request stays
open for someone who may actually answer — which matters most for **Always
allow**, since that widens what the agent may do for the rest of the session.
An agent with no approvers listed denies every request on arrival rather than
leaving it hanging — set `"slackApprovers": []` on an agent to exclude it
from a shared default list. The same goes for an agent whose Slack app is
configured here but failed to connect. An agent this adapter was never given
is left alone: a request is a broadcast, and refusing one another channel was
about to answer is not the adapter's call — `stratus serve` reports agents no
channel can ask for, at startup. Those automatic denials are recorded as
`undeliverable` rather than `decided`, so the log never shows a refusal
nobody made as one somebody did.

The message shows the tool's arguments as well as its name — approving
`shell.run` without seeing what it would run is not approval. Arguments are
escaped, so a model-written argument cannot mention or broadcast to the
workspace through the prompt itself, and long ones are truncated with a
notice saying so.

Requests are also denied, visibly, when they expire, when the turn is
cancelled, and when the daemon shuts down. Every ending the daemon is alive
for retracts the buttons, so a message does not keep offering a decision that
has nowhere to land.

A crash is the ending it cannot be alive for, and the record of what was
posted lives only in memory — so a new process cannot find its predecessor's
prompts to retract them. Those correct themselves on the next click: it
answers that the request is no longer pending and rewrites the message, since
the click is the one thing that carries the message's location back. A prompt
nobody clicks stays as it was until someone does.

**Interactivity must be enabled on the app** or Slack delivers no clicks at
all. The shipped manifest turns it on; an app created before this shipped
needs `settings.interactivity.is_enabled` set to `true` once, under **App
Manifest**. No request URL is needed — the clicks arrive over the same Socket
Mode connection.

## Who counts as the operator

Everything above decides *which agent* a message is for. None of it decides
*who is speaking*: the adapter admits a message that has a user, is not a
bot, carries no bookkeeping subtype, and is a DM or a mention — and any
member of the workspace can open a DM or type an `@mention`. A DM proves
nothing about who is typing.

So a message is the operator's only when the operator has said so:

```jsonc
{
  "principals": {
    "slackUsers": ["U01DYLAN"],
    "agents": {
      "ava": { "slackUsers": ["U01DYLAN", "U01OPS"] },
      "bea": { "slackUsers": [] }
    }
  }
}
```

A turn from a listed id reaches the agent as its operator's (`user`). A turn
from anyone else — in a DM as much as in a channel — reaches it as
`unknown`, and the session it lands in stays `unknown` from then on: that
text is in the transcript. Every fact the agent remembers afterwards
carries the label, and the prompt renders it under a heading that says so.
With no list at all, every Slack sender is `unknown`, and `stratus serve`
says so at startup. An agent's own entry replaces the shared list;
`"slackUsers": []` excludes an agent from it.

The list also decides how a speaker is *named* in a channel turn, which
the model reads as `Name: text`. A principal is their display name — one
line, at most 80 characters, control characters spelled out — because
their profile is trusted the way their messages are. With a list in force,
everyone else is their user id, exactly as an `@mention` of them already
is: a display name is text its owner typed, and the speaker position of a
user turn is not a place a stranger gets to put a sentence. With no list
at all there is nobody to prefer, so every author keeps their name.

The sender is judged on **every message**, not once per thread. A thread
keys one session for everyone in it, so an authorized member can open one
and a stranger can mention the agent inside it afterwards — the stranger's
turn lowers the session, and the authorized member's next turn does not
raise it back.

Like `approvals`, this block is read only from a config you chose —
`--config`, `STRATUS_CONFIG`, or the global `~/.stratus/config.json`. A
project-local `stratus.config.json` cannot appoint itself the principal.
The labels themselves are documented in
[Memory](../../docs/concepts/memory.md#where-a-fact-came-from).

## Speaking first: the outbound seam

The adapter also implements the channel contract's `resolveOutbound` — how a
scheduled turn's `message.send` reaches a channel, and how a schedule's
destination is validated at creation. The address is the agent **plus** a
conversation id (`C…`/`G…`/`D…`, never a name): each agent is its own Slack
app, possibly in its own workspace, so the id alone names nothing.

Validation is membership: the app must be able to see the conversation
(`conversations.info`) and be a member of it — `/invite` it where it should
report. A DM id passes on its own, because a `D…` conversation exists only
because someone opened it with the app; the adapter never opens new DMs, so
an agent cannot cold-message a workspace. This is what the
`channels:read` / `groups:read` / `mpim:read` scopes in the manifest are
for — an app created before this shipped needs them added under **OAuth &
Permissions** and reinstalled once, or every destination reads as invisible.
