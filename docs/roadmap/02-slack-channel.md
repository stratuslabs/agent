# 02 — Slack Channel: contract package + per-agent bot identity

## Goal

Talk to Stratus agents in Slack, where each agent has its own name, avatar, and presence, threads are resumable conversations, and replies stream via message edits.

## Why now

This is the first real front door for a running fleet, and the forcing function for the channel contract that every later adapter (Discord, Telegram, email) reuses.

## Scope

**In:**

- New package `@stratusagent/channels` — the transport contract, no vendor code:
  - `InboundMessage` (channel kind, team/workspace, conversation, thread, author, text, mentions),
  - `OutboundConnection` (post, edit, typing indicator, **file upload** — the adapter converts tool results that reference workspace file paths, like screenshots, into outbound attachments),
  - `ChannelAdapter` lifecycle (`start(gateway)`, `stop()`) plus the inbound → router → session-key mapping helpers.
- New package `@stratusagent/channel-slack`:
  - **Socket Mode** (no public ingress — required for machines behind NAT).
  - **One Slack app per agent.** Slack cannot give one bot multiple identities with real avatar/presence/DMs, so the adapter holds a map of bot token → agent id and runs one socket per agent. A Slack **app manifest template** ships in the package so creating an agent's app is a 2-minute copy-paste; setup docs cover it.
  - Session key convention: `slack:<agent-id>:<team>:<channel>:<conversation>`, where `<conversation>` is `thread_ts ?? ts` for channel messages — a top-level mention has no `thread_ts`, and falling back to its own `ts` roots the conversation at that message's reply thread instead of collapsing every top-level mention in a channel into one shared session — and the DM channel id for DMs (deliberately one ongoing conversation per peer). Passed to `gateway.dispatch` — thread = conversation, resumable across daemon restarts (from step 01). The agent id is part of the key: two agents mentioned in the same thread hold two independent sessions, and the gateway rejects a dispatch whose stored session belongs to a different agent than the one addressed — a session never crosses agent identities.
  - Streaming replies: post a placeholder, then edit on `provider.delta` batches (throttled to respect `chat.update` rate limits), finalize on completion. Typing indicator held for the whole turn.
  - Routing: mention/DM of an agent's bot goes to that agent directly; `createAgentRouter` (already in `@stratusagent/agents`) covers shared-channel rules and fallback.
- Gateway config: `channels.slack.agents: [{ agentId, appToken, botToken }]`. App and bot tokens are **gateway infrastructure secrets, not agent capabilities**: they resolve through a service-credential namespace owned by the gateway (a `channels` section of `~/.stratus/credentials.json`), never through the agent-scoped `CredentialResolver` seam — an agent's credential allowlist neither needs nor grants access to its own transport tokens.

**Out:** any other channel adapter; slash commands; Slack approval buttons (that lands with step 03); multi-workspace per agent.

## Design sketch

- Dependency: `@slack/bolt` (or bare `@slack/socket-mode` + `web-api` if bolt is too framework-y — decide in the PR; bias to fewer layers).
- The adapter translates events only. It never touches providers, tools, or memory — it calls `gateway.dispatch` and renders the event stream back into Slack. If the adapter needs something the gateway can't give it, the fix is in the gateway, not a side door.
- Message hygiene: strip the bot mention from inbound text, map Slack user ids → display names for the model, split >4k-char replies across messages, render tool-call events as a compact status line (`⚙ running demo.echo…`) that gets replaced by the final text.
- Delivery guarantees: Socket Mode redelivers on missed acks — dedupe inbound by `envelope_id`/event id so a slow turn doesn't run twice.

## Acceptance criteria

- Two agents from the roster run simultaneously in one workspace, each with its own avatar and presence dot; each answers its own mentions and DMs.
- Two agents mentioned in the same thread keep fully separate sessions (history, tools, memory) — neither ever answers under the other's identity.
- A threaded conversation continues correctly after `stratusd` restarts mid-thread.
- Replies visibly stream (placeholder → edits → final), and a long tool-using turn shows the tool status line and holds the typing indicator throughout.
- A message that triggers `memory.remember` persists the fact; the same agent recalls it later in a *different* channel (memory is agent-keyed, proving the identity model end-to-end).
- Contract tests for `@stratusagent/channels` run against a fake adapter — the Slack package is not required to test the contract.

## Open questions

- ~~Group channels where multiple Stratus agents are present: respond only when mentioned, or allow a router rule to give one agent the room by default? (Start: mention-only outside DMs.)~~ **Answered: neither.** Mention-only outside DMs turned out to be the wrong shape of question — the frustration is not who owns a *room*, it is that a reply in the agent's own thread went nowhere and the conversation had to be restarted with an `@` every turn. So the unit is the **thread**, not the room: a mention starts a conversation, every reply inside that thread reaches the agent it was started with, and a channel message outside any thread is still nobody's. Where several agents share a thread, an untagged reply goes to whoever spoke last — ordered by the agents' own sessions (`SessionRouting.updatedAt`), so a mention hands the thread over and a restart forgets nothing, with no ownership state to keep. Rooms are left alone: no router rule gives an agent a channel by default, and a workspace keeps the old behavior simply by not granting the history scopes.
- Do we want an operator "admin channel" convention (daemon posts startup/errors there) in this step or with 03's approvals?
