import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, matchesSkillAllowlist } from '@stratusagent/core';
import { formatSoul, isLoadableSkillId, type ParsedSoul } from '@stratusagent/agents';
import {
  agentsDirPath,
  discoverSkillsInDirectory,
  installSkillsFromDirectory,
  loadOperatorSkills,
  loadRosterSouls,
  skillsDirPath,
  readWorkingDirectory,
  gatewayInfoPath,
} from '@stratusagent/state';
import {
  runningGatewayBase,
  callRunningGateway,
  gatewayErrorMessage,
  noRunningDaemonMessage,
  readGatewayInfo,
} from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type {
  ParsedSkillAddCommand,
  ParsedSkillValidateCommand,
  ParsedSkillReloadCommand,
} from '../parse.ts';
import { rosterSoulsWithConfigured } from '../roster.ts';
import { resolveSource, redactedSourceUrl, cloneSource } from '../source.ts';

export const runSkillAdd = async (
  command: ParsedSkillAddCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const resolved = await resolveSource(command.source, env, 'skill');
  let sourceDir: string;
  let cleanup: (() => Promise<void>) | undefined;
  if (resolved.kind === 'local') {
    sourceDir = resolved.directory;
  } else {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'stratus-skill-add-'));
    cleanup = () => rm(scratch, { recursive: true, force: true });
    writeLine(streams.stdout, `Fetching ${redactedSourceUrl(resolved.url)} …`);
    try {
      await cloneSource(resolved.url, scratch);
    } catch (error) {
      await cleanup();
      throw error;
    }
    sourceDir = scratch;
  }

  try {
    // For a cloned source the temp directory's random basename must not
    // name a root-level skill — the repository's own name is what a
    // nameless root SKILL.md installs under.
    const rootId = resolved.kind === 'git'
      ? path.basename(new URL(resolved.url.replace(/^git@([^:]+):/, 'ssh://git@$1/')).pathname, '.git')
      : undefined;
    const result = await installSkillsFromDirectory(env, sourceDir, {
      ...(command.skillIds ? { only: command.skillIds } : {}),
      ...(command.force ? { force: true } : {}),
      ...(rootId !== undefined && rootId.length > 0 ? { rootId } : {}),
    });

    for (const skill of result.installed) {
      writeLine(streams.stdout, `installed ${skill.id} — ${skill.description}`);
      // The spec's compatibility field is written for exactly this reader:
      // the person deciding whether this environment can carry the skill.
      if (skill.compatibility !== undefined) {
        writeLine(streams.stdout, `  compatibility: ${skill.compatibility}`);
      }
    }
    // What installed with a caveat — a field another host owns, the
    // legacy key form, a bundled scripts/ — is said next to the install,
    // per skill: the operator deciding to enable it is the one who needs
    // to hear it, and this is the moment they are looking.
    for (const warning of result.warnings) {
      writeLine(streams.stderr, `Warning: ${warning.id}: ${warning.message}`);
    }
    // Present already is a no-op, not a failure — and exactly what the
    // "rerun with --agent" hint below produces, so these stay eligible
    // for the enablement step.
    for (const skill of result.alreadyInstalled) {
      writeLine(streams.stdout, `already installed ${skill.id} — ${skill.description}`);
    }
    for (const skip of result.skipped) {
      writeLine(streams.stderr, `Warning: skipped ${skip.id}: ${skip.reason}`);
    }
    if (result.installed.length === 0 && result.alreadyInstalled.length === 0) {
      writeLine(streams.stderr, result.skipped.length > 0
        ? 'Error: nothing was installed.'
        : `Error: no skills found in ${command.source}. A skill is a directory with a SKILL.md.`);
      return 1;
    }

    // The ordinary path needs no second step: a daemon that is running
    // serves what was just installed from its next turn. Only when
    // something changed on disk — a re-run that installed nothing has
    // nothing to reload — and only where a daemon has said it is running.
    if (result.installed.length > 0 && command.reload !== false) {
      await reloadRunningDaemonSkills(streams, env);
    }

    // Installed is not enabled: a soul opts in through its skills:
    // allowlist, and that stays true when the install came through a
    // command. --agent is the explicit way to say both at once.
    const ids = [...result.installed, ...result.alreadyInstalled].map((skill) => skill.id);
    if (command.agentId === undefined) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, 'Installed, not yet enabled. Add to an agent\'s soul frontmatter:');
      writeLine(streams.stdout, '  skills:');
      for (const id of ids) {
        writeLine(streams.stdout, `    - ${id}`);
      }
      writeLine(streams.stdout, `(or rerun with --agent <id>, or list them: stratus skills)`);
      return 0;
    }

    const { entries: roster } = await rosterSoulsWithConfigured(env, (line) => writeLine(streams.stderr, `Warning: ${line}`));
    const entry = roster.find((candidate) => candidate.soul.agent.id === command.agentId);
    if (!entry) {
      writeLine(streams.stderr, `Error: no agent with id ${command.agentId} in ${agentsDirPath(env)} or the configured soul. The skills are installed; enable them by editing a soul.`);
      return 1;
    }
    const existing = entry.soul.agent.skills ?? [];
    const additions = ids.filter((id) => !matchesSkillAllowlist(id, existing));
    if (additions.length === 0) {
      writeLine(streams.stdout, `${entry.soul.agent.name} already has all of these enabled.`);
      return 0;
    }
    // A field edit renders through formatSoul, which canonicalizes the
    // file — same trade the control API's field edits make.
    const next: ParsedSoul = {
      ...entry.soul,
      agent: { ...entry.soul.agent, skills: [...existing, ...additions] },
    };
    await writeFile(entry.path, formatSoul(next));
    writeLine(streams.stdout, `enabled for ${next.agent.name} (${entry.path}): ${additions.join(', ')}`);
    return 0;
  } finally {
    await cleanup?.();
  }
};

/**
 * `stratus skill validate <target>`: the install-time check, run without
 * installing — for an author about to publish a skill, or an operator
 * asking why one was refused. A local path is a skill directory or a
 * directory of skills, discovered exactly as `skill add` would; a bare id
 * names an installed skill under `~/.stratus/skills/`. Exit 1 when
 * anything would be refused, so a publish step can gate on it.
 */
export const runSkillValidate = async (
  command: ParsedSkillValidateCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  let directory: string | undefined;
  let installed = false;
  const localPath = path.resolve(readWorkingDirectory(env), command.target);
  try {
    if ((await stat(localPath)).isDirectory()) {
      directory = localPath;
    }
  } catch {
    // Not a local directory; try it as an installed id.
  }
  // The loader's rule for the lookup, so a directory that loads with a
  // pre-spec id can be validated — and told what to rename.
  if (directory === undefined && isLoadableSkillId(command.target)) {
    const installedPath = path.join(skillsDirPath(env), command.target);
    try {
      if ((await stat(installedPath)).isDirectory()) {
        directory = installedPath;
        installed = true;
      }
    } catch {
      // Not installed either.
    }
  }
  if (directory === undefined) {
    writeLine(
      streams.stderr,
      `Error: ${JSON.stringify(command.target)} is neither a directory nor an installed skill id (stratus skills lists those).`,
    );
    return 1;
  }

  // An installed directory IS the layout the spec's directory rule is
  // about, so its name is checked; a path the author typed is a checkout
  // or a container, judged as `skill add` would judge it.
  const { candidates, skipped } = await discoverSkillsInDirectory(
    directory,
    installed ? { checkRootDirectoryName: true } : {},
  );
  if (candidates.length === 0 && skipped.length === 0) {
    writeLine(streams.stderr, `Error: no skills found in ${directory}. A skill is a directory with a SKILL.md.`);
    return 1;
  }
  for (const candidate of candidates) {
    const caveat = candidate.warnings.length > 0
      ? ` — ${candidate.warnings.length} warning${candidate.warnings.length === 1 ? '' : 's'}`
      : '';
    writeLine(streams.stdout, `${candidate.id}: ok${caveat}`);
    for (const warning of candidate.warnings) {
      writeLine(streams.stdout, `  warning: ${warning}`);
    }
  }
  for (const skip of skipped) {
    writeLine(streams.stdout, `${skip.id}: refused`);
    writeLine(streams.stdout, `  error: ${skip.reason}`);
  }
  if (skipped.length > 0) {
    const noun = skipped.length === 1 ? 'skill' : 'skills';
    writeLine(streams.stderr, `Error: ${skipped.length} ${noun} would be refused at install.`);
    return 1;
  }
  return 0;
};

/**
 * After `skill add`: tell the daemon, if one says it is running. Silent
 * when none does — a `stratus run` user with no daemon should not read a
 * note about one — and a warning, never a failure, when the file names a
 * daemon that did not answer: the install itself succeeded.
 */
const reloadRunningDaemonSkills = async (streams: CliStreams, env: CliEnvironment): Promise<void> => {
  const info = await readGatewayInfo(env);
  if (!info) {
    return;
  }
  const base = info.url.replace(/\/+$/, '');
  try {
    const response = await callRunningGateway(env, {}, base, '/api/v1/skills/reload');
    if (!response.ok) {
      throw new Error(await gatewayErrorMessage(response));
    }
    writeLine(streams.stdout, `reloaded the running daemon's skills (${base}) — no restart needed`);
  } catch (error) {
    writeLine(
      streams.stderr,
      `Warning: ${gatewayInfoPath(env)} names a daemon at ${base}, but its skills were not reloaded: `
      + `${error instanceof Error ? error.message : String(error)} If it is running, reload it with: stratus skill reload`,
    );
  }
};

export const runSkillReload = async (
  command: ParsedSkillReloadCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }
  const response = await callRunningGateway(env, command, base, '/api/v1/skills/reload');
  if (!response.ok) {
    writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
    return 1;
  }
  const { skills } = await response.json() as { skills?: Array<{ id: string }> };
  const ids = (skills ?? []).map((skill) => skill.id);
  writeLine(streams.stdout, `reloaded skills in the daemon at ${base} — ${ids.length} skill(s) serving${ids.length > 0 ? `: ${ids.join(', ')}` : ''}`);
  return 0;
};

export const runSkills = async (
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const registry = new SkillRegistry();
  const skills = await loadOperatorSkills(env, registry, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });
  if (skills.length === 0) {
    writeLine(streams.stdout, `No skills installed in ${skillsDirPath(env)}.`);
    writeLine(streams.stdout, 'Install some: stratus skill add <owner/repo | git url | path>');
    return 0;
  }

  // Who has each skill enabled, so the listing answers the question that
  // follows "what is installed" — read from the same roster a dispatch
  // serves. Plugin-contributed skills are the daemon's to list
  // (/catalog/tools); this command reads the operator directory.
  //
  // A roster that will not load (a duplicate agent id, deliberately
  // fatal) is unreadable enablement, not empty enablement: say so and
  // withhold the claim rather than reporting every skill unused.
  let roster: Awaited<ReturnType<typeof loadRosterSouls>> = [];
  let rosterUnreadable = false;
  try {
    const resolved = await rosterSoulsWithConfigured(env, (line) => writeLine(streams.stderr, `Warning: ${line}`));
    roster = resolved.entries;
    rosterUnreadable = !resolved.complete;
  } catch (error) {
    rosterUnreadable = true;
    writeLine(
      streams.stderr,
      `Warning: cannot say who enables what — the roster did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const skill of skills) {
    let suffix = '';
    if (!rosterUnreadable) {
      const enabledBy = roster
        .filter((entry) => {
          const allowlist = entry.soul.agent.skills;
          return allowlist !== undefined
            && allowlist.length > 0
            && matchesSkillAllowlist(skill.id, allowlist);
        })
        .map((entry) => entry.soul.agent.name);
      suffix = enabledBy.length > 0 ? ` — enabled by ${enabledBy.join(', ')}` : ' — enabled by nobody yet';
    }
    writeLine(streams.stdout, `${skill.id.padEnd(24)}${skill.description}${suffix}`);
  }
  return 0;
};
