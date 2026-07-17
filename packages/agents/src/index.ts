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

const AVATAR_STYLES = ['geometric', 'gradient', 'orbit', 'mosaic', 'wave'] as const;

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
 * Derive an avatar theme from a name: a stable hue, a small palette, and a
 * rendering style. Consumers (CLI, web, macOS) draw the actual image from
 * this so the agent looks the same on every surface.
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
    style: AVATAR_STYLES[value % AVATAR_STYLES.length] ?? 'geometric',
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

export interface DelegateToolOptions {
  registry: AgentRegistry;
  runner: AgentRunner;
  /** Maximum delegation depth to stop orchestrator loops. Default 3. */
  maxDepth?: number;
}

const DEFAULT_MAX_DELEGATION_DEPTH = 3;

/**
 * The orchestrator primitive: a tool that runs another agent in its own
 * sub-session (with that agent's memory, tool allowlist, and credentials)
 * and returns its final reply as the tool result.
 */
export const createDelegateTool = ({
  registry,
  runner,
  maxDepth = DEFAULT_MAX_DELEGATION_DEPTH,
}: DelegateToolOptions): Tool => {
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
  async execute(input: JsonObject, session: Session) {
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
    const result = await runner.run({
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
