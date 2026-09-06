import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  saveChannelCredentials,
  saveConfigFile,
  saveCredentials,
  CREDENTIAL_PROVIDER_NAMES,
  verifyProviderKey,
  type CatalogModel,
  type ChannelCredentials,
  type CredentialProviderName,
  type CredentialsFile,
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
import { serviceEnvFor } from '../daemon.ts';
import type { CliStreams, CliEnvironment, CliConfigFile } from '../environment.ts';
import { writeLine } from '../io.ts';
import { packageInstalled } from '../loaders.ts';
import { defaultPackageInstaller } from '../npm.ts';
import type { CliProviderName, ParsedSetupCommand } from '../parse.ts';
import { quoteShellArg, stratusHeaderLines, createSetupPrompter } from '../prompter.ts';
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
    const config: Record<string, string> = { provider: state.provider };
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
      const choice = await prompter.select('', [
        `Providers            ${providersSummary()}`,
        `Models               ${modelsSummary()}`,
        `Agent                ${agentSummary()}`,
        `Channels             ${channelsSummary()}`,
        `Always on            ${serviceSummary()}`,
        'Test run             say hello with the current settings',
        'Save & finish',
      ]);

      // Backing out of the top level (Esc, or the input ending) saves.
      if (choice.kind !== 'index' || choice.index === 6) {
        break;
      }

      if (choice.index === 0) {
        await chooseProviders();
      } else if (choice.index === 1) {
        await chooseModels();
      } else if (choice.index === 2) {
        await chooseAgent();
      } else if (choice.index === 3) {
        await chooseChannels();
      } else if (choice.index === 4) {
        await chooseService();
      } else if (choice.index === 5) {
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
