import {
  AgentRegistry,
  type AgentDefinition,
  type AgentMemoryStore,
  type AgentRunner,
  type AvatarTheme,
  type JsonObject,
  type Session,
  type Tool,
} from '@stratusagent/core';

// First names only — agents should feel like a teammate you call by name.
// Uniqueness comes from the generated id suffix, never from the name.
const AGENT_NAMES = [
  'Ada', 'Amara', 'Arlo', 'Asha', 'August', 'Beatrix', 'Caleb', 'Camila',
  'Dara', 'Devon', 'Eleni', 'Elio', 'Esme', 'Felix', 'Freya', 'Gideon',
  'Hana', 'Hugo', 'Imani', 'Ines', 'Jasper', 'Juno', 'Kai', 'Kira',
  'Leandro', 'Lucia', 'Mabel', 'Mateo', 'Nadia', 'Nico', 'Odessa', 'Otis',
  'Priya', 'Quinn', 'Rafael', 'Romy', 'Sana', 'Silas', 'Tamsin', 'Theo',
  'Uma', 'Vera', 'Wesley', 'Xiomara', 'Yusuf', 'Zadie',
  'Alba', 'Bruno', 'Celia', 'Dashiell', 'Edie', 'Ferris', 'Greta', 'Hollis',
  'Ida', 'Jules', 'Koa', 'Lior', 'Marisol', 'Nyla', 'Oren', 'Paloma',
  'Reza', 'Sunny', 'Tobias', 'Vada', 'Wren', 'Yara', 'Zeke',
] as const;

/**
 * The one house style every Stratus agent avatar is drawn in. Surfaces
 * (CLI, web, macOS) render this style; agents differ by their name-derived
 * hue and palette, so the team looks cohesive while each member is
 * recognizable.
 */
export const AVATAR_STYLE = 'stratus';

/** Deterministic 32-bit hash so the same seed always yields the same identity. */
const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const hslToHex = (hue: number, saturation: number, lightness: number): string => {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};

/**
 * Generate a human-ish first name. Deterministic when a seed is supplied;
 * random otherwise.
 */
export const generateAgentName = (seed?: string): string => {
  const value = seed !== undefined
    ? hashSeed(seed)
    : Math.floor(Math.random() * 0xffffffff);
  return AGENT_NAMES[value % AGENT_NAMES.length] ?? 'Quinn';
};

/**
 * Derive an avatar theme from a name: a stable hue and a small palette in
 * the shared Stratus house style. Consumers (CLI, web, macOS) draw the
 * actual image from this so the agent looks the same on every surface.
 */
export const generateAvatarTheme = (name: string): AvatarTheme => {
  const value = hashSeed(name);
  const hue = value % 360;
  return {
    seed: name,
    hue,
    palette: [
      hslToHex(hue, 70, 55),
      hslToHex((hue + 30) % 360, 65, 70),
      hslToHex((hue + 180) % 360, 60, 45),
    ],
    style: AVATAR_STYLE,
  };
};

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';

export interface DefineAgentInput {
  name?: string;
  id?: string;
  instructions?: string;
  tools?: string[];
  credentials?: string[];
  avatar?: AvatarTheme;
  /** Seed for deterministic identity generation (used in tests). */
  seed?: string;
}

// Ids for generated names carry a short unique suffix: the name pool is
// small, and two agents that draw the same name must still be two people —
// memory and access scopes are keyed by id. Deterministic when seeded.
const generatedIdSuffix = (seed?: string): string => {
  const value = seed !== undefined
    ? hashSeed(`${seed}:id`)
    : Math.floor(Math.random() * 0xffffffff);
  return value.toString(36).padStart(4, '0').slice(0, 4);
};

/**
 * One-call agent creation. Everything is optional: with no input you get a
 * fresh identity with a human-ish name and a matching avatar theme.
 * Explicitly named agents keep a clean, predictable slug id.
 */
export const defineAgent = (input: DefineAgentInput = {}): AgentDefinition => {
  const nameWasGenerated = input.name === undefined;
  const name = input.name ?? generateAgentName(input.seed);
  return {
    id: input.id ?? (nameWasGenerated
      ? `${slugify(name)}-${generatedIdSuffix(input.seed)}`
      : slugify(name)),
    name,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    avatar: input.avatar ?? generateAvatarTheme(name),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.credentials ? { credentials: input.credentials } : {}),
  };
};

/**
 * A parsed soul file: the agent it defines plus optional runtime hints.
 * Souls are markdown with frontmatter — the frontmatter carries structured
 * identity (name, tools, credentials, provider, model) and the body is the
 * persona itself, written in prose.
 */
export interface ParsedSoul {
  agent: AgentDefinition;
  /** Provider the soul prefers (e.g. "anthropic"). Runtimes may override. */
  provider?: string;
  /** Model the soul prefers (e.g. "claude-opus-5"). Runtimes may override. */
  model?: string;
}

export interface ParseSoulOptions {
  /** Seed for deterministic identity generation when the soul has no name. */
  seed?: string;
}

const SOUL_SCALAR_KEYS = ['name', 'id', 'provider', 'model'] as const;
const SOUL_LIST_KEYS = ['tools', 'credentials'] as const;

type SoulScalarKey = (typeof SOUL_SCALAR_KEYS)[number];
type SoulListKey = (typeof SOUL_LIST_KEYS)[number];

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

interface SoulFrontmatter {
  scalars: Partial<Record<SoulScalarKey, string>>;
  lists: Partial<Record<SoulListKey, string[]>>;
}

// A deliberately tiny frontmatter dialect: `key: value` scalars and block
// lists of `- item` lines. Enough for souls, no YAML dependency.
const parseSoulFrontmatter = (lines: string[]): SoulFrontmatter => {
  const scalars: SoulFrontmatter['scalars'] = {};
  const lists: SoulFrontmatter['lists'] = {};
  let currentList: string[] | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0 || line.trim().startsWith('#')) {
      continue;
    }

    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem) {
      if (!currentList) {
        throw new Error(`Soul frontmatter has a list item outside a list: "${line.trim()}"`);
      }
      const item = unquote(listItem[1] ?? '');
      if (item.length > 0) {
        currentList.push(item);
      }
      continue;
    }

    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!entry) {
      throw new Error(`Soul frontmatter line is not "key: value": "${line.trim()}"`);
    }

    const key = entry[1] ?? '';
    const value = entry[2] ?? '';
    currentList = undefined;

    if ((SOUL_LIST_KEYS as readonly string[]).includes(key)) {
      const list: string[] = [];
      lists[key as SoulListKey] = list;
      const inline = value.trim();
      if (inline.length > 0) {
        // Inline form: tools: [a, b]
        const match = /^\[(.*)\]$/.exec(inline);
        if (!match) {
          throw new Error(`Soul frontmatter list "${key}" must be a block list or [a, b]: "${inline}"`);
        }
        for (const item of (match[1] ?? '').split(',')) {
          const cleaned = unquote(item);
          if (cleaned.length > 0) {
            list.push(cleaned);
          }
        }
      } else {
        currentList = list;
      }
      continue;
    }

    if (!(SOUL_SCALAR_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown soul frontmatter key: "${key}". Supported keys: ${[...SOUL_SCALAR_KEYS, ...SOUL_LIST_KEYS].join(', ')}.`,
      );
    }

    const scalar = unquote(value);
    if (scalar.length === 0) {
      throw new Error(`Soul frontmatter key "${key}" has no value.`);
    }
    scalars[key as SoulScalarKey] = scalar;
  }

  return { scalars, lists };
};

/**
 * Parse a soul file (markdown with optional frontmatter) into an agent
 * definition. The body becomes the agent's instructions; a missing name is
 * generated, so the smallest possible soul is just prose.
 */
export const parseSoul = (source: string, options: ParseSoulOptions = {}): ParsedSoul => {
  const normalized = source.replace(/\r\n/g, '\n');
  let frontmatter: SoulFrontmatter = { scalars: {}, lists: {} };
  let body = normalized;

  const opener = /^---[ \t]*\n/.exec(normalized);
  if (opener) {
    const closer = /\n---[ \t]*(\n|$)/.exec(normalized.slice(opener[0].length - 1));
    if (!closer || closer.index === undefined) {
      throw new Error('Soul frontmatter opened with --- but never closed.');
    }
    const frontmatterEnd = opener[0].length - 1 + closer.index;
    frontmatter = parseSoulFrontmatter(
      normalized.slice(opener[0].length, frontmatterEnd).split('\n'),
    );
    body = normalized.slice(frontmatterEnd + closer[0].length);
  }

  const instructions = body.trim();
  const { scalars, lists } = frontmatter;

  const agent = defineAgent({
    ...(scalars.name ? { name: scalars.name } : {}),
    ...(scalars.id ? { id: scalars.id } : {}),
    ...(instructions ? { instructions } : {}),
    ...(lists.tools ? { tools: lists.tools } : {}),
    ...(lists.credentials ? { credentials: lists.credentials } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });

  return {
    agent,
    ...(scalars.provider ? { provider: scalars.provider } : {}),
    ...(scalars.model ? { model: scalars.model } : {}),
  };
};

/**
 * Render an agent definition as a soul file, ready to save and edit. The
 * inverse of parseSoul for round-tripping `stratus agent new` output.
 */
export const formatSoul = (soul: ParsedSoul): string => {
  const lines: string[] = ['---', `name: ${soul.agent.name}`, `id: ${soul.agent.id}`];

  if (soul.provider) {
    lines.push(`provider: ${soul.provider}`);
  }
  if (soul.model) {
    lines.push(`model: ${soul.model}`);
  }
  for (const [key, values] of [
    ['tools', soul.agent.tools],
    ['credentials', soul.agent.credentials],
  ] as const) {
    if (values && values.length > 0) {
      lines.push(`${key}:`);
      for (const value of values) {
        lines.push(`  - ${value}`);
      }
    }
  }

  lines.push('---', '');
  lines.push(soul.agent.instructions ?? 'Describe who this agent is and how they talk.');
  lines.push('');
  return lines.join('\n');
};

export const MEMORY_TOOL_NAME = 'memory.remember';

/**
 * A tool that lets an agent write to its own long-term memory. Entries are
 * keyed by the session's agent id, so what one agent learns stays exclusively
 * that agent's knowledge — and follows it to every channel and thread.
 */
export const createRememberTool = (store: AgentMemoryStore): Tool => ({
  name: MEMORY_TOOL_NAME,
  description: 'Save a fact to your long-term memory so you can recall it in future conversations on any channel.',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact to remember, phrased so it makes sense later without context.' },
    },
    required: ['fact'],
  },
  async execute(input: JsonObject, session: Session) {
    const fact = typeof input.fact === 'string' ? input.fact.trim() : '';
    if (!fact) {
      throw new Error('memory.remember requires a non-empty "fact" string.');
    }
    const entry = await store.append(session.agent.id, fact, { sessionId: session.id });
    return { remembered: true, id: entry.id };
  },
});

export const DELEGATE_TOOL_NAME = 'agent.delegate';

/**
 * Runs a delegated sub-session. A plain runner works when every agent
 * shares one provider; a host with per-agent provider routing (the
 * gateway) supplies its own dispatcher so the target runs on the
 * target's resolved provider and credentials — never the delegator's.
 */
export type DelegateDispatch = (input: {
  sessionId: string;
  agent: AgentDefinition;
  userMessage: string;
  metadata: JsonObject;
  /** The parent turn's abort signal — a cancelled parent cancels the delegated run too. */
  signal?: AbortSignal;
}) => Promise<Session>;

export type DelegateToolOptions = {
  registry: AgentRegistry;
  /** Maximum delegation depth to stop orchestrator loops. Default 3. */
  maxDepth?: number;
} & ({ runner: AgentRunner; dispatch?: never } | { dispatch: DelegateDispatch; runner?: never });

const DEFAULT_MAX_DELEGATION_DEPTH = 3;

/**
 * The orchestrator primitive: a tool that runs another agent in its own
 * sub-session (with that agent's memory, tool allowlist, and credentials)
 * and returns its final reply as the tool result.
 */
export const createDelegateTool = ({
  registry,
  runner,
  dispatch,
  maxDepth = DEFAULT_MAX_DELEGATION_DEPTH,
}: DelegateToolOptions): Tool => {
  const runDelegated: DelegateDispatch = dispatch ?? ((input) => runner.run(input));
  // Sub-session ids must be unique even when one orchestrator delegates to
  // the same target repeatedly, and must stay unique across tool rebuilds
  // sharing one SessionStore — so a counter alone is not enough.
  let delegationCount = 0;
  const uniqueSuffix = (): string =>
    `${delegationCount}-${Math.random().toString(36).slice(2, 10)}`;

  return {
  name: DELEGATE_TOOL_NAME,
  description: 'Delegate a task to another agent by name and get their reply back.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Name or id of the agent to delegate to.' },
      prompt: { type: 'string', description: 'The task or question for that agent.' },
    },
    required: ['agent', 'prompt'],
  },
  async execute(input: JsonObject, session: Session, context) {
    const targetRef = typeof input.agent === 'string' ? input.agent : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!targetRef || !prompt) {
      throw new Error('agent.delegate requires "agent" and "prompt" strings.');
    }

    const depth = typeof session.metadata?.delegationDepth === 'number'
      ? session.metadata.delegationDepth
      : 0;
    if (depth >= maxDepth) {
      throw new Error(`Delegation depth limit reached (${maxDepth}).`);
    }

    const target = registry.get(targetRef) ?? registry.getByName(targetRef);
    if (!target) {
      throw new Error(`Agent not found: ${targetRef}`);
    }
    if (target.id === session.agent.id) {
      throw new Error('An agent cannot delegate to itself.');
    }

    delegationCount += 1;
    const result = await runDelegated({
      sessionId: `${session.id}:delegate:${target.id}:${depth + 1}:${uniqueSuffix()}`,
      agent: target,
      userMessage: prompt,
      metadata: {
        delegationDepth: depth + 1,
        delegatedBy: session.agent.id,
        rootSessionId: typeof session.metadata?.rootSessionId === 'string'
          ? session.metadata.rootSessionId
          : session.id,
      },
      // A cancelled parent turn cancels the delegated run with it —
      // otherwise the parent cannot settle until the target gives up.
      ...(context?.signal ? { signal: context.signal } : {}),
    });

    const reply = [...result.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.length > 0);

    return {
      agent: target.name,
      reply: reply?.content ?? '(no reply)',
      sessionId: result.id,
    };
  },
  };
};

export interface AgentRouteRule {
  /** Regex or predicate matched against the routing key (e.g. channel or message). */
  match: RegExp | ((input: string) => boolean);
  agent: AgentDefinition;
}

export interface AgentRouter {
  route(input: string): AgentDefinition;
}

/**
 * Route inbound work (a channel name, a message, a thread key) to an agent.
 * The Slack transport will feed channel/mention strings through this so the
 * same person consistently answers in the same places.
 */
export const createAgentRouter = (
  rules: AgentRouteRule[],
  fallback: AgentDefinition,
): AgentRouter => {
  // Global/sticky regexes mutate lastIndex on test(). Clone them (so the
  // caller's regex is never touched) keeping all flags — sticky stays
  // anchored — and reset lastIndex before every test for stable results.
  const normalized = rules.map((rule) => ({
    ...rule,
    match: rule.match instanceof RegExp
      ? new RegExp(rule.match.source, rule.match.flags)
      : rule.match,
  }));

  return {
    route(input) {
      for (const rule of normalized) {
        let matched: boolean;
        if (rule.match instanceof RegExp) {
          rule.match.lastIndex = 0;
          matched = rule.match.test(input);
        } else {
          matched = rule.match(input);
        }
        if (matched) {
          return rule.agent;
        }
      }
      return fallback;
    },
  };
};

/** Register a set of agents and get the registry back. */
export const createAgentTeam = (agents: AgentDefinition[]): AgentRegistry => {
  const registry = new AgentRegistry();
  for (const agent of agents) {
    registry.register(agent);
  }
  return registry;
};
