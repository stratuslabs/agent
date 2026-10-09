import { commandScopeFromPrefix, type CommandScope } from '@stratusagent/permissions';
import { resolveAgentApprovals, type ApprovalsConfig } from '@stratusagent/state';

/**
 * The commands an operator declared in `approvals.commands` (every agent)
 * and `approvals.agents.<id>.commands` (one agent), as the scopes the
 * permission engine matches. Each declared command runs without asking.
 *
 * Read from the config the daemon started with and never written anywhere:
 * the whitelist file holds what somebody answered "always allow" to, this
 * is what the operator wrote down, and keeping them apart is what lets
 * `stratus grants revoke` say truthfully that a config entry is not its to
 * take back.
 *
 * An entry that is not a command prefix (a flag, an operator, a glob) is
 * skipped and reported once through `warn`. Skipping narrows what runs
 * unattended, which is the direction to fail in; refusing to start would
 * turn a typo in a convenience list into an outage.
 */
export const createOperatorCommands = (
  approvals: ApprovalsConfig,
  warn: (line: string) => void,
): { scopesFor: (agentId: string) => CommandScope[]; declaredFor: (agentId: string) => string[] } => {
  const parsed = new Map<string, CommandScope | undefined>();
  const scopeOf = (entry: string): CommandScope | undefined => {
    if (!parsed.has(entry)) {
      const result = commandScopeFromPrefix(entry);
      if ('reason' in result) {
        warn(`approvals.commands: ignoring "${entry}": ${result.reason}`);
        parsed.set(entry, undefined);
      } else {
        parsed.set(entry, result.scope);
      }
    }
    return parsed.get(entry);
  };
  const declaredFor = (agentId: string): string[] => resolveAgentApprovals(approvals, agentId).commands ?? [];
  // Every entry is checked up front, so a bad one is reported when the
  // daemon starts, not the first time some agent happens to run a command.
  for (const entry of [...(approvals.commands ?? []), ...Object.values(approvals.agents ?? {}).flatMap((agent) => agent.commands ?? [])]) {
    scopeOf(entry);
  }
  return {
    declaredFor,
    scopesFor: (agentId) => declaredFor(agentId)
      .map(scopeOf)
      .filter((scope): scope is CommandScope => scope !== undefined),
  };
};

/** The startup line naming what runs without asking because config says so. */
export const describeOperatorCommands = (approvals: ApprovalsConfig): string | undefined => {
  const parts: string[] = [];
  if ((approvals.commands ?? []).length > 0) {
    parts.push(`${(approvals.commands ?? []).join(', ')} for every agent`);
  }
  for (const [agentId, agent] of Object.entries(approvals.agents ?? {})) {
    if ((agent.commands ?? []).length > 0) {
      parts.push(`${(agent.commands ?? []).join(', ')} for ${agentId}`);
    }
  }
  return parts.length === 0 ? undefined : `approvals: run without asking, from config: ${parts.join('; ')}`;
};
