/*
 * The Plugins menu of `stratus setup`: enabling, configuring and disabling
 * plugins, and what each one needs from the agents that use it. Moved out of
 * `runSetup` in setup.ts as is: the statements are unchanged, inside a
 * factory that takes the values they closed over there, and `runSetup`
 * destructures what it returns.
 */

import type { JsonObject } from '@stratusagent/core';
import { preflightPlugin, readPluginManifest, PluginConfigError, PluginManifestError } from '@stratusagent/plugins';
import { type PluginConfigBlock, unlistedToolsFor } from '@stratusagent/state';
import { writeLine } from '../../io.ts';
import { packageInstalled } from '../../loaders.ts';
import { isPackageName, isInstallableSpecifier, defaultPackageInstaller } from '../../npm.ts';
import { FIRST_PARTY_CAPABILITY_PACKAGES } from '../../plugin-catalog.ts';
import {
  checkPluginReleases,
  currentPlatformHost,
  installSpecifier,
  readPluginIndex,
  releaseVerdict,
} from '../../plugin-index.ts';
import { menuPrefixWidth } from '../../prompter.ts';
import { soulGrantsTool } from '../../roster.ts';
import type { SetupBase } from './context.ts';
import type { ChannelRosterEntry, SharedSetup } from './shared.ts';

export const createPluginSetup = ({
  state,
  streams,
  env,
  prompter,
  channelRoster,
  fitMenuRow,
}: Pick<SetupBase, 'state' | 'streams' | 'env' | 'prompter'> & Pick<SharedSetup, 'channelRoster' | 'fitMenuRow'>) => {
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
      grants: 'fs.read, fs.list, fs.search, fs.write, fs.move',
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
      await preflightPlugin(manifest, directory, block as JsonObject);
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
  ): Promise<{ packageName: string; tools: string[]; namespaces: string[]; skills: string[]; channels: string[] } | undefined> => {
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
        channels: manifest.contributes.channels.map((channel) => channel.name),
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

    // A soul with `tools: ["*"]` is allowlisted for *every* registered
    // tool, and the built-in `stratus` agent says that in code, so a fresh
    // install always has one. Enabling a plugin therefore can grant
    // capability immediately, and saying "no agent can call it yet" would
    // understate what just happened in the most common configuration there
    // is. A soul with no `tools:` key gets only the tools registered as
    // safe. Read the roster and say which it was.
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
    // On a home an older build set up, a soul with no list has every tool,
    // as it always did there; the daemon reads it the same way.
    const unlistedEvery = unlistedToolsFor(env) === 'every';
    const grantsEvery = (entry: ChannelRosterEntry): boolean => (entry.soul.agent.tools === undefined
      ? unlistedEvery
      : entry.soul.agent.tools.includes('*'));
    const reached = (entry: ChannelRosterEntry): string[] => {
      const tools = entry.soul.agent.tools;
      if (tools === undefined && unlistedEvery) {
        return everyTool;
      }
      if (tools === undefined) {
        // Only the tools registered as safe, and which of these those are
        // is the manifest and the operator's overrides, which `stratus
        // plugins` reads. Not re-derived here: such a soul is named on its
        // own line below instead of counted as reaching anything.
        return [];
      }
      if (tools.includes('*')) {
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
      if (tools === undefined || tools.includes('*') || contributed === undefined) {
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
    const permissive = callable.filter(grantsEvery);
    const explicit = callable.filter((entry) => !grantsEvery(entry));
    // Souls with no list at all, on a home where that is the safe tools:
    // not callable for anything this menu can vouch for, and the reason is
    // not the one a narrow list has.
    const unlisted = unlistedEvery ? [] : entries.filter((entry) => entry.soul.agent.tools === undefined);
    const unlistedLine = (): void => {
      if (unlisted.length === 0 || everyTool.length === 0) {
        return;
      }
      const one = unlisted.length === 1;
      writeLine(streams.stdout, `${label(unlisted)} ${one ? 'has' : 'have'} no \`tools:\` list, so ${one ? 'it gets' : 'they get'} only the tools registered as safe, which leaves out anything of ${name} that runs, writes or sends. Name ${grants ?? 'its tools'} in a \`tools:\` list to grant ${one ? 'it' : 'them'} the rest.`);
    };
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
        const has = permissive.length === 1 ? 'has' : 'have';
        const withoutList = permissive.filter((entry) => entry.soul.agent.tools === undefined).length;
        writeLine(streams.stdout, `${name} is enabled — and ${label(permissive)} ${withoutList === permissive.length
          ? `${has} no \`tools:\` list, which means every registered tool.`
          : withoutList === 0
            ? `${has} \`tools: ["*"]\`, which means every registered tool.`
            : `${permissive.length === 1 ? 'is' : 'are'} allowed every registered tool.`}`);
        // The agents are the subject, so no verb has to agree with the
        // tool list: "web.fetch are callable" and "fs.read, … is callable"
        // were both printed when the verb followed the agent count. The
        // list goes last because one entry ends in its own descriptor
        // (plugin-mcp's "…, discovered at connect").
        const who = permissive.length === 1 ? 'that agent' : 'those agents';
        writeLine(streams.stdout, uncheckedReason(name) !== undefined
          ? `So at the next daemon start, ${who} would gain ${grants ?? 'what it contributes'} — subject to the caveat above, which setup did not check.`
          : `So the next time the daemon starts, ${who} can call ${grants ?? 'what it contributes'}.`);
        writeLine(streams.stdout, withoutList > 0
          ? 'Give a soul a `tools:` list to narrow that. `stratus plugins` shows who can call what.'
          : 'Narrow that list to say which. `stratus plugins` shows who can call what.');
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
      unlistedLine();
      skillLine();
      return;
    }

    if (shortfall !== undefined) {
      // Allowlisted souls, every one of them short the setting: neither the
      // "callable by" line above nor the "no soul names it" one below is
      // true, and each would send the operator to fix the wrong gate.
      // "No agent" only when every soul has a list: one without a list may
      // reach a safe tool of this plugin, which this menu does not rate.
      writeLine(streams.stdout, `${name} is enabled. ${unlisted.length > 0 ? 'No agent that lists it can call it yet' : 'No agent can call it yet'} — ${label(shortfall.agents)} ${shortfall.one ? 'is' : 'are'} allowlisted for it, but ${shortfall.key} is not set for ${shortfall.one ? 'it' : 'them'} and every call would fail.`);
      writeLine(streams.stdout, `Set ${shortfall.key} for ${shortfall.one ? 'it' : 'them'} under plugins["${name}"].agents, then run \`stratus plugins\` to see the whole chain.`);
      unlistedLine();
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

    // Not "no agent can call it" when a soul has no list: that soul gets
    // whichever of these tools are registered as safe, and which ones those
    // are is the manifest's risk under the operator's floors and overrides,
    // which `stratus plugins` reads and this menu does not re-derive.
    const one = unlisted.length === 1;
    writeLine(streams.stdout, unlisted.length > 0
      ? `${name} is enabled. No soul's \`tools:\` list names what it contributes. ${label(unlisted)} ${one ? 'has' : 'have'} no list, so ${one ? 'it gets' : 'they get'} only the ones registered as safe; \`stratus plugins\` shows which those are. A soul grants the rest by naming them:`
      : `${name} is enabled. No agent can call it yet — every soul in the roster has a \`tools:\` list and none of them names what it contributes, and a soul grants tools by naming them:`);
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
      const more = options.length;
      options.push('More plugins… (checks npm)', 'Back');

      const choice = await prompter.select(
        'Plugins — what your agents can do (installing one grants nothing on its own)',
        options,
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }
      if (choice.index === more) {
        await chooseMorePlugins();
        continue;
      }
      const name = packages[choice.index];
      if (!name) {
        return;
      }
      await choosePlugin(name);
    }
  };

  /**
   * The plugins that release apart from this CLI, from the curated index
   * (`plugin-index.ts`). Asked for, never fetched on its own: it runs npm,
   * which reaches the registry, and the main menu has to work offline.
   *
   * An entry is offered only when its latest release would install and
   * load here (`releaseVerdict` says what that takes), and the install is
   * pinned to that release. The rest are named with the reason, so a plugin
   * missing from the list is not a mystery. Picking one goes to the same
   * install-then-enable path as every other row, which still asks first and
   * still reads what it contributes from its own manifest.
   */
  const chooseMorePlugins = async (): Promise<void> => {
    writeLine(streams.stdout);
    writeLine(streams.stdout, 'Checking npm for plugins…');
    const index = await readPluginIndex(env);
    if (index.source === 'bundled') {
      writeLine(streams.stdout, 'npm has no plugin index this CLI can read, so this is the list it shipped with.');
    }
    const listed = new Set(pluginPackages());
    const candidates = index.entries.filter((entry) => !listed.has(entry.name));
    const releases = await checkPluginReleases(candidates.map((entry) => entry.name), env);
    const host = currentPlatformHost();
    const offered: Array<(typeof candidates)[number] & { version: string }> = [];
    const skipped: string[] = [];
    for (const entry of candidates) {
      const verdict = releaseVerdict(entry.name, releases.get(entry.name) ?? { status: 'unknown' }, host);
      if (verdict.offer) {
        offered.push({ ...entry, version: verdict.version });
      } else {
        // At least one space after a name longer than the column: a
        // third-party name has no @stratusagent/ to shorten.
        skipped.push(`  ${entry.name.replace('@stratusagent/', '').padEnd(17)} ${verdict.reason}`);
      }
    }
    if (skipped.length > 0) {
      writeLine(streams.stdout, 'Not offered here:');
      for (const line of skipped) {
        writeLine(streams.stdout, line);
      }
    }
    if (offered.length === 0) {
      writeLine(streams.stdout, 'There are no more plugins to offer here right now.');
      await prompter.ask('Press Enter to return to the menu… ');
      return;
    }
    const reserved = menuPrefixWidth(offered.length + 1);
    const options = offered.map((entry) => fitMenuRow(`${entry.name.replace('@stratusagent/', '').padEnd(17)} ${entry.description}`, reserved));
    options.push('Back');
    const choice = await prompter.select('More plugins — installing one grants nothing on its own', options);
    if (choice.kind !== 'index' || choice.index === options.length - 1) {
      return;
    }
    const entry = offered[choice.index];
    if (entry) {
      await choosePlugin(entry.name, installSpecifier(entry.name, entry.version));
    }
  };

  /**
   * `install` is what `npm install -g` is handed, when it isn't the bare
   * name: More plugins pins the version it checked.
   */
  const choosePlugin = async (name: string, install: string = name): Promise<void> => {
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
      writeLine(streams.stdout, `Running: npm install -g ${install}`);
      const result = await (env.packageInstaller ?? defaultPackageInstaller)([install])
        .catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
      if (!result.ok) {
        writeLine(streams.stderr, `Could not install: ${result.message}`);
        writeLine(streams.stderr, `Run \`npm install -g ${install}\` yourself, then re-run setup to enable it.`);
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

  return { pluginPackages, pluginEnabled, pluginContributions, pluginsSummary, choosePlugins };
};

export type PluginSetup = ReturnType<typeof createPluginSetup>;
