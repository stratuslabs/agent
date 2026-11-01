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
