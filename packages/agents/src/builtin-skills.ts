import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { STRATUS_SKILL_ID, type Skill } from '@stratusagent/core';

import { createLazySkill, parseSkillDocument } from './skills.ts';

/**
 * Where the built-in skill ships: `skills/stratus/SKILL.md` in this
 * package, one level up from `src/` and `dist/` alike, so a source checkout
 * and an installed package read the same file.
 */
export const STRATUS_SKILL_PATH = fileURLToPath(new URL('../skills/stratus/SKILL.md', import.meta.url));

/**
 * The `stratus` skill: how Stratus works, for every agent (`Skill.builtin`).
 * Read from disk rather than inlined so it stays a plain `SKILL.md` that
 * `stratus skill validate` and a reviewer can read, and so a reload sees an
 * edit to a source checkout. The body is read when an agent asks for it;
 * only the description travels with every turn.
 */
export const loadStratusSkill = async (): Promise<Skill> => {
  const read = (): Promise<string> => readFile(STRATUS_SKILL_PATH, 'utf8');
  const document = parseSkillDocument(await read());
  return { ...createLazySkill({ id: STRATUS_SKILL_ID, document, read }), builtin: true };
};
