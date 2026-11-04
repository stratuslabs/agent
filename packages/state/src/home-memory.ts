/*
 * The memory store every surface reads and writes: one file per agent
 * under `agents/<id>/`, with the built-in agent's legacy default ids
 * folded in so its older facts stay readable, findable and forgettable.
 * Moved out of `roster.ts`, which uses it only to count each agent's
 * memories in the roster listing.
 */
import {
  type AgentMemoryStore,
  applyMemoryPinBudget,
  boundMemoryList,
  boundMemoryRead,
  boundRankedMemoryRead,
  clampMemoryRecallLimit,
  collectMemoryTopics,
  compareMemoryChronology,
  MEMORY_RECALL_MAX_LIMIT,
  memoryContentByteLength,
  type MemoryEntry,
  type MemoryListOptions,
  type MemoryPinnedOptions,
  type MemoryPinOutcome,
  memoryQueryMatches,
  type MemoryReadResult,
  memorySupersededIds,
  pinnedCapRefusal,
  tokenizeMemoryText,
} from '@stratusagent/core';

import type { StateEnvironment } from './environment.ts';
import { createShardedFileMemoryStore } from './memory.ts';
import { agentMemoryFilePath, stratusHomePath } from './paths.ts';
import { DEFAULT_STRATUS_AGENT } from './souls.ts';

// Unsouled runs used to remember facts under a per-provider default agent.
// Stratus inherits all of them: reads for the built-in agent also return
// entries stored under the legacy ids, while new facts land under 'stratus'.
const LEGACY_DEFAULT_AGENT_IDS = ['demo-agent', 'anthropic-agent', 'openai-agent'];

/**
 * One entry per id across the merged aliases, the earlier alias winning —
 * the same first-wins rule a single store applies to a duplicated id in its
 * own record.
 *
 * Two aliases can legitimately hold one id: the import contract scopes an
 * id to its agent, and a hand-edited file can put the same one under
 * `stratus` and under `demo-agent`. Returning both would hand the model two
 * entries it cannot tell apart, and every mutator takes an id and resolves
 * it through the aliases in this same order — so only the first was ever
 * addressable, and showing the second was a promise the wrapper could not
 * keep. The audit read deliberately keeps both, because saying what the
 * record holds is the one job it has.
 */
const firstByAliasOrder = (entries: readonly MemoryEntry[]): MemoryEntry[] => {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
};

/**
 * For each alias after the first, the ids some *earlier* alias holds — so a
 * query-filtered read can drop a hit that an earlier alias owns even though
 * this query did not match it there.
 *
 * Lazy on purpose. It reads an alias's whole live set, which is the price of
 * asking "does this alias hold this id" against a contract that has no such
 * method, so it runs only for the aliases that returned something and only
 * when more than one alias is in play. An install with no inherited entries
 * never reaches the read at all.
 */
const earlierAliasOwners = async (
  ids: readonly string[],
  batches: readonly { entries: MemoryEntry[] }[],
  held: (agentId: string) => Promise<readonly MemoryEntry[]>,
): Promise<Array<Set<string>>> => {
  const owners: Array<Set<string>> = ids.map(() => new Set<string>());
  let earlier = new Set<string>();
  for (let index = 0; index < ids.length; index += 1) {
    owners[index] = earlier;
    // Only worth loading the next alias's ids if a later alias has hits to
    // judge against them.
    if (batches.slice(index + 1).every((batch) => batch.entries.length === 0)) {
      break;
    }
    earlier = new Set([...earlier, ...(await held(ids[index]!)).map((entry) => entry.id)]);
  }
  return owners;
};

/**
 * The merged candidate pool under id precedence: every alias's answer minus
 * the ids an *earlier* alias owns, re-reading any alias whose own bound hid
 * the entries that filter then discarded.
 *
 * The filter is what makes precedence a property of the id rather than of
 * the query. Without it a bounded read picks whichever copy happened to
 * come back — the legacy one when the current owner's copy sat outside its
 * alias's own window — while `forget`, `pin` and supersession all resolve
 * the same id to the current owner. The model would then revise a fact it
 * never read.
 *
 * The re-read is what keeps the filter from silently shortening the answer.
 * An alias whose bounded batch is entirely shadowed would otherwise
 * contribute nothing while its unshadowed entries sat one row past the
 * bound, and the merged read would report `truncated` over a page it had
 * emptied itself. It costs a second query only when ownership removed
 * something from a batch the bound had already capped; an install with no
 * inherited entries never reaches either half.
 *
 * `refill` is omitted by the callers whose reads carry no bound at all —
 * nothing was capped there, so there is nothing to re-read.
 *
 * `rankedFor` is the query's tokens when a store ordered the batches by
 * relevance: they are merged by `mergeRanked` instead of concatenated, so
 * the caller can bound the result without re-sorting it by date.
 */
const settleAliasPrecedence = async (
  ids: readonly string[],
  batches: readonly MemoryReadResult[],
  held: (agentId: string) => Promise<readonly MemoryEntry[]>,
  refill?: (agentId: string) => Promise<MemoryReadResult>,
  rankedFor?: readonly string[],
): Promise<{ entries: MemoryEntry[]; truncated: boolean }> => {
  const owners = await earlierAliasOwners(ids, batches, held);
  const settled = await Promise.all(batches.map(async (batch, index) =>
    refill !== undefined && index > 0 && batch.truncated
    && batch.entries.some((entry) => owners[index]!.has(entry.id))
      ? refill(ids[index]!)
      : batch));
  const kept = settled.map((batch, index) =>
    batch.entries.filter((entry) => index === 0 || !owners[index]!.has(entry.id)));
  return {
    entries: firstByAliasOrder(rankedFor !== undefined ? mergeRanked(kept, rankedFor) : kept.flat()),
    truncated: settled.some((batch) => batch.truncated),
  };
};

/**
 * Ranked batches from separate aliases, merged in two passes: the facts
 * holding every query word, then the rest, each pass taking turns by rank.
 * A ranked search promises the first group comes first, and one alias's
 * partial match must not push another alias's full one past the limit.
 * Whether a fact holds every word is the contract's own match rule
 * (`memoryQueryMatches`), so it is the same question in every alias. How
 * well a fact matches is not: on the per-agent layout each alias is its
 * own file with its own index, so their relevance scores would not compare
 * even if the store handed them out, which it does not. Within a group,
 * taking turns is the merge that claims nothing it cannot know, and it
 * keeps each alias's own order intact.
 */
const mergeRanked = (
  batches: readonly (readonly MemoryEntry[])[],
  queryTokens: readonly string[],
): MemoryEntry[] => {
  const holdsEveryWord = (entry: MemoryEntry): boolean => memoryQueryMatches(entry, queryTokens);
  return [
    ...interleaveByRank(batches.map((batch) => batch.filter(holdsEveryWord))),
    ...interleaveByRank(batches.map((batch) => batch.filter((entry) => !holdsEveryWord(entry)))),
  ];
};

/** Every batch's first entry, then every batch's second, and so on, in alias order. */
const interleaveByRank = (batches: readonly (readonly MemoryEntry[])[]): MemoryEntry[] => {
  const merged: MemoryEntry[] = [];
  const longest = Math.max(0, ...batches.map((batch) => batch.length));
  for (let rank = 0; rank < longest; rank += 1) {
    for (const batch of batches) {
      const entry = batch[rank];
      if (entry !== undefined) {
        merged.push(entry);
      }
    }
  }
  return merged;
};

/**
 * The caller's `list` without its bound, for a refill. Written out field by
 * field rather than spread with `limit: undefined`, which
 * `exactOptionalPropertyTypes` refuses — a field added to
 * `MemoryListOptions` has to be added here too.
 */
const unboundedList = (options?: MemoryListOptions): MemoryListOptions | undefined =>
  options?.validity !== undefined ? { validity: options.validity } : undefined;

// Every method is alias-aware, not just `list`: a `search` or `forget` that
// delegated on agentId alone would compile, satisfy the interface, and
// quietly make every inherited entry unfindable and unforgettable — visible
// in `list`, absent from `recall`. Merged batches sort with everything else
// by the shared ordering rule (a ranked search's take turns by rank,
// facts holding every word first), and bounds apply after the merge, never per alias, or a busy
// legacy id crowds out the others.
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
    // Under the same id precedence every other read applies, and it has to
    // be resolved from the full entry sets rather than from these batches:
    // a pin-only batch does not contain the current owner's copy at all
    // when the owner simply has not pinned it, so de-duplicating the
    // concatenation would admit the legacy copy and put content into the
    // pinned core that `list`, `search`, and every id-based mutation hide.
    // Pinned reads carry no bound, so there is nothing to refill.
    const settled = await settleAliasPrecedence(
      ids,
      batches.map((entries) => ({ entries, truncated: false })),
      async (id) => (await store.list(id, { validity: 'all' })).entries,
    );
    const merged = new Map(settled.entries.map((entry) => [entry.id, entry]));
    const sizeOf = new Map([...merged].map(([id, entry]) => [id, memoryContentByteLength(entry.content)]));
    const budget = applyMemoryPinBudget([...merged.keys()], (id) => sizeOf.get(id));
    // What renders is each store's own answer to "current", intersected
    // with the merged budget — the wrapper cannot tell a superseded pin
    // from a live one by looking at the entry, and validity alone would
    // let a retired fact through.
    let visible = budget.effective;
    if (pinnedOptions?.include !== 'allocated') {
      // Settled the same way the allocated batches were, and for a reason
      // the id-only set hid: "is this pin current" is a question about the
      // *entry*, and pooling ids across aliases lets the copy precedence
      // rejected answer it. An expired `stratus` copy beside a current
      // legacy one would be admitted here — `merged` having correctly
      // picked the expired one — and the pinned core would carry a fact
      // that is not true now, which is the whole point of the filter.
      const settledCurrent = await settleAliasPrecedence(
        ids,
        (await Promise.all(ids.map((id) => store.pinned!(id)))).map((entries) => ({ entries, truncated: false })),
        async (id) => (await store.list(id, { validity: 'all' })).entries,
      );
      const current = new Set(settledCurrent.entries.map((entry) => entry.id));
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
      const targets = memorySupersededIds(options ?? {});
      if (ids.length === 1 || targets.length === 0) {
        return store.append(agentId, content, options);
      }
      // A successor has to be filed where the fact it retires lives, or the
      // retirement does not apply: every store resolves `supersedes` inside
      // one agent's own entries. `recall` surfaces inherited entries under
      // their legacy id and the tool tells the model to supersede by
      // recalled id, so writing the revision under the current id alone
      // would make every inherited fact unrevisable.
      // A merge goes where every fact it names lives. One whose facts span
      // both ids has no such place, and the store below says so.
      for (const id of ids) {
        const held = new Set((await store.list(id, { validity: 'all' })).entries.map((entry) => entry.id));
        if (targets.every((target) => held.has(target))) {
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
      // Bounded per alias first, then settled: `firstByAliasOrder` alone
      // only picks the earliest alias among those that *returned* an id,
      // so a current entry outside its own alias's window would lose to a
      // legacy copy of the same id and the recency tail would inject
      // content no mutation resolves to.
      const settled = await settleAliasPrecedence(
        ids,
        await Promise.all(ids.map((id) => store.list(id, options))),
        async (id) => (await store.list(id, { validity: 'all' })).entries,
        // Refilled unbounded rather than by a raised limit: what shadows
        // this alias is whatever the earlier aliases hold, so "limit plus
        // that" is asking for the whole alias the long way round.
        (id) => store.list(id, unboundedList(options)),
      );
      if (options?.limit === undefined) {
        return { entries: settled.entries.sort(compareMemoryChronology), truncated: settled.truncated };
      }
      const bounded = boundMemoryList(settled.entries, options.limit);
      return { entries: bounded.entries, truncated: bounded.truncated || settled.truncated };
    },
    async search(agentId, query, options) {
      const ids = aliasIds(agentId);
      if (ids.length === 1) {
        return store.search(agentId, query, options);
      }
      // Known imprecision, bounded and deliberate: each alias counts a
      // recall for its own winners, and the merge below then discards some
      // of them, so a multi-alias hit over-counts by at most (aliases - 1)
      // times whatever each alias was asked for — the caller's limit, or
      // the ceiling when a refill raised it. Usage is an observation that
      // nothing ranks or deletes on, and keeping it exact here would need
      // the stores to defer counting and the wrapper to record the merged
      // winners: two additions to the contract for a statistic on one
      // legacy id. A ranking strategy that ever reads these changes that.
      const batches = await Promise.all(ids.map((id) => store.search(id, query, options)));
      // Every batch came from the same store, so they agree on the ordering
      // it served; reporting the first is reporting all of them.
      const strategy = batches[0]?.strategy;
      const ranked = strategy !== undefined && strategy !== 'recency';
      const rankedFor = ranked ? tokenizeMemoryText(query) : undefined;
      const settled = await settleAliasPrecedence(
        ids,
        batches,
        async (id) => (await store.list(id, { validity: 'all' })).entries,
        // A search has no unbounded form — every limit is clamped — so a
        // refill asks for the store's own ceiling. Past that the single
        // alias path cannot see either, and `truncated` says so.
        (id) => store.search(id, query, { ...options, limit: MEMORY_RECALL_MAX_LIMIT }),
        rankedFor,
      );
      const limit = clampMemoryRecallLimit(options?.limit);
      const bounded = ranked ? boundRankedMemoryRead(settled.entries, limit) : boundMemoryRead(settled.entries, limit);
      return {
        entries: bounded.entries,
        truncated: bounded.truncated || settled.truncated,
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
            // Every alias, not the first that answers: the merged view
            // shows one entry per id, so unpinning it has to mean the id is
            // no longer pinned anywhere — a pin left behind under a second
            // alias would go on holding budget with nothing admitting it.
            let unpinned = false;
            for (const id of aliasIds(agentId)) {
              unpinned = (await store.unpin!(id, entryId)) || unpinned;
            }
            return unpinned;
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
            const lists = await Promise.all(ids.map((id) => store.topics!(id)));
            // Safe only when the *current* alias is the only contributor:
            // every topic then comes from the alias precedence would pick
            // anyway, and a later alias with no topics has no unshadowed
            // entry to add one. The mirror image is not safe and was the
            // bug — a later alias as the sole contributor says nothing
            // about ownership, because the current alias can hold the same
            // id with no `about` on its copy, and the hidden copy's topic
            // and its trust would pass straight through to the prompt.
            if (lists.slice(1).every((list) => list.length === 0)) {
              return lists[0] ?? [];
            }
            // Otherwise rebuilt from the deduplicated entry view the other
            // reads serve, not merged from per-alias lists. Those lists are
            // already aggregated, so a colliding id is counted under both
            // with no way left to apply precedence: the copy `list` and
            // `search` hide would still reach the prompt with its own
            // `about` spelling, and an `external` hidden copy would lower
            // the topic's trust and taint every session through the
            // runner's topic-trust term.
            const settled = await settleAliasPrecedence(
              ids,
              await Promise.all(ids.map((id) => store.list(id))),
              async (id) => (await store.list(id, { validity: 'all' })).entries,
            );
            return collectMemoryTopics(settled.entries);
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

/**
 * The memory every surface in this repository reads and writes: one file
 * per agent under `agents/<id>/`, with the built-in agent's inherited
 * aliases folded in.
 *
 * One factory rather than the same two-line composition in the gateway, in
 * `stratus run`, in `stratus memory`, and in the roster listing — the
 * sharding and the alias merge are both rules, and four hand-rolled copies
 * are four chances for one surface to answer "what does this agent
 * remember" differently from the next.
 */
export const createHomeMemoryStore = (env: StateEnvironment): AgentMemoryStore =>
  withLegacyDefaultMemories(createShardedFileMemoryStore(
    (agentId) => agentMemoryFilePath(env, agentId),
    stratusHomePath(env),
  ));
