// Types for the UI module a test imports. See grants.d.ts for why.
export interface TitleRoute {
  name: string;
  agentId?: string;
  tab?: string;
  section?: string;
  sessionId?: string;
}
/** What the dashboard calls the product. */
export const PRODUCT_NAME: string;
/** The browser tab title for a route: the page, then the product. */
export const pageTitle: (route: TitleRoute | undefined, agents?: Array<{ id: string; name?: string }>) => string;
