import { readGlobalConfigBlock, readTrustedConfigBlock } from './config-location.ts';
import type { StateEnvironment } from './environment.ts';
import type { LeaseBroker } from './leases.ts';

export interface LeasePolicyOptions {
  broker: LeaseBroker;
  env: StateEnvironment;
  /** The config the process was pinned to (`--config`), when it was. */
  configPath?: string;
  warn: (line: string) => void;
  /** Told when the leased list changes, so a daemon's log says when a key was fenced. */
  log?: (line: string) => void;
}

/**
 * Keep a broker's leased list in step with the trusted config: call the
 * returned function before every leased resolution and every provider
 * call, and a key an operator fences is fenced from its next use — in the
 * daemon and in a `stratus chat` that was already open alike.
 *
 * One implementation for both, because the rule has three parts that must
 * not drift: the trust rule (a project-local file naming the block is
 * ignored in favour of the global one); last-good (a config mid-edit keeps
 * the list it had); and fail-closed before any read (an unknown list
 * refuses every credential, since "unknown" read as "nothing leased" would
 * unfence them all).
 */
export const createLeasePolicyRefresh = (options: LeasePolicyOptions): (() => Promise<void>) => {
  let known = false;
  let lastDescribed: string | undefined;
  return async () => {
    let block = await readTrustedConfigBlock('leases', options.env, options.configPath);
    if (block.status === 'untrusted') {
      options.warn(`ignoring leases in ${block.path}: a project-local config cannot decide which credentials need a lease; using ~/.stratus/config.json instead`);
      block = await readGlobalConfigBlock('leases', options.env);
    }
    if (block.status === 'unreadable') {
      const error = block.error instanceof Error ? block.error : new Error(String(block.error));
      if (!known) {
        options.broker.setLeased(error);
      }
      options.warn(`could not read the leases block (${error.message})${known ? '; using the last one read' : '; refusing every credential until it can be read'}`);
      return;
    }
    const names = block.status === 'present' ? block.value.credentials : [];
    options.broker.setLeased(names);
    known = true;
    const described = names.join(', ');
    if (described !== lastDescribed) {
      // The first read says nothing when nothing is leased: an install
      // that never used leases should not grow a log line about them.
      if (lastDescribed !== undefined || described.length > 0) {
        options.log?.(described.length > 0 ? `leases: ${described} may only be used under a lease` : 'leases: no credential needs a lease');
      }
      lastDescribed = described;
    }
  };
};
