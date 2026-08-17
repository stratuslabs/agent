# @stratusagent/gateway

`stratusd` — the always-on Stratus Agent process. Everything above the kernel presumes a process that outlives a terminal command; this is that process.

One gateway owns:

- **Durable sessions** — `SqliteSessionStore` on `node:sqlite` (Node 22.13+, no native deps). The whole session round-trips as one JSON body, provider replay state included, so a conversation resumed after a daemon restart replays exactly. Session ids are caller-chosen and stable (channels derive them from conversations), which is what makes any inbound message resumable.
- **A per-provider runner pool** — each agent's soul pins its own provider/model; config re-resolves on every dispatch and runners are pooled by resolved configuration, so two agents never share a billing path or credentials by accident.
- **Dispatcher-backed delegation** — `agent.delegate` routes the target through the same per-provider dispatch as a direct message; a delegated specialist runs on *their* provider, never the delegator's.
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
