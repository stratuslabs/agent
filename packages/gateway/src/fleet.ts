import type {
  AgentDefinition,
  FleetAgent,
  FleetPendingApproval,
  FleetReader,
  FleetSchedule,
  FleetSession,
  SessionStatus,
} from '@stratusagent/core';
import { canonicalDestination, describeCadence, type ScheduleRecord } from '@stratusagent/agents';

import type { PendingApproval } from './index.ts';

/** What the fleet reader reads from: the same calls the control API makes. */
export interface FleetReaderSources {
  agents(): AgentDefinition[];
  store: {
    list(agentId?: string, limit?: number): FleetSession[];
    countByStatus(): Record<string, number>;
    lastActivityByAgent(): Record<string, { lastActiveAt: string; activeSessions: number }>;
    statusOf(id: string): SessionStatus | undefined;
  };
  schedules(): ScheduleRecord[];
  pendingApprovals(): PendingApproval[];
  /** Called once per read, before it answers: the host's audit line. */
  onRead(method: keyof FleetReader): void;
}

/**
 * The read-only fleet seam (roadmap 26). Every row is built field by field
 * rather than spread from its source, so a field added to a session,
 * schedule, or parked call later does not start crossing to plugins
 * unreviewed. Content stays behind: no persona, prompt, call input, or
 * session metadata.
 */
export const createFleetReader = (sources: FleetReaderSources): FleetReader => ({
  async agents() {
    sources.onRead('agents');
    const activity = sources.store.lastActivityByAgent();
    return sources.agents().map((agent): FleetAgent => {
      const seen = activity[agent.id];
      return {
        id: agent.id,
        name: agent.name,
        ...(seen ? { lastActiveAt: seen.lastActiveAt } : {}),
        activeSessions: seen?.activeSessions ?? 0,
      };
    });
  },

  async sessions(options = {}) {
    sources.onRead('sessions');
    return sources.store.list(options.agentId, options.limit).map((row): FleetSession => ({
      id: row.id,
      agentId: row.agentId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },

  async countByStatus() {
    sources.onRead('countByStatus');
    return { ...sources.store.countByStatus() };
  },

  async schedules() {
    sources.onRead('schedules');
    return sources.schedules().map((record): FleetSchedule => {
      const lastSessionStatus = record.lastSessionId !== undefined ? sources.store.statusOf(record.lastSessionId) : undefined;
      return {
        id: record.id,
        agentId: record.agentId,
        cadence: describeCadence(record.cadence),
        ...(record.destination ? { destination: canonicalDestination(record.destination) } : {}),
        createdAt: record.createdAt,
        ...(record.nextFireAt !== undefined ? { nextFireAt: record.nextFireAt } : {}),
        ...(record.lastFiredAt !== undefined ? { lastFiredAt: record.lastFiredAt } : {}),
        ...(lastSessionStatus !== undefined ? { lastSessionStatus } : {}),
      };
    });
  },

  async pendingApprovals() {
    sources.onRead('pendingApprovals');
    return sources.pendingApprovals().map((pending): FleetPendingApproval => ({
      requestId: pending.requestId,
      agentId: pending.agentId,
      sessionId: pending.sessionId,
      toolName: pending.call.toolName,
      risk: pending.risk,
      parkedAt: pending.parkedAt,
      ...(pending.expiresAt !== undefined ? { expiresAt: pending.expiresAt } : {}),
    }));
  },
});
