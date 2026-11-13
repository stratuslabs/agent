/*
 * The Providers and Models menus of `stratus setup`: provider sign-in, the
 * default provider, and the default and fallback models. Moved out of
 * `runSetup` in setup.ts as is: the statements are unchanged, inside a
 * factory that takes the values they closed over there, and `runSetup`
 * destructures what it returns.
 */

import { readFile } from 'node:fs/promises';
import { parseSoul } from '@stratusagent/agents';
import {
  CHATGPT_SIGN_IN_TIMEOUT_MS,
  chatgptSignInLocation,
  chatgptSignInStatus,
  collectAvailableModels as collectModels,
  defaultApiKeyEnvName,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  defaultModelFor as builtInModelDefault,
  hasChatGPTSignIn,
  isRegisteredProviderName,
  openChatGPTSignInFile,
  PROVIDER_PACKAGE_NAMES,
  readNonEmptyString,
  registeredProviderNameOf,
  runChatGPTSignIn,
  runChatGPTSignOut,
  type BuiltinProviderName,
  CREDENTIAL_PROVIDER_NAMES,
  verifyProviderKey,
  type CatalogModel,
  type CredentialProviderName,
  type StoredCredential,
  withoutTrailingSlashes,
} from '@stratusagent/state';
import { writeLine } from '../../io.ts';
import { packageInstalled } from '../../loaders.ts';
import type { CliProviderName } from '../../parse.ts';
import { installProviderPackages } from '../../provider-packages.ts';
import { openExternalUrl } from '../dashboard.ts';
import type { SetupBase } from './context.ts';

export const createProviderSetup = ({
  state,
  processEnv,
  prompter,
  streams,
  env,
}: Pick<SetupBase, 'state' | 'processEnv' | 'prompter' | 'streams' | 'env'>) => {
  // The demo model has none of its own; setup names Anthropic's for it,
  // as it always has.
  const builtInDefaultModel = (provider: BuiltinProviderName): string =>
    builtInModelDefault(provider === 'demo' ? 'anthropic' : provider);

  // A contributed provider's default is its own, so setup has none to
  // name for it — and none to write into a config or a soul.
  const defaultModelFor = (provider: CliProviderName): string | undefined =>
    isRegisteredProviderName(provider) ? undefined : builtInDefaultModel(provider);

  // Widened to CliProviderName only so setup can ask about the provider it
  // currently has selected, `demo` included; the rule itself is the shared one.
  const defaultKeyEnvFor = (provider: CliProviderName): string =>
    defaultApiKeyEnvName(credentialProviderOf(provider) ?? 'anthropic');

  /**
   * The sign-in a selection is stored under, or nothing: the demo provider
   * has none, and a provider a plugin registered brings its own through
   * its plugin's config and credentials — setup neither stores nor checks
   * one for it. Nor for chatgpt: its sign-in is a file of its own
   * (`~/.stratus/chatgpt-sign-in.json`), not a stored credential.
   */
  const credentialProviderOf = (provider: CliProviderName): CredentialProviderName | undefined =>
    provider === 'demo' || provider === 'chatgpt' || isRegisteredProviderName(provider) ? undefined : provider;

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

  /**
   * The install's ChatGPT account as the menus show it, read from its
   * sign-in file by `refreshChatGPTAccount`: `ready` and
   * `plan_usage_not_granted` as a run reads them (`chatgptSignInStatus`),
   * `signed_out` for an account kept after a sign-out or a refused refresh,
   * `none` without one. Only the email is kept; no token leaves the file.
   */
  type ChatGPTAccount =
    | { status: 'none' }
    | { status: 'unreadable'; reason: string }
    | { status: 'signed_out' | 'plan_usage_not_granted' | 'ready'; email?: string; holdsTokens: boolean };
  let chatgptAccount: ChatGPTAccount = { status: 'none' };

  const chatgptFile = () => openChatGPTSignInFile(chatgptSignInLocation(env));

  const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

  const refreshChatGPTAccount = async (): Promise<void> => {
    let document: Record<string, unknown> | undefined;
    try {
      document = await chatgptFile().read();
    } catch (error) {
      chatgptAccount = { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
      return;
    }
    const status = await chatgptSignInStatus({ read: async () => document });
    const session = document?.session;
    const record = typeof session === 'object' && session !== null && !Array.isArray(session)
      ? session as Record<string, unknown>
      : undefined;
    if (record === undefined || !filled(record.clientId) || !filled(record.subject)) {
      chatgptAccount = { status: 'none' };
      return;
    }
    chatgptAccount = {
      status: status === 'none' ? 'signed_out' : status,
      ...(filled(record.email) ? { email: record.email } : {}),
      holdsTokens: filled(record.accessToken) || filled(record.refreshToken) || filled(record.idToken),
    };
  };

  const chatgptRowStatus = (): string => {
    switch (chatgptAccount.status) {
      case 'none':
        return 'not signed in';
      case 'unreadable':
        return "can't read its sign-in file";
      case 'signed_out':
        return `signed out (${chatgptAccount.email ?? 'saved account'})`;
      case 'plan_usage_not_granted':
        return `signed in as ${chatgptAccount.email ?? 'your ChatGPT account'}, without use of your ChatGPT plan`;
      case 'ready':
        return `signed in as ${chatgptAccount.email ?? 'your ChatGPT account'}`;
    }
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
    if (chatgptAccount.status === 'ready' || chatgptAccount.status === 'plan_usage_not_granted') {
      parts.push('chatgpt (ChatGPT sign-in)');
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
    if (isRegisteredProviderName(state.provider)) {
      return `served by the plugin that registers ${registeredProviderNameOf(state.provider)}, on its own sign-in`;
    }
    if (state.provider === 'chatgpt') {
      return chatgptAccount.status === 'ready'
        ? `signed in with ChatGPT as ${chatgptAccount.email ?? 'your ChatGPT account'}`
        : 'not signed in with ChatGPT yet';
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
      const binding = verifyEndpoint && withoutTrailingSlashes(verifyEndpoint) !== DEFAULT_ANTHROPIC_BASE_URL
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

  const CHATGPT_PACKAGE = PROVIDER_PACKAGE_NAMES.chatgpt;

  /**
   * Whether provider-chatgpt, which carries the sign-in and sign-out, is
   * here, installing it first when it isn't: no provider ships with the
   * CLI. Installed the way Save and the Test run install a provider, without
   * a question, since choosing ChatGPT was the decision. False, having said
   * why, when that fails.
   */
  const ensureChatGPTPackage = async (): Promise<boolean> => {
    if (packageInstalled(CHATGPT_PACKAGE, env)) {
      return true;
    }
    if (await installProviderPackages([CHATGPT_PACKAGE], streams, env) && packageInstalled(CHATGPT_PACKAGE, env)) {
      return true;
    }
    writeLine(streams.stdout, `Signing in with ChatGPT needs ${CHATGPT_PACKAGE}, which isn't installed, so nothing changed. Install it, then choose ChatGPT here again.`);
    return false;
  };

  /**
   * Whether this terminal is a remote one, where a browser opened here
   * would be the wrong machine's, or none at all. The sign-in page has to
   * come back to this machine's 127.0.0.1, so the person opens it where
   * they are and forwards the callback port.
   */
  const remoteTerminal = (): boolean =>
    readNonEmptyString(processEnv.SSH_CONNECTION) !== undefined
    || readNonEmptyString(processEnv.SSH_CLIENT) !== undefined
    || readNonEmptyString(processEnv.SSH_TTY) !== undefined
    || (process.platform === 'linux'
      && readNonEmptyString(processEnv.DISPLAY) === undefined
      && readNonEmptyString(processEnv.WAYLAND_DISPLAY) === undefined);

  const callbackPortOf = (url: string): string => {
    try {
      return new URL(new URL(url).searchParams.get('redirect_uri') ?? '').port;
    } catch {
      return '';
    }
  };

  /**
   * Shows the sign-in page: the system browser on this machine, or the
   * link to open elsewhere. The link is printed only when it has to be:
   * a returning sign-in's carries the saved ID token as a hint.
   */
  const showChatGPTSignInPage = async (url: string): Promise<void> => {
    const port = callbackPortOf(url);
    const printLink = (lead: string): void => {
      writeLine(streams.stdout, lead);
      writeLine(streams.stdout, `  ${url}`);
      writeLine(streams.stdout, `The sign-in comes back to 127.0.0.1:${port} on this machine. If you open the link on another computer, forward that port from it first:`);
      writeLine(streams.stdout, `  ssh -L ${port}:127.0.0.1:${port} <this machine>`);
    };
    if (remoteTerminal()) {
      printLink('No browser here, so open this link in a browser to sign in with ChatGPT:');
      return;
    }
    try {
      await (env.openExternal ?? openExternalUrl)(url);
      writeLine(streams.stdout, 'Opened your browser to sign in with ChatGPT.');
    } catch (error) {
      printLink(`Couldn't open a browser here (${error instanceof Error ? error.message : String(error)}). Open this link to sign in with ChatGPT:`);
    }
  };

  const signInChatGPT = async (account: 'saved' | 'new'): Promise<void> => {
    if (!(await ensureChatGPTPackage())) {
      return;
    }
    const minutes = Math.round(CHATGPT_SIGN_IN_TIMEOUT_MS / 60_000);
    let outcome;
    try {
      outcome = await runChatGPTSignIn(env, {
        account,
        ...(env.fetch ? { fetch: env.fetch } : {}),
        openUrl: async (url) => {
          await showChatGPTSignInPage(url);
          writeLine(streams.stdout, `Waiting for the sign-in to finish in the browser (up to ${minutes} minutes)…`);
        },
      });
    } catch (error) {
      // provider-chatgpt's errors are written for the person signing in,
      // and never carry a token.
      writeLine(streams.stdout, `✗ ${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally {
      await refreshChatGPTAccount();
    }
    const who = outcome.email ?? 'your ChatGPT account';
    if (!outcome.planUsage) {
      writeLine(streams.stdout, `Signed in with ChatGPT as ${who}, but you didn't allow Stratus Agent to use your ChatGPT plan, so no agent runs on it. Choose ChatGPT here again and allow it.`);
      return;
    }
    writeLine(streams.stdout, `✓ Signed in with ChatGPT as ${who}.`);
    await maybeSwitchDefault('chatgpt');
  };

  const signOutChatGPT = async (): Promise<void> => {
    if (!(await ensureChatGPTPackage())) {
      return;
    }
    let outcome;
    try {
      outcome = await runChatGPTSignOut(env, env.fetch ? { fetch: env.fetch } : {});
    } catch (error) {
      writeLine(streams.stdout, `✗ ${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally {
      await refreshChatGPTAccount();
    }
    writeLine(streams.stdout, outcome.signedOut
      ? `Signed out of ChatGPT${outcome.email !== undefined ? ` (${outcome.email})` : ''}.`
      : 'Stratus Agent was not signed in with ChatGPT here, so there was nothing to sign out of.');
    if (outcome.revocation !== undefined && !outcome.revocation.confirmed) {
      writeLine(streams.stdout, `OpenAI didn't confirm it ended the sign-in${outcome.revocation.reason !== undefined ? ` (${outcome.revocation.reason})` : ''}. Its tokens are cleared here anyway; to end it at OpenAI too, remove Stratus Agent from your ChatGPT account's settings at chatgpt.com.`);
    }
    if (state.provider === 'chatgpt') {
      writeLine(streams.stdout, 'chatgpt is still your default provider, so agents can\'t run until you sign in with ChatGPT again or choose another provider here.');
    }
  };

  const chooseChatGPT = async (): Promise<void> => {
    await refreshChatGPTAccount();
    const current = chatgptAccount;
    if (current.status === 'unreadable') {
      writeLine(streams.stdout, `Couldn't read the ChatGPT sign-in file (${current.reason}). Fix or remove ~/.stratus/chatgpt-sign-in.json, then choose ChatGPT here again.`);
      return;
    }
    const who = current.status !== 'none' ? current.email ?? 'your saved account' : undefined;
    const signedIn = current.status === 'ready' || current.status === 'plan_usage_not_granted';
    const actions: Array<{ label: string; run: () => Promise<void> }> = [];
    if (signedIn) {
      actions.push({ label: `Sign in again as ${who}`, run: () => signInChatGPT('saved') });
      actions.push({ label: 'Sign out', run: signOutChatGPT });
    } else if (current.status === 'signed_out') {
      actions.push({ label: `Continue with ChatGPT as ${who}`, run: () => signInChatGPT('saved') });
      if (current.holdsTokens) {
        // A damaged record can keep a token it can't use: sign that out first.
        actions.push({ label: 'Sign out', run: signOutChatGPT });
      } else {
        actions.push({ label: 'Use a different ChatGPT account', run: () => signInChatGPT('new') });
      }
    } else {
      actions.push({ label: 'Continue with ChatGPT', run: () => signInChatGPT('saved') });
    }
    writeLine(streams.stdout, 'Sign in with your ChatGPT account, and agents run on your ChatGPT plan instead of an API key.');
    const answer = await prompter.select('ChatGPT:', [...actions.map((action) => action.label), 'Back']);
    if (answer.kind !== 'index' || answer.index >= actions.length) {
      return;
    }
    await actions[answer.index]!.run();
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
  const providerUsable = async (provider: CliProviderName): Promise<boolean> => {
    if (provider === 'demo') {
      return true;
    }
    if (provider === 'chatgpt') {
      // Its sign-in is a file of its own, read as a run would read it.
      return hasChatGPTSignIn(openChatGPTSignInFile(chatgptSignInLocation(env))).catch(() => false);
    }
    const keyEnvSelector = provider === state.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
        ?? state.apiKeyEnv
      : undefined;
    const stored = credentialProviderOf(provider);
    // A contributed provider brings its own sign-in; setup cannot check
    // it and does not claim to.
    if (stored === undefined) {
      return isRegisteredProviderName(provider);
    }
    return state.credentials[stored] !== undefined
      || readNonEmptyString(processEnv.STRATUS_API_KEY) !== undefined
      || (keyEnvSelector ? readNonEmptyString(processEnv[String(keyEnvSelector)]) !== undefined : false)
      || readNonEmptyString(processEnv[defaultKeyEnvFor(provider)]) !== undefined;
  };

  // Signing in makes that provider the default only when the current
  // default cannot actually run (demo, or a provider with no usable key).
  const maybeSwitchDefault = async (provider: CredentialProviderName | 'chatgpt'): Promise<void> => {
    if (state.provider === 'demo' || (state.provider !== provider && !(await providerUsable(state.provider)))) {
      await switchDefaultProvider(provider);
    }
  };

  const chooseProviders = async (): Promise<void> => {
    await refreshChatGPTAccount();
    const answer = await prompter.select('Providers — sign in to one or more:', [
      `Claude (Anthropic) — ${providerSignInStatus('anthropic')}`,
      `OpenAI-compatible — ${providerSignInStatus('openai')}`,
      `Codex (ChatGPT) — ${providerSignInStatus('codex')}`,
      `ChatGPT — ${chatgptRowStatus()}`,
      'Demo — built-in fake model, offline, no account',
      'Back',
    ]);

    if (answer.kind !== 'index' || answer.index === 5) {
      return;
    }

    if (answer.index === 4) {
      await switchDefaultProvider('demo');
      writeLine(streams.stdout, 'Demo selected — no sign-in needed. Mention "echo" or "tool" in a prompt to see tool calls.');
      return;
    }

    if (answer.index === 3) {
      await chooseChatGPT();
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
        writeLine(streams.stdout, 'Use provider:model, e.g. anthropic:claude-opus-5-5 or codex:gpt-5.5.');
        return undefined;
      }
      // A typed id that appears in the collected list belongs to that
      // provider, wherever the default currently points.
      const listed = available.find((entry) => entry.id === typed);
      const inferred = listed?.provider
        ?? credentialProviderOf(state.provider)
        ?? available[0]!.provider;
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

  return {
    builtInDefaultModel,
    defaultModelFor,
    defaultKeyEnvFor,
    credentialProviderOf,
    providersSummary,
    modelsSummary,
    signInSummary,
    refreshChatGPTAccount,
    /** Whether the ChatGPT sign-in, as last read, can serve a run. */
    chatgptReady: (): boolean => chatgptAccount.status === 'ready',
    chooseProviders,
    chooseModels,
  };
};

export type ProviderSetup = ReturnType<typeof createProviderSetup>;
