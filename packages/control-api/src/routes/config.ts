import {
  globalConfigPath,
  loadConfigFile,
  resolveConfigLocation,
  saveConfigFile,
  validateConfigFile,
  type StratusConfigFile,
} from '@stratusagent/state';

import { API_PREFIX, ApiError, readJsonObject } from '../http.ts';
import type { Route, RouteContext } from '../routes.ts';

/**
 * Every setting this endpoint will write, and what shape it has to be.
 *
 * `api` is here because GET returns it: leaving it out made the documented
 * whole-document round trip impossible for any daemon configured through an
 * `api` block — send it back and the write is rejected, drop it and the write
 * deletes the binding, because PUT replaces.
 *
 * The types are checked because `loadConfigFile` silently ignores values of
 * the wrong shape. Without this, `{ "provider": 42 }` is written, echoed in a
 * 200, and then read back as absent — the file, the response, and the running
 * daemon all disagreeing about what was just saved.
 */
const CONFIG_KEYS = {
  provider: 'string',
  model: 'string',
  baseUrl: 'string',
  apiKeyEnv: 'string',
  systemPrompt: 'string',
  soul: 'string',
  fallbackModel: 'string',
  fallbackProvider: 'string',
  fallbackBaseUrl: 'string',
  // A boolean the loader accepts, so GET returns it and PUT has to take it
  // back: a text-only OpenAI-compatible model needs `vision: false`, and a
  // round trip that refused the key would block every remote settings save
  // for that operator.
  vision: 'boolean',
  // A tag the loader validates; GET returns it, so PUT takes it back.
  language: 'string',
  approvals: 'object',
  api: 'object',
  // Like `api`: GET returns it, so PUT has to take it back or the documented
  // round trip deletes every principal assignment by omission. Validated
  // by the loader below like the other blocks; it is a trusted-config key,
  // and the only file this endpoint writes is a trusted one.
  principals: 'object',
} as const;

/**
 * Where the daemon's settings live, for this API's purposes.
 *
 * Resolved through the shared chain, then filtered to *trusted* locations —
 * which is exactly the set the operator chose: `--config`, `STRATUS_CONFIG`
 * (and its legacy spelling), or the global `~/.stratus/config.json`. An
 * auto-discovered project-local `stratus.config.json` is untrusted and skipped:
 * that file ships in a repository, and writing settings into somebody's
 * checkout because the daemon happened to start there would surprise
 * everyone — its `api` and `approvals` blocks are ignored anyway.
 *
 * Re-deriving the environment half of that precedence here is what the first
 * version did, and it meant this endpoint read and wrote a different file from
 * the one the daemon was actually running on whenever STRATUS_CONFIG was set:
 * every save appeared to succeed and changed nothing.
 */
const activeConfigPath = async (context: RouteContext): Promise<string> => {
  const location = await resolveConfigLocation(
    context.configPath ? { configPath: context.configPath } : {},
    context.env,
  ).catch(() => undefined);
  return location?.trusted ? location.path : globalConfigPath(context.env);
};

export const configRoutes: Route[] = [
  // ---- config --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/config`,
    async handler(context) {
      const configPath = await activeConfigPath(context);
      let config: StratusConfigFile = {};
      try {
        config = await loadConfigFile(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ApiError(500, 'config_unreadable', error instanceof Error ? error.message : String(error));
        }
      }
      return { path: configPath, config };
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/config`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const incoming = body.config;
      if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
        throw new ApiError(400, 'invalid_body', '"config" must be a JSON object.');
      }

      // Whitelisted, not merged wholesale. An unknown key would be silently
      // preserved and silently ignored by every reader — and this endpoint
      // must not become a way to write into a namespace it does not own.
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(incoming)) {
        // `plugins` is the one key this endpoint reads but does not write.
        // A plugin runs in the daemon's own process, so enabling one is not
        // a settings change; it is the security boundary the whole trust
        // model rests on, and it stays a deliberate edit to a file. Ignored
        // rather than rejected because `GET` hands the whole document back
        // and `PUT` takes the whole document — a 400 here would break the
        // round trip for everyone who has the block, and the value is
        // preserved below rather than dropped by the replace.
        // `executor` and `memoryStore` are the same boundary one step on:
        // they select which of that code an agent's commands run in and
        // where its memories are written, and stay a file edit for the
        // same reason.
        if (key === 'plugins' || key === 'executor' || key === 'memoryStore') {
          continue;
        }
        const expected = (CONFIG_KEYS as Record<string, string>)[key];
        if (!expected) {
          throw new ApiError(
            400,
            'unknown_config_key',
            `${key} is not a setting this API writes. Known keys: ${Object.keys(CONFIG_KEYS).join(', ')}.`,
          );
        }
        if (value === undefined || value === null) {
          continue;
        }
        const shaped = expected === 'object'
          ? typeof value === 'object' && !Array.isArray(value)
          : typeof value === expected;
        if (!shaped) {
          throw new ApiError(
            400,
            'invalid_config_value',
            `"${key}" must be ${expected === 'object' ? 'an object' : `a ${expected}`}; received ${Array.isArray(value) ? 'an array' : typeof value}.`,
          );
        }
        next[key] = value;
      }

      // Through the loader's own validator before anything is written. The
      // shape check above only knows `api` and `approvals` are objects; what
      // is *inside* them is a rule those blocks' parsers own, and an
      // `enabled` of `"false"` would otherwise be written, reported as saved,
      // and then make every later read of the file fail.
      const configPath = await activeConfigPath(context);
      // PUT replaces, so anything this endpoint does not write has to be
      // carried across explicitly or it is deleted by omission — and
      // deleting somebody's plugin list because they saved a model change
      // would silently take capability away from every agent.
      try {
        const current = await loadConfigFile(configPath);
        if (current.plugins) {
          next.plugins = current.plugins;
        }
        for (const key of ['executor', 'memoryStore'] as const) {
          if (current[key] !== undefined) {
            next[key] = current[key];
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ApiError(500, 'config_unreadable', error instanceof Error ? error.message : String(error));
        }
      }
      let validated: StratusConfigFile;
      try {
        validated = validateConfigFile(next, configPath);
      } catch (error) {
        throw new ApiError(400, 'invalid_config_value', error instanceof Error ? error.message : String(error));
      }

      await saveConfigFile(configPath, validated);
      // Settings feed provider resolution, which the gateway re-reads per
      // dispatch — but the default *soul* is roster identity, so a changed
      // one only reaches dispatches after a reload.
      await context.gateway.reloadRoster();
      return { path: configPath, config: validated };
    },
  },
];
