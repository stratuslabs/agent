// Types for the UI module a test imports. See grants.d.ts for why.
export interface Source {
  kind: 'web' | 'slack' | 'schedule' | 'event' | 'delegated' | 'other';
  icon: string;
  label: string;
  prompt?: string;
}
export interface SourceContext {
  schedules?: Array<{ id: string; prompt?: string; cadence?: string }>;
}
/** Where a conversation came from, read off its session id. */
export const sourceOf: (sessionId: string, context?: SourceContext) => Source;
/** A text's first non-empty line, cut to `max` characters. */
export const firstLine: (text: unknown, max?: number) => string;
/** A conversation's name in a list: its title, or where it came from. */
export const conversationTitle: (session: { id: string; title?: string }, context?: SourceContext) => string;
