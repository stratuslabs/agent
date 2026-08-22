import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventBus, JsonObject, Plugin, Skill, SkillRegistry, ToolRegistry } from '@stratusagent/core';
import { createLazySkill, parseSkillDocument } from '@stratusagent/agents';

import {
  parsePluginManifest,
  validatePluginConfig,
  PluginManifestError,
  type PluginManifest,
} from './manifest.ts';
import { ManifestBoundToolRegistry, type PluginToolRecord } from './registry.ts';

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

/** What the daemon knows about one skill a plugin contributed. */
export interface PluginSkillRecord {
  /** The qualified id (`stratus-plugin-github:pr-review`) — the canonical form. */
  id: string;
  /**
   * The bare id, when this package held it at load time. A plugin loading
   * later and wanting the same bare id retires it for both — the registry
   * is the live answer; this is the load-time snapshot.
   */
  alias?: string;
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
  tools: PluginToolRecord[];
  skills: PluginSkillRecord[];
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
   * Where tool output belongs on this machine. Supplied to any plugin whose
   * schema declares `workspaceRoot` and whose operator did not set one —
   * the host knows the platform's answer (`~/.stratus/workspaces`) and a
   * plugin that had to derive it would be re-deriving a path this
   * repository owns.
   */
  workspaceRoot?: string;
  /** Overrides the trusted set. See `isFirstPartyPackage`. */
  trusted?: (packageName: string) => boolean;
}

export interface LoadPluginsResult {
  loaded: LoadedPlugin[];
  failures: PluginLoadFailure[];
}

const WORKSPACE_ROOT_KEY = 'workspaceRoot';

const configFor = (
  block: JsonObject,
  manifest: PluginManifest,
  workspaceRoot: string | undefined,
): JsonObject => {
  const { enabled: _enabled, ...rest } = block;
  const declaresWorkspace = Boolean(
    manifest.config
    && typeof manifest.config.properties === 'object'
    && manifest.config.properties !== null
    && !Array.isArray(manifest.config.properties)
    && WORKSPACE_ROOT_KEY in (manifest.config.properties as JsonObject),
  );
  if (declaresWorkspace && workspaceRoot !== undefined && rest[WORKSPACE_ROOT_KEY] === undefined) {
    return { ...rest, [WORKSPACE_ROOT_KEY]: workspaceRoot };
  }
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
      const resolved = options.host.resolve(specifier);
      const { packageJson, directory } = await packageJsonFor(resolved, specifier);
      const manifest = parsePluginManifest(packageJson, specifier);
      const isTrusted = trusted(manifest.packageName);
      // Validated *after* the host's defaults are folded in, because that
      // is the configuration the plugin will actually be handed: a manifest
      // that declares `workspaceRoot` required would otherwise be refused
      // for missing the very setting the host supplies.
      const config = configFor(block, manifest, options.workspaceRoot);
      validatePluginConfig(manifest, config);

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

      const view = new ManifestBoundToolRegistry({ manifest, target: options.tools, trusted: isTrusted });
      await plugin.setup({ bus: options.bus, tools: view });

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
      const tools = view.commit(owners);
      const skills: PluginSkillRecord[] = [];
      for (const { skill, bareId, record } of stagedSkills) {
        options.skills?.register(skill);
        // The bare id is a convenience the skill holds only while it is
        // unambiguous — an operator skill or a second plugin wanting it
        // leaves this one reachable qualified. See SkillRegistry.
        options.skills?.registerAlias(bareId, skill.id);
        const aliased = options.skills?.resolve(bareId)?.id === skill.id;
        skills.push(aliased ? { ...record, alias: bareId } : record);
      }

      loaded.push({
        package: manifest.packageName,
        name: typeof plugin.name === 'string' && plugin.name.length > 0 ? plugin.name : manifest.packageName,
        manifest,
        trusted: isTrusted,
        tools,
        skills,
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
