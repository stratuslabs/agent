import { API_PREFIX, ApiError } from '../http.ts';
import type { Route } from '../routes.ts';
import { validGrantsAgentId } from './grants.ts';

export const memoryPassRoutes: Route[] = [
  // ---- memory passes (spec 962) -----------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents/:id/memory/passes`,
    async handler(context) {
      // Any valid id, like grants: the ledger of an agent whose soul is gone
      // is still what an operator audits. No content: ids, times, counts.
      const agentId = validGrantsAgentId(context.params.id);
      return { agentId, passes: await context.gateway.memoryPasses(agentId) };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents/:id/memory/passes/:passId`,
    async handler(context) {
      const agentId = validGrantsAgentId(context.params.id);
      const passId = context.params.passId ?? '';
      const found = await context.gateway.memoryPass(agentId, passId);
      if (found === undefined) {
        throw new ApiError(
          404,
          'memory_pass_not_found',
          `${agentId}'s ledger has no pass ${passId}. GET /agents/${agentId}/memory/passes lists them.`,
        );
      }
      return { agentId, ...found };
    },
  },
];
