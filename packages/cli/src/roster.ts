import { matchesToolAllowlist, toolScopesOverlap, type ToolRisk, type UnlistedTools } from '@stratusagent/core';
import { foldedAgentId, loadRosterSouls, resolveConfiguredSoul } from '@stratusagent/state';
import type { CliEnvironment } from './environment.ts';

/**
 * npm's package-name grammar, and nothing else: an optional `@scope/`, then
 * lowercase alphanumerics with `-`, `_` and `.`, no leading `.` or `_`, 214
 * characters at most.
 *
 * This is what a `plugins` config key has to be, because that key is *also*
 * the module specifier the loader hands `import.meta.resolve`. A version
 * suffix is a thing npm installs and Node cannot resolve, so a key carrying
 * one names a plugin that is permanently absent however many times it is
 * installed.
 */
/**
 * Whether one soul's allowlist reaches a tool a plugin contributes.
 *
 * The second gate, in the form both surfaces need it: `stratus plugins`
 * asks it per tool to build the who-can-call-what table, and the setup
 * menu asks it per agent to say what enabling just granted. An omitted
 * list is the tools registered at risk `safe`, so it reaches a tool only
 * when the caller knows that risk and it is `safe`, except on a home an
 * older build set up (`unlisted: 'every'`), where it reaches every tool,
 * as the daemon reads it (`unlistedToolsFor`); a *declared namespace*
 * is matched by overlap rather than by prefix, since `mcp.linear.*` sits
 * under a granted `mcp.*` and neither is the other's prefix.
 *
 * Shared rather than written twice, and this is the fifth time on this
 * change that mattered: a menu that answers "who can call it" differently
 * from the command that reports it is two answers to one question.
 */
export const soulGrantsTool = (
  tools: readonly string[] | undefined,
  name: string,
  discovered: boolean,
  risk?: ToolRisk,
  unlisted: UnlistedTools = 'safe',
): boolean => {
  if (tools === undefined) {
    return unlisted === 'every' || risk === 'safe';
  }
  return discovered
    ? tools.some((granted) => toolScopesOverlap(granted, name))
    : matchesToolAllowlist(name, tools);
};

/**
 * The souls skill enablement is judged against: the agents directory plus
 * the configured default soul (config `soul:` / STRATUS_SOUL), which may
 * live outside it and is served all the same. The daemon's roster and
 * `stratus agents` both include it, so `skill add --agent` and `stratus
 * skills` must not answer from a narrower set.
 */
export const rosterSoulsWithConfigured = async (
  env: CliEnvironment,
  warn: (line: string) => void,
  options: {
    /**
     * The config whose `soul` key names the configured agent. A caller
     * reading everything else from `--config` and this from the default
     * file would answer for a roster the daemon it describes does not
     * serve.
     */
    configPath?: string;
  } = {},
): Promise<{ entries: Awaited<ReturnType<typeof loadRosterSouls>>; complete: boolean }> => {
  const { configPath } = options;
  const entries = await loadRosterSouls(env, warn);
  let complete = true;
  try {
    const configured = await resolveConfiguredSoul(configPath !== undefined ? { configPath } : {}, env);
    // The gateway's rule for a default soul that never went through the
    // roster's fold check (stateDirectoryPeer in defaultAgentId): an id
    // that names another agent's state directory without being that id,
    // `Ava` beside roster `ava`, is dropped, and turns that name no agent
    // have no default.
    const id = configured?.soul.agent.id;
    const peer = id === undefined
      ? undefined
      : entries.map((candidate) => candidate.soul.agent.id)
        .find((other) => other !== id && foldedAgentId(other) === foldedAgentId(id));
    if (configured && peer !== undefined) {
      warn(
        `the configured default soul at ${configured.path} declares the agent id ${id}, which names the same `
        + `state directory as ${peer}, so the daemon ignores it and turns that name no agent fail. `
        + 'Rename one of the two ids.',
      );
    } else if (configured) {
      const entry = { soul: configured.soul, path: configured.path };
      const clash = entries.findIndex((candidate) => candidate.soul.agent.id === configured.soul.agent.id);
      // Replaced, not skipped: a roster file claiming the configured
      // soul's id is the one the gateway stops serving — both commands
      // must answer for the soul a dispatch actually runs.
      if (clash >= 0) {
        entries[clash] = entry;
      } else {
        // First, as the agent a turn that names none reaches.
        entries.unshift(entry);
      }
    }
  } catch (error) {
    // The configured agent's allowlist was not read, so the set is not
    // the roster — callers making enablement claims must withhold them.
    complete = false;
    warn(`could not read the configured soul: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { entries, complete };
};
