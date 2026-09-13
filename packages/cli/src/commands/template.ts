import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { escapeControlCharacters, type JsonObject, type JsonValue } from '@stratusagent/core';
import {
  agentsDirPath,
  globalConfigPath,
  discoverSkillsInDirectory,
  installSkillsFromDirectory,
  declaredAgentIds,
  loadSoulFile,
  loadConfigFile,
  validateConfigFile,
  saveConfigFile,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment, CliConfigFile } from '../environment.ts';
import { writeLine } from '../io.ts';
import { defaultPackageInstaller } from '../npm.ts';
import type { ParsedTemplateAddCommand } from '../parse.ts';
import { resolveSource, redactedSourceUrl, cloneSource } from '../source.ts';

// ---------------------------------------------------------------------------
// Templates: a folder of files, copied into ~/.stratus
// ---------------------------------------------------------------------------

/**
 * What a template directory holds. Every entry is a file somebody could
 * have written by hand into `~/.stratus`, which is the whole design:
 * installing one is copying, and reviewing one is reading a folder.
 *
 *   template.json     name and description — the only required file
 *   config.json       merged into ~/.stratus/config.json
 *   agents/<id>.md    soul files, copied to ~/.stratus/agents/
 *   skills/<id>/      skill directories, installed exactly as `skill add` does
 *
 * There is deliberately no list of packages to install. The keys of
 * `config.json`'s `plugins` block already name them, and a second list
 * would be a second answer that drifts from the first.
 */
const TEMPLATE_MANIFEST_FILENAME = 'template.json';

const TEMPLATE_CONFIG_FILENAME = 'config.json';

const TEMPLATE_AGENTS_DIRNAME = 'agents';

const TEMPLATE_SKILLS_DIRNAME = 'skills';

/**
 * A package specifier this command will hand to `npm install -g`.
 *
 * `defaultPackageInstaller` spawns npm through a shell on Windows, and its
 * comment says every package name reaching that shell is a constant in
 * this file. A template makes that false — these names come out of a
 * folder somebody downloaded — so anything that is not a plain npm package
 * name is refused before it can be re-parsed as a command. No version
 * suffix either: a template names packages, and the installed version is
 * reported rather than pinned.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

interface TemplateAgentPlan {
  /** The file inside `agents/`, and the name it installs under. */
  file: string;
  /** The reviewed bytes, so what installs is what was shown. */
  contents: string;
  /**
   * The id the soul actually claims, which need not match the filename: an
   * explicit `id:` wins, and a bare `name:` derives one. Ids are what key
   * sessions, memory, and credentials, so they are what a collision is
   * about.
   */
  id: string;
  name: string;
  /**
   * The soul's allowlist, `undefined` when it has no `tools:` line — which
   * means **every registered tool**, because `executeToolCall` skips the
   * allowlist check entirely for an undefined list. Kept undefined rather
   * than normalised to `[]` so the review can say so: an empty list and a
   * missing one are opposites, and reporting the wider one as "no tools"
   * is the review lying in the one direction that matters.
   */
  tools: string[] | undefined;
  /**
   * The soul's `credentials:` list, the other capability gate. Undefined is
   * *none* here, the opposite of `tools`: `assertCredentialAllowed` refuses
   * a name the list does not carry, so a soul with no list reaches no
   * stored secret at all.
   */
  credentials: string[] | undefined;
  /**
   * The soul's `delegates:` list, the third gate, and the one that reaches
   * furthest: a target on it runs a turn as *that* agent, with that agent's
   * tools, credentials, and memory, and `*` names the whole roster.
   * Undefined is none, like `credentials`.
   */
  delegates: string[] | undefined;
  /** Already installed under this filename; `--force` replaces it. */
  taken: boolean;
  /**
   * Why this soul cannot be installed at all, if it cannot. An id claimed
   * by a *different* file — another template soul, or a roster soul under
   * another name — is fatal rather than skippable: `loadRosterSouls`
   * refuses a duplicate id, so installing one takes down the whole roster
   * until somebody finds the file. `--force` cannot help, because the
   * clash is not with the file this would overwrite.
   */
  blocked?: string;
}

interface TemplatePlan {
  name: string;
  description: string;
  directory: string;
  agents: TemplateAgentPlan[];
  skills: string[];
  /** Plugin packages the config block names, in the order it names them. */
  packages: string[];
  /** Packages of those that this install would have to fetch. */
  missing: string[];
  config: JsonObject;
  /** Every value the fragment sets, so the review can show them. */
  configChanges: TemplateConfigChange[];
}

interface TemplateConfigChange {
  /** A dotted path into the config, e.g. `plugins.@stratusagent/tool-fs.roots`. */
  path: string;
  value: JsonValue;
  /** What that path says today, when the fragment replaces something. */
  was?: JsonValue;
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merge a template's `config.json` onto the config that exists.
 *
 * Plain objects merge key by key; scalars and arrays replace. That rule is
 * what keeps `plugins` additive — a template naming one package must not
 * take away the packages already enabled, which is exactly the data loss
 * `stratus setup` used to cause.
 */
const mergeTemplateConfig = (base: JsonValue | undefined, incoming: JsonValue): JsonValue => {
  if (!isPlainObject(base) || !isPlainObject(incoming)) {
    return incoming;
  }
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = mergeTemplateConfig(base[key], value as JsonValue);
  }
  return merged;
};

/**
 * The document a template's config would produce, refused if the loader
 * would refuse it.
 *
 * `validateConfigFile` exists for this — "anything that *writes* a config
 * has to answer the same question the loader answers", says its own doc
 * comment — and a template's `config.json` is only checked for being an
 * object, so `plugins: []` or `api: { port: "bad" }` would otherwise be
 * written and make the whole global config unreadable on the next run.
 */
/**
 * Fragment leaves the validated document does not carry, by dotted path.
 *
 * `validateConfigFile` normalizes: it builds a fresh document out of the
 * fields it recognizes, so a top-level key of the wrong type is dropped
 * rather than refused. `model: 123` over an existing `model: "sonnet"`
 * therefore deletes the model, while the review says it sets it to 123 and
 * the command reports success. Saving only what survives is right; saving
 * it without saying what did not is the bug.
 */
const leavesNotApplied = (
  fragment: JsonValue,
  validated: JsonValue | undefined,
  prefix: readonly string[] = [],
): string[] => {
  if (!isPlainObject(fragment)) {
    return JSON.stringify(validated) === JSON.stringify(fragment) ? [] : [prefix.join('.')];
  }
  // An empty object asks for a block, not for emptiness: the merge leaves
  // whatever was already there, so anything object-shaped satisfies it.
  if (!isPlainObject(validated)) {
    return [prefix.join('.')];
  }
  return Object.entries(fragment)
    .flatMap(([key, child]) => leavesNotApplied(child as JsonValue, validated[key], [...prefix, key]));
};

const mergedTemplateConfig = (
  current: CliConfigFile,
  fragment: JsonObject,
  configPath: string,
): CliConfigFile => {
  const merged = mergeTemplateConfig(current as JsonValue, fragment);
  let validated: CliConfigFile;
  try {
    validated = validateConfigFile(merged, configPath);
  } catch (error) {
    throw new Error(
      `This template's ${TEMPLATE_CONFIG_FILENAME} would make ${configPath} unreadable: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dropped = leavesNotApplied(fragment, validated as JsonValue);
  if (dropped.length > 0) {
    throw new Error(
      `This template's ${TEMPLATE_CONFIG_FILENAME} sets ${dropped.map(fromTemplate).join(', ')}, `
      + `which ${configPath} cannot hold — the wrong type, or not a setting at all. `
      + 'Installing it would drop those keys while the review said it set them, '
      + 'and a key you already had set would go with them. Fix the template.',
    );
  }
  return validated;
};

/**
 * Every value a config fragment actually sets, as a dotted path.
 *
 * The review used to print the top-level keys — `config plugins` — which
 * says nothing about what changed. A fragment's capability lives in its
 * leaves: `plugins.@stratusagent/tool-fs.roots` is the difference between
 * reading `~/notes` and reading `/`, and a review that hides it is a
 * review that can be used to smuggle one past an operator.
 *
 * An empty object is a leaf in its own right: `{ plugins: { pkg: {} } }`
 * adds a block, and printing nothing for it would lose that too.
 */
const configLeaves = (
  value: JsonValue,
  current: JsonValue | undefined,
  prefix: readonly string[] = [],
): TemplateConfigChange[] => {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    const replaced = current !== undefined && JSON.stringify(current) !== JSON.stringify(value);
    return [{ path: prefix.join('.'), value, ...(replaced ? { was: current } : {}) }];
  }
  // The current value is walked alongside rather than looked up by the
  // dotted path afterwards: npm names may contain dots, so `plugins` plus
  // a key like `a.b` renders a path that does not parse back to the key it
  // came from — and a "replaces" note naming the wrong value would be
  // worse than none.
  return Object.entries(value).flatMap(([key, child]) => configLeaves(
    child as JsonValue,
    isPlainObject(current) ? current[key] : undefined,
    [...prefix, key],
  ));
};

/**
 * Whether the soul already at `destination` is itself the holder of `id`.
 * A match is the ordinary `--force` replacement rather than a collision with
 * somebody else's agent; an unreadable or absent file is not holding it.
 */
const destinationHoldsId = async (destination: string, id: string): Promise<boolean> => {
  try {
    return (await loadSoulFile(destination)).agent.id === id;
  } catch {
    return false;
  }
};

const readTemplateJson = async (file: string): Promise<JsonObject | undefined> => {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  return parsed;
};

/** Read a template directory and work out what installing it would do. */
const planTemplateInstall = async (
  env: CliEnvironment,
  directory: string,
  warn: (line: string) => void,
): Promise<TemplatePlan> => {
  const manifest = await readTemplateJson(path.join(directory, TEMPLATE_MANIFEST_FILENAME));
  if (!manifest) {
    throw new Error(
      `${directory} has no ${TEMPLATE_MANIFEST_FILENAME}, so it is not a template. `
      + 'A template is a directory with template.json in it; see docs/guides/templates.md.',
    );
  }
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  if (!name || !description) {
    throw new Error(`${path.join(directory, TEMPLATE_MANIFEST_FILENAME)} needs a "name" and a "description".`);
  }

  const config = await readTemplateJson(path.join(directory, TEMPLATE_CONFIG_FILENAME)) ?? {};
  const pluginsBlock = config.plugins;
  const packages = isPlainObject(pluginsBlock) ? Object.keys(pluginsBlock) : [];
  for (const specifier of packages) {
    if (!NPM_PACKAGE_NAME.test(specifier)) {
      throw new Error(
        `${JSON.stringify(specifier)} is not an npm package name, so this template will not be installed. `
        + 'A plugins key names the package to install and enable, nothing else.',
      );
    }
  }
  // What this install would have to fetch. Resolved the way the daemon
  // resolves a plugin, so "already installed" means the same thing here as
  // it does when the plugin is loaded.
  const missing = packages.filter((specifier) => {
    try {
      import.meta.resolve(specifier);
      return false;
    } catch {
      return true;
    }
  });

  const agents: TemplateAgentPlan[] = [];
  const agentsDir = path.join(directory, TEMPLATE_AGENTS_DIRNAME);
  let agentFiles: string[] = [];
  try {
    agentFiles = (await readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  // The ids already spoken for, by path, so a soul whose id matches the very
  // file it would replace is the ordinary `--force` case rather than a
  // collision. A roster that is already broken is warned about and skipped:
  // this command is not the place to refuse over somebody else's duplicate.
  // `declaredAgentIds`, not a roster read of this command's own: it is the
  // set an id is actually claimed against — the roster, the configured
  // default soul (which can live outside `agents/` and still be served),
  // and the built-in `stratus`. Reading the roster alone said "available"
  // for ids the daemon would then hand to somebody else.
  // Pinned to the global config, because that is the one this command
  // merges into. Unpinned, `declaredAgentIds` resolves the configured soul
  // by the working directory's precedence, so a checkout carrying a
  // `stratus.config.json` hides the global config's own `soul:` — and an id
  // that soul holds is then claimed against the wrong set, installing a
  // roster entry the daemon shadows.
  const declared = agentFiles.length > 0
    ? await declaredAgentIds(env, globalConfigPath(env))
    : { ids: new Set<string>(), unread: [] as string[] };
  if (declared.unread.length > 0) {
    warn(`could not read ${declared.unread.join(' or ')}, so ids were not checked against what it declares.`);
  }

  const claimedHere = new Map<string, string>();
  for (const file of agentFiles) {
    // Parsed rather than copied blind: the review below can only name the
    // agent and its tools if the soul actually reads, and a template
    // shipping a broken one should fail here rather than at the next run.
    const soulPath = path.join(agentsDir, file);
    const soul = await loadSoulFile(soulPath);
    // The bytes the review is about, kept rather than re-read at copy time:
    // a local template is a directory something else can edit, and the gap
    // between the prompt and the copy is however long a human takes. What
    // lands has to be what was shown.
    const contents = await readFile(soulPath, 'utf8');
    const destination = path.join(agentsDirPath(env), file);
    let taken = false;
    try {
      await stat(destination);
      taken = true;
    } catch {
      // Not installed under this name.
    }
    const replacesOwnId = taken && await destinationHoldsId(destination, soul.agent.id);
    const alsoHere = claimedHere.get(soul.agent.id);
    const blocked = alsoHere !== undefined
      ? `${alsoHere} in this template already claims the id ${soul.agent.id}`
      : !replacesOwnId && declared.ids.has(soul.agent.id)
        ? `something already claims the id ${soul.agent.id}`
        : undefined;
    claimedHere.set(soul.agent.id, file);
    agents.push({
      file,
      contents,
      id: soul.agent.id,
      name: soul.agent.name,
      tools: soul.agent.tools ? [...soul.agent.tools] : undefined,
      credentials: soul.agent.credentials ? [...soul.agent.credentials] : undefined,
      delegates: soul.agent.delegates ? [...soul.agent.delegates] : undefined,
      taken,
      ...(blocked !== undefined ? { blocked } : {}),
    });
  }

  // Discovered by the same call that will install them. A directory listing
  // is a different rule: `discoverSkillsInDirectory` also finds a root
  // `SKILL.md` and the nested `.claude/skills/` layout, so a listing here
  // would omit skills the installer then adds — the review under-reporting
  // what lands, which is the one thing it must not do.
  const skills = (await discoverSkillsInDirectory(path.join(directory, TEMPLATE_SKILLS_DIRNAME)))
    .candidates
    .map((candidate) => candidate.id)
    .sort((left, right) => left.localeCompare(right));

  // Validated against the config as it stands, so a fragment the loader
  // would reject refuses the whole command before a single file is copied.
  // Checked again under the write below, in case the file moved underneath.
  const configChanges: TemplateConfigChange[] = [];
  if (Object.keys(config).length > 0) {
    let current: CliConfigFile = {};
    try {
      current = await loadConfigFile(globalConfigPath(env));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    mergedTemplateConfig(current, config, globalConfigPath(env));
    configChanges.push(...configLeaves(config, current as JsonValue));
  }

  return { name, description, directory, agents, skills, packages, missing, config, configChanges };
};

/**
 * Text a template supplied, on its way to a terminal.
 *
 * Every string in the review comes out of a folder somebody downloaded —
 * the manifest, agent and tool names, config keys, filenames. A key ending
 * in `\u001b[2J` erases the review directly above the prompt, and the
 * operator then approves a display the template wrote. `JSON.stringify`
 * covers a value's C0 range and nothing else, so it is not the guard
 * either. This is the rule `stratus memory list` already applies to
 * untrusted text, for the same reason.
 */
const fromTemplate = (text: string): string => escapeControlCharacters(text);

/**
 * An id as the review prints it in a comma-separated list. An id may itself
 * contain a comma or a space — the validator allows both — and a review
 * that printed `editor, reviewer` for one grant to the agent `editor, reviewer`
 * and for two grants alike would be a security review that cannot be read.
 * Such an id is JSON-quoted; a plain one stays plain.
 */
const reviewId = (id: string): string => (/[,\s"']/.test(id) ? JSON.stringify(id) : id);

/** What the operator says yes to: every file this would add, and every package. */
const writeTemplatePlan = (streams: CliStreams, plan: TemplatePlan, env: CliEnvironment): void => {
  writeLine(streams.stdout, `${fromTemplate(plan.name)} — ${fromTemplate(plan.description)}`);
  writeLine(streams.stdout);
  for (const agent of plan.agents) {
    // An absent `tools:` is not "none", it is "all" — see TemplateAgentPlan.
    const tools = agent.tools === undefined
      ? 'EVERY tool, because the soul has no tools: list'
      : agent.tools.length > 0 ? fromTemplate(agent.tools.join(', ')) : 'no tools';
    writeLine(streams.stdout, `  agent    ${fromTemplate(agent.name)} (${fromTemplate(agent.id)}) — ${tools}`);
    // The other gate, and the one nobody expects a folder of markdown to
    // move: a name here reaches the stored secret of that name the moment
    // the soul lands. Printed on its own line rather than appended to the
    // tools, because it is a different kind of grant.
    if (agent.credentials !== undefined && agent.credentials.length > 0) {
      writeLine(streams.stdout, `           may read your stored credentials: ${fromTemplate(agent.credentials.join(', '))}`);
    }
    // The furthest-reaching grant a folder of markdown can carry: a target
    // runs a turn as that agent, under that agent's tools, credentials, and
    // memory, and the wildcard is the whole roster — including agents this
    // template never saw. Said in those words, like the empty tools: list.
    if (agent.delegates !== undefined && agent.delegates.length > 0) {
      writeLine(
        streams.stdout,
        agent.delegates.includes('*')
          ? '           may hand work to EVERY agent on your roster, and run as them (delegates: [*])'
          : `           may hand work to, and run as: ${fromTemplate(agent.delegates.map(reviewId).join(', '))}`,
      );
    }
    if (agent.blocked !== undefined) {
      writeLine(streams.stdout, `           cannot install ${fromTemplate(agent.file)}: ${fromTemplate(agent.blocked)}.`);
    } else if (agent.taken) {
      writeLine(streams.stdout, `           ${fromTemplate(agent.file)} is already in your roster; --force replaces it.`);
    }
  }
  for (const skill of plan.skills) {
    writeLine(streams.stdout, `  skill    ${fromTemplate(skill)}`);
  }
  for (const specifier of plan.packages) {
    const note = plan.missing.includes(specifier) ? 'npm install -g' : 'already installed';
    writeLine(streams.stdout, `  plugin   ${fromTemplate(specifier)} (${note})`);
  }
  if (plan.configChanges.length > 0) {
    writeLine(streams.stdout, `  config   ${globalConfigPath(env)}`);
    for (const change of plan.configChanges) {
      const replaces = change.was !== undefined ? `  (replaces ${fromTemplate(JSON.stringify(change.was))})` : '';
      writeLine(streams.stdout, `           ${fromTemplate(change.path)}: ${fromTemplate(JSON.stringify(change.value))}${replaces}`);
    }
  }
  writeLine(streams.stdout);
};

/** A y/N on stderr, so stdout stays exactly what `--yes` would have printed. */
const confirmTemplateInstall = async (streams: CliStreams, env: CliEnvironment): Promise<boolean> => {
  const input = env.templateInput ?? process.stdin;
  const readline = createInterface({ input, terminal: false });
  streams.stderr.write('Install this? [y/N] ');
  try {
    const answer = await new Promise<string>((resolve) => {
      readline.once('line', resolve);
      readline.once('close', () => resolve(''));
    });
    writeLine(streams.stderr);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
};

export const runTemplateAdd = async (
  command: ParsedTemplateAddCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const resolved = await resolveSource(command.source, env, 'template');
  // Everything is read from a directory nothing else can write, so what the
  // review described is what installs. A clone is already private; a local
  // path is not — it is a working copy somebody may be editing, and the gap
  // between printing the review and copying is however long the operator
  // takes to answer plus however long `npm install -g` runs.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'stratus-template-add-'));
  const cleanup = (): Promise<void> => rm(scratch, { recursive: true, force: true });
  const directory = scratch;
  try {
    if (resolved.kind === 'local') {
      // verbatimSymlinks for the reason `installSkillsFromDirectory` uses it
      // on its own staging copy: the default rewrites a relative link to an
      // absolute path into the source tree, and `findEscapingSymlink` then
      // reads a skill's own intra-skill link as reaching outside itself and
      // skips the skill. Installing the same folder through `skill add`
      // accepts it, so the snapshot must not change the answer.
      await cp(resolved.directory, scratch, { recursive: true, verbatimSymlinks: true });
    } else {
      writeLine(streams.stdout, `Fetching ${redactedSourceUrl(resolved.url)} …`);
      await cloneSource(resolved.url, scratch);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  try {
    const plan = await planTemplateInstall(env, directory, (line) => writeLine(streams.stderr, `Warning: ${fromTemplate(line)}`));
    writeTemplatePlan(streams, plan, env);

    if (!command.yes && !await confirmTemplateInstall(streams, env)) {
      writeLine(streams.stderr, 'Nothing was installed.');
      return 1;
    }

    // Packages first, config last. A package installed with nothing
    // enabling it is inert; a config enabling a package that is not
    // installed makes the daemon warn and skip it on every start.
    if (plan.missing.length > 0) {
      const installer = env.packageInstaller ?? defaultPackageInstaller;
      const result = await installer(plan.missing);
      if (!result.ok) {
        writeLine(streams.stderr, `Could not install ${plan.missing.join(' ')}: ${result.message}`);
        writeLine(streams.stderr, 'Nothing was installed.');
        return 1;
      }
    }

    await mkdir(agentsDirPath(env), { recursive: true });
    // Re-read the claimed ids rather than trusting the plan's snapshot. The
    // exclusive write below only catches a collision on the same *path*, and
    // an id is claimed by content: another `template add`, an `agent new`, or
    // a hand-edited soul can take one under a different filename while the
    // review sits at its prompt. Two files with one id is what
    // `loadRosterSouls` refuses, and it refuses the whole roster. This
    // narrows the window rather than closing it — the same gap between the
    // read and the write that `stratus agent new` has.
    const claimedNow = plan.agents.length > 0
      ? await declaredAgentIds(env, globalConfigPath(env))
      : { ids: new Set<string>() };
    const installedAgents: string[] = [];
    const enabledPackages: Array<{ specifier: string; on: boolean }> = [];
    const refusedAgents: string[] = [];
    const blockedAgents: string[] = [];
    for (const agent of plan.agents) {
      const destination = path.join(agentsDirPath(env), agent.file);
      // Never, with or without --force: two files claiming one id is what
      // `loadRosterSouls` refuses, and it refuses the whole roster.
      if (agent.blocked !== undefined) {
        blockedAgents.push(`${agent.file} — ${agent.blocked}`);
        continue;
      }
      if (claimedNow.ids.has(agent.id) && !await destinationHoldsId(destination, agent.id)) {
        blockedAgents.push(`${agent.file} — something already claims the id ${agent.id}`);
        continue;
      }
      if (agent.taken && !command.force) {
        refusedAgents.push(agent.file);
        continue;
      }
      try {
        // `--force` removes the entry first rather than writing over it: a
        // roster entry can be a symlink, and writing through one truncates
        // whatever it points at — a file outside the agents directory that
        // this command was never asked to touch. `unlink` removes the link
        // itself, so a dangling one is replaced too.
        if (command.force) {
          try {
            await unlink(destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
          }
        }
        // Always exclusive, both paths: the destination was checked while
        // planning, and another `template add`, a setup flow, or an editor
        // can create it in the meantime. Without the flag the documented
        // "refused without --force" quietly becomes an overwrite of
        // somebody's newer file, and a forced write lands on a file created
        // after the unlink.
        await writeFile(destination, agent.contents, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        refusedAgents.push(agent.file);
        continue;
      }
      installedAgents.push(`${fromTemplate(agent.name)} (${fromTemplate(agent.id)})`);
    }

    // The same installer `skill add` uses, so a skill a template carries
    // and a skill installed by hand land identically — including the
    // refuse-rather-than-overwrite rule.
    const skillResult = plan.skills.length > 0
      ? await installSkillsFromDirectory(env, path.join(directory, TEMPLATE_SKILLS_DIRNAME), {
        ...(command.force ? { force: true } : {}),
      })
      : { installed: [], skipped: [], warnings: [], alreadyInstalled: [] };

    if (Object.keys(plan.config).length > 0) {
      const configPath = globalConfigPath(env);
      let current: CliConfigFile = {};
      try {
        current = await loadConfigFile(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      const merged = mergedTemplateConfig(current, plan.config, configPath);
      await saveConfigFile(configPath, merged);
      // What the merged block says, not what the template asked for. A
      // fragment carrying `enabled: false`, or one that says nothing about
      // `enabled` over a block already disabled, leaves the plugin off —
      // and "enabled X" would then be the command reporting a capability
      // the next restart will not provide.
      for (const specifier of plan.packages) {
        const block = merged.plugins?.[specifier];
        enabledPackages.push({ specifier, on: block?.enabled !== false });
      }
    }

    for (const agent of installedAgents) {
      writeLine(streams.stdout, `installed ${agent}`);
    }
    for (const skill of skillResult.installed) {
      writeLine(streams.stdout, `installed skill ${fromTemplate(skill.id)}`);
    }
    const enabled = enabledPackages.filter((entry) => entry.on).map((entry) => entry.specifier);
    const stillOff = enabledPackages.filter((entry) => !entry.on).map((entry) => entry.specifier);
    if (enabled.length > 0) {
      writeLine(streams.stdout, `enabled ${fromTemplate(enabled.join(', '))} in ${globalConfigPath(env)}`);
    }
    for (const specifier of stillOff) {
      writeLine(streams.stdout, `configured ${fromTemplate(specifier)} in ${globalConfigPath(env)}, still disabled`);
    }

    // Warnings rather than failures, on stderr, for the reason `skill add`
    // puts its own there: the rest of the template installed, and stdout is
    // the record of what landed. Only a template that added nothing at all
    // is an error.
    for (const file of refusedAgents) {
      writeLine(streams.stderr, command.force
        ? `Warning: skipped ${fromTemplate(file)} — something created it while this was installing. Run the same command again to replace it.`
        : `Warning: skipped ${fromTemplate(file)} — an agent of that name is already in your roster (--force replaces it).`);
    }
    for (const blocked of blockedAgents) {
      writeLine(streams.stderr, `Warning: skipped ${fromTemplate(blocked)}. Ids key sessions, memory, and credentials, so one of them has to change.`);
    }
    for (const skipped of skillResult.skipped) {
      writeLine(streams.stderr, `Warning: skipped skill ${fromTemplate(skipped.id)}: ${fromTemplate(skipped.reason)}`);
    }
    // What installed *with* a caveat — a field another host owns, a bundled
    // scripts/ — said the same way `skill add` says it. The operator
    // deciding whether to enable a skill is the one who needs to hear it,
    // and a template installs skills without their asking for each.
    for (const warning of skillResult.warnings) {
      writeLine(streams.stderr, `Warning: ${fromTemplate(warning.id)}: ${fromTemplate(warning.message)}`);
    }
    if (installedAgents.length === 0 && skillResult.installed.length === 0 && Object.keys(plan.config).length === 0) {
      writeLine(streams.stderr, 'Error: nothing was installed.');
      return 1;
    }

    // A running daemon holds its roster and its plugins in memory: souls are
    // re-read only for agents it already has, and a plugin is loaded at
    // start. So anything that landed needs the announced restart before it
    // is served — not only a plugin change.
    writeLine(streams.stdout);
    writeLine(streams.stdout, 'Tell a running daemon about it:');
    writeLine(streams.stdout, '  stratus restart          # picks up new agents, skills, and plugins');
    return 0;
  } finally {
    await cleanup();
  }
};
