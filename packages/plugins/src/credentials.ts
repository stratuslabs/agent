import type { CredentialResolver, JsonObject, JsonValue } from '@stratusagent/core';

import { PluginManifestError, type PluginManifest } from './manifest.ts';

/**
 * The manifest-bound view a plugin resolves credentials through.
 *
 * The reasoning is `ManifestBoundToolRegistry`'s, one contribution kind
 * over: validating `package.json` before import says what a plugin
 * *claims*, and says nothing about what `setup()` then asks for. Handed the
 * host's resolver directly, a plugin declaring only `search.apiKey` could
 * read any *other* credential the calling agent happens to allowlist — a
 * `github.token` it never declared — which would make `credentials` in the
 * manifest a comment rather than a statement an operator can audit against.
 *
 * Two gates apply in order, and they answer different questions. This one
 * asks whether the **code** declared the name; the resolver behind it asks
 * whether this **agent** was granted it. Neither subsumes the other: an
 * agent may allowlist a name for one plugin and not mean it for another.
 *
 * What this is not: a sandbox. A plugin runs in the daemon's process and
 * can read `process.env` whatever it is handed — `plugins.md` says so, and
 * this does not change it. What it buys is that an honest plugin's manifest
 * is a true statement of what it uses, enforced rather than advisory.
 */
export const createManifestBoundCredentialResolver = (
  manifest: PluginManifest,
  resolver: CredentialResolver,
  config?: JsonObject,
): CredentialResolver => {
  const declared = new Set([...manifest.credentials, ...configuredCredentialNames(manifest, config)]);
  // Bindings are names an approver or operator chose after the plugin
  // loaded, so no manifest can list them; one that says it reads them gets
  // the method, and every other plugin never sees it.
  const envBindings = manifest.envBindings === true ? resolver.envBindings?.bind(resolver) : undefined;
  return {
    async resolve(agent, name) {
      if (!declared.has(name)) {
        throw new PluginManifestError(
          `Plugin ${manifest.packageName} asked for credential ${name}, which its manifest does not declare. `
          + 'Add it to "credentials" in the package\'s stratus manifest.',
        );
      }
      return resolver.resolve(agent, name);
    },
    ...(envBindings !== undefined ? { envBindings } : {}),
  };
};

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The credential names an operator put under the key the manifest names in
 * `credentialsFromConfig`, fleet-wide and in each agent's own entry: the
 * values of that object (`{ GH_TOKEN: "github.token" }` names
 * `github.token`). Read from the config the host loaded, never from
 * anything the plugin hands back, so the plugin can't widen it.
 */
const configuredCredentialNames = (manifest: PluginManifest, config: JsonObject | undefined): string[] => {
  const key = manifest.credentialsFromConfig;
  if (key === undefined || config === undefined) {
    return [];
  }
  const blocks: JsonValue[] = [config[key] ?? null];
  if (isObject(config.agents)) {
    for (const entry of Object.values(config.agents)) {
      if (isObject(entry)) {
        blocks.push(entry[key] ?? null);
      }
    }
  }
  return blocks.flatMap((block) => (isObject(block) ? Object.values(block) : []))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
};
