import { providerPackagesMissingMessage, installProviderPackages, missingProviderPackages } from '../provider-packages.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatSoul, parseSoul } from '@stratusagent/agents';
import {
  claimSoulFile,
  credentialsPath,
  DEFAULT_OPENAI_BASE_URL,
  globalConfigPath,
  loadChannelCredentials,
  loadCredentials,
  isRegisteredProviderName,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  resolveRuntimeConfig,
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  saveChannelCredentials,
  saveChannelTransportSecrets,
  removeChannelTransportSecrets,
  saveConfigFile,
  saveCredentials,
} from '@stratusagent/state';
import {
  installService,
  readServiceStatus,
  servicePlatform,
  serviceUnitPath,
  uninstallService,
} from '../service.ts';
import { channelReloadLine, reloadRunningDaemonChannels, serviceEnvFor } from '../daemon.ts';
import type { CliStreams, CliEnvironment, CliConfigFile } from '../environment.ts';
import { writeLine } from '../io.ts';
import { packageInstalled } from '../loaders.ts';
import { CLI_VERSION, defaultPackageInstaller } from '../npm.ts';
import type { ParsedSetupCommand } from '../parse.ts';
import {
  quoteShellArg,
  stratusHeaderLines,
  createSetupPrompter,
} from '../prompter.ts';
import { createApprovalSetup } from './setup/approvals.ts';
import { createChannelSetup } from './setup/channels.ts';
import type { SetupState } from './setup/context.ts';
import { createPluginSetup } from './setup/plugins.ts';
import { createProviderSetup } from './setup/providers.ts';
import { createServiceSetup } from './setup/service.ts';
import { createSharedSetup } from './setup/shared.ts';
import { createSlackSetup } from './setup/slack.ts';
import { createTestRunSetup } from './setup/test-run.ts';

export const DEFAULT_SOUL_STARTER = [
  'You are a helpful, warm generalist. Answer first, explain second, and',
  'keep replies short unless the question genuinely needs depth. Use',
  'memory.remember for durable facts about the people you work with, and',
  'memory.recall to look up what you know when a conversation calls for it.',
].join('\n');

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
    ...(existing.language !== undefined ? { language: existing.language } : {}),
    ...(existing.plugins !== undefined ? { plugins: existing.plugins } : {}),
    ...(existing.approvals !== undefined ? { approvals: existing.approvals } : {}),
    ...(existing.api !== undefined ? { api: existing.api } : {}),
    ...(existing.principals !== undefined ? { principals: existing.principals } : {}),
    ...(existing.slack !== undefined ? { slack: existing.slack } : {}),
    // Settings setup has no menu for, carried through a save untouched: a
    // re-run that dropped them would put the operator's agents back on the
    // host and the file store without a word — and, for the two bounds,
    // back on defaults their model cannot serve. A `maxTokens` set because
    // a proxy's ceiling is under 16000 would silently return to 16000 and
    // fail every request; a raised `maxTurns` would return to 8.
    ...(existing.executor !== undefined ? { executor: existing.executor } : {}),
    ...(existing.memoryStore !== undefined ? { memoryStore: existing.memoryStore } : {}),
    ...(existing.maxTokens !== undefined ? { maxTokens: existing.maxTokens } : {}),
    ...(existing.maxTurns !== undefined ? { maxTurns: existing.maxTurns } : {}),
    // Carried for the same reason: setup has no screen for it, and a save
    // that dropped it would put every agent back on the shared budget.
    ...(existing.agentMaxTurns !== undefined ? { agentMaxTurns: existing.agentMaxTurns } : {}),
    ...(existing.autoContinue !== undefined ? { autoContinue: existing.autoContinue } : {}),
    credentials: await loadCredentials(env),
    credentialsDirty: false,
    channels: await loadChannelCredentials(env),
    channelsDirty: false,
    pluginChannelSecrets: {},
    pluginChannelEdits: [],
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

  const { channelRoster, fitMenuRow } = createSharedSetup({ streams, env, state, prompter });
  const {
    builtInDefaultModel,
    defaultModelFor,
    defaultKeyEnvFor,
    credentialProviderOf,
    providersSummary,
    modelsSummary,
    signInSummary,
    chooseProviders,
    chooseModels,
  } = createProviderSetup({ state, processEnv, prompter, streams, env });
  const { testRun } = createTestRunSetup({
    state,
    processEnv,
    streams,
    env,
    prompter,
    recentNotices,
    defaultKeyEnvFor,
    credentialProviderOf,
    builtInDefaultModel,
  });
  const { chooseSlackChannel } = createSlackSetup({
    streams,
    prompter,
    env,
    state,
    serveCommand,
    channelRoster,
  });
  const { serviceSummary, chooseService } = createServiceSetup({ env, state, streams, prompter });
  const { pluginPackages, pluginEnabled, pluginContributions, pluginsSummary, choosePlugins } = createPluginSetup({
    state,
    streams,
    env,
    prompter,
    channelRoster,
    fitMenuRow,
  });
  const { approvalsSummary, chooseApprovals } = createApprovalSetup({
    state,
    env,
    serveCommand,
    prompter,
    streams,
    channelRoster,
    fitMenuRow,
  });
  const { channelsSummary, pluginChannelKinds, boundPluginChannelKinds, chooseChannels } = createChannelSetup({
    state,
    env,
    prompter,
    serveCommand,
    streams,
    pluginPackages,
    pluginEnabled,
    pluginContributions,
    chooseSlackChannel,
    channelRoster,
  });

  const agentSummary = (): string => {
    if (!state.soulPath) {
      return 'none — every run uses the built-in default agent';
    }
    return state.soulPath;
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
    const pinnedModel = state.model ?? defaultModelFor(state.provider);
    const pin = state.provider !== 'demo'
      ? { provider: state.provider, ...(pinnedModel !== undefined ? { model: pinnedModel } : {}) }
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
   * The Slack channel package, when this setup has Slack tokens stored and
   * it is not installed. Setup knows that before the daemon does, so it is
   * the one place that can offer the install rather than leave the gap to
   * be found in a log after the fact.
   *
   * The dashboard is deliberately not offered here: its control API binds a
   * port, and the time to ask about that is when someone runs
   * `stratus dashboard`, which offers its own packages (card 308).
   * Declining is a real answer and prints the command.
   *
   * Installed at this CLI's own version, as the providers are: the packages
   * ship in lockstep, and an unpinned install on an older CLI pulls a newer
   * adapter than the core it loads into.
   */
  const offerOptionalPackages = async (): Promise<void> => {
    const slackPackage = '@stratusagent/channel-slack';
    const slackSpecifier = `${slackPackage}@${CLI_VERSION}`;
    const slackAgents = Object.keys(state.channels.slack ?? {}).length;
    if (slackAgents === 0 || packageInstalled(slackPackage, env)) {
      return;
    }
    writeLine(streams.stdout);
    writeLine(streams.stdout, 'One optional package is not installed:');
    writeLine(streams.stdout, `  ${slackPackage}`);
    writeLine(streams.stdout, `    Slack tokens are stored for ${slackAgents} agent(s), but nothing connects to Slack without it.`);

    const answer = await prompter.select('Install now with npm install -g?', ['Install it now', 'Skip']);
    if (answer.kind !== 'index' || answer.index !== 0) {
      writeLine(streams.stdout, `Skipped. Install it yourself with: npm install -g ${slackSpecifier}`);
      return;
    }

    writeLine(streams.stdout, `Running: npm install -g ${slackSpecifier}`);
    // Never fails setup — not even its exit code, unlike the always-on
    // service step below: the config and credentials are already written,
    // and a package that did not install is a warning at the next start,
    // not a broken machine.
    const result = await (env.packageInstaller ?? defaultPackageInstaller)([slackSpecifier])
      .catch((error: unknown) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
    if (result.ok) {
      writeLine(streams.stdout, `Installed ${slackPackage}.`);
    } else {
      writeLine(streams.stderr, `Could not install: ${result.message}`);
      writeLine(streams.stderr, `Setup is saved either way — run \`npm install -g ${slackSpecifier}\` yourself.`);
    }
  };

  /**
   * Write everything the menu decided, then report whether the always-on
   * service step it performed — installing the service, or removing one the
   * user chose not to run — and the install of the provider package the
   * config runs on both succeeded.
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
    // Channels whose secrets this save stored with no running daemon to
    // pick them up, and whether the service step below leaves one running.
    // Together they decide the finish screen's last line: the save line
    // says "run `stratus serve`" too, but optional-package installs scroll
    // it away, and the closing list is what a first run reads last.
    const awaitingServe = new Set<string>();
    let serviceRunning = false;
    // Typed as the file rather than as a bag of scalars: the carried blocks
    // below are objects, and a `Record<string, string | boolean>` was what
    // made dropping them the path of least resistance.
    const config: CliConfigFile = { provider: state.provider };
    const savedModel = state.model ?? defaultModelFor(state.provider);
    if (state.provider !== 'demo' && savedModel !== undefined) {
      config.model = savedModel;
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
    if (state.language !== undefined) {
      config.language = state.language;
    }
    // `plugins` and `approvals` have menus above; `api`, `principals`, and
    // `slack` do not and are written back exactly as they were read. Both cases
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
    if (state.slack !== undefined) {
      config.slack = state.slack;
    }
    if (state.executor !== undefined) {
      config.executor = state.executor;
    }
    if (state.memoryStore !== undefined) {
      config.memoryStore = state.memoryStore;
    }
    if (state.maxTokens !== undefined) {
      config.maxTokens = state.maxTokens;
    }
    if (state.maxTurns !== undefined) {
      config.maxTurns = state.maxTurns;
    }
    if (state.agentMaxTurns !== undefined) {
      config.agentMaxTurns = state.agentMaxTurns;
    }
    if (state.autoContinue !== undefined) {
      config.autoContinue = state.autoContinue;
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
    }
    if (state.pluginChannelEdits.length > 0) {
      // In the order they were made, so a store then a remove of the same
      // binding ends removed, as the menu last showed it.
      for (const edit of state.pluginChannelEdits) {
        if (edit.secrets !== undefined) {
          await saveChannelTransportSecrets(env, edit.kind, edit.agentId, edit.secrets);
        } else {
          await removeChannelTransportSecrets(env, edit.kind, edit.agentId);
        }
      }
    }
    if (state.channelsDirty || state.pluginChannelEdits.length > 0) {
      // Once every channel's secrets are written: a running daemon reloads
      // each channel that can (card 894), and the rest wait for its next
      // start, as they do with no daemon.
      const reload = await reloadRunningDaemonChannels(env);
      const answered = reload !== undefined && 'base' in reload ? reload : undefined;
      if (state.channelsDirty) {
        const connected = Object.keys(state.channels.slack ?? {}).length;
        const saved = connected > 0
          ? `Saved Slack tokens for ${connected} agent${connected === 1 ? '' : 's'} to ${credentialsPath(env)}`
          : `Removed the stored Slack tokens from ${credentialsPath(env)}`;
        writeLine(streams.stdout, answered !== undefined
          ? `${saved}. ${channelReloadLine(answered, 'slack')}`
          : connected > 0 ? `${saved} — run \`${serveCommand()}\` to bring them online.` : `${saved}.`);
        if (answered === undefined && connected > 0) {
          awaitingServe.add('slack');
        }
      }
      if (state.pluginChannelEdits.length > 0) {
        const saved = `Saved your channel secrets to ${credentialsPath(env)}`;
        const kinds = [...new Set(state.pluginChannelEdits.map((edit) => edit.kind))];
        writeLine(streams.stdout, answered !== undefined
          ? `${saved}. ${kinds.map((kind) => channelReloadLine(answered, kind)).join(' ')}`
          : `${saved} — run \`${serveCommand()}\` to bring them online.`);
        if (answered === undefined) {
          // From what the save leaves bound, not the edits: a store then a
          // remove of the same binding leaves nothing to bring online.
          const bound = await boundPluginChannelKinds();
          for (const kind of kinds) {
            if (bound.includes(kind)) {
              awaitingServe.add(kind);
            }
          }
        }
      }
      if (reload !== undefined && 'warning' in reload) {
        writeLine(streams.stderr, `Warning: ${reload.warning}`);
      }
    }

    // Before the service block below, deliberately. A package installed
    // after the daemon starts is invisible to it — installing does not
    // reload a running process — so offering here is what makes the
    // LaunchAgent come up with the Slack channel and the control API
    // already present, instead of warning about them in a log nobody reads
    // until the dashboard fails.
    // The provider package comes first, and without a question: choosing
    // the provider was the decision, and the CLI carries none of the
    // packages (the Anthropic adapter, the claude-code and codex harnesses),
    // so a daemon started without it fails every turn. Through the saved
    // files, so a soul's own pin counts.
    // A failed install is carried like a failed service step: everything is
    // saved, but the exit code and the closing line must not call a config
    // whose every turn fails ready.
    const providerPackages = await missingProviderPackages(env, configPath, { asService: true });
    const providerInstallFailed = !(await installProviderPackages(providerPackages, streams, env));
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
        } else {
          // That was the daemon answering every stored channel, edited in
          // this run or not, so each one is silent from here on.
          if (Object.keys(state.channels.slack ?? {}).length > 0) {
            awaitingServe.add('slack');
          }
          for (const kind of await boundPluginChannelKinds()) {
            awaitingServe.add(kind);
          }
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
      // Installed but not running is a failed step too: the always-on
      // service is the part of setup that is meant to be answering.
      const running = !('running' in result) || result.running === true;
      for (const message of result.messages) {
        writeLine(result.ok && running ? streams.stdout : streams.stderr, message);
      }
      if (!result.ok) {
        writeLine(streams.stderr, `Setup is saved either way — start the daemon yourself with \`${serveCommand()}\`.`);
        serviceStepFailed = true;
      } else if (!running) {
        writeLine(streams.stderr, 'Setup is saved either way. Check `stratus service status` once you have looked at the logs.');
        serviceStepFailed = true;
      } else {
        serviceRunning = true;
      }
    }
    writeLine(streams.stdout);

    // Exported STRATUS_* variables outrank the config file, so warn when one
    // would make `stratus run` behave differently from what was just saved.
    const conflicts = [
      detectEnvOverride('STRATUS_PROVIDER', state.provider, '--provider'),
      ...(state.provider !== 'demo' && (state.model ?? defaultModelFor(state.provider)) !== undefined
        ? [detectEnvOverride('STRATUS_MODEL', String(state.model ?? defaultModelFor(state.provider)), '--model')]
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

    // Read back what was just written, through the resolver a run uses,
    // before saying "ready". The menu's state is what setup meant to save;
    // whether a run starts is decided by the files on disk plus this shell's
    // environment, and the two have disagreed: a soul named in the
    // environment that no longer exists fails every run while the menu
    // looked signed in. Only the "ready" claim waits on this. The
    // not-signed-in branch already says what is missing. An exported
    // variable the suggested command overrides with a flag is resolved with
    // that same flag, so the read-back checks the command it suggests.
    const flagged = new Set(conflicts.flatMap((conflict) => (conflict.flag ? [conflict.envVar] : [])));
    const readBackSelection = {
      configPath,
      ...(flagged.has('STRATUS_PROVIDER') ? { provider: state.provider } : {}),
      ...(flagged.has('STRATUS_MODEL') ? { model: String(state.model ?? defaultModelFor(state.provider)) } : {}),
      ...(flagged.has('STRATUS_BASE_URL') ? { baseUrl: state.baseUrl ?? DEFAULT_OPENAI_BASE_URL } : {}),
    };
    const readBackFailure = providerInstallFailed
      ? providerPackagesMissingMessage(providerPackages)
      : await resolveRuntimeConfig(readBackSelection, env).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    const failedReadBack = (): boolean => {
      if (readBackFailure === undefined) {
        return false;
      }
      writeLine(streams.stdout, `Saved, but a run started here would fail: ${readBackFailure}`);
      writeLine(streams.stdout, `Run \`stratus doctor${runConfigFlag}${shadowConfigFlag}\` for the full picture. Once it is fixed, try:`);
      return true;
    };

    if (state.provider === 'demo') {
      if (!failedReadBack()) {
        writeLine(streams.stdout, 'You are ready to go — no account needed. Try:');
      }
    } else if (readNonEmptyString(processEnv.STRATUS_API_KEY)) {
      if (!failedReadBack()) {
        writeLine(streams.stdout, 'STRATUS_API_KEY is exported and takes precedence over your saved sign-in. You are ready to go. Try:');
      }
    } else if (isRegisteredProviderName(state.provider) || state.credentials[credentialProviderOf(state.provider) ?? 'anthropic']) {
      if (!failedReadBack()) {
        writeLine(streams.stdout, `You are ${signInSummary()} — ready to go. Try:`);
      }
    } else {
      const keyEnv = state.apiKeyEnv ?? defaultKeyEnvFor(state.provider);
      if (readNonEmptyString(processEnv[keyEnv])) {
        if (!failedReadBack()) {
          writeLine(streams.stdout, `${keyEnv} is set in your environment — you are ready to go. Try:`);
        }
      } else {
        writeLine(streams.stdout, 'You are NOT signed in yet — re-run `stratus setup` and pick option 1, or:');
        writeLine(streams.stdout, `  export ${keyEnv}=your-key`);
        writeLine(streams.stdout);
        writeLine(streams.stdout, 'Then try:');
      }
    }
    writeLine(streams.stdout, `  stratus run${extraFlags}${runConfigFlag}${shadowConfigFlag} "say hello"`);
    // Whether or not its packages are here: the command offers them itself.
    writeLine(streams.stdout, '  stratus dashboard');
    if (awaitingServe.size > 0 && !serviceRunning) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, `${awaitingServe.size === 1 && awaitingServe.has('slack') ? 'Slack answers' : 'Your channels answer'} only while stratusd runs — start it with \`${serveCommand()}\`.`);
    }
    return !serviceStepFailed && !providerInstallFailed;
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
      const channelKinds = (await pluginChannelKinds()).map((entry) => entry.kind);
      const choice = await prompter.select('', [
        `Providers            ${providersSummary()}`,
        `Models               ${modelsSummary()}`,
        `Agent                ${agentSummary()}`,
        `Plugins              ${fitMenuRow(pluginsSummary())}`,
        `Channels             ${fitMenuRow(channelsSummary(channelKinds))}`,
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
