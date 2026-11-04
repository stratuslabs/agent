/*
 * `stratus credentials`, `stratus signin`, `stratus channel` and
 * `stratus grants`: the keys an agent holds and what it is allowed to do.
 */
import { credentialVariableProblem, isValidAgentId } from '@stratusagent/agents';
import { CHANNEL_KIND_PATTERN, CREDENTIAL_NAME_PATTERN } from '@stratusagent/state';

import { type ParsedHelpCommand, readOptionValue } from './shared.ts';

export interface ParsedCredentialCommand {
  command: 'credential';
  action: 'set' | 'list' | 'remove' | 'env';
  /** The credential name — `search.apiKey` and whatever the ecosystem asks for next. */
  name?: string;
  /**
   * Store or remove this agent's own entry rather than the fleet's shared
   * one. For `env`, whose shell the binding is for.
   */
  agentId?: string;
  /**
   * The environment variable the agent's shell commands read the key from:
   * `set --env VAR`, or `env NAME VAR`.
   */
  env?: string;
  /** `env --remove`: drop the binding instead of making it. */
  remove?: boolean;
}

export interface ParsedSignInCommand {
  command: 'signin';
  action: 'set' | 'list' | 'remove';
  /** The provider the sign-in is for. Only `anthropic` has per-agent sign-ins. */
  provider?: 'anthropic';
  /** The agent whose own sign-in this is; required for set and remove. */
  agentId?: string;
  /**
   * `set` only: the config the daemon was started with, whose default soul
   * is on the roster the agent id is checked against.
   */
  configPath?: string;
}

export interface ParsedChannelCommand {
  command: 'channel';
  action: 'set' | 'list' | 'remove';
  /** The channel kind a plugin declares — `slack`, `imessage`. */
  kind?: string;
  /** The agent whose binding this is; required for set and remove. */
  agentId?: string;
  /**
   * The secret names to store, in the order their values are asked for
   * or read. Empty for Slack means its two tokens.
   */
  keys: string[];
}

export interface ParsedGrantsCommand {
  command: 'grants';
  /**
   * The config a stopped daemon would start with, for the `approvals.commands`
   * part of the listing. A serving daemon reports its own; this only matters
   * when the files are read. Default: what `stratus serve` would find.
   */
  configPath?: string;
  action: 'list' | 'revoke';
  agentId: string;
  /** revoke: exactly one of the three names what goes. */
  tool?: string;
  /** The scope as `stratus grants` lists it — `git push`. */
  scope?: string;
  origin?: string;
  /** A conversation as `stratus grants` lists it — `slack:C0123ABCD`. */
  destination?: string;
  format: 'text' | 'json';
  gateway?: string;
  token?: string;
}

export const parseCredentialCommand = (command: 'credentials' | 'credential', rest: string[]): ParsedCredentialCommand | ParsedHelpCommand => {
  const [subcommand, ...credentialRest] = command === 'credentials' ? ['list', ...rest] : rest;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand !== 'set' && subcommand !== 'list' && subcommand !== 'remove' && subcommand !== 'env') {
    throw new Error(`No credential subcommand named ${JSON.stringify(subcommand)}. It is set, list, remove, or env.`);
  }
  let name: string | undefined;
  let agentId: string | undefined;
  let variable: string | undefined;
  let remove = false;
  for (let index = 0; index < credentialRest.length; index += 1) {
    const token = credentialRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--agent') {
      agentId = readOptionValue(credentialRest, index, '--agent');
      index += 1;
      continue;
    }
    if (token === '--env' && subcommand === 'set') {
      variable = readOptionValue(credentialRest, index, '--env');
      index += 1;
      continue;
    }
    if (token === '--remove' && subcommand === 'env') {
      remove = true;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    // `env` takes the name and then the variable.
    if (subcommand === 'env' && name !== undefined && variable === undefined) {
      variable = token;
      continue;
    }
    if (name !== undefined) {
      throw new Error(subcommand === 'env'
        ? `credential env takes a credential name and a variable; ${JSON.stringify(token)} is one more.`
        : `credential ${subcommand} takes one credential name; got both ${JSON.stringify(name)} and ${JSON.stringify(token)}.`);
    }
    name = token;
  }
  if (subcommand !== 'list' && name === undefined) {
    throw new Error(`credential ${subcommand} needs a credential name — for a search backend that is search.apiKey.`);
  }
  if (subcommand === 'env' && variable === undefined) {
    throw new Error('credential env needs the variable too: stratus credential env twilio.authToken TWILIO_AUTH_TOKEN --agent <id>.');
  }
  // A binding is one agent's consent, never the fleet's.
  if (variable !== undefined && agentId === undefined) {
    throw new Error(
      subcommand === 'env'
        ? 'credential env needs --agent <id>: a binding is for one agent\'s shell.'
        : 'credential set --env needs --agent <id>: a binding is for one agent\'s shell. '
          + 'For a shared key, store it with credential set, then bind it per agent with credential env.',
    );
  }
  // The operator's rule; the stricter one is for names an agent picks.
  const variableProblem = variable !== undefined && !remove ? credentialVariableProblem(variable) : undefined;
  if (variableProblem !== undefined) {
    throw new Error(variableProblem);
  }
  // A name keys a map that a soul's `credentials:` list also names, so the
  // two spellings have to be able to meet. The store itself is
  // prototype-safe whatever lands in it; this rule is what stops a typo —
  // or a name no soul could ever write — from being stored and then
  // reported missing forever.
  if (name !== undefined && !CREDENTIAL_NAME_PATTERN.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a credential name. Use letters, digits, dots, dashes, or underscores, `
      + 'starting with a letter — search.apiKey, or an environment-style SLACK_TOKEN.',
    );
  }
  // The agents package's own rule, not a second one: it is already the
  // answer to "what may key a plain object", and it rejects the names —
  // `__proto__`, `toString` — that would store a credential nothing could
  // ever resolve.
  if (agentId !== undefined && !isValidAgentId(agentId)) {
    throw new Error(
      `${JSON.stringify(agentId)} cannot be an agent id, so a credential stored under it could never be resolved.`,
    );
  }
  return {
    command: 'credential',
    action: subcommand,
    ...(name !== undefined ? { name } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(variable !== undefined ? { env: variable } : {}),
    ...(remove ? { remove } : {}),
  };
};

export const parseSignInCommand = (command: 'signin' | 'signins', rest: string[]): ParsedSignInCommand | ParsedHelpCommand => {
  const [subcommand, ...signInRest] = command === 'signins' ? ['list', ...rest] : rest;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand !== 'set' && subcommand !== 'list' && subcommand !== 'remove') {
    throw new Error(`No signin subcommand named ${JSON.stringify(subcommand)}. It is set, list, or remove.`);
  }
  const positional: string[] = [];
  let agentId: string | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < signInRest.length; index += 1) {
    const token = signInRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--agent') {
      agentId = readOptionValue(signInRest, index, '--agent');
      index += 1;
      continue;
    }
    if (token === '--config') {
      configPath = readOptionValue(signInRest, index, '--config');
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    positional.push(token);
  }
  // Only `set` checks the roster; `remove` and `list` read the
  // credentials file alone, whichever config the daemon runs on.
  if (configPath !== undefined && subcommand !== 'set') {
    throw new Error(`--config is for signin set, which checks the agent against that config's roster. signin ${subcommand} reads only the credentials file.`);
  }
  if (subcommand === 'list') {
    if (positional.length > 0 || agentId !== undefined) {
      throw new Error('signin list takes no arguments; it lists every agent with a sign-in of its own.');
    }
    return { command: 'signin', action: 'list' };
  }
  const [provider, ...extra] = positional;
  if (provider !== 'anthropic' || extra.length > 0) {
    throw new Error(
      `signin ${subcommand} takes one provider, and anthropic (a Claude subscription) is the only one with per-agent sign-ins: `
      + `stratus signin ${subcommand} anthropic --agent <id>. The shared sign-in is \`stratus setup\`'s.`,
    );
  }
  if (agentId === undefined) {
    throw new Error(`signin ${subcommand} needs --agent: this is one agent's own sign-in. The shared one is \`stratus setup\`'s.`);
  }
  if (!isValidAgentId(agentId)) {
    throw new Error(`${JSON.stringify(agentId)} cannot be an agent id, so a sign-in stored under it could never be used.`);
  }
  return { command: 'signin', action: subcommand, provider, agentId, ...(configPath !== undefined ? { configPath } : {}) };
};

export const parseChannelCommand = (command: 'channel' | 'channels', rest: string[]): ParsedChannelCommand | ParsedHelpCommand => {
  const [subcommand, ...channelRest] = command === 'channels' ? ['list', ...rest] : rest;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand !== 'set' && subcommand !== 'list' && subcommand !== 'remove') {
    throw new Error(`No channel subcommand named ${JSON.stringify(subcommand)}. It is set, list, or remove.`);
  }
  const positional: string[] = [];
  let agentId: string | undefined;
  for (let index = 0; index < channelRest.length; index += 1) {
    const token = channelRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--agent') {
      agentId = readOptionValue(channelRest, index, '--agent');
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    positional.push(token);
  }
  const [kind, ...keys] = positional;
  if (subcommand === 'list') {
    if (positional.length > 0 || agentId !== undefined) {
      throw new Error('channel list takes no arguments; it lists every channel with stored secrets.');
    }
    return { command: 'channel', action: 'list', keys: [] };
  }
  if (kind === undefined) {
    throw new Error(`channel ${subcommand} needs a channel kind — the name its plugin declares, such as imessage.`);
  }
  if (!CHANNEL_KIND_PATTERN.test(kind)) {
    throw new Error(`${JSON.stringify(kind)} is not a channel kind. Use the kind a channel plugin declares (lowercase, hyphens).`);
  }
  if (agentId === undefined) {
    throw new Error(`channel ${subcommand} needs --agent: channel secrets are one set per agent, since each agent is its own identity on the channel.`);
  }
  // The same rule the credential command keeps, for the same reason: an
  // entry under an id no agent can have is a binding nothing resolves.
  if (!isValidAgentId(agentId)) {
    throw new Error(`${JSON.stringify(agentId)} cannot be an agent id, so a binding stored under it could never be resolved.`);
  }
  if (subcommand === 'remove') {
    if (keys.length > 0) {
      throw new Error('channel remove takes the kind and --agent only; it removes everything stored for that agent on that channel.');
    }
    return { command: 'channel', action: 'remove', kind, agentId, keys: [] };
  }
  if (kind !== 'slack' && keys.length === 0) {
    throw new Error(
      `channel set ${kind} needs the names of the secrets to store, from the plugin's README — for example \`stratus channel set ${kind} --agent ${agentId} apiKey apiSecret\`.`,
    );
  }
  const bad = keys.find((key) => !CREDENTIAL_NAME_PATTERN.test(key));
  if (bad !== undefined) {
    throw new Error(`${JSON.stringify(bad)} is not a secret name. Use letters, digits, dots, dashes, or underscores, starting with a letter.`);
  }
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) {
    throw new Error(`${repeated} is named twice; each secret is stored once.`);
  }
  return { command: 'channel', action: 'set', kind, agentId, keys };
};

export const parseGrantsCommand = (rest: string[]): ParsedGrantsCommand | ParsedHelpCommand => {
  const action: ParsedGrantsCommand['action'] = rest[0] === 'revoke' ? 'revoke' : 'list';
  const tokens = rest[0] === 'revoke' || rest[0] === 'list' ? rest.slice(1) : rest;
  const usage = action === 'revoke'
    ? 'stratus grants revoke <agent> --tool <name> | --scope "<command>" | --origin <origin> | --destination <channel:id>'
    : 'stratus grants <agent>';
  const parsed: ParsedGrantsCommand = { command: 'grants', action, agentId: '', format: 'text' };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--format') {
      const value = readOptionValue(tokens, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      parsed.format = value;
      index += 1;
      continue;
    }
    if (token === '--gateway') {
      parsed.gateway = readOptionValue(tokens, index, '--gateway');
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = readOptionValue(tokens, index, '--token');
      index += 1;
      continue;
    }
    if (token === '--config') {
      parsed.configPath = readOptionValue(tokens, index, '--config');
      index += 1;
      continue;
    }
    if (action === 'revoke'
      && (token === '--tool' || token === '--scope' || token === '--origin' || token === '--destination')) {
      const value = readOptionValue(tokens, index, token);
      if (token === '--tool') {
        parsed.tool = value;
      } else if (token === '--scope') {
        parsed.scope = value;
      } else if (token === '--destination') {
        parsed.destination = value;
      } else {
        parsed.origin = value;
      }
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (parsed.agentId === '') {
      parsed.agentId = token;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}. Try: ${usage}`);
  }
  if (parsed.agentId === '') {
    throw new Error(`grants${action === 'revoke' ? ' revoke' : ''} needs the agent id: ${usage}.`);
  }
  // The agents package's own rule, the same one the control API route and
  // `credential --agent` apply — and the reason is sharper here: this id is
  // joined into a path (`<id>/whitelist.json`), and the grant store
  // documents it as an already-validated single segment by the time it
  // reaches that join. Unchecked, `../../other` reads — and on a revoke
  // rewrites — a grant file outside ~/.stratus/agents.
  if (!isValidAgentId(parsed.agentId)) {
    throw new Error(
      `${JSON.stringify(parsed.agentId)} cannot be an agent id, so it names no grant file. `
      + 'Use the id `stratus agents` lists.',
    );
  }
  if (action === 'revoke') {
    const named = [parsed.tool, parsed.scope, parsed.origin, parsed.destination]
      .filter((value) => value !== undefined).length;
    if (named !== 1) {
      throw new Error(`grants revoke names exactly one of --tool, --scope, --origin, or --destination: ${usage}.`);
    }
  }
  return parsed;
};
