import { effectiveMemoryValidityAt, memoryEntryTrust } from '@stratusagent/core';

import { API_PREFIX, ApiError, readJsonObject, requireString } from '../http.ts';
import type { Route } from '../routes.ts';
import { validGrantsAgentId } from './grants.ts';

/**
 * An agent's memory, for the operator: what it remembers and the way to
 * make it forget, which `stratus memory list` and `forget` already are at
 * the machine. The id is validated and not looked up, like grants and the
 * pass ledger: the memory of an agent no longer on the roster is still the
 * operator's to read and clear.
 */
export const memoryRoutes: Route[] = [
  // ---- memory --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents/:id/memory`,
    async handler(context) {
      const agentId = validGrantsAgentId(context.params.id);
      const { entries, pinned } = await context.gateway.memoryEntries(agentId);
      const held = new Set(pinned);
      const now = new Date();
      return {
        agentId,
        // Each as the store holds it, plus the three readings an operator
        // decides by, from the rules the prompt itself uses: whose words it
        // may be, whether it is true now, and whether it is pinned.
        entries: entries.map((entry) => ({
          ...entry,
          trust: memoryEntryTrust(entry),
          validity: effectiveMemoryValidityAt(entry, now),
          pinned: held.has(entry.id),
        })),
      };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/agents/:id/memory/forget`,
    async handler(context) {
      const agentId = validGrantsAgentId(context.params.id);
      // In the body, not the path: an entry id is the store's to choose, and
      // one that is `.` or `..` would be collapsed out of a URL by every
      // client's path normalization before it reached a route.
      const entryId = requireString(await readJsonObject(context.request), 'entryId');
      if (!await context.gateway.forgetMemory(agentId, entryId)) {
        throw new ApiError(
          404,
          'memory_entry_not_found',
          `${agentId} has no live memory entry with id ${entryId}. GET /agents/${agentId}/memory lists the ones it has.`,
        );
      }
      // A tombstone, not an erasure: the record keeps the entry and
      // `stratus memory audit` still shows it.
      return { agentId, entryId, forgotten: true };
    },
  },
];
