/*
 * `stratus people`: who each agent answers to on Slack (`principals`) and
 * who may approve its gated calls (`approvals`), listed and changed without
 * editing the config by hand. The daemon re-reads both at a roster reload,
 * so a change here reaches a running agent without a restart.
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_STRATUS_AGENT,
  globalConfigPath,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  resolveAgentApprovals,
  resolveAgentPrincipals,
  saveConfigFile,
  validateConfigFile,
  withoutTrailingSlashes,
  type ApprovalsConfig,
  type PrincipalsConfig,
  type StratusConfigFile,
} from '@stratusagent/state';
import { callRunningGateway, readGatewayInfo, reloadRunningDaemonChannels } from '../daemon.ts';
import type { CliEnvironment, CliStreams } from '../environment.ts';
import { writeLine } from '../io.ts';
import { compareVersions } from '../npm.ts';
import type { ParsedPeopleCommand } from '../parse.ts';
import { quoteShellArg } from '../prompter.ts';
import { rosterSoulsWithConfigured } from '../roster.ts';
import { loadServeApprovals, loadServePrincipals } from '../trusted-config.ts';

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The two lists this command edits, as the config names them. */
const LISTS = {
  people: { block: 'principals', key: 'slackUsers' },
  approvers: { block: 'approvals', key: 'slackApprovers' },
} as const;
type ListKind = keyof typeof LISTS;

const listName = (kind: ListKind, agentId?: string): string =>
  agentId === undefined
    ? `${LISTS[kind].block}.${LISTS[kind].key}`
    : `${LISTS[kind].block}.agents.${agentId}.${LISTS[kind].key}`;

/**
 * A list as the daemon's parser reads it: absent unless it is an array, and
 * only its non-empty strings. An empty array is a list (nobody), distinct
 * from no list (inherit the shared one).
 */
const readList = (config: Raw, kind: ListKind, agentId?: string): string[] | undefined => {
  const block = config[LISTS[kind].block];
  if (!isObject(block)) {
    return undefined;
  }
  const holder = agentId === undefined
    ? block
    : isObject(block.agents) && isObject(block.agents[agentId]) ? block.agents[agentId] : undefined;
  const list = holder?.[LISTS[kind].key];
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : undefined;
};

const writeList = (config: Raw, kind: ListKind, agentId: string | undefined, list: string[]): void => {
  const blockName = LISTS[kind].block;
  const block = isObject(config[blockName]) ? config[blockName] : (config[blockName] = {});
  if (agentId === undefined) {
    block[LISTS[kind].key] = list;
    return;
  }
  const agents = isObject(block.agents) ? block.agents : (block.agents = {});
  const entry = isObject(agents[agentId]) ? agents[agentId] : (agents[agentId] = {});
  entry[LISTS[kind].key] = list;
};

const agentsWithOwnList = (config: Raw, kind: ListKind): string[] => {
  const block = config[LISTS[kind].block];
  return isObject(block) && isObject(block.agents)
    ? Object.keys(block.agents).filter((agentId) => readList(config, kind, agentId) !== undefined)
    : [];
};

interface PeopleEdit {
  added: string[];
  removed: string[];
  /** Lists that unchanged would already have said this. */
  already: string[];
  /** Agent lists that began as a copy of the shared one. */
  copied: string[];
  /** add without --agent: agents with their own list this does not reach. */
  notReached: string[];
}

/**
 * Apply one add or remove to a parsed config, in place. Never deletes a
 * list: an agent whose own list empties keeps `[]`, because a deleted key
 * would hand it the shared list and so admit the people it was kept from.
 */
const editPeople = (
  config: Raw,
  command: { action: 'add' | 'remove'; memberId: string; agentId: string | undefined; approver: boolean },
): PeopleEdit => {
  const { memberId, agentId, approver } = command;
  const edit: PeopleEdit = { added: [], removed: [], already: [], copied: [], notReached: [] };
  if (command.action === 'add') {
    for (const kind of approver ? ['people', 'approvers'] as const : ['people'] as const) {
      const own = readList(config, kind, agentId);
      const current = own ?? (agentId === undefined ? [] : readList(config, kind) ?? []);
      if (current.includes(memberId)) {
        edit.already.push(listName(kind, agentId));
      } else {
        writeList(config, kind, agentId, [...current, memberId]);
        edit.added.push(listName(kind, agentId));
        if (own === undefined && agentId !== undefined) {
          edit.copied.push(listName(kind, agentId));
        }
      }
      if (agentId === undefined) {
        for (const other of agentsWithOwnList(config, kind)) {
          if (!readList(config, kind, other)?.includes(memberId) && !edit.notReached.includes(other)) {
            edit.notReached.push(other);
          }
        }
      }
    }
    return edit;
  }
  for (const kind of approver ? ['approvers'] as const : ['people', 'approvers'] as const) {
    if (agentId === undefined) {
      for (const target of [undefined, ...agentsWithOwnList(config, kind)]) {
        const list = readList(config, kind, target);
        if (list?.includes(memberId)) {
          writeList(config, kind, target, list.filter((entry) => entry !== memberId));
          edit.removed.push(listName(kind, target));
        }
      }
      continue;
    }
    const own = readList(config, kind, agentId);
    const current = own ?? readList(config, kind);
    if (current?.includes(memberId)) {
      writeList(config, kind, agentId, current.filter((entry) => entry !== memberId));
      edit.removed.push(listName(kind, agentId));
      if (own === undefined) {
        edit.copied.push(listName(kind, agentId));
      }
    }
  }
  return edit;
};

/**
 * The file the daemon reads `principals` and `approvals` from: `--config`,
 * then STRATUS_CONFIG, then the global one. Never a project-local
 * `stratus.config.json`: the daemon ignores these blocks there, so writing
 * one would report a change nothing applies.
 */
const trustedConfigPath = (env: CliEnvironment, configPath: string | undefined): string => {
  const explicit = configPath ?? readNonEmptyString(readProcessEnv(env).STRATUS_CONFIG)?.trim();
  return explicit ? path.resolve(readWorkingDirectory(env), explicit) : globalConfigPath(env);
};

/** Roster agents, then any agent the two blocks already name. `configPath` is `--config`, as the daemon was given it. */
const knownAgentIds = async (env: CliEnvironment, configPath: string | undefined, config: Raw, warn: (line: string) => void): Promise<string[]> => {
  const { entries } = await rosterSoulsWithConfigured(env, warn, configPath !== undefined ? { configPath } : {});
  const ids = entries.map((entry) => entry.soul.agent.id);
  for (const blockName of ['principals', 'approvals'] as const) {
    const block = config[blockName];
    if (isObject(block) && isObject(block.agents)) {
      ids.push(...Object.keys(block.agents).sort());
    }
  }
  return [...new Set(ids)];
};

const approvalsModeNote = (mode: unknown, configPath: string): string =>
  `Note: approvals.mode is ${typeof mode === 'string' ? mode : 'headless'}, so a call that needs approval is refused `
  + `rather than asked about. Approvers are asked once it is "remote" in ${configPath} (or the daemon runs with --approvals remote).`;

/**
 * The trusted config a running daemon reads, as it reports it, so a change
 * is never written to a file that daemon does not use (one installed with
 * `--config` reads only that). Undefined when no daemon answers or it
 * cannot say; the reload that follows then reports what it can.
 */
const daemonConfig = async (env: CliEnvironment): Promise<{ base: string; path: string } | undefined> => {
  const info = await readGatewayInfo(env);
  if (!info) {
    return undefined;
  }
  const base = withoutTrailingSlashes(info.url);
  try {
    const response = await callRunningGateway(env, {}, base, '/api/v1/config', undefined, 'GET', AbortSignal.timeout(5_000));
    if (!response.ok) {
      return undefined;
    }
    const { path: daemonPath } = await response.json() as { path?: unknown };
    return typeof daemonPath === 'string' ? { base, path: daemonPath } : undefined;
  } catch {
    return undefined;
  }
};

const samePath = async (a: string, b: string): Promise<boolean> => {
  if (path.resolve(a) === path.resolve(b)) {
    return true;
  }
  try {
    return await realpath(a) === await realpath(b);
  } catch {
    return false;
  }
};

const daemonVersion = async (env: CliEnvironment, base: string): Promise<string | undefined> => {
  try {
    const response = await callRunningGateway(env, {}, base, '/api/v1/health', undefined, 'GET', AbortSignal.timeout(5_000));
    const { version } = await response.json() as { version?: unknown };
    return typeof version === 'string' && version.trim() !== '' ? version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The last release whose Slack reload kept the people lists it started
 * with while still reporting `reloaded`. A fixed bar, not this CLI's own
 * version: one built from source before the next release carries this
 * same number, and a daemon newer than the CLI re-reads them too.
 */
const LAST_START_ONLY_PEOPLE = '0.14.12';

/**
 * Reload a running daemon and say, truthfully, whether the change is live.
 * Only Slack reads these lists, so Slack's outcome is the answer; and a
 * daemon from 0.14.12 or before reports Slack `reloaded` without re-reading
 * the lists, so its version decides whether that can be believed.
 */
const reportDaemon = async (env: CliEnvironment, streams: CliStreams): Promise<void> => {
  const reload = await reloadRunningDaemonChannels(env);
  if (reload === undefined) {
    writeLine(streams.stdout, 'No daemon is serving the control API for this home, so this applies when one starts; a daemon running without it needs `stratus restart`.');
    return;
  }
  if ('warning' in reload) {
    writeLine(streams.stdout, reload.warning);
    return;
  }
  const slack = reload.channels.filter((channel) => channel.name === 'slack');
  const entry = slack.find((channel) => channel.outcome !== 'reloaded') ?? slack[0];
  if (entry === undefined) {
    writeLine(streams.stdout, `The running daemon (${reload.base}) has no Slack connection right now, so these lists apply once it connects.`);
    return;
  }
  if (entry.outcome === 'failed') {
    writeLine(streams.stdout, `The running daemon (${reload.base}) could not reload slack${entry.reason ? ` (${entry.reason})` : ''}, so this applies at its next start: \`stratus restart\`.`);
    return;
  }
  if (entry.outcome !== 'reloaded') {
    writeLine(streams.stdout, `The running daemon (${reload.base}) is still reloading slack; \`stratus logs\` shows when it's done, and \`stratus restart\` applies this if it doesn't finish.`);
    return;
  }
  const version = await daemonVersion(env, reload.base);
  if (version === undefined || compareVersions(version, LAST_START_ONLY_PEOPLE) <= 0) {
    writeLine(
      streams.stdout,
      version === undefined
        ? `The running daemon (${reload.base}) did not say which version it is, so it may still use the old lists. Apply them with: stratus restart`
        : `The running daemon (${reload.base}) is ${version}, which reads these lists only when it starts, so it still uses the old ones. Apply them with: stratus restart`,
    );
    return;
  }
  writeLine(streams.stdout, `The running daemon (${reload.base}) applied this now, with no restart. \`stratus logs\` shows each agent's new counts.`);
};

const describeList = (list: string[] | undefined, source: string | undefined): string =>
  `${list === undefined || list.length === 0 ? 'nobody' : list.join(', ')}${source ? ` (${source})` : ''}`;

const runPeopleList = async (command: ParsedPeopleCommand, streams: CliStreams, env: CliEnvironment): Promise<number> => {
  const warn = (line: string): void => writeLine(streams.stderr, `Warning: ${line}`);
  const configPath = trustedConfigPath(env, command.configPath);
  // The daemon's own readers, so this lists what it would use, a
  // project-local block refused and an unreadable one closed as it is there.
  const principals: PrincipalsConfig = await loadServePrincipals(env, command.configPath, warn);
  const approvals: ApprovalsConfig = await loadServeApprovals(env, command.configPath, warn);
  const raw: Raw = { principals, approvals };
  const ids = await knownAgentIds(env, command.configPath, raw, warn);
  writeLine(streams.stdout, `Who each agent answers to on Slack, from ${configPath}:`);
  let anyApprover = false;
  for (const agentId of ids) {
    const admit = resolveAgentPrincipals(principals, agentId).admit;
    const people = readList(raw, 'people', agentId) ?? readList(raw, 'people');
    const peopleSource = readList(raw, 'people', agentId) !== undefined ? 'its own list'
      : readList(raw, 'people') !== undefined ? 'shared list' : undefined;
    const approvers = resolveAgentApprovals(approvals, agentId).slackApprovers;
    const approverSource = readList(raw, 'approvers', agentId) !== undefined ? 'its own list'
      : readList(raw, 'approvers') !== undefined ? 'shared list' : undefined;
    anyApprover ||= (approvers?.length ?? 0) > 0;
    writeLine(streams.stdout);
    writeLine(streams.stdout, agentId);
    writeLine(streams.stdout, `  admits     ${admit === 'anyone' ? 'anyone' : 'listed people only'}`);
    writeLine(streams.stdout, `  people     ${describeList(people, peopleSource)}`);
    writeLine(streams.stdout, `  approvers  ${describeList(approvers, approverSource)}`);
  }
  writeLine(streams.stdout);
  const daemon = await daemonConfig(env);
  if (daemon !== undefined && !(await samePath(daemon.path, configPath))) {
    writeLine(streams.stdout, `The running daemon reads ${daemon.path}, not this file: stratus people --config ${quoteShellArg(daemon.path)}`);
  }
  if (anyApprover && approvals.mode !== 'remote') {
    writeLine(streams.stdout, approvalsModeNote(approvals.mode, configPath));
  }
  writeLine(streams.stdout, 'Add someone: stratus people add <member-id> [--agent <id>] [--approver]');
  writeLine(streams.stdout, 'Remove someone: stratus people remove <member-id> [--agent <id>] [--approver]');
  return 0;
};

export const runPeople = async (command: ParsedPeopleCommand, streams: CliStreams, env: CliEnvironment): Promise<number> => {
  if (command.action === 'list') {
    return runPeopleList(command, streams, env);
  }
  const { memberId, agentId } = command;
  const approver = command.approver ?? false;
  if (memberId === undefined) {
    throw new Error(`people ${command.action} needs a Slack member ID.`);
  }
  const configPath = trustedConfigPath(env, command.configPath);

  // The raw document, not the loader's normalized copy: saving that would
  // drop every key this build does not know. Validated first, so a file
  // the daemon would already refuse is never rewritten around the problem.
  let config: Raw;
  try {
    let text: string | undefined;
    try {
      text = await readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    validateConfigFile(parsed, configPath);
    config = parsed as Raw;
  } catch (error) {
    writeLine(streams.stderr, `Could not read ${configPath} (${error instanceof Error ? error.message : String(error)}), so it was left untouched. Fix it, then try again.`);
    return 1;
  }

  if (agentId !== undefined) {
    const known = await knownAgentIds(env, command.configPath, config, (line) => writeLine(streams.stderr, `Warning: ${line}`));
    if (!known.includes(agentId) && agentId !== DEFAULT_STRATUS_AGENT.id) {
      writeLine(streams.stderr, `No agent ${agentId} here, so nothing changed. \`stratus agents\` lists them.`);
      return 1;
    }
  }

  const daemon = await daemonConfig(env);
  if (daemon !== undefined && !(await samePath(daemon.path, configPath))) {
    const flags = `${agentId !== undefined ? ` --agent ${agentId}` : ''}${approver ? ' --approver' : ''}`;
    writeLine(
      streams.stderr,
      `The running daemon (${daemon.base}) reads ${daemon.path}, so a change to ${configPath} wouldn't reach it. Nothing changed. `
      + `To change its lists: stratus people ${command.action} ${memberId}${flags} --config ${quoteShellArg(daemon.path)}`,
    );
    return 1;
  }

  const next = structuredClone(config);
  const edit = editPeople(next, { action: command.action, memberId, agentId, approver });
  const changed = [...edit.added, ...edit.removed];
  if (changed.length === 0) {
    if (command.action === 'add') {
      writeLine(streams.stdout, `${memberId} is already on ${edit.already.join(' and ')}; nothing changed.`);
      return 0;
    }
    const where = agentId !== undefined
      ? `${agentId}'s ${approver ? 'approver list' : 'people or approver lists'}`
      : `any ${approver ? 'approver' : 'people or approver'} list`;
    writeLine(streams.stderr, `${memberId} isn't on ${where} in ${configPath}, so nothing changed.`);
    return 1;
  }

  try {
    validateConfigFile(next, configPath);
  } catch (error) {
    writeLine(streams.stderr, `That change would leave ${configPath} invalid (${error instanceof Error ? error.message : String(error)}), so it was left untouched.`);
    return 1;
  }
  await saveConfigFile(configPath, next as StratusConfigFile);

  writeLine(
    streams.stdout,
    command.action === 'add'
      ? `Added ${memberId} to ${edit.added.join(' and ')} in ${configPath}.`
      : `Removed ${memberId} from ${edit.removed.join(', ')} in ${configPath}.`,
  );
  for (const list of edit.copied) {
    writeLine(streams.stdout, `${agentId} used the shared list, so ${list} starts as a copy of it. Later changes to the shared list don't reach ${agentId}.`);
  }
  for (const other of edit.notReached) {
    writeLine(streams.stdout, `${other} has its own list, so this doesn't reach it: stratus people add ${memberId} --agent ${other}${approver ? ' --approver' : ''}`);
  }
  if (command.action === 'add' && approver) {
    const approvals = next.approvals;
    const mode = isObject(approvals) ? approvals.mode : undefined;
    if (mode !== 'remote') {
      writeLine(streams.stdout, approvalsModeNote(mode, configPath));
    }
  }
  await reportDaemon(env, streams);
  return 0;
};
