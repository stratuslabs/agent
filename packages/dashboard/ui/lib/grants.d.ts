// Types for the one UI module a test imports. The UI itself is plain ES
// modules with no build step; this declaration is what lets `pnpm typecheck`
// cover the test without pretending the module is TypeScript.
export type AlwaysMeans = 'scope' | 'origin' | 'tool' | 'session';
/** The line shown beside **Always allow**, or undefined when the lifetime is unknown. */
export const alwaysOffer: (always: AlwaysMeans | undefined, agentName: string) => string | undefined;
