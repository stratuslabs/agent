# Slack

Talk to your agents in Slack — **each agent as its own Slack app**, with its
own avatar, presence, and DMs. Threads are resumable conversations that
survive daemon restarts (a turn parked on an approval when the daemon died is re-asked afterwards, one that was still running is continued, and either reply still lands in the thread; a Slack redelivery of a message already answered starts no second turn), and a reply arrives once it is finished, with Slack's own "is thinking…" status while the agent works. Socket Mode
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

Mention it — `@Blair what's blocking the release?` — and it answers in a
thread. **Inside that thread you do not have to mention it again**: replies
reach it the way replying to a colleague reaches them, and so do replies
from anyone else in the thread. Outside a thread it stays quiet; a channel
message nobody addressed to it is not its business.

Threads with more than one agent follow the rule people already use: an
untagged reply goes to **whoever spoke last**, and mentioning another agent
moves the conversation to them. A reply an agent already took stays its own,
even if Slack delivers it again after a restart and someone else has spoken
since. The agent that stood down keeps
listening: what you say to its colleague in that thread, and what the
colleague answers, go into its own session, marked as said to somebody
else, so when you turn back to it, it answers as someone who followed
along. An agent mentioned partway into a thread opens with the thread's
parent and newest earlier messages, and one mentioned at the top of a channel
opens with the channel's most recent messages, when its app has the history
scopes. The full set of rules, and the
two edges around them, is [Who a message is
for](../../packages/channel-slack/README.md#who-a-message-is-for).

**It knows which room it is in.** Each turn tells the agent whether it is in
a direct message (with whom, when they are a principal), a group DM, a private channel, or a public
channel, and how many people are in it — so a
conversation that moves from a DM into `#general` is not answered as though
it were still a DM, and something said to it privately stays out of a
channel. The lookup behind it uses scopes the app manifest already asks for
([What the agent is told about the
room](../../packages/channel-slack/README.md#what-the-agent-is-told-about-the-room)).

### How an agent listens

That rule is a rule and not judgement: in a thread where people are mostly
talking to each other, an agent that answers every untagged reply will
answer ones that were not meant for it. `listens:` in the soul's frontmatter
picks how the agent handles a reply that did not name it — part of what the
agent *is*, next to `tools:` and `skills:`, not a deployment setting:

```markdown
---
name: Blair
listens: judge
---
```

- `thread` — the default, and the rule above: every untagged reply in a
  thread it is in. Cheap, predictable, and right for a thread with one
  person in it.
- `mentions` — only when named. The behavior before thread follow-through
  existed; some agents should be exactly this.
- `judge` — it hears everything, and for a while after it last spoke it
  **decides** whether an untagged message is one it should answer: the
  message runs a turn that is told nobody asked it anything and that it may
  say nothing, and a turn that says nothing leaves the thread untouched — no
  `…`, no `(no reply)`, and a line a failed attempt had started before the
  retry chose silence is deleted rather than left standing. That "while" is its attention: eight messages or
  fifteen minutes after it last answered a message that named it, whichever
  ends first; past that a message is heard for free with no model call, and
  mentioning it starts the window again. Speaking up on its own does not —
  an agent cannot extend its own attention, or a talkative one would never
  drift out. So "thanks Blair, we've got it from here" works because it is a
  sentence the agent read, and a mention is still the way to be sure.

Judging costs a model call per message inside the window, which is why the
window exists. An agent that judges never takes a colleague's *reply* as
something to answer — two judging agents would otherwise talk to each other
— and in a thread that mixes a judging agent with one on the thread rule,
a judging agent that speaks takes the thread like any speaker — whoever's
reply sits lowest in the thread holds it — so the other stands down from
then on; only a message typed while the judging agent was still deciding
may get both. Editable without opening the
file: `PUT /agents/:id` takes `listens` like any other field.

An app installed before this shipped needs the `channels:history` /
`groups:history` / `mpim:history` scopes and the `message.*` events added
once (the manifest `stratus setup` prints already has them) — until then it
answers mentions and DMs and nothing else, which is also how you keep an
agent mention-only on purpose.

## A home channel

A channel can be the place you talk to one agent, so nobody has to `@` it
there. List it under that agent's `homeChannels` and every new top-level
message in it from someone the agent [admits](../../packages/channel-slack/README.md#who-counts-as-the-operator)
is addressed to it, exactly as if it had been mentioned: the reply opens a
thread under the message.

```jsonc
// ~/.stratus/config.json — trusted configs only
{
  "slack": {
    "agents": {
      "atlas": { "homeChannels": ["C0123ABCD"] }  // channel ids, not names
    }
  }
}
```

- A message there that names another agent is that agent's, not both.
- Threads are unchanged: an untagged reply follows the soul's
  [`listens`](#how-an-agent-listens), as in any other channel.
- One channel has one home agent. If two agents in the same workspace list
  it, neither gets it: the daemon warns at startup and both answer there
  only when mentioned. It is per-agent only: the top-level `slack`
  block refuses `homeChannels`.
- Mentions of people are not mentions of agents, so `@Kai can you look?`
  posted top-level in the channel still goes to the home agent.
- Under the default `admit: "anyone"`, every member who can post in the
  channel starts a turn, which costs a model call each. Set
  `admit: "principals"` for a busy public channel.
- It uses the same `channels:history` / `groups:history` scopes and
  `message.*` events as thread follow-through, and takes effect on restart.

## How replies appear

By default an agent posts finished messages, never a `…` that is then
rewritten in front of you. Whatever it writes before it starts a tool is
posted as that tool starts — "On it, checking the three PRs" reaches the
thread at once, not an hour later — and the finished reply follows as its
own message. While it works, Slack shows its own loading status under the
agent's name: "is thinking…", or "is running shell.run…" while a tool runs. A turn nobody asked for (an agent that
[judges](#how-an-agent-listens)) shows no status, since it may decide to
say nothing.

Messages you send while it is still working wait their turn and are
answered in order. In a DM each one shows the status as soon as you send
it, so a second message never makes the agent look idle; in a channel
thread the status keeps saying what the running turn is doing until its
reply posts.

If you would rather watch the reply being written, set `stream`: the agent
posts a `…` placeholder at once, edits it as the reply arrives, shows
`⚙ tool…` lines while tools run, and finalizes it — how every reply looked
before `final` existed.

```jsonc
// ~/.stratus/config.json — trusted configs only
{
  "slack": {
    "replies": "final",              // the default; or "stream"
    "agents": {
      "blair": { "replies": "stream" }  // per agent, over the default
    }
  }
}
```

Restart the daemon to apply it. The loading status needs nothing new from
your Slack app: `chat:write`, which every Stratus app already has, is enough
for it in channels. A workspace where Slack refuses the status gets one
warning in the daemon log, and replies still post — just without the status
ahead of them. Slack drops a status after two minutes with no message, so
the daemon sets it again while a long turn runs.

Slack shows a preview card under each link an agent posts. To turn that
off, set `linkPreviews` to `false`, for every agent or one: links stay
clickable, and a reply that names three PRs is three lines, not three
cards.

```jsonc
// ~/.stratus/config.json — trusted configs only
{
  "slack": {
    "linkPreviews": false,             // default true, Slack's own behavior
    "agents": {
      "blair": { "linkPreviews": true }  // per agent, over the default
    }
  }
}
```

Restart the daemon to apply it. In `stream` mode the setting is made when
the placeholder is posted; Slack's edit call takes no preview setting of its
own.

## Sending an image

Attach a screenshot — a PNG, JPEG, GIF, or WebP — to a message, or drop one
into the thread on its own, and the agent is shown it. That takes the
`files:read` scope, which the manifest `stratus setup` prints includes; an
app installed before it needs the scope added under **OAuth & Permissions**
and a reinstall, and until then `stratus serve` warns, naming the scope,
whenever an image arrives.

Text files are read too. Attach a Markdown plan, a CSV, a JSON file, or a
log, and its contents reach the agent with your message, up to 100 KB a
file and 200 KB a message. Anything else — a PDF, a Word file, an image
over 5 MB or 8000 pixels a side, one that would take a single message's
images past 20 MB together, or a text file over those caps — reaches the
agent by name, with the reason it was not read: not a kind of file read
here, too large, not downloaded (in time, or at all), or not readable as
text or an image. It answers honestly from that note rather than as if it
had read the file, and without guessing at a cause the note does not give.
A message the agent only overheard names its files as not opened.

Which runtimes can actually look: agents on the **Anthropic API**, an
**OpenAI-compatible** provider, or a **Claude subscription** (the Claude Code
runtime) receive the image itself. On Claude Code that is the newest
message's images: a conversation replayed after the runtime lost its own
session names older ones rather than sending them again. The **Codex**
harness takes a text prompt, so an agent on it is told an image was attached,
and what it was called, and that it cannot see it. An
OpenAI-compatible model that takes only text — most local runtimes — needs
`"vision": false` in [config](../reference/config.md), which gives it that
same note; without it the endpoint rejects the request, and keeps rejecting
every later turn of that session, because the image is stored with the
message. The image is stored with the message in the session, so a later
turn in the same thread still has it — up to 20 MB and 20 images across the
thread, newest first, and fewer when the rest of the conversation — tool
results, a long transcript — needs the room in the same request. Past
either, the oldest images are let go of: the model is told one was there,
and what it was called, and the session keeps that note in place of the
pixels. The same happens to an image the model
API refuses outright: it is dropped from the session and the turn retried
without it, so one bad file cannot fail a thread from then on.

## Adding a credential from Slack

An agent that needs a key it does not hold can ask for one in the
conversation, with the `credential.request` tool. The daemon grants it to every agent,
whatever its `tools:` says, because the form goes to an approver who
decides everything after that. The one-time link it can fall back to is a
bearer credential, so a link needs the soul to list `credential.request`
(or have no `tools:` key):

```
Kai is asking for a credential: github.token, for Kai only.
Kai says: To open pull requests on the website repo.
[Add credential]
```

**Add credential** opens a form. Whoever submits it is checked against the
agent's approvers, the same `approvals.slackApprovers` list that decides
[approval buttons](./approvals.md), on the click and again on the
submission; anyone else in the thread is told they cannot. What the form does:

- **It stores the key add-only**, through the same rule as the
  [control API](../../packages/control-api/README.md): a name already
  stored is refused, in the form, with the `stratus credential set` command
  that replaces it, and so is a name the daemon's environment already
  supplies, since a stored one would be read first and replace it.
  Replacing or removing a key stays on the machine. A request whose name
  was stored since it was made (another form for the same shared key, or
  the machine) can never be answered, so the refusal also takes its button
  down; an empty value leaves the form open for another try.
- **For the agent alone, unless it asked otherwise.** The agent chooses the
  scope when it asks (`scope: "shared"` stores one key for the whole fleet,
  which other agents can use once their own souls list it),
  and the message says which before anyone clicks.
- **It grants the key to the agent that asked**, by adding the name to that
  agent's soul under `credentials:`. A shared key is still granted only to
  that one agent; others need their own soul entry. The agent can use it
  from its next reply. A soul file given to another agent while the
  request waited stores nothing: the form says so, and the agent asks again.
  A key stored whose soul could not then be written is recorded like any
  other (`credential.provided`, with the error), and the message says the
  agent cannot use it until the name is added to its soul by hand.
- **The value never enters the conversation.** It goes from the form to
  `~/.stratus/credentials.json` and nowhere else: not the thread, the
  transcript, the model, the event stream, or the daemon log. What the log
  records is the name, the scope, and who added it.
- **Slack hears back in time.** A submission is answered within Slack's
  three-second window. When storing takes longer, the form closes first,
  and if the key then could not be added, the submitter gets a private
  message saying why.

An agent asks only in a conversation a channel started, and only in a
channel that can show the form, which today is Slack; a scheduled or HTTP
turn, or a conversation in another channel, is told to have the operator run
`stratus credential set` instead. For Slack that means a turn the adapter
started from a Slack message, and the form goes to that message's thread:
session metadata saying `channel: slack` is not enough, since a control API
caller can write it. The agent hears that its operator was asked
only once the form is posted. With no approver configured for it, or a post
Slack refused, or a conversation no approver can see (a direct message with
someone who is not one, or a private channel or group DM with none of them
in it), nothing is posted or left pending, and the agent is told why,
so it never says it is waiting on someone who cannot see the question.
Where the daemon serves the control API, the agent is handed a one-time
link to a form instead, and it can ask for one directly with `via: "link"`
([Remote access](./remote-access.md#adding-a-credential-from-a-link)). A
key that is already stored, or supplied by the daemon's environment, but not
granted is not asked for either: the agent is told to have it added to its
soul. Requests live in the daemon's memory, so after a restart
the first click on an old button answers that the request is no longer
pending and takes the button down for everyone, and the agent asks again. The form uses Slack's interactivity, which the app manifest in
the [`@stratusagent/channel-slack` README](../../packages/channel-slack/README.md)
already turns on for approval buttons; no scope is added.

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
  way. The label does not refuse anyone; `"admit": "principals"` in the
  same block does, so an agent with tools answers only the people you
  listed. How and why is in [Who counts as the
  operator](../../packages/channel-slack/README.md#who-counts-as-the-operator)
  and [Memory](../concepts/memory.md#where-a-fact-came-from).
- **Replies are translated to Slack's markup.** Agents write Markdown; Slack
  renders mrkdwn, where bold is `*one asterisk*` and headings do not exist. The
  adapter converts on the way out, leaving code spans and fences as written —
  so a soul does not need a "you are on Slack" rule to be readable there.
  Slack has no tables either, so a Markdown pipe table becomes a code block
  with its columns lined up, or, when that is wider than 60 characters, one
  line per row with each value named by its column. The
  full list of what is converted is in the
  [`@stratusagent/channel-slack` README](../../packages/channel-slack/README.md).
- **Approval buttons** — with [`--approvals remote`](./approvals.md), a gated
  tool call parks the turn and asks in its thread with **Allow once** /
  **Always allow** / **Deny**. Clicks are authorized by *who clicked*, never
  by who can see the message.
- Nothing answers in Slack until the daemon runs — see
  [Always on](./always-on.md).
