// Types for a UI module the tests import. The UI itself is plain ES
// modules with no build step; this declaration is what lets `pnpm typecheck`
// cover the test without pretending the module is TypeScript.
export type AlwaysMeans = 'scope' | 'origin' | 'tool' | 'destination' | 'session';
/** The line shown beside **Always allow**, or undefined when the lifetime is unknown. */
export const alwaysOffer: (always: AlwaysMeans | undefined, agentName: string) => string | undefined;
/** Whether a failed GET /grants means the daemon can't list grant owners (501, or 404 not_found from a daemon without the route). */
export const ownersUnknown: (error: unknown) => boolean;
