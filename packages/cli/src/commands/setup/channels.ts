/*
 * The Channels menu of `stratus setup`: Slack and the channels plugins
 * contribute, and which agent each one is bound to. Moved out of `runSetup`
 * in setup.ts as is: the statements are unchanged, inside a factory that
 * takes the values they closed over there, and `runSetup` destructures what
 * it returns.
 */

import { loadChannelTransportSecrets, CREDENTIAL_NAME_PATTERN } from '@stratusagent/state';
import { writeLine } from '../../io.ts';
import type { SetupBase } from './context.ts';
import type { PluginSetup } from './plugins.ts';
import type { SlackSetup } from './slack.ts';
import type { SharedSetup } from './shared.ts';

export const createChannelSetup = ({
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
}: Pick<SetupBase, 'state' | 'env' | 'prompter' | 'serveCommand' | 'streams'> & Pick<PluginSetup, 'pluginPackages' | 'pluginEnabled' | 'pluginContributions'> & Pick<SlackSetup, 'chooseSlackChannel'> & Pick<SharedSetup, 'channelRoster'>) => {
  const channelsSummary = (pluginKinds: readonly string[]): string => {
    const connected = Object.keys(state.channels.slack ?? {}).length;
    const slack = connected === 0
      ? 'Slack: not connected'
      : `Slack: ${connected} agent${connected === 1 ? '' : 's'} connected`;
    return pluginKinds.length === 0 ? slack : `${slack}; also ${pluginKinds.join(', ')}`;
  };

  /**
   * The channel kinds the enabled plugins declare, Slack's own aside, each
   * with the config key of every plugin declaring it — from manifests,
   * never by loading a package, as the Plugins row reads them. Every one,
   * not the first: two plugins may carry the same kind for different agents
   * (channels key on agent and kind), and an agent bound by the second one's
   * config is as bound as one bound by the first's.
   */
  const pluginChannelKinds = async (): Promise<Array<{ kind: string; plugins: string[] }>> => {
    const kinds: Array<{ kind: string; plugins: string[] }> = [];
    for (const name of pluginPackages()) {
      if (!pluginEnabled(name)) {
        continue;
      }
      for (const kind of (await pluginContributions(name))?.channels ?? []) {
        if (kind === 'slack') {
          continue;
        }
        const entry = kinds.find((candidate) => candidate.kind === kind);
        if (entry === undefined) {
          kinds.push({ kind, plugins: [name] });
        } else if (!entry.plugins.includes(name)) {
          entry.plugins.push(name);
        }
      }
    }
    return kinds;
  };

  /**
   * The plugin channels some agent is bound to, by stored secrets or by its
   * plugin's config block, as the channel menu below counts a binding.
   */
  const boundPluginChannelKinds = async (): Promise<string[]> => {
    const bound: string[] = [];
    for (const { kind, plugins } of await pluginChannelKinds()) {
      state.pluginChannelSecrets[kind] ??= await loadChannelTransportSecrets(env, kind);
      const inConfig = plugins.some((plugin) => {
        const configured = state.plugins?.[plugin]?.agents;
        return typeof configured === 'object' && configured !== null && !Array.isArray(configured) && Object.keys(configured).length > 0;
      });
      if (inConfig || Object.keys(state.pluginChannelSecrets[kind]).length > 0) {
        bound.push(kind);
      }
    }
    return bound;
  };

  /**
   * Slack alone, as it always was, until a plugin declares a channel: then
   * the row asks which channel first. A setup with no channel plugin sees
   * exactly the screens it saw before there could be one.
   */
  const chooseChannels = async (): Promise<void> => {
    const kinds = await pluginChannelKinds();
    if (kinds.length === 0) {
      await chooseSlackChannel();
      return;
    }
    while (true) {
      const options = [
        'Slack'.padEnd(20) + 'built in',
        ...kinds.map(({ kind, plugins }) => kind.padEnd(20) + `from ${plugins.join(', ')}`),
        'Back',
      ];
      const choice = await prompter.select('Channels', options);
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }
      const picked = kinds[choice.index - 1];
      if (picked === undefined) {
        await chooseSlackChannel();
      } else {
        await choosePluginChannel(picked.kind, picked.plugins);
      }
    }
  };

  /**
   * One plugin channel's agents, and whether each is bound — by secrets
   * stored under `channels.<kind>.<agentId>`, or by an entry under the
   * plugin's own config `agents` block. Either is a binding: a channel that
   * needs no secret (iMessage on this Mac) is bound by config alone, so a
   * menu that knew only secrets would call it not connected.
   *
   * Setup stores secrets and never writes the plugin's config: which keys
   * that block takes is the plugin's schema, which only its README states.
   */
  const choosePluginChannel = async (kind: string, plugins: readonly string[]): Promise<void> => {
    const secretsFor = async (): Promise<Record<string, Record<string, string>>> => {
      state.pluginChannelSecrets[kind] ??= await loadChannelTransportSecrets(env, kind);
      return state.pluginChannelSecrets[kind];
    };
    while (true) {
      const { entries: roster, loaded: rosterLoaded } = await channelRoster();
      const stored = await secretsFor();
      // Any plugin carrying this kind binds the agents its own block lists.
      const inConfig = (id: string): boolean => plugins.some((plugin) => {
        const configured = state.plugins?.[plugin]?.agents;
        return typeof configured === 'object' && configured !== null && !Array.isArray(configured) && Object.hasOwn(configured, id);
      });
      const options = roster.map((entry) => {
        const id = entry.soul.agent.id;
        const bindings = [
          ...(stored[id] !== undefined ? [`✓ secrets: ${Object.keys(stored[id]).sort().join(', ')}`] : []),
          ...(inConfig(id) ? ['✓ in its plugin config'] : []),
        ];
        return `${entry.soul.agent.name} (${id})`.padEnd(34) + (bindings.length > 0 ? bindings.join('; ') : '— not connected');
      });
      // Only against a roster that loaded, for the reason the Slack menu
      // gives: an unreadable roster would make every binding look orphaned.
      const orphans = rosterLoaded
        ? Object.keys(stored).filter((id) => !roster.some((entry) => entry.soul.agent.id === id))
        : [];
      for (const id of orphans) {
        options.push(`${id}`.padEnd(34) + '! secrets without a matching agent');
      }
      options.push('Back');

      const blocks = plugins.map((plugin) => `plugins["${plugin}"].agents`).join(' or ');
      const choice = await prompter.select(`Channels — ${kind} (from ${plugins.join(', ')})`, options, {
        footnote: `Bound by secrets stored here, or by an entry under ${blocks} in your config — the plugin's README says which. Run \`${serveCommand()}\` afterwards.`,
      });
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }
      const agentId = choice.index < roster.length
        ? roster[choice.index]?.soul.agent.id
        : orphans[choice.index - roster.length];
      if (agentId === undefined) {
        return;
      }

      const actions = [
        ...(choice.index < roster.length ? [stored[agentId] !== undefined ? 'Replace the stored secrets' : 'Store secrets'] : []),
        ...(stored[agentId] !== undefined ? ['Remove the stored secrets'] : []),
        'Back',
      ];
      const action = await prompter.select(`${agentId} on ${kind}`, actions);
      if (action.kind !== 'index' || actions[action.index] === 'Back') {
        continue;
      }
      if (actions[action.index] === 'Remove the stored secrets') {
        delete stored[agentId];
        state.pluginChannelEdits.push({ kind, agentId });
        writeLine(streams.stdout, `Removed ${agentId}'s ${kind} secrets.`);
        continue;
      }

      const names = (await prompter.ask(`Secret names for ${kind}, separated by spaces (its README lists them): `))
        .split(/\s+/)
        .filter((name) => name.length > 0);
      if (names.length === 0) {
        continue;
      }
      const bad = names.find((name, index) => !CREDENTIAL_NAME_PATTERN.test(name) || names.indexOf(name) !== index);
      if (bad !== undefined) {
        writeLine(streams.stderr, `${bad} is not a secret name, or is named twice. Nothing was stored.`);
        continue;
      }
      const secrets: Record<string, string> = {};
      for (const name of names) {
        secrets[name] = await prompter.askSecret(`${name} (not echoed): `);
      }
      const empty = names.find((name) => (secrets[name] ?? '').length === 0);
      if (empty !== undefined) {
        writeLine(streams.stderr, `${empty} was empty, so nothing was stored. A binding missing a secret would never come online.`);
        continue;
      }
      stored[agentId] = secrets;
      state.pluginChannelEdits.push({ kind, agentId, secrets });
      writeLine(streams.stdout, `Stored ${names.join(', ')} for ${agentId} on ${kind}; saved when you finish.`);
    }
  };

  return { channelsSummary, pluginChannelKinds, boundPluginChannelKinds, chooseChannels };
};

export type ChannelSetup = ReturnType<typeof createChannelSetup>;
