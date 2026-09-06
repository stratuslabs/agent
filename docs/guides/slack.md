# Slack

Talk to your agents in Slack — **each agent as its own Slack app**, with its
own avatar, presence, and DMs. Threads are resumable conversations that
survive daemon restarts (a turn parked on an approval when the daemon died is re-asked afterwards and its reply still lands in the thread), and replies stream via message edits. Socket Mode
means no public ingress: a Mac Mini behind NAT is fine.

## Install the channel

```bash
npm install -g @stratusagent/channel-slack
```

The CLI ships **no** transport, so an install that never touches Slack never
carries the Slack SDKs (~9 MB). You rarely have to type this: connect an
agent in `stratus setup` → **Channels** and
[**Save & finish** offers the install](../start/setup.md#what-save--finish-offers),
because storing tokens is already the decision to use Slack.

If tokens are stored for an agent but the package isn't installed,
`stratus serve` says so and starts anyway, serving every other channel.

## Connect an agent

`stratus setup` → **Channels** walks each agent onto Slack: it prints the
app manifest with the agent's name already filled in, takes both tokens
without echoing them, verifies each against Slack, and stores them for the
daemon. Nothing to hand-edit.

The full app setup — creating the app from the manifest, scopes, Socket
Mode, and how the adapter behaves (who a message is for, free-form DMs,
streaming edits, session keys) — is documented in the
[`@stratusagent/channel-slack` README](../../packages/channel-slack/README.md),
which is canonical for the Slack surface.

## Talking to an agent

Mention it — `@Ava what's blocking the release?` — and it answers in a
thread. **Inside that thread you do not have to mention it again**: replies
reach it the way replying to a colleague reaches them, and so do replies
from anyone else in the thread. Outside a thread it stays quiet; a channel
message nobody addressed to it is not its business.

Threads with more than one agent follow the rule people already use: an
untagged reply goes to **whoever spoke last**, and mentioning another agent
moves the conversation to them. It is still a rule and not judgement, so in
a thread where people are mostly talking to each other the agent will answer
replies that were not meant for it — give the side conversation its own
thread. Each agent keeps its own session, so one
tagged in halfway through knows only what it is told from there — say what
it needs in the message that brings it in. The full set of rules, and the
two edges around them, is [Who a message is
for](../../packages/channel-slack/README.md#who-a-message-is-for).

An app installed before this shipped needs the `channels:history` /
`groups:history` / `mpim:history` scopes and the `message.*` events added
once (the manifest `stratus setup` prints already has them) — until then it
answers mentions and DMs and nothing else, which is also how you keep an
agent mention-only on purpose.

## Sending an image

Attach a screenshot — a PNG, JPEG, GIF, or WebP — to a message, or drop one
into the thread on its own, and the agent is shown it. That takes the
`files:read` scope, which the manifest `stratus setup` prints includes; an
app installed before it needs the scope added under **OAuth & Permissions**
and a reinstall, and until then `stratus serve` warns, naming the scope,
whenever an image arrives. Anything that is not an image the model can
take — a log, a PDF, an image over 5 MB, or one that would take a single
message's images past 20 MB together — reaches the agent by name, told
that it cannot be opened, so it answers honestly rather than as if it had
read the file.

Which runtimes can actually look: agents on the **Anthropic API** or an
**OpenAI-compatible** provider receive the image itself. The **Claude Code**
and **Codex** harnesses take a text prompt, so an agent on either is told an
image was attached, and what it was called, and that it cannot see it. The
image is stored with the message in the session, so a later turn in the same
thread still has it — up to 20 MB of images per request, newest first;
past that, the oldest ones reach the model as a note saying they are no
longer sent.

## Worth knowing

- **Tokens are gateway infrastructure secrets.** They live under
  `channels.slack.<agentId>` in `~/.stratus/credentials.json` and are never
  resolved through the agent-scoped credential allowlist — an agent must not
  be able to read the tokens of the transport carrying it.
- **Name who your agent's operator is.** Any member of the workspace can DM
  an agent or mention it, and the adapter cannot tell them from you. Until
  you list your Slack user id under `principals` in `~/.stratus/config.json`,
  every message an agent receives in Slack is treated as coming from someone
  it cannot vouch for, and every fact it remembers there is labelled that
  way. How and why is in [Who counts as the
  operator](../../packages/channel-slack/README.md#who-counts-as-the-operator)
  and [Memory](../concepts/memory.md#where-a-fact-came-from).
- **Replies are translated to Slack's markup.** Agents write Markdown; Slack
  renders mrkdwn, where bold is `*one asterisk*` and headings do not exist. The
  adapter converts on the way out, leaving code spans and fences as written —
  so a soul does not need a "you are on Slack" rule to be readable there. The
  full list of what is converted is in the
  [`@stratusagent/channel-slack` README](../../packages/channel-slack/README.md).
- **Approval buttons** — with [`--approvals remote`](./approvals.md), a gated
  tool call parks the turn and asks in its thread with **Allow once** /
  **Always allow** / **Deny**. Clicks are authorized by *who clicked*, never
  by who can see the message.
- Nothing answers in Slack until the daemon runs — see
  [Always on](./always-on.md).
