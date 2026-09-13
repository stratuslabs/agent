import type { Skill } from '@stratusagent/core';
import { parseFrontmatterLines, extractFrontmatter } from './frontmatter.ts';

/**
 * The shape a skill id is written in — the Agent Skills spec's rule for
 * `name`, which is also the directory name: lowercase letters and digits
 * in hyphen-separated runs (`web-research`), at most 64 characters, no
 * leading, trailing, or doubled hyphen. One pattern for the manifest's
 * declared ids, the operator directory's folder names, and install-time
 * validation — two copies would drift into two answers to what a valid
 * id is.
 */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The spec's ceiling on `name`, and so on a skill id. */
export const SKILL_ID_MAX_LENGTH = 64;

export const isValidSkillId = (id: string): boolean =>
  id.length <= SKILL_ID_MAX_LENGTH && SKILL_ID_PATTERN.test(id);

// The rule before the spec's: any lowercase kebab-ish run, doubled and
// trailing hyphens and all, no length cap. What a directory or manifest
// id that loaded yesterday was checked against.
const LEGACY_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Whether an id that is already on this machine — a directory under
 * `~/.stratus/skills/`, a plugin manifest's declared id — is served.
 * Wider than `isValidSkillId` on purpose: the spec's rule arrived after
 * some of these were written, and tightening the *loader* would silently
 * drop an enabled procedure from an agent on upgrade. Installing and
 * validating use the strict rule; loading uses this one, and warns.
 */
export const isLoadableSkillId = (id: string): boolean => LEGACY_SKILL_ID_PATTERN.test(id);

/** What a skill id refusal says, everywhere one is refused. */
export const SKILL_ID_RULE =
  'Skill ids are lowercase letters, digits, and single hyphens (web-research), at most 64 characters.';

/** The spec's ceiling on `description`. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** The spec's ceiling on `compatibility`. */
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

// The frontmatter keys the Agent Skills spec defines. Everything else at
// the top level belongs to some other host — read past, and reported by
// `validateSkillDocument`. `allowed-tools` is read so it is not reported,
// and then deliberately unused: it is another host's pre-approval list,
// and here the two gates (a trusted config, a soul's allowlist) are the
// only things that grant a tool.
const SKILL_SPEC_KEYS: readonly string[] = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];

// `version` and `requires` at the top level are the pre-spec Stratus form;
// the spec keeps host extensions under `metadata:`, and that is where a
// skill written today puts them. The old form still reads, so an installed
// skill keeps working — and validation says which form it found.
const SKILL_SCALAR_KEYS = ['name', 'description', 'license', 'compatibility', 'allowed-tools', 'version'] as const;

const SKILL_LIST_KEYS = ['requires'] as const;

const SKILL_MAP_KEYS = ['metadata'] as const;

const SKILL_LEGACY_KEYS: readonly string[] = ['version', 'requires'];

/**
 * A parsed `SKILL.md`: the one-line identity that reaches the system
 * prompt, and the body that only ever travels through `skill.read`.
 */
export interface ParsedSkillDocument {
  /**
   * The skill's name — under the spec, its id, and equal to its directory
   * name. Optional here because loading stays tolerant of what is already
   * installed; the registered skill falls back to its id.
   */
  name?: string;
  /**
   * When to reach for this skill — what routing runs on, so it earns its
   * place by saying when, not what the body contains.
   */
  description: string;
  /** The spec's `license`: a name, or a bundled file. Informational. */
  license?: string;
  /**
   * The spec's `compatibility`: what the skill needs from its environment,
   * in prose — for the operator installing it, since nothing here can act
   * on it.
   */
  compatibility?: string;
  /** The spec's `metadata:` map, verbatim — every value a string. */
  metadata?: Record<string, string>;
  /** `metadata.version`, or the legacy top-level key. Informational. */
  version?: string;
  /**
   * Toolset globs the procedure expects (`browser.*`), from
   * `metadata.requires` (space-separated) or the legacy top-level list.
   * Advisory — see `Skill.requires`.
   */
  requires?: string[];
  /**
   * Top-level keys outside the spec, in file order — the legacy Stratus
   * keys and other hosts' fields alike. What validation warns about.
   */
  unknownKeys: string[];
  body: string;
}

/**
 * Parse a `SKILL.md` — the same frontmatter dialect souls use (`key: value`
 * scalars, block lists), plus the spec's `metadata:` map. The body is the
 * procedure itself, markdown, untouched.
 *
 * `description` is required: it is the only thing the model sees before
 * deciding to load the body, and a skill without one is unreachable by the
 * mechanism that makes skills cheap. Everything the spec constrains beyond
 * presence — the name rule, the length ceilings — is
 * `validateSkillDocument`'s, so that loading what is already installed
 * stays lenient while installing is strict.
 */
export const parseSkillDocument = (source: string): ParsedSkillDocument => {
  const { lines, body } = extractFrontmatter(source, 'skill');
  if (!lines) {
    throw new Error('Skill file has no frontmatter. A SKILL.md starts with --- and needs at least a description.');
  }
  const { scalars, lists, maps, unknownKeys } = parseFrontmatterLines(lines, {
    kind: 'skill',
    scalarKeys: SKILL_SCALAR_KEYS,
    listKeys: SKILL_LIST_KEYS,
    mapKeys: SKILL_MAP_KEYS,
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
  const metadata = maps.metadata;
  const version = metadata?.version ?? scalars.version;
  const requires = metadata?.requires !== undefined
    ? metadata.requires.split(/\s+/).filter((entry) => entry.length > 0)
    : lists.requires;
  // The legacy keys are read, and still not the spec's: a validator names
  // them so a skill written here can be moved to the form that ports.
  const legacy = SKILL_LEGACY_KEYS.filter((key) => (key === 'requires' ? lists.requires : scalars[key]) !== undefined);
  return {
    ...(scalars.name ? { name: scalars.name } : {}),
    description,
    ...(scalars.license ? { license: scalars.license } : {}),
    ...(scalars.compatibility ? { compatibility: scalars.compatibility } : {}),
    ...(metadata ? { metadata } : {}),
    ...(version ? { version } : {}),
    ...(requires && requires.length > 0 ? { requires } : {}),
    unknownKeys: [...legacy, ...unknownKeys.filter((key) => !SKILL_SPEC_KEYS.includes(key))],
    body: body.trim(),
  };
};

export interface ValidateSkillDocumentOptions {
  /**
   * The directory the skill sits in (its basename), which the spec
   * requires `name` to equal. Omit where the directory is circumstance
   * rather than identity — a repository whose root is the skill, checked
   * out wherever git put it.
   */
  directoryName?: string;
  /**
   * What to suggest when `name` is missing — the directory name, or for a
   * root skill the repository's. Only ever read for the error text.
   */
  suggestedName?: string;
}

const characterCount = (text: string): number => Array.from(text).length;

/** What `validateSkillDocument` found: errors refuse an install, warnings ride along. */
export interface SkillValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Check a parsed `SKILL.md` against the Agent Skills spec — the checks
 * `skills-ref validate` runs, so a skill that passes here passes there:
 * `name` present, shaped like an id, equal to the directory name;
 * `description` and `compatibility` under their ceilings. Errors are what
 * refuses an install. Top-level keys the spec does not define are
 * warnings, not errors: the reference validator refuses them, but the
 * ecosystem's skills carry other hosts' fields routinely, and refusing a
 * skill over a field that changes nothing here fails the whole point of
 * conforming. The legacy Stratus keys get their own warning, naming the
 * `metadata:` form that ports.
 *
 * Loading never calls this — an installed skill keeps loading whatever
 * the spec says today. Installing always does.
 */
export const validateSkillDocument = (
  document: ParsedSkillDocument,
  options: ValidateSkillDocumentOptions = {},
): SkillValidation => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (document.name === undefined) {
    const suggestion = options.suggestedName ?? options.directoryName;
    errors.push(
      `frontmatter has no "name". The Agent Skills spec requires one, equal to the directory name${
        suggestion !== undefined ? ` — add: name: ${suggestion}` : ''
      }.`,
    );
  } else if (!isValidSkillId(document.name)) {
    errors.push(`name ${JSON.stringify(document.name)} is not a skill id. ${SKILL_ID_RULE}`);
  } else if (options.directoryName !== undefined && document.name !== options.directoryName) {
    errors.push(
      `name ${JSON.stringify(document.name)} does not match the directory name ${JSON.stringify(options.directoryName)}. The spec requires the two to agree — rename one.`,
    );
  }

  // Characters, as the spec and its Python reference count them — code
  // points, not the UTF-16 units `.length` reports, which would count an
  // emoji twice and refuse a description the reference validator passes.
  const descriptionLength = characterCount(document.description);
  if (descriptionLength > SKILL_DESCRIPTION_MAX_LENGTH) {
    errors.push(
      `description is ${descriptionLength} characters, past the spec's ceiling of ${SKILL_DESCRIPTION_MAX_LENGTH}. Say when to reach for the skill, and move the rest into the body.`,
    );
  }
  const compatibilityLength = document.compatibility !== undefined ? characterCount(document.compatibility) : 0;
  if (compatibilityLength > SKILL_COMPATIBILITY_MAX_LENGTH) {
    errors.push(
      `compatibility is ${compatibilityLength} characters, past the spec's ceiling of ${SKILL_COMPATIBILITY_MAX_LENGTH}.`,
    );
  }

  const legacy = document.unknownKeys.filter((key) => SKILL_LEGACY_KEYS.includes(key));
  const foreign = document.unknownKeys.filter((key) => !SKILL_LEGACY_KEYS.includes(key));
  for (const key of legacy) {
    warnings.push(
      key === 'requires'
        ? 'top-level "requires" is the pre-spec Stratus form, and the reference validator refuses it. Write it as metadata.requires, one space-separated string: "browser.* fs.read".'
        : 'top-level "version" is the pre-spec Stratus form, and the reference validator refuses it. Write it as metadata.version.',
    );
  }
  if (foreign.length > 0) {
    warnings.push(
      `frontmatter key${foreign.length > 1 ? 's' : ''} outside the Agent Skills spec: ${foreign.map((key) => JSON.stringify(key)).join(', ')}. Another host's; ignored here, and the reference validator refuses ${foreign.length > 1 ? 'them' : 'it'}.`,
    );
  }

  return { errors, warnings };
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
