import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentWorkspaces,
  CredentialResolver,
  EventBus,
  JsonObject,
  Plugin,
  Skill,
  SkillRegistry,
  ToolRegistry,
} from '@stratusagent/core';
import { createLazySkill, parseSkillDocument } from '@stratusagent/agents';

import {
  parsePluginManifest,
  parseToolRiskOverrides,
  validatePluginConfig,
  PluginManifestError,
  type PluginManifest,
} from './manifest.ts';
import { createManifestBoundCredentialResolver } from './credentials.ts';
import { ManifestBoundToolRegistry, type PluginToolRecord } from './registry.ts';
import {
  createContributionOwners,
  createContributionTargets,
  ManifestBoundContributions,
  type ChannelSecretSource,
  type ContributionTargets,
  type PluginContributionRecords,
} from './contributions.ts';

/**
 * The two capabilities loading an optional package needs, taken from the
 * caller rather than used here.
 *
 * `import.meta.resolve` answers relative to the module that calls it, so a
 * helper that called its own would answer for this package's node_modules
 * rather than the host's — resolvable from the daemon and resolvable from
 * here are different questions, and only the first one is the one being
 * asked. Callers pass `{ resolve: (id) => import.meta.resolve(id), import:
 * (id) => import(id) }` and get the rule without a copy of it.
 */
export interface OptionalModuleHost {
  resolve(specifier: string): string;
  import(specifier: string): Promise<unknown>;
}

/**
 * Load a package that may not be installed, or report that it is not.
 *
 * Resolution and loading are separate questions, and only the first one
 * means "not installed". Inspecting the import's error cannot tell them
 * apart: a package that IS installed but is missing one of its own
 * dependencies throws `ERR_MODULE_NOT_FOUND` too, naming that dependency —
 * so a broken install would read as an absent one, silently disabling
 * something whose configuration says it should be running.
 *
 * Extracted because there were three copies of it — the Slack adapter, the
 * control API, and the dashboard resolved from inside the control API —
 * and a plugin loader would have been the fourth.
 */
export const loadOptionalModule = async <T = unknown>(
  specifier: string,
  host: OptionalModuleHost,
): Promise<T | undefined> => {
  try {
    host.resolve(specifier);
  } catch {
    return undefined;
  }
  // Resolvable: any failure from here is a real problem with the installed
  // package, and surfaces.
  return (await host.import(specifier)) as T;
};

/** The ABI every loadable plugin exports. See `plugins.md`. */
export type CreatePlugin = (config: JsonObject) => Plugin | Promise<Plugin>;

/**
 * Where a package's own package.json is, given something it resolved to —
 * the parsed manifest source plus the directory it was found in, which is
 * the package root a manifest's relative skill paths resolve against.
 */
const packageJsonFor = async (
  resolvedUrl: string,
  specifier: string,
): Promise<{ packageJson: unknown; directory: string }> => {
  let directory = path.dirname(fileURLToPath(resolvedUrl));
  // Bounded rather than "until the filesystem root": a walk that reaches
  // `/` would read some unrelated package.json and validate a manifest
  // that never described this package.
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const raw = await readFile(path.join(directory, 'package.json'), 'utf8');
      return { packageJson: JSON.parse(raw) as unknown, directory };
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  throw new PluginManifestError(`Could not find a package.json for ${specifier}.`);
};

/**
 * The version an installed package declares, or undefined when it is not
 * installed or names no version.
 *
 * Through `packageJsonFor`, so there is one answer to where a package's
 * package.json is rather than a second walk that drifts from it — and one
 * that is bounded the same way, so a package without its own manifest
 * reports nothing instead of some parent directory's version.
 *
 * Nothing is imported: `stratus update` asks this of every companion
 * package before it decides what to upgrade, and importing a channel
 * adapter to read its version would open the sockets it exists to open.
 */
export const installedPackageVersion = async (
  specifier: string,
  host: Pick<OptionalModuleHost, 'resolve'>,
): Promise<string | undefined> => {
  let resolved: string;
  try {
    resolved = host.resolve(specifier);
  } catch {
    return undefined;
  }
  try {
    const { packageJson } = await packageJsonFor(resolved, specifier);
    const version = (packageJson as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A package's manifest, and the directory it was found in.
 *
 * Nothing here imports the package — the property `parsePluginManifest`
 * exists for, and the reason this is worth having on its own. `stratus
 * plugins` has to answer "what would this contribute, and at what risk"
 * for a daemon that is not running, and running somebody's `setup` to find
 * out would spawn the MCP subprocesses and open the sockets that a listing
 * command has no business starting.
 *
 * `loadPlugins` goes through here too, so there is one answer to where a
 * package's manifest is rather than a second walk that drifts from it.
 */
export const readPluginManifest = async (
  specifier: string,
  host: Pick<OptionalModuleHost, 'resolve'>,
): Promise<{ manifest: PluginManifest; directory: string }> => {
  const { packageJson, directory } = await packageJsonFor(host.resolve(specifier), specifier);
  return { manifest: parsePluginManifest(packageJson, specifier), directory };
};

/**
 * Whether a package's code is trusted — which is to say whether its
 * manifest may declare a tool `safe`.
 *
 * First-party packages ship from this repository and pass its CI; anything
 * else floors at `gated`. An operator can widen the set deliberately, and
 * doing so is the same act as enabling the plugin at all: enablement is the
 * security boundary, and this is a statement about how far it extends.
 */
export const isFirstPartyPackage = (packageName: string): boolean =>
  packageName === '@stratusagent' || packageName.startsWith('@stratusagent/');

/**
 * What the daemon knows about one skill a plugin contributed.
 *
 * Deliberately no `alias` field: whether the bare id still reaches this
 * skill is the registry's to answer, live — a plugin loading later can
 * retire it — and a snapshot here would be a second answer that goes
 * stale the moment it matters. Ask `SkillRegistry.idsFor`.
 */
export interface PluginSkillRecord {
  /** The qualified id (`stratus-plugin-github:pr-review`) — the canonical form. */
  id: string;
  /**
   * The id the manifest declared, which the skill also answers to while no
   * one else claims it. Kept so a host rebuilding its catalog — a live
   * skills reload — can re-run the alias rules rather than re-derive the
   * bare form from the qualified one.
   */
  bareId: string;
  name: string;
  description: string;
  /** The package whose skill this is — provenance, same as tools. */
  package: string;
  /** Absolute path of the SKILL.md, for operators asking where prose lives. */
  path: string;
}

export interface LoadedPlugin {
  /** The package name — a plugin's identity is its package. */
  package: string;
  /** What the plugin called itself in its `Plugin.name`. */
  name: string;
  manifest: PluginManifest;
  trusted: boolean;
  /**
   * The plugin's registered tools, **live**: the same array its view keeps
   * current, so a bridge's reconnect-time registrations and removals show
   * here without the host being told. Read it when answering; do not copy
   * it into a snapshot that will go stale.
   */
  tools: PluginToolRecord[];
  skills: PluginSkillRecord[];
  /** The providers, channels, memory stores, and executors it registered. */
  contributions: PluginContributionRecords;
  /**
   * The plugin itself, so the host can shut it down. A browser plugin holds
   * a Chromium and a listening socket; a daemon that stopped without
   * telling it would leak both.
   */
  instance: Plugin;
}

/** A plugin an operator asked for that did not load, and why. */
export interface PluginLoadFailure {
  package: string;
  reason: string;
}

export interface LoadPluginsOptions {
  /** The `plugins` block: package name to that package's settings. */
  config: Record<string, JsonObject> | undefined;
  host: OptionalModuleHost;
  /** The registry a plugin's tools are committed into once it loads whole. */
  tools: ToolRegistry;
  /**
   * The catalog a plugin's manifest-declared skills register into once it
   * loads whole. Omitted, contributed skills are ignored — a host that
   * cannot serve skills should not half-register them.
   */
  skills?: SkillRegistry;
  bus: EventBus;
  /**
   * The registries a plugin's providers, channels, memory stores, and
   * executors are committed into once it loads whole — the counterparts
   * of `tools`. Any omitted is replaced by a private one: the plugin still
   * loads, its contribution is recorded on `LoadedPlugin`, and it reaches
   * nothing — the way a contributed skill is ignored by a host with no
   * catalog. `stratus run` is that host for channels.
   */
  providers?: ContributionTargets['providers'];
  channels?: ContributionTargets['channels'];
  memory?: ContributionTargets['memory'];
  executors?: ContributionTargets['executors'];
  /**
   * How a channel plugin receives its transport secrets, by kind. A host
   * that omits it refuses the request with a message saying so — a channel
   * needs the daemon's credential store, and a host without one cannot
   * carry a channel at all.
   */
  channelSecrets?: ChannelSecretSource;
  /**
   * Handed to every plugin's `setup` as `PluginContext.credentials`. A host
   * that omits it leaves a plugin needing a key with no way to resolve one
   * — see `PluginContext`.
   */
  credentials?: CredentialResolver;
  /**
   * Where each agent's tool output belongs on this machine, handed to every
   * plugin's `setup` as `PluginContext.workspaces`.
   *
   * This replaced a single `workspaceRoot` the loader filled in for any
   * plugin whose schema declared it. That worked while the workspace was
   * `~/.stratus/workspaces/<id>` — a root plus the agent id — and stopped
   * working the moment it moved inside the agent's own directory, because
   * the id was no longer the last segment and five plugins had each written
   * that shape down. The host answers the whole question now.
   */
  workspaces?: AgentWorkspaces;
  /** Overrides the trusted set. See `isFirstPartyPackage`. */
  trusted?: (packageName: string) => boolean;
  /** Handed to every plugin's `setup` as `PluginContext.log` / `.warn`. */
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface LoadPluginsResult {
  loaded: LoadedPlugin[];
  failures: PluginLoadFailure[];
}

/**
 * Where the filesystem provenance ledger lives, for a host that has no
 * layout of its own. **Stripped** for everyone the loader serves, the way
 * `toolRisks` is, and the reason is the same one that used to make it
 * overwritten: two plugins write the ledger (`tool-fs`, `plugin-mcp`), and
 * an operator who points one of them at a different workspace must not
 * thereby give it a different ledger — `fs.read` consults one, so a file
 * recorded in another reads back unlabelled.
 *
 * It was forced to the host's workspace root while that root was a single
 * path. It is not one any more: the workspace is per agent and the host
 * answers for it through the `workspaces` seam, which both writers use for
 * the ledger and neither can override. One ledger by construction rather
 * than by the loader holding a key down.
 */
const LEDGER_ROOT_KEY = 'ledgerRoot';

/**
 * The configuration a plugin will actually be handed: its own block, minus
 * the keys the host owns.
 *
 * Exported because validating a block against a manifest is only right on
 * *this* object — the raw block still carries the keys the host strips, and
 * `stratus plugins` has to answer whether a daemon would accept a plugin's
 * settings. Answering it from a different object than the loader uses is
 * how a diagnostic ends up disagreeing with the thing it diagnoses.
 */
export const pluginConfigWithHostDefaults = (
  block: JsonObject,
  manifest: PluginManifest,
): JsonObject => {
  // `toolRisks` is the host's key, applied by the view at registration —
  // stripped here so the plugin's code never sees, and so can never
  // second-guess, the operator's risk word.
  const { enabled: _enabled, toolRisks: _toolRisks, [LEDGER_ROOT_KEY]: _ledgerRoot, ...rest } = block;
  // `workspaceRoot` is no longer filled with the host's answer. It was,
  // while there was a single root to fill it with; the host now answers per
  // agent through the `workspaces` seam, so a value here is one an operator
  // wrote, and `workspaceResolver` lets it win — relocating a workspace by
  // writing it down is a thing they are documented to be able to do.
  return rest;
};

/** A declared skill, read and validated but not yet in any registry. */
interface StagedPluginSkill {
  skill: Skill;
  bareId: string;
  record: PluginSkillRecord;
}

/**
 * Read and validate every skill a manifest declares — staged, not
 * registered, the same discipline the tool view keeps: nothing a plugin
 * contributes lands anywhere until the whole plugin has loaded. A skill
 * file that is missing, escapes its package, or will not parse refuses the
 * plugin whole, before its code is imported — a skill is prose, so the
 * host reads it from the declaration alone.
 */
const stageManifestSkills = async (
  manifest: PluginManifest,
  packageDirectory: string,
): Promise<StagedPluginSkill[]> => {
  const staged: StagedPluginSkill[] = [];
  for (const declaration of manifest.contributes.skills) {
    const filePath = path.resolve(packageDirectory, declaration.path);
    // A manifest names files inside its own package; `../` reaching out of
    // it would make "installing a plugin" read arbitrary files under the
    // skill's name.
    if (!filePath.startsWith(packageDirectory + path.sep)) {
      throw new PluginManifestError(
        `Plugin ${manifest.packageName}: skill ${declaration.id} declares a path outside its package: ${declaration.path}`,
      );
    }
    let source: string;
    try {
      source = await readFile(filePath, 'utf8');
    } catch (error) {
      throw new PluginManifestError(
        `Plugin ${manifest.packageName}: skill ${declaration.id} could not be read at ${declaration.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let document;
    try {
      document = parseSkillDocument(source);
    } catch (error) {
      throw new PluginManifestError(
        `Plugin ${manifest.packageName}: skill ${declaration.id} is not a valid SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The canonical id is the package name verbatim plus the declared id —
    // verbose on purpose; see "Naming" in docs/architecture/plugins.md.
    const qualified = `${manifest.packageName}:${declaration.id}`;
    staged.push({
      bareId: declaration.id,
      skill: createLazySkill({ id: qualified, document, read: () => readFile(filePath, 'utf8') }),
      record: {
        id: qualified,
        bareId: declaration.id,
        name: document.name ?? declaration.id,
        description: document.description,
        package: manifest.packageName,
        path: filePath,
      },
    });
  }
  return staged;
};

/**
 * Everything `loadPlugins` checks before it imports a package: that the
 * settings match the manifest's own schema, that any `toolRisks` overrides
 * name tools the manifest declares and risks it permits, and that every
 * skill file the manifest names is present, inside the package, and
 * readable.
 *
 * One function because any of them failing rejects the *whole* plugin — it
 * registers no tools and no skills — so a caller that ran a subset would
 * report a plugin ready that the daemon refuses. `stratus plugins` is that
 * caller, and it got exactly half of this right the first time; the
 * `toolRisks` parse was the third check, missing here while the doc below
 * said it should not be, until setup started asking this question too.
 *
 * Nothing here imports the package, which is what lets a diagnostic ask the
 * question without starting anything.
 *
 * `loadPlugins` calls the same three checks rather than this composition of
 * them, because it needs what the staging and the parse *return* and stages
 * only when it has a registry to put skills in. The checks themselves are
 * shared, so there is no second reading of a schema, an override or a skill
 * path here — only a second caller of each. Anything added to the loader's
 * preflight belongs in both.
 */
export const preflightPlugin = async (
  manifest: PluginManifest,
  directory: string,
  block: JsonObject,
): Promise<void> => {
  // The loader's order, kept: a block whose settings are wrong should say
  // so before its overrides are read, since the overrides are the narrower
  // mistake and the schema error is the one more likely to explain it.
  validatePluginConfig(manifest, pluginConfigWithHostDefaults(block, manifest));
  parseToolRiskOverrides(manifest, block);
  await stageManifestSkills(manifest, directory);
};

/**
 * Turn a `plugins` config block into running capability.
 *
 * Ordered the way the trust model requires: **nothing auto-loads** (only
 * what is listed and enabled, and callers pass this only what a trusted
 * config named), the **manifest is validated before the module is
 * imported**, and `setup()` registers through the manifest-bound view
 * rather than the raw registry.
 *
 * One plugin failing does not take the others — or the daemon — down: a
 * failure is collected, named, and reported to the operator, because a
 * daemon that refuses to start over a mistyped package name is a worse
 * outcome than one running the plugins that do load and saying which did
 * not. What is *never* degraded is the security half: an undeclared name, a
 * collision, or a manifest that will not parse refuses that plugin whole.
 */
export const loadPlugins = async (options: LoadPluginsOptions): Promise<LoadPluginsResult> => {
  const entries = Object.entries(options.config ?? {});
  const trusted = options.trusted ?? isFirstPartyPackage;
  const loaded: LoadedPlugin[] = [];
  const failures: PluginLoadFailure[] = [];
  // Which package owns each name so far, so a collision can name both.
  const owners = new Map<string, string>();
  const contributionOwners = createContributionOwners();
  const targets = createContributionTargets({
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.executors ? { executors: options.executors } : {}),
  });

  for (const [specifier, rawBlock] of entries) {
    const block = rawBlock ?? {};
    if (block.enabled === false) {
      continue;
    }
    // Held outside the try so a plugin that was *constructed* and then
    // failed can still be told to let go. A plugin acquires its resources
    // in `createPlugin` and `setup` — a subscription on the bus, a socket,
    // a child process — and a load that fails after that point leaves them
    // held for the life of a daemon that goes on running without it.
    let instance: Plugin | undefined;
    try {
      const { manifest, directory } = await readPluginManifest(specifier, options.host);
      const isTrusted = trusted(manifest.packageName);
      // Validated on the object the plugin will actually be handed, not on
      // the raw block: the block still carries the keys the host strips, and
      // a schema that forbids extra properties would refuse it for them.
      const config = pluginConfigWithHostDefaults(block, manifest);
      validatePluginConfig(manifest, config);
      const riskOverrides = parseToolRiskOverrides(manifest, block);

      // Skills are read and validated before the module is imported —
      // they are files the manifest names, so a broken one fails the
      // plugin without running any of its code.
      const stagedSkills = options.skills ? await stageManifestSkills(manifest, directory) : [];

      const module = (await options.host.import(specifier)) as { createPlugin?: CreatePlugin };
      if (typeof module.createPlugin !== 'function') {
        throw new PluginManifestError(
          `Plugin ${manifest.packageName} does not export createPlugin(config). See docs/architecture/plugins.md.`,
        );
      }

      const plugin = await module.createPlugin(config);
      if (!plugin || typeof plugin.setup !== 'function') {
        throw new PluginManifestError(
          `Plugin ${manifest.packageName}: createPlugin did not return a plugin with a setup(context).`,
        );
      }
      instance = plugin;

      const view = new ManifestBoundToolRegistry({ manifest, target: options.tools, trusted: isTrusted, riskOverrides });
      const contributions = new ManifestBoundContributions({
        manifest,
        targets,
        owners: contributionOwners,
        ...(options.channelSecrets !== undefined ? { channelSecrets: options.channelSecrets } : {}),
      });
      await plugin.setup({
        bus: options.bus,
        tools: view,
        providers: contributions.providers,
        channels: contributions.channels,
        memory: contributions.memory,
        executors: contributions.executors,
        // Bound to what this plugin's manifest declares, never the host's
        // resolver raw: a plugin must not reach a credential it did not
        // declare merely because the calling agent allowlisted it for
        // something else.
        ...(options.credentials !== undefined
          ? { credentials: createManifestBoundCredentialResolver(manifest, options.credentials) }
          : {}),
        ...(options.workspaces !== undefined ? { workspaces: options.workspaces } : {}),
        ...(options.log !== undefined ? { log: options.log } : {}),
        ...(options.warn !== undefined ? { warn: options.warn } : {}),
      });

      // Everything that can refuse happens before anything commits, so a
      // plugin never lands half — tools registered, skills not. The
      // qualified id makes a canonical collision here mean the same
      // package twice; still refused with both halves consistent.
      if (options.skills) {
        for (const { skill } of stagedSkills) {
          if (options.skills.has(skill.id)) {
            throw new PluginManifestError(
              `Skill id collision: ${skill.id} is already registered. A skill id is unique per install.`,
            );
          }
        }
      }
      // The non-tool kinds are checked before the tools commit and landed
      // after it, so neither half can be live while the other is refused.
      contributions.preflightCommit();
      const tools = view.commit(owners);
      const contributed = contributions.commit();
      const skills: PluginSkillRecord[] = [];
      for (const { skill, bareId, record } of stagedSkills) {
        options.skills?.register(skill);
        // The bare id is a convenience the skill holds only while it is
        // unambiguous — an operator skill or a second plugin wanting it
        // leaves this one reachable qualified. See SkillRegistry, which
        // stays the only answer to whether the alias still resolves.
        options.skills?.registerAlias(bareId, skill.id);
        skills.push(record);
      }

      loaded.push({
        package: manifest.packageName,
        name: typeof plugin.name === 'string' && plugin.name.length > 0 ? plugin.name : manifest.packageName,
        manifest,
        trusted: isTrusted,
        tools,
        skills,
        contributions: contributed,
        instance: plugin,
      });
    } catch (error) {
      // Refused, and then released. A plugin whose `dispose` also throws is
      // ignored: it is already being reported as failed, and the second
      // failure would replace the reason that says why.
      try {
        await instance?.dispose?.();
      } catch {
        // Nothing more to do for a plugin that cannot even let go.
      }
      failures.push({
        package: specifier,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { loaded, failures };
};
