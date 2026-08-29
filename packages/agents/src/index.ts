import {
  AgentRegistry,
  type AgentDefinition,
  type AgentMemoryStore,
  type AgentRunner,
  type AvatarTheme,
  type JsonObject,
  type Session,
  type Skill,
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

/**
 * The shape an id is *minted* in: lowercase alphanumerics and internal
 * hyphens, starting with an alphanumeric. Everything `slugify` produces
 * matches it, so every id this module derives does.
 *
 * Not what validation enforces. A hand-written `id:` predates any shape
 * rule and `Ava_1` was as valid as `ava` — see `isValidAgentId`.
 */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * How long an id we *build* is allowed to get. A construction bound, not a
 * validation rule — `isValidAgentId` deliberately does not check it.
 *
 * Every id derived from a long name predates this bound, and enforcing it
 * retroactively drops working agents off the roster, while trimming them
 * silently re-keys their sessions, memory, and credentials to an id nobody
 * has ever used. So the bound applies where an id is minted fresh and
 * nothing is keyed to it yet, and nowhere else. File systems still have
 * limits, and an id long enough to hit them fails at the join with a name
 * that says so.
 */
export const MAX_AGENT_ID_LENGTH = 64;

/**
 * What an id may never be, whatever else it is: anything that stops being
 * a single, addressable path segment. A separator escapes the directory,
 * a leading dot hides the file or walks up out of it (`..`), and a control
 * character is not typeable back.
 */
const PATH_UNSAFE_AGENT_ID = /[/\\]|[\u0000-\u001f\u007f]/;

/**
 * Whether `id` is safe to key an agent's resources and paths by.
 *
 * Ids are not labels. They key sessions, memory, credentials, Slack channel
 * tokens, and every per-agent path on disk — and an explicit frontmatter
 * `id` is untrusted input: a soul file travels with a repository, and in
 * the hosted profile it comes from a tenant. `id: ../../escape` reaches
 * every one of those joins intact, so it is stopped once here rather than
 * defended at each of them.
 *
 * **Unsafe is the rule, not un-sluglike.** Nothing before this checked an
 * explicit id at all, so `Ava_1`, `team.alpha`, and `AVA` are all out there
 * keying real sessions and real credentials. Holding them to the shape ids
 * are minted in would not make anything safer — none of them can leave
 * their directory — and `loadRosterSouls` degrades a soul that will not
 * parse to a warning, so the only thing it would accomplish is dropping
 * those agents off the roster on upgrade, quietly, while their data stays
 * behind under the old id. Reserving the slug shape for ids nobody has
 * chosen yet costs nothing; imposing it on ids people are already using
 * costs them their agent.
 *
 * Rejected, never sanitized: rewriting `../../escape` into `escape` hands
 * back an agent nobody asked for, keyed to resources nobody named.
 */
export const isValidAgentId = (id: string): boolean =>
  id.length > 0
  // Invisible leading or trailing space cannot be typed back reliably, so
  // an id that is not its own trimmed self is a mistake, not a legacy.
  && id === id.trim()
  && !id.startsWith('.')
  && !PATH_UNSAFE_AGENT_ID.test(id)
  // An id keys plain objects too — `credentials.channels.slack[id]` among
  // them — where an inherited name is not a free slot. `toString` reads as
  // already connected with nothing stored, and `__proto__` assigns through
  // to the prototype, so the write lands nowhere and `JSON.stringify` drops
  // it. `in {}` names exactly that set, and names it by the property it
  // has rather than by a list to keep in step.
  && !(id in {});

/**
 * A freshly minted id, bounded — `base` trimmed so that appending `suffix`
 * still fits, with any hyphen left dangling by the trim removed.
 *
 * Only for ids nothing is keyed to yet: a generated agent's
 * name-plus-suffix, and `agent new` retrying a filename collision. Both mint
 * an id in the same breath as the agent, so trimming takes nothing away.
 * Shared rather than re-derived so the two do not each own half of the bound
 * and drift. An id derived from a name someone chose does *not* come through
 * here — that name may already have an agent behind it.
 */
export const agentIdWithSuffix = (base: string, suffix?: string): string => {
  const tail = suffix ? `-${suffix}` : '';
  const room = Math.max(1, MAX_AGENT_ID_LENGTH - tail.length);
  return `${base.slice(0, room).replace(/-+$/, '') || 'agent'}${tail}`;
};

export interface DefineAgentInput {
  name?: string;
  id?: string;
  instructions?: string;
  tools?: string[];
  skills?: string[];
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
  // Only an explicit id is checked: a derived one comes out of slugify,
  // which cannot produce anything unsafe.
  if (input.id !== undefined && !isValidAgentId(input.id)) {
    throw new Error(
      `Invalid agent id: ${JSON.stringify(input.id)}. An id becomes a path segment, so it may not start with `
      + 'a dot or contain a slash, a backslash, a control character, or leading or trailing whitespace — '
      + 'it keys files and credentials, not just labels.',
    );
  }
  // A chosen name's slug is used whole. It is not this function's to
  // shorten: the same name has resolved to the same id in every release,
  // and two long names that differ only past the bound are two agents,
  // not one roster-refusing collision.
  const derived = nameWasGenerated
    ? agentIdWithSuffix(slugify(name), generatedIdSuffix(input.seed))
    : slugify(name);
  return {
    // Derived ids are safe by construction with one exception: `constructor`
    // is a perfectly ordinary slug and an Object.prototype key, so the name
    // "Constructor" reaches a rule that only ran on explicit ids. Checked
    // rather than special-cased, so what this returns is *an id that
    // validates* — not one that passes the cases anyone thought of. The
    // suffix is seeded by the slug, so the name still answers the same way
    // every time.
    id: input.id ?? (isValidAgentId(derived)
      ? derived
      : agentIdWithSuffix(derived, generatedIdSuffix(derived))),
    name,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    avatar: input.avatar ?? generateAvatarTheme(name),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
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
const SOUL_LIST_KEYS = ['tools', 'skills', 'credentials'] as const;

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

interface FrontmatterShape {
  /** Lowercased document kind for error messages ("soul", "skill"). */
  kind: string;
  scalarKeys: readonly string[];
  listKeys: readonly string[];
  /**
   * Ignore what the shape does not name instead of refusing it — unknown
   * keys, whatever indented block sits under one, and the YAML block and
   * multi-line scalars other ecosystems write.
   *
   * Skills opt in: they travel an ecosystem whose frontmatter carries
   * fields other hosts own (`license`, `metadata`, `allowed-tools`), and
   * refusing those would refuse most published skills over metadata that
   * changes nothing here. Souls stay strict, deliberately — an unknown
   * soul key can be a typo'd allowlist, and a soul that loads with
   * silently weaker access is the worse failure.
   */
  tolerant?: boolean;
}

interface ParsedFrontmatter {
  scalars: Partial<Record<string, string>>;
  lists: Partial<Record<string, string[]>>;
}

// A deliberately tiny frontmatter dialect: `key: value` scalars and block
// lists of `- item` lines. Enough for souls and skills, no YAML dependency.
// Tolerant mode (see FrontmatterShape) additionally reads the block-scalar
// forms (`description: >-` and friends) and plain multi-line scalars, and
// skips unknown keys with their nested blocks.
const parseFrontmatterLines = (lines: string[], shape: FrontmatterShape): ParsedFrontmatter => {
  const scalars: ParsedFrontmatter['scalars'] = {};
  const lists: ParsedFrontmatter['lists'] = {};
  const tolerant = shape.tolerant ?? false;
  let currentList: string[] | undefined;
  // Tolerant-mode line context: an unknown key whose indented block is
  // being skipped, or a known scalar whose value continues on indented
  // lines (a YAML block scalar, or a plain scalar that wraps). Inside
  // either, blank lines and lines starting with # are content or skipped
  // block — never the comments the top level treats them as — so both are
  // handled before the comment filter below.
  let skippingUnknownBlock = false;
  let continuation: { key: string; literal: boolean; pendingBreak: boolean } | undefined;

  const isIndented = (line: string): boolean => /^\s/.test(line);

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const blank = line.trim().length === 0;

    if (tolerant && skippingUnknownBlock && (blank || isIndented(line))) {
      continue;
    }
    if (tolerant && continuation) {
      if (blank) {
        // A blank line is a line break in a literal block and a paragraph
        // break in a folded or plain one — never the end of the value.
        if (continuation.literal) {
          const existing = scalars[continuation.key] ?? '';
          if (existing.length > 0) {
            scalars[continuation.key] = `${existing}\n`;
          }
        } else {
          continuation.pendingBreak = true;
        }
        continue;
      }
      if (isIndented(line)) {
        const existing = scalars[continuation.key] ?? '';
        const separator = continuation.literal || continuation.pendingBreak ? '\n' : ' ';
        continuation.pendingBreak = false;
        // The raw content, not unquote(): inside a block scalar a quote or
        // a # is text, and YAML agrees.
        const piece = line.trim();
        scalars[continuation.key] = existing.length > 0 ? `${existing}${separator}${piece}` : piece;
        continue;
      }
      // A non-indented line ends the value; fall through to read it.
    }

    if (blank || line.trim().startsWith('#')) {
      continue;
    }

    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem) {
      if (!currentList) {
        throw new Error(`${capitalize(shape.kind)} frontmatter has a list item outside a list: "${line.trim()}"`);
      }
      const item = unquote(listItem[1] ?? '');
      if (item.length > 0) {
        currentList.push(item);
      }
      continue;
    }

    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!entry) {
      throw new Error(`${capitalize(shape.kind)} frontmatter line is not "key: value": "${line.trim()}"`);
    }

    const key = entry[1] ?? '';
    const value = entry[2] ?? '';
    currentList = undefined;
    skippingUnknownBlock = false;
    continuation = undefined;

    if (shape.listKeys.includes(key)) {
      const list: string[] = [];
      lists[key] = list;
      const inline = value.trim();
      if (inline.length > 0) {
        // Inline form: tools: [a, b]
        const match = /^\[(.*)\]$/.exec(inline);
        if (!match) {
          throw new Error(`${capitalize(shape.kind)} frontmatter list "${key}" must be a block list or [a, b]: "${inline}"`);
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

    if (!shape.scalarKeys.includes(key)) {
      if (tolerant) {
        // The key and anything nested under it belong to some other host.
        skippingUnknownBlock = true;
        continue;
      }
      throw new Error(
        `Unknown ${shape.kind} frontmatter key: "${key}". Supported keys: ${[...shape.scalarKeys, ...shape.listKeys].join(', ')}.`,
      );
    }

    const inline = value.trim();
    // YAML block-scalar headers: `>` folds continuation lines with spaces,
    // `|` keeps their line breaks; either may carry an indentation digit
    // and a chomping sign in either order, and a trailing comment. Only
    // meaningful in tolerant mode — the strict dialect never wrote them.
    if (tolerant && /^[>|](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/.test(inline)) {
      scalars[key] = '';
      continuation = { key, literal: inline.startsWith('|'), pendingBreak: false };
      continue;
    }

    const scalar = unquote(value);
    if (scalar.length === 0) {
      if (tolerant) {
        // May be a plain scalar continuing on indented lines; empty stays
        // empty and is dropped below if nothing follows.
        scalars[key] = '';
        continuation = { key, literal: false, pendingBreak: false };
        continue;
      }
      throw new Error(`${capitalize(shape.kind)} frontmatter key "${key}" has no value.`);
    }
    scalars[key] = scalar;
    if (tolerant) {
      continuation = { key, literal: false, pendingBreak: false };
    }
  }

  // A tolerant block scalar that never got a body reads as absent, not as
  // an empty string that would satisfy a required-field check.
  for (const [key, value] of Object.entries(scalars)) {
    if (value !== undefined && value.length === 0) {
      delete scalars[key];
    }
  }

  return { scalars, lists };
};

const capitalize = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/**
 * Split a markdown document into its `---`-fenced frontmatter lines (if
 * any) and the body after them. Shared by souls and skills — one reading
 * of what the fences mean, wherever the dialect appears.
 */
const extractFrontmatter = (
  source: string,
  kind: string,
): { lines: string[] | undefined; body: string } => {
  const normalized = source.replace(/\r\n/g, '\n');
  const opener = /^---[ \t]*\n/.exec(normalized);
  if (!opener) {
    return { lines: undefined, body: normalized };
  }
  const closer = /\n---[ \t]*(\n|$)/.exec(normalized.slice(opener[0].length - 1));
  if (!closer || closer.index === undefined) {
    throw new Error(`${capitalize(kind)} frontmatter opened with --- but never closed.`);
  }
  const frontmatterEnd = opener[0].length - 1 + closer.index;
  return {
    lines: normalized.slice(opener[0].length, frontmatterEnd).split('\n'),
    body: normalized.slice(frontmatterEnd + closer[0].length),
  };
};

/**
 * Parse a soul file (markdown with optional frontmatter) into an agent
 * definition. The body becomes the agent's instructions; a missing name is
 * generated, so the smallest possible soul is just prose.
 */
export const parseSoul = (source: string, options: ParseSoulOptions = {}): ParsedSoul => {
  const { lines, body } = extractFrontmatter(source, 'soul');
  const { scalars, lists } = lines
    ? parseFrontmatterLines(lines, { kind: 'soul', scalarKeys: SOUL_SCALAR_KEYS, listKeys: SOUL_LIST_KEYS })
    : { scalars: {}, lists: {} } as ParsedFrontmatter;

  const instructions = body.trim();

  const agent = defineAgent({
    ...(scalars.name ? { name: scalars.name } : {}),
    ...(scalars.id ? { id: scalars.id } : {}),
    ...(instructions ? { instructions } : {}),
    ...(lists.tools ? { tools: lists.tools } : {}),
    ...(lists.skills ? { skills: lists.skills } : {}),
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
    ['skills', soul.agent.skills],
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

// ---- skills ----------------------------------------------------------------

/**
 * The shape a skill id is written in: lowercase kebab-case (`web-research`).
 * One pattern for the manifest's declared ids and the operator directory's
 * folder names — two copies would drift into two answers to what a valid
 * id is.
 */
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const isValidSkillId = (id: string): boolean => SKILL_ID_PATTERN.test(id);

const SKILL_SCALAR_KEYS = ['name', 'description', 'version'] as const;
const SKILL_LIST_KEYS = ['requires'] as const;

/**
 * A parsed `SKILL.md`: the one-line identity that reaches the system
 * prompt, and the body that only ever travels through `skill.read`.
 */
export interface ParsedSkillDocument {
  /** Display name; the registered skill falls back to its id. */
  name?: string;
  /**
   * When to reach for this skill — what routing runs on, so it earns its
   * place by saying when, not what the body contains.
   */
  description: string;
  /** Informational; nothing keys on it. */
  version?: string;
  /** Toolset globs the procedure expects (`browser.*`). Advisory — see `Skill.requires`. */
  requires?: string[];
  body: string;
}

/**
 * Parse a `SKILL.md` — the same frontmatter dialect souls use (`key: value`
 * scalars, block lists), with the skill's keys: `name`, `description`,
 * optional `version`, optional `requires`. The body is the procedure
 * itself, markdown, untouched.
 *
 * `description` is required: it is the only thing the model sees before
 * deciding to load the body, and a skill without one is unreachable by the
 * mechanism that makes skills cheap.
 */
export const parseSkillDocument = (source: string): ParsedSkillDocument => {
  const { lines, body } = extractFrontmatter(source, 'skill');
  if (!lines) {
    throw new Error('Skill file has no frontmatter. A SKILL.md starts with --- and needs at least a description.');
  }
  const { scalars, lists } = parseFrontmatterLines(lines, {
    kind: 'skill',
    scalarKeys: SKILL_SCALAR_KEYS,
    listKeys: SKILL_LIST_KEYS,
    // Skills travel the wider agent-skills ecosystem (skills.sh and the
    // registries behind it), whose frontmatter carries fields other hosts
    // own. Those are metadata to skip, not defects to refuse — see
    // FrontmatterShape.tolerant, and note souls do NOT set this.
    tolerant: true,
  });
  const description = scalars.description;
  if (!description) {
    throw new Error(
      'Skill frontmatter has no "description". The description is what an agent routes on — say when to reach for this skill.',
    );
  }
  return {
    ...(scalars.name ? { name: scalars.name } : {}),
    description,
    ...(scalars.version ? { version: scalars.version } : {}),
    ...(lists.requires && lists.requires.length > 0 ? { requires: lists.requires } : {}),
    body: body.trim(),
  };
};

export interface LazySkillInput {
  /** The id the skill registers under — qualified for a plugin's skill. */
  id: string;
  /** The parsed document, from the load-time read that validated the file. */
  document: ParsedSkillDocument;
  /** Re-read the file's source. Called on demand; the registry caches. */
  read: () => Promise<string>;
}

/**
 * A `Skill` whose body stays on disk until somebody asks. The identity
 * comes from the load-time parse (which is also what validated the file);
 * `load()` re-reads rather than closing over the body, so an
 * enabled-but-unused skill costs its description line and nothing else —
 * in the prompt and in memory.
 */
export const createLazySkill = ({ id, document, read }: LazySkillInput): Skill => ({
  id,
  name: document.name ?? id,
  description: document.description,
  ...(document.requires ? { requires: document.requires } : {}),
  load: async () => parseSkillDocument(await read()).body,
});

export const MEMORY_TOOL_NAME = 'memory.remember';

/**
 * A tool that lets an agent write to its own long-term memory. Entries are
 * keyed by the session's agent id, so what one agent learns stays exclusively
 * that agent's knowledge — and follows it to every channel and thread.
 */
export const createRememberTool = (store: AgentMemoryStore): Tool => ({
  name: MEMORY_TOOL_NAME,
  description: 'Save a fact to your long-term memory so you can recall it in future conversations on any channel.',
  // The agent's own memory, keyed to the agent and read by nobody else.
  risk: 'safe',
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
  // Safe, and the call is arguable enough to record why. Delegation spends
  // provider tokens and starts work as another agent, which reads like
  // `gated` — but the money argument proves too much: the turn that decides
  // to delegate was itself an unapproved provider call, so gating on spend
  // gates the conversation. What delegation does NOT do is act outside
  // Stratus. It stays in the fleet, the delegate's own tool calls face the
  // policy again under the delegate's allowlist, and maxDepth bounds the
  // chain.
  //
  // The practical half: `gated` here means a headless daemon refuses every
  // delegation, and headless is what every installed service runs. That
  // would remove the orchestrator pattern from the product until remote
  // approval exists — a feature removal wearing a safety hat, with no way
  // for an operator to say yes. Revisit when a human can actually be asked.
  risk: 'safe',
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

// ---- schedules --------------------------------------------------------------
//
// The pure half of step 10: what a schedule *is* — its cadence, its prompt,
// its optional destination — and the arithmetic of when it fires next. The
// scheduler that arms timers, the store that makes rows durable, and the
// channel that delivers a send all live in the gateway; this stays free of
// them so the CLI can describe a schedule and the tests can check the
// arithmetic without standing a daemon up.

/**
 * Where a schedule reports, or a `message.send` speaks: a channel kind plus
 * a channel-native id — the same convention approver lists use, because
 * mapping through a Stratus identity adds a lookup that can only be wrong.
 */
export interface ScheduleDestination {
  /** Channel kind, e.g. 'slack' — which adapter must do the talking. */
  channel: string;
  /** Channel-native conversation id (Slack: `C…`/`G…`/`D…`). */
  to: string;
}

/**
 * The one string form of a destination, `<channel>:<native id>`, used
 * everywhere a destination is *compared*: `Tool.destinationFor`, the
 * permission policy's pre-authorization check, and the schedule row it is
 * checked against. One canonicalization, or two writers of `slack:C01` and
 * `SLACK:C01` would disagree about the same channel.
 */
export const canonicalDestination = (destination: ScheduleDestination): string =>
  `${destination.channel.trim().toLowerCase()}:${destination.to.trim()}`;

/**
 * When a schedule runs. Three shapes rather than one string, because the
 * three are advanced differently: an interval adds itself to the previous
 * slot, a cron expression is searched forward, and a one-shot has no next
 * at all.
 */
export type ScheduleCadence =
  | { kind: 'every'; intervalMs: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'at'; at: string };

/** One durable schedule, exactly as the human approved it. */
export interface ScheduleRecord {
  id: string;
  agentId: string;
  cadence: ScheduleCadence;
  /** The user message each firing dispatches — the payload of the feature. */
  prompt: string;
  /**
   * Where firings are pre-authorized to report. Absent for a silent
   * schedule, whose firings face the gate like any inbound turn.
   */
  destination?: ScheduleDestination;
  createdAt: string;
  /** The session whose turn created it, for the audit trail. */
  createdBy?: string;
  /**
   * The next slot, ISO-8601. Consumed — advanced — BEFORE the dispatch, so
   * a daemon that dies mid-firing can never run the same window twice.
   * Absent for a spent one-shot: it will not fire again and its row stays
   * only until the firing it pre-authorized has finished.
   */
  nextFireAt?: string;
  lastFiredAt?: string;
  /**
   * The session id of the most recent firing. What the restart sweep uses
   * to tell a spent one-shot whose turn is parked on a human (keep the row
   * — it is the approval's scope) from one whose turn is over (delete it).
   */
  lastSessionId?: string;
}

/** `every` strings: a positive integer and one unit — `90s`, `10m`, `2h`, `1d`. */
export const parseInterval = (text: string): number | undefined => {
  const match = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return undefined;
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return amount * unit;
};

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /**
   * Whether the day fields were written as anything but `*`. Standard cron
   * semantics: when BOTH are restricted, a day matches if EITHER does —
   * `0 0 1 * 1` is "the 1st, and every Monday", not "the 1st when it is a
   * Monday".
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const parseCronField = (
  field: string,
  min: number,
  max: number,
  label: string,
): Set<number> => {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!stepMatch || part.length === 0) {
      throw new Error(`Invalid cron ${label} field: ${field}`);
    }
    const [, rangeText, stepText] = stepMatch;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new Error(`Invalid cron ${label} step: ${part}`);
    }
    let low: number;
    let high: number;
    if (rangeText === '*') {
      low = min;
      high = max;
    } else {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(rangeText!);
      if (!rangeMatch) {
        throw new Error(`Invalid cron ${label} field: ${field} (numbers only — names are not supported)`);
      }
      low = Number(rangeMatch[1]);
      high = rangeMatch[2] === undefined ? low : Number(rangeMatch[2]);
      // A bare value with a step (`5/15`) reads to the end of the range,
      // matching vixie cron.
      if (rangeMatch[2] === undefined && stepText !== undefined) {
        high = max;
      }
    }
    if (low < min || high > max || low > high) {
      throw new Error(`Cron ${label} value out of range ${min}-${max}: ${part}`);
    }
    for (let value = low; value <= high; value += step) {
      values.add(value);
    }
  }
  return values;
};

/**
 * Five fields — minute, hour, day-of-month, month, day-of-week — with `*`,
 * lists, ranges, and steps. Numbers only; day-of-week 0-7 with both 0 and 7
 * as Sunday. Evaluated in the daemon's local time, which is what "every
 * morning at 7" means to the person whose machine it is.
 */
export const parseCronExpression = (expression: string): CronFields => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `A cron expression has five fields (minute hour day-of-month month day-of-week); got ${fields.length} in "${expression}".`,
    );
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseCronField(dow, 0, 7, 'day-of-week');
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseCronField(minute, 0, 59, 'minute'),
    hours: parseCronField(hour, 0, 23, 'hour'),
    daysOfMonth: parseCronField(dom, 1, 31, 'day-of-month'),
    months: parseCronField(month, 1, 12, 'month'),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
};

/** How far a cron search looks before concluding the expression never fires. */
const CRON_SEARCH_DAYS = 366 * 4;

const nextCronFire = (fields: CronFields, after: Date): Date | undefined => {
  // Strictly after `after`, at minute granularity.
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const dayMatches = (date: Date): boolean => {
    if (!fields.months.has(date.getMonth() + 1)) {
      return false;
    }
    const domMatch = fields.daysOfMonth.has(date.getDate());
    const dowMatch = fields.daysOfWeek.has(date.getDay());
    if (fields.domRestricted && fields.dowRestricted) {
      return domMatch || dowMatch;
    }
    return fields.domRestricted ? domMatch : fields.dowRestricted ? dowMatch : true;
  };

  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);

  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let offset = 0; offset < CRON_SEARCH_DAYS; offset += 1) {
    if (dayMatches(day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
          if (candidate >= start && candidate > after) {
            return candidate;
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  // Reachable: `0 0 31 2 *` matches no real date. Creation treats this as
  // a refusal, not a schedule that quietly never runs.
  return undefined;
};

/**
 * The slot after `after`, or undefined when there is none — a one-shot
 * already past, or a cron expression that matches no real date. One
 * implementation, because the scheduler advancing a fired slot and the
 * creation path computing the first one must never disagree.
 */
export const nextFireAfter = (cadence: ScheduleCadence, after: Date): Date | undefined => {
  switch (cadence.kind) {
    case 'every':
      return new Date(after.getTime() + cadence.intervalMs);
    case 'cron':
      return nextCronFire(parseCronExpression(cadence.expression), after);
    case 'at': {
      const at = new Date(cadence.at);
      if (Number.isNaN(at.getTime())) {
        return undefined;
      }
      return at.getTime() > after.getTime() ? at : undefined;
    }
    default:
      return undefined;
  }
};

/** One line for a human: `every 30m`, `cron 0 7 * * *`, `once at 2026-…`. */
export const describeCadence = (cadence: ScheduleCadence): string => {
  switch (cadence.kind) {
    case 'every': {
      const units: Array<[number, string]> = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1_000, 's']];
      for (const [ms, suffix] of units) {
        if (cadence.intervalMs % ms === 0) {
          return `every ${cadence.intervalMs / ms}${suffix}`;
        }
      }
      return `every ${cadence.intervalMs}ms`;
    }
    case 'cron':
      return `cron ${cadence.expression}`;
    case 'at':
      return `once at ${cadence.at}`;
    default:
      return 'unknown';
  }
};

/**
 * Metadata a firing's session carries. The schedule id is what the
 * permission carve-out resolves the approved destination from, and
 * `scheduled: true` is what lets a renderer say a turn arrived from a
 * schedule rather than a person.
 */
export const SCHEDULE_ID_METADATA_KEY = 'scheduleId';
export const SCHEDULED_TURN_METADATA_KEY = 'scheduled';

// ---- schedule tools ---------------------------------------------------------

export const SCHEDULE_EVERY_TOOL_NAME = 'schedule.every';
export const SCHEDULE_AT_TOOL_NAME = 'schedule.at';
export const SCHEDULE_LIST_TOOL_NAME = 'schedule.list';
export const SCHEDULE_CANCEL_TOOL_NAME = 'schedule.cancel';
export const MESSAGE_SEND_TOOL_NAME = 'message.send';

export interface ScheduleCreateInput {
  agentId: string;
  cadence: ScheduleCadence;
  prompt: string;
  destination?: ScheduleDestination;
  /** The session whose turn asked, for the audit trail. */
  createdBy?: string;
}

/**
 * The gateway-supplied handle the schedule tools close over — the same
 * pattern as `agent.delegate`'s dispatcher, because the scheduler needs the
 * store, the roster, and the channels, and none of those are this package's
 * to hold. `create` owns every refusal that needs daemon knowledge: the
 * interval floor, and a destination the agent's channel cannot address —
 * checked NOW, while a person is present to hear why, not at 6am.
 */
export interface SchedulerHandle {
  create(input: ScheduleCreateInput): Promise<ScheduleRecord>;
  list(agentId: string): Promise<ScheduleRecord[]>;
  /** True when a schedule of this agent's was cancelled; false when nothing matched. */
  cancel(agentId: string, scheduleId: string): Promise<boolean>;
}

const parseDestinationInput = (raw: unknown): ScheduleDestination | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const channel = (raw as JsonObject).channel;
  const to = (raw as JsonObject).to;
  if (typeof channel !== 'string' || channel.trim().length === 0
    || typeof to !== 'string' || to.trim().length === 0) {
    return undefined;
  }
  return { channel: channel.trim().toLowerCase(), to: to.trim() };
};

const DESTINATION_PARAMETER = {
  type: 'object',
  description: 'Where firings report. Omit for a schedule that does not speak — its sends will need approval like any other. The channel kind plus the channel-native conversation id (for Slack, a channel id like C0123456789 that your app is a member of).',
  properties: {
    channel: { type: 'string', description: "Channel kind, e.g. 'slack'." },
    to: { type: 'string', description: 'Channel-native conversation id.' },
  },
  required: ['channel', 'to'],
} satisfies JsonObject;

/**
 * One schedule as a surface shows it — the CLI table, the control API's
 * listing, and the tool results all render this one projection, so the
 * operator's view and the agent's cannot drift.
 */
export const describeSchedule = (record: ScheduleRecord): JsonObject => ({
  id: record.id,
  agentId: record.agentId,
  cadence: describeCadence(record.cadence),
  prompt: record.prompt,
  ...(record.destination ? { destination: canonicalDestination(record.destination) } : {}),
  ...(record.nextFireAt ? { nextFireAt: record.nextFireAt } : {}),
  ...(record.lastFiredAt ? { lastFiredAt: record.lastFiredAt } : {}),
  createdAt: record.createdAt,
});

/**
 * The four `schedule.*` tools over one handle.
 *
 * Risk is split per tool, not per toolset: creating a schedule spends
 * future money unattended and (with a destination) mints a standing
 * permission to speak, so `schedule.every` and `schedule.at` are `gated` —
 * the approval of THAT call is the human decision the whole step leans on.
 * `schedule.list` is a read, and `schedule.cancel` only ever narrows
 * authority — it is the reversal the risk note in the spec names — so both
 * are `safe`: a headless agent that set a bad schedule must be able to
 * undo it without waiting for the human whose absence is the problem.
 */
export const createScheduleTools = (scheduler: SchedulerHandle): Tool[] => {
  const create = async (
    session: Session,
    cadence: ScheduleCadence,
    input: JsonObject,
  ): Promise<JsonObject> => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) {
      throw new Error('A schedule needs a non-empty "prompt" — the instruction each firing runs.');
    }
    if (input.destination !== undefined && parseDestinationInput(input.destination) === undefined) {
      throw new Error('"destination" must be { channel, to } with non-empty strings, or omitted.');
    }
    const destination = parseDestinationInput(input.destination);
    const record = await scheduler.create({
      agentId: session.agent.id,
      cadence,
      prompt,
      ...(destination ? { destination } : {}),
      createdBy: session.id,
    });
    return { created: true, schedule: describeSchedule(record) };
  };

  return [
    {
      name: SCHEDULE_EVERY_TOOL_NAME,
      description: 'Set a recurring schedule for yourself: an interval ("30m", "1d") or a five-field cron expression, the prompt each firing runs, and optionally the destination your reports are pre-authorized to post to. Creating a schedule needs human approval once; its firings then run unattended.',
      risk: 'gated',
      parameters: {
        type: 'object',
        properties: {
          every: { type: 'string', description: 'Interval like "90s", "30m", "2h", "1d". Exactly one of "every" or "cron".' },
          cron: { type: 'string', description: 'Five-field cron expression (minute hour day-of-month month day-of-week), local time. Exactly one of "every" or "cron".' },
          prompt: { type: 'string', description: 'The instruction each firing runs, phrased to stand alone.' },
          destination: DESTINATION_PARAMETER,
        },
        required: ['prompt'],
      },
      async execute(input: JsonObject, session: Session) {
        const every = typeof input.every === 'string' ? input.every.trim() : '';
        const cron = typeof input.cron === 'string' ? input.cron.trim() : '';
        if ((every === '') === (cron === '')) {
          throw new Error('Pass exactly one of "every" (an interval) or "cron" (a cron expression).');
        }
        if (every) {
          const intervalMs = parseInterval(every);
          if (intervalMs === undefined) {
            throw new Error(`Not an interval: "${every}". Use a positive integer and one unit — "90s", "30m", "2h", "1d".`);
          }
          return create(session, { kind: 'every', intervalMs }, input);
        }
        parseCronExpression(cron); // Refuse a bad expression here, with its own message.
        return create(session, { kind: 'cron', expression: cron }, input);
      },
    },
    {
      name: SCHEDULE_AT_TOOL_NAME,
      description: 'Schedule a one-shot run of a prompt at a future time (ISO-8601). Needs human approval once; the firing then runs unattended.',
      risk: 'gated',
      parameters: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'When to fire, ISO-8601 (e.g. 2026-09-01T07:00:00). Must be in the future.' },
          prompt: { type: 'string', description: 'The instruction the firing runs, phrased to stand alone.' },
          destination: DESTINATION_PARAMETER,
        },
        required: ['at', 'prompt'],
      },
      async execute(input: JsonObject, session: Session) {
        const at = typeof input.at === 'string' ? input.at.trim() : '';
        const parsed = new Date(at);
        if (!at || Number.isNaN(parsed.getTime())) {
          throw new Error(`Not a timestamp: "${at}". Use ISO-8601, e.g. 2026-09-01T07:00:00.`);
        }
        if (parsed.getTime() <= Date.now()) {
          throw new Error(`${at} is in the past — a one-shot schedule must name a future time.`);
        }
        return create(session, { kind: 'at', at: parsed.toISOString() }, input);
      },
    },
    {
      name: SCHEDULE_LIST_TOOL_NAME,
      description: 'List your own schedules: cadence, prompt, destination, and when each fires next.',
      // A read of state this agent itself created.
      risk: 'safe',
      parameters: { type: 'object', properties: {} },
      async execute(_input: JsonObject, session: Session) {
        const records = await scheduler.list(session.agent.id);
        return { schedules: records.map(describeSchedule) };
      },
    },
    {
      name: SCHEDULE_CANCEL_TOOL_NAME,
      description: 'Cancel one of your schedules by id. Cancelling also revokes the pre-authorized destination that was approved with it.',
      // Cancel only ever NARROWS authority — it destroys a human-minted
      // grant — and it is the reversal that keeps schedule creation short
      // of `dangerous`. Gating it would leave a headless agent unable to
      // undo its own schedule for want of the human whose absence is the
      // point of headless.
      risk: 'safe',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The schedule id, from schedule.list or the creation result.' },
        },
        required: ['id'],
      },
      async execute(input: JsonObject, session: Session) {
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (!id) {
          throw new Error('schedule.cancel requires a non-empty "id".');
        }
        const cancelled = await scheduler.cancel(session.agent.id, id);
        if (!cancelled) {
          throw new Error(`No schedule of yours has id ${id}. schedule.list shows what exists.`);
        }
        return { cancelled: true, id };
      },
    },
  ];
};

// ---- message.send -----------------------------------------------------------

/**
 * Delivers one outbound message through the agent's channel. The gateway
 * implements it over the channel contract's `resolveOutbound`; rejecting is
 * the way to say a destination cannot be served.
 */
export type OutboundMessenger = (input: {
  agentId: string;
  destination: ScheduleDestination;
  text: string;
}) => Promise<void>;

/**
 * Post to a channel or DM outside the current conversation — what makes a
 * scheduled turn observable.
 *
 * `gated`, and deliberately not `safe` the way `agent.delegate` is: the
 * delegate stays inside the fleet, under every per-agent allowlist and the
 * same approval policy, while this speaks to people who did not ask. The
 * unattended path is the schedule carve-out — `destinationFor` names where
 * this call would speak, and the policy allows it exactly when the firing's
 * schedule was approved with that destination.
 */
export const createMessageSendTool = (send: OutboundMessenger): Tool => ({
  name: MESSAGE_SEND_TOOL_NAME,
  description: 'Send a message to a channel or DM you are not currently talking in. Scheduled turns may post to their schedule\'s approved destination without asking; anywhere else needs approval.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      destination: {
        ...DESTINATION_PARAMETER,
        description: 'Where to post: the channel kind plus the channel-native conversation id.',
      },
      text: { type: 'string', description: 'The message text.' },
    },
    required: ['destination', 'text'],
  },
  destinationFor(input: JsonObject) {
    const destination = parseDestinationInput(input.destination);
    return destination ? canonicalDestination(destination) : undefined;
  },
  async execute(input: JsonObject, session: Session) {
    const destination = parseDestinationInput(input.destination);
    if (!destination) {
      throw new Error('message.send requires "destination" as { channel, to } with non-empty strings.');
    }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) {
      throw new Error('message.send requires a non-empty "text".');
    }
    await send({ agentId: session.agent.id, destination, text });
    return { sent: true, destination: canonicalDestination(destination) };
  },
});
