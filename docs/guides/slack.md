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
from anyone else in the thread who may talk to it: the people listed in
`principals.slackUsers` by default, or everyone under `admit: "anyone"`
(see [Who counts as the operator](../../packages/channel-slack/README.md#who-counts-as-the-operator)). Outside a
thread it stays quiet; a channel message nobody addressed to it is not its
business.

In a thread with more than one agent, an untagged reply goes to **the agent
the thread belongs to**: the first one to hold it, usually the one you
mentioned to start it. Mentioning another agent gets you its answer, and
your own untagged replies after that go to it too, until you name someone
else: `@Bea your turn`, then `and?`, is Bea's. The thread itself does not
move, so someone who has not named an agent in it is still answered by the
thread's owner.
Another app's bot that replied in the thread before any of your agents held
it owns the thread the same way, including an agent served by another daemon
or another machine. A thread an integration started (an alert, a deploy
note) belongs to the first agent you mention under it. A reply an agent
already took stays its own, even if Slack delivers it again after a
restart. The agent that stood down keeps
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
- `judge` — it hears everything, and **decides** whether an untagged
  message that is its own is one it should answer. Which messages are its
  own follows the `thread` rule above: the agent the sender last named,
  else the thread's owner, with no time limit, so an instruction an hour
  after its last answer still reaches it. The message runs a turn that is
  told nobody asked it anything and that it may say nothing, and a turn that
  says nothing leaves the thread untouched — no `…`, no `(no reply)`, and a
  line a failed attempt had started before the retry chose silence is
  deleted rather than left standing. So "thanks Blair, we've got it from
  here" works because it is a sentence the agent read, and a mention is
  still the way to be sure.

Judging costs a main-model call for each untagged message the agent owns,
answered or not, and exactly one agent takes each message. Every decision
is logged as one line, without the message text:
`slack: judge: blair took 1792….123 in C0… (owner)`. An agent that judges never takes a colleague's *reply* as
something to answer — two judging agents would otherwise talk to each other
— and in a thread that mixes a judging agent with one on the thread rule,
a judging agent that speaks takes the thread like any speaker — whoever's
reply sits lowest in the thread holds it — so the other stands down from
then on; a message typed while the judging agent was still deciding stays
the previous owner's. Editable without opening the
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
- Only the people listed in `principals.slackUsers` start a turn (the
  default `admit: "principals"`). Under `admit: "anyone"`, every member
  who can post in the channel does, which costs a model call each.
- It uses the same `channels:history` / `groups:history` scopes and
  `message.*` events as thread follow-through, and takes effect on restart.

## When agents tag each other

By default an agent ignores every other Slack bot, other agents included. To
let agents ask each other things in Slack, including agents on other
machines, turn on `agentMentions`:

```jsonc
// ~/.stratus/config.json (trusted configs only)
{
  "slack": {
    // Agents served by other daemons, by name: their Slack bot user ids,
    // in the same workspace as the agents that answer them.
    // This daemon's own agents are on the team already.
    "team": { "blair": "U0123ABCD", "nova": "U0456EFGH" },
    // On for every agent on this daemon...
    "agentMentions": true,
    "agents": {
      // ...or per agent, either way, with an optional list of who it answers.
      "nova": { "agentMentions": true, "agentMentionsFrom": ["blair"] }
    }
  }
}
```

- An agent with it on answers when a **team** agent names it: one of this
  daemon's agents, or one listed in `team`. With `agentMentionsFrom` set,
  only the agents listed there. Any other bot is always ignored. This holds
  under `admit: "principals"` too: turning it on is the opt-in.
- Only a mention counts. An untagged message from another agent is never a
  turn, and a bot's mention doesn't take over the thread from the people
  in it.
- The reply goes in the thread the other agent posted in. Each daemon's own
  Slack app hears the mention, so this works across machines.
- The reply isn't tagged automatically. The answering agent is told the
  asker's tag and includes it when the asker needs to see the answer; an
  untagged reply reaches only the people in the thread. For the asker to
  hear a tagged answer, it needs `agentMentions` on as well.
- What another agent says is labelled `unknown`, below an operator, even if
  its bot is listed as a principal. Nothing here can see what its words were
  built from. It can't stop a turn, and approvals still go to the people in
  `approvals`.
- Loop guard: a thread takes at most 4 agent mentions in a row on each
  daemon. After that the agents stop answering each other until a person
  says something in the thread. The count is kept in memory, so a restart
  resets it.
- It takes effect on restart.

## How replies appear

By default an agent posts finished messages, never a `…` that is then
rewritten in front of you. Whatever it writes before its first tool is
posted as that tool starts — "On it, checking the three PRs" reaches the
thread at once, not an hour later.

After that, a task keeps one progress message up to date instead of
posting each step. Its first line comes from the tools the agent actually
called, not from what it says about them: "⚙ Working · step 3: `shell.run`",
"⏸ Waiting for approval to run `shell.run`", and at the end "✓ Done ·
7 steps", "■ Stopped after 3 steps" or "✗ Failed after 3 steps". Anything
else the agent writes between tools goes under that line, newest last;
a passage too long to fit there is posted whole as a message of its own.
The progress message opens once a task has worked for ten seconds, or as
soon as the agent writes something more between tools, so a quick answer
is just the answer. The finished reply follows as its own message; when
the agent's last words came before its last tool call, those words are
the reply rather than a line in the progress message.

While it works, Slack shows its own loading status under the
agent's name: "is thinking…", or "is running shell.run…" while a tool runs.
The same step also goes out as Slack's loading message ("Running
shell.run…"), for Slack's newer agent sessions, which replace the status
line with their own text ("Finding answers…"). A turn nobody asked for (an agent that
[judges](#how-an-agent-listens)) shows no status, since it may decide to
say nothing.

Messages you send while it is still working reach it at its next step:
once the tool it is running finishes, it reads them before it decides what
to do next, so "skip the tests" lands mid-task, and the reply it posts
answers them along with what you first asked. If it is already writing
its final reply, they wait, and its next turn answers everything that
queued in one reply. An agent on a provider that runs its own tool loop
(Codex, or Claude through a subscription sign-in) doesn't take messages
mid-task yet: they always wait for the next turn. In a DM each message
shows the status as soon as you send it, so a second message never makes
the agent look idle; in a channel thread the status keeps saying what the
running turn is doing until its reply posts.

If you would rather watch the reply being written, set `stream`: the agent
posts a `…` placeholder at once, edits it as the reply arrives, shows
`⚙ tool…` lines while tools run, and finalizes it — how every reply looked
before `final` existed.

To have an agent read more like someone texting, set `texts`: it works the
way `final` does, but each paragraph of a reply is posted as a message of
its own, in order, in the same thread. The words before a tool are split the
same way. A code block, a list, a heading with the paragraph under it, and a
line ending in a colon with what it introduces each stay in one message. A
reply is at most five messages, and anything past the fifth paragraph stays
together in the last one. Messages the agent sends with `message.send` and
error notices are posted as written.

```jsonc
// ~/.stratus/config.json — trusted configs only
{
  "slack": {
    "replies": "final",              // the default; or "stream" or "texts"
    "agents": {
      "blair": { "replies": "stream" }, // per agent, over the default
      "atlas": { "replies": "texts" }
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

## Stopping a turn

Reply `stop` in the thread (or the DM) while the agent is working, or
`@agent stop` when more than one agent is in the thread. The agent's running
turn is cancelled, along with any of its turns queued behind it in that
conversation, and the reply reads "Stopped by @you." A tool call in progress
is cancelled the same way a timeout cancels it, and an approval it was
waiting on is cancelled and its card says so. A tool that doesn't stop when
asked (usually a plugin's) gets 2 seconds, then the turn ends without it.
Its result says it was left behind and may still be running.

Only the agent's approvers (`approvals.slackApprovers`) can stop it. From
anyone else, or when nothing is running, `stop` is an ordinary message. An
untagged `stop` goes to the agent that holds the thread, including one that
only answers mentions or judges; the others only hear it. Under `admit: "principals"`, an approver who is not a listed
principal can still stop the agent by naming it (`@agent stop`), and
nothing else they send is admitted.

A turn the daemon picked back up after a restart is stopped the same way,
and the thread reads "Stopped by @you." In the moment after a restart while
the daemon is still loading that turn, nothing is running yet, so a `stop`
sent then is handled as an ordinary message after the turn. A scheduled
firing runs in its own session, not the thread's, so a `stop` under a
schedule's report does not reach it.

## Sending an image

Attach a screenshot — a PNG, JPEG, GIF, or WebP — to a message, or drop one
into the thread on its own, and the agent is shown it. That takes the
`files:read` scope, which the manifest `stratus setup` prints includes; an
app installed before it needs the scope added under **OAuth & Permissions**
and a reinstall, and until then `stratus serve` warns, naming the scope,
whenever an image arrives.

An image over 5 MB or 8000 pixels a side, the model API's limits, is sent as
Slack's own preview of it, up to 1024 pixels a side, and the agent is told it
is seeing a scaled preview. Small text in a full-screen Retina screenshot may
not survive that, so send a crop of the part that matters.

Text files are read too. Attach a Markdown plan, a CSV, a JSON file, or a
log, and its contents reach the agent with your message, up to 100 KB a
file and 200 KB a message. A larger text file, up to 10 MB, is saved under
the agent's workspace in `attachments/slack/`, and the agent is told the
path so it can read it with its file tools. The saved file keeps the
sender's trust label, so reading it back counts as reading what that person
sent. An agent keeps up to 256 MB, and 1,000 files, of saved attachments; past that, a new one
reaches the agent by name only and the daemon log says which directory to
clear. Nothing is deleted for you. Anything else — a PDF, a Word file, an image over 5 MB or 8000 pixels
a side that Slack made no preview of, one that would take a single message's images past 20 MB together,
or a text file over 10 MB — reaches the
agent by name, with the reason it was not read: not a kind of file read
here, too large, not downloaded (in time, or at all), or not readable as
text or an image. It answers honestly from that note rather than as if it
had read the file, and without guessing at a cause the note does not give.
A message the agent only overheard names its files as not opened.

Files are downloaded only from Slack's own file host, `https://files.slack.com`.
A remote file, which another app added as a link to a file it hosts somewhere
else, is never fetched: Slack hands out that app's own link in place of a
Slack one, and the bot token is not sent outside Slack. The agent gets it by
name, as not downloaded, and the daemon log names the host.

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
  Removing a key stays on the machine, and so does replacing one, except
  through a replace request (below). A request whose name
  was stored since it was made (another form for the same shared key, or
  the machine) can never be answered, so the refusal also takes its button
  down; an empty value, or a PEM key whose line breaks were lost, leaves the
  form open for another try. The field is one line, so a new key file such as
  a PEM private key goes through a [link](./remote-access.md#adding-a-credential-from-a-link)
  (`via: "link"`), and a replacement one, which only a form can take, through
  `stratus credential set <name> < key.pem` on the machine.
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
- **Replacing a key the agent holds** (`credential.request` with
  `replace: true`, for an expiring or revoked token) puts up the same kind
  of form, titled **Replace a credential**, with the same approver checks.
  It's only asked for a key the agent already holds and is granted, always as
  a form and never a link, and only where the key is stored: the agent's own
  entry, or a shared one when the agent asked with `scope: "shared"` (that
  changes the key for every agent granted it). A key the daemon's
  environment supplies can't be replaced from here. The new value is written
  beside the old file and renamed over it, so the old key stays until the
  new one is saved, and the next command or tool call uses the new one with
  no restart.
- **A key for the agent's shell says so.** When the agent asks with `env`
  (`credential.request` with `env: "GH_TOKEN"`, for a CLI or script that
  reads its token from a variable), the message and the form both say
  "Kai's shell commands will be able to read this as `GH_TOKEN`, so Kai can
  see the value". Answering stores the value and that binding together, and
  the agent's next command has `$GH_TOKEN`, with no config edit or restart.
  See [tool-shell](../../packages/tool-shell/README.md#stored-credentials-in-the-environment).
- **Every key added or replaced from a form or a link writes an audit
  line** to `~/.stratus/credential-audit.log`: when, which name, whose store,
  added or replaced, the approver's Slack id, form or link, and the variable
  when one was bound. It holds names only, never a value.

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
  the agent answers nobody in Slack: only listed principals get a turn
  (`"admit": "principals"`, the default). `stratus setup` asks for your
  member ID when you connect an agent. Member IDs belong to one workspace,
  so setup also asks when the list the agent would use, its own or
  inherited, isn't confirmed for this workspace by a bot already using it
  there (Enter keeps it), and saves a first list for this agent alone
  while another Slack agent is in a different workspace. `stratus doctor` flags
  an agent nobody is listed for. `"admit": "anyone"` in the same block opens the
  door to every workspace member, labelled `unknown`, and every fact the
  agent remembers from them carries that label. How and why is in [Who counts as the
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
- **Bookmarks** — a `message.read` of a channel's top level also returns the
  channel's bookmarks. It needs the `bookmarks:read` scope, which the
  manifest asks for. An app created before it should have the scope added
  under **OAuth & Permissions** and be reinstalled; until then the read
  returns the messages and tells the agent the scope is missing. Details in
  [Reading a channel](../../packages/channel-slack/README.md#reading-a-channel).
- **Images in a read** — `message.read` shows the agent the images on the
  messages it reads, at most 5 and 10 MB per read, held to the same limits
  as an image someone sends it (Slack's preview for one over 5 MB). Each
  message says which images it showed and why any other was not, so the
  agent can read fewer messages to see the rest. It uses the `files:read`
  scope the manifest already asks for. Details in
  [Reading a channel](../../packages/channel-slack/README.md#reading-a-channel).
- **Reading your own DM** — in a DM, `message.read` can read that DM's
  earlier messages and threads, so an agent can look back past what its
  session holds. Every other DM stays unreadable, whatever is approved.
  Details in [Reading a channel](../../packages/channel-slack/README.md#reading-a-channel).
- **Creating channels** — `channel.create` makes a channel with the agent's
  own app, sets its topic and purpose, and invites people (Slack user ids)
  and other agents on this host. It needs the `channels:manage` scope for
  public channels and `groups:write` for private ones. The default manifest
  leaves both out, since most agents never create channels; add them under
  **OAuth & Permissions** for the agents that should, and reinstall. Without
  them the call says which scope is missing. It is a gated tool, so it goes
  through approvals like `message.send`. Details in
  [Creating a channel](../../packages/channel-slack/README.md#creating-a-channel).
- **Joining channels and inviting people** — `channel.join` joins an
  existing public channel with the agent's own app, by its id (`C…`, from
  the channel's link). An app can never join a private channel on its own:
  a member has to invite it. `channel.invite` invites people (Slack user
  ids) and other agents on this host to a channel the app is already in.
  Join needs the `channels:join` scope; invite needs `channels:write.invites`
  for public channels and `groups:write.invites` for private ones
  (`channels:manage` and `groups:write`, the `channel.create` scopes, also
  cover inviting). The default manifest leaves them all out; add them under
  **OAuth & Permissions** for the agents that should have them, and
  reinstall. Both are gated tools. Details in
  [Joining a channel and inviting people](../../packages/channel-slack/README.md#joining-a-channel-and-inviting-people).
- **Archiving a channel** — `channel.archive` archives a channel the
  agent's **own** app created (with `channel.create`, say), by its id. It
  refuses a channel another user or app created, a direct message, a channel
  shared with another workspace or organization, and the conversation the
  agent was asked from. Slack records the app's bot user as a channel's
  creator, so ownership is per Slack app: it relies on one app per agent,
  and it refuses every channel when another agent on the host uses the same
  app. An agent can't undo an archive (Slack doesn't let bot tokens
  unarchive); messages are kept, and a person can unarchive the channel in
  Slack. It uses the `channel.create` scopes, `channels:manage` (public) and
  `groups:write` (private), so no new scope. It is a gated tool. Details in
  [Archiving a channel](../../packages/channel-slack/README.md#archiving-a-channel).
- **Approval buttons** — with [`--approvals remote`](./approvals.md), a gated
  tool call parks the turn and asks in its thread with **Allow once** /
  **Always allow** / **Deny**. Clicks are authorized by *who clicked*, never
  by who can see the message.
- Nothing answers in Slack until the daemon runs — see
  [Always on](./always-on.md).
