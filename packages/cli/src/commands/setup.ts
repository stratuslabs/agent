import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject } from '@stratusagent/core';
import {
  preflightPlugin,
  readPluginManifest,
  PluginConfigError,
  PluginManifestError,
} from '@stratusagent/plugins';
import { DEFAULT_ANTHROPIC_MODEL } from '@stratusagent/provider-anthropic';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/provider-codex';
import { formatSoul, parseSoul, type ParsedSoul } from '@stratusagent/agents';
import {
  claimSoulFile,
  collectAvailableModels as collectModels,
  credentialsPath,
  defaultApiKeyEnvName,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_STRATUS_AGENT,
  globalConfigPath,
  loadChannelCredentials,
  loadCredentials,
  loadRosterSouls,
  loadSoulFile,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  resolveAgentApprovals,
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  saveChannelCredentials,
  saveConfigFile,
  saveCredentials,
  CREDENTIAL_PROVIDER_NAMES,
  verifyProviderKey,
  workspacesDirPath,
  type ApiConfig,
  type ApprovalsConfig,
  type CatalogModel,
  type PrincipalsConfig,
  type ChannelCredentials,
  type CredentialProviderName,
  type CredentialsFile,
  type PluginConfigBlock,
  type PluginsConfig,
  type RosterEntry,
  type FallbackRuntime,
  type RuntimeConfig,
  type StoredCredential,
} from '@stratusagent/state';
import {
  installService,
  readServiceStatus,
  servicePlatform,
  serviceUnitPath,
  uninstallService,
} from '../service.ts';
import { type ApprovalReach, classifyApprovalReach, unattendedReachParts } from '../approvals.ts';
import { serviceEnvFor } from '../daemon.ts';
import type { CliStreams, CliEnvironment, CliConfigFile } from '../environment.ts';
import { writeLine } from '../io.ts';
import { packageInstalled } from '../loaders.ts';
import { isPackageName, isInstallableSpecifier, defaultPackageInstaller } from '../npm.ts';
import type { CliProviderName, ParsedSetupCommand } from '../parse.ts';
import { PLUGIN_MARKETPLACE_URL, FIRST_PARTY_CAPABILITY_PACKAGES } from '../plugin-catalog.ts';
import {
  menuPrefixWidth,
  quoteShellArg,
  stratusHeaderLines,
  createSetupPrompter,
} from '../prompter.ts';
import { soulGrantsTool } from '../roster.ts';
import { runSingleLoop, printSessionSummary, formatRuntimeBanner } from '../runtime.ts';
import { verifySlackBotToken, verifySlackAppToken, slackAppManifest } from '../slack.ts';

export const DEFAULT_SOUL_STARTER = [
  'You are a helpful, warm generalist. Answer first, explain second, and',
  'keep replies short unless the question genuinely needs depth. Use',
  'memory.remember for durable facts about the people you work with, and',
  'memory.recall to look up what you know when a conversation calls for it.',
].join('\n');

interface SetupState {
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
  credentials: CredentialsFile;
  credentialsDirty: boolean;
  /** Channel tokens (Slack apps, keyed by agent id) and whether they changed. */
  channels: ChannelCredentials;
  channelsDirty: boolean;
  /** Run stratusd under the platform's service manager after saving. */
  service: { install: boolean; runAtLogin: boolean };
}

export const runSetup = async (
  command: ParsedSetupCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const cwd = readWorkingDirectory(env);
  const processEnv = readProcessEnv(env);

  // Config target: --config, then STRATUS_CONFIG, then the global
  // ~/.stratus/config.json — the file `stratus run` falls back to from any
  // directory, which is what makes setup a one-time step.
  const envConfigVar = readNonEmptyString(processEnv.STRATUS_CONFIG) ? 'STRATUS_CONFIG' : undefined;
  const envConfigPath = envConfigVar ? String(processEnv.STRATUS_CONFIG).trim() : undefined;
  const configPath = command.configPath
    ? path.resolve(cwd, command.configPath)
    : envConfigPath
      ? path.resolve(cwd, envConfigPath)
      : globalConfigPath(env);
  // A path passed via --config is not auto-discovered by `stratus run`, so
  // suggested commands must carry it explicitly.
  const runConfigFlag = command.configPath ? ` --config ${quoteShellArg(command.configPath)}` : '';
  // Set once save() detects a project config shadowing the global one.
  // Suggested commands must carry it too, or they read a different config
  // than the one just written — for `serve` that means a different roster,
  // and Slack apps stored here would be skipped as having no agent.
  let shadowConfigFlag = '';
  const serveCommand = (): string => `stratus serve${runConfigFlag}${shadowConfigFlag}`;

  // Seed from what is already configured, so re-running setup edits instead
  // of clobbering.
  let existing: CliConfigFile = {};
  try {
    existing = await loadConfigFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      writeLine(streams.stderr, `Warning: could not read ${configPath} (${error instanceof Error ? error.message : String(error)}); starting fresh.`);
    }
  }

  // Interactive mode is a screen-based interface: every menu clears and
  // redraws under a fixed header, and status lines printed between menus
  // are carried onto the next screen (dimmed) so nothing is missed.
  const interactive = env.setupInput === undefined && process.stdin.isTTY === true;
  const baseStreams = streams;
  const recentNotices: string[] = [];
  if (interactive) {
    streams = {
      stderr: baseStreams.stderr,
      stdout: {
        write(chunk: string) {
          for (const raw of String(chunk).split('\n')) {
            const line = raw.trimEnd();
            if (line.trim().length > 0) {
              recentNotices.push(line);
              if (recentNotices.length > 8) {
                recentNotices.shift();
              }
            }
          }
          return baseStreams.stdout.write(chunk);
        },
      },
    };
  }

  const state: SetupState = {
    provider: existing.provider ?? 'anthropic',
    ...(existing.model ? { model: existing.model } : {}),
    ...(existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(existing.apiKeyEnv ? { apiKeyEnv: existing.apiKeyEnv } : {}),
    ...(existing.systemPrompt ? { systemPrompt: existing.systemPrompt } : {}),
    ...(existing.soul ? { soulPath: existing.soul } : {}),
    ...(existing.fallbackModel ? { fallbackModel: existing.fallbackModel } : {}),
    // Pin an implicit fallback provider now, so a later default-provider
    // switch cannot silently change what the fallback means.
    ...(existing.fallbackModel || existing.fallbackProvider
      ? { fallbackProvider: existing.fallbackProvider ?? existing.provider ?? 'anthropic' }
      : {}),
    ...(existing.fallbackBaseUrl ? { fallbackBaseUrl: existing.fallbackBaseUrl } : {}),
    ...(existing.vision !== undefined ? { vision: existing.vision } : {}),
    ...(existing.promptCache !== undefined ? { promptCache: existing.promptCache } : {}),
    ...(existing.promptCacheTtl !== undefined ? { promptCacheTtl: existing.promptCacheTtl } : {}),
    ...(existing.plugins !== undefined ? { plugins: existing.plugins } : {}),
    ...(existing.approvals !== undefined ? { approvals: existing.approvals } : {}),
    ...(existing.api !== undefined ? { api: existing.api } : {}),
    ...(existing.principals !== undefined ? { principals: existing.principals } : {}),
    credentials: await loadCredentials(env),
    credentialsDirty: false,
    channels: await loadChannelCredentials(env),
    channelsDirty: false,
    // On by default: setup's whole promise is that you finish it and the
    // agents are working. An always-on runtime you have to remember to
    // start is not always-on, and every Slack app configured here stays
    // silent until stratusd is up. An existing install keeps ITS login
    // setting, though — rerunning setup and pressing save must not quietly
    // undo a deliberate `service install --no-login`.
    service: await (async () => {
      const status = await readServiceStatus(serviceEnvFor(env)).catch(() => undefined);
      // An unknown answer (a broken user bus, a timed-out query) must not
      // read as "they chose --no-login" — that would disable a service on
      // the next save because of a transient failure.
      return {
        install: true,
        runAtLogin: status?.installed && status.runAtLogin !== undefined ? status.runAtLogin : true,
      };
    })(),
  };

  const prompter = createSetupPrompter(baseStreams, env, {
    header: stratusHeaderLines,
    consumeNotices: () => recentNotices.splice(0),
  });

  const defaultModelFor = (provider: CliProviderName): string =>
    provider === 'openai'
      ? DEFAULT_OPENAI_MODEL
      : provider === 'codex'
        ? DEFAULT_CODEX_MODEL
        : DEFAULT_ANTHROPIC_MODEL;
  // Widened to CliProviderName only so setup can ask about the provider it
  // currently has selected, `demo` included; the rule itself is the shared one.
  const defaultKeyEnvFor = (provider: CliProviderName): string =>
    defaultApiKeyEnvName(provider === 'demo' ? 'anthropic' : provider);

  const credentialLabel = (provider: CredentialProviderName, credential: StoredCredential): string =>
    credential.type === 'oauth_token'
      ? (provider === 'codex' ? 'ChatGPT sign-in' : 'Claude subscription')
      : 'API key';

  const providerSignInStatus = (provider: CredentialProviderName): string => {
    const credential = state.credentials[provider];
    if (credential) {
      return `signed in (${credentialLabel(provider, credential)})`;
    }
    if (readNonEmptyString(processEnv[defaultKeyEnvFor(provider)])) {
      return `using ${defaultKeyEnvFor(provider)} from your environment`;
    }
    return 'not signed in';
  };

  const providersSummary = (): string => {
    const parts: string[] = [];
    for (const provider of CREDENTIAL_PROVIDER_NAMES) {
      const credential = state.credentials[provider];
      if (credential) {
        parts.push(`${provider} (${credentialLabel(provider, credential)})`);
      } else if (readNonEmptyString(processEnv[defaultKeyEnvFor(provider)])) {
        parts.push(`${provider} (env key)`);
      }
    }
    if (parts.length === 0) {
      return state.provider === 'demo' ? 'demo — offline, no account' : 'none signed in yet';
    }
    if (state.provider === 'demo') {
      parts.push('default: demo');
    }
    return parts.join(' · ');
  };

  const modelsSummary = (): string => {
    if (state.provider === 'demo') {
      return 'demo (no model)';
    }
    const base = `default ${state.model ?? `${defaultModelFor(state.provider)} (default)`}`;
    return state.fallbackModel ? `${base} · fallback ${state.fallbackModel}` : `${base} · no fallback`;
  };

  const signInSummary = (): string => {
    if (state.provider === 'demo') {
      return 'no account needed';
    }
    const credential = state.credentials[state.provider];
    if (credential) {
      return credential.type === 'oauth_token'
        ? (state.provider === 'codex'
            ? 'using your ChatGPT (codex login) sign-in'
            : 'signed in with your Claude subscription')
        : 'signed in with an API key';
    }
    const keyEnv = state.apiKeyEnv ?? defaultKeyEnvFor(state.provider);
    if (readNonEmptyString(processEnv.STRATUS_API_KEY) ?? readNonEmptyString(processEnv[keyEnv])) {
      return `using ${readNonEmptyString(processEnv.STRATUS_API_KEY) ? 'STRATUS_API_KEY' : keyEnv} from your environment`;
    }
    return 'not signed in yet';
  };

  const agentSummary = (): string => {
    if (!state.soulPath) {
      return 'none — every run uses the built-in default agent';
    }
    return state.soulPath;
  };

  const channelsSummary = (): string => {
    const connected = Object.keys(state.channels.slack ?? {}).length;
    if (connected === 0) {
      return 'Slack: not connected';
    }
    return `Slack: ${connected} agent${connected === 1 ? '' : 's'} connected`;
  };

  const storeCredential = (provider: CredentialProviderName, credential: StoredCredential): void => {
    state.credentials[provider] = credential;
    state.credentialsDirty = true;
  };

  const signInAnthropic = async (): Promise<void> => {
    const signedIn = state.credentials.anthropic !== undefined;
    const answer = await prompter.select('How should Stratus connect to Claude?', [
      'Claude subscription (Pro/Max) — sign in through Claude Code, no per-token cost',
      'Anthropic API key — pay per use (console.anthropic.com)',
      'Skip for now',
      ...(signedIn ? ['Sign out'] : []),
    ]);

    if (signedIn && answer.kind === 'index' && answer.index === 3) {
      delete state.credentials.anthropic;
      state.credentialsDirty = true;
      writeLine(streams.stdout, 'Signed out of Anthropic.');
      return;
    }

    if (answer.kind !== 'index' || answer.index === 2) {
      return;
    }

    if (answer.index === 1) {
      const key = await prompter.askSecret('Paste your Anthropic API key (starts with sk-ant-, Enter to skip; input is hidden): ');
      if (!key) {
        writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
        return;
      }
      writeLine(streams.stdout, 'Checking the key against the Anthropic API…');
      // The key is verified against the configured endpoint and bound to
      // it, so a later provider switch (or an anthropic fallback) can never
      // send a proxy credential to the official endpoint.
      const verifyEndpoint = state.provider === 'anthropic' ? state.baseUrl : undefined;
      const binding = verifyEndpoint && verifyEndpoint.replace(/\/+$/, '') !== DEFAULT_ANTHROPIC_BASE_URL
        ? { baseUrl: verifyEndpoint }
        : {};
      const verdict = await verifyProviderKey('anthropic', key, verifyEndpoint, env.fetch ?? globalThis.fetch);
      if (verdict.status === 'ok') {
        storeCredential('anthropic', { type: 'api_key', value: key, ...binding });
        writeLine(streams.stdout, '✓ Key verified — you are signed in to Anthropic.');
      } else if (verdict.status === 'rejected') {
        writeLine(streams.stdout, `✗ Anthropic rejected that key (${verdict.detail}). It was NOT saved — check console.anthropic.com and try again from this menu.`);
      } else {
        storeCredential('anthropic', { type: 'api_key', value: key, ...binding });
        writeLine(streams.stdout, `! Could not reach the Anthropic API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
      }
      return;
    }

    // Default: subscription sign-in via Claude Code.
    writeLine(streams.stdout, 'Your Claude Pro/Max subscription covers usage made through Claude Code.');
    writeLine(streams.stdout, 'In another terminal on this machine, run:');
    writeLine(streams.stdout, '  claude setup-token');
    writeLine(streams.stdout, '(requires Claude Code installed and signed in to your Claude account)');
    const token = await prompter.askSecret('Paste the setup token it prints (starts with sk-ant-oat, Enter to skip; input is hidden): ');
    if (!token) {
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    storeCredential('anthropic', { type: 'oauth_token', value: token });
    writeLine(streams.stdout, '✓ Subscription token saved. It is verified on your first run.');
  };

  const signInOpenAI = async (): Promise<void> => {
    const currentEndpoint = (state.provider === 'openai' ? state.baseUrl : undefined)
      ?? state.credentials.openai?.baseUrl
      ?? DEFAULT_OPENAI_BASE_URL;
    const baseUrlAnswer = await prompter.ask(`API base URL [${currentEndpoint}]: `);
    const chosenEndpoint = baseUrlAnswer || currentEndpoint;
    // state.baseUrl describes the DEFAULT provider's endpoint; a secondary
    // openai sign-in keeps its endpoint on the credential instead. The
    // change is committed only once a sign-in is accepted — a rejected key
    // must not leave a new endpoint paired with the old credential.
    const commitEndpoint = (): void => {
      if (state.provider === 'openai') {
        state.baseUrl = chosenEndpoint;
      }
    };
    const key = await prompter.askSecret('Paste your API key (Enter to skip; input is hidden): ');
    if (!key) {
      // Without a stored credential there is no old key the new endpoint
      // could be mispaired with.
      if (!state.credentials.openai) {
        commitEndpoint();
      } else if (chosenEndpoint !== currentEndpoint) {
        writeLine(streams.stdout, 'Endpoint left unchanged — paste a key for the new endpoint to switch to it.');
      }
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    writeLine(streams.stdout, 'Checking the key…');
    // The endpoint travels with the credential, so this sign-in keeps
    // working even when another provider is the default.
    const endpoint = chosenEndpoint !== DEFAULT_OPENAI_BASE_URL ? { baseUrl: chosenEndpoint } : {};
    const verdict = await verifyProviderKey('openai', key, chosenEndpoint, env.fetch ?? globalThis.fetch);
    if (verdict.status === 'ok') {
      storeCredential('openai', { type: 'api_key', value: key, ...endpoint });
      commitEndpoint();
      writeLine(streams.stdout, '✓ Key verified — you are signed in.');
    } else if (verdict.status === 'rejected') {
      writeLine(streams.stdout, `✗ The API rejected that key (${verdict.detail}). It was NOT saved — try again from this menu.`);
      if (chosenEndpoint !== currentEndpoint) {
        writeLine(streams.stdout, 'The endpoint was left unchanged as well.');
      }
    } else {
      storeCredential('openai', { type: 'api_key', value: key, ...endpoint });
      commitEndpoint();
      writeLine(streams.stdout, `! Could not reach the API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
    }
  };

  const signInCodex = async (): Promise<void> => {
    const signedIn = state.credentials.codex !== undefined;
    const answer = await prompter.select('How should Stratus connect to Codex?', [
      'ChatGPT subscription — uses this machine\'s `codex login` sign-in, no per-token cost',
      'OpenAI API key — pay per use (platform.openai.com)',
      'Skip for now',
      ...(signedIn ? ['Sign out'] : []),
    ]);

    if (signedIn && answer.kind === 'index' && answer.index === 3) {
      delete state.credentials.codex;
      state.credentialsDirty = true;
      writeLine(streams.stdout, 'Signed out of Codex. (A `codex login` sign-in, if any, stays with codex itself — run `codex logout` to clear it.)');
      return;
    }

    if (answer.kind !== 'index' || answer.index === 2) {
      return;
    }

    if (answer.index === 1) {
      const key = await prompter.askSecret('Paste your OpenAI API key (Enter to skip; input is hidden): ');
      if (!key) {
        writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
        return;
      }
      writeLine(streams.stdout, 'Checking the key against the OpenAI API…');
      const verdict = await verifyProviderKey('codex', key, undefined, env.fetch ?? globalThis.fetch);
      if (verdict.status === 'ok') {
        storeCredential('codex', { type: 'api_key', value: key });
        writeLine(streams.stdout, '✓ Key verified — Codex runs will bill this OpenAI API key.');
      } else if (verdict.status === 'rejected') {
        writeLine(streams.stdout, `✗ OpenAI rejected that key (${verdict.detail}). It was NOT saved — check platform.openai.com and try again from this menu.`);
      } else {
        storeCredential('codex', { type: 'api_key', value: key });
        writeLine(streams.stdout, `! Could not reach the OpenAI API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
      }
      return;
    }

    // Default: the machine's own ChatGPT sign-in. Codex keeps those tokens
    // in its own auth store; Stratus records only that this machine uses
    // it, so nothing secret is written here.
    writeLine(streams.stdout, 'Your ChatGPT plan covers usage made through Codex.');
    writeLine(streams.stdout, 'If you have not signed in yet, run this in another terminal on this machine:');
    writeLine(streams.stdout, '  codex login');
    writeLine(streams.stdout, '(requires the Codex CLI: npm install -g @openai/codex)');
    const confirmed = await prompter.select('Use this machine\'s codex sign-in?', ['Yes — codex is (or will be) signed in here', 'Skip for now']);
    if (confirmed.kind !== 'index' || confirmed.index !== 0) {
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    storeCredential('codex', { type: 'oauth_token', value: 'chatgpt' });
    writeLine(streams.stdout, '✓ Recorded — Codex runs use this machine\'s ChatGPT sign-in. It is verified on your first run.');
  };

  // Changing the default provider invalidates settings that were chosen
  // for the old one: the model and apiKeyEnv are cleared (defaults take
  // over), while the openai base URL is kept — it belongs to the openai
  // sign-in and still serves openai fallbacks. A soul that pins a provider
  // outranks the config at run time, so that earns a warning, not a reset.
  const switchDefaultProvider = async (next: CliProviderName): Promise<void> => {
    if (state.provider === next) {
      return;
    }
    state.provider = next;
    delete state.model;
    delete state.apiKeyEnv;
    // state.baseUrl is the DEFAULT provider's endpoint; the old provider's
    // URL must not follow the switch. An openai default reseeds from the
    // credential's bound endpoint.
    delete state.baseUrl;
    if (next === 'openai' && state.credentials.openai?.baseUrl) {
      state.baseUrl = state.credentials.openai.baseUrl;
    }
    if (state.soulPath) {
      try {
        const soul = parseSoul(await readFile(state.soulPath, 'utf8'), { seed: state.soulPath });
        if (soul.provider && soul.provider !== next) {
          writeLine(
            streams.stdout,
            `Heads up: your default agent (${soul.agent.name}) pins provider ${soul.provider} in their soul, which outranks this choice at run time. Edit ${state.soulPath} or clear the agent (menu 3).`,
          );
        }
      } catch {
        // A broken soul file surfaces when it is actually used.
      }
    }
  };

  // Whether a provider could actually serve a run right now, through any
  // credential source a real run would consider: the stored sign-in, the
  // generic STRATUS_API_KEY, a configured apiKeyEnv, or the provider's own
  // env var.
  const providerUsable = (provider: CliProviderName): boolean => {
    if (provider === 'demo') {
      return true;
    }
    const keyEnvSelector = provider === state.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
        ?? state.apiKeyEnv
      : undefined;
    return state.credentials[provider] !== undefined
      || readNonEmptyString(processEnv.STRATUS_API_KEY) !== undefined
      || (keyEnvSelector ? readNonEmptyString(processEnv[String(keyEnvSelector)]) !== undefined : false)
      || readNonEmptyString(processEnv[defaultKeyEnvFor(provider)]) !== undefined;
  };

  // Signing in makes that provider the default only when the current
  // default cannot actually run (demo, or a provider with no usable key).
  const maybeSwitchDefault = async (provider: CredentialProviderName): Promise<void> => {
    if (state.provider === 'demo' || (state.provider !== provider && !providerUsable(state.provider))) {
      await switchDefaultProvider(provider);
    }
  };

  const chooseProviders = async (): Promise<void> => {
    const answer = await prompter.select('Providers — sign in to one or more:', [
      `Claude (Anthropic) — ${providerSignInStatus('anthropic')}`,
      `OpenAI-compatible — ${providerSignInStatus('openai')}`,
      `Codex (ChatGPT) — ${providerSignInStatus('codex')}`,
      'Demo — built-in fake model, offline, no account',
      'Back',
    ]);

    if (answer.kind !== 'index' || answer.index === 4) {
      return;
    }

    if (answer.index === 3) {
      await switchDefaultProvider('demo');
      writeLine(streams.stdout, 'Demo selected — no sign-in needed. Mention "echo" or "tool" in a prompt to see tool calls.');
      return;
    }

    if (answer.index === 2) {
      await signInCodex();
      if (state.credentials.codex) {
        await maybeSwitchDefault('codex');
      }
      return;
    }

    if (answer.index === 1) {
      await signInOpenAI();
      if (state.credentials.openai) {
        await maybeSwitchDefault('openai');
      }
      return;
    }

    await signInAnthropic();
    if (state.credentials.anthropic) {
      await maybeSwitchDefault('anthropic');
    }
  };

  // Every model the current sign-ins can actually reach. The rule lives in
  // @stratusagent/state because the control API answers the same question —
  // setup passes the selection it is *holding* rather than the saved one, so
  // a key pasted a moment ago is already in play.
  const collectAvailableModels = (): Promise<CatalogModel[]> => collectModels(
    {
      provider: state.provider,
      ...(state.baseUrl !== undefined ? { baseUrl: state.baseUrl } : {}),
      ...(state.apiKeyEnv !== undefined ? { apiKeyEnv: state.apiKeyEnv } : {}),
      credentials: state.credentials,
    },
    env,
  );

  const pickModel = async (kind: 'default' | 'fallback'): Promise<void> => {
    const available = await collectAvailableModels();
    if (available.length === 0) {
      writeLine(streams.stdout, 'No models available yet — sign in to a provider first (menu 1).');
      return;
    }

    const shown = available.slice(0, 30);
    const labels = shown.map((entry) => `${entry.id} — ${entry.provider}`);
    const typeItOption = labels.length;
    labels.push('Type a model id…');
    const footnote = available.length > shown.length
      ? `  …and ${available.length - shown.length} more — pick "Type a model id…" to name one.`
      : undefined;

    const answer = await prompter.select('Available models:', labels, {
      allowText: true,
      ...(footnote ? { footnote } : {}),
    });
    if (answer.kind === 'back') {
      return;
    }

    const parseTyped = (typed: string): { provider: CredentialProviderName; id: string } | undefined => {
      if (typed.includes(':')) {
        const [providerPart, ...idParts] = typed.split(':');
        const id = idParts.join(':').trim();
        if ((providerPart === 'anthropic' || providerPart === 'openai' || providerPart === 'codex') && id) {
          return { provider: providerPart, id };
        }
        writeLine(streams.stdout, 'Use provider:model, e.g. anthropic:claude-opus-5 or codex:gpt-5.5.');
        return undefined;
      }
      // A typed id that appears in the collected list belongs to that
      // provider, wherever the default currently points.
      const listed = available.find((entry) => entry.id === typed);
      const inferred = listed?.provider
        ?? (state.provider !== 'demo' ? state.provider : available[0]!.provider);
      return { provider: inferred, id: typed };
    };

    let choice: { provider: CredentialProviderName; id: string } | undefined;
    if (answer.kind === 'text') {
      choice = parseTyped(answer.text);
    } else if (answer.index === typeItOption) {
      const typed = await prompter.ask('Model id (or provider:model): ');
      choice = typed ? parseTyped(typed) : undefined;
    } else {
      choice = shown[answer.index];
    }

    if (!choice) {
      return;
    }

    if (kind === 'default') {
      await switchDefaultProvider(choice.provider);
      state.model = choice.id;
      writeLine(streams.stdout, `Default model set to ${choice.id} (${choice.provider}).`);
      // A soul's model pin outranks the config at run time, so a silent
      // mismatch here would make this choice a no-op.
      if (state.soulPath) {
        try {
          const soul = parseSoul(await readFile(state.soulPath, 'utf8'), { seed: state.soulPath });
          if (soul.model && soul.model !== choice.id
            && (soul.provider === undefined || soul.provider === choice.provider)) {
            writeLine(
              streams.stdout,
              `Heads up: your default agent (${soul.agent.name}) pins model ${soul.model} in their soul, which outranks this choice at run time. Edit ${state.soulPath} or clear the agent (menu 3).`,
            );
          }
        } catch {
          // A broken soul file surfaces when it is actually used.
        }
      }
    } else {
      state.fallbackProvider = choice.provider;
      state.fallbackModel = choice.id;
      const openaiEndpoint = (state.provider === 'openai' ? state.baseUrl : undefined)
        ?? state.credentials.openai?.baseUrl;
      if (choice.provider === 'openai' && openaiEndpoint && openaiEndpoint !== DEFAULT_OPENAI_BASE_URL) {
        state.fallbackBaseUrl = openaiEndpoint;
      } else {
        delete state.fallbackBaseUrl;
      }
      if (choice.id === (state.model ?? defaultModelFor(state.provider)) && choice.provider === state.provider) {
        writeLine(streams.stdout, 'Note: the fallback matches the default model, so it will not add resilience.');
      }
      writeLine(streams.stdout, `Fallback model set to ${choice.id} (${choice.provider}) — used when the default model errors mid-run.`);
    }
  };

  const chooseModels = async (): Promise<void> => {
    const answer = await prompter.select(`Models — ${modelsSummary()}`, [
      'Choose the default model',
      'Choose a fallback model',
      'Clear the fallback',
      'Back',
    ]);

    if (answer.kind !== 'index' || answer.index === 3) {
      return;
    }
    if (answer.index === 1) {
      await pickModel('fallback');
      return;
    }
    if (answer.index === 2) {
      delete state.fallbackModel;
      delete state.fallbackProvider;
      writeLine(streams.stdout, 'Fallback cleared.');
      return;
    }
    await pickModel('default');
  };

  const chooseAgent = async (): Promise<void> => {
    const answer = await prompter.select('Your default agent:', [
      'Create a new agent',
      'Use an existing soul file',
      'No default agent',
    ]);

    if (answer.kind !== 'index') {
      return;
    }

    if (answer.index === 2) {
      delete state.soulPath;
      writeLine(streams.stdout, 'Cleared — runs use the built-in default agent.');
      return;
    }

    if (answer.index === 1) {
      const soulAnswer = await prompter.ask('Path to the soul file: ');
      if (!soulAnswer) {
        return;
      }
      const resolved = path.resolve(cwd, soulAnswer);
      try {
        const soul = parseSoul(await readFile(resolved, 'utf8'), { seed: resolved });
        state.soulPath = resolved;
        writeLine(streams.stdout, `Loaded ${soul.agent.name} from ${resolved}.`);
      } catch (error) {
        writeLine(streams.stdout, `Could not load that soul file: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const name = await prompter.ask('Name your agent (Enter to have one generated): ');
    const instructions = await prompter.ask('Describe their personality in a sentence or two (Enter for a starter you can edit later): ');
    const persona = instructions || DEFAULT_SOUL_STARTER;
    const pin = state.provider !== 'demo'
      ? { provider: state.provider, model: state.model ?? defaultModelFor(state.provider) }
      : {};
    const claimed = await claimSoulFile(
      env,
      { ...(name ? { name } : {}), instructions: persona },
      (agent) => formatSoul({ agent, ...pin }),
      (message) => writeLine(streams.stdout, message),
    );
    const { agent, soulPath } = claimed;
    state.soulPath = soulPath;
    writeLine(streams.stdout, `Say hello to ${agent.name}.`);
    writeLine(streams.stdout, `Their soul lives at ${soulPath} — edit it any time to change how they talk.`);
  };

  // Mirror the saved config's fallback so option 4 exercises the same
  // failover a real run would perform.
  const buildTestFallback = (): FallbackRuntime | undefined => {
    if (!state.fallbackModel || state.provider === 'demo') {
      return undefined;
    }
    const fallbackProvider = (state.fallbackProvider ?? state.provider) as CredentialProviderName;
    const envKey = (fallbackProvider === state.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY)
      : undefined)
      ?? readNonEmptyString(processEnv[defaultKeyEnvFor(fallbackProvider)]);
    const candidate = envKey ? undefined : state.credentials[fallbackProvider];
    // A codex fallback consumes no endpoint URL, so a stored key bound to
    // one cannot serve it — the same skip resolveRuntimeConfig performs.
    const credential = fallbackProvider === 'codex' && candidate?.type === 'api_key' && candidate.baseUrl !== undefined
      ? undefined
      : candidate;
    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    // A codex oauth entry is the subscription marker, not a token to send.
    const codexSubscription = fallbackProvider === 'codex' && !apiKey && credential?.type === 'oauth_token';
    const authToken = fallbackProvider !== 'codex' && credential?.type === 'oauth_token' ? credential.value : undefined;
    if (!apiKey && !authToken && !codexSubscription) {
      return undefined;
    }
    return {
      provider: fallbackProvider,
      model: state.fallbackModel,
      ...(fallbackProvider === 'openai'
        ? {
            baseUrl: (credential?.type === 'api_key' ? credential.baseUrl : undefined)
              ?? state.fallbackBaseUrl
              ?? (state.provider === 'openai' ? state.baseUrl : undefined)
              ?? DEFAULT_OPENAI_BASE_URL,
          }
        // The codex harness owns its endpoints; only anthropic can carry one.
        : fallbackProvider === 'codex'
          ? {}
          : (() => {
              const url = (fallbackProvider === state.provider ? state.baseUrl : undefined)
                ?? (credential?.type === 'api_key' ? credential.baseUrl : undefined);
              return url ? { baseUrl: url } : {};
            })()),
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
      ...(codexSubscription ? { codexSubscription: true as const } : {}),
    };
  };

  const buildTestRuntime = async (): Promise<RuntimeConfig | undefined> => {
    let soul: ParsedSoul | undefined;
    if (state.soulPath) {
      try {
        soul = parseSoul(await readFile(state.soulPath, 'utf8'), { seed: state.soulPath });
      } catch (error) {
        writeLine(streams.stdout, `Warning: could not load the soul file (${error instanceof Error ? error.message : String(error)}); testing without it.`);
      }
    }

    if (state.provider === 'demo') {
      return { provider: 'demo', ...(soul ? { soul } : {}) };
    }

    // Mirror resolveRuntimeConfig exactly: environment keys (including the
    // STRATUS_API_KEY_ENV selector) outrank the stored sign-in, and a
    // stored key's bound endpoint is authoritative — so the inline test
    // exercises precisely what a real run will use.
    const keyEnv = readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
      ?? state.apiKeyEnv
      ?? defaultKeyEnvFor(state.provider);
    const envKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
      ?? readNonEmptyString(processEnv[String(keyEnv)]);
    const credential = envKey ? undefined : state.credentials[state.provider];
    const boundUrl = credential?.type === 'api_key' ? credential.baseUrl : undefined;
    const model = state.model ?? defaultModelFor(state.provider);

    if (state.provider === 'anthropic') {
      const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
      const authToken = credential?.type === 'oauth_token' ? credential.value : undefined;
      if (!apiKey && !authToken) {
        writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export ANTHROPIC_API_KEY).');
        return undefined;
      }
      const fallback = buildTestFallback();
      const anthropicUrl = boundUrl ?? state.baseUrl;
      return {
        provider: 'anthropic',
        model,
        ...(anthropicUrl ? { baseUrl: anthropicUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(authToken ? { authToken } : {}),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }

    if (state.provider === 'codex') {
      // The harness owns its endpoints: a key bound to one cannot be
      // honored on codex — resolveRuntimeConfig refuses this outright, and
      // the inline test mirrors it rather than quietly unbinding the key.
      if (boundUrl !== undefined) {
        writeLine(streams.stdout, `Your saved codex key is bound to ${boundUrl}, and codex does not use a custom base URL. Store the key without one to run on codex.`);
        return undefined;
      }
      const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
      // The subscription marker means the machine's own codex sign-in
      // serves the run — nothing more to resolve here.
      if (!apiKey && credential?.type !== 'oauth_token') {
        writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export CODEX_API_KEY).');
        return undefined;
      }
      const fallback = buildTestFallback();
      return {
        provider: 'codex',
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }

    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    if (!apiKey) {
      writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export OPENAI_API_KEY).');
      return undefined;
    }
    const fallback = buildTestFallback();
    return {
      provider: 'openai',
      model,
      baseUrl: boundUrl ?? state.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
      apiKey,
      ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
      ...(env.fetch ? { fetch: env.fetch } : {}),
      ...(soul ? { soul } : {}),
      ...(fallback ? { fallback } : {}),
    };
  };

  /**
   * Walks an agent through connecting their own Slack app: show the
   * manifest to paste, take both tokens, verify each against Slack, and
   * store them under the agent's id. Tokens are keyed by a roster agent
   * picked from a list rather than typed, so the id can never drift from
   * the roster — the mismatch that otherwise surfaces only as a startup
   * warning about an agent the gateway cannot find.
   */
  const connectSlackAgent = async (agentId: string, agentName: string): Promise<void> => {
    writeLine(streams.stdout);
    writeLine(streams.stdout, `Create a Slack app for ${agentName}:`);
    writeLine(streams.stdout, '  1. Open https://api.slack.com/apps → Create New App → From a manifest');
    writeLine(streams.stdout, '  2. Pick your workspace, then paste this manifest:');
    writeLine(streams.stdout);
    for (const line of slackAppManifest(agentName).split('\n')) {
      writeLine(streams.stdout, `    ${line}`);
    }
    writeLine(streams.stdout);
    writeLine(streams.stdout, '  3. Create the app, then Basic Information → App-Level Tokens →');
    writeLine(streams.stdout, '     Generate a token with the connections:write scope (xapp-…)');
    writeLine(streams.stdout, '  4. Install App → copy the Bot User OAuth Token (xoxb-…)');
    writeLine(streams.stdout, `  5. Basic Information → Display Information → upload ${agentName}'s avatar`);
    writeLine(streams.stdout);

    const appToken = await prompter.askSecret('Paste the app-level token (xapp-…, Enter to cancel; input is hidden): ');
    if (!appToken) {
      writeLine(streams.stdout, 'Cancelled — nothing was saved.');
      return;
    }
    if (!appToken.startsWith('xapp-')) {
      writeLine(streams.stdout, '✗ That does not look like an app-level token (they start with xapp-). Nothing was saved.');
      return;
    }
    const botToken = await prompter.askSecret('Paste the bot user OAuth token (xoxb-…, Enter to cancel; input is hidden): ');
    if (!botToken) {
      writeLine(streams.stdout, 'Cancelled — nothing was saved.');
      return;
    }
    if (!botToken.startsWith('xoxb-')) {
      writeLine(streams.stdout, '✗ That does not look like a bot token (they start with xoxb-). Nothing was saved.');
      return;
    }

    writeLine(streams.stdout, 'Checking the tokens with Slack…');
    const fetchImpl = env.fetch ?? globalThis.fetch;
    const bot = await verifySlackBotToken(botToken, fetchImpl);
    if (bot.status === 'rejected') {
      writeLine(streams.stdout, `✗ Slack rejected the bot token (${bot.detail}). Nothing was saved — reinstall the app and copy the token again.`);
      return;
    }
    const app = await verifySlackAppToken(appToken, fetchImpl);
    if (app.status === 'rejected') {
      writeLine(streams.stdout, `✗ Slack rejected the app-level token (${app.detail}). Nothing was saved — check it has the connections:write scope.`);
      return;
    }

    const slack = { ...(state.channels.slack ?? {}) };
    slack[agentId] = { appToken, botToken };
    state.channels = { ...state.channels, slack };
    state.channelsDirty = true;

    if (bot.status === 'ok' && app.status === 'ok') {
      const where = bot.identity.teamName ? ` in ${bot.identity.teamName}` : '';
      const who = bot.identity.botUserId ? ` (bot ${bot.identity.botUserId})` : '';
      writeLine(streams.stdout, `✓ Verified — ${agentName} is connected to Slack${where}${who}.`);
    } else {
      // Unreachable is not a verdict on the tokens: save and let the
      // daemon report on its first connection attempt.
      const detail = bot.status === 'unreachable' ? bot.detail : (app as { detail?: string }).detail;
      writeLine(streams.stdout, `! Could not reach Slack to verify (${detail}). Saved the tokens anyway — \`${serveCommand()}\` will report on startup.`);
    }
  };

  /**
   * A roster entry with an optional path: the built-in Stratus agent
   * comes from no file at all, exactly as the gateway registers it.
   */
  interface ChannelRosterEntry extends Omit<RosterEntry, 'path'> {
    path?: string;
  }

  /**
   * Every agent the gateway would dispatch to: the built-in Stratus
   * agent, the ~/.stratus/agents roster, and the configured default soul,
   * which `stratus setup` can point at a file anywhere. The gateway
   * registers all three, so a Channels list built from the agents
   * directory alone would hide agents Slack can perfectly well talk to.
   * Reads state.soulPath rather than the saved config so a soul chosen
   * earlier in this same setup session is already connectable.
   */
  const channelRoster = async (): Promise<{ entries: ChannelRosterEntry[]; loaded: boolean }> => {
    const warnOnce = (message: string): void => writeLine(streams.stderr, `Warning: ${message}.`);
    // Seeded before the roster loads, exactly as loadRoster does it: a
    // fresh install with no soul files still has an agent to put on
    // Slack, and a roster file that declares id "stratus" cannot take the
    // built-in's place — the gateway skips it, so offering it here would
    // name an app after an agent that never receives the messages.
    const entries: ChannelRosterEntry[] = [{ soul: { agent: { ...DEFAULT_STRATUS_AGENT } } }];
    // loadRosterSouls refuses a roster whose files collide, and drops the
    // ones claiming the reserved built-in id, so what comes back here is
    // already unambiguous.
    let rosterSouls: RosterEntry[] = [];
    let rosterLoaded = true;
    try {
      rosterSouls = await loadRosterSouls(env, warnOnce);
    } catch (error) {
      // A roster that cannot say who its agents are cannot have channels
      // configured for them — but the rest of setup (providers, models,
      // sign-ins) still works, so this reports and moves on rather than
      // taking the whole command down.
      rosterLoaded = false;
      warnOnce(error instanceof Error ? error.message : String(error));
      // Nothing is offered, not merely the colliding pair. A roster that
      // refuses to load fails `createGateway.start()` outright, so no
      // agent is servable — not the built-in seeded above, and not the
      // configured soul resolved below (which can itself BE one of the
      // colliding files). Listing any of them invites connecting a Slack
      // app to an agent the daemon cannot bring online, and connecting an
      // app is the expensive half of that mistake.
      return { entries: [], loaded: false };
    }
    entries.push(...rosterSouls);

    // The soul a run resolves to, in resolveSoulPath's own order: an env
    // override outranks the config value this setup session is editing.
    // Listing the config soul while `stratus serve` registers the env one
    // would store tokens against an id the adapter then skips.
    const processEnv = readProcessEnv(env);
    const envSoul = readNonEmptyString(processEnv.STRATUS_SOUL);
    if (typeof envSoul === 'string' && state.soulPath && envSoul !== state.soulPath) {
      warnOnce(`STRATUS_SOUL points at ${envSoul}, which outranks the configured ${state.soulPath} — Channels lists what a run would actually use`);
    }
    const effectiveSoul = typeof envSoul === 'string' ? envSoul : state.soulPath;
    if (!effectiveSoul) {
      return { entries, loaded: rosterLoaded };
    }
    const resolved = path.resolve(readWorkingDirectory(env), effectiveSoul);
    if (entries.some((entry) => entry.path === resolved)) {
      return { entries, loaded: rosterLoaded };
    }
    try {
      const soul = await loadSoulFile(resolved);
      // An explicit id can collide with a roster file, or with the
      // built-in. The gateway's defaultAgentId replaces the registered
      // source whenever it is pathless (the built-in) or resolves to a
      // different file, so the configured soul is the one Slack actually
      // dispatches to — offering the namesake here would connect an app
      // to a different agent than it names.
      const collision = entries.findIndex((entry) => entry.soul.agent.id === soul.agent.id);
      if (collision >= 0) {
        entries.splice(collision, 1);
      }
      entries.unshift({ soul, path: resolved });
    } catch (error) {
      warnOnce(`could not read the default soul ${resolved} (${error instanceof Error ? error.message : String(error)})`);
    }
    return { entries, loaded: rosterLoaded };
  };

  const serviceSummary = (): string => {
    if (!servicePlatform(serviceEnvFor(env))) {
      return `not available on ${env.processEnv?.OSTYPE ?? process.platform} — run \`stratus serve\` yourself`;
    }
    if (!state.service.install) {
      return 'off — start stratusd yourself with `stratus serve`';
    }
    return state.service.runAtLogin
      ? 'stratusd runs after setup, and at every login'
      : 'stratusd runs after setup, but not at login';
  };

  /**
   * Whether the roster keeps answering once this terminal closes. On by
   * default: an agent you have to remember to start is not always-on, and
   * every Slack app configured above is silent until stratusd runs.
   */
  const chooseService = async (): Promise<void> => {
    if (!servicePlatform(serviceEnvFor(env))) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, `Stratus has no service integration for ${process.platform} yet — run \`stratus serve\` yourself, or supervise it however you prefer.`);
      await prompter.ask('Press Enter to return to the menu… ');
      return;
    }
    const choice = await prompter.select('Always on — keep stratusd running in the background', [
      'Run after setup, and start again at every login (recommended)',
      'Run after setup, but do not start at login',
      'Do not run it for me — I will start `stratus serve` myself',
      'Back',
    ], {
      footnote: process.platform === 'darwin'
        // Said here rather than left to be discovered after a reboot.
        ? 'A LaunchAgent starts at login, not at power-on. For a machine that should recover unattended, turn on automatic login too.'
        : 'A user service starts at login. `loginctl enable-linger` keeps it up on a machine you do not stay logged in to.',
    });
    if (choice.kind !== 'index' || choice.index === 3) {
      return;
    }
    state.service = {
      install: choice.index !== 2,
      runAtLogin: choice.index === 0,
    };
  };

  /**
   * What a plugin's block should say when setup writes it, beyond
   * `enabled`. Only settings without which the plugin is installed,
   * enabled, and still useless — the failure this menu exists to stop
   * anyone reaching by accident:
   *
   * - `tool-fs` roots are the whole boundary. With none, the plugin loads
   *   and every call fails "No filesystem roots are configured", which
   *   reads to an agent as a broken tool rather than an unset one.
   * - `plugin-mcp` requires `servers`, and its value is a set of endpoints
   *   only the operator knows. A block written without it is refused at
   *   load, so this menu offers no one-key enable for it.
   *
   * `tool-shell`, `tool-web` and `tool-browser` work from `{ enabled:
   * true }` — their settings narrow what is already permitted, and the
   * plugin without them is restrictive rather than broken.
   */
  const PLUGIN_SETUP: Record<string, {
    label: string;
    grants: string;
    /** Asked for on enable; the block is not written without an answer. */
    needs?: { key: string; question: string; placeholder: string; list: boolean };
    /**
     * Something setup can neither supply nor check without importing the
     * plugin — which this menu never does. Printed on enable rather than
     * blocking, because unlike a missing `roots` it is usually already
     * satisfied and setup cannot tell which.
     */
    note?: string;
    /**
     * A setting setup cannot invent, and the reason. The refusal is about
     * the setting being absent, never about the package: a block that
     * already has it is enabled and disabled like any other.
     */
    byHand?: { key: string; reason: string };
  }> = {
    '@stratusagent/tool-fs': {
      label: 'Files',
      grants: 'fs.read, fs.list, fs.search, fs.write',
      needs: {
        key: 'roots',
        question: 'Which directories may agents read and write? (comma-separated, e.g. ~/notes): ',
        placeholder: '~/notes',
        list: true,
      },
    },
    '@stratusagent/tool-shell': { label: 'Shell', grants: 'shell.run' },
    '@stratusagent/tool-web': { label: 'Web', grants: 'web.fetch' },
    '@stratusagent/tool-browser': {
      label: 'Browser',
      grants: 'browser.goto, browser.read, browser.screenshot, browser.act',
      // The package depends on `playwright-core`, which downloads no
      // browser on purpose — a few megabytes rather than 150. So the
      // browser is one you already have or one you fetch, and without
      // either every call fails: enabled and unusable, the state this menu
      // exists to prevent. Setup cannot check for it without importing the
      // plugin, so it says so instead.
      note: 'It drives a browser you already have. If none is found, run `npx playwright install chromium`, '
        + 'or point it at yours with `channel` or `executablePath` under plugins["@stratusagent/tool-browser"].',
    },
    '@stratusagent/plugin-mcp': {
      label: 'MCP bridge',
      grants: 'mcp.<server>.<tool>, discovered at connect',
      // Setup checks that `servers` is an object and stops there. What
      // each entry needs — exactly one of `command` or `url`, and the
      // rest of `resolveServerSpec` — is the plugin's rule, and both ways
      // to apply it here are worse than not applying it: a copy in this
      // file drifts from the plugin the first time it gains a transport,
      // and importing the package to ask means calling `createPlugin`,
      // which the loader's own comment says may open a socket. So the
      // menu says what it did not check instead of implying it did. The
      // claim that needs qualifying is the grant line's "the next time
      // the daemon starts", which is a prediction about a block setup
      // never wrote.
      note: 'Setup checked that servers is a block and no further — reading what is inside it means loading the plugin, '
        + 'which setup never does. If the bridge refuses an entry, the daemon says "plugin @stratusagent/plugin-mcp did not load" '
        + 'at startup, and `stratus serve` shows that directly.',
      byHand: {
        key: 'servers',
        reason: 'it needs a servers block naming each MCP server — see docs/reference/config.md',
      },
    },
  };

  /** Every package this menu lists: the first-party set, plus whatever is already configured. */
  const pluginPackages = (): string[] => [
    ...FIRST_PARTY_CAPABILITY_PACKAGES,
    ...Object.keys(state.plugins ?? {}).filter((name) => !FIRST_PARTY_CAPABILITY_PACKAGES.includes(name)),
  ];

  const pluginEnabled = (name: string): boolean => {
    const block = state.plugins?.[name];
    return block !== undefined && block.enabled !== false;
  };

  /**
   * What the daemon would refuse about a block, or `undefined` if it would
   * take it — the loader's own preflight, not a third opinion.
   *
   * `stratus plugins` already runs `preflightPlugin` to answer exactly this
   * about an enabled plugin, and the menu asking it a different way was how
   * three rounds of review found a different hand-rolled check short of the
   * real rule: a `servers` that is a string, `roots` that are numbers, a
   * `timeoutMs` that is not an integer. The manifest's schema knows all
   * three, so the fix is to ask it rather than to keep guessing at it.
   *
   * A package that will not resolve has no manifest to ask, and that is
   * `undefined` too: setup cannot preflight what is not installed, and
   * saying nothing is wrong is the same answer it has always given there.
   */
  const pluginConfigProblem = async (name: string, block: PluginConfigBlock): Promise<string | undefined> => {
    try {
      const { manifest, directory } = await readPluginManifest(name, {
        resolve: (target) => import.meta.resolve(target),
      });
      await preflightPlugin(manifest, directory, block as JsonObject, workspacesDirPath(env));
      return undefined;
    } catch (error) {
      // A package that will not *resolve* is not a verdict about the block —
      // `host.resolve` throws a plain Error for that, and setup has always
      // answered "nothing known" there. Everything the loader itself
      // refuses is: a schema mismatch and a bad `toolRisks` override raise
      // `PluginConfigError`, while an unparseable manifest and a skill file
      // that is missing, unreadable or outside the package raise
      // `PluginManifestError`. Catching only the first read the second as
      // "no problem" and enabled a plugin the daemon rejects before it
      // registers anything.
      if (error instanceof PluginConfigError || error instanceof PluginManifestError) {
        return error.message;
      }
      return undefined;
    }
  };

  /**
   * What setup did not check about this plugin, or `undefined` if there is
   * nothing left unchecked.
   *
   * One concept, because the two cases print the same kind of sentence and
   * the verdict below has to be qualified for both. `preflightPlugin` never
   * imports the package — that is what lets it answer without starting
   * anything — so a plugin can pass every check here and still be refused
   * by `loadPlugins` for not exporting `createPlugin(config)`, returning
   * something that is not a plugin, or failing `setup()`. For the packages
   * this file knows, that is not a real risk and only the declared caveat
   * applies; for one it does not know, it is exactly the risk, and reading
   * an absent `PLUGIN_SETUP` entry as "nothing to declare" claimed a
   * readiness setup had no way to establish.
   */
  const uncheckedReason = (name: string): string | undefined => {
    const setup = PLUGIN_SETUP[name];
    if (setup === undefined) {
      return `Setup read ${name}'s manifest and no more — it never loads a package, so whether it exports createPlugin(config) `
        + 'is something only a daemon start will tell you. If it does not, the daemon says "plugin '
        + `${name} did not load" and registers nothing.`;
    }
    return setup.note;
  };

  /**
   * The tool names a plugin contributes, read from its manifest.
   *
   * The manifest rather than `PLUGIN_SETUP.grants`, which is display text
   * and exists only for the packages this file knows: a third-party plugin
   * has real names too, and they are what decides whether a soul's
   * `tools:` list already reaches it. `undefined` where no manifest can be
   * read — a question setup declines rather than answers wrongly.
   */
  const pluginContributions = async (
    name: string,
  ): Promise<{ packageName: string; tools: string[]; namespaces: string[]; skills: string[] } | undefined> => {
    try {
      const { manifest } = await readPluginManifest(name, {
        resolve: (target) => import.meta.resolve(target),
      });
      return {
        // The manifest's own name, which is *not* the config key: the same
        // package reached through an alias or a subpath specifier is a
        // different key and the same `packageName`, and the loader
        // qualifies skills with this one. Carried out of here so callers
        // cannot reach for the specifier by accident.
        packageName: manifest.packageName,
        tools: manifest.contributes.tools.map((tool) => tool.name),
        namespaces: manifest.contributes.toolsDiscovered.map((entry) => entry.namespace),
        // The qualified form the loader stages them under, which is what a
        // `skills:` entry has to match.
        skills: manifest.contributes.skills.map((skill) => `${manifest.packageName}:${skill.id}`),
      };
    } catch {
      return undefined;
    }
  };

  /**
   * Whether the setting a plugin is useless without resolves to something
   * for one agent, given the block that would be written.
   *
   * `resolvePluginAgentConfig` shallow-merges, so a per-agent value
   * *replaces* the fleet-wide one rather than extending it. That is why
   * `agents.<id>.roots: []` is how a config takes one agent out, and why a
   * fleet-wide list says nothing about an agent that overrides it.
   */
  const pluginSettingReaches = (
    block: PluginConfigBlock | undefined,
    key: string,
    agentId: string,
  ): boolean => {
    const agents = block?.agents;
    const own = typeof agents === 'object' && agents !== null && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)[agentId]
      : undefined;
    const value = typeof own === 'object' && own !== null && !Array.isArray(own)
      && key in (own as Record<string, unknown>)
      ? (own as Record<string, unknown>)[key]
      : block?.[key];
    // Nonempty is this menu's own question — "would an agent get anything"
    // — and the only part of it the manifest does not answer, since a
    // schema that permits `roots: []` is right to. Whether the entries are
    // the right *type* is the manifest's, checked by `pluginConfigProblem`
    // before enabling, so a second test for it here would be the copy this
    // file keeps growing.
    return Array.isArray(value) && value.length > 0;
  };

  const pluginsSummary = (): string => {
    const enabled = pluginPackages().filter((name) => pluginEnabled(name));
    if (enabled.length === 0) {
      return 'none — agents have no tools beyond the built-ins';
    }
    return enabled.map((name) => name.replace('@stratusagent/', '')).join(', ');
  };

  /**
   * Enabling is only the second of two gates, and this menu owns just that
   * one. The soul's `tools:` list is the other, and setup does not edit
   * souls — so the line to paste is printed rather than applied, which is
   * also the honest thing: which agent gets a tool is not a decision this
   * menu has the standing to make.
   */
  const printSoulGrantLine = async (name: string): Promise<void> => {
    const grants = PLUGIN_SETUP[name]?.grants;
    const first = grants?.split(',')[0]?.trim();
    writeLine(streams.stdout);

    // A soul with no `tools:` key is allowlisted for *every* registered
    // tool — `matchesToolAllowlist` treats an omitted list as permissive,
    // and the built-in `stratus` agent has none, so a fresh install always
    // has one. Enabling a plugin therefore can grant capability
    // immediately, and saying "no agent can call it yet" would understate
    // what just happened in the most common configuration there is. Read
    // the roster and say which of the two it was.
    const { entries, loaded } = await channelRoster();
    if (!loaded) {
      // The roster refused to load, so `entries` is empty — which is not
      // evidence that every soul has a `tools:` list. Claiming nothing can
      // call the plugin would be a statement about a file this command
      // could not read, and false the moment the collision is fixed if any
      // soul omits its allowlist. Same posture as the Channels menu.
      writeLine(streams.stdout, `${name} is enabled. Who can call it is unknown until the roster loads — fix the error above, then run \`stratus plugins\`.`);
      return;
    }
    const contributed = await pluginContributions(name);
    const label = (list: ChannelRosterEntry[]): string =>
      list.map((entry) => `${entry.soul.agent.name} (${entry.soul.agent.id})`).join(', ');
    // Every contributed tool name, concrete and discovered alike. A
    // discovered namespace is matched by overlap rather than prefix, which
    // `soulGrantsTool` handles; both are things a `tools:` entry can reach.
    const everyTool = contributed === undefined ? [] : [...contributed.tools, ...contributed.namespaces];
    // What one soul's allowlist actually reaches — the *names*, not a
    // yes/no. `tools: [fs.read]` grants one of the four tool-fs
    // contributes, and reporting the plugin as callable said all four were.
    //
    // Reported as the soul's own **entries**, never as the plugin's
    // declarations, because `toolScopesOverlap` is overlap and not
    // containment: a soul granting `mcp.linear.get_issue` overlaps a
    // declared `mcp.*` — which is the right test for "does this soul reach
    // the plugin" and the wrong thing to print, since it read back as the
    // soul granting the whole namespace. An entry says exactly what it
    // says, and a discovered namespace has no tool names to enumerate
    // until the bridge connects.
    const reached = (entry: ChannelRosterEntry): string[] => {
      const tools = entry.soul.agent.tools;
      if (tools === undefined) {
        return everyTool;
      }
      if (contributed === undefined) {
        // No manifest, no names to test — no claim either way about a soul
        // that named something specific.
        return [];
      }
      return tools.filter((granted) =>
        contributed.tools.some((tool) => soulGrantsTool([granted], tool, false))
        || contributed.namespaces.some((namespace) => soulGrantsTool([granted], namespace, true)));
    };
    /** Concrete contributed tools no entry of this soul's reaches. */
    const missedTools = (entry: ChannelRosterEntry): string[] => {
      const tools = entry.soul.agent.tools;
      if (tools === undefined || contributed === undefined) {
        return [];
      }
      // Only the concrete ones: a declared namespace registers its tools at
      // connect time, so setup cannot say which of them an entry misses.
      return contributed.tools.filter((tool) => !soulGrantsTool(tools, tool, false));
    };

    // Allowlisted is not the same as able to call it. `tool-fs` enabled
    // from a per-agent `roots` block leaves every *other* allowlisted soul
    // holding tools that throw "No filesystem roots are configured" on the
    // first call. Naming it as an agent that can call them would report the
    // installed-enabled-and-useless state this menu exists to prevent as
    // the success case.
    const needsKey = PLUGIN_SETUP[name]?.needs?.key;
    const settingReaches = (entry: ChannelRosterEntry): boolean => needsKey === undefined
      || pluginSettingReaches(state.plugins?.[name], needsKey, entry.soul.agent.id);
    const allowlisted = entries.filter((entry) => reached(entry).length > 0);
    const callable = allowlisted.filter(settingReaches);
    const unset = allowlisted.filter((entry) => !settingReaches(entry));
    const permissive = callable.filter((entry) => entry.soul.agent.tools === undefined);
    const explicit = callable.filter((entry) => entry.soul.agent.tools !== undefined);
    // The key travels with the agents rather than beside them, so the
    // branches below cannot ask about one and read the other.
    const shortfall = needsKey !== undefined && unset.length > 0
      ? { key: needsKey, agents: unset, one: unset.length === 1 }
      : undefined;

    // Skills are the other half of what a plugin contributes and they are
    // gated the other way round: an omitted `skills:` list is **none**,
    // deliberately, because a skill silently changing how an agent behaves
    // is worse than one it has to be told about. So no soul gains them by
    // default, and a line about tools cannot speak for them.
    const skillLine = (): void => {
      if (contributed === undefined || contributed.skills.length === 0) {
        return;
      }
      const one = contributed.skills.length === 1;
      writeLine(streams.stdout, `It also contributes ${one ? 'a skill' : 'skills'}: ${contributed.skills.join(', ')}.`);
      // Every id, not the first: `matchesSkillAllowlist` selects an exact id
      // or a package wildcard, so a one-item list from a plural sentence
      // grants one skill and silently leaves the rest off.
      //
      // The wildcard is built from the *manifest's* package name, never the
      // config key this menu was called with. They are the same for every
      // ordinary install and differ for an alias or a subpath specifier,
      // and the loader qualifies skills with the manifest's — so a wildcard
      // spelled from the key would grant nothing while the exact ids beside
      // it worked, which is the worst way for two halves of one sentence to
      // disagree.
      writeLine(streams.stdout, `Those are not granted by \`tools:\` and no soul gets them by default — an omitted \`skills:\` list is none. Add \`skills: [${contributed.skills.join(', ')}]\` to grant ${one ? 'it' : 'them'}${one ? '' : `, or \`skills: [${contributed.packageName}:*]\` for every skill this package contributes`}.`);
    };

    if (callable.length > 0) {
      if (permissive.length > 0) {
        writeLine(streams.stdout, `${name} is enabled — and ${label(permissive)} ${permissive.length === 1 ? 'has' : 'have'} no \`tools:\` list, which means every registered tool.`);
        writeLine(streams.stdout, uncheckedReason(name) !== undefined
          ? `So ${grants ?? 'what it contributes'} ${permissive.length === 1 ? 'is' : 'are'} what ${permissive.length === 1 ? 'that agent' : 'those agents'} would gain at the next daemon start — subject to the caveat above, which setup did not check.`
          : `So ${grants ?? 'what it contributes'} ${permissive.length === 1 ? 'is' : 'are'} callable by ${permissive.length === 1 ? 'that agent' : 'those agents'} the next time the daemon starts.`);
        writeLine(streams.stdout, 'Give a soul a `tools:` list to narrow that. `stratus plugins` shows who can call what.');
      }
      for (const entry of explicit) {
        // Per soul, and naming what its list *matched* — an allowlist can
        // grant one of four tools, and saying the plugin is callable there
        // reported the other three as available when the runtime denies
        // them.
        const names = reached(entry);
        const rest = missedTools(entry);
        writeLine(streams.stdout, `${name} is enabled — and ${entry.soul.agent.name} (${entry.soul.agent.id}) already grants ${names.join(', ')} in \`tools:\`${rest.length > 0 ? `, but not ${rest.join(', ')}` : ''}.`);
      }
      if (shortfall !== undefined) {
        writeLine(streams.stdout, `${label(shortfall.agents)} ${shortfall.one ? 'is' : 'are'} allowlisted too, but ${shortfall.key} is not set for ${shortfall.one ? 'it' : 'them'} — every call would fail until it is, under plugins["${name}"].agents.`);
      }
      skillLine();
      return;
    }

    if (shortfall !== undefined) {
      // Allowlisted souls, every one of them short the setting: neither the
      // "callable by" line above nor the "no soul names it" one below is
      // true, and each would send the operator to fix the wrong gate.
      writeLine(streams.stdout, `${name} is enabled. No agent can call it yet — ${label(shortfall.agents)} ${shortfall.one ? 'is' : 'are'} allowlisted for it, but ${shortfall.key} is not set for ${shortfall.one ? 'it' : 'them'} and every call would fail.`);
      writeLine(streams.stdout, `Set ${shortfall.key} for ${shortfall.one ? 'it' : 'them'} under plugins["${name}"].agents, then run \`stratus plugins\` to see the whole chain.`);
      skillLine();
      return;
    }

    if (everyTool.length === 0) {
      // A plugin that contributes no tools at all — skills only, which is a
      // valid manifest. Sending the operator to edit `tools:` would name
      // the wrong key entirely.
      if (contributed !== undefined && contributed.skills.length > 0) {
        writeLine(streams.stdout, `${name} is enabled. It contributes no tools, so there is nothing for a \`tools:\` list to name.`);
        skillLine();
        return;
      }
      writeLine(streams.stdout, `${name} is enabled. What it contributes is in its manifest — run \`stratus plugins\` to see it and who can reach it.`);
      return;
    }

    writeLine(streams.stdout, `${name} is enabled. No agent can call it yet — every soul in the roster has a \`tools:\` list and none of them names what it contributes, and a soul grants tools by naming them:`);
    writeLine(streams.stdout, `  tools: [${everyTool[0] as string}]`);
    writeLine(streams.stdout, `Add it to the \`tools:\` list in ${state.soulPath ?? 'your agent\'s soul file'}, then run \`stratus plugins\` to see the whole chain and what it contributes.`);
    skillLine();
  };

  const choosePlugins = async (): Promise<void> => {
    while (true) {
      const packages = pluginPackages();
      // Every package plus Back — the count the widest prefix comes from.
      const reserved = menuPrefixWidth(packages.length + 1);
      const options = packages.map((name) => {
        const short = name.replace('@stratusagent/', '');
        const installed = packageInstalled(name, env);
        const status = !installed
          ? '— not installed'
          : pluginEnabled(name)
            ? '✓ enabled'
            : 'installed, not enabled';
        return fitMenuRow(short.padEnd(18) + status, reserved);
      });
      options.push('Back');

      const choice = await prompter.select(
        'Plugins — what your agents can do (installing one grants nothing on its own)',
        options,
        { footnote: `More plugins — ${PLUGIN_MARKETPLACE_URL}` },
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }
      const name = packages[choice.index];
      if (!name) {
        return;
      }
      await choosePlugin(name);
    }
  };

  const choosePlugin = async (name: string): Promise<void> => {
    const setup = PLUGIN_SETUP[name];
    const installed = packageInstalled(name, env);
    const enabled = pluginEnabled(name);

    // Only a block still *missing* that setting is refused. A configured
    // one switched off — by this menu, which promises its settings are kept
    // for turning it back on — must be able to come back, or the promise is
    // false and the switch is one-way.
    const byHandValue = setup?.byHand !== undefined ? state.plugins?.[name]?.[setup.byHand.key] : undefined;
    // Present *and* something the loader would take. Presence alone read
    // `servers: "invalid"` as a config to switch back on; asking the
    // manifest instead of inventing a shape test here is the same move the
    // enable path makes, and there is one rule between them.
    const byHandProblem = setup?.byHand !== undefined && byHandValue !== undefined
      ? await pluginConfigProblem(name, state.plugins?.[name] ?? {})
      : undefined;
    const configuredByHand = byHandValue !== undefined && byHandProblem === undefined;
    if (setup?.byHand && !enabled && !configuredByHand) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, `${name} contributes ${setup.grants}.`);
      writeLine(streams.stdout, `Setup does not enable it: ${setup.byHand.reason}.`);
      if (byHandProblem !== undefined) {
        // Present, and not what the loader will take. Without this the
        // refusal reads as "you have not set it", which sends an operator
        // who plainly has to look for a menu bug rather than at the value.
        writeLine(streams.stdout, `A daemon would refuse the block you have: ${byHandProblem}`);
      }
      if (!installed) {
        writeLine(streams.stdout, `Install it with: npm install -g ${name}`);
      }
      await prompter.ask('Press Enter to return to the menu… ');
      return;
    }

    if (!installed) {
      // Enabled with the package gone — an uninstall, or a config copied
      // from another machine. The block is exactly what an operator would
      // want to clear, and reaching it used to require installing the
      // package first in order to switch it off.
      //
      // A key that could never end up loaded is offered no install: the row
      // comes from `Object.keys(state.plugins)`, so a typo, a stray
      // character or a copied `pkg@1.2.3` arrives here as a package name.
      //
      // The bare-name rule, not the installable-specifier one: this key is
      // what the loader hands `import.meta.resolve`, and Node does not
      // resolve a version suffix — so `npm install -g @scope/foo@latest`
      // succeeds and the plugin stays "not installed" forever. Switching it
      // off stays available either way; a block keyed by something that can
      // never load is exactly one to clear.
      const installable = isPackageName(name);
      const actions = enabled
        ? [...(installable ? ['Install it with npm install -g'] : []), 'Switch it off in the config', 'Back']
        : [...(installable ? ['Install it with npm install -g, then enable it'] : []), 'Back'];
      if (!installable) {
        writeLine(streams.stdout);
        writeLine(streams.stdout, isInstallableSpecifier(name)
          ? `${name} carries a version, and a plugins key is also the module specifier a daemon imports — Node does not resolve one, so installing it would leave the plugin absent. Key the block by the package name alone.`
          : `${name} is not a package name npm can install — check the key in your plugins config.`);
      }
      const answer = await prompter.select(
        enabled
          ? `${name} is enabled in your config but not installed, so a daemon registers nothing for it.`
          : `${name} is not installed. It contributes ${setup?.grants ?? 'its own tools'}.`,
        actions,
      );
      if (answer.kind !== 'index' || answer.index === actions.length - 1) {
        return;
      }
      if (enabled && answer.index === actions.length - 2) {
        disablePlugin(name);
        return;
      }
      writeLine(streams.stdout, `Running: npm install -g ${name}`);
      const result = await (env.packageInstaller ?? defaultPackageInstaller)([name])
        .catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
      if (!result.ok) {
        writeLine(streams.stderr, `Could not install: ${result.message}`);
        writeLine(streams.stderr, `Run \`npm install -g ${name}\` yourself, then re-run setup to enable it.`);
        return;
      }
      writeLine(streams.stdout, `Installed ${name}.`);
      // Enabling proceeds on npm's exit code, not a second resolve: a
      // package written into the global prefix a moment ago need not be
      // resolvable from THIS process, whose module resolution was fixed
      // when it started. The same reasoning the optional-package step
      // already uses for the dashboard.
      await enablePlugin(name);
      return;
    }

    if (!enabled) {
      const answer = await prompter.select(
        `${name} is installed but not enabled. It contributes ${setup?.grants ?? 'its own tools'}.`,
        ['Enable it', 'Back'],
      );
      if (answer.kind !== 'index' || answer.index === 1) {
        return;
      }
      await enablePlugin(name);
      return;
    }

    const current = state.plugins?.[name] ?? {};
    const actions = setup?.needs
      ? [`Change ${setup.needs.key}`, 'Disable it', 'Back']
      : ['Disable it', 'Back'];
    const answer = await prompter.select(
      `${name} is enabled.${setup?.needs && Array.isArray(current[setup.needs.key])
        ? ` ${setup.needs.key}: ${(current[setup.needs.key] as string[]).join(', ')}`
        : ''}`,
      actions,
    );
    if (answer.kind !== 'index' || answer.index === actions.length - 1) {
      return;
    }
    if (setup?.needs && answer.index === 0) {
      await enablePlugin(name);
      return;
    }
    disablePlugin(name);
  };

  /**
   * Switched off, never deleted. The loader treats `enabled: false` and an
   * absent key the same, but the operator does not: a block carries
   * `agents` overrides and `toolRisks` that setup never asked about, and
   * dropping them would be #161 again — a menu deleting config it does not
   * own, one plugin at a time instead of all four blocks at once.
   */
  const disablePlugin = (name: string): void => {
    state.plugins = {
      ...(state.plugins ?? {}),
      [name]: { ...(state.plugins?.[name] ?? {}), enabled: false },
    };
    writeLine(streams.stdout, packageInstalled(name, env)
      ? `${name} is switched off. The package is still installed, and its settings are kept for when you turn it back on.`
      : `${name} is switched off, so a daemon stops trying to load it. Its settings are kept for when you install it again.`);
  };

  const enablePlugin = async (name: string): Promise<void> => {
    const setup = PLUGIN_SETUP[name];
    const existing = state.plugins?.[name] ?? {};
    const block: PluginConfigBlock = { ...existing, enabled: true };
    // Whether the prompt below kept a per-agent value rather than writing a
    // fleet-wide one. Said after the block is checked, not before: the
    // alternative printed "keeping your per-agent roots" and then refused
    // to enable, which is two answers to one question.
    let keptPerAgent = false;

    if (setup?.needs) {
      const needsKey = setup.needs.key;
      const prior = existing[needsKey];
      const prefill = Array.isArray(prior) ? (prior as string[]).join(', ') : undefined;
      const answer = (await prompter.ask(
        setup.needs.question,
        ...(prefill !== undefined ? [{ prefill }] : []),
      )).trim();
      const values = answer.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
      if (values.length === 0) {
        // A per-agent block satisfies this on its own: the plugin resolves
        // its settings per session, so `agents.<id>.roots` with nothing at
        // the top level is a working config — and a narrower one than any
        // fleet-wide answer this prompt could take. Demanding a global
        // value here would push an operator to widen access to get past a
        // menu.
        //
        // Deleted, not merely left unwritten: `block` is a copy of the
        // existing one, so keeping the key would leave every unoverridden
        // agent on the old fleet-wide roots while the line below says
        // nothing is granted fleet-wide. Saying access narrowed while it
        // did not is the worst way for this menu to be wrong.
        //
        // Only an interactive run reaches this with a key to delete: the
        // prefill is editable on a TTY, while the piped prompter returns it
        // for an empty line. So there is no test — `setupInput` forces the
        // non-interactive path, where an empty answer means "keep" and this
        // deletes a key that was never there.
        delete block[needsKey];
        // Asked of the block as it now stands, and only of agents the
        // roster actually serves. An override left behind by a deleted
        // agent grants nobody anything: every served agent would resolve
        // an empty list and every call would fail, while this menu
        // reported the plugin enabled — the same "configured and useless"
        // state the prompt exists to prevent, reached by the branch that
        // was supposed to allow the narrow config. An unreadable roster
        // cannot answer, so it does not qualify anything either.
        const { entries, loaded } = await channelRoster();
        const coveredPerAgent = loaded
          && entries.some((entry) => pluginSettingReaches(block, needsKey, entry.soul.agent.id));
        if (!coveredPerAgent) {
          // Otherwise not written at all rather than written empty: an
          // enabled block with no roots anywhere is the exact "installed,
          // enabled, and useless" state this menu exists to keep anyone
          // from reaching by accident.
          //
          // "Left as it was" is the whole outcome, and what that means
          // differs by where the operator came from. Reaching this by
          // erasing an existing value — Change roots, prefill deleted —
          // leaves the old value in the saved config, because the return
          // is before `state.plugins` is written. Saying "it grants
          // nothing without roots" there describes a block that still has
          // roots, and an operator who meant to take access away would
          // read it as confirmation. Setup names what it kept instead, and
          // how to actually drop it, rather than dropping it on a guess:
          // an empty answer is not an unambiguous "revoke", and this menu
          // does not widen or narrow a boundary the operator did not.
          const kept = existing[needsKey];
          writeLine(streams.stdout, Array.isArray(kept) && kept.length > 0
            ? `Nothing entered, so ${name} kept the ${needsKey} it already had (${kept.join(', ')}) — setup did not remove them. Edit plugins["${name}"].${needsKey} to change what is reachable.`
            : `Nothing entered, so ${name} was left as it was — it grants nothing without ${needsKey}.`);
          return;
        }
        keptPerAgent = true;
      } else {
        block[needsKey] = values;
      }
    }

    // The block that would be *written*, not the one that was there. Asking
    // before the prompt meant `Change roots` — the action offered precisely
    // to repair a bad value — refused on the value it exists to replace,
    // and an operator had no way through this menu to fix a setting this
    // menu owns. Settings it does not own are still caught here: the
    // replacement is folded in first, and whatever remains wrong is wrong
    // in the block a daemon would be handed.
    const problem = await pluginConfigProblem(name, block);
    if (problem !== undefined) {
      writeLine(streams.stdout);
      // "was not enabled" is only true where the block was not already
      // enabled. Reached from the install action on a config that already
      // says `enabled: true`, this returns before touching `state`, so the
      // old block survives and Save writes it — a daemon then tries the
      // package it just installed and refuses it, while setup had said it
      // was not enabled. Report what is actually there, and name the way
      // out; switching it off is the operator's call, not this branch's,
      // for the same reason the roots prompt does not revoke on a blank
      // line.
      writeLine(streams.stdout, existing.enabled === false || existing.enabled === undefined
        ? `${name} was not enabled — a daemon would refuse these settings: ${problem}`
        : `${name} is still enabled in your config, and a daemon would refuse these settings: ${problem}`);
      writeLine(streams.stdout, existing.enabled === false || existing.enabled === undefined
        ? 'Fix that in your config, then enable it here. `stratus plugins` reports the same check.'
        : 'Fix that in your config, or switch the plugin off here so a daemon stops trying to load it. `stratus plugins` reports the same check.');
      return;
    }
    if (keptPerAgent && setup?.needs) {
      writeLine(streams.stdout, `Keeping the per-agent ${setup.needs.key} already configured for ${name}; nothing is granted fleet-wide.`);
    }

    state.plugins = { ...(state.plugins ?? {}), [name]: block };
    const unchecked = uncheckedReason(name);
    if (unchecked !== undefined) {
      writeLine(streams.stdout, unchecked);
    }
    await printSoulGrantLine(name);
  };

  /**
   * Who may answer a gated call while nobody is watching. The two halves
   * are one decision: `remote` with nobody to ask behaves exactly like
   * `headless` — the call parks and the timeout denies it — so the mode
   * and the approvers are set on the same screen rather than in two places
   * that can disagree.
   */
  /**
   * The daemon's own verdict, not a second version of it. Every round of
   * review on this row found the hand-written summary short a clause the
   * engine applies — headless still runs already-authorized calls, an
   * explicit `timeoutMs: 0` parks instead of denying, the control API can
   * answer for an agent Slack cannot reach. The row now takes the first
   * clause `stratus plugins` prints and the submenu carries the rest, so
   * the two can differ in length and never in fact.
   */
  const approvalsSummary = async (): Promise<string[]> => {
    const mode = state.approvals?.mode ?? 'headless';
    const { entries, loaded } = await channelRoster();
    // `headless` is a statement about the policy, not the roster, so it
    // survives a roster that will not load. Everything else here depends on
    // who is served: passing `undefined` would make `classifyApprovalReach`
    // skip the intersection and read every stored token as askable, so the
    // row would promise Slack asks for a fleet whose gateway refuses to
    // start. Same rule as the grant line and the Channels menu — an
    // unreadable roster is not evidence in either direction.
    if (mode === 'remote' && !loaded) {
      return ['remote — who can be asked is unknown until the roster loads; fix the error above, then `stratus plugins`'];
    }
    return unattendedReachParts(
      mode,
      state.approvals ?? {},
      state.channels,
      entries.map((entry) => entry.soul.agent.id),
      apiApprovalsReachable(),
      env,
    );
  };

  /** Whether a parked call could be settled through `POST /api/v1/approvals`. */
  const apiApprovalsReachable = (): boolean =>
    packageInstalled('@stratusagent/control-api', env) && state.api?.enabled !== false;

  const approvalReach = async (): Promise<ApprovalReach> => {
    const { entries, loaded } = await channelRoster();
    return classifyApprovalReach(
      state.approvals ?? {},
      state.channels,
      loaded ? entries.map((entry) => entry.soul.agent.id) : undefined,
      env,
    );
  };

  /**
   * Agents that can actually be asked: stored Slack tokens intersected with
   * the roster. A token that outlived its agent is offered nowhere — the
   * Slack adapter skips it (`no roster agent with id …`), so approvers
   * named for it configure a route no call can take. `stratus plugins`
   * learned this the same way; the Channels menu shows such tokens as
   * orphans and is the one place they are reachable, to be cleared.
   *
   * A roster that failed to load is not evidence of an orphan, so the raw
   * list stands in that case — the same posture the Channels menu takes,
   * for the same reason: acting on "no agent has this id" when the roster
   * could not say who its agents are destroys working configuration.
   */
  /**
   * Agents whose approvers this screen may edit: stored tokens intersected
   * with the roster, and deliberately *not* gated on the adapter being
   * installed.
   *
   * Reachability and editability are different questions here, and only on
   * this screen. `offerOptionalPackages()` runs inside `save()`, after the
   * menu — so on a first install the operator connects Slack under
   * Channels, opens Approvals, and the package that will be installed
   * moments later is still absent. Gating the rows on it left the fresh
   * install with nothing to configure and no way back into the menu,
   * which is the one path this whole PR exists to make work.
   *
   * The *verdict* keeps the package gate, because that is a claim about
   * what a daemon would do rather than about what may be written now.
   */
  const configurableSlackAgents = async (): Promise<string[]> => {
    const stored = Object.keys(state.channels.slack ?? {});
    const { entries, loaded } = await channelRoster();
    if (!loaded) {
      return stored;
    }
    return stored.filter((agentId) => entries.some((entry) => entry.soul.agent.id === agentId));
  };

  /**
   * Trim a menu option to one physical terminal row.
   *
   * `selectInteractive` moves the cursor up by the number of options to
   * redraw, so an option that wraps leaves the rewind short and every
   * later redraw overwrites the wrong lines. `reserved` is what the
   * caller's own prefix costs before the text starts.
   *
   * Only a TTY has a width to fit into, and piped output keeps the full
   * text — which is where nothing is redrawn, and also why none of this is
   * covered by a test: `prompter.isInteractive()` is false whenever
   * `setupInput` is set, which is every one of them.
   *
   * Every option in every menu has this constraint. Fitted here are the
   * ones this change lengthened or added; a long soul path in the Agent
   * row can still wrap, and the real fix for that is teaching
   * `selectInteractive` to count rendered rows.
   */
  const fitMenuRow = (text: string, reserved = 27): string => {
    // `process.stdout` rather than the injected stream, which is typed to
    // `write` alone — the same place `selectInteractive` reads `isTTY`
    // from, and only consulted when it is actually driving a terminal.
    const columns = prompter.isInteractive() ? process.stdout.columns : undefined;
    if (typeof columns !== 'number' || columns <= 0) {
      return text;
    }
    // The row's own prefix — `menuPrefixWidth`, plus whatever padding the
    // caller adds — subtracted from the width, so what is left is what the
    // text may occupy.
    const budget = columns - reserved;
    return text.length <= budget ? text : `${text.slice(0, Math.max(budget - 1, 0))}…`;
  };

  const chooseApprovals = async (): Promise<void> => {
    while (true) {
      const mode = state.approvals?.mode ?? 'headless';
      const connected = await configurableSlackAgents();
      // Two modes, a row per connected agent when remote, and Back.
      const reserved = menuPrefixWidth(2 + (mode === 'remote' ? connected.length : 0) + 1);
      // Static text, and still fitted: with `(current)` shown this row runs
      // to 76 columns including the selection prefix, so it clears an
      // 80-column terminal by four and wraps on anything narrower — and a
      // wrapped row corrupts every redraw, because the rewind counts
      // options rather than rendered rows. Being static is not being short.
      const options = [
        fitMenuRow(`Headless${mode === 'headless' ? ' (current)' : ''}          refuse gated calls when nobody is watching`, reserved),
        fitMenuRow(`Ask in Slack${mode === 'remote' ? ' (current)' : ''}       park the turn and ask an approver`, reserved),
      ];
      if (mode === 'remote') {
        for (const agentId of connected) {
          // The *resolved* answer, through the rule the daemon uses: an
          // agent with no override of its own inherits the top-level list,
          // and reading the override alone would report "nobody" for an
          // agent a global list already covers.
          const resolved = resolveAgentApprovals(state.approvals, agentId);
          const own = state.approvals?.agents?.[agentId]?.slackApprovers;
          const approvers = resolved.slackApprovers ?? [];
          const label = approvers.length === 0
            ? '— nobody, so its calls are denied'
            : own === undefined
              ? `${approvers.join(', ')} (inherited)`
              : approvers.join(', ');
          // Fitted like the top-level row, and for the same reason: several
          // approvers, or one long agent id, is enough to wrap — and the
          // redraw rewinds by option count, not by rendered rows. Every
          // option in every menu has this constraint; these are the ones
          // this PR adds.
          options.push(fitMenuRow(`  approvers for ${agentId}`.padEnd(26) + label
            + (approvers.length > 0 && !resolved.slackChannel ? ' · no fallback channel' : ''), reserved));
        }
      }
      options.push('Back');

      // Said here because it is only true here: tokens are stored, the
      // adapter is not installed yet, and Save is about to offer it. The
      // rows are editable regardless — the alternative was a first install
      // with nothing to configure.
      const adapterPending = connected.length > 0 && !packageInstalled('@stratusagent/channel-slack', env);
      // The whole verdict, never trimmed: a footnote is drawn once, outside
      // the redraw loop, so wrapping costs nothing here — and this is the
      // screen where the trimmed row's remainder belongs.
      const verdict = (await approvalsSummary()).join('; ');
      const footnote = adapterPending
        ? `${verdict}. @stratusagent/channel-slack is not installed yet — Save & finish offers it, and these approvers apply once it is. ${serveCommand()} brings them online.`
        : mode === 'remote' && connected.length === 0
          // The advice comes *after* the verdict, never instead of it: with
          // the control API up a parked call is already answerable, and
          // replacing the verdict here told the operator to go connect
          // Slack while the row above said the API had it. The screen that
          // changes the mode must not answer differently from the row.
          ? `${verdict}. No agent is connected to Slack, so connect one under Channels to be asked there.`
          : verdict;
      const choice = await prompter.select(
        'Approvals — what happens to a gated call with nobody watching',
        options,
        { footnote },
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }
      if (choice.index === 0) {
        state.approvals = { ...(state.approvals ?? {}), mode: 'headless' };
        continue;
      }
      if (choice.index === 1) {
        state.approvals = { ...(state.approvals ?? {}), mode: 'remote' };
        continue;
      }
      const agentId = connected[choice.index - 2];
      if (!agentId) {
        continue;
      }
      const resolved = resolveAgentApprovals(state.approvals, agentId);
      const current = resolved.slackApprovers ?? [];
      // Prefilled with the resolved list, and `ask` returns the prefill for
      // an empty line — so Enter keeps what is on screen and can never
      // revoke anything. That matters here more than elsewhere:
      // `resolveAgentApprovals` reads `agent ?? global` and an empty array
      // is not nullish, so a written `[]` is the config's way of *excluding*
      // an agent from the global list, not of leaving it alone.
      const answer = (await prompter.ask(
        `Slack user ids who may approve for ${agentId} (comma-separated, e.g. U01ABCDEF; Enter to keep): `,
        ...(current.length > 0 ? [{ prefill: current.join(', ') }] : []),
      )).trim();
      const approvers = answer.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
      const agents = { ...(state.approvals?.agents ?? {}) };
      const entry = { ...(agents[agentId] ?? {}) };
      const inheriting = state.approvals?.agents?.[agentId]?.slackApprovers === undefined;
      const unchanged = approvers.length === current.length
        && approvers.every((id, index) => id === current[index]);
      if (approvers.length === 0) {
        // An empty answer must never *widen*. With a top-level list in play
        // this writes the explicit `[]` the config reserves for excluding
        // an agent from it, because deleting the key would hand those
        // approvers an agent that had been kept from them — either one the
        // operator excluded on purpose, or one whose narrower list they
        // just erased. `[]` and an absent key differ here in exactly the
        // direction that matters, and the previous round fixed the other
        // half of this: never write `[]` over a list nobody touched.
        const globalApprovers = state.approvals?.slackApprovers ?? [];
        const hadOwn = state.approvals?.agents?.[agentId]?.slackApprovers !== undefined;
        if (globalApprovers.length > 0 || hadOwn) {
          // `[]` outlives the list it excludes from. With no top-level
          // approvers today the two look identical, but deleting the key
          // means the agent silently joins whatever list is added tomorrow
          // — so an exclusion already on disk is preserved, not tidied
          // away because it happens to be inert right now.
          entry.slackApprovers = [];
          writeLine(streams.stdout, globalApprovers.length > 0
            ? `${agentId} is excluded from the top-level approvers (${globalApprovers.join(', ')}), so nobody may approve for it and its gated calls are denied.`
            : `${agentId} has no approvers, so its gated calls are denied — and it stays excluded if a top-level list is added later.`);
        } else {
          // Never had one and nothing to inherit: an absent key is what
          // "unset" looks like, and writing `[]` would invent an exclusion
          // the operator never asked for.
          delete entry.slackApprovers;
        }
      } else if (inheriting && unchanged) {
        // Keeping an inherited list must not freeze it: writing the same ids
        // as this agent's own override would look identical today and stop
        // tracking the top-level list the operator edits tomorrow.
        writeLine(streams.stdout, `${agentId} still inherits the top-level approvers (${current.join(', ')}).`);
      } else {
        entry.slackApprovers = approvers;
      }

      if (entry.slackApprovers !== undefined || resolved.slackApprovers !== undefined) {
        // The other half of a working route, and the half a fresh install
        // has no way to guess it needs. A turn that arrived through Slack
        // is answered in its own thread, but one from a schedule, a
        // delegation or the control API reaches the adapter with no
        // destination and is denied undeliverable — so approvers alone
        // configure approvals for exactly the calls least likely to need
        // them. `stratus plugins` reports this state; better not to create
        // it here in the first place.
        // "Enter to skip" is only true with nothing prefilled. `ask` returns
        // the prefill for an empty line, so where a channel already resolves
        // Enter *keeps* it — an operator told otherwise would believe they
        // had removed a fallback that goes on receiving approval details.
        // The same correction the approvers prompt above already carries.
        //
        // What clearing the line does, though, is decided by whether this
        // agent *owns* the channel, not by whether one resolves: clearing
        // an inherited one deletes a key that was never there and the
        // global goes on resolving. Reading the offer off the resolved
        // value promised a removal the branch below then refuses — the
        // prompt and its own outcome disagreeing about the same keypress.
        const ownChannel = state.approvals?.agents?.[agentId]?.slackChannel;
        const globalChannel = state.approvals?.slackChannel;
        const hasChannel = resolved.slackChannel !== undefined;
        const channelOffer = ownChannel !== undefined
          ? (globalChannel !== undefined
            ? `(Enter to keep it; clear the line to fall back to the top-level ${globalChannel}): `
            : '(Enter to keep it; clear the line to remove it): ')
          : hasChannel
            ? '(Enter to go on inheriting it; type another to give this agent its own): '
            : '(e.g. C0123456, Enter to skip): ';
        const channelAnswer = (await prompter.ask(
          `Which Slack channel should ${agentId} ask in when the turn did not start in Slack? ${channelOffer}`,
          ...(hasChannel ? [{ prefill: resolved.slackChannel as string }] : []),
        )).trim();
        // The same inheritance trap as the approvers above, one field over:
        // the prompt is prefilled with the resolved value, so keeping an
        // inherited channel would write it as this agent's own and stop it
        // tracking the top-level one. Both fields need the guard; fixing
        // only the one under review is how this arrived here twice.
        const inheritsChannel = ownChannel === undefined;
        if (channelAnswer.length > 0 && inheritsChannel && channelAnswer === resolved.slackChannel) {
          writeLine(streams.stdout, `${agentId} still inherits the top-level fallback channel (${channelAnswer}).`);
        } else if (channelAnswer.length > 0) {
          entry.slackChannel = channelAnswer;
        } else if (resolved.slackChannel !== undefined) {
          // Blanked deliberately: an editable prefill makes this reachable.
          // What it can mean depends on whether a top-level channel exists,
          // and only one of the two is "no fallback" — clearing the
          // override otherwise moves the agent onto the global channel,
          // which is a different, possibly wider place to post approval
          // details. Setup says which happened rather than assuming.
          //
          // Untested for the same reason the roots deletion above is: an
          // empty answer where a prefill exists is a TTY-only path, since
          // the piped prompter returns `line || prefill` and `setupInput`
          // forces it.
          delete entry.slackChannel;
          writeLine(streams.stdout, globalChannel !== undefined
            ? `${agentId} ${inheritsChannel ? 'still uses' : 'now uses'} the top-level fallback channel (${globalChannel})${inheritsChannel ? '' : ' instead of its own'}. Setup cannot turn the fallback off for one agent — remove approvals.slackChannel to drop it for everyone.`
            : `${agentId} has no fallback channel now: only turns already in Slack can be asked.`);
        } else {
          writeLine(streams.stdout, `No fallback channel for ${agentId}: only turns already in Slack can be asked, and a scheduled or API-started call is denied undeliverable.`);
        }
      }

      agents[agentId] = entry;
      state.approvals = { ...(state.approvals ?? {}), mode: 'remote', agents };
    }
  };

  const chooseChannels = async (): Promise<void> => {
    while (true) {
      const { entries: roster, loaded: rosterLoaded } = await channelRoster();
      const slack = state.channels.slack ?? {};

      // The roster always holds at least the built-in agent, so there is
      // no empty state to short-circuit on — and short-circuiting would
      // strand orphaned tokens, which are only reachable from this list.
      const options = roster.map((entry) => {
        const id = entry.soul.agent.id;
        const status = slack[id] ? '✓ connected' : '— not connected';
        return `${entry.soul.agent.name} (${id})`.padEnd(34) + status;
      });
      // Orphans: tokens whose agent left the roster would otherwise be
      // invisible here while still being loaded by `stratus serve`.
      //
      // Only when the roster actually loaded. "No agent has this id" is a
      // claim about the roster, and a roster that refused to load cannot
      // support it — every stored token would look orphaned, and this list
      // offers to DELETE them. Losing a working agent's Slack credentials
      // because a different pair of files collided is a far worse outcome
      // than leaving a real orphan on screen for one run.
      const orphans = rosterLoaded
        ? Object.keys(slack).filter((id) => !roster.some((entry) => entry.soul.agent.id === id))
        : [];
      if (!rosterLoaded) {
        writeLine(
          streams.stderr,
          'Warning: no agents are offered while the roster is unreadable — the daemon cannot start either. Fix the roster first.',
        );
      }
      for (const id of orphans) {
        options.push(`${id}`.padEnd(34) + '! tokens without a matching agent');
      }
      options.push('Back');

      const choice = await prompter.select(
        'Channels — Slack (one app per agent: its own name, avatar, and presence)',
        options,
        { footnote: `Run \`${serveCommand()}\` afterwards to bring the connected agents online.` },
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }

      if (choice.index >= roster.length) {
        // An orphaned entry — offer to clear it.
        const orphanId = orphans[choice.index - roster.length];
        if (!orphanId) {
          return;
        }
        const confirm = await prompter.select(`No agent with id ${orphanId} is in the roster.`, [
          'Remove these Slack tokens',
          'Keep them',
        ]);
        if (confirm.kind === 'index' && confirm.index === 0) {
          const next = { ...slack };
          delete next[orphanId];
          state.channels = { ...state.channels, slack: next };
          state.channelsDirty = true;
          writeLine(streams.stdout, `Removed the Slack tokens for ${orphanId}.`);
        }
        continue;
      }

      const entry = roster[choice.index];
      if (!entry) {
        return;
      }
      const agentId = entry.soul.agent.id;
      const agentName = entry.soul.agent.name;

      if (!slack[agentId]) {
        await connectSlackAgent(agentId, agentName);
        continue;
      }

      const action = await prompter.select(`${agentName} is connected to Slack.`, [
        'Replace the tokens (re-run the app setup)',
        'Disconnect from Slack (forget the tokens)',
        'Back',
      ]);
      if (action.kind !== 'index' || action.index === 2) {
        continue;
      }
      if (action.index === 0) {
        await connectSlackAgent(agentId, agentName);
        continue;
      }
      const next = { ...slack };
      delete next[agentId];
      state.channels = { ...state.channels, slack: next };
      state.channelsDirty = true;
      writeLine(streams.stdout, `${agentName} is no longer connected to Slack. The Slack app itself still exists — delete it at api.slack.com/apps if you are done with it.`);
    }
  };

  const testRun = async (): Promise<void> => {
    const runtime = await buildTestRuntime();
    if (!runtime) {
      return;
    }
    writeLine(streams.stdout, `Running a quick hello (${formatRuntimeBanner(runtime).replace('Starting Stratus Agent local loop with ', '')})…`);
    try {
      const session = await runSingleLoop(
        'Say hello and introduce yourself in one short sentence.',
        streams,
        { events: false, runtime, env },
      );
      printSessionSummary(session, streams);
      writeLine(streams.stdout);
      if (prompter.isInteractive()) {
        await prompter.ask('Press Enter to return to the menu… ');
        recentNotices.length = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLine(streams.stdout, `Test run failed: ${message}`);
      if (runtime.provider === 'anthropic' && runtime.authToken && /Claude Code|\b(401|403|429)\b/.test(message)) {
        writeLine(streams.stdout, 'Subscription runs go through Claude Code. Make sure it is installed (npm install -g @anthropic-ai/claude-code) and signed in (run `claude`), or sign in with an Anthropic API key instead (Providers menu → Claude → API key).');
      } else if (/\b429\b/.test(message)) {
        writeLine(streams.stdout, 'A 429 means the provider rate-limited the request. On a new Anthropic account this usually means no purchased credits yet — check console.anthropic.com → Billing and Limits, then try again.');
      } else if (/\b(401|403)\b/.test(message)) {
        writeLine(streams.stdout, 'The provider rejected the credential — re-run sign-in from the Providers menu.');
      }
    }
  };

  const detectEnvOverride = (
    primary: string,
    chosen: string,
    flagName?: string,
  ): { envVar: string; envValue: string; flag?: string } | undefined => {
    if (!readNonEmptyString(processEnv[primary])) {
      return undefined;
    }
    const envValue = String(processEnv[primary]).trim();
    if (envValue === chosen) {
      return undefined;
    }
    return {
      envVar: primary,
      envValue,
      ...(flagName ? { flag: `${flagName} ${quoteShellArg(chosen)}` } : {}),
    };
  };

  /**
   * An optional package this setup's own choices imply, and why. Setup knows
   * both facts before the daemon does — that Slack tokens were just stored,
   * and that it is about to recommend `stratus dashboard` — so it is the one
   * place that can offer the install rather than leave the gap to be found
   * in a log after the fact.
   */
  interface PackageGroup {
    id: 'slack' | 'dashboard';
    label: string;
    why: string;
    packages: string[];
  }

  /**
   * Whether `stratus dashboard` can work. Read before the offer and set by
   * it, so the closing suggestions never name a command this machine cannot
   * run — the failure that sends someone to the logs to find out why.
   */
  let dashboardReady = packageInstalled('@stratusagent/control-api', env)
    && packageInstalled('@stratusagent/dashboard', env);

  const missingPackageGroups = (): PackageGroup[] => {
    const groups: PackageGroup[] = [];
    const slackAgents = Object.keys(state.channels.slack ?? {}).length;
    if (slackAgents > 0 && !packageInstalled('@stratusagent/channel-slack', env)) {
      groups.push({
        id: 'slack',
        label: 'Slack channel',
        why: `Slack tokens are stored for ${slackAgents} agent(s), but nothing connects to Slack without it`,
        packages: ['@stratusagent/channel-slack'],
      });
    }
    // Both, because the dashboard is what was offered: the control API is
    // the port and the dashboard is the page served on it. Only the missing
    // half is installed, so accepting this on a machine that already has
    // the API does not reinstall it.
    const dashboardPackages = ['@stratusagent/control-api', '@stratusagent/dashboard']
      .filter((name) => !packageInstalled(name, env));
    if (dashboardPackages.length > 0) {
      groups.push({
        id: 'dashboard',
        label: 'Web dashboard',
        why: '`stratus dashboard` needs it, and it opens an authenticated port on 127.0.0.1',
        packages: dashboardPackages,
      });
    }
    return groups;
  };

  /**
   * Offers the packages above. Declining is a real answer and prints the
   * command; the control API in particular binds a port, and installing it
   * is how an operator says they want one open, so this asks rather than
   * deciding for them.
   */
  const offerOptionalPackages = async (): Promise<void> => {
    const groups = missingPackageGroups();
    if (groups.length === 0) {
      return;
    }
    writeLine(streams.stdout);
    writeLine(streams.stdout, groups.length === 1
      ? 'One optional package is not installed:'
      : `${groups.length} optional packages are not installed:`);
    for (const group of groups) {
      writeLine(streams.stdout, `  ${group.packages.join(' ')}`);
      writeLine(streams.stdout, `    ${group.why}.`);
    }

    const answer = await prompter.select('Install now with npm install -g?', groups.length === 1
      ? ['Install it now', 'Skip']
      : ['Install all of them now', ...groups.map((group) => `Install the ${group.label} only`), 'Skip']);

    const chosen = ((): PackageGroup[] => {
      if (answer.kind !== 'index') {
        return [];
      }
      if (groups.length === 1) {
        return answer.index === 0 ? groups : [];
      }
      if (answer.index === 0) {
        return groups;
      }
      const only = groups[answer.index - 1];
      return only ? [only] : [];
    })();

    // Held before the install rather than derived after it: picking one
    // group is not a decision about the other, and the daemon starts a few
    // lines below and warns about exactly what is still missing — the
    // notice this whole offer exists to pre-empt.
    const declined = groups.filter((group) => !chosen.includes(group));

    if (chosen.length > 0) {
      const packages = chosen.flatMap((group) => group.packages);
      writeLine(streams.stdout, `Running: npm install -g ${packages.join(' ')}`);
      // Never fails setup — not even its exit code, unlike the always-on
      // service step below: the config and credentials are already written,
      // and a package that did not install is a warning at the next start,
      // not a broken machine.
      const result = await (env.packageInstaller ?? defaultPackageInstaller)(packages)
        .catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
      if (result.ok) {
        writeLine(streams.stdout, `Installed ${packages.join(' ')}.`);
        // npm's exit code, not a second resolve: a package written into the
        // global prefix a moment ago need not be resolvable from THIS
        // process, whose module resolution was fixed when it started.
        if (chosen.some((group) => group.id === 'dashboard')) {
          dashboardReady = true;
        }
      } else {
        writeLine(streams.stderr, `Could not install: ${result.message}`);
        writeLine(streams.stderr, `Setup is saved either way — run \`npm install -g ${packages.join(' ')}\` yourself.`);
      }
    }

    if (declined.length > 0) {
      const rest = declined.flatMap((group) => group.packages).join(' ');
      writeLine(streams.stdout, chosen.length > 0
        ? `Still missing. Install with: npm install -g ${rest}`
        : `Skipped. Install them yourself with: npm install -g ${rest}`);
    }
  };

  /**
   * Write everything the menu decided, then report whether the always-on
   * service step it performed — installing the service, or removing one the
   * user chose not to run — succeeded.
   *
   * A boolean rather than a throw: the service is the one optional part of
   * setup and everything else is already on disk by the time it runs, so
   * failing outright would lose the saved config to a service that can be
   * installed (or removed) later. The exit code carries it instead — the
   * same answer `stratus service install` and `stratus service uninstall`
   * give for the identical failure, which is what a script driving setup
   * has to be able to see.
   */
  const save = async (): Promise<boolean> => {
    // The always-on service step is the only one here that can fail without
    // taking the rest of setup with it, so it is the only one the exit code
    // has to carry. Both signs count: a unit left in place after "do not run
    // it for me" starts a daemon at login the user asked not to have, which
    // is no more a successful setup than one that will not come up at all.
    let serviceStepFailed = false;
    // Typed as the file rather than as a bag of scalars: the carried blocks
    // below are objects, and a `Record<string, string | boolean>` was what
    // made dropping them the path of least resistance.
    const config: CliConfigFile = { provider: state.provider };
    if (state.provider !== 'demo') {
      config.model = state.model ?? defaultModelFor(state.provider);
    }
    if (state.provider === 'openai') {
      config.baseUrl = state.baseUrl ?? state.credentials.openai?.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
    } else if (state.provider === 'anthropic' && state.baseUrl) {
      // A configured anthropic endpoint (a proxy) must survive re-running
      // setup, or runs silently revert to the official endpoint.
      config.baseUrl = state.baseUrl;
    }
    if (state.apiKeyEnv) {
      config.apiKeyEnv = state.apiKeyEnv;
    }
    if (state.systemPrompt) {
      config.systemPrompt = state.systemPrompt;
    }
    if (state.soulPath) {
      config.soul = state.soulPath;
    }
    if (state.provider !== 'demo' && state.fallbackModel) {
      config.fallbackModel = state.fallbackModel;
      config.fallbackProvider = state.fallbackProvider ?? state.provider;
      if (config.fallbackProvider === 'openai' && state.fallbackBaseUrl) {
        config.fallbackBaseUrl = state.fallbackBaseUrl;
      }
    }
    if (state.vision !== undefined) {
      config.vision = state.vision;
    }
    if (state.promptCache !== undefined) {
      config.promptCache = state.promptCache;
    }
    if (state.promptCacheTtl !== undefined) {
      config.promptCacheTtl = state.promptCacheTtl;
    }
    // `plugins` and `approvals` have menus above; `api` and `principals`
    // do not and are written back exactly as they were read. Both cases
    // land here the same way, because the menus edit this state rather
    // than the file — so there is nothing to merge, only to not lose.
    if (state.plugins !== undefined) {
      config.plugins = state.plugins;
    }
    if (state.approvals !== undefined) {
      config.approvals = state.approvals;
    }
    if (state.api !== undefined) {
      config.api = state.api;
    }
    if (state.principals !== undefined) {
      config.principals = state.principals;
    }

    await saveConfigFile(configPath, config);

    writeLine(streams.stdout);
    writeLine(streams.stdout, `Wrote ${configPath}`);

    // A project-local config in this directory outranks the global file for
    // bare runs started here — say so, and make the suggested command pick
    // the file that was just written.
    if (configPath === globalConfigPath(env)) {
      const shadowPath = path.join(cwd, DEFAULT_CONFIG_FILENAME);
      try {
        await readFile(shadowPath, 'utf8');
        writeLine(streams.stdout, `Note: ${shadowPath} exists and takes precedence over the global config for runs started in this directory.`);
        writeLine(streams.stdout, 'The suggested commands below include --config so they use what you just saved.');
        shadowConfigFlag = ` --config ${quoteShellArg(configPath)}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    if (state.credentialsDirty) {
      await saveCredentials(env, state.credentials);
      writeLine(streams.stdout, `Saved your sign-in to ${credentialsPath(env)} (readable only by you).`);
    }
    if (state.channelsDirty) {
      // Channel tokens live in their own namespace of the same file; the
      // writers merge, so this never clobbers the provider sign-in above.
      await saveChannelCredentials(env, state.channels);
      const connected = Object.keys(state.channels.slack ?? {}).length;
      writeLine(streams.stdout, connected > 0
        ? `Saved Slack tokens for ${connected} agent${connected === 1 ? '' : 's'} to ${credentialsPath(env)} — run \`${serveCommand()}\` to bring them online.`
        : `Removed the stored Slack tokens from ${credentialsPath(env)}.`);
    }

    // Before the service block below, deliberately. A package installed
    // after the daemon starts is invisible to it — installing does not
    // reload a running process — so offering here is what makes the
    // LaunchAgent come up with the Slack channel and the control API
    // already present, instead of warning about them in a log nobody reads
    // until the dashboard fails.
    await offerOptionalPackages();

    // Last, so the daemon starts against the config and credentials that
    // were just written rather than the ones it would have found a moment
    // ago. A service failure is reported and never fails setup: the
    // settings are already saved, and `stratus serve` still works by hand.
    if (!state.service.install && servicePlatform(serviceEnvFor(env))) {
      // Opting out has to actually take effect. Skipping the install would
      // leave a unit from an earlier setup running and enabled at login,
      // while the menu said "off" — still burning provider usage and still
      // answering in Slack after an explicit opt-out.
      const existing = await readServiceStatus(serviceEnvFor(env)).catch(() => undefined);
      if (existing?.installed) {
        // Removal deletes the unit file, so it can reject the same way the
        // install can. Setup's settings are already written by this point;
        // the optional service must not take the whole command down.
        const removed = await uninstallService(serviceEnvFor(env)).catch((error: unknown) => ({
          ok: false,
          messages: [
            `Could not remove the always-on service: ${error instanceof Error ? error.message : String(error)}`,
            `${serviceUnitPath(serviceEnvFor(env))} is still in place — remove it by hand, or it will start again at login.`,
          ],
        }));
        for (const message of removed.messages) {
          writeLine(removed.ok ? streams.stdout : streams.stderr, message);
        }
        if (!removed.ok) {
          serviceStepFailed = true;
        }
      }
    } else if (state.service.install && servicePlatform(serviceEnvFor(env))) {
      // The unit is pinned to the file setup just wrote. Its working
      // directory is the home directory, so discovery from there would
      // find a different config whenever setup was run with --config or
      // STRATUS_CONFIG — the daemon would come up on another roster and
      // leave the Slack apps configured above offline.
      // installService writes files, so it can reject outright — an
      // inaccessible ~/Library/LaunchAgents, a read-only home. Letting
      // that escape would fail setup itself, after the config and
      // credentials were already saved, when the always-on service is the
      // one optional part of it.
      const result = await installService(serviceEnvFor(env), {
        runAtLogin: state.service.runAtLogin,
        configPath,
      }).catch((error: unknown) => ({
        ok: false,
        messages: [`Could not install the always-on service: ${error instanceof Error ? error.message : String(error)}`],
      }));
      for (const message of result.messages) {
        writeLine(result.ok ? streams.stdout : streams.stderr, message);
      }
      if (!result.ok) {
        writeLine(streams.stderr, `Setup is saved either way — start the daemon yourself with \`${serveCommand()}\`.`);
        serviceStepFailed = true;
      }
    }
    writeLine(streams.stdout);

    // Exported STRATUS_* variables outrank the config file, so warn when one
    // would make `stratus run` behave differently from what was just saved.
    const conflicts = [
      detectEnvOverride('STRATUS_PROVIDER', state.provider, '--provider'),
      ...(state.provider !== 'demo'
        ? [detectEnvOverride('STRATUS_MODEL', state.model ?? defaultModelFor(state.provider), '--model')]
        : []),
      ...(state.provider === 'openai'
        ? [detectEnvOverride('STRATUS_BASE_URL', state.baseUrl ?? DEFAULT_OPENAI_BASE_URL, '--base-url')]
        : [detectEnvOverride('STRATUS_BASE_URL', '')]),
      detectEnvOverride('STRATUS_SYSTEM_PROMPT', state.systemPrompt ?? ''),
    ].filter((conflict) => conflict !== undefined);

    for (const conflict of conflicts) {
      writeLine(
        streams.stdout,
        `Note: ${conflict.envVar}=${conflict.envValue} is exported and takes precedence over the config file (run \`unset ${conflict.envVar}\` to clear it).`,
      );
    }
    if (conflicts.some((conflict) => conflict.flag)) {
      writeLine(streams.stdout, 'The suggested commands below include flags so they use what you just configured.');
    }
    if (conflicts.length > 0) {
      writeLine(streams.stdout);
    }
    const extraFlags = conflicts.flatMap((conflict) => (conflict.flag ? [` ${conflict.flag}`] : [])).join('');

    if (state.provider === 'demo') {
      writeLine(streams.stdout, 'You are ready to go — no account needed. Try:');
    } else if (readNonEmptyString(processEnv.STRATUS_API_KEY)) {
      writeLine(streams.stdout, 'STRATUS_API_KEY is exported and takes precedence over your saved sign-in. You are ready to go. Try:');
    } else if (state.credentials[state.provider]) {
      writeLine(streams.stdout, `You are ${signInSummary()} — ready to go. Try:`);
    } else {
      const keyEnv = state.apiKeyEnv ?? defaultKeyEnvFor(state.provider);
      if (readNonEmptyString(processEnv[keyEnv])) {
        writeLine(streams.stdout, `${keyEnv} is set in your environment — you are ready to go. Try:`);
      } else {
        writeLine(streams.stdout, 'You are NOT signed in yet — re-run `stratus setup` and pick option 1, or:');
        writeLine(streams.stdout, `  export ${keyEnv}=your-key`);
        writeLine(streams.stdout);
        writeLine(streams.stdout, 'Then try:');
      }
    }
    writeLine(streams.stdout, `  stratus run${extraFlags}${runConfigFlag}${shadowConfigFlag} "say hello"`);
    if (dashboardReady) {
      writeLine(streams.stdout, '  stratus dashboard');
    }
    return !serviceStepFailed;
  };

  try {
    if (!interactive) {
      writeLine(streams.stdout, 'Stratus Agent setup');
      writeLine(streams.stdout, 'Pick a provider, sign in, and create your agent — all from this menu.');
    }
    if (envConfigVar && !command.configPath) {
      writeLine(streams.stdout, `${envConfigVar} is set, so the config will be written to ${configPath}.`);
    }

    while (true) {
      writeLine(streams.stdout);
      // Awaited before the menu is drawn: the approvals summary reads the
      // roster, to intersect stored Slack tokens with agents that exist.
      // Every clause, not the first: a prefix of this sentence has been
      // wrong twice — the mixed roster where Slack denies one agent and the
      // control API answers for another reads as a flat denial without the
      // clause that follows. So the row carries what `stratus plugins`
      // prints, and where it cannot fit it is *visibly* cut rather than
      // silently shortened: an ellipsis says there is more, which a chosen
      // prefix never did. The Approvals screen has the whole thing.
      //
      // Cut at all only because `selectInteractive` rewinds the cursor by
      // `options.length`, one physical row per option — a wrapped row
      // corrupts every redraw after the first arrow key. Wrapping is not
      // the cosmetic cost I took it for when I let this line grow.
      const approvals = fitMenuRow((await approvalsSummary()).join('; '));
      const choice = await prompter.select('', [
        `Providers            ${providersSummary()}`,
        `Models               ${modelsSummary()}`,
        `Agent                ${agentSummary()}`,
        `Plugins              ${fitMenuRow(pluginsSummary())}`,
        `Channels             ${channelsSummary()}`,
        `Approvals            ${approvals}`,
        `Always on            ${serviceSummary()}`,
        'Test run             say hello with the current settings',
        'Save & finish',
      ]);

      // Backing out of the top level (Esc, or the input ending) saves.
      if (choice.kind !== 'index' || choice.index === 8) {
        break;
      }

      if (choice.index === 0) {
        await chooseProviders();
      } else if (choice.index === 1) {
        await chooseModels();
      } else if (choice.index === 2) {
        await chooseAgent();
      } else if (choice.index === 3) {
        await choosePlugins();
      } else if (choice.index === 4) {
        await chooseChannels();
      } else if (choice.index === 5) {
        await chooseApprovals();
      } else if (choice.index === 6) {
        await chooseService();
      } else if (choice.index === 7) {
        await testRun();
      }
    }

    // Non-zero when the always-on service step failed, matching `stratus
    // service install` and `stratus service uninstall`. Everything setup
    // saved is still saved, and the output above says so — but a daemon that
    // will not come up at login, or one that will after the user said not to
    // run it, is not a successful setup, and a script that only reads the
    // exit code had no way to tell.
    return (await save()) ? 0 : 1;
  } finally {
    prompter.close();
  }
};
