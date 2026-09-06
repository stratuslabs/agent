import { mkdir } from 'node:fs/promises';

import {
  atLeastAsRisky,
  matchesSkillAllowlist,
  matchesToolAllowlist,
  raiseRiskTo,
  type AgentDefinition,
  type JsonObject,
  type JsonValue,
  type ToolRisk,
} from '@stratusagent/core';
import {
  effectivePluginConfig,
  isFirstPartyPackage,
  parseToolRiskOverrides,
  readPluginManifest,
  riskFloorFor,
  validatePluginConfig,
  type OptionalModuleHost,
  type PluginManifest,
} from '@stratusagent/plugins';

import { withFileLock } from './lock.ts';

/**
 * Agent templates: a soul, an allowlist, and the plugin configuration those
 * tools need, presented together as one bundle an operator approves once.
 *
 * The two gates are untouched — installing a plugin still runs nothing, a
 * trusted config must still enable it, and a soul must still allowlist its
 * tools. What a template removes is the cost of answering both by hand from
 * separate documents. See `docs/roadmap/16-templates.md`.
 *
 * Everything here is *proposal and review*. `planAgentTemplate` computes
 * what the bundle would grant against the configuration that exists;
 * `applyAgentTemplate` commits a plan the operator accepted. They are two
 * calls because the review step is the product: nothing between them is
 * recomputed, so what lands is what was printed.
 */

/**
 * The format version a template declares. A bundle this host does not
 * understand is refused rather than read optimistically — the operator is
 * reviewing what it *says*, so a field this code silently ignores is a
 * grant nobody saw.
 */
export const AGENT_TEMPLATE_VERSION = 1;

/** Everything a template is allowed to know about the agent being created. */
export interface TemplateRenderContext {
  agentId: string;
  agentName: string;
  /** `~/.stratus/workspaces/<id>` — this agent's own directory. */
  workspacePath: string;
}

/** One plugin a template's tools need, and the settings they need from it. */
export interface TemplatePluginRequirement {
  /** Package name: a plugin's identity is its package. */
  package: string;
  /** One sentence for the review screen: why this bundle needs it. */
  reason: string;
  /**
   * Settings the template asks for in the plugin's shared block. Compared
   * against what the config already says, key by key — see
   * `planAgentTemplate` for what agreement, silence, and contradiction each
   * mean.
   */
  settings?: JsonObject;
  /**
   * The block written under `agents.<id>`, rendered from the new agent's
   * identity. A function rather than a string with a placeholder in it: the
   * id is the one thing a template cannot know, and `{{id}}` in a data file
   * is the first step of the DSL this format deliberately does not have.
   *
   * Per-agent by preference wherever a setting is an access boundary — a
   * template that widened the *fleet's* `roots` would hand every existing
   * agent a directory nobody reviewed on their behalf.
   */
  agentSettings?: (context: TemplateRenderContext) => JsonObject;
}

/** A schedule a template proposes. It never creates one; see `plan.schedule`. */
export interface TemplateScheduleProposal {
  /** An interval `schedule.every` accepts: "30m", "1d". */
  every: string;
  /** The prompt each firing would run, phrased to stand alone. */
  prompt: string;
  /** Why this agent is worth running unattended. */
  reason: string;
}

/**
 * A first-party bundle: persona, allowlists, and the plugin configuration
 * behind them.
 *
 * Tools are **literal names, never globs**. A soul may say `web.*` and the
 * planner discloses one as a wildcard, but no shipped template writes one:
 * a glob authorizes every tool in the namespace *including ones registered
 * later*, by an unpinned plugin update nobody reviewed, so what the
 * operator approved would keep widening after they approved it.
 */
export interface AgentTemplate {
  templateVersion: number;
  /** The id `--template` takes. */
  id: string;
  /** One short noun phrase for a menu. */
  title: string;
  /** One sentence: what this agent is for. */
  summary: string;
  /** The name the agent gets unless `--name` says otherwise. */
  defaultName: string;
  /** The soul's body — the persona, in prose. */
  persona: string;
  tools: string[];
  skills: string[];
  /** Names, never values. See `plan.credentials`. */
  credentials: string[];
  plugins: TemplatePluginRequirement[];
  schedule?: TemplateScheduleProposal;
}

// ---------------------------------------------------------------------------
// The plan: what this bundle would grant, against the config that exists
// ---------------------------------------------------------------------------

/** One tool the soul would allowlist, with the risk that actually applies. */
export interface TemplateToolGrant {
  /** The allowlist entry, verbatim — a wildcard stays a wildcard here. */
  entry: string;
  /** True when the entry is a glob rather than a name. */
  wildcard: boolean;
  /** Tool names this entry reaches on this host right now. */
  resolves: TemplateResolvedTool[];
  /**
   * Set when nothing installed answers the entry: an allowlist entry
   * matching no registered tool grants nothing, and saying so is the
   * difference between a bundle that works and one that looks like it does.
   */
  unresolved?: true;
}

/** A tool an allowlist entry reaches, at the risk the host would enforce. */
export interface TemplateResolvedTool {
  name: string;
  /** The risk after the floor and any operator override. */
  risk: ToolRisk;
  /** What the manifest declared, when the floor or an override changed it. */
  declaredRisk?: ToolRisk;
  /** The package it comes from, or `undefined` for a kernel tool. */
  package?: string;
  /** Why the resolved risk differs from the declared one. */
  raisedBy?: 'floor' | 'override';
}

/** What a template's plugin entry meets in the configuration that exists. */
export type TemplatePluginOutcome =
  | {
    status: 'add';
    package: string;
    reason: string;
    /** The block that would be written. */
    settings: JsonObject;
    version?: string;
  }
  | {
    status: 'amend';
    package: string;
    reason: string;
    /** Keys the template needs that the existing block does not have. */
    adds: JsonObject;
    version?: string;
  }
  | {
    status: 'reuse';
    package: string;
    reason: string;
    version?: string;
  }
  | {
    status: 'conflict';
    package: string;
    reason: string;
    conflicts: TemplateSettingConflict[];
    version?: string;
  }
  | {
    status: 'missing';
    package: string;
    reason: string;
    /** What to run before trying again. */
    installCommand: string;
  }
  | {
    status: 'unreadable';
    package: string;
    reason: string;
    /**
     * Why this host would refuse the plugin: a manifest that will not
     * parse, or a config block it rejects. Either way the daemon registers
     * nothing for it, so the tools the plan lists would not exist.
     */
    error: string;
  };

/**
 * The outcomes that are a *merge* decision, as opposed to a statement about
 * whether the package is there at all. `decidePluginConfig` returns only
 * these: it reads settings, and an uninstalled package has none to read.
 */
export type TemplateMergeOutcome = Extract<
  TemplatePluginOutcome,
  { status: 'add' | 'amend' | 'reuse' | 'conflict' }
>;

/** One setting the template contradicts. Both values, never a winner. */
export interface TemplateSettingConflict {
  key: string;
  existing: JsonValue;
  requested: JsonValue;
}

/** A credential the bundle names, and whether the operator has provided it. */
export interface TemplateCredentialNeed {
  name: string;
  /** Where a value was found: this agent's own entry, the fleet's, or none. */
  provided: 'agent' | 'shared' | 'missing';
  /** What to run when it is missing. */
  provideCommand: string;
}

/** A skill the bundle enables, and whether anything installed answers it. */
export interface TemplateSkillNeed {
  entry: string;
  installed: boolean;
}

/**
 * Why a plan cannot be applied. A blocker stops the operation and changes
 * nothing — an uninstalled plugin and a contradicted setting are both cases
 * where committing would make the reviewed summary a lie.
 */
export interface TemplateBlocker {
  kind:
    | 'missing-plugin'
    | 'conflict'
    | 'unreadable-plugin'
    | 'untrusted-config'
    | 'unreadable-config'
    /** Two enabled plugins contribute the same tool name; the daemon refuses one. */
    | 'tool-collision';
  message: string;
}

/** The whole reviewable answer to "what will this bundle let this agent do". */
export interface TemplatePlan {
  template: AgentTemplate;
  /** The identity that would be created. Its id is claimed at apply time. */
  agent: AgentDefinition;
  soulPath: string;
  /** The config file the plugin entries would be written to. */
  configPath: string;
  tools: TemplateToolGrant[];
  skills: TemplateSkillNeed[];
  credentials: TemplateCredentialNeed[];
  plugins: TemplatePluginOutcome[];
  /** Proposed, never created — a schedule is its own reviewed step. */
  schedule?: TemplateScheduleProposal;
  /** Empty when the plan can be applied. */
  blockers: TemplateBlocker[];
}

// ---------------------------------------------------------------------------
// Resolving what a bundle actually grants
// ---------------------------------------------------------------------------

/**
 * The kernel's own tools and their risks, for a summary that must describe
 * every entry a soul lists rather than only the plugin-contributed ones.
 *
 * A table rather than a registry read, because the planner runs in a CLI
 * with no gateway: constructing `memory.remember` needs a memory store,
 * `schedule.every` needs a scheduler, and `agent.delegate` needs a fleet.
 * The risks are the ones those factories set, and the parity test in
 * `templates.test.ts` fails if either side moves.
 */
export const KERNEL_TOOL_RISKS: Readonly<Record<string, ToolRisk>> = {
  'memory.remember': 'safe',
  'memory.recall': 'safe',
  'memory.forget': 'safe',
  'agent.delegate': 'safe',
  'skill.read': 'safe',
  'schedule.every': 'gated',
  'schedule.at': 'gated',
  'schedule.list': 'safe',
  'schedule.cancel': 'safe',
  'message.send': 'gated',
};

const isGlob = (entry: string): boolean => entry.includes('*');

const deepEqual = (a: JsonValue | undefined, b: JsonValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every tool an installed manifest names outright, with its host risk. */
const manifestTools = (
  manifest: PluginManifest,
  block: JsonObject,
): TemplateResolvedTool[] => {
  const floor = riskFloorFor(isFirstPartyPackage(manifest.packageName));
  // The operator's word, read through the same parser the registration view
  // uses — a second reading here could disagree with the one that will
  // actually be enforced, which is the only thing the summary promises.
  // Throws on a block the daemon would refuse, and the caller turns that
  // into a blocker: `loadPlugins` treats it as fatal for the whole plugin,
  // so swallowing it here would print a tool list that stops existing at
  // the next restart.
  const overrides = parseToolRiskOverrides(manifest, block);
  return manifest.contributes.tools.map((declaration) => {
    const override = overrides.get(declaration.name);
    const base = override ?? declaration.risk;
    const risk = raiseRiskTo(base, floor);
    return {
      name: declaration.name,
      risk,
      package: manifest.packageName,
      ...(risk !== declaration.risk ? { declaredRisk: declaration.risk } : {}),
      ...(risk !== base ? { raisedBy: 'floor' as const } : override !== undefined && override !== declaration.risk ? { raisedBy: 'override' as const } : {}),
    };
  });
};

/**
 * A namespace a bridge claims instead of naming what is inside it. Nothing
 * is known until it connects, so the summary says the namespace and the
 * ceiling rather than pretending to a list.
 */
const manifestNamespaces = (manifest: PluginManifest): TemplateResolvedTool[] =>
  manifest.contributes.toolsDiscovered.map((declaration) => ({
    name: declaration.namespace,
    risk: raiseRiskTo(declaration.risk, riskFloorFor(isFirstPartyPackage(manifest.packageName))),
    package: manifest.packageName,
  }));

const resolveGrant = (entry: string, available: TemplateResolvedTool[]): TemplateToolGrant => {
  const wildcard = isGlob(entry);
  const resolves = available.filter((tool) => (
    wildcard ? matchesToolAllowlist(tool.name, [entry]) : tool.name === entry
  ));
  return {
    entry,
    ...(wildcard ? { wildcard: true } : { wildcard: false }),
    resolves,
    ...(resolves.length === 0 ? { unresolved: true as const } : {}),
  };
};

// ---------------------------------------------------------------------------
// The merge decision: a template's plugin entries meet the config that exists
// ---------------------------------------------------------------------------

/**
 * What each of a template's plugin entries would do to the `plugins` block
 * as it stands right now.
 *
 * One function, called twice: once by `planAgentTemplate` to print, and
 * once by `applyAgentTemplate` under the lock to commit. Two readings of
 * "already present with compatible settings" would be two answers, and the
 * one the operator approved is the one that must decide the write.
 *
 * Settings are compared key by key, and the three cases are three different
 * things: a key the block already agrees with is **reused, not rewritten**;
 * a key the block does not have is **added**; a key the block answers
 * differently is a **conflict**, which stops the operation and names both
 * values, because silently keeping either one makes the reviewed summary a
 * lie.
 */
export const decidePluginConfig = (
  template: AgentTemplate,
  context: TemplateRenderContext,
  existingPlugins: Record<string, JsonObject>,
): Map<string, TemplateMergeOutcome> => {
  const decided = new Map<string, TemplateMergeOutcome>();
  for (const requirement of template.plugins) {
    const { package: packageName, reason } = requirement;
    const existing = existingPlugins[packageName];
    const requested: JsonObject = { enabled: true, ...(requirement.settings ?? {}) };
    const perAgent = requirement.agentSettings?.(context);

    if (existing === undefined) {
      decided.set(packageName, {
        status: 'add',
        package: packageName,
        reason,
        settings: perAgent ? { ...requested, agents: { [context.agentId]: perAgent } } : requested,
      });
      continue;
    }

    const conflicts: TemplateSettingConflict[] = [];
    const adds: JsonObject = {};
    for (const [key, value] of Object.entries(requested)) {
      const present = existing[key];
      if (present === undefined) {
        adds[key] = value as JsonValue;
      } else if (!deepEqual(present, value as JsonValue)) {
        conflicts.push({ key, existing: present, requested: value as JsonValue });
      }
    }
    if (conflicts.length > 0) {
      decided.set(packageName, { status: 'conflict', package: packageName, reason, conflicts });
      continue;
    }
    // The per-agent block is usually an addition — a brand-new id has no
    // entry — but "usually" is not "always": an operator can configure
    // `agents.<id>` before the soul exists, and an entry outlives a soul
    // somebody deleted. Either way it is settings the template would be
    // overwriting, so it is compared key by key exactly like the shared
    // ones. Silently replacing a root somebody chose is precisely the
    // failure the conflict rule exists to prevent.
    if (perAgent) {
      const agents = isJsonObject(existing.agents) ? existing.agents : {};
      const mine = agents[context.agentId];
      const mineNow = isJsonObject(mine) ? mine : {};
      const perAgentAdds: JsonObject = {};
      for (const [key, value] of Object.entries(perAgent)) {
        const present = mineNow[key];
        if (present === undefined) {
          perAgentAdds[key] = value as JsonValue;
        } else if (!deepEqual(present, value as JsonValue)) {
          conflicts.push({
            key: `agents.${context.agentId}.${key}`,
            existing: present,
            requested: value as JsonValue,
          });
        }
      }
      if (conflicts.length > 0) {
        decided.set(packageName, { status: 'conflict', package: packageName, reason, conflicts });
        continue;
      }
      if (Object.keys(perAgentAdds).length > 0) {
        adds.agents = { ...agents, [context.agentId]: { ...mineNow, ...perAgentAdds } } as JsonValue;
      }
    }
    decided.set(
      packageName,
      Object.keys(adds).length > 0
        ? { status: 'amend', package: packageName, reason, adds }
        : { status: 'reuse', package: packageName, reason },
    );
  }
  return decided;
};

const conflictBlocker = (
  outcome: Extract<TemplatePluginOutcome, { status: 'conflict' }>,
  templateId: string,
  configPath: string,
): TemplateBlocker => ({
  kind: 'conflict',
  message: `${outcome.package} is already configured in ${configPath} with settings ${templateId} contradicts:\n`
    + outcome.conflicts
      .map((entry) => `  ${entry.key}: yours is ${JSON.stringify(entry.existing)}, the template asks for ${JSON.stringify(entry.requested)}`)
      .join('\n')
    + '\nNothing was changed. Reconcile them by hand, or create this agent without a template.',
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanAgentTemplateOptions {
  template: AgentTemplate;
  /** The identity that would be created — from `defineAgent`, id and all. */
  agent: AgentDefinition;
  /** Where the soul would be written. */
  soulPath: string;
  /** The trusted config the plugin entries would land in. */
  configPath: string;
  /** The config as it stands, or `{}` when there is no file yet. */
  config: { plugins?: Record<string, JsonObject> };
  /** This agent's workspace directory, for per-agent settings. */
  workspacePath: string;
  /** Resolves a package specifier the way the host that will load it does. */
  host: OptionalModuleHost;
  /**
   * `~/.stratus/workspaces` — the host default folded into a plugin's block
   * before it is validated, exactly as the loader folds it. Without it a
   * manifest requiring `workspaceRoot` would be reported as invalid here and
   * load perfectly well in the daemon.
   */
  workspaceRoot?: string;
  /** Named credentials as stored: which the fleet has, which this agent has. */
  credentials: { shared: Record<string, string>; agents: Record<string, Record<string, string>> };
  /** Skill ids installed on this host — operator directory plus plugin skills. */
  installedSkills: readonly string[];
  /** Blockers the caller already knows about (an untrusted or unreadable config). */
  blockers?: readonly TemplateBlocker[];
}

/**
 * What this template would do to this host, resolved.
 *
 * The **effective** result, never the template's requested values: on a
 * host that already enables a plugin with different settings the two
 * differ, and the one the operator must approve is the one that will be
 * true afterwards. Computed here rather than in the CLI because the
 * dashboard renders the same flow, and two implementations of "what will
 * this grant" is two answers to the only question the review step asks.
 *
 * Risks are read off the **resolved** manifests, never off anything the
 * template asserts about itself — a template has no way to say `shell.run`
 * is `safe`, and a plugin manifest that says so about its own third-party
 * code shows the floored value here.
 */
export const planAgentTemplate = async (
  options: PlanAgentTemplateOptions,
): Promise<TemplatePlan> => {
  const { template, agent } = options;
  if (template.templateVersion !== AGENT_TEMPLATE_VERSION) {
    throw new Error(
      `Template ${template.id} declares templateVersion ${template.templateVersion}; this install understands `
      + `${AGENT_TEMPLATE_VERSION}. Upgrade with: npm install -g @stratusagent/cli`,
    );
  }

  const existingPlugins = options.config.plugins ?? {};
  const context: TemplateRenderContext = {
    agentId: agent.id,
    agentName: agent.name,
    workspacePath: options.workspacePath,
  };

  const blockers: TemplateBlocker[] = [...(options.blockers ?? [])];
  const decided = decidePluginConfig(template, context, existingPlugins);
  const outcomes: TemplatePluginOutcome[] = [];
  const available: TemplateResolvedTool[] = Object.entries(KERNEL_TOOL_RISKS)
    .map(([name, risk]) => ({ name, risk }));
  // Who owns each name so far, exactly as `loadPlugins` tracks it, seeded
  // with the kernel's own — its `commit` refuses a plugin whose name the
  // kernel already registered too.
  const owners = new Map<string, string>(
    Object.keys(KERNEL_TOOL_RISKS).map((name) => [name, 'the kernel']),
  );

  /**
   * Every plugin the daemon will load after this write, in the order it
   * will load them: what the config already lists, then what the template
   * adds. `loadPlugins` walks `Object.entries` of the merged block, and a
   * later plugin whose name an earlier one owns is refused whole — so a
   * plan that only looked at the template's own packages would attribute a
   * tool to the package it came from in the template rather than to the one
   * that will actually win, and would miss that the required plugin does
   * not load at all.
   */
  const required = new Map(template.plugins.map((requirement) => [requirement.package, requirement]));
  const loadOrder: string[] = [
    // A package the config disables loads nothing, so it owns no names and
    // is none of this bundle's business — unless the template requires it,
    // in which case `enabled: false` is a value the template contradicts
    // and has to be reported as the conflict it is.
    ...Object.keys(existingPlugins)
      .filter((name) => existingPlugins[name]?.enabled !== false || required.has(name)),
    ...template.plugins
      .map((requirement) => requirement.package)
      .filter((name) => existingPlugins[name] === undefined),
  ];

  for (const packageName of loadOrder) {
    const requirement = required.get(packageName);
    const reason = requirement?.reason ?? 'already enabled in your config';
    const outcome = decided.get(packageName);

    // Resolution and loading are separate questions, and only the first one
    // means "not installed" — the rule `loadOptionalModule` states, applied
    // here because a plan must tell an operator to run npm install rather
    // than show them a broken package's error under the wrong heading.
    try {
      options.host.resolve(packageName);
    } catch {
      if (requirement === undefined) {
        // Already in the config and not installed. The daemon reports that
        // itself and it is not this bundle's business — it contributes no
        // names, so it cannot collide with one either.
        continue;
      }
      const installCommand = `npm install -g ${packageName}`;
      outcomes.push({ status: 'missing', package: packageName, reason, installCommand });
      blockers.push({
        kind: 'missing-plugin',
        message: `${packageName} is not installed, and ${template.id} needs it for ${reason}. `
          + `Install it, then run this again:\n  ${installCommand}`,
      });
      continue;
    }

    let installed;
    try {
      installed = await readPluginManifest(packageName, options.host);
    } catch (error) {
      if (requirement === undefined) {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ status: 'unreadable', package: packageName, reason, error: message });
      blockers.push({
        kind: 'unreadable-plugin',
        message: `${packageName} is installed but its manifest could not be read: ${message}`,
      });
      continue;
    }

    if (outcome?.status === 'conflict') {
      blockers.push(conflictBlocker(outcome, template.id, options.configPath));
      // Reported, and then left alone. Nothing is being written, and a
      // block the operator disabled contributes no names to collide with.
      outcomes.push(installed.version !== undefined
        ? { ...outcome, version: installed.version }
        : outcome);
      continue;
    }
    // The block this plugin will be loaded with after the write: what the
    // config already says, plus whatever this bundle would add to it.
    const merged: JsonObject = outcome?.status === 'add'
      ? outcome.settings
      : outcome?.status === 'amend'
        ? { ...(existingPlugins[packageName] ?? {}), ...outcome.adds }
        : existingPlugins[packageName] ?? {};
    if (merged.enabled === false) {
      continue;
    }

    // Everything the daemon checks before it registers anything: the
    // manifest's own schema over the block with the host's defaults folded
    // in, and the operator's risk words. `loadPlugins` refuses the plugin
    // whole over either, so a plan that skipped them would print a tool
    // list that stops existing at the next restart.
    let tools: TemplateResolvedTool[];
    try {
      validatePluginConfig(installed.manifest, effectivePluginConfig(merged, installed.manifest, options.workspaceRoot));
      tools = manifestTools(installed.manifest, merged);
    } catch (error) {
      if (requirement === undefined) {
        // Somebody else's broken block. It will not load, so it cannot own
        // a name this bundle's plugins need — skipping it is what makes the
        // collision check below describe the daemon rather than the file.
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ status: 'unreadable', package: packageName, reason, error: message });
      blockers.push({
        kind: 'unreadable-plugin',
        message: `${packageName} is installed, but this host would refuse to load it as configured: ${message}\n`
          + `A plugin refused at load registers nothing, so the tools above would not exist. Fix it in ${options.configPath}, then run this again.`,
      });
      continue;
    }

    // Concrete names only. A `toolsDiscovered` namespace is a ceiling on
    // what a bridge may register later, not a reservation: the loader
    // stages and checks the names a plugin actually registers, so two
    // bridges both declaring `mcp.*` collide only if they discover the same
    // tool, which nothing here can know. Treating the namespace string as a
    // registered name would block every plan on a fleet with two bridges.
    const collisions = tools.filter((tool) => owners.has(tool.name));
    if (collisions.length > 0) {
      // Only when it changes what *this* bundle would grant. Two plugins
      // the operator already enables colliding with each other is a real
      // problem and an entirely pre-existing one — the daemon already
      // refuses the later of them — and refusing to create a plugin-free
      // agent over it would be this command failing for something it
      // neither causes nor can fix.
      if (requirement !== undefined) {
        const message = collisions
          .map((tool) => `  ${tool.name} is already contributed by ${owners.get(tool.name)}`)
          .join('\n');
        blockers.push({
          kind: 'tool-collision',
          message: `${packageName} cannot load beside what ${options.configPath} already enables:\n${message}\n`
            + 'A tool name is unique per install, so the daemon refuses the later plugin whole. Disable one of them, then run this again.',
        });
        outcomes.push({
          status: 'unreadable',
          package: packageName,
          reason,
          error: `tool name collision: ${collisions.map((tool) => tool.name).join(', ')}`,
        });
      }
      // Refused either way, so it owns nothing and grants nothing.
      continue;
    }
    for (const tool of tools) {
      owners.set(tool.name, packageName);
    }

    // A plugin the config already enables contributes its names to the
    // collision map above, and nothing else: the operator is not being
    // asked to approve it, and the soul does not allowlist its tools.
    if (requirement === undefined || outcome === undefined) {
      continue;
    }
    available.push(...tools, ...manifestNamespaces(installed.manifest));
    outcomes.push(installed.version !== undefined
      ? { ...outcome, version: installed.version }
      : outcome);
  }

  const agentCredentials = options.credentials.agents[agent.id] ?? {};
  return {
    template,
    agent,
    soulPath: options.soulPath,
    configPath: options.configPath,
    tools: template.tools.map((entry) => resolveGrant(entry, available)),
    skills: template.skills.map((entry) => ({
      entry,
      installed: options.installedSkills.some((id) => matchesSkillAllowlist(id, [entry])),
    })),
    credentials: template.credentials.map((name) => ({
      name,
      provided: agentCredentials[name] !== undefined
        ? 'agent' as const
        : options.credentials.shared[name] !== undefined ? 'shared' as const : 'missing' as const,
      provideCommand: `printf %s "$KEY" | stratus credential set ${name} --agent ${agent.id}`,
    })),
    plugins: outcomes,
    ...(template.schedule ? { schedule: template.schedule } : {}),
    blockers,
  };
};

/** The highest risk anything in a plan grants — the one-line headline. */
export const planRiskCeiling = (plan: TemplatePlan): ToolRisk => {
  let ceiling: ToolRisk = 'safe';
  for (const grant of plan.tools) {
    for (const tool of grant.resolves) {
      if (atLeastAsRisky(tool.risk, ceiling)) {
        ceiling = tool.risk;
      }
    }
  }
  return ceiling;
};

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Thrown when a plan cannot commit. Nothing is written when it is raised. */
export class TemplateApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateApplyError';
  }
}

export interface ApplyAgentTemplateOptions {
  plan: TemplatePlan;
  /**
   * Claim an id nothing else holds and write the soul at it — the shared
   * `claimSoulFile`, handed in rather than called here so a template takes
   * exactly the path a hand-written agent takes. A second path into the
   * roster would be a second set of validation rules to disagree with the
   * first.
   */
  claimSoul: (render: (agent: AgentDefinition) => string) => Promise<{ agent: AgentDefinition; soulPath: string }>;
  /** The soul file's contents for whichever identity the claim settled on. */
  renderSoul: (agent: AgentDefinition) => string;
  /**
   * This agent's workspace directory: re-rendered into the per-agent
   * settings, and created inside the guarded region so a root the config
   * names is a directory that exists.
   */
  workspacePathFor: (agentId: string) => string;
  /** Re-read the config. Called under the lock, and its result is the merge base. */
  readConfig: () => Promise<Record<string, JsonValue>>;
  /**
   * Recompute the whole plan, for the identity actually claimed and against
   * the config as it stands under the lock.
   *
   * Not an optimisation and not a second opinion: it is what makes the
   * commit describe the same host the review described. Re-running only the
   * merge decision catches a setting the template contradicts and nothing
   * else — a writer that added a plugin colliding on `fs.read`, or broke a
   * required plugin's `toolRisks`, contradicts none of the template's keys
   * and would sail through, committing a soul whose plugin the daemon then
   * refuses.
   */
  replan: (agent: AgentDefinition, config: { plugins?: Record<string, JsonObject> }) => Promise<TemplatePlan>;
  /** Write the merged config. Called under the lock. */
  writeConfig: (config: Record<string, JsonValue>) => Promise<void>;
  /** Remove a soul this call wrote, when the config half fails. */
  removeSoul: (soulPath: string) => Promise<void>;
  /** `~/.stratus/config.lock` — the file every writer of the config takes. */
  lockPath: string;
  /**
   * Injected failure point, for the test that proves the rollback rather
   * than asserting it by inspection. Called with the soul on disk and the
   * config not yet written.
   */
  beforeConfigWrite?: () => Promise<void>;
}

export interface AppliedTemplate {
  /** The identity that was created — its id, when a collision forced one. */
  agent: AgentDefinition;
  soulPath: string;
  configPath: string;
  /** Packages whose blocks this write created or amended. */
  configured: string[];
  /**
   * Set when the claim had to take a different id than the plan showed,
   * because something claimed the planned one in between. Disclosed rather
   * than absorbed: the id keys memory, credentials, and the per-agent
   * plugin block the operator just reviewed.
   */
  reassignedFrom?: string;
}

/**
 * Commit a reviewed plan: the soul and the configuration, together or not
 * at all.
 *
 * A template that wrote a soul and then failed on the config would leave an
 * agent whose allowlist references tools nothing enables — the exact
 * half-configured state this whole step exists to prevent. So a failure
 * anywhere after the claim removes the soul it wrote.
 *
 * Everything runs under `lockPath`, and the merge decision is **re-run**
 * there rather than replayed from the plan. The CLI and the dashboard both
 * read-modify-write the same file: the read that decides the merge has to
 * happen inside the lock, or a racing creation's plugin entry is one an
 * operator loses without ever having touched it. Re-running also means a
 * conflict that appeared since the plan was printed still stops the
 * operation, instead of being written over by a decision made against a
 * config that no longer exists.
 */
export const applyAgentTemplate = async (
  options: ApplyAgentTemplateOptions,
): Promise<AppliedTemplate> => {
  const { plan } = options;
  if (plan.blockers.length > 0) {
    throw new TemplateApplyError(
      `${plan.template.id} cannot be applied:\n${plan.blockers.map((blocker) => blocker.message).join('\n')}`,
    );
  }

  return withFileLock(options.lockPath, async () => {
    // Inside the lock: the claim and the config write have to be one
    // operation, or two creations of the same-named agent can settle on the
    // same per-agent block key.
    const claimed = await options.claimSoul(options.renderSoul);
    const configured: string[] = [];
    const workspacePath = options.workspacePathFor(claimed.agent.id);
    try {
      await options.beforeConfigWrite?.();
      // Inside the guard, before the config names it: a per-agent `roots`
      // pointing at a directory that could not be created is a soul whose
      // first `fs.list` fails, and a home where `~/.stratus/workspaces` is
      // unwritable must leave no agent behind rather than one that half
      // works.
      await mkdir(workspacePath, { recursive: true });
      const config = await options.readConfig();
      const rawPlugins = config.plugins;
      const plugins: Record<string, JsonObject> = isJsonObject(rawPlugins as JsonValue)
        ? { ...(rawPlugins as Record<string, JsonObject>) }
        : {};

      // The plan the write is built from, computed here rather than
      // replayed from the one that was printed.
      const fresh = await options.replan(claimed.agent, { plugins });
      if (fresh.blockers.length > 0) {
        throw new TemplateApplyError(
          `${plan.template.id} cannot be applied — the configuration changed since this was reviewed:\n`
          + fresh.blockers.map((blocker) => blocker.message).join('\n'),
        );
      }
      // And what it grants has to still be what was approved. An unrelated
      // config change is fine; one that moves a tool, its risk, or the
      // package behind it means the operator said yes to something else.
      if (JSON.stringify(fresh.tools) !== JSON.stringify(plan.tools)) {
        throw new TemplateApplyError(
          `${plan.template.id} was not created: the configuration changed since this was reviewed, and the tools it `
          + 'would grant are no longer the ones printed. Nothing was written — run the command again to review the '
          + 'current answer.',
        );
      }

      for (const outcome of fresh.plugins) {
        if (outcome.status === 'add') {
          plugins[outcome.package] = outcome.settings;
          configured.push(outcome.package);
        } else if (outcome.status === 'amend') {
          // `agents` merges rather than replaces: `decidePluginConfig` built
          // this agent's entry onto the block it was just handed, which is
          // the block a racing creation's entry is already in.
          plugins[outcome.package] = { ...(plugins[outcome.package] ?? {}), ...outcome.adds };
          configured.push(outcome.package);
        }
      }
      // Only when something actually changed. A template that needs no
      // plugin — or one whose entries the config already satisfies — must
      // not rewrite a file it agrees with: `reuse` means kept exactly as it
      // is, down to not touching its mtime.
      if (configured.length > 0) {
        config.plugins = plugins as unknown as JsonValue;
        await options.writeConfig(config);
      }
    } catch (error) {
      // Removed, not left for the operator to find: a soul whose allowlist
      // names tools nothing enables is worse than no agent at all.
      await options.removeSoul(claimed.soulPath).catch(() => {
        // Nothing more to do — the original failure is the one to report.
      });
      throw error;
    }

    return {
      agent: claimed.agent,
      soulPath: claimed.soulPath,
      configPath: plan.configPath,
      configured,
      ...(claimed.agent.id !== plan.agent.id ? { reassignedFrom: plan.agent.id } : {}),
    };
  });
};
