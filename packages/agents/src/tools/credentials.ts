import type { CredentialScope, JsonObject, Session, Tool } from '@stratusagent/core';

export const CREDENTIAL_REQUEST_TOOL_NAME = 'credential.request';

/**
 * Asks a human for a credential. The gateway implements it: it checks the
 * request, announces it for a channel to render, and answers with what the
 * agent should say. It throws, with a sentence the agent can repeat, when
 * the request cannot be put to anyone.
 */
export type CredentialRequester = (
  request: { name: string; scope: CredentialScope; reason?: string },
  session: Session,
) => Promise<{ requestId: string }>;

/**
 * Ask the operator for a named credential this agent does not hold.
 *
 * The value never comes back through here, or anywhere the model can see:
 * the channel puts a form in front of an approver, the form's answer goes
 * straight to the credential store, and the name is added to this agent's
 * soul so its tools can use it from the next reply. An agent that went
 * searching its files and environment for a key its operator had stored
 * elsewhere is why the path exists, and why the only thing an agent can do
 * with a secret is ask for one.
 *
 * `safe`: it asks a question in the conversation the agent is already in,
 * and a human decides everything after that.
 */
export const createCredentialRequestTool = (requestCredential: CredentialRequester): Tool => ({
  name: CREDENTIAL_REQUEST_TOOL_NAME,
  description: 'Ask your operator for a named credential you do not hold (for example github.token). They are shown a form to add it; you never see the value, and once they add it the tools that need it can use it from your next reply. Scope "agent" (the default) keeps it yours alone; "shared" offers it to every agent.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The credential name, as the tool that needs it documents it: search.apiKey, github.token.' },
      scope: { type: 'string', enum: ['agent', 'shared'], description: 'Whose key it is. Default "agent", for you alone.' },
      reason: { type: 'string', description: 'One sentence on what you need it for, shown to the person asked.' },
    },
    required: ['name'],
  },
  async execute(input: JsonObject, session: Session) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw new Error('credential.request needs "name", the credential to ask for.');
    }
    const scope = input.scope ?? 'agent';
    if (scope !== 'agent' && scope !== 'shared') {
      throw new Error('credential.request "scope" is "agent" (yours alone, the default) or "shared" (every agent).');
    }
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : undefined;
    const { requestId } = await requestCredential({ name, scope, ...(reason !== undefined ? { reason } : {}) }, session);
    return {
      requested: true,
      requestId,
      name,
      scope,
      note: 'Your operator was asked in this conversation. You will not see the value; once they add it, the tools that need it can use it from your next reply.',
    };
  },
});
