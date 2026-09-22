# @stratusagent/gateway

`stratusd` — the always-on Stratus Agent process. Everything above the kernel presumes a process that outlives a terminal command; this is that process.

One gateway owns:

- **Durable sessions, one database per agent** — `ShardedSessionStore` over a `SqliteSessionStore` per agent (`node:sqlite`, Node 22.13+, no native deps) at `~/.stratus/agents/<id>/sessions.db`, so a store is opened on one agent's path and no query can return another's rows. The whole session round-trips as one JSON body, provider replay state included, so a conversation resumed after a daemon restart replays exactly. Session ids are caller-chosen and stable (channels derive them from conversations), which is what makes any inbound message resumable — and a fleet-wide index in `~/.stratus/fleet.db` is where such an id is claimed, where a lookup with no agent in hand resolves it, and what answers the reads that were never about one agent (status counts, per-agent activity, the listing, the restart sweeps). `start()` reconciles the index against the stores before anything reads either.
- **A per-provider runner pool** — each agent's soul pins its own provider/model; config re-resolves on every dispatch and runners are pooled by resolved configuration, so two agents never share a billing path or credentials by accident.
- **Dispatcher-backed delegation** — `agent.delegate` routes the target through the same per-provider dispatch as a direct message; a delegated specialist runs on *their* provider, never the delegator's.
- **Approval recovery** — a turn parked on a human is a durable checkpoint, not a lost turn. The runner records the parked call and the calls queued behind it *before* asking, and clears it before the tool runs, so the record covers exactly the window in which nothing has happened. On start the gateway sweeps for `pending_approval` sessions and finishes them: the parked call is re-asked (or refused, if its window ran out while the process was down), and the queue behind it drains, so every `tool_use` still ends with a `tool_result`. Earlier calls are never replayed — their results were already durable, and a re-asked request keeps the remainder of its original window rather than starting a new one. Calls made through a provider that drives its own inner loop are deliberately excluded: recovery re-enters the *kernel* loop and cannot rebuild that provider's, so those fail cleanly instead (see [04](../../docs/roadmap/04-agent-sdk-bridge.md)).
- **An activity watchdog** — progress-based, not wall-clock: any event from the session resets it, and an idle turn is aborted cleanly (the abort cancels the underlying provider request and kills tool subprocesses).
- **Single-flight per session** — a second message to a busy session queues behind the in-flight turn; different sessions run concurrently.
- **Live-refresh** — souls are re-read on each dispatch, so an edited persona or allowlist reaches existing conversations on their next turn. Sessions pin an agent *id* and never cross identities.

```ts
import { createGateway } from '@stratusagent/gateway';

const gateway = createGateway();
await gateway.start();
const session = await gateway.dispatch({
  sessionId: 'slack:ava:T1:C1:171234.5678', // stable → resumable
  agentId: 'ava',
  userMessage: 'morning!',
});
await gateway.stop(); // drains in-flight turns first
```

Run it in the foreground with `stratus serve`. A launchd template for macOS lives in `launchd/com.stratuslabs.stratusd.plist`.

**A host that starts the gateway itself owns the state migration.** `stratus serve` claims the home (`claimHome`) and runs the pending migrations before it ever calls `createGateway`. A host doing its own wiring must do the same on a directory written by a build before the per-agent layout: `start()` refuses one that still holds a shared `sessions.db` or an `<id>.whitelist.json`, rather than opening empty stores over it and starting a second population beside every session, schedule, and grant already there. The message names the fix — claim the home, then `await runStateMigrations(env, { exclusive: true })` from `@stratusagent/state`. The gateway will not do it unasked: the move needs the directory to itself, and only the host knows whether it has it.

The question is asked about `stateDir` — the directory the stores were actually opened on — not about `~/.stratus`. A host that set its own `stateDir` is stranding *that* directory's sessions, and `stratus update` does not migrate a directory it does not know about; the refusal says so rather than pointing at a remedy that would not apply.
