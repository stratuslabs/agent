import { CREDENTIAL_NAME_PATTERN } from '@stratusagent/state';
import type { CliEnvironment } from './environment.ts';
import type { ParsedHelpCommand } from './parse/shared.ts';
import {
  parseChatCommand,
  type ParsedChatCommand,
  type ParsedRunCommand,
  parseRunCommand,
} from './parse/run.ts';
import {
  parseDashboardCommand,
  type ParsedDashboardCommand,
  type ParsedServeCommand,
  parseServeCommand,
} from './parse/serve.ts';
import {
  parseAgentCommand,
  parseAgentsCommand,
  type ParsedAgentNewCommand,
  type ParsedAgentsCommand,
  type ParsedSetupCommand,
  parseSetupCommand,
} from './parse/agents.ts';
import {
  type ParsedPluginsCommand,
  type ParsedSkillAddCommand,
  type ParsedSkillReloadCommand,
  type ParsedSkillsCommand,
  type ParsedSkillValidateCommand,
  type ParsedTemplateAddCommand,
  parsePluginsCommand,
  parseSkillCommand,
  parseSkillsCommand,
  parseTemplateCommand,
} from './parse/extensions.ts';
import {
  parseChannelCommand,
  parseCredentialCommand,
  type ParsedChannelCommand,
  type ParsedCredentialCommand,
  type ParsedGrantsCommand,
  type ParsedSignInCommand,
  parseGrantsCommand,
  parseSignInCommand,
} from './parse/access.ts';
import { type ParsedMemoryCommand, parseMemoryCommand } from './parse/memory.ts';
import {
  type ParsedSessionCommand,
  type ParsedSessionsCommand,
  parseSessionCommand,
  parseSessionsCommand,
} from './parse/sessions.ts';
import {
  type ParsedEventsCommand,
  type ParsedHealthCommand,
  type ParsedRestartCommand,
  type ParsedSchedulesCommand,
  parseHealthCommand,
  parseRestartCommand,
  parseSchedulesCommand,
} from './parse/gateway.ts';
import {
  type ParsedDoctorCommand,
  type ParsedLogsCommand,
  parseDoctorCommand,
  type ParsedServiceCommand,
  type ParsedUpdateCommand,
  parseLogsCommand,
  parseServiceCommand,
  parseUpdateCommand,
} from './parse/host.ts';

// The rule lives in `@stratusagent/state` now that the control API checks the
// same names; re-exported so this module's importers keep working.
export { CREDENTIAL_NAME_PATTERN };

export interface ParsedVersionCommand {
  command: 'version';
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
  | ParsedSignInCommand
  | ParsedChannelCommand
  | ParsedRestartCommand
  | ParsedHealthCommand
  | ParsedEventsCommand
  | ParsedSchedulesCommand
  | ParsedGrantsCommand
  | ParsedMemoryCommand
  | ParsedSessionCommand
  | ParsedSessionsCommand
  | ParsedDoctorCommand
  | ParsedLogsCommand
  | ParsedUpdateCommand
  | ParsedServiceCommand
  | ParsedServeCommand
  | ParsedHelpCommand
  | ParsedVersionCommand;

export const parseCommand = (argv: string[], env: CliEnvironment = {}): ParsedCommand => {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  // Before every other command, and answered even where one would fail:
  // the first thing anyone is asked for in a bug report is the version,
  // and a build too broken to serve is exactly when it is wanted. Reaching
  // it through `update --check` was the only way to see it, which asks npm
  // over the network to answer a question about this machine.
  if (command === 'version' || command === '--version' || command === '-v') {
    return { command: 'version' };
  }

  if (command === 'dashboard') {
    return parseDashboardCommand(rest);
  }

  if (command === 'serve') {
    return parseServeCommand(rest);
  }

  if (command === 'chat') {
    return parseChatCommand(rest);
  }

  if (command === 'agents' || (command === 'agent' && rest[0] === 'list')) {
    return parseAgentsCommand(command, rest);
  }

  if (command === 'schedules' || (command === 'schedule' && rest[0] === 'list') || (command === 'schedule' && rest[0] === 'cancel')) {
    return parseSchedulesCommand(command, rest);
  }

  if (command === 'doctor') {
    return parseDoctorCommand(rest);
  }

  if (command === 'update') {
    return parseUpdateCommand(rest);
  }

  if (command === 'service') {
    return parseServiceCommand(rest);
  }

  if (command === 'logs') {
    return parseLogsCommand(rest);
  }

  if (command === 'credentials' || command === 'credential') {
    return parseCredentialCommand(command, rest);
  }

  if (command === 'signin' || command === 'signins') {
    return parseSignInCommand(command, rest);
  }

  if (command === 'channel' || command === 'channels') {
    return parseChannelCommand(command, rest);
  }

  if (command === 'plugins' || (command === 'plugin' && rest[0] === 'list')) {
    return parsePluginsCommand(command, rest);
  }

  if (command === 'skills' || (command === 'skill' && rest[0] === 'list')) {
    return parseSkillsCommand(command, rest);
  }

  if (command === 'template') {
    return parseTemplateCommand(rest);
  }

  if (command === 'skill') {
    return parseSkillCommand(rest);
  }

  if (command === 'grants') {
    return parseGrantsCommand(rest);
  }

  if (command === 'memory') {
    return parseMemoryCommand(rest);
  }

  if (command === 'sessions' || (command === 'session' && rest[0] === 'list')) {
    return parseSessionsCommand(command, rest);
  }

  if (command === 'session') {
    return parseSessionCommand(rest);
  }

  if (command === 'restart') {
    return parseRestartCommand(rest);
  }

  if (command === 'health' || command === 'events') {
    return parseHealthCommand(command, rest);
  }

  if (command === 'agent') {
    return parseAgentCommand(rest);
  }

  if (command === 'setup') {
    return parseSetupCommand(rest);
  }

  if (command !== 'run') {
    throw new Error(`Unknown command: ${command}`);
  }

  return parseRunCommand(rest, env);
};

// Each family's module owns its result types; they are re-exported here so
// every importer of this module keeps working.
export {
  type CliApprovalMode,
  type CliProviderName,
  type ParsedHelpCommand,
} from './parse/shared.ts';

export {
  defaultApprovalMode,
  type ParsedChatCommand,
  type ParsedRunCommand,
} from './parse/run.ts';

export {
  type ParsedDashboardCommand,
  type ParsedServeCommand,
  type ServeApprovalMode,
} from './parse/serve.ts';

export {
  type ParsedAgentNewCommand,
  type ParsedAgentsCommand,
  type ParsedSetupCommand,
} from './parse/agents.ts';

export {
  type ParsedPluginsCommand,
  type ParsedSkillAddCommand,
  type ParsedSkillReloadCommand,
  type ParsedSkillsCommand,
  type ParsedSkillValidateCommand,
  type ParsedTemplateAddCommand,
} from './parse/extensions.ts';

export {
  type ParsedChannelCommand,
  type ParsedCredentialCommand,
  type ParsedGrantsCommand,
  type ParsedSignInCommand,
} from './parse/access.ts';

export {
  memoryCommandWritesState,
  type ParsedMemoryCommand,
} from './parse/memory.ts';

export {
  type ParsedSessionCommand,
  type ParsedSessionsCommand,
  SESSION_STATUSES,
  STOPPED_EARLY_FILTER,
} from './parse/sessions.ts';

export {
  type ParsedEventsCommand,
  type ParsedHealthCommand,
  type ParsedRestartCommand,
  type ParsedSchedulesCommand,
} from './parse/gateway.ts';

export {
  type ParsedDoctorCommand,
  type ParsedLogsCommand,
  type ParsedServiceCommand,
  type ParsedUpdateCommand,
} from './parse/host.ts';
