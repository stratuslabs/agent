/**
 * Whether a policy's answer runs the call. Only `true` does: a refusal is
 * `false` or an object carrying the reason the agent is told, so a test
 * that asks "did it run?" compares this, not the answer itself.
 */
export const ran = (answer: unknown): boolean => answer === true;
