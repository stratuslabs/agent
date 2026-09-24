// The package's one public surface: every export below is re-exported by
// name from the module that owns it. The rules other packages are told to
// reuse rather than re-derive each have one home here — `runtime.ts` for
// `resolveRuntimeConfig`, `served.ts` for `applySoulPins` and
// `servedRuntimes`, `provider-names.ts` for what a provider is called and
// which environment variable holds its key.

/** The providers this package builds itself — the kernel's list, re-exported from where callers were told to find it. */
export { BUILTIN_PROVIDER_NAMES, type BuiltinProviderName } from '@stratusagent/core';

/**
 * The names a trusted config's `executor` / `memoryStore` key means the
 * built-ins by, and what an operator writes to reset one explicitly after
 * trying a plugin's. The kernel's constants, re-exported from where
 * callers were told to find them.
 */
export { BUILTIN_EXECUTOR_NAME, BUILTIN_MEMORY_STORE_NAME } from '@stratusagent/core';

export { createFileMemoryStore, createShardedFileMemoryStore, type FileMemoryStoreOptions } from './memory.ts';

export {
  type StateEnvironment,
  readProcessEnv,
  readWorkingDirectory,
  readHomeDirectory,
  readNonEmptyString,
} from './environment.ts';

export {
  DEFAULT_CONFIG_FILENAME,
  stratusHomePath,
  globalConfigPath,
  logsDirPath,
  credentialsPath,
  agentsDirPath,
  legacyMemoryFilePath,
  legacyMemoryFileIn,
  legacySessionDbPath,
  legacySessionDbIn,
  legacyWorkspacesDirPath,
  legacyWorkspacesDirIn,
  legacyAgentWorkspaceIn,
  skillsDirPath,
  agentWorkspacePath,
  agentWorkspaceIn,
  agentStateDirPath,
  agentStateDirIn,
  agentsDirIn,
  agentSessionDbPath,
  agentSessionDbIn,
  agentMemoryFilePath,
  agentMemoryFileIn,
  fleetDbPath,
  fleetDbIn,
  assertPathSafeAgentId,
  foldedAgentId,
  gatewayTokenPath,
  gatewayInfoPath,
} from './paths.ts';

export {
  REGISTERED_PROVIDER_PREFIX,
  type RegisteredProviderName,
  type StratusProviderName,
  isBuiltinProviderName,
  isRegisteredProviderName,
  registeredProviderNameOf,
  CREDENTIAL_PROVIDER_NAMES,
  type CredentialProviderName,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  parseProviderName,
  defaultApiKeyEnvName,
} from './provider-names.ts';

export {
  type AgentApprovalConfig,
  MAX_APPROVAL_TIMEOUT_MS,
  type ApprovalsConfig,
  type AgentPrincipalsConfig,
  type PrincipalsAdmit,
  type PrincipalsConfig,
  type AgentSlackConfig,
  type SlackConfig,
  type SlackReplyMode,
  type ApiConfig,
  type PluginConfigBlock,
  type PluginsConfig,
  type StratusConfigFile,
  type FallbackRuntime,
  type IgnoredUntrustedConfig,
  type RuntimeConfig,
  type SignedInRuntimeConfig,
  isSignedInRuntime,
  type RuntimeSelection,
} from './config.ts';

export {
  type StoredCredential,
  type CredentialsFile,
  loadCredentials,
  saveCredentials,
  type SlackChannelCredential,
  type ChannelCredentials,
  loadChannelCredentials,
  saveChannelCredentials,
  loadChannelTransportSecrets,
  listChannelKinds,
  saveChannelTransportSecrets,
  type NamedCredentials,
  loadNamedCredentials,
  saveNamedCredentials,
  createFileCredentialResolver,
} from './credentials.ts';

export {
  migrateLegacyMemory,
  STATE_SCHEMA_VERSION,
  stateFilePath,
  type StateStamp,
  type StateMigration,
  STATE_MIGRATIONS,
  readStateStamp,
  mergeStateStamp,
  newerStateMessage,
  assertStateCompatible,
  pendingStateMigrations,
  type StateMigrationRunOptions,
  type AppliedStateMigration,
  runStateMigrations,
} from './migrations.ts';

export {
  drainSharedMemory,
  hasBracketedLegacyState,
  hasBracketedLegacyStateIn,
  legacyStateHeld,
  legacyStateHeldIn,
} from './layout-migration.ts';

export {
  ConfigFileError,
  loadConfigFile,
  validateConfigFile,
  resolveAgentApprovals,
  resolveAgentPrincipals,
  resolveAgentSlack,
  saveConfigFile,
} from './config-file.ts';

export {
  type ResolvedConfigLocation,
  resolveConfigLocation,
  discoverActiveConfig,
  type TrustedConfigBlock,
  readTrustedConfigBlock,
  readGlobalConfigBlock,
} from './config-location.ts';

export {
  DEFAULT_STRATUS_AGENT,
  resolveSoulPath,
  resolveSoul,
  resolveConfiguredSoul,
  loadSoulFile,
  type RosterEntry,
  DuplicateAgentIdError,
  loadRosterSouls,
} from './souls.ts';

export {
  type OperatorSkillInfo,
  type LoadOperatorSkillsOptions,
  loadOperatorSkills,
  type SkillInstallCandidate,
  type SkillInstallSkip,
  type SkillInstallWarning,
  type ValidateSkillDirectoryOptions,
  type SkillDirectoryValidation,
  validateSkillDirectory,
  type InstallSkillsOptions,
  type DiscoverSkillsOptions,
  type InstallSkillsResult,
  discoverSkillsInDirectory,
  installSkillsFromDirectory,
} from './skills.ts';

export {
  apiKeyEnvNameFor,
  resolveEnvApiKey,
  ignoredUntrustedConfigKeys,
  discoverIgnoredUntrustedConfig,
  resolveRuntimeConfig,
} from './runtime.ts';

export {
  createDemoTool,
  createDemoProvider,
  FALLBACK_ACTIVE_METADATA_KEY,
  PROVIDER_STATE_METADATA_KEYS,
  createFallbackWrappedProvider,
  type RegisteredProviders,
  createRuntimeProvider,
} from './provider-runtime.ts';

export {
  type SoulPinContext,
  applySoulPins,
  type ServedRuntime,
  servedRuntimes,
} from './served.ts';

export {
  KNOWN_CLAUDE_MODELS,
  KNOWN_CODEX_MODELS,
  type ProviderKeyVerdict,
  verifyProviderKey,
  type CatalogModel,
  type ModelCatalogSelection,
  collectAvailableModels,
} from './models.ts';

export {
  withLegacyDefaultMemories,
  createHomeMemoryStore,
  declaredAgentIds,
  claimSoulFile,
  personaSnippet,
  type AgentSummary,
  listAgentSummaries,
} from './roster.ts';

/**
 * The rule that an agent's state directory is never a symlink, re-exported
 * from `@stratusagent/permissions`, which owns it. `gateway` depends on this
 * package and not on that one, and a second spelling of the check is exactly
 * what the one home exists to prevent.
 */
export {
  isSymlinkedStatePath,
  isSymlinkedStatePathSync,
  symlinkedStateDirectoryMessage,
  symlinkedStateFileMessage,
} from '@stratusagent/permissions';

export { createAgentWorkspaces } from './workspaces.ts';
