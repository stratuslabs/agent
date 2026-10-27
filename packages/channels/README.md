# @stratusagent/channels (deprecated)

The channel contract for [Stratus Agent](https://github.com/stratuslabs/agent) now ships in `@stratusagent/core`. This release of `@stratusagent/channels` only re-exports the same names from there. No release after this one is planned.

Change your imports:

```ts
// before
import { channelSessionKey, type ChannelAdapter } from '@stratusagent/channels';
// after
import { channelSessionKey, type ChannelAdapter } from '@stratusagent/core';
```

Then drop `@stratusagent/channels` from your dependencies. Nothing else changes: the names, types, and behavior are the ones this package exported before.
