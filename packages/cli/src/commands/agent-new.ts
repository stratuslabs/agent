import { DEFAULT_ANTHROPIC_MODEL } from '@stratusagent/provider-anthropic';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/provider-codex';
import { defineAgent, formatSoul, generateAgentName } from '@stratusagent/agents';
import {
  claimSoulFile,
  DEFAULT_OPENAI_MODEL,
  discoverActiveConfig,
  globalConfigPath,
  parseProviderName,
  readNonEmptyString,
  readProcessEnv,
  loadConfigFile,
  saveConfigFile,
  type StratusConfigFile,
  type StratusProviderName,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment, CliConfigFile } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedAgentNewCommand } from '../parse.ts';
import { quoteShellArg, stratusHeaderLines, createSetupPrompter } from '../prompter.ts';
import { DEFAULT_SOUL_STARTER } from './setup.ts';

/**
 * The provider/model a newly created soul pins. Frontmatter pins what a run
 * from this directory would actually use: env vars outrank the active
 * config file (project-local or explicit first, global otherwise), and no
 * provider anywhere falls back to demo — the exact precedence of stratus
 * run. Demo produces no model at all: the soul keeps following the
 * machine's configuration instead of demanding credentials nothing has
 * signed in for. The active config's model was written for the provider
 * named in that config, so it only travels into the soul when they still
 * match; otherwise the selected provider's own default model stands in.
 *
 * Exported for tests: the interactive path that consumes it needs a TTY.
 */
export const soulPinForNewAgent = (
  activeConfig: StratusConfigFile,
  processEnv: NodeJS.ProcessEnv,
): { provider: StratusProviderName; model?: string } => {
  // The map already validates, so the value is a provider name; the cast
  // only undoes `readNonEmptyString`'s widening to `string`.
  const envProvider = readNonEmptyString(
    processEnv.STRATUS_PROVIDER,
    (value) => parseProviderName(value, 'STRATUS_PROVIDER'),
  ) as StratusProviderName | undefined;
  const provider = envProvider ?? activeConfig.provider ?? 'demo';
  if (provider === 'demo') {
    return { provider };
  }
  const configModelApplies = (activeConfig.provider ?? 'openai') === provider;
  const model = readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? (configModelApplies ? activeConfig.model : undefined)
    ?? (provider === 'openai'
      ? DEFAULT_OPENAI_MODEL
      : provider === 'codex'
        ? DEFAULT_CODEX_MODEL
        : DEFAULT_ANTHROPIC_MODEL);
  return { provider, model };
};

export const runAgentNew = async (
  command: ParsedAgentNewCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // On a real terminal, creating an agent is the same guided experience as
  // setup: a headed screen, a prefilled (editable) name, a personality, and
  // an offer to make them the default. Scripted formats and piped input
  // keep the plain one-shot output.
  const interactive = env.setupInput === undefined
    && process.stdin.isTTY === true
    && command.format === 'text';

  if (interactive) {
    const prompter = createSetupPrompter(streams, env, {
      header: stratusHeaderLines,
      consumeNotices: () => [],
    });
    try {
      streams.stdout.write('\u001b[2J\u001b[H');
      for (const line of stratusHeaderLines()) {
        writeLine(streams.stdout, line);
      }
      writeLine(streams.stdout);

      const suggested = command.name ?? generateAgentName();
      const name = (await prompter.ask('Choose your name: ', { prefill: suggested })) || suggested;
      const instructions = await prompter.ask(
        'Describe their personality (Enter for a starter you can edit later): ',
        ...(command.instructions ? [{ prefill: command.instructions }] : []),
      );

      const persona = instructions || DEFAULT_SOUL_STARTER;

      const processEnv = readProcessEnv(env);
      // Creating an agent must not be blocked by a broken config — it only
      // feeds the soul's provider/model hint, so fall back to defaults.
      const { location: configLocation, config: activeConfig } = await discoverActiveConfig(env, (message) => {
        writeLine(streams.stdout, `Note: ${message}.`);
      });
      const { provider: soulProvider, model: soulModel } = soulPinForNewAgent(activeConfig, processEnv);
      const soulPin = soulProvider !== 'demo' && soulModel !== undefined
        ? { provider: soulProvider, model: soulModel }
        : {};

      const claimed = await claimSoulFile(
        env,
        { name, instructions: persona },
        (candidate) => formatSoul({ agent: candidate, ...soulPin }),
        (message) => writeLine(streams.stdout, message),
      );
      const { agent, soulPath } = claimed;

      const makeDefault = await prompter.select(`Make ${agent.name} your default agent?`, [
        'Yes — every stratus run talks to them',
        'Not now',
      ]);
      let madeDefault = false;
      if (makeDefault.kind === 'index' && makeDefault.index === 0) {
        // The default agent is a machine-wide setting, so it lands in the
        // global config even when a project config is active here.
        let globalConfig: CliConfigFile | undefined;
        try {
          globalConfig = await loadConfigFile(globalConfigPath(env));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            globalConfig = {};
          } else {
            // A malformed config is recoverable by hand — never overwrite it.
            writeLine(streams.stdout, `Could not read ${globalConfigPath(env)} (${error instanceof Error ? error.message : String(error)}), so it was left untouched. Fix it, then make ${agent.name} the default from stratus setup.`);
          }
        }
        if (globalConfig !== undefined) {
          // Re-validated rather than cast: `readNonEmptyString` widens to
          // `string`, and the shared parser is what says which strings are
          // provider names. Every source feeding soulProvider is already one,
          // so this narrows without being able to throw.
          const config: CliConfigFile = {
            ...globalConfig,
            provider: globalConfig.provider ?? parseProviderName(soulProvider, 'provider'),
            soul: soulPath,
          };
          await saveConfigFile(globalConfigPath(env), config);
          madeDefault = true;
          if (configLocation && configLocation.path !== globalConfigPath(env)) {
            writeLine(streams.stdout, `Note: ${configLocation.path} takes precedence over the global config for runs started in this directory.`);
          }
        }
      }

      writeLine(streams.stdout);
      writeLine(streams.stdout, `Say hello to ${agent.name}.`);
      writeLine(streams.stdout, `Their soul lives at ${soulPath} — edit it any time to change how they talk.`);
      writeLine(streams.stdout);
      writeLine(streams.stdout, 'Try:');
      writeLine(streams.stdout, madeDefault
        ? '  stratus run "introduce yourself"'
        : `  stratus run --soul ${quoteShellArg(soulPath)} "introduce yourself"`);
      return 0;
    } finally {
      prompter.close();
    }
  }

  const agent = defineAgent({
    ...(command.name ? { name: command.name } : {}),
    ...(command.instructions ? { instructions: command.instructions } : {}),
  });

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify(agent, null, 2));
    return 0;
  }

  if (command.format === 'soul') {
    streams.stdout.write(
      formatSoul({ agent, provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL }),
    );
    return 0;
  }

  writeLine(streams.stdout, `Say hello to ${agent.name}.`);
  writeLine(streams.stdout);
  writeLine(streams.stdout, `  id      ${agent.id}`);
  writeLine(streams.stdout, `  avatar  ${agent.avatar?.style} theme, hue ${agent.avatar?.hue}, palette ${agent.avatar?.palette.join(' ')}`);
  if (agent.instructions) {
    writeLine(streams.stdout, `  soul    ${agent.instructions}`);
  }
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Save this as a soul file and run it:');
  writeLine(streams.stdout, `  stratus agent new --name ${quoteShellArg(agent.name)}${command.instructions ? ` --instructions ${quoteShellArg(command.instructions)}` : ''} --format soul > my-agent.md`);
  writeLine(streams.stdout, '  stratus run --soul my-agent.md "hello"');
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Definition (JSON):');
  writeLine(streams.stdout, JSON.stringify(agent, null, 2));
  return 0;
};
