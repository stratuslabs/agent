/**
 * The permission decision shown beside a call in the live session view,
 * from a `permission.decided` event: what was decided, which check decided
 * it, and a reviewer's code when one did. The event carries no tool input,
 * so neither does this.
 */

const PAST = { allow: 'allowed', ask: 'asked', block: 'blocked' };

export const decisionNote = (decision) => {
  // A shadow decision changed nothing (the call ran as it would have), so
  // it is said as what it would have done, never as what happened.
  const head = decision.verdict === undefined
    ? `${decision.shadow === true ? 'shadow: ' : ''}${decision.allowed ? 'allowed' : 'refused'}`
    : decision.shadow === true
      ? `would have ${PAST[decision.verdict] ?? decision.verdict}`
      : decision.verdict;
  return [head, decision.layer, decision.reviewCode].filter((part) => part !== undefined && part !== '').join(' · ');
};

export const decisionTone = (decision) => {
  // Shadow first: the policy reports what it would have done, refusals
  // included, but nothing was refused, so it is never shown as one.
  if (decision.shadow === true) {
    return decision.allowed && (decision.verdict === undefined || decision.verdict === 'allow') ? 'ok' : 'warn';
  }
  return decision.allowed ? 'ok' : 'bad';
};

/**
 * Where a shadow decision goes among a turn's call lines: the earliest line
 * for that call still without one, or -1 when none is waiting. A call is its
 * id and its tool, since an endpoint that numbers its calls per response
 * reuses ids. Reviews settle in the order their calls were made, near
 * enough, which keeps a reused id on the same tool from taking a later
 * call's shadow.
 */
export const shadowLineIndex = (lines, callId, toolName) =>
  lines.findIndex((line) => line.decides && line.callId === callId && line.toolName === toolName && line.shadow === undefined);

/**
 * The stored results a finished turn's call lines belong to, by message
 * index, so the decisions seen live stay beside the calls once the stored
 * transcript replaces the live lines. Every call stores one result, ran or
 * denied, so each line that decides is matched to the latest result for its
 * call not already taken, working back from the end. The walk stops at the
 * user message that started the turn: a line whose result is missing goes
 * without, rather than taking an earlier turn's result that reused its id.
 */
export const settledLines = (messages, lines) => {
  const matched = new Map();
  let start = messages.length;
  while (start > 0 && messages[start - 1].role !== 'user') {
    start -= 1;
  }
  let before = messages.length;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at];
    if (!line.decides) {
      continue;
    }
    for (let index = before - 1; index >= start; index -= 1) {
      const result = messages[index].role === 'tool' ? messages[index].toolResult : undefined;
      if (result !== undefined && result.callId === line.callId && result.toolName === line.toolName) {
        matched.set(index, line);
        before = index;
        break;
      }
    }
  }
  return matched;
};
