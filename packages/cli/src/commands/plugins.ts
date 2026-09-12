import {
  matchesToolAllowlist,
  raiseRiskTo,
  toolScopesOverlap,
  type ToolRisk,
} from '@stratusagent/core';
import {
  declaredRiskFor,
  isFirstPartyPackage,
  parseToolRiskOverrides,
  preflightPlugin,
  readPluginManifest,
  riskFloorFor,
} from '@stratusagent/plugins';
import { loadRosterSouls, workspacesDirPath } from '@stratusagent/state';
import { describeUnattendedReach } from '../approvals.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import { packageInstalled } from '../loaders.ts';
import type { ParsedPluginsCommand } from '../parse.ts';
import {
  PLUGIN_MARKETPLACE_URL,
  FIRST_PARTY_CAPABILITY_PACKAGES,
  KERNEL_TOOL_NAMES,
} from '../plugin-catalog.ts';
import { soulGrantsTool, rosterSoulsWithConfigured } from '../roster.ts';
import { loadServeApprovals, loadServeApi, loadServePlugins } from '../trusted-config.ts';

/** One tool a plugin's manifest declares, as this machine would have it. */
export interface PluginToolReport {
  name: string;
  /**
   * Declared as a namespace rather than named, so the tools under it arrive
   * when the server connects. `mcp.*` is the case: a name that does not
   * exist yet is not a name that does not exist.
   */
  discovered: boolean;
  /**
   * What `ManifestBoundToolRegistry` would settle on, minus the claim only a
   * running daemon has. An operator's `toolRisks` override *replaces* the
   * manifest's declaration and is bounded only by the package's floor —
   * lowering one is the whole point of the key — and without an override it
   * is the riskier of the declaration and that floor. A registered object
   * may then raise itself further, so this is a floor on what a call will
   * face rather than the last word on it.
   */
  risk: ToolRisk;
  /**
   * Agent ids whose `tools:` allowlist selects this name. Empty is the
   * finding, not the absence of one: installing a plugin grants nothing.
   */
  grantedTo: string[];
}

export interface PluginReport {
  package: string;
  /** Resolvable from this process. */
  installed: boolean;
  /** Named in the trusted config's plugins block, whatever its `enabled`. */
  configured: boolean;
  /** Configured and not switched off. */
  enabled: boolean;
  tools: PluginToolReport[];
  /**
   * Why a daemon would register nothing for this plugin, when it would —
   * an unreadable manifest, or settings its own schema rejects. Enabled and
   * loadable are different questions, and a report that ran them together
   * would call `plugin-mcp` with no `servers` ready to use.
   */
  problem?: string;
  /**
   * What might go wrong that a manifest cannot settle. A name two packages
   * both declare collides only if both *register* it, and registration is
   * `setup()`'s business — so this says "if it does" rather than reporting
   * a failure that may never happen.
   */
  warnings?: string[];
}

export interface PluginsReport {
  approvals: 'headless' | 'remote';
  /**
   * What this machine would really do with a gated call — the mode alone
   * does not say. `headless` still runs one a standing grant, an approved
   * command scope, or an approved site already covers (the engine checks
   * all three before it refuses), and `remote` with no reachable approver
   * denies on arrival rather than asking anybody.
   */
  approvalsSummary: string;
  /**
   * Set when the roster did not load, in which case every `grantedTo` is
   * withheld rather than reported empty — the same rule `stratus skills`
   * follows, and for the same reason: unreadable enablement must not print
   * as "granted to nobody".
   */
  rosterUnreadable: boolean;
  plugins: PluginReport[];
}

/**
 * What this machine's plugins are, and where the chain from installed to
 * callable breaks.
 *
 * Four things have to be true before an agent can call a plugin's tool —
 * the package is installed, a trusted config enables it, the agent's
 * `tools:` names it, and the approval policy lets the call through — and
 * every one of them fails silently on its own. A listing of installed
 * packages answers the first and reads as an answer to all four, which is
 * how an agent ends up with a persona describing tools it never had.
 *
 * Manifests rather than a load: `readPluginManifest` imports nothing, so
 * this never runs a plugin's `setup` — which for the MCP bridge would spawn
 * every configured server's subprocess to answer a question about a
 * daemon that is not running.
 */
export const collectPluginsReport = async (
  command: ParsedPluginsCommand,
  env: CliEnvironment,
  warn: (line: string) => void,
): Promise<PluginsReport> => {
  const pluginsConfig = await loadServePlugins(env, command.configPath, warn);
  const approvals = await loadServeApprovals(env, command.configPath, warn);
  // What the loader would fold in, so the validation below is against the
  // object a daemon on this machine would build.
  const workspaceRoot = workspacesDirPath(env);
  // Read the same way the daemon reads it: installed, and not switched off
  // by the trusted config's `api` block.
  const api = await loadServeApi(env, command.configPath, warn);
  const apiReachable = packageInstalled('@stratusagent/control-api', env) && api.enabled !== false;

  // Who grants what, from the roster a dispatch actually serves — the same
  // resolution `stratus skills` uses, so the two commands cannot disagree
  // about which souls are live.
  let roster: Awaited<ReturnType<typeof loadRosterSouls>> = [];
  let rosterUnreadable = false;
  try {
    const resolved = await rosterSoulsWithConfigured(env, warn, {
      ...(command.configPath !== undefined ? { configPath: command.configPath } : {}),
      includeBuiltIn: true,
    });
    roster = resolved.entries;
    rosterUnreadable = !resolved.complete;
  } catch (error) {
    rosterUnreadable = true;
    warn(`cannot say who is granted what — the roster did not load: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * Which agents a declared name reaches. A soul with no `tools:` key
   * grants every registered tool, which is the opposite of an empty list —
   * so an absent allowlist matches everything here too, or this would
   * report the most permissive agents as the least.
   */
  const grantedTo = (name: string, discovered: boolean): string[] => roster
    .filter((entry) => soulGrantsTool(entry.soul.agent.tools, name, discovered))
    .map((entry) => entry.soul.agent.id);

  // Configured first, in the operator's own order, then the first-party
  // packages they have not configured — the second group is why an install
  // that granted nothing is visible at all.
  const configured = Object.keys(pluginsConfig);
  const packages = [
    ...configured,
    ...FIRST_PARTY_CAPABILITY_PACKAGES.filter((name) => !configured.includes(name)),
  ];

  const plugins: PluginReport[] = [];
  // Which package claimed each literal tool name, across the whole loop.
  // `loadPlugins` keeps the same map and rejects the *later* plugin whole
  // when a registration collides, so a per-plugin check would report two
  // packages ready to serve one name that only one of them will get.
  //
  // Literal declarations only: the registry claims names as they register,
  // and a namespace has none until its server connects.
  // Qualified skill ids, tracked the same way and for the same reason.
  const claimedSkills = new Map<string, string>();
  /**
   * Every name or namespace some plugin may register, in config order.
   *
   * One list rather than a map of literals, because a collision is an
   * *overlap* and overlap has no preferred direction: a later literal falls
   * under an earlier namespace exactly as a later namespace covers an
   * earlier literal. Two one-way passes is what this was, and it missed
   * whichever direction was written second.
   *
   * The daemon's own tools are *registered*, unconditionally, before any
   * plugin loads; a plugin's entry is only a declaration, which is why the
   * two produce different warnings.
   */
  const claims: Array<{ pattern: string; owner: string; registered: boolean }> = KERNEL_TOOL_NAMES
    .map((name) => ({ pattern: name, owner: 'the daemon itself', registered: true }));
  for (const specifier of packages) {
    const block = pluginsConfig[specifier] ?? {};
    const isConfigured = configured.includes(specifier);
    const base: PluginReport = {
      package: specifier,
      installed: packageInstalled(specifier, env),
      configured: isConfigured,
      enabled: isConfigured && block.enabled !== false,
      tools: [],
    };
    // Nothing below runs for a plugin the loader would skip. It skips an
    // absent or switched-off block before it reads a manifest, parses an
    // override, or validates anything — so doing any of that here invents a
    // failure for a plugin that has none, and the renderer shows no tools
    // for one either way. Gating the whole block rather than each call is
    // deliberate: gating them one at a time is what left the override parse
    // unconditional after the preflight moved.
    if (!base.installed || !base.enabled) {
      plugins.push(base);
      continue;
    }
    try {
      const { manifest, directory } = await readPluginManifest(specifier, {
        resolve: (target) => import.meta.resolve(target),
      });
      const floor = riskFloorFor(isFirstPartyPackage(manifest.packageName));
      const overrides = parseToolRiskOverrides(manifest, block);
      // Everything the loader checks before importing, through the loader's
      // own function — a plugin whose settings or skill files it rejects
      // registers nothing, and reading here as enabled is the false clean
      // bill this command exists to stop giving.
      //
      // Only for a plugin the loader would actually reach, though: it skips
      // an absent or switched-off block before validating anything, so
      // preflighting one would report `plugin-mcp` that nobody configured as
      // broken settings instead of as the install to enable.
      if (base.enabled) {
        await preflightPlugin(manifest, directory, block, workspaceRoot);
      }
      // One row per tool the report will name, tracked as they are emitted.
      // A concrete name can be reached more than one way — declared outright
      // *and* covered by a namespace, or covered by two nested namespaces
      // like `mcp.*` and `mcp.linear.*` — and every one of those is a single
      // runtime tool. Filtering each source against the others is what
      // produced two rounds of duplicate rows; one set, checked as rows are
      // added, cannot miss a path.
      const seen = new Set<string>();
      const declared: Array<{ name: string; discovered: boolean; namespace: boolean; declared: ToolRisk }> = [];
      const emit = (row: { name: string; discovered: boolean; namespace: boolean; declared: ToolRisk }): void => {
        if (seen.has(row.name)) {
          return;
        }
        seen.add(row.name);
        declared.push(row);
      };
      // Literal declarations first: a name the manifest states outright is
      // described best by its own entry, not by a namespace that covers it.
      // Risk through `declaredRiskFor`, never the declaration in hand: with
      // overlapping namespaces (`mcp.*` and `mcp.linear.*`) it is the *first*
      // match that registration uses, so reading each entry's own risk would
      // show a narrower namespace at a risk none of its tools will have.
      const riskOf = (name: string, fallback: ToolRisk): ToolRisk => declaredRiskFor(manifest, name) ?? fallback;
      for (const tool of manifest.contributes.tools) {
        emit({ name: tool.name, discovered: false, namespace: false, declared: riskOf(tool.name, tool.risk) });
      }
      for (const entry of manifest.contributes.toolsDiscovered) {
        emit({
          name: entry.namespace,
          discovered: true,
          namespace: true,
          declared: riskOf(entry.namespace, entry.risk),
        });
        // An override under a declared namespace names a concrete tool
        // (`mcp.linear.get_issue`), which is the whole point of the key for
        // a bridge — and it can never equal the namespace, so the namespace
        // row alone would report the default risk for a tool the operator
        // has deliberately re-rated. Listed beside it rather than folded in:
        // they are different risks, and which tools carry the override is
        // the thing worth seeing.
        for (const name of overrides.keys()) {
          // Any wildcard key, not merely the declared namespace itself: the
          // registry applies an override by each concrete *registered*
          // name, so a nested `mcp.linear.*` is exactly as inert as
          // `mcp.*`. Excluding only the equal case left the nested one
          // advertising a re-rating no call gets.
          if (name.endsWith('.*')) {
            continue;
          }
          if (matchesToolAllowlist(name, [entry.namespace])) {
            emit({ name, discovered: true, namespace: false, declared: riskOf(name, entry.risk) });
          }
        }
      }
      // A warning, not a failure. Ownership is claimed at registration —
      // `view.commit(owners)` records what `setup()` actually registered —
      // so a name two manifests both declare collides only if both plugins
      // go on to register it, which nothing here can know. Reporting it as
      // a load failure would condemn a plugin that loads perfectly well
      // because its tool is optional.
      // Keyed by config entry, never by package name: the same package
      // configured through two specifiers is two entries the loader treats
      // as two plugins, and exempting them for sharing a `packageName`
      // would hide the collision an operator is likeliest to create by
      // accident.
      //
      // A plugin never collides with itself: everything it declares is
      // gathered first, checked against what came before, and only then
      // added. That ordering is what makes a manifest declaring both
      // `mcp.ping` and `mcp.*` silent — it registers that name once — and
      // it is load-bearing, so adding claims inside the loop below would
      // reintroduce a warning telling operators to fix a working config.
      const declaredHere = [
        ...manifest.contributes.tools.map((tool) => tool.name),
        ...manifest.contributes.toolsDiscovered.map((entry) => entry.namespace),
      ];
      for (const pattern of declaredHere) {
        for (const claim of claims) {
          if (!toolScopesOverlap(pattern, claim.pattern)) {
            continue;
          }
          const subject = pattern === claim.pattern
            ? `${pattern} is`
            : `${pattern} overlaps ${claim.pattern}, which is`;
          // One sentence for every collision, because a manifest cannot
          // tell when a name registers and the cost turns entirely on
          // that. `ManifestBoundToolRegistry` stages while `owners` is
          // unset and registers live once `commit` sets it, so a clash
          // before the plugin commits rolls it back whole and a clash
          // after refuses that one registration. Neither side of the
          // declaration says which: a bridge's first connect happens
          // inside `setup()` when its server is up and on a reconnect
          // when it is not, and a plugin may hold `context.tools` and
          // register a plainly-named tool from a timer long after.
          //
          // Three rounds of review went into splitting this by
          // declaration kind, then by which side of the pair held the
          // namespace. Both splits claimed knowledge the manifest does
          // not have. Do not reintroduce one.
          base.warnings = [
            ...(base.warnings ?? []),
            `${subject} ${claim.registered ? 'already registered by' : 'also declared by'} ${claim.owner}; `
            + 'if both register that name, a daemon keeps the first and refuses the second registration — '
            + 'the whole plugin, tools and skills together, if it happens before that plugin finishes loading, '
            + 'or just that one tool if it happens after',
          ];
        }
      }
      for (const pattern of declaredHere) {
        claims.push({ pattern, owner: specifier, registered: false });
      }

      // Skills collide on the qualified `packageName:id`, so a clash means
      // one package configured twice — the two-specifier case again. Firmer
      // than the tool warning and worded that way: the loader stages skills
      // from the manifest and refuses the second entry outright rather than
      // waiting to see what `setup()` does. Still "if it loads", since a
      // plugin that fails to import never reaches the check.
      for (const skill of manifest.contributes.skills) {
        const qualified = `${manifest.packageName}:${skill.id}`;
        const owner = claimedSkills.get(qualified);
        if (owner !== undefined) {
          base.warnings = [
            ...(base.warnings ?? []),
            `skill ${qualified} is already declared by ${owner}; if both load, a daemon keeps the first `
            + 'and refuses this one whole, tools and skills together',
          ];
        } else {
          claimedSkills.set(qualified, specifier);
        }
      }
      base.tools = declared.map((tool) => {
        // Never on the namespace row. `parseToolRiskOverrides` accepts a
        // namespace-shaped key, but the registry looks an override up by
        // each concrete *registered* name — so `toolRisks: { "mcp.*": … }`
        // changes no call, and showing the row at that risk would advertise
        // a re-rating the daemon will not honour.
        const override = tool.namespace ? undefined : overrides.get(tool.name);
        return {
          name: tool.name,
          discovered: tool.discovered,
          risk: override !== undefined
            ? raiseRiskTo(override, floor)
            : raiseRiskTo(tool.declared, floor),
          grantedTo: grantedTo(tool.name, tool.discovered),
        };
      });
    } catch (error) {
      // Reported per plugin rather than thrown: one package with a broken
      // manifest must not take down the listing that would have shown it.
      base.problem = error instanceof Error ? error.message : String(error);
    }
    plugins.push(base);
  }

  const mode = approvals.mode ?? 'headless';
  return {
    approvals: mode,
    approvalsSummary: await describeUnattendedReach(
      mode,
      approvals,
      env,
      rosterUnreadable ? undefined : roster.map((entry) => entry.soul.agent.id),
      apiReachable,
    ),
    rosterUnreadable,
    plugins,
  };
};

/** `stratus plugins` — the chain from installed to callable, per plugin. */
export const runPlugins = async (
  command: ParsedPluginsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const report = await collectPluginsReport(command, env, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify(report, null, 2));
    return 0;
  }

  writeLine(streams.stdout, `approvals: ${report.approvalsSummary}`);
  writeLine(streams.stdout);

  for (const plugin of report.plugins) {
    const state = !plugin.installed
      ? 'not installed'
      : !plugin.configured
        ? 'installed, not enabled'
        : !plugin.enabled
          ? 'installed, switched off'
          // Enabled and loadable are separate: a plugin whose settings its
          // own schema rejects is enabled and registers nothing, and saying
          // only "enabled" here is the false clean bill this command exists
          // to stop giving.
          : plugin.problem !== undefined ? 'installed, enabled, will not load' : 'installed, enabled';
    // Padded to a column, but never run together: a package name longer
    // than the column would otherwise touch its own status.
    writeLine(streams.stdout, `${plugin.package.padEnd(29)} ${state}`);

    if (plugin.problem !== undefined) {
      writeLine(streams.stdout, `  a daemon would register nothing for it: ${plugin.problem}`);
      continue;
    }
    if (!plugin.installed) {
      writeLine(streams.stdout, `  install it: npm install -g ${plugin.package}`);
      continue;
    }
    // Nothing is registered for a plugin that will not load, so its tools
    // are not listed: a grant column beside a name no agent can call reads
    // as capability this machine has.
    if (!plugin.configured) {
      writeLine(streams.stdout, `  installing granted nothing — add "${plugin.package}" to the plugins block of a trusted config to load it`);
      continue;
    }
    if (!plugin.enabled) {
      writeLine(streams.stdout, '  switched off — remove "enabled": false to load it');
      continue;
    }
    for (const warning of plugin.warnings ?? []) {
      writeLine(streams.stdout, `  warning: ${warning}`);
    }
    for (const tool of plugin.tools) {
      const granted = report.rosterUnreadable
        ? ''
        : tool.grantedTo.length > 0
          ? ` → ${tool.grantedTo.join(', ')}`
          : ' → nobody, until a soul’s tools: list names it';
      const shape = tool.discovered ? ' (names arrive at connect)' : '';
      writeLine(streams.stdout, `  ${tool.name.padEnd(28)}${tool.risk}${shape}${granted}`);
    }
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, `More plugins — ${PLUGIN_MARKETPLACE_URL}`);
  return 0;
};
