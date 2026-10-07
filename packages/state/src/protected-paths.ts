import type { ProtectedPaths } from '@stratusagent/core';

import { ConfigFileError } from './config-file.ts';
import { resolveConfigLocation } from './config-location.ts';
import type { RuntimeSelection } from './config.ts';
import { type StateEnvironment } from './environment.ts';
import {
  credentialsPath,
  gatewayInfoPath,
  gatewayTokenPath,
  globalConfigPath,
  stratusHomePath,
} from './paths.ts';
import { createAgentWorkspaces } from './workspaces.ts';

/**
 * The host's answer to "what may no plugin hand an agent", passed to
 * plugins as `PluginContext.protectedPaths`.
 *
 * The whole Stratus home, minus the agents' workspaces. Everything else in
 * it is the daemon's: the credential store and the control API's token,
 * the config with its plugin `env` blocks, every agent's sessions,
 * memories, and grants, the souls and skills that say what an agent is and
 * may do, the logs, and each plugin's private state. An agent with
 * `roots: ["~"]` could read all of it with `fs.read`, which runs ungated,
 * including another agent's conversations. It could also ask to rewrite
 * its own soul or grants through `fs.write`, which only an approval stood
 * in front of. A list of the secret files alone would leave those open.
 *
 * The secret files are also named one by one, inside the home that already
 * covers them. The guard matches a named file by inode as well, so a hard
 * link to `credentials.json` from inside a workspace is still refused.
 *
 * A trusted config chosen by `--config` or `STRATUS_CONFIG` can live
 * anywhere and holds the same secrets as the global one, so it is
 * protected wherever it is. A project-local `stratus.config.json` is not:
 * it is untrusted, ships in a repository, and is the agent's to read like
 * any other file there.
 */
export const createHostProtectedPaths = (
  env: StateEnvironment,
  selection: Pick<RuntimeSelection, 'configPath'> = {},
): ProtectedPaths => {
  const workspaces = createAgentWorkspaces(env);
  return {
    all: async () => {
      const listed = [
        stratusHomePath(env),
        credentialsPath(env),
        gatewayTokenPath(env),
        gatewayInfoPath(env),
        globalConfigPath(env),
      ];
      try {
        const location = await resolveConfigLocation(selection, env);
        if (location?.trusted === true && !listed.includes(location.path)) {
          listed.push(location.path);
        }
      } catch (error) {
        // An unreadable config is the config loader's failure to report, not
        // this list's: the global one is already covered by the home, and
        // an explicit one is resolved without being read.
        if (!(error instanceof ConfigFileError)) {
          throw error;
        }
      }
      return listed;
    },
    exempt: () => workspaces.all(),
  };
};
