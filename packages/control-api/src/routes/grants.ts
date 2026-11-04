import { isValidAgentId } from '@stratusagent/agents';
import {
  describeAgentGrants,
  WhitelistUnreadableError,
  type AgentGrantStore,
} from '@stratusagent/permissions';

import { API_PREFIX, ApiError, optionalString, readJsonObject } from '../http.ts';
import type { Route, RouteContext } from '../routes.ts';

/**
 * An id that reaches a path join. Validated the way every other agent id
 * is, and *not* checked against the roster: a grant can outlive its agent,
 * and listing or revoking one for an id that no longer has a soul is the
 * operator's remedy for exactly that.
 */
export const validGrantsAgentId = (raw: string | undefined): string => {
  const agentId = raw ?? '';
  if (!isValidAgentId(agentId)) {
    throw new ApiError(400, 'invalid_agent_id', `${JSON.stringify(agentId)} is not a valid agent id.`);
  }
  return agentId;
};

const grantStoreOf = (context: RouteContext): AgentGrantStore => {
  if (!context.grants) {
    throw new ApiError(
      501,
      'grants_unavailable',
      'This daemon was started without a grant store, so there is nothing to list or revoke here.',
    );
  }
  return context.grants;
};

export const grantRoutes: Route[] = [
  // ---- grants --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents/:id/grants`,
    async handler(context) {
      const agentId = validGrantsAgentId(context.params.id);
      const store = grantStoreOf(context);
      const listing = describeAgentGrants(await store.grantsFor(agentId));
      // Whether each tool grant would apply to a call right now, judged the
      // way the policy judges it: the tool as currently contributed. A
      // listing that showed a grant the engine will not honour — the
      // plugin updated, the tool gone — would be the audit view lying in
      // the reassuring direction. Only a live daemon can say, which is why
      // `stratus grants` reading the files directly cannot show it.
      // Conversation grants follow the same contributor rule in the policy,
      // so they are judged the same way here.
      const contributors = new Map(context.gateway.tools().map((tool) => [tool.name, tool.package]));
      const staleness = (grant: { tool: string; package?: string }): string | undefined =>
        !contributors.has(grant.tool)
          ? 'no loaded tool has this name, so the grant applies to nothing until one does'
          : contributors.get(grant.tool) !== grant.package
            ? `the tool is now contributed by ${contributors.get(grant.tool) ?? 'the kernel'}, not ${grant.package ?? 'the kernel'}, so a call asks again`
            : undefined;
      const marked = <T extends { tool: string; package?: string }>(grant: T): T & { stale?: string } => {
        const stale = staleness(grant);
        return { ...grant, ...(stale !== undefined ? { stale } : {}) };
      };
      return {
        agentId,
        configCommands: context.configCommands?.(agentId) ?? [],
        scopes: listing.scopes,
        commands: listing.commands,
        origins: listing.origins,
        destinations: listing.destinations.map(marked),
        tools: listing.tools.map(marked),
      };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/agents/:id/grants/revoke`,
    async handler(context) {
      const agentId = validGrantsAgentId(context.params.id);
      const store = grantStoreOf(context);
      const body = await readJsonObject(context.request);
      const tool = optionalString(body, 'tool');
      const scope = optionalString(body, 'scope');
      const origin = optionalString(body, 'origin');
      const destination = optionalString(body, 'destination');
      const named = [tool, scope, origin, destination].filter((value) => value !== undefined).length;
      if (named !== 1) {
        throw new ApiError(400, 'invalid_grant', 'Name exactly one of tool, scope, origin, or destination to revoke.');
      }
      // Through the daemon's own store, so the policy's next decision sees
      // the removal — this is what makes a revoke take effect without a
      // restart, and why the CLI comes here rather than editing the file.
      let revoked: boolean;
      try {
        revoked = tool !== undefined
          ? await store.forgetTool(agentId, tool)
          : scope !== undefined
            ? await store.forgetScope(agentId, scope)
            : destination !== undefined
              ? await store.forgetDestination(agentId, destination)
              : await store.forgetOrigin(agentId, origin ?? '');
      } catch (error) {
        if (!(error instanceof WhitelistUnreadableError)) {
          throw error;
        }
        // A file that exists and will not parse is never written over — the
        // same rule a grant obeys — so there is nothing to revoke *in*, and
        // the message names the fix.
        throw new ApiError(409, 'grants_unreadable', error.message);
      }
      if (!revoked) {
        throw new ApiError(
          404,
          'grant_not_found',
          `${agentId} has no such grant. GET /agents/${agentId}/grants lists what exists.`,
        );
      }
      return { revoked: true };
    },
  },
];
