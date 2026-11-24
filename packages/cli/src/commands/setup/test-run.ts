/*
 * The Test run menu item of `stratus setup`: builds a runtime from the
 * settings so far and says hello with it. Moved out of `runSetup` in
 * setup.ts as is: the statements are unchanged, inside a factory that takes
 * the values they closed over there, and `runSetup` destructures what it
 * returns.
 */

import { installProviderPackages, uninstalledProviderPackages } from '../../provider-packages.ts';
import { readFile } from 'node:fs/promises';
import { parseSoul, type ParsedSoul } from '@stratusagent/agents';
import {
  DEFAULT_OPENAI_BASE_URL,
  chatgptSignInLocation,
  hasChatGPTSignIn,
  isRegisteredProviderName,
  openChatGPTSignInFile,
  languageFor,
  readNonEmptyString,
  type CredentialProviderName,
  type FallbackRuntime,
  type RuntimeConfig,
} from '@stratusagent/state';
import { writeLine } from '../../io.ts';
import { runSingleLoop, printSessionSummary, formatRuntimeBanner } from '../../runtime.ts';
import type { SetupBase } from './context.ts';
import type { ProviderSetup } from './providers.ts';

export const createTestRunSetup = ({
  state,
  processEnv,
  streams,
  env,
  prompter,
  recentNotices,
  defaultKeyEnvFor,
  credentialProviderOf,
  builtInDefaultModel,
}: Pick<SetupBase, 'state' | 'processEnv' | 'streams' | 'env' | 'prompter' | 'recentNotices'> & Pick<ProviderSetup, 'defaultKeyEnvFor' | 'credentialProviderOf' | 'builtInDefaultModel'>) => {
  // Mirror the saved config's fallback so option 4 exercises the same
  // failover a real run would perform.
  // Whether the install's ChatGPT sign-in can serve a run, as
  // resolveRuntimeConfig asks it; a file that can't be read can't.
  const chatgptSignedIn = (): Promise<boolean> =>
    hasChatGPTSignIn(openChatGPTSignInFile(chatgptSignInLocation(env))).catch(() => false);

  const buildTestFallback = async (soul?: ParsedSoul): Promise<FallbackRuntime | undefined> => {
    if (!state.fallbackModel || state.provider === 'demo') {
      return undefined;
    }
    const selectedFallback = state.fallbackProvider ?? state.provider;
    if (isRegisteredProviderName(selectedFallback)) {
      // A contributed fallback brings its own sign-in, as a contributed
      // primary does; the test run selects it by name and no more.
      return { provider: selectedFallback, model: state.fallbackModel };
    }
    if (selectedFallback === 'chatgpt') {
      // Its own sign-in file, and skipped without one, as a real run does.
      return await chatgptSignedIn()
        ? { provider: 'chatgpt', model: state.fallbackModel, signIn: chatgptSignInLocation(env) }
        : undefined;
    }
    const fallbackProvider = selectedFallback as CredentialProviderName;
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
      // The agent's effort follows it onto an Anthropic fallback, as
      // resolveRuntimeConfig does.
      ...(fallbackProvider === 'anthropic' && soul?.effort ? { effort: soul.effort } : {}),
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

  // The language the saved config would run in, soul over config, carried
  // onto whichever variant the test run builds: it is part of what the
  // quick hello is there to exercise.
  const buildTestRuntime = async (): Promise<RuntimeConfig | undefined> => {
    const runtime = await buildTestRuntimeVariant();
    const language = runtime ? languageFor(runtime.soul, state) : undefined;
    return runtime && language !== undefined ? { ...runtime, language } : runtime;
  };

  const buildTestRuntimeVariant = async (): Promise<RuntimeConfig | undefined> => {
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
    const storedFor = credentialProviderOf(state.provider);
    const credential = envKey || storedFor === undefined ? undefined : state.credentials[storedFor];
    const boundUrl = credential?.type === 'api_key' ? credential.baseUrl : undefined;

    if (isRegisteredProviderName(state.provider)) {
      // A contributed provider brings its own sign-in and its own default
      // model; the test run selects it and no more, exactly as a real run
      // resolves it — the configured fallback included, so the test
      // exercises the failover the saved config would perform.
      const fallback = await buildTestFallback(soul);
      return {
        provider: state.provider,
        ...(state.model ? { model: state.model } : {}),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }
    const model = state.model ?? builtInDefaultModel(state.provider);

    if (state.provider === 'chatgpt') {
      // Tested on the sign-in the file holds, which Providers > ChatGPT
      // saves (or an earlier setup did). A base URL refuses
      // the test as resolveRuntimeConfig refuses the run: the sign-in goes
      // only to OpenAI.
      const namedBaseUrl = readNonEmptyString(processEnv.STRATUS_BASE_URL) ?? state.baseUrl;
      if (namedBaseUrl !== undefined) {
        writeLine(streams.stdout, `provider=chatgpt does not use a custom base URL, so a run with ${namedBaseUrl} is refused. Remove the base URL to test it.`);
        return undefined;
      }
      if (!await chatgptSignedIn()) {
        writeLine(streams.stdout, 'You are not signed in with ChatGPT on this install, so there is nothing to test yet.');
        return undefined;
      }
      const fallback = await buildTestFallback(soul);
      return {
        provider: 'chatgpt',
        model,
        signIn: chatgptSignInLocation(env),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }

    if (state.provider === 'anthropic') {
      const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
      const authToken = credential?.type === 'oauth_token' ? credential.value : undefined;
      if (!apiKey && !authToken) {
        writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export ANTHROPIC_API_KEY).');
        return undefined;
      }
      const fallback = await buildTestFallback(soul);
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
        // The hello runs at the effort the agent's real turns use, as
        // resolveRuntimeConfig sets it from the soul.
        ...(soul?.effort ? { effort: soul.effort } : {}),
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
      const fallback = await buildTestFallback(soul);
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
    const fallback = await buildTestFallback(soul);
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

  const testRun = async (): Promise<void> => {
    const runtime = await buildTestRuntime();
    if (!runtime) {
      return;
    }
    // The CLI carries no provider package, and this row comes before Save,
    // which installs the one picked. Without this, the first hello on a
    // fresh install failed on the missing package and told someone already
    // in setup to choose the provider again in setup. Installed the way
    // Save does it, without a question: choosing the provider was the
    // decision. A failed install has already said so, with the command.
    if (!(await installProviderPackages(uninstalledProviderPackages([runtime], env), streams, env))) {
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

  return { testRun };
};

export type TestRunSetup = ReturnType<typeof createTestRunSetup>;
