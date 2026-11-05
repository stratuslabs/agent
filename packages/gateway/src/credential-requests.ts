/*
 * Credential requests: the `credential.request` tool, the requests it opens,
 * and answering one (storing the value, granting it, auditing the change).
 * Moved out of `createGateway` in index.ts as is: the statements are
 * unchanged, inside a factory that takes what they closed over there, and
 * `createGateway` calls it where they were and destructures what it returns.
 * formCredentialValue and isFlattenedPem, used only here, moved with them.
 */

import { randomUUID } from 'node:crypto';
import {
  type AgentRegistry,
  type CredentialDelivery,
  type CredentialScope,
  type EventBus,
  matchesToolAllowlist,
  type ToolRegistry,
  type UnlistedTools,
} from '@stratusagent/core';
import {
  createCredentialRequestTool,
  CREDENTIAL_REQUEST_TOOL_NAME,
  credentialVariableProblem,
} from '@stratusagent/agents';
import type { AgentSource } from './agent-source.ts';
import type { GatewayChannelAdapter, ProvideCredentialInput, ProvideCredentialResult } from './types.ts';
import {
  addNamedCredential,
  appendCredentialAudit,
  CREDENTIAL_NAME_PATTERN,
  grantSoulCredential,
  loadSoulFile,
  NamedCredentialExistsError,
  NamedCredentialMissingError,
  namedCredentialSource,
  quoteShellArg,
  replaceNamedCredential,
  type StateEnvironment,
  withSoulFileLock,
} from '@stratusagent/state';

/**
 * A value from a form, without the line breaks around it.
 *
 * Forms take multi-line values now, so a one-line key copied with the line
 * break after it would otherwise be stored with it, and fail later inside
 * whatever header or command it lands in. Only line breaks: a value's own
 * spaces are its own, as on the CLI.
 */
const formCredentialValue = (value: string): string => value.replace(/^[\r\n]+|[\r\n]+$/g, '');

/**
 * A PEM block (a private key, a certificate) with no line breaks left, which
 * is what a one-line field makes of a pasted key file. PEM readers need the
 * line after the `-----BEGIN …-----` header, so storing it would only move
 * the failure to the first call that reads the key. Only a value that *is*
 * one: a PEM inside JSON (a service account file) escapes its line breaks,
 * so it has none of its own and is fine as sent.
 */
const isFlattenedPem = (value: string): boolean =>
  /^\s*-----BEGIN [A-Z0-9 ]+-----/.test(value) && !value.includes('\n');

/** What credential requests close over in `createGateway`. */
export interface CredentialRequestsDeps {
  env: StateEnvironment;
  warn: (line: string) => void;
  bus: EventBus;
  startedChannels: GatewayChannelAdapter[];
  channelCarrying: (
    kind: string,
    agentId: string,
    capable: (candidate: GatewayChannelAdapter) => boolean,
  ) => { adapter?: GatewayChannelAdapter; carriesOthers: boolean };
  registry: AgentRegistry;
  sources: Map<string, AgentSource>;
  unlistedTools: () => UnlistedTools;
  tools: ToolRegistry;
}

export const createCredentialRequests = ({
  env,
  warn,
  bus,
  startedChannels,
  channelCarrying,
  registry,
  sources,
  unlistedTools,
  tools,
}: CredentialRequestsDeps) => {
  /**
   * Credential requests waiting on a person, by request id.
   *
   * In memory on purpose: a request is a question somebody is being asked
   * now, and a restart that forgot it only means the agent asks again. What
   * matters is that the entry carries everything the answer needs, so a
   * channel quoting the id back decides nothing about where the key goes.
   */
  const credentialRequests = new Map<string, {
    agentId: string;
    sessionId: string;
    name: string;
    scope: CredentialScope;
    soulPath: string;
    /** A new value for a key already stored where `scope` says, swapped in place. */
    replace?: boolean;
    /** The variable the agent's shell reads the key from once it is stored, which the form said. */
    env?: string;
    /** How it was put to someone, for the audit line. */
    via?: CredentialDelivery;
  }>();

  tools.register(createCredentialRequestTool(async (request, session) => {
    const agentId = session.agent.id;
    const soulPath = sources.get(agentId)?.soulPath;
    if (soulPath === undefined) {
      throw new Error(
        `${session.agent.name} is the built-in agent and has no soul file to grant a credential in. `
        + `Your operator can store one on the machine with \`stratus credential set ${request.name}\`.`,
      );
    }
    if (!CREDENTIAL_NAME_PATTERN.test(request.name)) {
      throw new Error(
        `${JSON.stringify(request.name)} is not a credential name. Use letters, digits, dots, dashes, or underscores, `
        + 'starting with a letter, the way the tool that needs it spells it: search.apiKey, github.token.',
      );
    }
    // The stricter rule, for a name the model picked: checked before anyone
    // is asked, so an approver never sees a form whose binding the store
    // would refuse, and so a variable that changes what a judged command
    // does (NODE_OPTIONS) is never offered at all.
    if (request.env !== undefined) {
      const problem = credentialVariableProblem(request.env, { requested: true });
      if (problem !== undefined) {
        throw new Error(`${problem} Nothing is pending.`);
      }
    }
    // A key already stored is not something to ask a person for again: the
    // form only adds, so it could only fail. Say what is actually missing.
    const source = await namedCredentialSource(env, agentId, request.name);
    const stored = source !== undefined;
    const granted = session.agent.credentials?.includes(request.name) === true;
    // Binding a key the agent already holds asks for no value, and every
    // form today has a value field, so phase 1 leaves it to the machine.
    const bindOnMachine = request.env !== undefined
      ? ` To have your shell read it as ${request.env}, ask your operator to run \`stratus credential env ${request.name} ${request.env} --agent ${quoteShellArg(agentId)}\` on the machine.`
      : '';
    if (request.replace === true) {
      // Checked here, before anyone is asked, so an approver is never shown
      // a form whose answer could only be refused.
      if (!stored || !granted) {
        throw new Error(`You don't hold ${request.name}, so there is nothing to replace. Ask for it without replace.`);
      }
      if (source === 'environment') {
        throw new Error(
          `${request.name} comes from the daemon's environment, which a form can't change. `
          + 'Ask your operator to change it where that environment is set.',
        );
      }
      if (source === 'shared' && request.scope !== 'shared') {
        throw new Error(
          `${request.name} is a shared credential, so replacing it changes the key for every agent granted it. `
          + 'Ask again with scope "shared" if that is what you mean.',
        );
      }
      if (source === 'agent' && request.scope === 'shared') {
        throw new Error(`${request.name} is your own credential, not a shared one. Ask again with scope "agent" to replace it.`);
      }
      if (request.via === 'link') {
        throw new Error('A replacement is asked for in a form an approver answers, never a link. Nothing is pending.');
      }
    } else if (stored && granted) {
      throw new Error(
        `You already hold ${request.name}; the tools that need it use it for you. To rotate it for a new value, ask again with replace: true.${bindOnMachine}`
        + (request.env !== undefined ? ' Nothing is pending.' : ''),
      );
    } else if (stored) {
      throw new Error(
        `${request.name} is already ${source === 'environment' ? "supplied by the daemon's environment" : 'stored'} but not granted to you. `
        + `Ask your operator to add it to the credentials list in your soul; a form would only refuse to store it again.${bindOnMachine}`,
      );
    }
    const onMachine = request.env === undefined
      ? `\`stratus credential set ${request.name}${request.scope === 'agent' ? ` --agent ${quoteShellArg(agentId)}` : ''}\``
      : request.scope === 'agent'
        ? `\`stratus credential set ${request.name} --agent ${quoteShellArg(agentId)} --env ${request.env}\``
        : `\`stratus credential set ${request.name}\`, then \`stratus credential env ${request.name} ${request.env} --agent ${quoteShellArg(agentId)}\``;
    const record = {
      agentId,
      sessionId: session.id,
      name: request.name,
      scope: request.scope,
      soulPath,
      ...(request.replace === true ? { replace: true } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
    };
    const announce = async (requestId: string, via: CredentialDelivery): Promise<void> => {
      await bus.emit({
        type: 'credential.requested',
        sessionId: session.id,
        agentId,
        requestId,
        name: request.name,
        scope: request.scope,
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
        via,
        ...(request.replace === true ? { replace: true } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(session.metadata ? { metadata: session.metadata } : {}),
      });
    };
    // A link only for an agent whose soul lists the tool. Every agent may
    // ask through a form, because a form goes to an approver; a link is a
    // bearer credential the model is handed, and whoever it reaches can
    // store a key and amend the soul. That is the operator's to allow.
    const allowlist = session.agent.tools ?? registry.get(agentId)?.tools;
    // An omitted list grants the safe tools, this one among them, but a
    // link is the operator's to allow by naming it, so only a list says yes.
    // On a home an older build set up an omitted list is every tool, and
    // has always allowed a link there.
    const linkAllowed = allowlist === undefined
      ? unlistedTools() === 'every'
      : matchesToolAllowlist(CREDENTIAL_REQUEST_TOOL_NAME, allowlist);
    // Why no form went up, said to the agent beside the link that replaces
    // it, so it can tell the person why they are getting a link instead.
    let formUnavailable: string | undefined;
    if (request.via !== 'link') {
      // Only a conversation a channel started has anywhere to show a form,
      // and only a channel that renders one can show it: a scheduled or
      // HTTP turn, or a channel with no form, would record a request nobody
      // sees while the agent tells its user the operator was asked.
      const kind = session.metadata?.channel;
      const { adapter } = typeof kind === 'string'
        ? channelCarrying(kind, agentId, (candidate) => candidate.requestCredential !== undefined
          && (request.replace !== true || candidate.credentialReplaceForms === true)
          // A form that can't say the key will be shell-readable must not
          // be the approval for it: a link says it instead.
          && (request.env === undefined || candidate.credentialEnvForms === true))
        : { adapter: undefined };
      if (!adapter?.requestCredential || !session.metadata) {
        formUnavailable = typeof kind === 'string'
          ? `This conversation's channel (${kind}) cannot show your operator a ${request.replace === true ? 'replacement' : 'credential'} form here${request.env !== undefined ? ' that says which variable your shell will read it from' : ''}.`
          : 'This conversation is not in a channel that can show your operator a form.';
      } else {
        const requestId = randomUUID();
        credentialRequests.set(requestId, { ...record, via: 'form' });
        // Delivered before it is announced, and dropped if delivery fails: a
        // request whose post never landed has no button to answer it, so
        // keeping it would leave it pending for good behind a tool result
        // saying the operator was asked.
        try {
          await adapter.requestCredential({
            sessionId: session.id,
            agentId,
            requestId,
            name: request.name,
            scope: request.scope,
            ...(request.reason !== undefined ? { reason: request.reason } : {}),
            ...(request.replace === true ? { replace: true } : {}),
            ...(request.env !== undefined ? { env: request.env } : {}),
            metadata: session.metadata,
          });
          await announce(requestId, 'form');
          return { requestId, via: 'form' };
        } catch (error) {
          credentialRequests.delete(requestId);
          formUnavailable = `The form could not be shown here: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (request.replace === true) {
        // Never a link: whoever holds one could change a key in use.
        throw new Error(`${formUnavailable} Nothing is pending. A replacement needs a conversation that can show an approver a form.`);
      }
      if (request.via === 'form') {
        throw new Error(`${formUnavailable} Nothing is pending. ${linkAllowed ? 'Ask for a link instead (via: "link"), or ask' : 'Ask'} your operator to store ${request.name} on the machine with ${onMachine} and grant it to you.`);
      }
    }
    if (!linkAllowed) {
      throw new Error(
        `${formUnavailable !== undefined ? `${formUnavailable} ` : ''}A one-time link needs ${CREDENTIAL_REQUEST_TOOL_NAME} in your soul's tools: list, and it is not there. Nothing is pending. `
        + `Ask in a conversation that can show your operator a form, or ask your operator to store ${request.name} on the machine with ${onMachine} and grant it to you.`,
      );
    }
    // A link where no form can go, from whichever adapter issues them: the
    // control API, which is not tied to any one agent's transport.
    const linker = startedChannels.find((candidate) => candidate.requestCredentialLink !== undefined);
    if (!linker?.requestCredentialLink) {
      throw new Error(
        `${formUnavailable !== undefined ? `${formUnavailable} ` : ''}No control API is running to issue a link either. `
        + `Ask your operator to store ${request.name} on the machine with ${onMachine} and grant it to you.`,
      );
    }
    const requestId = randomUUID();
    credentialRequests.set(requestId, { ...record, via: 'link' });
    let link: { url: string; expiresAt: string; localOnly?: boolean };
    try {
      link = await linker.requestCredentialLink({
        sessionId: session.id,
        agentId,
        agentName: session.agent.name,
        requestId,
        name: request.name,
        scope: request.scope,
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
      });
    } catch (error) {
      credentialRequests.delete(requestId);
      throw new Error(
        `A link for ${request.name} could not be issued: ${error instanceof Error ? error.message : String(error)} `
        + `Nothing is pending. Ask your operator to store it on the machine with ${onMachine}.`,
      );
    }
    await announce(requestId, 'link');
    return {
      requestId,
      via: 'link',
      url: link.url,
      expiresAt: link.expiresAt,
      ...(link.localOnly === true ? { localOnly: true } : {}),
      ...(formUnavailable !== undefined ? { formUnavailable } : {}),
    };
  }));

  /**
   * Requests an answer is being stored for now. Claimed before the first
   * await: two approvers submitting one form at once would otherwise both
   * start storing, and the second's add-only conflict would retire a
   * request the first was about to settle as added.
   */
  const answering = new Set<string>();

  const provideCredential = async (input: ProvideCredentialInput): Promise<ProvideCredentialResult> => {
    const request = credentialRequests.get(input.requestId);
    if (!request) {
      return { ok: false, retired: true, message: 'That credential request is no longer pending. Ask the agent to request it again.' };
    }
    if (answering.has(input.requestId)) {
      return { ok: false, message: 'Someone else\'s answer to this request is being stored right now. Wait a moment before trying again.' };
    }
    answering.add(input.requestId);
    try {
      return await answerCredentialRequest(input, request);
    } finally {
      answering.delete(input.requestId);
    }
  };

  /**
   * The audit line for a key changed from a chat or a link. After the
   * store, since it records what happened; a line that can't be written is
   * warned about rather than undoing a change that already landed.
   */
  const auditCredentialChange = async (
    action: 'add' | 'replace',
    request: NonNullable<ReturnType<typeof credentialRequests.get>>,
    actor: string | undefined,
  ): Promise<void> => {
    try {
      await appendCredentialAudit(env, {
        action,
        name: request.name,
        ...(request.scope === 'agent' ? { agentId: request.agentId } : {}),
        ...(actor !== undefined ? { actor } : {}),
        via: request.via ?? 'form',
        requestedBy: request.agentId,
        ...(request.env !== undefined ? { env: request.env, bindingFor: request.agentId } : {}),
      });
    } catch (error) {
      warn(`credentials: ${request.name} was ${action === 'add' ? 'added' : 'replaced'}, but the audit line could not be written (${error instanceof Error ? error.message : String(error)}).`);
    }
  };

  const answerCredentialRequest = async (
    input: ProvideCredentialInput,
    request: NonNullable<ReturnType<typeof credentialRequests.get>>,
  ): Promise<ProvideCredentialResult> => {
    // The agent must still be served from the file the request captured: a
    // repointed default soul (same id, another file) replaces the source,
    // and a grant landing in the old file would report a key the agent now
    // running cannot use.
    const served = sources.get(request.agentId)?.soulPath;
    if (served !== request.soulPath) {
      credentialRequests.delete(input.requestId);
      return {
        ok: false,
        retired: true,
        message: `${request.agentId} is no longer served from ${request.soulPath}, so nothing was stored. Ask ${request.agentId} to request it again.`,
      };
    }
    // The soul the grant will land in must still be the requester's, and is
    // checked before anything is stored: a file reassigned to another agent
    // while the request waited would otherwise receive a key nobody meant
    // to give it. `grantSoulCredential` checks again as it writes.
    let owner: string;
    try {
      owner = (await loadSoulFile(request.soulPath)).agent.id;
    } catch (error) {
      return {
        ok: false,
        message: `${request.agentId}'s soul could not be read (${error instanceof Error ? error.message : String(error)}), so nothing was stored.`,
      };
    }
    if (owner !== request.agentId) {
      credentialRequests.delete(input.requestId);
      return {
        ok: false,
        retired: true,
        message: `${request.soulPath} now belongs to ${owner}, not ${request.agentId}, so nothing was stored. Ask ${request.agentId} to request it again.`,
      };
    }
    const value = formCredentialValue(input.value);
    if (isFlattenedPem(value)) {
      // Refused, not retired: the same form can still take the key whole.
      const command = request.scope === 'agent'
        ? `stratus credential set ${request.name} --agent ${quoteShellArg(request.agentId)} < key.pem`
        : `stratus credential set ${request.name} < key.pem`;
      return {
        ok: false,
        message: 'That looks like a PEM key whose line breaks were lost, so nothing was stored: whatever reads it would fail. '
          + `Paste it again from the original file with its line breaks, or store it on the machine: ${command}.`,
      };
    }
    const store = {
      ...(request.scope === 'agent' ? { agentId: request.agentId } : {}),
      // The binding the form promised, written with the value, always for
      // the agent that asked: consent is per agent even for a shared key.
      ...(request.env !== undefined ? { bind: { agentId: request.agentId, variable: request.env } } : {}),
    };
    if (request.replace === true) {
      // Re-read under the soul lock, so a grant removed while the form
      // waited (a shared key most of all) is never rotated on its behalf.
      let stillGranted: boolean;
      try {
        stillGranted = await withSoulFileLock(async () => {
          const soul = await loadSoulFile(request.soulPath);
          if (soul.agent.id !== request.agentId || soul.agent.credentials?.includes(request.name) !== true) {
            return false;
          }
          await replaceNamedCredential(env, { name: request.name, value, ...store });
          return true;
        });
      } catch (error) {
        // Removed since the request was made: no value can land now.
        if (error instanceof NamedCredentialMissingError) {
          credentialRequests.delete(input.requestId);
          return { ok: false, retired: true, message: error.message };
        }
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (!stillGranted) {
        credentialRequests.delete(input.requestId);
        return {
          ok: false,
          retired: true,
          message: `${request.agentId} is no longer granted ${request.name} in ${request.soulPath}, so the stored key was kept. Ask ${request.agentId} to request it again if it still needs it.`,
        };
      }
      credentialRequests.delete(input.requestId);
      await auditCredentialChange('replace', request, input.actor);
      await bus.emit({
        type: 'credential.provided',
        sessionId: request.sessionId,
        agentId: request.agentId,
        requestId: input.requestId,
        name: request.name,
        scope: request.scope,
        replace: true,
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
      });
      // The soul already lists it: a replace is only asked for a key held.
      return { ok: true, name: request.name, scope: request.scope, agentId: request.agentId, granted: false };
    }
    try {
      await addNamedCredential(env, {
        name: request.name,
        value,
        ...store,
      });
    } catch (error) {
      // A name stored since the request was made (another form for the
      // same shared key, or the machine) is final under add-only: no value
      // typed into this form can ever land, so the request is retired
      // rather than left answering every submission with the same refusal.
      if (error instanceof NamedCredentialExistsError) {
        credentialRequests.delete(input.requestId);
        return { ok: false, retired: true, message: error.message };
      }
      // Otherwise refused, not failed: the request stays pending, so a
      // person who typed an empty value can try again from the same form.
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    credentialRequests.delete(input.requestId);
    await auditCredentialChange('add', request, input.actor);
    // Stored first, granted second: a key nobody may use is recoverable by
    // editing the soul, while a soul naming a key that was never stored
    // fails every call that reaches for it. Announced either way, because
    // the store already changed and a shared key is already usable.
    //
    // The served path is checked again under the soul lock, which roster
    // reloads take too: a default repointed while the key was being
    // written, or while the grant queued behind another soul edit, would
    // otherwise be granted in a file the running agent no longer reads.
    let granted = false;
    let grantError: string | undefined;
    try {
      granted = await grantSoulCredential(request.soulPath, request.name, request.agentId, {
        check: () => {
          const servedNow = sources.get(request.agentId)?.soulPath;
          if (servedNow !== request.soulPath) {
            throw new Error(`${request.agentId} is now served from ${servedNow ?? 'no soul file'}, not ${request.soulPath}`);
          }
        },
      });
    } catch (error) {
      grantError = error instanceof Error ? error.message : String(error);
    }
    await bus.emit({
      type: 'credential.provided',
      sessionId: request.sessionId,
      agentId: request.agentId,
      requestId: input.requestId,
      name: request.name,
      scope: request.scope,
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(grantError !== undefined ? { grantError } : {}),
    });
    if (grantError !== undefined) {
      return {
        ok: false,
        retired: true,
        message: `${request.name} was stored, but could not be added to ${request.soulPath} `
          + `(${grantError}). Add it to the soul's credentials list by hand.`,
      };
    }
    return { ok: true, name: request.name, scope: request.scope, agentId: request.agentId, granted };
  };

  return { provideCredential };
};

export type CredentialRequests = ReturnType<typeof createCredentialRequests>;
