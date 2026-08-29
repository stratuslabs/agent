## What changed

<!-- What this does, and why it is worth doing. Prose is fine — this is
     the thing a reviewer reads first. -->

## Docs

<!-- Name the file, don't tick a box. "Documented in docs/guides/logs.md"
     is checkable; "yes, documented" is not.

     Anything a user can see needs a line here: a new command or flag, a
     changed default, a new file the CLI writes, a changed setup menu.
     Deferring is allowed — say so and say when, so it is visible now
     rather than discovered three releases later. -->

- Documented in:

## Checks

- [ ] `pnpm build && pnpm typecheck && pnpm test` green locally
- [ ] New behavior has a test that fails without the change

## Notes for review

<!-- Anything deliberately left out, a tradeoff worth arguing about, or a
     limit a reader should know before relying on this. Delete if none. -->
