import {
  EFFORT_LEVELS,
  isEffortLevel,
  isLanguageTag,
  isListensMode,
  LISTENS_MODES,
  type AgentDefinition,
  type EffortLevel,
} from '@stratusagent/core';
import { defineAgent } from './define.ts';
import {
  unquote,
  type ParsedFrontmatter,
  parseFrontmatterLines,
  extractFrontmatter,
  writeScalar,
} from './frontmatter.ts';

/**
 * Whether `agent` may delegate to the agent with id `targetId`. Exact ids
 * or `*`; no namespace globs, because agent ids have no namespaces. Omitted
 * is nobody — see `AgentDefinition.delegates`.
 */
export const isDelegateAllowed = (agent: Pick<AgentDefinition, 'delegates'>, targetId: string): boolean =>
  (agent.delegates ?? []).some((entry) => entry === '*' || entry === targetId);

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
  /** Model the soul prefers (e.g. "claude-opus-5-5"). Runtimes may override. */
  model?: string;
  /**
   * The language this agent writes in (`en-GB`), over the config file's
   * `language` and the `en-US` default. See `resolveRuntimeConfig`.
   */
  language?: string;
  /**
   * How hard this agent's Claude model works on each turn (`high`). Sent
   * to the API and the Claude Code harness, lowered to what each model
   * takes; see `resolveEffort` in core. Absent sends nothing, so every
   * model stays on its own default.
   */
  effort?: EffortLevel;
  /**
   * The model and tools this agent's conversation turns run on, when the
   * soul has a `front:` block. See {@link SoulFront}. Absent means every
   * turn runs on the agent's own model and tools, as before the key existed.
   */
  front?: SoulFront;
}

/**
 * A soul's `front:` block: what answers a person who is waiting. Turns in a
 * conversation (a channel message, `stratus chat`, a task's outcome notice)
 * run on `model` with the front tools, so a quick question gets a quick
 * answer and longer work goes to a background task on the agent itself.
 * Schedules, triggers and task workers keep the agent's own model and tools.
 */
export interface SoulFront {
  /** The model conversation turns run on (`claude-haiku-5-5`). Required: there is no hidden default. */
  model: string;
  /** The provider serving `model`. Omitted is the agent's own. */
  provider?: string;
  /**
   * Replaces the default quick set the front gets beside the task tools.
   * Same entries as the soul's `tools:`, and never a grant: a tool the
   * agent's own `tools:` does not allow stays out of the front's reach.
   */
  tools?: string[];
}

/**
 * What a front always has, beside its quick set: starting work in the
 * background, seeing it and stopping it, and passing a follow-up to it.
 * The last is named before it exists so a soul written today reaches it the
 * day it ships; a name nothing registered grants nothing. Literals, not the
 * tools' name constants: `tools/delegate.ts` imports this file, and a cycle
 * read at module load is a crash that depends on import order. A test holds
 * them equal.
 */
export const FRONT_TASK_TOOLS: readonly string[] = [
  'agent.delegate',
  'agent.tasks',
  'agent.cancelTask',
  'agent.messageTask',
];

/**
 * The quick set a front gets when `front.tools` names none: reads, memory
 * and messages, each answered in moments. No writes, no shell, no web: a
 * front and a task writing one file is the failure that is hard to see, and
 * a slow tool holds the conversation it exists to keep moving.
 */
export const DEFAULT_FRONT_TOOLS: readonly string[] = [
  'memory.recall',
  'memory.remember',
  'message.read',
  'message.send',
  'fs.read',
  'fs.list',
  'fs.search',
];

/**
 * Tool steps a front turn takes before it wraps up, or the agent's own
 * budget when that is lower. A proposal from the spec, held small so a
 * front that loops can't hold the conversation; the live checks may move it.
 */
export const FRONT_MAX_STEPS = 8;

/** Every tool entry a front turn is held to, before the agent's own `tools:` narrows it further. */
export const frontToolEntries = (front: SoulFront): string[] => [
  ...FRONT_TASK_TOOLS,
  ...(front.tools ?? DEFAULT_FRONT_TOOLS),
];

export interface ParseSoulOptions {
  /** Seed for deterministic identity generation when the soul has no name. */
  seed?: string;
}

const SOUL_SCALAR_KEYS = ['name', 'id', 'provider', 'model', 'listens', 'language', 'effort'] as const;

const SOUL_LIST_KEYS = ['tools', 'skills', 'credentials', 'delegates'] as const;

const FRONT_SCALAR_KEYS = ['model', 'provider'] as const;

const FRONT_LIST_KEYS = ['tools'] as const;

/**
 * The frontmatter lines with a top-level `front:` block taken out, and that
 * block's lines dedented so the shared parser reads them as a document of
 * their own. The dialect has no nested maps, and `front:` is the one soul
 * key that needs one; reading it here keeps the block as strict as the rest
 * of the soul, where an unknown key is refused rather than skipped.
 */
const takeFrontBlock = (lines: string[]): { rest: string[]; front: string[] | undefined } => {
  const rest: string[] = [];
  let front: string[] | undefined;
  let inFront = false;
  for (const line of lines) {
    const opener = /^front\s*:(.*)$/.exec(line);
    if (opener) {
      if (front !== undefined) {
        throw new Error('Soul frontmatter has more than one front: block.');
      }
      const inline = (opener[1] ?? '').trim();
      if (inline.length > 0 && !inline.startsWith('#')) {
        throw new Error(
          `Soul frontmatter front: must be a block of indented lines, like "front:" then "  model: claude-haiku-5-5": "${line.trim()}"`,
        );
      }
      front = [];
      inFront = true;
      continue;
    }
    if (inFront && (line.trim().length === 0 || /^\s/.test(line))) {
      front?.push(line);
      continue;
    }
    inFront = false;
    rest.push(line);
  }
  if (front === undefined) {
    return { rest, front: undefined };
  }
  const indents = front.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return { rest, front: front.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length))) };
};

const parseFront = (lines: string[]): SoulFront => {
  const { scalars, lists } = parseFrontmatterLines(lines, {
    kind: 'soul front:',
    scalarKeys: FRONT_SCALAR_KEYS,
    listKeys: FRONT_LIST_KEYS,
  });
  if (scalars.model === undefined) {
    throw new Error(
      'Soul frontmatter front: has no model. Name the model conversation turns run on, like "  model: claude-haiku-5-5".',
    );
  }
  return {
    model: scalars.model,
    ...(scalars.provider !== undefined ? { provider: scalars.provider } : {}),
    ...(lists.tools !== undefined ? { tools: lists.tools } : {}),
  };
};

/**
 * The soul edit that grants one delegate, as the refusal suggests it. The
 * inline form, `delegates: [a, "b, c"]`, quoted when the inline parser
 * would otherwise split or unquote the id, in whichever quote it does not
 * contain — and the block form when the id holds both quotes, since no
 * inline spelling of `a"',b` reads back as one entry, while a block line
 * is never split and is unquoted only for matching outer quotes, which
 * {@link writeScalar} guards. Rendered this carefully because
 * `delegates: [foo,bar]` is a grant to two agents and a refusal of the
 * one the message was about.
 */
export const suggestedDelegatesEdit = (value: string): string => {
  if (!/[,"'\s]/.test(value) && unquote(value) === value) {
    return `delegates: [${value}]`;
  }
  if (!value.includes('"')) {
    return `delegates: ["${value}"]`;
  }
  if (!value.includes("'")) {
    return `delegates: ['${value}']`;
  }
  return `a delegates: list with the line "- ${writeScalar(value)}"`;
};

/**
 * Parse a soul file (markdown with optional frontmatter) into an agent
 * definition. The body becomes the agent's instructions; a missing name is
 * generated, so the smallest possible soul is just prose.
 */
export const parseSoul = (source: string, options: ParseSoulOptions = {}): ParsedSoul => {
  const { lines, body } = extractFrontmatter(source, 'soul');
  const split = lines ? takeFrontBlock(lines) : undefined;
  const { scalars, lists } = split
    ? parseFrontmatterLines(split.rest, { kind: 'soul', scalarKeys: SOUL_SCALAR_KEYS, listKeys: SOUL_LIST_KEYS })
    : { scalars: {}, lists: {}, maps: {}, unknownKeys: [], skippedMapEntries: {} } as ParsedFrontmatter;
  const front = split?.front !== undefined ? parseFront(split.front) : undefined;

  const instructions = body.trim();

  // Strict, like every soul key: a misspelled mode would otherwise load as
  // the default, and an agent that answers every reply when it was meant
  // to judge is the failure this file is read to prevent.
  if (scalars.listens !== undefined && !isListensMode(scalars.listens)) {
    throw new Error(
      `Soul frontmatter listens: ${JSON.stringify(scalars.listens)} is not a listening mode; use one of ${LISTENS_MODES.join(', ')}.`,
    );
  }

  // Strict for the same reason, and for one more: the tag is interpolated
  // into every prompt the agent is sent, so it may only be a tag.
  if (scalars.language !== undefined && !isLanguageTag(scalars.language)) {
    throw new Error(
      `Soul frontmatter language: ${JSON.stringify(scalars.language)} is not a language tag; use one like en-US or en-GB.`,
    );
  }

  // Strict too: a misspelled level silently left the agent on the model's
  // default, which is the setting this key exists to change.
  if (scalars.effort !== undefined && !isEffortLevel(scalars.effort)) {
    throw new Error(
      `Soul frontmatter effort: ${JSON.stringify(scalars.effort)} is not an effort level; use one of ${EFFORT_LEVELS.join(', ')}.`,
    );
  }

  const agent = defineAgent({
    ...(scalars.name ? { name: scalars.name } : {}),
    ...(scalars.id ? { id: scalars.id } : {}),
    ...(instructions ? { instructions } : {}),
    ...(lists.tools ? { tools: lists.tools } : {}),
    ...(lists.skills ? { skills: lists.skills } : {}),
    ...(lists.credentials ? { credentials: lists.credentials } : {}),
    ...(lists.delegates ? { delegates: lists.delegates } : {}),
    ...(isListensMode(scalars.listens) ? { listens: scalars.listens } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });

  return {
    agent,
    ...(scalars.provider ? { provider: scalars.provider } : {}),
    ...(scalars.model ? { model: scalars.model } : {}),
    ...(isLanguageTag(scalars.language) ? { language: scalars.language } : {}),
    ...(isEffortLevel(scalars.effort) ? { effort: scalars.effort } : {}),
    ...(front !== undefined ? { front } : {}),
  };
};

export const formatSoul = (soul: ParsedSoul): string => {
  const lines: string[] = ['---', `name: ${writeScalar(soul.agent.name)}`, `id: ${writeScalar(soul.agent.id)}`];

  if (soul.provider) {
    lines.push(`provider: ${soul.provider}`);
  }
  if (soul.model) {
    lines.push(`model: ${soul.model}`);
  }
  if (soul.agent.listens) {
    lines.push(`listens: ${soul.agent.listens}`);
  }
  if (soul.language) {
    lines.push(`language: ${soul.language}`);
  }
  if (soul.effort) {
    lines.push(`effort: ${soul.effort}`);
  }
  if (soul.front) {
    lines.push('front:', `  model: ${writeScalar(soul.front.model)}`);
    if (soul.front.provider) {
      lines.push(`  provider: ${writeScalar(soul.front.provider)}`);
    }
    if (soul.front.tools !== undefined) {
      // Kept when empty, like the soul's own tools: an empty list is the
      // task tools alone, and an omitted one adds the default quick set.
      if (soul.front.tools.length === 0) {
        lines.push('  tools: []');
      } else {
        lines.push('  tools:');
        for (const tool of soul.front.tools) {
          lines.push(`    - ${writeScalar(tool)}`);
        }
      }
    }
  }
  for (const [key, values] of [
    ['tools', soul.agent.tools],
    ['skills', soul.agent.skills],
    ['credentials', soul.agent.credentials],
    ['delegates', soul.agent.delegates],
  ] as const) {
    if (values && values.length > 0) {
      lines.push(`${key}:`);
      for (const value of values) {
        lines.push(`  - ${writeScalar(value)}`);
      }
    } else if (key === 'tools' && values !== undefined) {
      // Kept, unlike the other lists: an omitted `tools:` is the safe
      // tools, and an empty one is nothing. Dropping it here widened every
      // agent allowed nothing whose soul went through a field edit.
      lines.push('tools: []');
    }
  }

  lines.push('---', '');
  lines.push(soul.agent.instructions ?? 'Describe who this agent is and how they talk.');
  lines.push('');
  return lines.join('\n');
};
