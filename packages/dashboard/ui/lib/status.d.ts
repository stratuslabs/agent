// Types for the UI module a test imports. See grants.d.ts for why.
export interface StatusAgent {
  id: string;
  name?: string;
  runsOn?: { provider: string; model?: string };
  activeSessions?: number;
}
export interface StatusContext {
  approvals?: Array<{ agentId: string }>;
  runtimes?: Array<{ provider: string; problem?: string }>;
}
export interface AgentStatus {
  kind: 'working' | 'needs' | 'idle' | 'provider';
  label: string;
  detail?: string;
}
/** Working, Needs you, Idle or Can't reach provider, from the roster, approvals and runtimes. */
export const agentStatus: (agent: StatusAgent, context?: StatusContext) => AgentStatus;
/** Home's summary line: how many agents are working, and how many approvals wait. */
export const statusLine: (agents: StatusAgent[], context?: StatusContext) => string;
