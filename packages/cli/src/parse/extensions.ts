/*
 * `stratus template`, `stratus skill`, `stratus skills` and `stratus plugins`:
 * what an agent is built from, added, checked and listed.
 */
import { type ParsedHelpCommand, readFormatValue, readOptionValue } from './shared.ts';

export interface ParsedTemplateAddCommand {
  command: 'template-add';
  /** A GitHub `owner/repo`, a git URL, or a local path. */
  source: string;
  /** Skip the review and install straight away. */
  yes?: boolean;
  /** Replace an agent or skill already installed under the same name. */
  force?: boolean;
}

export interface ParsedSkillAddCommand {
  command: 'skill-add';
  /** A GitHub `owner/repo`, a git URL, or a local path. */
  source: string;
  /** Install only these ids (repeatable --skill). */
  skillIds?: string[];
  /** Replace an already-installed id instead of refusing it. */
  force?: boolean;
  /** Enable the installed skills in this agent's soul afterwards. */
  agentId?: string;
  /** Tell a running daemon to reload its skills afterwards. Default true; `--no-reload` sets false. */
  reload?: boolean;
}

export interface ParsedSkillValidateCommand {
  command: 'skill-validate';
  /** A skill directory, a directory of skills, or an installed skill's id. */
  target: string;
}

export interface ParsedPluginsCommand {
  command: 'plugins';
  format: 'text' | 'json';
  /** The config whose plugins block to read, when not the default. */
  configPath?: string;
}

export interface ParsedSkillsCommand {
  command: 'skills';
}

export interface ParsedSkillReloadCommand {
  command: 'skill-reload';
  /** A daemon's control API URL; default: the one `~/.stratus/gateway.json` names. */
  gateway?: string;
  token?: string;
}

export const parsePluginsCommand = (command: 'plugins' | 'plugin', rest: string[]): ParsedPluginsCommand | ParsedHelpCommand => {
  const pluginsRest = command === 'plugins' ? rest : rest.slice(1);
  let format: 'text' | 'json' = 'text';
  let configPath: string | undefined;
  for (let index = 0; index < pluginsRest.length; index += 1) {
    const token = pluginsRest[index] as string;
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--format') {
      format = readFormatValue(pluginsRest, index, ['text', 'json']);
      index += 1;
      continue;
    }
    if (token === '--config') {
      configPath = readOptionValue(pluginsRest, index, '--config');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return { command: 'plugins', format, ...(configPath !== undefined ? { configPath } : {}) };
};

export const parseSkillsCommand = (command: 'skills' | 'skill', rest: string[]): ParsedSkillsCommand | ParsedHelpCommand => {
  const skillsRest = command === 'skills' ? rest : rest.slice(1);
  for (const token of skillsRest) {
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return { command: 'skills' };
};

export const parseTemplateCommand = (rest: string[]): ParsedTemplateAddCommand | ParsedHelpCommand => {
  const [subcommand, ...templateRest] = rest;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand !== 'add') {
    throw new Error(`Unknown template subcommand: ${subcommand}. Try: stratus template add <path or owner/repo>`);
  }
  let source: string | undefined;
  let yes = false;
  let force = false;
  for (const token of templateRest) {
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--yes' || token === '-y') {
      yes = true;
      continue;
    }
    if (token === '--force') {
      force = true;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (source !== undefined) {
      throw new Error(`template add takes one source; got both ${JSON.stringify(source)} and ${JSON.stringify(token)}.`);
    }
    source = token;
  }
  if (source === undefined) {
    throw new Error('template add needs a source: a GitHub owner/repo, a git URL, or a local path.');
  }
  return {
    command: 'template-add',
    source,
    ...(yes ? { yes } : {}),
    ...(force ? { force } : {}),
  };
};

export const parseSkillCommand = (rest: string[]): ParsedSkillAddCommand | ParsedSkillValidateCommand | ParsedSkillReloadCommand | ParsedHelpCommand => {
  const [subcommand, ...skillRest] = rest;
  if (subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand === 'validate') {
    let target: string | undefined;
    for (const token of skillRest) {
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (target !== undefined) {
        throw new Error(`skill validate takes one target; got both ${JSON.stringify(target)} and ${JSON.stringify(token)}.`);
      }
      target = token;
    }
    if (target === undefined) {
      throw new Error('skill validate needs a target: a skill directory, a directory of skills, or an installed skill id.');
    }
    return { command: 'skill-validate', target };
  }
  if (subcommand === 'reload') {
    const parsed: ParsedSkillReloadCommand = { command: 'skill-reload' };
    for (let index = 0; index < skillRest.length; index += 1) {
      const token = skillRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--gateway') {
        parsed.gateway = readOptionValue(skillRest, index, '--gateway');
        index += 1;
        continue;
      }
      if (token === '--token') {
        parsed.token = readOptionValue(skillRest, index, '--token');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }
  if (subcommand !== 'add') {
    throw new Error(`Unknown skill subcommand: ${subcommand ?? '(missing)'}. Try: stratus skill add <source>, stratus skill validate <path>, stratus skill reload, stratus skills`);
  }

  let source: string | undefined;
  const skillIds: string[] = [];
  let force = false;
  let agentId: string | undefined;
  let reload = true;

  for (let index = 0; index < skillRest.length; index += 1) {
    const token = skillRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--skill') {
      skillIds.push(readOptionValue(skillRest, index, '--skill'));
      index += 1;
      continue;
    }
    if (token === '--agent') {
      agentId = readOptionValue(skillRest, index, '--agent');
      index += 1;
      continue;
    }
    if (token === '--force') {
      force = true;
      continue;
    }
    if (token === '--no-reload') {
      reload = false;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (source !== undefined) {
      throw new Error(`skill add takes one source; got both ${JSON.stringify(source)} and ${JSON.stringify(token)}.`);
    }
    source = token;
  }

  if (source === undefined) {
    throw new Error('skill add needs a source: a GitHub owner/repo, a git URL, or a local path.');
  }

  return {
    command: 'skill-add',
    source,
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(force ? { force } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(reload ? {} : { reload }),
  };
};
