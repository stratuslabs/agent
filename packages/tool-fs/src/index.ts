import path from 'node:path';

import type { JsonObject, Plugin } from '@stratusagent/core';
import {
  createFileLedger,
  createProcessLocalLedger,
  LEDGER_FILENAME,
  ledgerGuard,
  protectedPathGuard,
  workspaceResolver,
  workspacePreparer,
  allAgentWorkspaces,
  type LedgerGuard,
  type ProtectedPathGuard,
} from '@stratusagent/plugins';

import { createKeyedSerializer } from './shared.ts';
import { createReadTool } from './read.ts';
import { createListTool } from './list.ts';
import { createSearchTool } from './search.ts';
import { createWriteTool } from './write.ts';
import { createMoveTool, type LedgerView, spellingsOf } from './move.ts';

export {
  canonicalRoots,
  expandHome,
  openContained,
  PathOutsideRootError,
  resolveWithinRoots,
} from './paths.ts';
// The ledger moved to the plugin host the moment it got a second writer
// (`plugin-mcp`); re-exported from its old home so no importer breaks.
export {
  createFileLedger,
  createProcessLocalLedger,
  LEDGER_FILENAME,
  ledgerGuard,
  nameIdentifiesHandle,
  type FileIdentity,
  type LedgerGuard,
  type TaintedWriteLedger,
} from '@stratusagent/plugins';

export interface FsPluginConfig extends JsonObject {
  /** Directories this agent may reach. Nothing outside them is readable. */
  roots?: string[];
  /** Cap on a single read, before truncation. */
  maxBytes?: number;
  /** Cap on `fs.search` matches. */
  maxMatches?: number;
  /** Cap on `fs.list` entries. */
  maxEntries?: number;
}

/**
 * The filesystem toolset.
 *
 * Reads are `safe` and writes are `gated`, which is the risk model applied
 * rather than a compromise: reading inside a directory a human chose is
 * work an agent does on its own, and writing where other people read is the
 * thing worth a person's attention. The roots are what make the first half
 * true, so they are an access boundary and not a preference — resolved from
 * `session.agent.id` on every call.
 */
export const createFsPlugin = (config: JsonObject = {}): Plugin => {
  // The ledger's home used to be a root this plugin appended the agent id
  // to. It is now whatever the host says the agent's workspace is, because
  // the layout is the host's: see `workspaceResolver`. `ledgerRoot` and
  // `workspaceRoot` remain the fallback for a host that wires this plugin
  // by hand and supplies no `workspaces` seam — the loader sets `ledgerRoot`
  // and never lets a config block override it, so two writers cannot keep
  // two ledgers.
  const handWiredLedgerRoot = typeof config.ledgerRoot === 'string' && config.ledgerRoot.length > 0
    ? config.ledgerRoot
    : typeof config.workspaceRoot === 'string' && config.workspaceRoot.length > 0
      ? config.workspaceRoot
      : undefined;
  const serialized = createKeyedSerializer();
  return {
    name: '@stratusagent/tool-fs',
    setup(context) {
      // Built here rather than at construction, because the seam arrives
      // with the context. A host that supplies neither leaves the ledger
      // process-local, which the README says outright.
      // The ledger follows the host's seam and never this plugin's own
      // `workspaceRoot`, which is how one ledger is kept now that the
      // loader no longer holds `ledgerRoot` down: `plugin-mcp` writes the
      // same ledger, and an operator who relocates one plugin's workspace
      // must not thereby give it a second one — `fs.read` consults one, so
      // a file recorded in another reads back unlabelled. The config roots
      // are the fallback for a host that wires this plugin by hand.
      const ledgerRoot = context.workspaces === undefined ? handWiredLedgerRoot : undefined;
      // Two resolvers: naming the ledger for a read costs nothing, while
      // recording a write needs the directory made and owner-only. Every
      // `fs.read` takes a snapshot, so asking the preparing one on a read
      // would let a workspace that cannot be made stop reads under roots
      // that are perfectly readable.
      const workspaceFor = workspaceResolver(context.workspaces, ledgerRoot);
      const prepareFor = workspacePreparer(context.workspaces, ledgerRoot);
      const ledger = workspaceFor !== undefined && prepareFor !== undefined
        ? createFileLedger(workspaceFor, prepareFor)
        : createProcessLocalLedger();
      // Which paths are a ledger is decided per call, from the workspaces as
      // they stand — see `ledgerGuard` for the spellings a ledger can have
      // and why none is cached.
      const isLedger = async (): Promise<LedgerGuard> => ledgerGuard(
        await allAgentWorkspaces(context.workspaces, ledgerRoot),
        // The configured root's own contract — one directory per agent
        // directly under it — so an agent whose workspace does not exist
        // yet still has its ledger path reserved. See `ledgerGuard`.
        ledgerRoot !== undefined ? [ledgerRoot] : [],
      );
      // Asked per call, like the ledger guard: what the host protects is
      // re-read so a change under a running daemon holds from the next call.
      const isProtected = (): Promise<ProtectedPathGuard> => protectedPathGuard(context.protectedPaths);
      const ledgerView = async (): Promise<LedgerView> => {
        const workspaces = await allAgentWorkspaces(context.workspaces, ledgerRoot);
        const roots = ledgerRoot !== undefined ? [ledgerRoot] : [];
        return {
          guard: await ledgerGuard(workspaces, roots),
          holders: await spellingsOf([
            ...workspaces.map((workspace) => path.join(workspace, LEDGER_FILENAME)),
            ...roots,
          ]),
        };
      };
      const protectedHolders = async (): Promise<string[]> =>
        spellingsOf(context.protectedPaths === undefined ? [] : await context.protectedPaths.all());
      context.tools.register(createReadTool(config, ledger, isLedger, serialized, isProtected));
      context.tools.register(createListTool(config, ledger, isProtected));
      context.tools.register(createSearchTool(config, ledger, isLedger, isProtected));
      context.tools.register(createWriteTool(config, ledger, isLedger, serialized, isProtected));
      context.tools.register(createMoveTool(config, ledger, ledgerView, serialized, isProtected, protectedHolders));
    },
  };
};

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = createFsPlugin;
