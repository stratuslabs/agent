// Types for the one UI module a test imports. The UI itself is plain ES
// modules with no build step; this declaration is what lets `pnpm typecheck`
// cover the test without pretending the module is TypeScript.
export interface Latest {
  /** Issue a ticket for a refresh that is starting now. */
  begin(): number;
  /** Whether no newer ticket has been issued since this one. */
  isCurrent(ticket: number): boolean;
}
export const createLatest: () => Latest;
