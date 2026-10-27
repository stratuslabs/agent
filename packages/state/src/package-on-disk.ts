import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package a bare specifier names (`@scope/name` or `name`, without a
 * subpath), or `undefined` for anything Node resolves another way: a
 * relative or absolute path, a URL or `node:` builtin, a `#` subpath import.
 */
const packageNameOf = (specifier: string): string | undefined => {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':') || specifier.includes('\\')) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 && parts[0]!.length > 1 && parts[1] !== '' ? `${parts[0]}/${parts[1]}` : undefined;
  }
  return parts[0];
};

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Whether `specifier`'s package has a package.json on disk where Node's ES
 * module resolver looks for it from `base` (the importing module's URL or
 * path): `node_modules/<name>` beside every ancestor of its directory.
 * Anything that is not a bare package name is left to Node (`true`).
 *
 * Ask this before asking Node. Node 24 and later remember a package that
 * failed to resolve for the rest of the process, so once a lookup has
 * missed, installing the package does not help until a restart: the next
 * import fails on "Cannot find package '<dir>/index.js'". Setup checks for
 * the provider, installs it and runs a test turn in one process; a daemon
 * whose turn failed on a missing provider tells the operator to install it
 * and send the message again. A miss found here never reaches Node.
 *
 * Not a resolver: `true` says only that Node is worth asking. It ignores a
 * package importing its own name, which Node allows through `exports`.
 */
export const packageOnDisk = (specifier: string, base: string | URL): boolean => {
  const name = packageNameOf(specifier);
  if (name === undefined) {
    return true;
  }
  const from = typeof base === 'string' && !base.startsWith('file:') ? base : fileURLToPath(base);
  let dir = path.dirname(from);
  for (;;) {
    if (isFile(path.join(dir, 'node_modules', name, 'package.json'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
};

/**
 * Whether `specifier` resolves from the module at `base`, asking Node
 * (`resolve`, that module's `import.meta.resolve`) only once the package
 * is on disk. Resolution, not loading: a package that is installed but
 * fails to load is a different fault, and its import says so.
 */
export const packageResolvable = (
  specifier: string,
  base: string | URL,
  resolve: (specifier: string) => string,
): boolean => {
  if (!packageOnDisk(specifier, base)) {
    return false;
  }
  try {
    resolve(specifier);
    return true;
  } catch {
    return false;
  }
};
