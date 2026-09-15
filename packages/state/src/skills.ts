import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SkillRegistry } from '@stratusagent/core';
import {
  createLazySkill,
  isLoadableSkillId,
  SKILL_ID_RULE,
  validateSkillDocument,
  isValidSkillId,
  parseSkillDocument,
  type ParsedSkillDocument,
} from '@stratusagent/agents';
import type { StateEnvironment } from './environment.ts';
import { skillsDirPath } from './paths.ts';

/** One operator-installed skill the daemon is serving, for listings and logs. */
export interface OperatorSkillInfo {
  id: string;
  name: string;
  description: string;
  /** The SKILL.md path, for the operator asking where the prose lives. */
  path: string;
  /** Toolset globs the skill's frontmatter says it expects. Advisory. */
  requires?: string[];
  /**
   * The spec's `compatibility` prose — what the skill says it needs from
   * its environment. For the operator at install; nothing acts on it.
   */
  compatibility?: string;
}

export interface LoadOperatorSkillsOptions {
  /**
   * Refuse the whole load on the first skill that would not load, instead
   * of warning and serving the rest. What a live reload wants: a daemon
   * that already serves a complete catalog must not swap it for a partial
   * one because a file is mid-edit, and the error names the file so the
   * operator can fix it and reload again. At start there is no previous
   * set to keep, which is why the default degrades.
   */
  strict?: boolean;
}

/**
 * Load `~/.stratus/skills/` into a skill registry: each subdirectory with a
 * `SKILL.md` is one skill, the directory name its id.
 *
 * Degrades the way `loadRosterSouls` does — one unparseable skill is a
 * warning, never a refusal to serve the rest (unless `strict`) — with the
 * same exception: an id collision has no right winner, so
 * `SkillRegistry.register` throwing `DuplicateSkillIdError` propagates
 * rather than being caught. Load these before plugins, so an operator's
 * bare id beats a plugin's bare alias while the plugin's skill stays
 * reachable qualified.
 */
export const loadOperatorSkills = async (
  env: StateEnvironment,
  registry: SkillRegistry,
  warn: (message: string) => void = () => {},
  options: LoadOperatorSkillsOptions = {},
): Promise<OperatorSkillInfo[]> => {
  const skip = (skillPath: string, reason: string): void => {
    if (options.strict) {
      throw new Error(`Cannot load ${skillPath}: ${reason}`);
    }
    warn(`skipping ${skillPath}: ${reason}`);
  };
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(skillsDirPath(env), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const loaded: OperatorSkillInfo[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // Dot-directories are never skills and never warnings: an installer's
    // staging directory or a stray .git must not spam the log for a
    // window nobody controls.
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const id = entry.name;
    const skillPath = path.join(skillsDirPath(env), id, 'SKILL.md');
    if (!isLoadableSkillId(id)) {
      skip(skillPath, `${JSON.stringify(id)} is not a skill id. ${SKILL_ID_RULE}`);
      continue;
    }
    if (!isValidSkillId(id)) {
      // Served, and said: the spec's rule is newer than this directory,
      // and an upgrade must not silently take an enabled procedure away.
      // A fresh install of it would be refused.
      warn(
        `${skillPath}: ${JSON.stringify(id)} predates the Agent Skills name rule (${SKILL_ID_RULE}) — still served, but a fresh install of it would be refused. Rename the directory, and its name:, to conform.`,
      );
    }
    let document;
    try {
      document = parseSkillDocument(await readFile(skillPath, 'utf8'));
    } catch (error) {
      skip(skillPath, error instanceof Error ? error.message : String(error));
      continue;
    }
    registry.register(createLazySkill({ id, document, read: () => readFile(skillPath, 'utf8') }));
    loaded.push({
      id,
      name: document.name ?? id,
      description: document.description,
      path: skillPath,
      ...(document.requires ? { requires: document.requires } : {}),
      ...(document.compatibility !== undefined ? { compatibility: document.compatibility } : {}),
    });
  }
  return loaded;
};

/** A skill found in a source directory, validated and ready to copy. */
export interface SkillInstallCandidate {
  /** The id it would install under — its directory name in `~/.stratus/skills/`. */
  id: string;
  /** The directory that gets copied, SKILL.md and bundled files alike. */
  directory: string;
  name: string;
  description: string;
  /**
   * What validation noted without refusing: fields outside the spec, the
   * legacy Stratus keys, a bundled `scripts/`. For the installer to say,
   * per skill, next to what it installed.
   */
  warnings: string[];
}

/** A skill a source offered that was not installed, and why. */
export interface SkillInstallSkip {
  id: string;
  reason: string;
}

/** A skill that installed, and something the operator should know about it. */
export interface SkillInstallWarning {
  id: string;
  message: string;
}

export interface ValidateSkillDirectoryOptions {
  /**
   * Check `name` against this directory name, as the spec requires.
   * Omitted for a skill whose directory is circumstance — a repository
   * that is the skill, checked out wherever git put it.
   */
  directoryName?: string;
  /** What a missing `name` should be, for the error text. */
  suggestedName?: string;
}

/** The outcome of validating one skill directory. `document` is present whenever the file parsed. */
export interface SkillDirectoryValidation {
  document?: ParsedSkillDocument;
  errors: string[];
  warnings: string[];
}

/**
 * Validate one skill directory the way an install does: the `SKILL.md`
 * parses, its frontmatter passes `validateSkillDocument`, and what the
 * directory bundles is noted. `stratus skill validate` and `stratus skill
 * add` share this — one reading of "conforms", so a skill that validates
 * is a skill that installs, and vice versa.
 *
 * A bundled `scripts/` is a warning rather than a refusal: the files are
 * inert on disk, and the roadmap's line — prose imports, executables do
 * not — means nothing here registers or runs them. An agent can run one
 * only through its own `shell.run` gate, like any other command, and the
 * operator installing the skill should hear that it bundles some.
 */
export const validateSkillDirectory = async (
  directory: string,
  options: ValidateSkillDirectoryOptions = {},
): Promise<SkillDirectoryValidation> => {
  let source: string;
  try {
    source = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  } catch (error) {
    return {
      errors: [`no SKILL.md in ${directory}: ${error instanceof Error ? error.message : String(error)}. A skill is a directory with a SKILL.md.`],
      warnings: [],
    };
  }
  let document: ParsedSkillDocument;
  try {
    document = parseSkillDocument(source);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], warnings: [] };
  }
  const { errors, warnings } = validateSkillDocument(document, {
    ...(options.directoryName !== undefined ? { directoryName: options.directoryName } : {}),
    ...(options.suggestedName !== undefined ? { suggestedName: options.suggestedName } : {}),
  });

  let scriptCount = 0;
  try {
    const entries = await readdir(path.join(directory, 'scripts'), { recursive: true, withFileTypes: true });
    scriptCount = entries.filter((entry) => entry.isFile()).length;
  } catch {
    // No scripts/ — the common case.
  }
  if (scriptCount > 0) {
    warnings.push(
      `bundles scripts/ (${scriptCount} file${scriptCount === 1 ? '' : 's'}). Installed as files only: nothing registers or runs them, and an agent can run one only through its own shell.run gate, like any other command.`,
    );
  }

  return { document, errors, warnings };
};

export interface InstallSkillsOptions {
  /** Install only these ids; everything else the source offers is skipped silently. */
  only?: string[];
  /** Replace an existing `~/.stratus/skills/<id>` instead of refusing it. */
  force?: boolean;
  /** See DiscoverSkillsOptions.rootId — forwarded to discovery. */
  rootId?: string;
}

export interface DiscoverSkillsOptions {
  /**
   * What the source directory is called where it came from — for a cloned
   * source, the repository's own name rather than the temporary directory
   * git landed in, whose random basename is either not an id or, worse,
   * accidentally one. Read only by the root-as-skill case.
   */
  rootId?: string;
  /**
   * Treat the root directory's own name as the skill's identity and check
   * `name` against it, as for a skill inside a container. Off by default,
   * because a source's root is usually a checkout, whose directory name is
   * circumstance. On for a directory that *is* the installed layout —
   * `~/.stratus/skills/<id>` — where a `name` that disagrees with the
   * directory is exactly the defect to report.
   */
  checkRootDirectoryName?: boolean;
}

export interface InstallSkillsResult {
  installed: OperatorSkillInfo[];
  /** What validation noted about the skills in `installed`, per skill. */
  warnings: SkillInstallWarning[];
  /**
   * Offered by the source and already present under the same id — not
   * copied, but real, loadable, and as eligible for enablement as a fresh
   * install. Distinct from `skipped` because "run again with --agent"
   * must work on exactly these; folding them into skips made the
   * advertised rerun fail with nothing installed.
   */
  alreadyInstalled: OperatorSkillInfo[];
  skipped: SkillInstallSkip[];
}

// Where the ecosystem keeps skills inside a repository, in the order the
// skills.sh CLI searches them. A directory named here is a container of
// skills, not a skill.
const SKILL_CONTAINER_DIRNAMES = ['skills', path.join('.claude', 'skills'), path.join('.agents', 'skills')];

const SKILL_IGNORED_DIRNAMES = new Set(['.git', 'node_modules']);

/**
 * Find every skill a directory offers: a `SKILL.md` at its root makes the
 * directory itself one skill; otherwise each immediate subdirectory with a
 * `SKILL.md` is one — at the root and inside the container directories the
 * ecosystem's repositories use (`skills/`, `.claude/skills/`,
 * `.agents/skills/`). One level, not a recursive crawl: the conventions
 * are flat, and a walk that reached deeper would install directories
 * nobody published as skills.
 *
 * Every candidate passed `validateSkillDirectory`: a skill that does not
 * conform to the spec (no `name`, a name that is not an id or not its
 * directory's, a description past the ceiling) comes back as a skip with
 * every reason, so an installer can say what it left behind rather than
 * silently thinning the source — and so what installed is known to load.
 */
export const discoverSkillsInDirectory = async (
  sourceDir: string,
  options: DiscoverSkillsOptions = {},
): Promise<{ candidates: SkillInstallCandidate[]; skipped: SkillInstallSkip[] }> => {
  const candidates: SkillInstallCandidate[] = [];
  const skipped: SkillInstallSkip[] = [];
  const claimed = new Set<string>();

  const consider = async (directory: string, fallbackId: string, isRoot = false): Promise<void> => {
    try {
      await readFile(path.join(directory, 'SKILL.md'), 'utf8');
    } catch {
      return;
    }
    // The spec makes `name` the id and requires it to equal the directory
    // name, which is what it will be in `~/.stratus/skills/`. A repository
    // whose root is the skill is the exception: its directory is wherever
    // it happened to be checked out, so only the name is checked there,
    // and the caller-supplied root id is what a nameless one is told to
    // add.
    const checkDirectory = !isRoot || options.checkRootDirectoryName === true;
    const validation = await validateSkillDirectory(
      directory,
      checkDirectory ? { directoryName: fallbackId, suggestedName: fallbackId } : { suggestedName: fallbackId },
    );
    if (validation.errors.length > 0 || validation.document?.name === undefined) {
      // Every error is a sentence naming its fix, so joined they read as
      // the whole diagnosis — one skip line saying everything wrong.
      skipped.push({ id: fallbackId, reason: validation.errors.join(' ') });
      return;
    }
    const id = validation.document.name;
    if (claimed.has(id)) {
      skipped.push({ id, reason: 'the source offers this id more than once; the first occurrence was kept' });
      return;
    }
    claimed.add(id);
    candidates.push({
      id,
      directory,
      name: id,
      description: validation.document.description,
      warnings: validation.warnings,
    });
  };

  await consider(sourceDir, options.rootId ?? path.basename(sourceDir), true);
  // A root SKILL.md means the directory IS the skill, so everything under
  // it is that skill's bundle: a SKILL.md inside its examples/ must not
  // become a second installed (and enableable) skill. Root or children,
  // never both — and a root that failed to parse still claims the layout,
  // reported as its own skip rather than mined for lookalikes.
  let rootIsSkill = candidates.length > 0 || skipped.length > 0;
  if (!rootIsSkill) {
    try {
      await readFile(path.join(sourceDir, 'SKILL.md'), 'utf8');
      rootIsSkill = true;
    } catch {
      // No root SKILL.md: a container of skills.
    }
  }
  if (rootIsSkill) {
    return { candidates, skipped };
  }
  const containers = [sourceDir, ...SKILL_CONTAINER_DIRNAMES.map((dirname) => path.join(sourceDir, dirname))];
  for (const container of containers) {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await readdir(container, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || SKILL_IGNORED_DIRNAMES.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      await consider(path.join(container, entry.name), entry.name);
    }
  }

  return { candidates, skipped };
};

/**
 * Copy the skills a directory offers into `~/.stratus/skills/`, whole
 * directories — a skill's bundled `references/` and `examples/` travel
 * with its SKILL.md. The source is typically a fresh clone of a skills
 * repository; a local path works identically.
 *
 * An id already installed is refused (per skill, with the rest still
 * installing) rather than overwritten — `force` says the replacement is
 * meant. Nothing here enables anything: a soul still opts in through its
 * `skills:` allowlist, which is what makes bulk-installing a stranger's
 * repository safe by default.
 */
export const installSkillsFromDirectory = async (
  env: StateEnvironment,
  sourceDir: string,
  options: InstallSkillsOptions = {},
): Promise<InstallSkillsResult> => {
  const { candidates, skipped } = await discoverSkillsInDirectory(
    sourceDir,
    options.rootId !== undefined ? { rootId: options.rootId } : {},
  );
  const wanted = options.only === undefined
    ? candidates
    : candidates.filter((candidate) => options.only?.includes(candidate.id));
  if (options.only !== undefined) {
    for (const id of options.only) {
      if (!candidates.some((candidate) => candidate.id === id)) {
        skipped.push({ id, reason: 'the source does not offer a skill with this id' });
      }
    }
  }

  const installed: OperatorSkillInfo[] = [];
  const warnings: SkillInstallWarning[] = [];
  const alreadyInstalled: OperatorSkillInfo[] = [];
  for (const candidate of wanted) {
    const destination = path.join(skillsDirPath(env), candidate.id);
    let exists = false;
    try {
      await readdir(destination);
      exists = true;
    } catch {
      // Not installed yet.
    }
    if (exists && !options.force) {
      // Present is not a failure: the id the caller asked for is here and
      // loadable, and an enablement step that follows this install must
      // see it. A copy whose SKILL.md no longer parses is the exception —
      // that one is genuinely unusable until forced over.
      const installedPath = path.join(destination, 'SKILL.md');
      try {
        const document = parseSkillDocument(await readFile(installedPath, 'utf8'));
        alreadyInstalled.push({
          id: candidate.id,
          name: document.name ?? candidate.id,
          description: document.description,
          path: installedPath,
          ...(document.requires ? { requires: document.requires } : {}),
          ...(document.compatibility !== undefined ? { compatibility: document.compatibility } : {}),
        });
      } catch (error) {
        skipped.push({
          id: candidate.id,
          reason: `already installed but unreadable (${error instanceof Error ? error.message : String(error)}); pass force to replace it`,
        });
      }
      continue;
    }

    // Everything that can refuse happens before the existing version is
    // touched, and the copy lands in a staging sibling first — a failed
    // install must never have deleted the working version it was
    // replacing. The rename at the end is the commit.
    const escaping = await findEscapingSymlink(candidate.directory);
    if (escaping !== undefined) {
      skipped.push({
        id: candidate.id,
        reason: `contains a symlink reaching outside the skill (${escaping}) — installed, it would read files it does not own`,
      });
      continue;
    }
    await mkdir(skillsDirPath(env), { recursive: true });
    const staging = path.join(skillsDirPath(env), `.installing-${candidate.id}-${randomUUID().slice(0, 8)}`);
    try {
      // verbatimSymlinks keeps a relative intra-skill link relative — the
      // default rewrites it to an absolute path into the source, which
      // for a cloned source is deleted the moment the install returns.
      // Containment above is what makes preserving links safe.
      await cp(candidate.directory, staging, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (candidateSource) => {
          const base = path.basename(candidateSource);
          return !SKILL_IGNORED_DIRNAMES.has(base);
        },
      });
      const document = parseSkillDocument(await readFile(path.join(staging, 'SKILL.md'), 'utf8'));
      if (exists) {
        await rm(destination, { recursive: true, force: true });
      }
      await rename(staging, destination);
      installed.push({
        id: candidate.id,
        name: document.name ?? candidate.id,
        description: document.description,
        path: path.join(destination, 'SKILL.md'),
        ...(document.requires ? { requires: document.requires } : {}),
        ...(document.compatibility !== undefined ? { compatibility: document.compatibility } : {}),
      });
      for (const message of candidate.warnings) {
        warnings.push({ id: candidate.id, message });
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return { installed, warnings, alreadyInstalled, skipped };
};

/**
 * The first symlink under `directory` whose target resolves outside it, or
 * undefined when every link stays contained.
 *
 * Links are otherwise preserved verbatim on install, so an escaping one
 * would keep escaping from `~/.stratus/skills/` — where `SKILL.md ->
 * ../../credentials.json` is a skill body that reads the operator's
 * secrets the moment an agent loads it. Refused per skill, before
 * anything is copied or removed.
 */
const findEscapingSymlink = async (directory: string): Promise<string | undefined> => {
  const root = await realpath(directory);
  const lexicalRoot = path.resolve(directory);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const linkPath = path.join(entry.parentPath, entry.name);
    // What the copy filter drops was never going to install: a package
    // manager routinely plants out-of-tree symlinks under node_modules,
    // and refusing the skill over a link that will not exist afterwards
    // is a false rejection. Judged by path segments, matching the filter.
    const segments = path.relative(directory, linkPath).split(path.sep);
    if (segments.some((segment) => SKILL_IGNORED_DIRNAMES.has(segment))) {
      continue;
    }
    // The raw target first, and an absolute one refuses whether or not it
    // resolves right now: preserved verbatim, an absolute path is pinned
    // to the machine and tree the skill was inspected on — inside a
    // cloned source it dangles the moment the clone is deleted, and
    // anywhere else it is reading somebody's filesystem by fiat.
    const target = await readlink(linkPath);
    if (path.isAbsolute(target)) {
      return path.relative(directory, linkPath);
    }
    let resolved: string;
    try {
      resolved = await realpath(linkPath);
    } catch {
      // Dangling here proves nothing: the link re-resolves wherever the
      // skill lands, so `../../credentials.json` dangles in a fresh clone
      // and reads the operator's secrets once it sits under
      // `~/.stratus/skills/<id>/`. With no target to resolve, it is
      // judged by path arithmetic alone: the relative target must stay
      // inside the skill.
      const lexical = path.resolve(path.dirname(path.resolve(linkPath)), target);
      if (lexical !== lexicalRoot && !lexical.startsWith(lexicalRoot + path.sep)) {
        return path.relative(directory, linkPath);
      }
      continue;
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return path.relative(directory, linkPath);
    }
  }
  return undefined;
};
