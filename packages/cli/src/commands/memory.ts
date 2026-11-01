import { chmod, readFile, writeFile } from 'node:fs/promises';

import {
  BUILTIN_MEMORY_STORE_NAME,
  escapeControlCharacters,
  memoryEntryTrust,
  effectiveMemoryValidityAt,
  type MemoryAuditEntry,
  type MemoryEntry,
} from '@stratusagent/core';
import {
  agentMemoryFilePath,
  agentMemoryPassesFileIn,
  agentMemoryShadowFileIn,
  agentsDirPath,
  createHomeMemoryStore,
  createMemoryPassLedger,
  createMemoryShadowFile,
  memoryPassEntries,
  memoryPassSummaries,
  memoryShadowEntriesOf,
  migrateLegacyMemory,
  stratusHomePath,
  undoMemoryPass,
  type MemoryPassSummary,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import { memoryCommandWritesState, type ParsedMemoryCommand } from '../parse.ts';
import { loadServeRuntimeSelection } from '../trusted-config.ts';

/**
 * `stratus memory` — the operator's half of an agent's long-term memory.
 * The fleet console is meant to own the console view; this is the
 * terminal half.
 *
 * `list` shows what an agent's store holds with the label each entry
 * carries, because an operator cannot re-assert what they cannot see;
 * `search`, `forget`, and `audit` are the same reads and the same retirement
 * the agent's own tools perform. `pin` and `unpin` write records into the
 * append-only lane — the entry's own line is never touched, which is what
 * keeps `O_APPEND` and the hand-edit promise intact.
 *
 * `reassert` is the one way a label ever rises: it appends a re-assertion
 * record to the JSONL (never rewrites a line), so a running daemon — which
 * re-reads the file on every read — sees it at once. Operator only, on
 * purpose: no tool exposes this, because an agent re-labelling its own
 * memory as trusted is the attack writing its own permission slip.
 *
 * `--all-unknown` exists for the upgrade: every entry written before labels
 * existed reads `unknown`, and the injected slice of such a store makes
 * every session `unknown` on its first turn. Re-asserting the entries the
 * agent actually surfaces, once, is the bounded work that drains it.
 *
 * `export` and `import` move a corpus between machines, and are what an
 * evaluation harness loads a corpus with. **An imported entry lands
 * `external`** unless the operator passes `--preserve-trust`: import is the
 * laundering problem with a human in the middle, so the safe default
 * re-labels and the flag is a person vouching for the file.
 *
 * `passes`, `list --pass` and `undo-pass` are the audit half of memory
 * passes (spec 962): the ledger, what one pass wrote, and taking a pass
 * back. Undo is a forget per entry, so it is append-only like any other.
 */
/** How many passes `stratus memory passes` shows without --limit, newest first. */
const DEFAULT_PASSES_LISTED = 20;

export const runMemory = async (
  command: ParsedMemoryCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // Every subcommand here reads and writes the built-in file store
  // directly, with no plugin host and no daemon in the way — which is
  // right, and only right while the fleet's memories actually live there.
  // A config selecting a contributed store puts them somewhere else
  // entirely, and answering from the JSONL anyway would report a store the
  // agent does not use and write pins and tombstones nothing reads.
  const configured = await loadServeRuntimeSelection('memoryStore', env, undefined, (line) =>
    writeLine(streams.stderr, `Warning: ${line}`));
  if (configured !== undefined && configured !== BUILTIN_MEMORY_STORE_NAME) {
    writeLine(
      streams.stderr,
      `Error: this fleet's config selects memoryStore ${configured}, so its agents do not keep their memories under ${agentsDirPath(env)}. `
      + `\`stratus memory\` reads and writes the built-in ${BUILTIN_MEMORY_STORE_NAME} store only — use that store's own tooling, or set memoryStore to ${BUILTIN_MEMORY_STORE_NAME}.`,
    );
    return 1;
  }
  // Only the writers fold a legacy per-directory store in: the read-only
  // commands are what a downgraded build is allowed to run against newer
  // state, and a migration is a write.
  if (memoryCommandWritesState(command.action)) {
    await migrateLegacyMemory(env);
  }
  const store = createHomeMemoryStore(env);
  const at = new Date();
  // Two ways an entry reads `unknown`, and only one is the upgrade case:
  // no label at all (written before labels existed, or added by hand), or a
  // recorded `unknown` — a session that heard from a sender nobody vouched
  // for, or ran a shell command. The bulk re-assertion is for the first;
  // the second may hold a stranger's text and is named by id, once read.
  const unlabelled = (entry: MemoryEntry): boolean => entry.trust === undefined;
  const describeEntry = (entry: MemoryAuditEntry): Record<string, unknown> => ({
    id: entry.id,
    trust: memoryEntryTrust(entry),
    content: entry.content,
    createdAt: entry.createdAt,
    validity: effectiveMemoryValidityAt(entry, at),
    ...(entry.kind ? { kind: entry.kind } : {}),
    ...(entry.about ? { about: entry.about } : {}),
    ...(entry.validFrom ? { validFrom: entry.validFrom } : {}),
    ...(entry.validUntil ? { validUntil: entry.validUntil } : {}),
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    ...(entry.forgottenAt ? { forgottenAt: entry.forgottenAt } : {}),
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.origin ? { origin: entry.origin } : {}),
  });

  /**
   * One entry, two lines: the id with its label and status, then the
   * content indented. Control characters are spelled out, so a fact holding
   * a newline cannot forge the line above it or repaint the terminal an
   * operator is deciding from.
   */
  const printEntry = (entry: MemoryAuditEntry, pinnedIds: ReadonlySet<string>): void => {
    const validity = effectiveMemoryValidityAt(entry, at);
    const marks = [
      `[${memoryEntryTrust(entry)}]`,
      ...(pinnedIds.has(entry.id) ? ['[pinned]'] : []),
      ...(validity !== 'current' ? [`[${validity}]`] : []),
      // Escaped like the content below it: these come off the record, and a
      // hand-edited line's timestamp or `supersedes` can carry a newline
      // just as a fact can — which would forge the header of the entry
      // after it on the screen the operator is deciding from.
      ...(entry.forgottenAt !== undefined ? [`[forgotten ${escapeControlCharacters(entry.forgottenAt)}]`] : []),
      ...(entry.origin?.taintedBy ? [`(tainted by ${escapeControlCharacters(entry.origin.taintedBy)})`] : []),
      ...(unlabelled(entry) ? ['(no recorded origin)'] : []),
      ...(entry.supersedes ? [`(replaces ${escapeControlCharacters(entry.supersedes)})`] : []),
    ];
    // The id is escaped like everything else off the record. `import`
    // validates only that it is a string, so an untrusted corpus can carry
    // a newline or an escape sequence in one — and this line is the frame
    // every other line hangs off, so a forged one forges an entry.
    writeLine(streams.stdout, `${escapeControlCharacters(entry.id)}  ${marks.join('  ')}`);
    writeLine(streams.stdout, `  ${escapeControlCharacters(entry.content)}`);
    if (entry.about && entry.about.length > 0) {
      writeLine(streams.stdout, `  about: ${entry.about.map(escapeControlCharacters).join(', ')}`);
    }
  };

  /**
   * One pass, two lines: its id, kind, mode, status, counts and time, then
   * what it read. Escaped like an entry: a hand-edited ledger line can
   * carry a newline in any string.
   */
  const printPass = (summary: MemoryPassSummary): void => {
    const status = summary.reason !== undefined ? `${summary.status} (${summary.reason})` : summary.status;
    writeLine(
      streams.stdout,
      escapeControlCharacters(
        `${summary.passId}  ${summary.kind} ${summary.mode}  ${status}  saved ${summary.saved}, superseded ${summary.superseded}  ${summary.claimedAt}`,
      ),
    );
    if (summary.sessionId !== undefined && summary.slice !== undefined) {
      const { slice } = summary;
      const read = `${slice.count} message${slice.count === 1 ? '' : 's'}, ${slice.count === 1 ? slice.from : `${slice.from} to ${slice.to}`}`;
      const cut = slice.cut !== undefined ? `; ${slice.cut.messageId} was cut to fit, ${slice.cut.bytesOmitted} bytes left out` : '';
      writeLine(streams.stdout, `  ${escapeControlCharacters(`session ${summary.sessionId}: ${read}${cut}`)}`);
    } else if (summary.group !== undefined) {
      writeLine(streams.stdout, `  ${escapeControlCharacters(`group ${summary.group.key}`)}`);
    }
  };

  // `allocated`, not the default: a pin that is superseded or outside its
  // validity window still holds its place in the 2 KiB budget and is
  // exactly what makes a later pin refuse — an operator who cannot see it
  // cannot unpin it, and the refusal would look like arithmetic that does
  // not add up.
  const pinnedIds = async (): Promise<Set<string>> =>
    new Set((store.pinned ? await store.pinned(command.agentId, { include: 'allocated' }) : []).map((entry) => entry.id));

  // The pass ledger and shadow file sit beside the agent's other state,
  // where the daemon writes them. A ledger is ids, times and counts only.
  const stateDir = stratusHomePath(env);
  const passesFile = (): string => agentMemoryPassesFileIn(stateDir, command.agentId);
  const readPasses = async (): Promise<MemoryPassSummary[]> =>
    memoryPassSummaries(await createMemoryPassLedger(passesFile(), { stateHome: stateDir }).read());
  const findPass = async (passId: string): Promise<MemoryPassSummary | undefined> =>
    (await readPasses()).find((summary) => summary.passId === passId);
  const noSuchPass = (passId: string): number => {
    writeLine(
      streams.stderr,
      `Error: ${command.agentId}'s ledger has no pass ${passId}. stratus memory passes ${command.agentId} lists them.`,
    );
    return 1;
  };

  if (command.action === 'passes') {
    const all = await readPasses();
    const shown = all.slice(0, command.limit ?? DEFAULT_PASSES_LISTED);
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, total: all.length, passes: shown }, null, 2));
      return 0;
    }
    if (all.length === 0) {
      writeLine(streams.stdout, `${command.agentId} has no memory passes in ${passesFile()}.`);
      return 0;
    }
    for (const summary of shown) {
      printPass(summary);
    }
    if (shown.length < all.length) {
      writeLine(streams.stdout, '');
      writeLine(streams.stdout, `${all.length - shown.length} older pass${all.length - shown.length === 1 ? '' : 'es'} not shown. Raise --limit to see more.`);
    }
    return 0;
  }

  if (command.action === 'undo-pass') {
    const passId = command.pass!;
    const found = await findPass(passId);
    if (found?.mode === 'shadow') {
      writeLine(streams.stdout, `Pass ${escapeControlCharacters(passId)} ran in shadow mode, so it wrote nothing to memory. Nothing to undo.`);
      return 0;
    }
    const written = await memoryPassEntries(store, command.agentId, passId);
    if (found === undefined && written.length === 0) {
      return noSuchPass(escapeControlCharacters(passId));
    }
    if (found?.status === 'open') {
      writeLine(
        streams.stderr,
        `Warning: pass ${escapeControlCharacters(passId)} has not ended, so it may still write. Run undo-pass again once stratus memory passes shows it ended.`,
      );
    }
    const { forgotten } = await undoMemoryPass(store, command.agentId, passId);
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, passId, forgotten }, null, 2));
      return 0;
    }
    if (forgotten.length === 0) {
      writeLine(streams.stdout, `Pass ${escapeControlCharacters(passId)} has no live entries left for ${command.agentId}; nothing was forgotten.`);
      return 0;
    }
    writeLine(
      streams.stdout,
      `Forgot ${forgotten.length} entr${forgotten.length === 1 ? 'y' : 'ies'} pass ${escapeControlCharacters(passId)} wrote for ${command.agentId}. `
      + 'What they replaced is live again. They stay in the record; stratus memory audit still shows them.',
    );
    return 0;
  }

  if (command.action === 'list' && command.pass !== undefined) {
    const passId = command.pass;
    const found = await findPass(passId);
    const shadow = found?.mode === 'shadow';
    // Write mode: from the store, forgotten ones included, so an undone
    // pass still shows what it wrote. Shadow: what it would have written.
    const written: MemoryAuditEntry[] = shadow
      ? memoryShadowEntriesOf(await createMemoryShadowFile(agentMemoryShadowFileIn(stateDir, command.agentId), { stateHome: stateDir }).read(), passId)
      : await memoryPassEntries(store, command.agentId, passId);
    if (found === undefined && written.length === 0) {
      return noSuchPass(escapeControlCharacters(passId));
    }
    const entries = written.filter((entry) => command.trust === undefined || memoryEntryTrust(entry) === command.trust);
    const pinned = shadow ? new Set<string>() : await pinnedIds();
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        agentId: command.agentId,
        passId,
        ...(found !== undefined ? { pass: found } : {}),
        entries: entries.map((entry) => ({ ...describeEntry(entry), pinned: pinned.has(entry.id) })),
      }, null, 2));
      return 0;
    }
    if (shadow) {
      writeLine(streams.stdout, `Pass ${escapeControlCharacters(passId)} ran in shadow mode. These are what it would have saved; none is in memory.`);
    }
    if (entries.length === 0) {
      writeLine(streams.stdout, `Pass ${escapeControlCharacters(passId)} wrote nothing${command.trust === undefined ? '' : ` at ${command.trust}`}.`);
      return 0;
    }
    for (const entry of entries) {
      printEntry(entry, pinned);
    }
    return 0;
  }

  if (command.action === 'list') {
    // `all`, not the default: an operator has to be able to see an expired
    // fact *as* expired. The prompt is where "true now" is enforced.
    const live = (await store.list(command.agentId, { validity: 'all' })).entries
      .filter((entry) => command.trust === undefined || memoryEntryTrust(entry) === command.trust);
    const pinned = await pinnedIds();
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        agentId: command.agentId,
        entries: live.map((entry) => ({ ...describeEntry(entry), pinned: pinned.has(entry.id) })),
      }, null, 2));
      return 0;
    }
    if (live.length === 0) {
      writeLine(
        streams.stdout,
        command.trust === undefined
          ? `${command.agentId} has no live memory entries in ${agentMemoryFilePath(env, command.agentId)}.`
          : `${command.agentId} has no live memory entries at ${command.trust}.`,
      );
      return 0;
    }
    for (const entry of live) {
      printEntry(entry, pinned);
    }
    if (command.trust === undefined) {
      const unlabelledCount = live.filter(unlabelled).length;
      const recordedUnknown = live.filter((entry) => !unlabelled(entry) && memoryEntryTrust(entry) === 'unknown').length;
      if (unlabelledCount > 0) {
        writeLine(streams.stdout, '');
        writeLine(
          streams.stdout,
          `${unlabelledCount} entr${unlabelledCount === 1 ? 'y has' : 'ies have'} no recorded origin, so any session that reads one writes unknown. `
          + `Review them, then: stratus memory reassert ${command.agentId} --trust user --all-unknown (or name ids).`,
        );
      }
      if (recordedUnknown > 0) {
        writeLine(streams.stdout, '');
        writeLine(
          streams.stdout,
          `${recordedUnknown} entr${recordedUnknown === 1 ? 'y was' : 'ies were'} recorded unknown — written after a message from someone not configured as a principal, or after a shell command — `
          + 'and may repeat what a stranger said. --all-unknown leaves these alone; re-assert one by id once you have read it.',
        );
      }
    }
    return 0;
  }

  if (command.action === 'search') {
    // Asked the way `memory.recall` asks, so the operator sees what the
    // agent would get for the same words.
    const found = await store.search(command.agentId, command.query ?? '', {
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
      strategy: 'hybrid',
    });
    const pinned = await pinnedIds();
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        agentId: command.agentId,
        query: command.query,
        strategy: found.strategy,
        truncated: found.truncated,
        entries: found.entries.map((entry) => ({ ...describeEntry(entry), pinned: pinned.has(entry.id) })),
      }, null, 2));
      return 0;
    }
    if (found.entries.length === 0) {
      writeLine(
        streams.stdout,
        found.strategy === 'recency'
          ? `Nothing of ${command.agentId}'s matches ${command.query}. Every word has to appear in a fact, or in what the fact is about.`
          : `Nothing of ${command.agentId}'s matches ${command.query}.`,
      );
      return 0;
    }
    for (const entry of found.entries) {
      printEntry(entry, pinned);
    }
    if (found.truncated) {
      writeLine(streams.stdout, '');
      writeLine(
        streams.stdout,
        found.strategy === 'recency'
          ? 'More matched than this read returns. Narrow the words, or raise --limit.'
          : 'More matched than this read returns, and the best matches came first. Raise --limit to see more.',
      );
    }
    return 0;
  }

  if (command.action === 'audit') {
    // The audit read is the only one that shows a tombstoned entry, and
    // with supersession it is where "which entry replaced which" is
    // answered — the successor names its predecessor on its own line.
    const entries = await store.audit(command.agentId);
    const pinned = await pinnedIds();
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        agentId: command.agentId,
        entries: entries.map((entry) => ({ ...describeEntry(entry), pinned: pinned.has(entry.id) })),
      }, null, 2));
      return 0;
    }
    if (entries.length === 0) {
      writeLine(streams.stdout, `${command.agentId} has never written to ${agentMemoryFilePath(env, command.agentId)}.`);
      return 0;
    }
    const replacedBy = new Map<string, string[]>();
    for (const entry of entries) {
      if (entry.supersedes !== undefined) {
        replacedBy.set(entry.supersedes, [...(replacedBy.get(entry.supersedes) ?? []), entry.id]);
      }
    }
    for (const entry of entries) {
      printEntry(entry, pinned);
      const successors = replacedBy.get(entry.id);
      if (successors !== undefined) {
        writeLine(streams.stdout, `  replaced by: ${successors.map(escapeControlCharacters).join(', ')}`);
      }
    }
    return 0;
  }

  if (command.action === 'export') {
    // Everything the agent still holds, oldest first — superseded entries
    // included, because the successor carries its own retirement and the
    // revision travels with it. A forgotten entry cannot: its tombstone is
    // a record, and a file of entries has nowhere to put one, so exporting
    // it would resurrect a fact the agent dropped. Provenance rides along;
    // whether it survives the import is the importing side's decision, and
    // its default is no.
    const entries = (await store.audit(command.agentId))
      .filter((entry) => entry.forgottenAt === undefined)
      .map(({ forgottenAt: _forgotten, ...entry }) => entry);
    // Refused rather than deduplicated, because there is no honest way to
    // choose here. `audit` is the one read that deliberately returns both
    // copies of an id the default agent holds under a legacy alias as well
    // — saying what the record holds is its whole job — and it returns them
    // in chronological order, so which alias *owns* the id is not in this
    // list to recover. Import then keeps the first copy of an id and skips
    // the rest, and the legacy copy is usually the older one, so writing
    // both would migrate the copy every read hides and drop the canonical
    // one: an export/import that silently replaces a fact with the version
    // it was shadowing. A refusal naming the ids is recoverable; a swapped
    // corpus is discovered months later, if ever.
    const seen = new Set<string>();
    const collisions = [...new Set(entries.filter((entry) => seen.size === seen.add(entry.id).size).map((entry) => entry.id))];
    if (collisions.length > 0) {
      writeLine(
        streams.stderr,
        `Error: ${command.agentId} holds ${collisions.length} entr${collisions.length === 1 ? 'y id' : 'y ids'} twice `
        + `— ${collisions.slice(0, 5).join(', ')}${collisions.length > 5 ? ', …' : ''} — once under its own id and once under a legacy `
        + 'alias it inherits. Export cannot tell which copy should travel, and importing the file would keep whichever came '
        + `first. Nothing was written: run \`stratus memory audit ${command.agentId}\` to see both, forget the copy you do not want, and export again.`,
      );
      return 1;
    }
    const jsonl = entries.map((entry) => JSON.stringify(entry)).join('\n');
    if (command.file !== undefined) {
      // Owner-only, like everything else holding conversation content —
      // and tightened with an explicit `chmod`, because `writeFile`'s mode
      // applies only when it *creates* the file. Exporting over a
      // world-readable path left behind by something else would otherwise
      // publish the corpus under the old permissions. The chmod runs
      // first, so the content never exists at the looser mode.
      await writeFile(command.file, '', { mode: 0o600 });
      await chmod(command.file, 0o600);
      await writeFile(command.file, entries.length > 0 ? `${jsonl}\n` : '', { mode: 0o600 });
      writeLine(streams.stdout, `Wrote ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} of ${command.agentId} to ${command.file}.`);
      return 0;
    }
    if (entries.length > 0) {
      writeLine(streams.stdout, jsonl);
    }
    return 0;
  }

  if (command.action === 'import') {
    if (!store.importEntries) {
      writeLine(streams.stderr, 'Error: this memory store cannot import entries.');
      return 1;
    }
    let raw: string;
    try {
      raw = await readFile(command.file!, 'utf8');
    } catch (error) {
      writeLine(streams.stderr, `Error: cannot read ${command.file}: ${(error as Error).message}`);
      return 1;
    }
    const entries: MemoryEntry[] = [];
    let lineNumber = 0;
    for (const line of raw.split('\n')) {
      lineNumber += 1;
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeLine(streams.stderr, `Error: ${command.file} line ${lineNumber} is not JSON. Nothing was imported.`);
        return 1;
      }
      const candidate = parsed as MemoryEntry;
      if (typeof candidate?.id !== 'string' || typeof candidate?.content !== 'string'
        || typeof candidate?.createdAt !== 'string') {
        writeLine(streams.stderr, `Error: ${command.file} line ${lineNumber} is not a memory entry — it needs id, content, and createdAt. Nothing was imported.`);
        return 1;
      }
      entries.push(
        // The safety rule: an imported entry lands `external` unless a
        // person says otherwise, because a file from elsewhere may repeat
        // what a stranger wrote and nothing here can tell.
        command.preserveTrust ? candidate : { ...candidate, trust: 'external' },
      );
    }
    const result = await store.importEntries(command.agentId, entries);
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, ...result, preservedTrust: command.preserveTrust }, null, 2));
      return 0;
    }
    writeLine(
      streams.stdout,
      `Imported ${result.imported} entr${result.imported === 1 ? 'y' : 'ies'} into ${command.agentId}`
      + `${command.preserveTrust ? ', keeping each recorded trust label' : ' as external — pass --preserve-trust if you vouch for this file'}.`,
    );
    if (result.skipped.length > 0) {
      writeLine(streams.stdout, `${result.skipped.length} already had that id and were left alone.`);
    }
    return 0;
  }

  if (command.action === 'forget') {
    let dropped = 0;
    const missing: string[] = [];
    for (const id of command.ids) {
      if (await store.forget(command.agentId, id)) {
        dropped += 1;
      } else {
        missing.push(id);
      }
    }
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, forgotten: dropped, missing }, null, 2));
    } else {
      writeLine(streams.stdout, `Retired ${dropped} entr${dropped === 1 ? 'y' : 'ies'} of ${command.agentId}. They stay in the record; stratus memory audit still shows them.`);
    }
    for (const id of missing) {
      writeLine(streams.stderr, `No live memory entry with id ${id} belongs to ${command.agentId}; nothing was forgotten for it.`);
    }
    return missing.length === 0 ? 0 : 1;
  }

  if (command.action === 'pin' || command.action === 'unpin') {
    if (!store.pin || !store.unpin) {
      writeLine(streams.stderr, 'Error: this memory store does not support pinning.');
      return 1;
    }
    let changed = 0;
    const failures: string[] = [];
    for (const id of command.ids) {
      if (command.action === 'unpin') {
        if (await store.unpin(command.agentId, id)) {
          changed += 1;
        } else {
          failures.push(`No pin of ${command.agentId}'s names id ${id}; nothing was unpinned.`);
        }
        continue;
      }
      let outcome;
      try {
        outcome = await store.pin(command.agentId, id);
      } catch (error) {
        failures.push((error as Error).message);
        continue;
      }
      if (outcome.pinned) {
        changed += 1;
      } else {
        // The cap refuses rather than evicting, and says so naming the cap:
        // an operator who cannot see why a pin bounced will assume it worked.
        failures.push(outcome.reason ?? `Could not pin ${id}.`);
      }
    }
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, action: command.action, changed, failures }, null, 2));
    } else {
      writeLine(
        streams.stdout,
        `${command.action === 'pin' ? 'Pinned' : 'Unpinned'} ${changed} entr${changed === 1 ? 'y' : 'ies'} of ${command.agentId}. A running daemon reads the change on its next turn.`,
      );
    }
    for (const failure of failures) {
      writeLine(streams.stderr, failure);
    }
    return failures.length === 0 ? 0 : 1;
  }

  if (!store.reassertTrust) {
    writeLine(streams.stderr, 'Error: this memory store cannot re-assert trust.');
    return 1;
  }
  const trust = command.trust ?? 'user';
  const live = (await store.list(command.agentId, { validity: 'all' })).entries;
  const targets = command.allUnknown
    ? [...new Set([...live.filter(unlabelled).map((entry) => entry.id), ...command.ids])]
    : command.ids;
  if (targets.length === 0) {
    writeLine(streams.stdout, `${command.agentId} has no live entries with no recorded origin; nothing to re-assert. An entry recorded unknown is named by id.`);
    return 0;
  }
  const missing: string[] = [];
  let changed = 0;
  for (const id of targets) {
    if (await store.reassertTrust(command.agentId, id, trust)) {
      changed += 1;
    } else {
      missing.push(id);
    }
  }
  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, trust, reasserted: changed, missing }, null, 2));
  } else {
    writeLine(streams.stdout, `Re-asserted ${changed} entr${changed === 1 ? 'y' : 'ies'} of ${command.agentId} as ${trust}. A running daemon reads the change on its next turn.`);
  }
  for (const id of missing) {
    writeLine(streams.stderr, `No live memory entry with id ${id} belongs to ${command.agentId}; nothing was re-asserted for it.`);
  }
  return missing.length === 0 ? 0 : 1;
};
