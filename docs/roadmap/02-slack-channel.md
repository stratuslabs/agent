# 02 — Slack Channel: contract package + per-agent bot identity

## Goal

Talk to Stratus agents in Slack, where each agent has its own name, avatar, and presence, threads are resumable conversations, and replies stream via message edits.

## Why now

This is the first real front door for a running fleet, and the forcing function for the channel contract that every later adapter (Discord, Telegram, email) reuses.

## Scope

**In:**

- New package `@stratusagent/channels` — the transport contract, no vendor code:
  - `InboundMessage` (channel kind, team/workspace, conversation, thread, author, text, mentions),
  - `OutboundConnection` (post, edit, typing indicator),
  - `ChannelAdapter` lifecycle (`start(gateway)`, `stop()`) plus the inbound → router → session-key mapping helpers.
- New package `@stratusagent/channel-slack`:
  - **Socket Mode** (no public ingress — required for machines behind NAT).
  - **One Slack app per agent.** Slack cannot give one bot multiple identities with real avatar/presence/DMs, so the adapter holds a map of bot token → agent id and runs one socket per agent. A Slack **app manifest template** ships in the package so creating an agent's app is a 2-minute copy-paste; setup docs cover it.
  - Session key convention: `slack:<team>:<channel>:<thread_ts>` (DMs: the DM channel id) passed to `gateway.dispatch` — thread = conversation, resumable across daemon restarts (from step 01).
  - Streaming replies: post a placeholder, then edit on `provider.delta` batches (throttled to respect `chat.update` rate limits), finalize on completion. Typing indicator held for the whole turn.
  - Routing: mention/DM of an agent's bot goes to that agent directly; `createAgentRouter` (already in `@stratusagent/agents`) covers shared-channel rules and fallback.
- Gateway config: `channels.slack.agents: [{ agentId, appToken, botToken }]`, tokens resolved through the existing `CredentialResolver` seam so they live in `~/.stratus/credentials.json`, not in config plaintext.

**Out:** any other channel adapter; slash commands; Slack approval buttons (that lands with step 03); multi-workspace per agent.

## Design sketch

- Dependency: `@slack/bolt` (or bare `@slack/socket-mode` + `web-api` if bolt is too framework-y — decide in the PR; bias to fewer layers).
- The adapter translates events only. It never touches providers, tools, or memory — it calls `gateway.dispatch` and renders the event stream back into Slack. If the adapter needs something the gateway can't give it, the fix is in the gateway, not a side door.
- Message hygiene: strip the bot mention from inbound text, map Slack user ids → display names for the model, split >4k-char replies across messages, render tool-call events as a compact status line (`⚙ running demo.echo…`) that gets replaced by the final text.
- Delivery guarantees: Socket Mode redelivers on missed acks — dedupe inbound by `envelope_id`/event id so a slow turn doesn't run twice.

## Acceptance criteria

- Two agents from the roster run simultaneously in one workspace, each with its own avatar and presence dot; each answers its own mentions and DMs.
- A threaded conversation continues correctly after `stratusd` restarts mid-thread.
- Replies visibly stream (placeholder → edits → final), and a long tool-using turn shows the tool status line and holds the typing indicator throughout.
- A message that triggers `memory.remember` persists the fact; the same agent recalls it later in a *different* channel (memory is agent-keyed, proving the identity model end-to-end).
- Contract tests for `@stratusagent/channels` run against a fake adapter — the Slack package is not required to test the contract.

## Open questions

- Group channels where multiple Stratus agents are present: respond only when mentioned, or allow a router rule to give one agent the room by default? (Start: mention-only outside DMs.)
- Do we want an operator "admin channel" convention (daemon posts startup/errors there) in this step or with 03's approvals?
