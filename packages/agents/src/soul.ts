import { isListensMode, LISTENS_MODES, type AgentDefinition } from '@stratusagent/core';
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
  /** Model the soul prefers (e.g. "claude-opus-5"). Runtimes may override. */
  model?: string;
}

export interface ParseSoulOptions {
  /** Seed for deterministic identity generation when the soul has no name. */
  seed?: string;
}

const SOUL_SCALAR_KEYS = ['name', 'id', 'provider', 'model', 'listens'] as const;

const SOUL_LIST_KEYS = ['tools', 'skills', 'credentials', 'delegates'] as const;

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
  const { scalars, lists } = lines
    ? parseFrontmatterLines(lines, { kind: 'soul', scalarKeys: SOUL_SCALAR_KEYS, listKeys: SOUL_LIST_KEYS })
    : { scalars: {}, lists: {}, maps: {}, unknownKeys: [] } as ParsedFrontmatter;

  const instructions = body.trim();

  // Strict, like every soul key: a misspelled mode would otherwise load as
  // the default, and an agent that answers every reply when it was meant
  // to judge is the failure this file is read to prevent.
  if (scalars.listens !== undefined && !isListensMode(scalars.listens)) {
    throw new Error(
      `Soul frontmatter listens: ${JSON.stringify(scalars.listens)} is not a listening mode; use one of ${LISTENS_MODES.join(', ')}.`,
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
    }
  }

  lines.push('---', '');
  lines.push(soul.agent.instructions ?? 'Describe who this agent is and how they talk.');
  lines.push('');
  return lines.join('\n');
};
