/**
 * The range every package declares in its `engines` field. Two floors, not
 * one: `node:sqlite` was unflagged in 22.13.0 on the LTS line and in 23.4.0
 * on the 23.x line, so 23.0 through 23.3 are NEWER than the 22.x floor and
 * still ship it behind `--experimental-sqlite`. A plain `>=22.13` admits
 * exactly those releases.
 */
export const SUPPORTED_NODE_RANGE = '>=22.13 <23 || >=23.4';

/**
 * Why the CLI checks a version its manifests already declare: `engines` is
 * advisory. npm and pnpm print EBADENGINE and carry on unless the user has
 * turned on engine-strict, so an install on Node 20 succeeds and the floor
 * is discovered later as an ERR_UNKNOWN_BUILTIN_MODULE for `node:sqlite`,
 * thrown from a lazy import inside whichever command first needed the
 * session store. That error names neither Node nor the version required.
 *
 * Returns the message to print, or undefined when the version is fine —
 * including when it cannot be parsed at all, since an unrecognized build
 * string is a bad reason to refuse to run.
 */
export const unsupportedNodeMessage = (version: string): string | undefined => {
  const parts = version.replace(/^v/, '').split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return undefined;
  }
  const supported = major > 23
    || (major === 23 && minor >= 4)
    || (major === 22 && minor >= 13);
  if (supported) {
    return undefined;
  }
  return `Stratus Agent needs Node 22.13 or newer, and 23.4 or newer on the 23.x line — this is Node ${version.replace(/^v/, '')}.\n`
    + "The gateway's session store uses node:sqlite, unflagged in 22.13.0 and, on the 23.x line, not until 23.4.0.\n"
    + 'Upgrade with `brew install node` on macOS, or your package manager or nvm on Linux.';
};

/**
 * The warning listeners to install in place of Node's default one, so the
 * `node:sqlite` ExperimentalWarning stops being the first thing the CLI
 * prints.
 *
 * The session store imports `node:sqlite`, which is experimental on every
 * Node release this supports — that is exactly why
 * {@link SUPPORTED_NODE_RANGE} is written the way it is — so the warning
 * announces a dependency the project chose deliberately and a user can do
 * nothing about. It landed above `stratusd ready` on every `stratus serve`,
 * and on `stratus schedules`.
 *
 * Filtered rather than silenced wholesale (`--no-warnings` would be the
 * blunt version): every other warning still reaches stderr through the
 * listeners passed in, because a deprecation in our own dependencies is
 * ours to act on.
 */
export const withoutSqliteExperimentalWarning = (
  listeners: readonly ((warning: Error) => void)[],
): ((warning: Error) => void) => (warning) => {
  if (warning.name === 'ExperimentalWarning' && /\bSQLite\b/i.test(warning.message)) {
    return;
  }
  for (const listener of listeners) {
    listener(warning);
  }
};

/**
 * The name Node gives its own `warning` printer. Matched rather than assumed
 * so that a Node which renames it simply stops being filtered — the warning
 * comes back, which is noise, where guessing wrong would rewrite somebody
 * else's listener.
 */
const NODE_DEFAULT_WARNING_LISTENER = 'onWarning';

/**
 * Swap Node's default warning printer for the filtered one above.
 *
 * Node installs its printer as an ordinary `warning` listener, so adding one
 * alongside it would print twice rather than filter; the default has to come
 * off and be handed to the replacement.
 *
 * **Only ever Node's own printer.** Wrapping a listener somebody else
 * registered changes it in two ways that are not ours to change: `listeners()`
 * hands back the *unwrapped* function for a `once` listener, so re-registering
 * it makes it permanent — it then runs for every later warning instead of one
 * — and a caller that keeps a reference can no longer `process.off('warning',
 * theirs)`, because what is registered is this wrapper. So when anything other
 * than the default is present — a `--require` preload, an embedding host — this
 * does nothing at all and the warning stays. A host that took an interest in
 * warnings owns them.
 *
 * Called once from the binary, before anything imports the session store.
 */
export const filterSqliteExperimentalWarning = (process_: NodeJS.EventEmitter = process): void => {
  // rawListeners, not listeners: the wrapper is the registration, and only it
  // carries the once-ness. It matters even here, where the guard below means
  // the sole listener is Node's own — the next reader should not have to know
  // that to see why this is safe.
  const existing = process_.rawListeners('warning') as ((warning: Error) => void)[];
  const [only] = existing;
  if (existing.length !== 1 || only?.name !== NODE_DEFAULT_WARNING_LISTENER) {
    return;
  }
  process_.removeAllListeners('warning');
  process_.on('warning', withoutSqliteExperimentalWarning([only]));
};
