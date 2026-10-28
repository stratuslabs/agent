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
  request: { name: string; scope: CredentialScope; reason?: string; via?: CredentialDelivery; replace?: boolean; env?: string },
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
  description: 'Ask your operator for a named credential you do not hold (for example github.token). They are shown a form to add it, in this conversation where it can show one, or behind a one-time link you are given to pass on; you never see the value, and once they add it the tools that need it can use it from your next reply. Scope "agent" (the default) keeps it yours alone; "shared" stores it once for the fleet, but it is granted only to you: another agent can use it only once its own soul lists the name. '
    + 'To rotate a key you already hold (expiring, revoked), set replace: true: an approver gets a form in this conversation to enter the new value, which swaps the stored one in place. A replace is never a link, and a shared key needs scope "shared" to say so, since it changes the key for every agent that uses it. '
    + 'For a key a command or script you run with shell.run reads from an environment variable, set env to that variable (GH_TOKEN, TWILIO_AUTH_TOKEN): the form tells the person your shell will be able to read it, and once they add it your commands have it from your next reply, with no config change or restart.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The credential name, as the tool that needs it documents it: search.apiKey, github.token.' },
      scope: { type: 'string', enum: ['agent', 'shared'], description: 'Where the key is stored. Default "agent", for you alone; "shared" stores one value other agents can be granted too.' },
      reason: { type: 'string', description: 'One sentence on what you need it for, shown to the person asked.' },
      replace: {
        type: 'boolean',
        description: 'true to ask for a new value for a key you already hold, replacing the stored one. Form only.',
      },
      env: {
        type: 'string',
        description: 'The environment variable your shell commands should read the key from, for a CLI or script that reads its token from one: GH_TOKEN, TWILIO_AUTH_TOKEN. Uppercase, ending in _TOKEN, _KEY, _SECRET, _PASSWORD, _SID or _ID. Omit it for a key only a tool uses.',
      },
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
    if (input.replace !== undefined && typeof input.replace !== 'boolean') {
      throw new Error('credential.request "replace" is true (a new value for a key you hold) or false; omit it to ask for a key you don\'t have.');
    }
    const replace = input.replace === true;
    if (replace && via === 'link') {
      throw new Error('A replacement is asked for in a form an approver answers, never a link: a link lets whoever holds it change a key every call you make uses. Ask without via, in a conversation that can show a form.');
    }
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : undefined;
    if (input.env !== undefined && (typeof input.env !== 'string' || input.env.trim().length === 0)) {
      throw new Error('credential.request "env" is the environment variable your shell commands read the key from, like GH_TOKEN; omit it for a key only a tool uses.');
    }
    const env = typeof input.env === 'string' ? input.env.trim() : undefined;
    const asked = await requestCredential({
      name,
      scope,
      ...(reason !== undefined ? { reason } : {}),
      ...(via !== undefined ? { via } : {}),
      ...(replace ? { replace } : {}),
      ...(env !== undefined ? { env } : {}),
    }, session);
    const after = (replace
      ? 'You will not see the value; once an approver enters it, it replaces the stored one and your tools use it from your next reply.'
      : 'You will not see the value; once they add it, the tools that need it can use it from your next reply.')
      + (env !== undefined ? ` Your shell commands will read it as $${env} from then on.` : '');
    if (asked.via === 'form') {
      return { requested: true, requestId: asked.requestId, name, scope, via: 'form', ...(replace ? { replace } : {}), ...(env !== undefined ? { env } : {}), note: `Your operator was asked in this conversation. ${after}` };
    }
    return {
      requested: true,
      requestId: asked.requestId,
      name,
      scope,
      ...(env !== undefined ? { env } : {}),
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
