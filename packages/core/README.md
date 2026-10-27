# @stratusagent/core

The Stratus Agent kernel: contracts for sessions, providers, tools, agents, memory, credentials, and events, plus a minimal multi-turn orchestration runtime (`AgentRunner`) with in-memory defaults.

Providers, executors, transports, and UIs live in separate packages — core stays small, dependency-light, and platform-agnostic. What those packages build against is here: the channel contract a transport implements (`ChannelAdapter`, `channelSessionKey`, the sender policy) and the executor helpers (`successResult`, `failureResult`, `createDirectExecutor`), formerly the separate packages `@stratusagent/channels` and `@stratusagent/executors`.

See the [repository README](https://github.com/stratuslabs/agent) for the full picture.
