// Types for the UI module a test imports. See grants.d.ts for why.
export interface DecisionView {
  allowed: boolean;
  layer: string;
  reason: string;
  verdict?: 'allow' | 'ask' | 'block';
  reviewCode?: string;
  shadow?: boolean;
}
/** What was decided and by which check, for the line beside a call. */
export const decisionNote: (decision: DecisionView) => string;
/** How the note is colored: a refusal, a shadow decision that would have stopped the call, or neither. */
export const decisionTone: (decision: DecisionView) => 'ok' | 'warn' | 'bad';
