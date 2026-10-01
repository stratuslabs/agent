import type { JsonObject, Session, Tool } from '@stratusagent/core';

export const LEASE_REQUEST_TOOL_NAME = 'lease.request';

/** How long a requested lease runs when the agent does not say. */
export const DEFAULT_LEASE_REQUEST_DURATION = '1h';

/**
 * Asks a human for a lease on a credential. The gateway implements it: it
 * checks the request, puts it in front of an approver, and throws, with a
 * sentence the agent can repeat, when it cannot be put to anyone.
 */
export type LeaseRequester = (
  request: { credential: string; duration: string; maxUses?: number; reason: string },
  session: Session,
) => Promise<{ requestId: string }>;

/**
 * Ask an approver for a lease on a credential that may only be used under
 * one (`leases.credentials`).
 *
 * The lease is the approver's grant, not the agent's: this only asks, in
 * the conversation the agent is already in, with the terms the agent wants
 * shown to whoever decides. Nothing is granted until a person approves, and
 * an approved lease is an ordinary one, revocable like any other.
 *
 * `safe`: it asks a question, and a human decides everything after that.
 */
export const createLeaseRequestTool = (requestLease: LeaseRequester): Tool => ({
  name: LEASE_REQUEST_TOOL_NAME,
  description: 'Ask an approver for a lease on a credential that may only be used under one, when a tool was refused because you hold no live lease. They are shown the credential, how long, how many uses, and your reason, and approve or deny it; once approved, the key works from your next reply until the lease runs out.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      credential: { type: 'string', description: 'The credential, as the refusal named it: github.token, search.apiKey. Not a model sign-in (provider:…), which only your operator grants.' },
      duration: { type: 'string', description: `How long the lease should run once approved: 30m, 2h, 7d. Default ${DEFAULT_LEASE_REQUEST_DURATION}. Ask for no longer than the task needs.` },
      uses: { type: 'integer', minimum: 1, description: 'How many uses of the key the task needs. Leave out for no limit inside the time.' },
      reason: { type: 'string', description: 'One sentence on what you need it for, shown to the person asked and kept on the lease.' },
    },
    required: ['credential', 'reason'],
  },
  async execute(input: JsonObject, session: Session) {
    const credential = typeof input.credential === 'string' ? input.credential.trim() : '';
    if (!credential) {
      throw new Error('lease.request needs "credential", the key to ask for a lease on.');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) {
      throw new Error('lease.request needs "reason": one sentence on what the key is for, for the person deciding.');
    }
    const duration = typeof input.duration === 'string' && input.duration.trim().length > 0
      ? input.duration.trim()
      : DEFAULT_LEASE_REQUEST_DURATION;
    const uses = input.uses;
    if (uses !== undefined && (typeof uses !== 'number' || !Number.isInteger(uses) || uses < 1)) {
      throw new Error('lease.request "uses" is a whole number, 1 or more; leave it out for no limit.');
    }
    const { requestId } = await requestLease(
      { credential, duration, ...(uses !== undefined ? { maxUses: uses } : {}), reason },
      session,
    );
    return {
      requested: true,
      requestId,
      credential,
      duration,
      ...(uses !== undefined ? { uses } : {}),
      note: 'An approver was asked in this conversation. Nothing is granted until they approve; once they do, the key works from your next reply.',
    };
  },
});
