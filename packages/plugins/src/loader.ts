import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventBus, JsonObject, Plugin, ToolRegistry } from '@stratusagent/core';

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

/** Where a package's own package.json is, given something it resolved to. */
const packageJsonFor = async (resolvedUrl: string, specifier: string): Promise<unknown> => {
  let directory = path.dirname(fileURLToPath(resolvedUrl));
  // Bounded rather than "until the filesystem root": a walk that reaches
  // `/` would read some unrelated package.json and validate a manifest
  // that never described this package.
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const raw = await readFile(path.join(directory, 'package.json'), 'utf8');
      return JSON.parse(raw) as unknown;
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

export interface LoadedPlugin {
  /** The package name — a plugin's identity is its package. */
  package: string;
  /** What the plugin called itself in its `Plugin.name`. */
  name: string;
  manifest: PluginManifest;
  trusted: boolean;
  tools: PluginToolRecord[];
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
    try {
      const resolved = options.host.resolve(specifier);
      const manifest = parsePluginManifest(await packageJsonFor(resolved, specifier), specifier);
      const isTrusted = trusted(manifest.packageName);
      validatePluginConfig(manifest, block);

      const module = (await options.host.import(specifier)) as { createPlugin?: CreatePlugin };
      if (typeof module.createPlugin !== 'function') {
        throw new PluginManifestError(
          `Plugin ${manifest.packageName} does not export createPlugin(config). See docs/architecture/plugins.md.`,
        );
      }

      const plugin = await module.createPlugin(configFor(block, manifest, options.workspaceRoot));
      if (!plugin || typeof plugin.setup !== 'function') {
        throw new PluginManifestError(
          `Plugin ${manifest.packageName}: createPlugin did not return a plugin with a setup(context).`,
        );
      }

      const view = new ManifestBoundToolRegistry({ manifest, target: options.tools, trusted: isTrusted });
      await plugin.setup({ bus: options.bus, tools: view });
      const tools = view.commit(owners);

      loaded.push({
        package: manifest.packageName,
        name: typeof plugin.name === 'string' && plugin.name.length > 0 ? plugin.name : manifest.packageName,
        manifest,
        trusted: isTrusted,
        tools,
      });
    } catch (error) {
      failures.push({
        package: specifier,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { loaded, failures };
};
