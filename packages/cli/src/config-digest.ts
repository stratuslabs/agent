import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * A digest of a config file's bytes, or undefined when it cannot be read.
 * The daemon takes one at start and `stratus doctor` takes one now; the two
 * differing is how doctor knows the running daemon is on an older config.
 * Content rather than mtime, so saving a file unchanged is not a reason to
 * restart.
 */
export const configDigest = async (configPath: string): Promise<string | undefined> => {
  try {
    return createHash('sha256').update(await readFile(configPath)).digest('hex');
  } catch {
    return undefined;
  }
};
