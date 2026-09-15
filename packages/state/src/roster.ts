import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentDefinition,
  type AgentMemoryStore,
  type AvatarTheme,
  applyMemoryPinBudget,
  boundMemoryList,
  boundMemoryRead,
  clampMemoryRecallLimit,
  compareMemoryChronology,
  memoryContentByteLength,
  mergeMemoryTopics,
  pinnedCapRefusal,
  type MemoryEntry,
  type MemoryPinnedOptions,
  type MemoryPinOutcome,
} from '@stratusagent/core';
import { agentIdWithSuffix, defineAgent, parseSoul, type ParsedSoul } from '@stratusagent/agents';
import { DEFAULT_ANTHROPIC_MODEL } from '@stratusagent/provider-anthropic';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/provider-codex';
import { createFileMemoryStore } from './memory.ts';
import { ConfigFileError } from './config-file.ts';
import { discoverActiveConfig } from './config-location.ts';
import {
  type StateEnvironment,
  readProcessEnv,
  readWorkingDirectory,
  readNonEmptyString,
} from './environment.ts';
import { agentsDirPath, memoryFilePath } from './paths.ts';
import {
  isRegisteredProviderName,
  DEFAULT_OPENAI_MODEL,
  parseProviderName,
} from './provider-names.ts';
import { type SoulPinContext, applySoulPins } from './served.ts';
import { DEFAULT_STRATUS_AGENT, resolveConfiguredSoul, loadRosterSouls } from './souls.ts';

// Unsouled runs used to remember facts under a per-provider default agent.
// Stratus inherits all of them: reads for the built-in agent also return
// entries stored under the legacy ids, while new facts land under 'stratus'.
const LEGACY_DEFAULT_AGENT_IDS = ['demo-agent', 'anthropic-agent', 'openai-agent'];

// Every method is alias-aware, not just `list`: a `search` or `forget` that
// delegated on agentId alone would compile, satisfy the interface, and
// quietly make every inherited entry unfindable and unforgettable — visible
// in `list`, absent from `recall`. Merged batches sort with everything else
// by the shared ordering rule, and bounds apply after the merge, never per
// alias, or a busy legacy id crowds out the others.
export const withLegacyDefaultMemories = (store: AgentMemoryStore): AgentMemoryStore => {
  const aliasIds = (agentId: string): string[] =>
    agentId === DEFAULT_STRATUS_AGENT.id
      ? [DEFAULT_STRATUS_AGENT.id, ...LEGACY_DEFAULT_AGENT_IDS]
      : [agentId];
  /**
   * One budget for the merged identity, not one per alias. Each alias
   * accepts its own pins against its own 2 KiB, so concatenating them can
   * exceed the cap the injected slice would then trim by recency — which is
   * the silent eviction the cap exists to refuse. Allocated here in alias
   * order (and within an alias, that store's append order), so the write
   * path above and the read below cannot disagree about which pins are
   * effective.
   */
  const mergedPinBudget = async (ids: readonly string[], pinnedOptions?: MemoryPinnedOptions): Promise<{
    effective: MemoryEntry[];
    ids: Set<string>;
    bytes: number;
    sizeOf: Map<string, number>;
  }> => {
    // Always allocated over `all`, whatever the caller asked to see: a
    // budget that skipped the pins outside their validity window would
    // free their bytes, admit a later pin, and drop it again when a window
    // opened. The caller's own filter is applied afterwards.
    const batches = await Promise.all(ids.map((id) => store.pinned!(id, { include: 'allocated' })));
    const merged = new Map(batches.flat().map((entry) => [entry.id, entry]));
    const sizeOf = new Map([...merged].map(([id, entry]) => [id, memoryContentByteLength(entry.content)]));
    const budget = applyMemoryPinBudget([...merged.keys()], (id) => sizeOf.get(id));
    // What renders is each store's own answer to "current", intersected
    // with the merged budget — the wrapper cannot tell a superseded pin
    // from a live one by looking at the entry, and validity alone would
    // let a retired fact through.
    let visible = budget.effective;
    if (pinnedOptions?.include !== 'allocated') {
      const current = new Set(
        (await Promise.all(ids.map((id) => store.pinned!(id)))).flat().map((entry) => entry.id),
      );
      visible = budget.effective.filter((id) => current.has(id));
    }
    return {
      effective: visible.map((id) => merged.get(id)!),
      ids: new Set(budget.effective),
      bytes: budget.bytes,
      sizeOf,
    };
  };

  return {
    async append(agentId, content, options) {
      const ids = aliasIds(agentId);
      if (ids.length === 1 || options?.supersedes === undefined) {
        return store.append(agentId, content, options);
      }
      // A successor has to be filed where the fact it retires lives, or the
      // retirement does not apply: every store resolves `supersedes` inside
      // one agent's own entries. `recall` surfaces inherited entries under
      // their legacy id and the tool tells the model to supersede by
      // recalled id, so writing the revision under the current id alone
      // would make every inherited fact unrevisable.
      for (const id of ids) {
        if ((await store.list(id, { validity: 'all' })).entries.some((entry) => entry.id === options.supersedes)) {
          return store.append(id, content, options);
        }
      }
      // Nowhere to file it — let the store say so, in the words it already
      // has for an id that is not the caller's to supersede.
      return store.append(agentId, content, options);
    },
    async list(agentId, options) {
      const ids = aliasIds(agentId);
      if (ids.length === 1) {
        return store.list(agentId, options);
      }
      const batches = await Promise.all(ids.map((id) => store.list(id, options)));
      const merged = batches.flatMap((batch) => batch.entries);
      const anyTruncated = batches.some((batch) => batch.truncated);
      if (options?.limit === undefined) {
        return { entries: merged.sort(compareMemoryChronology), truncated: anyTruncated };
      }
      const bounded = boundMemoryList(merged, options.limit);
      return { entries: bounded.entries, truncated: bounded.truncated || anyTruncated };
    },
    async search(agentId, query, options) {
      const ids = aliasIds(agentId);
      if (ids.length === 1) {
        return store.search(agentId, query, options);
      }
      // Known imprecision, bounded and deliberate: each alias counts a
      // recall for its own winners, and the merge below then discards some
      // of them, so a multi-alias hit over-counts by at most
      // (aliases - 1) x limit. Usage is an observation that nothing ranks
      // or deletes on, and keeping it exact here would need the stores to
      // defer counting and the wrapper to record the merged winners —
      // two additions to the contract for a statistic on one legacy id.
      // A ranking strategy that ever reads these is what changes that.
      const batches = await Promise.all(ids.map((id) => store.search(id, query, options)));
      const bounded = boundMemoryRead(batches.flatMap((batch) => batch.entries), clampMemoryRecallLimit(options?.limit));
      // Every batch came from the same store, so they agree on the ordering
      // it served; reporting the first is reporting all of them.
      const strategy = batches[0]?.strategy;
      return {
        entries: bounded.entries,
        truncated: bounded.truncated || batches.some((batch) => batch.truncated),
        ...(strategy !== undefined ? { strategy } : {}),
      };
    },
    async forget(agentId, entryId) {
      for (const id of aliasIds(agentId)) {
        if (await store.forget(id, entryId)) {
          return true;
        }
      }
      return false;
    },
    async audit(agentId) {
      const ids = aliasIds(agentId);
      if (ids.length === 1) {
        return store.audit(agentId);
      }
      const batches = await Promise.all(ids.map((id) => store.audit(id)));
      return batches.flat().sort(compareMemoryChronology);
    },
    // Alias-aware like `forget`, for the same reason: a legacy entry under
    // a legacy id is exactly the one an operator pins or re-asserts.
    ...(store.pin
      ? {
          async pin(agentId: string, entryId: string) {
            const ids = aliasIds(agentId);
            if (ids.length === 1) {
              return store.pin!(agentId, entryId);
            }
            let lastFailure: unknown;
            for (const id of ids) {
              let outcome: MemoryPinOutcome;
              try {
                outcome = await store.pin!(id, entryId);
              } catch (error) {
                lastFailure = error;
                continue;
              }
              if (!outcome.pinned) {
                return outcome;
              }
              // The alias that took the pin saw only its own budget, so it
              // can accept one the merged replay then makes inert — and
              // reporting success for a pin that never reaches the prompt
              // is the eviction the cap promises never happens, wearing a
              // different hat. Retract it and refuse instead, naming the
              // merged total.
              const effective = await mergedPinBudget(ids);
              if (effective.ids.has(entryId)) {
                return { pinned: true, bytes: effective.bytes };
              }
              await store.unpin?.(id, entryId);
              const held = await mergedPinBudget(ids);
              return {
                pinned: false,
                reason: pinnedCapRefusal(held.bytes, effective.sizeOf.get(entryId) ?? 0),
                bytes: held.bytes,
              };
            }
            throw lastFailure;
          },
        }
      : {}),
    ...(store.unpin
      ? {
          async unpin(agentId: string, entryId: string) {
            for (const id of aliasIds(agentId)) {
              if (await store.unpin!(id, entryId)) {
                return true;
              }
            }
            return false;
          },
        }
      : {}),
    ...(store.pinned
      ? {
          async pinned(agentId: string, pinnedOptions?: MemoryPinnedOptions) {
            const ids = aliasIds(agentId);
            if (ids.length === 1) {
              return store.pinned!(agentId, pinnedOptions);
            }
            const budget = await mergedPinBudget(ids, pinnedOptions);
            return budget.effective.map((entry) => entry).sort(compareMemoryChronology);
          },
        }
      : {}),
    ...(store.topics
      ? {
          async topics(agentId: string) {
            const ids = aliasIds(agentId);
            if (ids.length === 1) {
              return store.topics!(agentId);
            }
            // Merged through the shared rule rather than concatenated: a
            // topic an agent wrote about under both ids is one topic with
            // one count, which is what two lists would not give.
            return mergeMemoryTopics(...await Promise.all(ids.map((id) => store.topics!(id))));
          },
        }
      : {}),
    // Import writes under the agent's own id, never a legacy alias: the
    // aliases exist to *read* what an older build wrote, and a new write
    // filed under one would be creating history nobody had.
    ...(store.importEntries
      ? { importEntries: (agentId: string, entries: readonly MemoryEntry[]) => store.importEntries!(agentId, entries) }
      : {}),
    ...(store.reassertTrust
      ? {
          async reassertTrust(agentId, entryId, trust) {
            for (const id of aliasIds(agentId)) {
              if (await store.reassertTrust!(id, entryId, trust)) {
                return true;
              }
            }
            return false;
          },
        }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// Creating a soul under an id nothing else holds
// ---------------------------------------------------------------------------

/**
 * The ids a newly created soul must not claim: every id the served roster
 * holds, which is three things and not one directory.
 *
 * - **What the roster files declare.** A filename is not an id: a soul at
 *   `renamed.md` may declare `id: ava`, so `ava.md` being free proves
 *   nothing — and since a duplicate refuses the whole roster, writing one
 *   would hand back an agent whose daemon cannot start.
 * - **The configured default soul**, which the daemon registers whether or
 *   not its file lives in the agents directory. It wins a same-id contest
 *   with a roster file — `defaultAgentId` replaces the source when the
 *   path differs — so a new agent sharing its id is not refused, it is
 *   shadowed: created, then undispatchable by id or from Slack, with
 *   nothing saying so.
 * - **The reserved `stratus`**, since a roster soul claiming it is skipped
 *   at load, so writing one creates an agent that silently never appears.
 *
 * The two readable sources fail **independently**, and what they return is
 * what they know rather than all-or-nothing. A configured soul that is
 * missing or mid-edit does not stop the daemon serving the roster, so it
 * must not discard the roster's claims either: collapsing both to unknown
 * would let a caller write the very duplicate that refuses the roster it
 * could have read. `unread` names what could not be answered, so the
 * caller can say which check did not run instead of implying none did.
 */
/**
 * A config that is not there at all, which is not a config that could not
 * be read — the distinction `ConfigFileError.code` exists for.
 *
 * Callers here pin the global config deliberately, and pinning is what
 * turns "no file" into a rejection: an unpinned resolve skips a candidate
 * that is not there, while a pinned one reports the file it was told to
 * use. On a machine where `stratus setup` has not run yet there is no
 * `~/.stratus/config.json`, and the id check has nothing it could miss —
 * so saying it was skipped named a hazard that does not exist, on the one
 * path every new install takes. A config that exists and will not read is
 * still reported: there the ids really are unchecked.
 */
const isAbsentConfig = (reason: unknown): boolean =>
  reason instanceof ConfigFileError && reason.code === 'ENOENT';

export const declaredAgentIds = async (
  env: StateEnvironment,
  configPath?: string,
): Promise<{ ids: Set<string>; unread: string[] }> => {
  const [roster, configured] = await Promise.allSettled([
    loadRosterSouls(env, () => {}),
    // The soul a run started here would resolve, by the same precedence the
    // daemon uses — never a second reading of it. Pinned when the caller has
    // a pinned config: a daemon on `--config custom.json` may name a default
    // soul the working directory's config does not, and an id claimed without
    // seeing it is claimed against the wrong set. The write then succeeds and
    // the roster reload hands that id to the configured soul instead, so the
    // agent just created is reported 201 and never served.
    resolveConfiguredSoul(configPath ? { configPath } : {}, env),
  ]);

  const ids = new Set([DEFAULT_STRATUS_AGENT.id]);
  const unread: string[] = [];
  if (roster.status === 'fulfilled') {
    for (const entry of roster.value) {
      ids.add(entry.soul.agent.id);
    }
  } else {
    unread.push('the roster');
  }
  if (configured.status === 'fulfilled') {
    if (configured.value) {
      ids.add(configured.value.soul.agent.id);
    }
  } else if (!isAbsentConfig(configured.reason)) {
    unread.push('the configured default soul');
  }
  return { ids, unread };
};

/**
 * Write a new soul under an id nothing else holds, and return the agent
 * that got written.
 *
 * The name stays theirs, but the id — the soul filename, the memory key,
 * the credential scope — must be unique: the suggestion pool is small, so
 * a repeat name would otherwise share an earlier agent's memory. Two
 * claims have to fail here, and only one of them is a filename:
 *
 * - An id another soul declares, whatever that soul is called on disk.
 *   Since a duplicate refuses the whole roster, writing one would leave a
 *   daemon that will not start — created by the command meant to help.
 * - The path itself, via `wx`, which makes the claim atomic against a
 *   concurrent writer that the roster read above cannot see.
 *
 * On either, the id takes a fresh suffix and we try again — through the
 * shared bound, since appending a suffix to a maxed-out base would build
 * an id the validator refuses, turning a collision into a crash.
 */
export const claimSoulFile = async (
  env: StateEnvironment,
  input: { name?: string; instructions: string },
  render: (agent: AgentDefinition) => string,
  note: (message: string) => void,
  configPath?: string,
): Promise<{ agent: AgentDefinition; soulPath: string }> => {
  const { ids: taken, unread } = await declaredAgentIds(env, configPath);
  if (unread.length > 0) {
    note(`Note: could not read ${unread.join(' or ')}, so this id was not checked against the ids it declares.`);
  }
  await mkdir(agentsDirPath(env), { recursive: true });
  let agent = defineAgent({ ...(input.name ? { name: input.name } : {}), instructions: input.instructions });
  const baseId = agent.id;
  for (;;) {
    const soulPath = path.join(agentsDirPath(env), `${agent.id}.md`);
    if (!taken.has(agent.id)) {
      try {
        await writeFile(soulPath, render(agent), { flag: 'wx' });
        return { agent, soulPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    agent = defineAgent({
      id: agentIdWithSuffix(baseId, randomUUID().slice(0, 4)),
      ...(input.name ? { name: input.name } : { name: agent.name }),
      instructions: input.instructions,
    });
  }
};

// ---------------------------------------------------------------------------
// The roster as data
// ---------------------------------------------------------------------------

/** The first non-empty line of a persona, trimmed to fit one terminal row. */
export const personaSnippet = (instructions: string | undefined): string | undefined => {
  const firstLine = instructions?.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > 78 ? `${firstLine.slice(0, 77)}…` : firstLine;
};

/** One agent as `stratus agents` and `GET /api/v1/agents` both describe it. */
export interface AgentSummary {
  id: string;
  name: string;
  /** The agent an agentId-less run or dispatch answers as. */
  default: boolean;
  /** The built-in Stratus persona, which has no soul file. */
  builtIn: boolean;
  soulPath?: string;
  /** The soul's own frontmatter pin, verbatim. Absent when it pins nothing. */
  provider?: string;
  model?: string;
  /** What a run as this agent resolves to right now. */
  runsOn: { provider: string; model?: string };
  memories: number;
  persona?: string;
  /**
   * The deterministic palette the kernel computed for this agent. Carried
   * structurally rather than as prose so every surface — a terminal line, a
   * web avatar, a macOS view — renders it its own way from one source.
   */
  avatar?: AvatarTheme;
}

/**
 * The whole roster, resolved: who the agents are, where their souls live,
 * what each would run on right now, and what each remembers.
 *
 * Reads the agents directory directly rather than through `loadRosterSouls`,
 * and the difference is deliberate: listing must survive a roster the daemon
 * would refuse. A duplicate id or an unparseable file degrades to a warning
 * and one missing row, because a person running this is usually running it
 * *because* something is wrong.
 */
export const listAgentSummaries = async (
  env: StateEnvironment,
  warn: (message: string) => void = () => {},
  /** The config the caller is pinned to; see `discoverActiveConfig`. */
  configPath?: string,
): Promise<AgentSummary[]> => {
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(env)));
  const processEnv = readProcessEnv(env);
  // Listing must never be blocked by a broken config — it only feeds the
  // default marker and the "runs on" lines.
  const { config: activeConfig, location: activeConfigLocation } = await discoverActiveConfig(env, warn, configPath);

  const pinContext: SoulPinContext = {
    ...(activeConfig.provider !== undefined ? { configProvider: activeConfig.provider } : {}),
    // Whether a file was actually found, not whether one was asked for: a
    // config with no provider key predates the anthropic option and names
    // openai as the default, while no config at all names nothing — and the
    // difference decides whether a soul's pin demotes anything.
    configPresent: activeConfigLocation !== undefined,
  };

  /**
   * What a run as this soul would actually use right now.
   *
   * The soul's pins are normalized through `applySoulPins` first — the same
   * call dispatch makes — rather than by ranking the environment above them
   * here. That ordering was wrong in exactly the case the pins exist for: a
   * daemon started with `STRATUS_PROVIDER=openai` serving a soul pinned to
   * anthropic dispatches anthropic, because the pin demotes the daemon-wide
   * default, while a listing that read the raw environment reported openai.
   * Two surfaces disagreeing about which provider is being billed.
   *
   * What is left afterwards still follows `resolveRuntimeConfig`'s precedence
   * — env, soul, config, demo — because a listing must answer even when no
   * credential resolves, which is precisely when someone is looking at it.
   */
  const runsOnFor = (soul?: ParsedSoul): { provider: string; model?: string } => {
    const normalized = soul
      ? applySoulPins(soul, {}, env, pinContext).env
      : env;
    const soulEnv = readProcessEnv(normalized);
    const envProvider = readNonEmptyString(soulEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'));
    const envModel = readNonEmptyString(soulEnv.STRATUS_MODEL);

    // Resolved form, so a soul's `ollama` equals the `plugin:ollama` the
    // config and environment were read into.
    const soulProvider = readNonEmptyString(soul?.provider, (value) => parseProviderName(value, 'soul file'));
    const soulModel = soul?.model;
    const provider = envProvider ?? soulProvider ?? activeConfig.provider ?? 'demo';
    if (provider === 'demo') {
      return { provider };
    }
    const soulModelApplies = soulProvider === undefined || soulProvider === provider;
    const configModelApplies = (activeConfig.provider ?? 'openai') === provider;
    const model = envModel
      ?? (soulModelApplies ? soulModel : undefined)
      ?? (configModelApplies ? activeConfig.model : undefined)
      // A contributed provider's default model is its own; nothing here
      // knows it, and reporting a built-in's default would be a guess.
      ?? (isRegisteredProviderName(provider)
        ? undefined
        : provider === 'openai'
          ? DEFAULT_OPENAI_MODEL
          : provider === 'codex'
            ? DEFAULT_CODEX_MODEL
            : DEFAULT_ANTHROPIC_MODEL);
    return model !== undefined ? { provider, model } : { provider };
  };

  // The config's soul under the same trust rule `resolveSoulPath` applies:
  // a project-local file's default is not the default a run would use.
  const defaultSoulPath = readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? (activeConfigLocation?.trusted === false ? undefined : activeConfig.soul);
  const resolvedDefaultSoul = defaultSoulPath
    ? path.resolve(readWorkingDirectory(env), defaultSoulPath)
    : undefined;

  const summaries: AgentSummary[] = [];

  const addSoul = async (soulPath: string): Promise<void> => {
    let parsed: ParsedSoul;
    try {
      parsed = parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath });
    } catch (error) {
      warn(`skipping ${soulPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const { agent } = parsed;
    const persona = personaSnippet(agent.instructions);
    summaries.push({
      id: agent.id,
      name: agent.name,
      default: soulPath === resolvedDefaultSoul,
      builtIn: false,
      soulPath,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      runsOn: runsOnFor(parsed),
      memories: (await memory.list(agent.id)).entries.length,
      ...(persona ? { persona } : {}),
      ...(agent.avatar ? { avatar: agent.avatar } : {}),
    });
  };

  let rosterFiles: string[] = [];
  try {
    rosterFiles = (await readdir(agentsDirPath(env)))
      .filter((file) => file.endsWith('.md'))
      .sort()
      .map((file) => path.join(agentsDirPath(env), file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  for (const soulPath of rosterFiles) {
    await addSoul(soulPath);
  }
  // A default soul can live outside ~/.stratus/agents (a project soul, a
  // hand-written file) — the roster would be lying without it.
  if (resolvedDefaultSoul && !rosterFiles.includes(resolvedDefaultSoul)) {
    await addSoul(resolvedDefaultSoul);
  }

  // The built-in Stratus persona serves every run that has no soul.
  const builtInPersona = personaSnippet(DEFAULT_STRATUS_AGENT.instructions);
  summaries.push({
    id: DEFAULT_STRATUS_AGENT.id,
    name: DEFAULT_STRATUS_AGENT.name,
    default: resolvedDefaultSoul === undefined,
    builtIn: true,
    runsOn: runsOnFor(),
    memories: (await memory.list(DEFAULT_STRATUS_AGENT.id)).entries.length,
    ...(builtInPersona ? { persona: builtInPersona } : {}),
  });

  summaries.sort((a, b) => {
    if (a.default !== b.default) {
      return a.default ? -1 : 1;
    }
    if (a.builtIn !== b.builtIn) {
      return a.builtIn ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  return summaries;
};
