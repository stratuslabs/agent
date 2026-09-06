// The package's one public surface: every export below is re-exported by
// name from the module that owns it. `commands/` holds one file per CLI
// command (the `run*` entrypoints `main.ts` dispatches to); the top-level
// modules are what more than one command shares — the environment types,
// argv parsing, the agent runtime, and the helpers that talk to a running
// daemon. `bin.ts` imports this file, so anything here loads on every
// command: the gateway is imported lazily, by type only, for that reason.

export {
  installService,
  launchdPlist,
  readServiceCommand,
  readServiceStatus,
  servicePlatform,
  serviceUnitPath,
  startService,
  stopService,
  systemdUnit,
  uninstallService,
  SERVICE_LABEL,
  type ServiceRunner,
  type ServiceStatus,
} from './service.ts';

export {
  createLogWriter,
  currentLogPosition,
  truncateRedirectLogs,
  formatLogRecord,
  parseLogLines,
  readRecentRecords,
  tailLog,
  type LogRecord,
} from './logs.ts';

// The shared state package owns config resolution, credentials, memory, and
// provider wiring now (the gateway uses the same code); the CLI re-exports
// its historical surface so existing importers keep working.
export { createFileMemoryStore } from '@stratusagent/state';

export type { StoredCredential, RuntimeConfig } from '@stratusagent/state';

export {
  type CliStreams,
  type CliEnvironment,
  type DashboardSession,
  type SupervisorMessage,
  type SupervisorLink,
  type RestartHandoff,
  type RespawnResult,
  type PackageInstallResult,
  type PackageInstaller,
  type PackageVersionFetcher,
  type PackageResolver,
} from './environment.ts';

export {
  SUPPORTED_NODE_RANGE,
  unsupportedNodeMessage,
  withoutSqliteExperimentalWarning,
  filterSqliteExperimentalWarning,
} from './preflight.ts';

export { VERSION_LOOKUP_TIMEOUT_MS, compareVersions, npmNeedsShell, CLI_VERSION } from './npm.ts';

export { stringifyValue } from './io.ts';

export { HELP_TEXT } from './help.ts';

export {
  type CliProviderName,
  type CliApprovalMode,
  type ParsedRunCommand,
  type ParsedDashboardCommand,
  type ParsedSetupCommand,
  type ParsedAgentNewCommand,
  type ParsedChatCommand,
  type ParsedSkillAddCommand,
  type ParsedSkillValidateCommand,
  type ParsedSkillsCommand,
  CREDENTIAL_NAME_PATTERN,
  type ParsedCredentialCommand,
  type ParsedSkillReloadCommand,
  type ParsedRestartCommand,
  type ParsedAgentsCommand,
  type ParsedSchedulesCommand,
  type ParsedMemoryCommand,
  type ParsedSessionCommand,
  type ParsedDoctorCommand,
  type ParsedUpdateCommand,
  type ParsedServiceCommand,
  type ParsedLogsCommand,
  type ServeApprovalMode,
  type ParsedServeCommand,
  type ParsedHelpCommand,
  type ParsedCommand,
  parseCommand,
} from './parse.ts';

export { formatEvent, eventDetail } from './events.ts';

export { describeApprovalCall, createApprovalPolicy } from './approvals.ts';

export {
  resolveRuntimeConfig,
  warnOnCredentialOverride,
  runSingleLoop,
  printSessionSummary,
} from './runtime.ts';

export { slackAppManifest } from './slack.ts';

export {
  RESTART_EXIT_CODE,
  UNDRAINED_RESTART_EXIT_CODE,
  serveArgv,
  restartEntrypoint,
} from './supervisor.ts';

export { runChat } from './commands/chat.ts';

export { runSetup } from './commands/setup.ts';

export { runAgents } from './commands/agents.ts';

export { type DoctorReport, collectDoctorReport, runDoctor } from './commands/doctor.ts';

export { runLogs } from './commands/logs.ts';

export { runService } from './commands/service.ts';

export { runSkillAdd, runSkillValidate, runSkillReload, runSkills } from './commands/skills.ts';

export { runSchedules } from './commands/schedules.ts';

export { runCredential } from './commands/credential.ts';

export { runMemory } from './commands/memory.ts';

export { runSessionRollover } from './commands/session.ts';

export { runRestart } from './commands/restart.ts';

export { soulPinForNewAgent, runAgentNew } from './commands/agent-new.ts';

export { openExternalUrl, runDashboard } from './commands/dashboard.ts';

export { runServe } from './commands/serve.ts';

export { type CliRunOptions, runCli } from './main.ts';
