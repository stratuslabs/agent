/*
 * What `runSetup` (setup.ts) shares with the menu modules beside this file:
 * the settings a setup session edits, and the values each menu's factory
 * takes from `runSetup`. `SetupState` moved here from setup.ts as is.
 */

import type { CliConfigFile, CliEnvironment, CliStreams } from '../../environment.ts';
import type { CliProviderName } from '../../parse.ts';
import type { createSetupPrompter } from '../../prompter.ts';
import type {
  ApiConfig,
  ApprovalsConfig,
  PrincipalsConfig,
  SlackConfig,
  ChannelCredentials,
  CredentialsFile,
  PluginsConfig,
} from '@stratusagent/state';

export interface SetupState {
  provider: CliProviderName;
  model?: string;
  fallbackModel?: string;
  fallbackProvider?: CliProviderName;
  fallbackBaseUrl?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  soulPath?: string;
  /**
   * Carried through a save untouched: setup has no menu for it, and a
   * rewrite that dropped it would hand a text-only model its images back.
   */
  vision?: boolean;
  /**
   * Carried for the same reason `vision` is, and grouped with it because
   * they are the same kind of thing: a preference about how requests are
   * made, not a grant. Dropping them reverted an operator who had turned
   * caching off — for a fleet that never reads a cached prefix back, where
   * the write premium is a pure surcharge — to paying it again silently.
   */
  promptCache?: boolean;
  promptCacheTtl?: '5m' | '1h';
  /**
   * The fleet's writing language, carried for the same reason: setup has
   * no menu for it, and a save that dropped it would put every agent back
   * on the default without anyone choosing that.
   */
  language?: string;
  /**
   * Settings setup has no menu for, held so a save does not drop them —
   * see the round-trip below.
   */
  maxTokens?: number;
  maxTurns?: number;
  agentMaxTurns?: Record<string, number>;
  autoContinue?: Record<string, true | number>;
  /**
   * The four blocks an operator writes by hand, carried for the same reason
   * `vision` is — with more at stake, because each one is a decision about
   * what the daemon may do rather than a preference. `save` rebuilds the
   * file from this state, so a key absent here is a key deleted from disk:
   * re-running setup silently un-installed every plugin, un-appointed every
   * approver, dropped every principal back to `unknown`, and returned the
   * control API to its default binding. Found while working out why an
   * agent had no tools — the plugins block granting them had been erased by
   * a later `stratus setup` that never mentioned plugins.
   *
   * Carried as `loadConfigFile` normalized them, not as the bytes on disk.
   * That is the shape `validateConfigFile` already vouches for, and its own
   * documentation is why: a writer that answers this question differently
   * from the loader writes a file the next read rejects. A hand-written key
   * no parser recognizes is dropped here — but every reader was already
   * ignoring it, so what is lost is a key that never did anything.
   */
  plugins?: PluginsConfig;
  approvals?: ApprovalsConfig;
  api?: ApiConfig;
  principals?: PrincipalsConfig;
  slack?: SlackConfig;
  /** Trusted-only selections with no menu here; carried through a save. */
  executor?: string;
  memoryStore?: string;
  credentials: CredentialsFile;
  credentialsDirty: boolean;
  /** Channel tokens (Slack apps, keyed by agent id) and whether they changed. */
  channels: ChannelCredentials;
  channelsDirty: boolean;
  /**
   * Plugin channels' transport secrets as this run will leave them, by
   * kind then agent, read the first time a kind's menu opens. The edits
   * are written on save, in order, the way Slack's tokens are.
   */
  pluginChannelSecrets: Record<string, Record<string, Record<string, string>>>;
  pluginChannelEdits: Array<{ kind: string; agentId: string; secrets?: Record<string, string> }>;
  /** Run stratusd under the platform's service manager after saving. */
  service: { install: boolean; runAtLogin: boolean };
}

/**
 * The values `runSetup` sets up before any menu runs, which the menu
 * factories close over. `streams` is the interactive wrapper when there is
 * one, and `existing` the config as loaded: neither is reassigned after the
 * factories are called. `serveCommand` reads `save()`'s project-config flag
 * when it is called, as it did inside `runSetup`.
 */
export interface SetupBase {
  state: SetupState;
  prompter: ReturnType<typeof createSetupPrompter>;
  streams: CliStreams;
  env: CliEnvironment;
  processEnv: NodeJS.ProcessEnv;
  cwd: string;
  existing: CliConfigFile;
  recentNotices: string[];
  serveCommand: () => string;
}
