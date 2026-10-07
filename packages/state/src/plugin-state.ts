import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PluginStateDirectory } from '@stratusagent/core';
import { assertDerivedStatePathSync } from '@stratusagent/permissions';
import { type StateEnvironment } from './environment.ts';
import { pluginStateDirPath, stratusHomePath } from './paths.ts';

/**
 * The host's answer to "where does this plugin keep what it remembers",
 * handed to each plugin's `setup` as `PluginContext.stateDirectory`, bound
 * to that plugin's package name by the loader.
 *
 * The join lives here for the reason `createAgentWorkspaces` exists: a
 * plugin that joins its own path onto `~/.stratus` is a copy of the layout,
 * and the first channel plugin with a read position to keep would have
 * been the first copy.
 */
export const createPluginStateDirectories = (env: StateEnvironment) => (packageName: string): PluginStateDirectory => ({
  prepare: () => {
    const home = stratusHomePath(env);
    const directory = pluginStateDirPath(env, packageName);
    // `chmod` follows links, so a planted `plugins/` or `@scope/` would hand
    // its target this mode and receive the state written through it. The
    // walk refuses a link anywhere between the home and the leaf.
    assertDerivedStatePathSync(home, directory, 'directory');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode applies only to what it creates, so a level that
    // already existed keeps whatever it had. Every level below the home is
    // this layout's own, the scope directory included.
    for (let level = directory; level !== home && level.startsWith(home); level = path.dirname(level)) {
      chmodSync(level, 0o700);
    }
    return directory;
  },
});
