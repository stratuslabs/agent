import { isTrustLevel, TRUST_LEVELS, type TrustLevel } from '@stratusagent/core';
import { isValidAgentId } from '@stratusagent/agents';
import { parseProviderName, type StratusProviderName } from '@stratusagent/state';
import type { CliEnvironment } from './environment.ts';

export type CliProviderName = StratusProviderName;

export type CliApprovalMode = 'always' | 'ask' | 'never';

export interface ParsedRunCommand {
  command: 'run';
  prompt: string;
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to run as. */
  soul?: string;
  format: 'text' | 'json';
  events: boolean;
  approvals: CliApprovalMode;
  maxTurns?: number;
}

export interface ParsedDashboardCommand {
  command: 'dashboard';
  port?: number;
  /**
   * Present only when `--host` was actually given.
   *
   * A defaulted string here would be indistinguishable from an explicit
   * `--host 127.0.0.1`, and the two mean opposite things when a trusted
   * config says `api.host: "0.0.0.0"`: absent means "let the config decide",
   * while explicit means "bind loopback, whatever the config says". Collapsing
   * them exposed the API on every interface to an operator who had just asked
   * for the opposite.
   */
  host?: string;
  openBrowser: boolean;
}

export interface ParsedSetupCommand {
  command: 'setup';
  configPath?: string;
}

export interface ParsedAgentNewCommand {
  command: 'agent-new';
  name?: string;
  instructions?: string;
  format: 'text' | 'json' | 'soul';
}

export interface ParsedChatCommand {
  command: 'chat';
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to chat with. */
  soul?: string;
  events: boolean;
  approvals: CliApprovalMode;
  maxTurns?: number;
}

export interface ParsedTemplateAddCommand {
  command: 'template-add';
  /** A GitHub `owner/repo`, a git URL, or a local path. */
  source: string;
  /** Skip the review and install straight away. */
  yes?: boolean;
  /** Replace an agent or skill already installed under the same name. */
  force?: boolean;
}

export interface ParsedSkillAddCommand {
  command: 'skill-add';
  /** A GitHub `owner/repo`, a git URL, or a local path. */
  source: string;
  /** Install only these ids (repeatable --skill). */
  skillIds?: string[];
  /** Replace an already-installed id instead of refusing it. */
  force?: boolean;
  /** Enable the installed skills in this agent's soul afterwards. */
  agentId?: string;
  /** Tell a running daemon to reload its skills afterwards. Default true; `--no-reload` sets false. */
  reload?: boolean;
}

export interface ParsedSkillValidateCommand {
  command: 'skill-validate';
  /** A skill directory, a directory of skills, or an installed skill's id. */
  target: string;
}

export interface ParsedPluginsCommand {
  command: 'plugins';
  format: 'text' | 'json';
  /** The config whose plugins block to read, when not the default. */
  configPath?: string;
}

export interface ParsedSkillsCommand {
  command: 'skills';
}

/**
 * What a credential name may be: the two conventions in use, and nothing
 * that would be awkward in a soul's `credentials:` list — `search.apiKey`
 * and environment-style `SLACK_TOKEN`. Leading letter required, which also
 * happens to exclude `__proto__`; the store does not *rely* on that (it
 * keys prototype-free maps), because a credentials file can be written by
 * something other than this command.
 */
export const CREDENTIAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export interface ParsedCredentialCommand {
  command: 'credential';
  action: 'set' | 'list' | 'remove';
  /** The credential name — `search.apiKey` and whatever the ecosystem asks for next. */
  name?: string;
  /** Store or remove this agent's own entry rather than the fleet's shared one. */
  agentId?: string;
}

export interface ParsedSkillReloadCommand {
  command: 'skill-reload';
  /** A daemon's control API URL; default: the one `~/.stratus/gateway.json` names. */
  gateway?: string;
  token?: string;
}

export interface ParsedRestartCommand {
  command: 'restart';
  /** For the daemon's log. */
  reason?: string;
  /** How long the daemon lets in-flight turns finish, in milliseconds. */
  drainTimeoutMs?: number;
  gateway?: string;
  token?: string;
}

export interface ParsedAgentsCommand {
  command: 'agents';
  format: 'text' | 'json';
  /**
   * Ask a running gateway instead of resolving locally. The first
   * remote-consuming command: the same listing, rendered from the control
   * API's answer rather than from this machine's files.
   */
  gateway?: string;
  /** Bearer token override, for a gateway whose token file is not local. */
  token?: string;
}

export interface ParsedSchedulesCommand {
  command: 'schedules';
  action: 'list' | 'cancel';
  /** cancel only: which schedule. */
  scheduleId?: string;
  format: 'text' | 'json';
}

export interface ParsedGrantsCommand {
  command: 'grants';
  action: 'list' | 'revoke';
  agentId: string;
  /** revoke: exactly one of the three names what goes. */
  tool?: string;
  /** The scope as `stratus grants` lists it — `git push`. */
  scope?: string;
  origin?: string;
  format: 'text' | 'json';
  gateway?: string;
  token?: string;
}

export interface ParsedMemoryCommand {
  command: 'memory';
  action: 'list' | 'reassert';
  agentId: string;
  /** list: show only entries at this label. reassert: the label to record. */
  trust?: TrustLevel;
  /** reassert: the entries to re-label, by id. */
  ids: string[];
  /** reassert: every live entry currently reading `unknown` — the upgrade case. */
  allUnknown: boolean;
  format: 'text' | 'json';
}

export interface ParsedSessionCommand {
  command: 'session';
  action: 'rollover';
  sessionId: string;
  gateway?: string;
  token?: string;
}

export interface ParsedDoctorCommand {
  command: 'doctor';
  format: 'text' | 'json';
  configPath?: string;
}

export interface ParsedUpdateCommand {
  command: 'update';
  /** Report what an update would do — version, migrations, unit health — without doing any of it. */
  check: boolean;
}

export interface ParsedServiceCommand {
  command: 'service';
  action: 'install' | 'uninstall' | 'status' | 'start' | 'stop';
  /** install only: start automatically at login. Defaults to true. */
  runAtLogin?: boolean;
  /** install only: the config the managed daemon should load. */
  configPath?: string;
}

export interface ParsedLogsCommand {
  command: 'logs';
  /** Keep streaming new records instead of exiting after the backlog. */
  follow: boolean;
  /** How many recent records to show before following. */
  limit: number;
  agentId?: string;
  sessionId?: string;
  format: 'text' | 'json';
}

export type ServeApprovalMode = 'headless' | 'remote';

export interface ParsedServeCommand {
  command: 'serve';
  configPath?: string;
  /** Overrides `approvals.mode` in the config file. */
  approvals?: ServeApprovalMode;
  /** Watchdog idle timeout in milliseconds. 0 disables. */
  idleTimeoutMs?: number;
  events: boolean;
  /** Write the structured log to ~/.stratus/logs. Defaults to true. */
  logToFile?: boolean;
  /** Serve the control API. Defaults to true when the package is installed. */
  api?: boolean;
  /** Overrides `api.port` in the config file. */
  apiPort?: number;
  /** Overrides `api.host` in the config file. */
  apiHost?: string;
}

export interface ParsedHelpCommand {
  command: 'help';
}

export type ParsedCommand =
  | ParsedRunCommand
  | ParsedChatCommand
  | ParsedDashboardCommand
  | ParsedSetupCommand
  | ParsedAgentNewCommand
  | ParsedAgentsCommand
  | ParsedSkillAddCommand
  | ParsedTemplateAddCommand
  | ParsedSkillValidateCommand
  | ParsedPluginsCommand
  | ParsedSkillsCommand
  | ParsedSkillReloadCommand
  | ParsedCredentialCommand
  | ParsedRestartCommand
  | ParsedSchedulesCommand
  | ParsedGrantsCommand
  | ParsedMemoryCommand
  | ParsedSessionCommand
  | ParsedDoctorCommand
  | ParsedLogsCommand
  | ParsedUpdateCommand
  | ParsedServiceCommand
  | ParsedServeCommand
  | ParsedHelpCommand;

const readPromptFromEnvironment = (env: CliEnvironment): string => (env.stdin ?? '').trim();

const readOptionValue = (tokens: string[], index: number, flag: string): string => {
  const value = tokens[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

export const parseCommand = (argv: string[], env: CliEnvironment = {}): ParsedCommand => {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'dashboard') {
    let port: number | undefined;
    let host: string | undefined;
    let openBrowser = true;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--port') {
        const value = Number(readOptionValue(rest, index, '--port'));
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new Error(`Invalid value for --port: ${rest[index + 1] ?? '(missing)'}`);
        }
        port = value;
        index += 1;
        continue;
      }
      if (token === '--host') {
        host = readOptionValue(rest, index, '--host');
        index += 1;
        continue;
      }
      if (token === '--no-open') {
        openBrowser = false;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    return {
      command: 'dashboard',
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      openBrowser,
    };
  }

  if (command === 'serve') {
    const parsed: ParsedServeCommand = { command: 'serve', events: true };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--config') {
        parsed.configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      if (token === '--idle-timeout') {
        const seconds = Number(readOptionValue(rest, index, '--idle-timeout'));
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`Invalid value for --idle-timeout: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.idleTimeoutMs = Math.round(seconds * 1000);
        index += 1;
        continue;
      }
      if (token === '--approvals') {
        const value = readOptionValue(rest, index, '--approvals');
        if (value !== 'headless' && value !== 'remote') {
          throw new Error(`Unsupported approvals mode: ${value}. Use headless or remote.`);
        }
        parsed.approvals = value;
        index += 1;
        continue;
      }
      if (token === '--no-events') {
        parsed.events = false;
        continue;
      }
      if (token === '--no-log-file') {
        parsed.logToFile = false;
        continue;
      }
      if (token === '--no-api') {
        parsed.api = false;
        continue;
      }
      if (token === '--api') {
        parsed.api = true;
        continue;
      }
      if (token === '--api-port') {
        const port = Number(readOptionValue(rest, index, '--api-port'));
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`Invalid value for --api-port: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.apiPort = port;
        index += 1;
        continue;
      }
      if (token === '--api-host') {
        parsed.apiHost = readOptionValue(rest, index, '--api-host');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'chat') {
    const parsed: ParsedChatCommand = { command: 'chat', events: false, approvals: 'always' };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--provider') {
        parsed.provider = parseProviderName(readOptionValue(rest, index, '--provider'), '--provider');
        index += 1;
        continue;
      }
      if (token === '--model') {
        parsed.model = readOptionValue(rest, index, '--model');
        index += 1;
        continue;
      }
      if (token === '--base-url') {
        parsed.baseUrl = readOptionValue(rest, index, '--base-url');
        index += 1;
        continue;
      }
      if (token === '--soul') {
        parsed.soul = readOptionValue(rest, index, '--soul');
        index += 1;
        continue;
      }
      if (token === '--config') {
        parsed.configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      if (token === '--approvals') {
        const value = readOptionValue(rest, index, '--approvals');
        if (value !== 'always' && value !== 'ask' && value !== 'never') {
          throw new Error(`Invalid value for --approvals: ${value}`);
        }
        parsed.approvals = value;
        index += 1;
        continue;
      }
      if (token === '--max-turns') {
        const value = Number(readOptionValue(rest, index, '--max-turns'));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid value for --max-turns: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.maxTurns = value;
        index += 1;
        continue;
      }
      if (token === '--events') {
        parsed.events = true;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'agents' || (command === 'agent' && rest[0] === 'list')) {
    const agentsRest = command === 'agents' ? rest : rest.slice(1);
    let format: 'text' | 'json' = 'text';
    let gateway: string | undefined;
    let token: string | undefined;
    for (let index = 0; index < agentsRest.length; index += 1) {
      const argument = agentsRest[index];
      if (!argument) {
        continue;
      }
      if (argument === '--help' || argument === '-h') {
        return { command: 'help' };
      }
      if (argument === '--format') {
        const value = readOptionValue(agentsRest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (argument === '--gateway') {
        gateway = readOptionValue(agentsRest, index, '--gateway');
        index += 1;
        continue;
      }
      if (argument === '--token') {
        token = readOptionValue(agentsRest, index, '--token');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${argument}`);
    }
    if (token !== undefined && gateway === undefined) {
      throw new Error('--token only applies with --gateway.');
    }
    return {
      command: 'agents',
      format,
      ...(gateway ? { gateway } : {}),
      ...(token ? { token } : {}),
    };
  }

  if (command === 'schedules' || (command === 'schedule' && rest[0] === 'list') || (command === 'schedule' && rest[0] === 'cancel')) {
    const schedulesRest = command === 'schedules' ? rest : rest.slice(1);
    const action = (command === 'schedule' ? rest[0] : schedulesRest[0]) === 'cancel' ? 'cancel' : 'list';
    const tokens = action === 'cancel' && command === 'schedules' ? schedulesRest.slice(1) : schedulesRest;
    let format: 'text' | 'json' = 'text';
    let scheduleId: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token || (action === 'list' && token === 'list' && index === 0)) {
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
        format = value;
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (action === 'cancel' && scheduleId === undefined) {
        scheduleId = token;
        continue;
      }
      throw new Error(`Unexpected argument: ${token}. Try: stratus schedules, stratus schedules cancel <id>`);
    }
    if (action === 'cancel' && !scheduleId) {
      throw new Error('schedules cancel needs the schedule id: stratus schedules cancel <id>.');
    }
    return {
      command: 'schedules',
      action,
      ...(scheduleId ? { scheduleId } : {}),
      format,
    };
  }

  if (command === 'doctor') {
    let format: 'text' | 'json' = 'text';
    let configPath: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--format') {
        const value = readOptionValue(rest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (token === '--config') {
        configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'doctor', format, ...(configPath ? { configPath } : {}) };
  }

  if (command === 'update') {
    let check = false;
    for (const token of rest) {
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--check') {
        check = true;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'update', check };
  }

  if (command === 'service') {
    const action = rest[0];
    if (action === '--help' || action === '-h' || action === undefined) {
      return { command: 'help' };
    }
    if (action !== 'install' && action !== 'uninstall' && action !== 'status' && action !== 'start' && action !== 'stop') {
      throw new Error(`Unknown service action: ${action} (expected install, uninstall, status, start, or stop)`);
    }
    const parsed: ParsedServiceCommand = { command: 'service', action };
    const serviceRest = rest.slice(1);
    for (let index = 0; index < serviceRest.length; index += 1) {
      const token = serviceRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--no-login') {
        if (action !== 'install') {
          throw new Error('--no-login applies to `stratus service install`.');
        }
        parsed.runAtLogin = false;
        continue;
      }
      if (token === '--config') {
        if (action !== 'install') {
          throw new Error('--config applies to `stratus service install`.');
        }
        parsed.configPath = readOptionValue(serviceRest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'logs') {
    let follow = false;
    let limit = 50;
    let agentId: string | undefined;
    let sessionId: string | undefined;
    let format: 'text' | 'json' = 'text';
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--follow' || token === '-f') {
        follow = true;
        continue;
      }
      if (token === '--lines' || token === '-n') {
        const value = Number(readOptionValue(rest, index, token));
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`Invalid value for ${token}: ${rest[index + 1] ?? '(missing)'}`);
        }
        limit = Math.floor(value);
        index += 1;
        continue;
      }
      if (token === '--agent') {
        agentId = readOptionValue(rest, index, '--agent');
        index += 1;
        continue;
      }
      if (token === '--session') {
        sessionId = readOptionValue(rest, index, '--session');
        index += 1;
        continue;
      }
      if (token === '--format') {
        const value = readOptionValue(rest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return {
      command: 'logs',
      follow,
      limit,
      format,
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  if (command === 'credentials' || command === 'credential') {
    const [subcommand, ...credentialRest] = command === 'credentials' ? ['list', ...rest] : rest;
    if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand !== 'set' && subcommand !== 'list' && subcommand !== 'remove') {
      throw new Error(`No credential subcommand named ${JSON.stringify(subcommand)}. It is set, list, or remove.`);
    }
    let name: string | undefined;
    let agentId: string | undefined;
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
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (name !== undefined) {
        throw new Error(`credential ${subcommand} takes one credential name; got both ${JSON.stringify(name)} and ${JSON.stringify(token)}.`);
      }
      name = token;
    }
    if (subcommand !== 'list' && name === undefined) {
      throw new Error(`credential ${subcommand} needs a credential name — for a search backend that is search.apiKey.`);
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
    };
  }

  if (command === 'plugins' || (command === 'plugin' && rest[0] === 'list')) {
    const pluginsRest = command === 'plugins' ? rest : rest.slice(1);
    let format: 'text' | 'json' = 'text';
    let configPath: string | undefined;
    for (let index = 0; index < pluginsRest.length; index += 1) {
      const token = pluginsRest[index] as string;
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--format') {
        const value = readOptionValue(pluginsRest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Invalid value for --format: ${value}. Use text or json.`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (token === '--config') {
        configPath = readOptionValue(pluginsRest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'plugins', format, ...(configPath !== undefined ? { configPath } : {}) };
  }

  if (command === 'skills' || (command === 'skill' && rest[0] === 'list')) {
    const skillsRest = command === 'skills' ? rest : rest.slice(1);
    for (const token of skillsRest) {
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'skills' };
  }

  if (command === 'template') {
    const [subcommand, ...templateRest] = rest;
    if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand !== 'add') {
      throw new Error(`Unknown template subcommand: ${subcommand}. Try: stratus template add <path or owner/repo>`);
    }
    let source: string | undefined;
    let yes = false;
    let force = false;
    for (const token of templateRest) {
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--yes' || token === '-y') {
        yes = true;
        continue;
      }
      if (token === '--force') {
        force = true;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (source !== undefined) {
        throw new Error(`template add takes one source; got both ${JSON.stringify(source)} and ${JSON.stringify(token)}.`);
      }
      source = token;
    }
    if (source === undefined) {
      throw new Error('template add needs a source: a GitHub owner/repo, a git URL, or a local path.');
    }
    return {
      command: 'template-add',
      source,
      ...(yes ? { yes } : {}),
      ...(force ? { force } : {}),
    };
  }

  if (command === 'skill') {
    const [subcommand, ...skillRest] = rest;
    if (subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand === 'validate') {
      let target: string | undefined;
      for (const token of skillRest) {
        if (token === '--help' || token === '-h') {
          return { command: 'help' };
        }
        if (token.startsWith('--')) {
          throw new Error(`Unknown option: ${token}`);
        }
        if (target !== undefined) {
          throw new Error(`skill validate takes one target; got both ${JSON.stringify(target)} and ${JSON.stringify(token)}.`);
        }
        target = token;
      }
      if (target === undefined) {
        throw new Error('skill validate needs a target: a skill directory, a directory of skills, or an installed skill id.');
      }
      return { command: 'skill-validate', target };
    }
    if (subcommand === 'reload') {
      const parsed: ParsedSkillReloadCommand = { command: 'skill-reload' };
      for (let index = 0; index < skillRest.length; index += 1) {
        const token = skillRest[index];
        if (!token) {
          continue;
        }
        if (token === '--help' || token === '-h') {
          return { command: 'help' };
        }
        if (token === '--gateway') {
          parsed.gateway = readOptionValue(skillRest, index, '--gateway');
          index += 1;
          continue;
        }
        if (token === '--token') {
          parsed.token = readOptionValue(skillRest, index, '--token');
          index += 1;
          continue;
        }
        throw new Error(`Unknown option: ${token}`);
      }
      return parsed;
    }
    if (subcommand !== 'add') {
      throw new Error(`Unknown skill subcommand: ${subcommand ?? '(missing)'}. Try: stratus skill add <source>, stratus skill validate <path>, stratus skill reload, stratus skills`);
    }

    let source: string | undefined;
    const skillIds: string[] = [];
    let force = false;
    let agentId: string | undefined;
    let reload = true;

    for (let index = 0; index < skillRest.length; index += 1) {
      const token = skillRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--skill') {
        skillIds.push(readOptionValue(skillRest, index, '--skill'));
        index += 1;
        continue;
      }
      if (token === '--agent') {
        agentId = readOptionValue(skillRest, index, '--agent');
        index += 1;
        continue;
      }
      if (token === '--force') {
        force = true;
        continue;
      }
      if (token === '--no-reload') {
        reload = false;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (source !== undefined) {
        throw new Error(`skill add takes one source; got both ${JSON.stringify(source)} and ${JSON.stringify(token)}.`);
      }
      source = token;
    }

    if (source === undefined) {
      throw new Error('skill add needs a source: a GitHub owner/repo, a git URL, or a local path.');
    }

    return {
      command: 'skill-add',
      source,
      ...(skillIds.length > 0 ? { skillIds } : {}),
      ...(force ? { force } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(reload ? {} : { reload }),
    };
  }

  if (command === 'grants') {
    const action: ParsedGrantsCommand['action'] = rest[0] === 'revoke' ? 'revoke' : 'list';
    const tokens = rest[0] === 'revoke' || rest[0] === 'list' ? rest.slice(1) : rest;
    const usage = action === 'revoke'
      ? 'stratus grants revoke <agent> --tool <name> | --scope "<command>" | --origin <origin>'
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
      if (action === 'revoke' && (token === '--tool' || token === '--scope' || token === '--origin')) {
        const value = readOptionValue(tokens, index, token);
        if (token === '--tool') {
          parsed.tool = value;
        } else if (token === '--scope') {
          parsed.scope = value;
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
    // joined into a path (`<id>.whitelist.json`), and the grant store
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
      const named = [parsed.tool, parsed.scope, parsed.origin].filter((value) => value !== undefined).length;
      if (named !== 1) {
        throw new Error(`grants revoke names exactly one of --tool, --scope, or --origin: ${usage}.`);
      }
    }
    return parsed;
  }

  if (command === 'memory') {
    const [action, ...memoryRest] = rest;
    if (action === undefined || action === '--help' || action === '-h') {
      return { command: 'help' };
    }
    if (action !== 'list' && action !== 'reassert') {
      throw new Error(`Unknown memory subcommand: ${action}. Try: stratus memory list <agent>, stratus memory reassert <agent> --trust user <id>...`);
    }
    let agentId: string | undefined;
    let trust: TrustLevel | undefined;
    let format: 'text' | 'json' = 'text';
    let allUnknown = false;
    const ids: string[] = [];
    for (let index = 0; index < memoryRest.length; index += 1) {
      const token = memoryRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--trust') {
        const value = readOptionValue(memoryRest, index, '--trust');
        if (!isTrustLevel(value)) {
          throw new Error(`Unsupported trust level: ${value}. Use one of ${TRUST_LEVELS.join(', ')}.`);
        }
        trust = value;
        index += 1;
        continue;
      }
      if (token === '--format') {
        const value = readOptionValue(memoryRest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (token === '--all-unknown' && action === 'reassert') {
        allUnknown = true;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (agentId === undefined) {
        agentId = token;
        continue;
      }
      if (action === 'reassert') {
        ids.push(token);
        continue;
      }
      throw new Error(`Unexpected argument: ${token}. Try: stratus memory list <agent>`);
    }
    if (!agentId) {
      throw new Error(`memory ${action} needs the agent id: stratus memory ${action} <agent>${action === 'reassert' ? ' --trust user <id>...' : ''}.`);
    }
    if (action === 'reassert') {
      if (trust === undefined) {
        throw new Error('memory reassert needs --trust <user|agent|external|unknown>: the label you are vouching for.');
      }
      if (ids.length === 0 && !allUnknown) {
        throw new Error('memory reassert needs entry ids, or --all-unknown to re-label every entry that has no recorded origin.');
      }
    }
    return {
      command: 'memory',
      action,
      agentId,
      ...(trust !== undefined ? { trust } : {}),
      ids,
      allUnknown,
      format,
    };
  }

  if (command === 'session') {
    const [action, ...sessionRest] = rest;
    if (action === undefined || action === '--help' || action === '-h') {
      return { command: 'help' };
    }
    if (action !== 'rollover') {
      throw new Error(`Unknown session subcommand: ${action}. Try: stratus session rollover <session-id>`);
    }
    const parsed: ParsedSessionCommand = { command: 'session', action: 'rollover', sessionId: '' };
    for (let index = 0; index < sessionRest.length; index += 1) {
      const token = sessionRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--gateway') {
        parsed.gateway = readOptionValue(sessionRest, index, '--gateway');
        index += 1;
        continue;
      }
      if (token === '--token') {
        parsed.token = readOptionValue(sessionRest, index, '--token');
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (parsed.sessionId.length > 0) {
        throw new Error(`Unexpected argument: ${token}. Try: stratus session rollover <session-id>`);
      }
      parsed.sessionId = token;
    }
    if (parsed.sessionId.length === 0) {
      throw new Error('session rollover needs the session id: stratus session rollover <session-id>. `stratus logs` shows ids in its last column.');
    }
    return parsed;
  }

  if (command === 'restart') {
    const parsed: ParsedRestartCommand = { command: 'restart' };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--reason') {
        parsed.reason = readOptionValue(rest, index, '--reason');
        index += 1;
        continue;
      }
      if (token === '--drain-timeout') {
        const seconds = Number(readOptionValue(rest, index, '--drain-timeout'));
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`Invalid value for --drain-timeout: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.drainTimeoutMs = Math.round(seconds * 1000);
        index += 1;
        continue;
      }
      if (token === '--gateway') {
        parsed.gateway = readOptionValue(rest, index, '--gateway');
        index += 1;
        continue;
      }
      if (token === '--token') {
        parsed.token = readOptionValue(rest, index, '--token');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'agent') {
    const [subcommand, ...agentRest] = rest;
    if (subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand !== 'new') {
      throw new Error(`Unknown agent subcommand: ${subcommand ?? '(missing)'}. Try: stratus agent new, stratus agent list`);
    }

    let name: string | undefined;
    let instructions: string | undefined;
    let format: 'text' | 'json' | 'soul' = 'text';

    for (let index = 0; index < agentRest.length; index += 1) {
      const token = agentRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--name') {
        name = readOptionValue(agentRest, index, '--name');
        index += 1;
        continue;
      }
      if (token === '--instructions') {
        instructions = readOptionValue(agentRest, index, '--instructions');
        index += 1;
        continue;
      }
      if (token === '--format') {
        const value = readOptionValue(agentRest, index, '--format');
        if (value !== 'text' && value !== 'json' && value !== 'soul') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    return {
      command: 'agent-new',
      ...(name ? { name } : {}),
      ...(instructions ? { instructions } : {}),
      format,
    };
  }

  if (command === 'setup') {
    let configPath: string | undefined;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--config') {
        configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    return { command: 'setup', ...(configPath ? { configPath } : {}) };
  }

  if (command !== 'run') {
    throw new Error(`Unknown command: ${command}`);
  }

  let prompt = '';
  let provider: CliProviderName | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let configPath: string | undefined;
  let soul: string | undefined;
  let format: 'text' | 'json' = 'text';
  let events = true;
  let approvals: CliApprovalMode = 'always';
  let maxTurns: number | undefined;
  let useStdin = false;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token) {
      continue;
    }

    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }

    if (token === '--prompt' || token === '-p') {
      prompt = readOptionValue(rest, index, '--prompt');
      index += 1;
      continue;
    }

    if (token === '--stdin') {
      useStdin = true;
      continue;
    }

    if (token === '--provider') {
      provider = parseProviderName(readOptionValue(rest, index, '--provider'), '--provider');
      index += 1;
      continue;
    }

    if (token === '--model') {
      model = readOptionValue(rest, index, '--model');
      index += 1;
      continue;
    }

    if (token === '--base-url') {
      baseUrl = readOptionValue(rest, index, '--base-url');
      index += 1;
      continue;
    }

    if (token === '--config') {
      configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }

    if (token === '--soul') {
      soul = readOptionValue(rest, index, '--soul');
      index += 1;
      continue;
    }

    if (token === '--format') {
      const value = readOptionValue(rest, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      format = value;
      index += 1;
      continue;
    }

    if (token === '--no-events') {
      events = false;
      continue;
    }

    if (token === '--approvals') {
      const value = readOptionValue(rest, index, '--approvals');
      if (value !== 'always' && value !== 'ask' && value !== 'never') {
        throw new Error(`Unsupported approvals mode: ${value}. Use always, ask, or never.`);
      }
      approvals = value;
      index += 1;
      continue;
    }

    if (token === '--max-turns') {
      const value = Number(readOptionValue(rest, index, '--max-turns'));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid value for --max-turns: ${rest[index + 1] ?? '(missing)'}`);
      }
      maxTurns = value;
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  if (!prompt) {
    prompt = positionals.join(' ').trim();
  }

  if (!prompt && useStdin) {
    prompt = readPromptFromEnvironment(env);
  }

  if (!prompt) {
    throw new Error('A prompt is required. Pass it with --prompt, --stdin, or as a positional argument.');
  }

  if (approvals === 'ask' && useStdin) {
    throw new Error('--approvals ask cannot be combined with --stdin because both read from standard input.');
  }

  return {
    command: 'run',
    prompt,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(configPath ? { configPath } : {}),
    ...(soul ? { soul } : {}),
    format,
    events,
    approvals,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
};
