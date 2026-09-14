import type { ListensMode, AgentDefinition, AvatarTheme } from '@stratusagent/core';
import {
  generateAgentName,
  generateAvatarTheme,
  slugify,
  isValidAgentId,
  isValidDelegateEntry,
  agentIdWithSuffix,
  generatedIdSuffix,
} from './identity.ts';

export interface DefineAgentInput {
  name?: string;
  id?: string;
  instructions?: string;
  tools?: string[];
  skills?: string[];
  credentials?: string[];
  delegates?: string[];
  /** See `AgentDefinition.listens`. */
  listens?: ListensMode;
  avatar?: AvatarTheme;
  /** Seed for deterministic identity generation (used in tests). */
  seed?: string;
}

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
  if (input.id === '*') {
    // The wildcard was an accepted id until `delegates` gave it a meaning,
    // so a soul written before then can still carry it. The path-safety
    // message would be wrong for it — `*` breaks none of those rules — and
    // the roster reports this error with the file's path, so name the real
    // reason and the fix rather than leaving the operator to guess why an
    // agent that loaded yesterday is skipped today.
    throw new Error(
      'Invalid agent id: "*". * is the delegates wildcard (delegates: [\'*\'] means any agent on the roster), '
      + 'so no agent may have it as an id — give this agent another id. Its sessions, memory, and credentials '
      + 'are keyed by the old id and stay on disk.',
    );
  }
  if (input.id !== undefined && !isValidAgentId(input.id)) {
    throw new Error(
      `Invalid agent id: ${JSON.stringify(input.id)}. An id becomes a path segment, so it may not start with `
      + 'a dot or contain a slash, a backslash, a control character, or leading or trailing whitespace — '
      + 'it keys files and credentials, not just labels.',
    );
  }
  // Each entry is an id or the wildcard. Refused here, not in the tool: a
  // list holding a value no agent can have would be a grant to nobody
  // that read as a grant.
  for (const entry of input.delegates ?? []) {
    if (!isValidDelegateEntry(entry)) {
      throw new Error(
        `Invalid delegates entry: ${JSON.stringify(entry)}. Each entry is an agent id, or * for any agent on the roster.`,
      );
    }
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
    ...(input.delegates ? { delegates: input.delegates } : {}),
    ...(input.listens ? { listens: input.listens } : {}),
  };
};
