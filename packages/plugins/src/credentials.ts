import type { CredentialResolver } from '@stratusagent/core';

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
): CredentialResolver => {
  const declared = new Set(manifest.credentials);
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
  };
};
