import {
  DEFAULT_TOOL_RISK,
  matchesToolAllowlist,
  SKILL_READ_TOOL_NAME,
  type JsonObject,
  type JsonValue,
  type ToolRisk,
} from '@stratusagent/core';
import { isValidSkillId } from '@stratusagent/agents';

/**
 * The manifest version this host understands. A plugin declaring anything
 * else is refused rather than read optimistically: the whole point of the
 * manifest is that the daemon can trust what it says about a package it has
 * not imported, and reading an unknown dialect on a guess gives that up.
 */
export const PLUGIN_MANIFEST_VERSION = 1;

/** A tool the manifest names outright. */
export interface PluginToolDeclaration {
  name: string;
  risk: ToolRisk;
}

/**
 * A namespace the manifest claims instead of naming what is inside it —
 * the form a bridge whose tool names exist only at connect time can be
 * declared under. The risk is a ceiling on trust, never a floor the plugin
 * picks: everything discovered under it registers at this risk or higher.
 */
export interface PluginNamespaceDeclaration {
  namespace: string;
  risk: ToolRisk;
}

export interface PluginSkillDeclaration {
  id: string;
  path: string;
}

export interface PluginContributions {
  tools: PluginToolDeclaration[];
  toolsDiscovered: PluginNamespaceDeclaration[];
  /**
   * Skills the package ships as files, loaded by the host from this
   * declaration — a skill is prose, so registering it never requires
   * importing the plugin's code. `path` is relative to the package root
   * and must stay inside it.
   */
  skills: PluginSkillDeclaration[];
}

export interface PluginManifest {
  /** The package name, which is the plugin's identity. */
  packageName: string;
  pluginVersion: number;
  contributes: PluginContributions;
  credentials: string[];
  /** JSON Schema for the plugin's own config block, if it declared one. */
  config?: JsonObject;
}

/** A manifest that cannot be trusted to describe the package it came from. */
export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

/** A config block that does not match what the manifest said it would be. */
export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

// `namespace.verb`, with the nesting a bridged server's names need
// (`mcp.linear.create_issue`). Underscores are allowed inside a segment
// because somebody else's API chose those names; the leading character is
// not, so nothing can be typed to look like a flag or a hidden file.
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*)*\.\*$/;

const RISKS: ToolRisk[] = ['safe', 'gated', 'dangerous'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseRisk = (raw: unknown, where: string): ToolRisk => {
  // Undeclared is `gated`, exactly as it is on a Tool: a manifest entry
  // that forgot to think about risk is held back rather than waved through.
  if (raw === undefined) {
    return DEFAULT_TOOL_RISK;
  }
  if (typeof raw !== 'string' || !RISKS.includes(raw as ToolRisk)) {
    throw new PluginManifestError(
      `Invalid risk in ${where}: ${JSON.stringify(raw)}. Use safe, gated, or dangerous.`,
    );
  }
  return raw as ToolRisk;
};

/**
 * Read the `stratus` field of a package.json into a manifest, or refuse it.
 *
 * Nothing here imports the package — that is the property the manifest
 * exists for. A misconfigured or over-reaching plugin fails at load, with
 * its own name in the message, rather than at the first tool call in the
 * middle of somebody's turn.
 */
export const parsePluginManifest = (packageJson: unknown, specifier: string): PluginManifest => {
  if (!isObject(packageJson)) {
    throw new PluginManifestError(`Package ${specifier} has no readable package.json.`);
  }
  const packageName = typeof packageJson.name === 'string' && packageJson.name.length > 0
    ? packageJson.name
    : specifier;
  const stratus = packageJson.stratus;
  if (!isObject(stratus)) {
    throw new PluginManifestError(
      `Package ${packageName} is not a Stratus plugin: its package.json has no "stratus" manifest.`,
    );
  }

  const version = stratus.pluginVersion;
  if (version !== PLUGIN_MANIFEST_VERSION) {
    throw new PluginManifestError(
      `Plugin ${packageName} declares pluginVersion ${JSON.stringify(version)}; this host understands ${PLUGIN_MANIFEST_VERSION}.`,
    );
  }

  const contributes = isObject(stratus.contributes) ? stratus.contributes : {};
  const tools: PluginToolDeclaration[] = [];
  const toolsDiscovered: PluginNamespaceDeclaration[] = [];
  const skills: PluginSkillDeclaration[] = [];

  if (contributes.tools !== undefined) {
    if (!Array.isArray(contributes.tools)) {
      throw new PluginManifestError(`Plugin ${packageName}: contributes.tools must be an array.`);
    }
    for (const entry of contributes.tools) {
      if (!isObject(entry) || typeof entry.name !== 'string') {
        throw new PluginManifestError(
          `Plugin ${packageName}: every contributes.tools entry needs a "name".`,
        );
      }
      if (!TOOL_NAME_PATTERN.test(entry.name)) {
        throw new PluginManifestError(
          `Plugin ${packageName}: ${JSON.stringify(entry.name)} is not a tool name. Tools are namespace.verb, lowercase (fs.read).`,
        );
      }
      // Reserved, and refused here — before any host has imported or
      // staged anything — because ordering must not decide who owns it:
      // the runner's gates exempt this exact name from the tools
      // allowlist for any agent with a skill enabled, and preserve a
      // pre-registered reader as the host's. A host that loads plugins
      // before building its runner (`stratus run`) would otherwise let a
      // plugin's code stand in for the kernel's skill reader and run
      // under an exemption the soul never granted it.
      if (entry.name === SKILL_READ_TOOL_NAME) {
        throw new PluginManifestError(
          `Plugin ${packageName}: ${SKILL_READ_TOOL_NAME} is the kernel's skill reader and cannot be contributed by a plugin.`,
        );
      }
      tools.push({ name: entry.name, risk: parseRisk(entry.risk, `${packageName} tool ${entry.name}`) });
    }
  }

  if (contributes.toolsDiscovered !== undefined) {
    if (!Array.isArray(contributes.toolsDiscovered)) {
      throw new PluginManifestError(`Plugin ${packageName}: contributes.toolsDiscovered must be an array.`);
    }
    for (const entry of contributes.toolsDiscovered) {
      if (!isObject(entry) || typeof entry.namespace !== 'string') {
        throw new PluginManifestError(
          `Plugin ${packageName}: every contributes.toolsDiscovered entry needs a "namespace".`,
        );
      }
      if (!NAMESPACE_PATTERN.test(entry.namespace)) {
        throw new PluginManifestError(
          `Plugin ${packageName}: ${JSON.stringify(entry.namespace)} is not a namespace. Declare one as a prefix and a star (mcp.*).`,
        );
      }
      // A namespace covering the reader is the same claim as naming it —
      // it would authorize registering skill.read at setup. Same reading
      // of the glob the allowlists use, so the two cannot disagree.
      if (matchesToolAllowlist(SKILL_READ_TOOL_NAME, [entry.namespace])) {
        throw new PluginManifestError(
          `Plugin ${packageName}: namespace ${JSON.stringify(entry.namespace)} covers ${SKILL_READ_TOOL_NAME}, the kernel's skill reader, and cannot be claimed by a plugin.`,
        );
      }
      toolsDiscovered.push({
        namespace: entry.namespace,
        risk: parseRisk(entry.risk, `${packageName} namespace ${entry.namespace}`),
      });
    }
  }

  if (contributes.skills !== undefined) {
    if (!Array.isArray(contributes.skills)) {
      throw new PluginManifestError(`Plugin ${packageName}: contributes.skills must be an array.`);
    }
    for (const entry of contributes.skills) {
      if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.path !== 'string') {
        throw new PluginManifestError(
          `Plugin ${packageName}: every contributes.skills entry needs an "id" and a "path".`,
        );
      }
      if (!isValidSkillId(entry.id)) {
        throw new PluginManifestError(
          `Plugin ${packageName}: ${JSON.stringify(entry.id)} is not a skill id. Skill ids are kebab-case (web-research).`,
        );
      }
      // Refused at the manifest, not discovered mid-registration: the
      // loader preflights staged skills against the shared registry and
      // then registers after committing tools, so a duplicate that only
      // surfaced at registration would leave the plugin half-landed —
      // tools live, first skill live, plugin reported failed.
      if (skills.some((declared) => declared.id === entry.id)) {
        throw new PluginManifestError(
          `Plugin ${packageName}: contributes.skills declares ${JSON.stringify(entry.id)} twice.`,
        );
      }
      skills.push({ id: entry.id, path: entry.path });
    }
  }

  const credentials: string[] = [];
  if (stratus.credentials !== undefined) {
    if (!Array.isArray(stratus.credentials) || stratus.credentials.some((name) => typeof name !== 'string')) {
      throw new PluginManifestError(`Plugin ${packageName}: credentials must be an array of names.`);
    }
    credentials.push(...(stratus.credentials as string[]));
  }

  if (stratus.config !== undefined && !isObject(stratus.config)) {
    throw new PluginManifestError(`Plugin ${packageName}: config must be a JSON Schema object.`);
  }

  return {
    packageName,
    pluginVersion: PLUGIN_MANIFEST_VERSION,
    contributes: { tools, toolsDiscovered, skills },
    credentials,
    ...(isObject(stratus.config) ? { config: stratus.config as JsonObject } : {}),
  };
};

/**
 * The risk a manifest says a tool registers at, or undefined when the
 * manifest does not authorize the name at all.
 *
 * A literal declaration wins over a namespace: a plugin that both owns
 * `mcp.*` at `gated` and names `mcp.ping` at `safe` gets what it wrote for
 * the name it wrote. Namespace matching is `matchesToolAllowlist` — the
 * same reading of `mcp.*` a soul's allowlist gets, because two readings of
 * one glob is two answers to what a package may register.
 */
export const declaredRiskFor = (manifest: PluginManifest, toolName: string): ToolRisk | undefined => {
  const literal = manifest.contributes.tools.find((entry) => entry.name === toolName);
  if (literal) {
    return literal.risk;
  }
  const namespace = manifest.contributes.toolsDiscovered.find(
    (entry) => matchesToolAllowlist(toolName, [entry.namespace]),
  );
  return namespace?.risk;
};

// ---- config validation -----------------------------------------------------

/**
 * Keys the host owns inside a plugin's config block. They are stripped
 * before the plugin's own schema sees the block — a plugin author writes a
 * schema for their settings, not for the machinery that selects them.
 */
export const HOST_CONFIG_KEYS = ['enabled', 'agents'] as const;

const typeOf = (value: JsonValue): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const typeMatches = (expected: string, actual: string): boolean =>
  expected === actual || (expected === 'number' && actual === 'integer');

/**
 * Check a config block against the manifest's schema.
 *
 * A deliberately small subset of JSON Schema — `type`, `properties`,
 * `required`, `items`, `enum`, and `additionalProperties: false` — chosen
 * so that the daemon can answer "is this configuration well-formed" without
 * carrying a validator library into every install. Keywords outside the
 * subset are ignored rather than refused, so a schema written against the
 * full standard still loads; what it buys is fewer checks, never a false
 * pass on a keyword we pretended to understand.
 */
export const validateAgainstSchema = (
  value: JsonValue,
  schema: JsonObject,
  where: string,
  options: { requireRequired?: boolean } = {},
): void => {
  const requireRequired = options.requireRequired ?? true;

  const allowedValues: JsonValue[] | undefined = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (allowedValues && !allowedValues.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value))) {
    throw new PluginConfigError(
      `${where} must be one of ${allowedValues.map((entry) => JSON.stringify(entry)).join(', ')}; got ${JSON.stringify(value)}.`,
    );
  }

  if (typeof schema.type === 'string' && !typeMatches(schema.type, typeOf(value))) {
    throw new PluginConfigError(`${where} must be a ${schema.type}; got ${typeOf(value)}.`);
  }

  if (Array.isArray(value) && schema.items !== undefined && isObject(schema.items)) {
    value.forEach((entry, index) => {
      validateAgainstSchema(entry, schema.items as JsonObject, `${where}[${index}]`, options);
    });
    return;
  }

  if (isObject(value) && !Array.isArray(value)) {
    const properties = isObject(schema.properties) ? (schema.properties as JsonObject) : undefined;
    if (requireRequired && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) {
          throw new PluginConfigError(`${where} is missing required setting ${JSON.stringify(key)}.`);
        }
      }
    }
    if (properties) {
      for (const [key, entry] of Object.entries(value)) {
        const propertySchema = properties[key];
        if (propertySchema === undefined) {
          if (schema.additionalProperties === false) {
            throw new PluginConfigError(`${where} has no setting named ${JSON.stringify(key)}.`);
          }
          continue;
        }
        if (isObject(propertySchema)) {
          validateAgainstSchema(entry, propertySchema as JsonObject, `${where}.${key}`, options);
        }
      }
    }
  }
};

/**
 * Validate one plugin's whole config block — the defaults and every
 * per-agent override — against the manifest's schema.
 *
 * The per-agent entries are checked with `required` relaxed, and that is
 * the point of them: an agent block says what differs for that agent, so
 * holding a two-key override to a schema's required list would make the
 * defaults above it unusable.
 */
export const validatePluginConfig = (manifest: PluginManifest, block: JsonObject): void => {
  const schema = manifest.config;
  if (!schema) {
    return;
  }
  const { enabled: _enabled, agents, ...defaults } = block as JsonObject & { agents?: JsonValue };
  validateAgainstSchema(defaults as JsonObject, schema, `plugins["${manifest.packageName}"]`);

  if (agents === undefined) {
    return;
  }
  if (!isObject(agents)) {
    throw new PluginConfigError(
      `plugins["${manifest.packageName}"].agents must be an object keyed by agent id.`,
    );
  }
  for (const [agentId, entry] of Object.entries(agents as JsonObject)) {
    if (!isObject(entry)) {
      throw new PluginConfigError(
        `plugins["${manifest.packageName}"].agents.${agentId} must be an object of settings.`,
      );
    }
    validateAgainstSchema(
      entry as JsonObject,
      schema,
      `plugins["${manifest.packageName}"].agents.${agentId}`,
      { requireRequired: false },
    );
  }
};

/**
 * One agent's settings for a plugin: its own entry over the defaults, key
 * by key — the shape `approvals` already uses, and the reason a plugin
 * whose settings are an access boundary must call this **per execution**
 * rather than closing over a value at setup. `session.agent.id` is what
 * makes the answer different for two agents; resolving once at setup gives
 * every agent whichever one happened to be asked about first.
 */
export const resolvePluginAgentConfig = (block: JsonObject | undefined, agentId: string): JsonObject => {
  if (!block) {
    return {};
  }
  const { enabled: _enabled, agents, ...defaults } = block as JsonObject & { agents?: JsonValue };
  const overrides = isObject(agents) ? (agents as JsonObject)[agentId] : undefined;
  return isObject(overrides) ? { ...defaults, ...(overrides as JsonObject) } : { ...defaults };
};
