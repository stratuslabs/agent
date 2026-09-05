/**
 * The plugin host: what a plugin claims, what it is allowed to register,
 * and how a config block becomes running capability.
 *
 * The contract lives in `docs/architecture/plugins.md` and is not
 * re-derived here. What this package adds is enforcement — a manifest read
 * without importing the package it describes, a registration view that
 * holds `setup()` to that manifest, and a loader that refuses rather than
 * degrades when a plugin over-reaches.
 */
export {
  declaredRiskFor,
  parsePluginManifest,
  parseToolRiskOverrides,
  resolvePluginAgentConfig,
  validateAgainstSchema,
  validatePluginConfig,
  HOST_CONFIG_KEYS,
  PLUGIN_MANIFEST_VERSION,
  PluginConfigError,
  PluginManifestError,
  type PluginContributions,
  type PluginManifest,
  type PluginNamespaceDeclaration,
  type PluginSkillDeclaration,
  type PluginToolDeclaration,
} from './manifest.ts';

export { createManifestBoundCredentialResolver } from './credentials.ts';

export {
  ManifestBoundToolRegistry,
  riskFloorFor,
  type PluginToolRecord,
} from './registry.ts';

export {
  isFirstPartyPackage,
  loadOptionalModule,
  loadPlugins,
  type CreatePlugin,
  type LoadedPlugin,
  type LoadPluginsOptions,
  type LoadPluginsResult,
  type OptionalModuleHost,
  type PluginLoadFailure,
  type PluginSkillRecord,
} from './loader.ts';

export {
  createFileLedger,
  createProcessLocalLedger,
  isLedgerPath,
  LEDGER_FILENAME,
  ledgerContentTrust,
  ledgerGuard,
  type FileIdentity,
  type LedgerGuard,
  type TaintedWriteLedger,
} from './provenance.ts';
