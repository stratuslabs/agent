import type { CredentialDelivery, CredentialScope, JsonObject, Session, Tool } from '@stratusagent/core';

export const CREDENTIAL_REQUEST_TOOL_NAME = 'credential.request';

/**
 * Asks a human for a credential. The gateway implements it: it checks the
 * request, puts it to someone (a form in this conversation, or a one-time
 * link for the agent to pass on), and answers with how. It throws, with a
 * sentence the agent can repeat, when the request cannot be put to anyone.
 *
 * `via` absent means a form where the conversation can show one and a link
 * where it cannot. `formUnavailable` says why a link came back when no link
 * was asked for.
 */
export type CredentialRequester = (
  request: { name: string; scope: CredentialScope; reason?: string; via?: CredentialDelivery },
  session: Session,
) => Promise<
  | { requestId: string; via: 'form' }
  | { requestId: string; via: 'link'; url: string; expiresAt: string; localOnly?: boolean; formUnavailable?: string }
>;

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
  description: 'Ask your operator for a named credential you do not hold (for example github.token). They are shown a form to add it, in this conversation where it can show one, or behind a one-time link you are given to pass on; you never see the value, and once they add it the tools that need it can use it from your next reply. Scope "agent" (the default) keeps it yours alone; "shared" stores it once for the fleet, but it is granted only to you: another agent can use it only once its own soul lists the name.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The credential name, as the tool that needs it documents it: search.apiKey, github.token.' },
      scope: { type: 'string', enum: ['agent', 'shared'], description: 'Where the key is stored. Default "agent", for you alone; "shared" stores one value other agents can be granted too.' },
      reason: { type: 'string', description: 'One sentence on what you need it for, shown to the person asked.' },
      via: {
        type: 'string',
        enum: ['form', 'link'],
        description: 'How to ask. Omit it for a form here when this conversation can show one, and a link otherwise; "link" when the person would rather not enter the key in this conversation\'s app.',
      },
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
      throw new Error('credential.request "scope" is "agent" (yours alone, the default) or "shared" (stored once for the fleet).');
    }
    const via = input.via;
    if (via !== undefined && via !== 'form' && via !== 'link') {
      throw new Error('credential.request "via" is "form" (in this conversation) or "link" (a one-time link to pass on); omit it to let the daemon choose.');
    }
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : undefined;
    const asked = await requestCredential({
      name,
      scope,
      ...(reason !== undefined ? { reason } : {}),
      ...(via !== undefined ? { via } : {}),
    }, session);
    const after = 'You will not see the value; once they add it, the tools that need it can use it from your next reply.';
    if (asked.via === 'form') {
      return { requested: true, requestId: asked.requestId, name, scope, via: 'form', note: `Your operator was asked in this conversation. ${after}` };
    }
    return {
      requested: true,
      requestId: asked.requestId,
      name,
      scope,
      via: 'link',
      link: asked.url,
      expiresAt: asked.expiresAt,
      // Said to the agent because the agent is the one holding the link:
      // whoever it hands it to can add the key, once.
      note: `${asked.formUnavailable !== undefined ? `${asked.formUnavailable} ` : ''}`
        + `Give this link to the person who should add ${name}: it opens a form for it, works once, and expires at ${asked.expiresAt}. `
        + `Anyone holding it can add the key, so share it only with them, and never ask for the key itself in chat. `
        + (asked.localOnly === true
          ? 'It points at the daemon\'s local address, so it opens only on the machine the daemon runs on; say so, and that setting api.publicUrl gives links that open elsewhere. '
          : '')
        + after,
    };
  },
});
