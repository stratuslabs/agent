import os from 'node:os';
import path from 'node:path';

/**
 * `~` and `~/x` mean the same thing here as they do in a shell.
 *
 * Lived in `tool-fs` while it was the only plugin reading a path out of
 * its config block; a memory-store plugin was the second, and a second
 * copy of even four lines is a second answer to what `~` means.
 */
export const expandHome = (value: string, home = os.homedir()): string => {
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/')) {
    return path.join(home, value.slice(2));
  }
  return value;
};
