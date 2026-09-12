import type {
  InstalledVersionReader,
  PackageInstallResult,
  PackageInstaller,
  PackageVersionFetcher,
} from './environment.ts';

/** How long `stratus update` waits for npm to answer a version lookup. */
export const VERSION_LOOKUP_TIMEOUT_MS = 15_000;

export const defaultPackageVersionFetcher: PackageVersionFetcher = async (packageName) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('npm', ['view', packageName, 'version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: npmNeedsShell(process.platform),
    });
    let stdout = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // An unreachable registry must degrade to "unknown", never hang the
    // update on someone's terminal.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, VERSION_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 && stdout.trim().length > 0 ? stdout.trim() : undefined));
  });
};

/**
 * Dotted-numeric comparison, enough for this package's own versions:
 * positive when `a` is newer than `b`. Anything unparseable in a segment
 * counts as zero rather than throwing — a weird registry answer must not
 * crash the update that would fix things.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string): number[] =>
    value.trim().replace(/^v/, '').split('.').map((part) => {
      const numeric = Number.parseInt(part, 10);
      return Number.isInteger(numeric) ? numeric : 0;
    });
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * Whether spawning npm needs a shell on this platform.
 *
 * On Windows npm is `npm.cmd`, a batch file: a bare `npm` does not exist as
 * an executable there (PATHEXT is a shell's job, not spawn's), and naming
 * the `.cmd` directly has thrown EINVAL since the fix for CVE-2024-27980 —
 * both land in the caller's error handler, so a Windows setup would report
 * that it could not install and leave Slack and the dashboard missing.
 *
 * `shell: true` concatenates the arguments without escaping — Node 24
 * deprecates the pattern as DEP0190 for exactly that reason — so what may
 * reach it is fenced by `isInstallablePackageName` below rather than by an
 * argument about where the names come from. That argument used to be
 * "every name here is a constant in the CLI's own source", and it stopped
 * being true
 * the moment the Plugins menu started listing package names read from a
 * config.
 */
export const npmNeedsShell = (platform: NodeJS.Platform): boolean => platform === 'win32';

export const isPackageName = (name: string): boolean =>
  name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);

/**
 * A package name, optionally with a plain version — what npm may be handed.
 *
 * A wider question than `isPackageName` and a different one: the updater
 * installs `@stratusagent/cli@latest`, which is a valid thing to install and
 * an invalid thing to import. Using one predicate for both let a versioned
 * `plugins` key through the menu's install offer.
 *
 * The version half is deliberately not npm's full range syntax: `^1.0.0` is
 * a valid range and `^` is cmd.exe's escape character. Only the plain forms
 * this CLI actually passes are accepted, and a range that needs more is a
 * thing to install by hand.
 */
export const isInstallableSpecifier = (specifier: string): boolean => {
  const scoped = specifier.startsWith('@');
  // Split on the `@` that introduces a version, never the one that opens a
  // scope — `@scope/pkg` has both and only the first is part of the name.
  const at = specifier.indexOf('@', scoped ? 1 : 0);
  const name = at === -1 ? specifier : specifier.slice(0, at);
  const version = at === -1 ? undefined : specifier.slice(at + 1);
  if (!isPackageName(name)) {
    return false;
  }
  return version === undefined || /^[a-z0-9][a-z0-9.-]*$/.test(version);
};

export const defaultPackageInstaller: PackageInstaller = async (packages) => {
  const { spawn } = await import('node:child_process');
  // The fence, at the one place that touches a shell, so every caller is
  // behind it — including ones added later, which is how the old invariant
  // was lost.
  const rejected = packages.filter((entry) => !isInstallableSpecifier(entry));
  if (rejected.length > 0) {
    return {
      ok: false,
      message: `${rejected.join(', ')} ${rejected.length === 1 ? 'is not a package name' : 'are not package names'} npm can install. `
        + 'Fix the key in your config, or install it yourself.',
    };
  }
  return new Promise<PackageInstallResult>((resolve) => {
    // npm's own output is inherited rather than captured: a global install
    // runs for tens of seconds, and a silent one is indistinguishable from
    // a setup that has hung. stdin is NOT inherited — the setup prompter
    // owns it, and two readers on one stream race for the same bytes.
    const child = spawn('npm', ['install', '-g', ...packages], {
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: npmNeedsShell(process.platform),
    });
    // `error` and `close` can both fire — a spawn that fails still closes.
    let settled = false;
    const finish = (result: PackageInstallResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.once('error', (error: Error) => {
      finish({ ok: false, message: error.message });
    });
    child.once('close', (code) => {
      finish(code === 0
        ? { ok: true, message: '' }
        : { ok: false, message: `npm exited with code ${code ?? 'unknown'}` });
    });
  });
};

/**
 * What `stratus update` reads to learn which version of a companion this
 * machine actually has. Through `@stratusagent/plugins`, which already owns
 * the bounded walk from a resolved specifier to its package.json — a second
 * copy here would drift from it, and this one would be the copy that
 * decides whether somebody's Slack adapter gets upgraded.
 */
export const defaultInstalledVersionReader: InstalledVersionReader = async (specifier) => {
  const { installedPackageVersion } = await import('@stratusagent/plugins');
  return installedPackageVersion(specifier, { resolve: (target) => import.meta.resolve(target) });
};

export const CLI_VERSION = '0.11.2';

export const CLI_PACKAGE_NAME = '@stratusagent/cli';
