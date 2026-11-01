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
/** One tool status line in the live session view. */
export interface CallLine {
  text: string;
  callId: string;
  toolName: string;
  /** True for the line a decision belongs beside: the call starting, or its refusal. */
  decides: boolean;
  decision?: DecisionView;
  shadow?: DecisionView;
}
/** The earliest line for this call (id and tool) still without a shadow decision, or -1. */
export const shadowLineIndex: (lines: readonly CallLine[], callId: string, toolName: string) => number;
/** A finished turn's deciding lines by the index of the stored result each belongs to. */
export const settledLines: (
  messages: readonly { role: string; toolResult?: { callId: string; toolName: string } }[],
  lines: readonly CallLine[],
) => Map<number, CallLine>;
