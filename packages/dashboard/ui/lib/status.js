/**
 * What an agent is doing, in the four words every screen uses: Working,
 * Needs you, Idle, and Can't reach provider.
 *
 * Worked out from data the API already serves, without a verdict from the
 * daemon: the roster's count of running or parked sessions, the pending
 * approvals, and `/health`'s runtimes. A runtime with a `problem` is the
 * daemon saying no provider resolves; it applies to the agents that run on
 * none. An approval outranks everything, because it is the one state a
 * person has to act on.
 */
export const agentStatus = (agent, { approvals = [], runtimes = [] } = {}) => {
  if (approvals.some((request) => request.agentId === agent.id)) {
    return { kind: 'needs', label: 'Needs you' };
  }
  const problem = runtimes.find((runtime) => typeof runtime.problem === 'string' && runtime.problem.length > 0);
  if (problem && (agent.runsOn === undefined || agent.runsOn.provider === 'none')) {
    return { kind: 'provider', label: "Can't reach provider", detail: problem.problem };
  }
  if ((agent.activeSessions ?? 0) > 0) {
    return { kind: 'working', label: 'Working' };
  }
  return { kind: 'idle', label: 'Idle' };
};

/** The one-line summary under Home's greeting. */
export const statusLine = (agents, context = {}) => {
  const waiting = (context.approvals ?? []).length;
  const working = agents.filter((agent) => agentStatus(agent, { runtimes: context.runtimes }).kind === 'working').length;
  const head = working > 0 || agents.length > 1
    ? `${working} of ${agents.length} agent${agents.length === 1 ? '' : 's'} working`
    : `${agents.length} agent${agents.length === 1 ? '' : 's'} · nothing running`;
  return waiting > 0 ? `${head} · ${waiting} need${waiting === 1 ? 's' : ''} you` : head;
};
