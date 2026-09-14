import { AgentRegistry, type AgentDefinition } from '@stratusagent/core';

export interface AgentRouteRule {
  /** Regex or predicate matched against the routing key (e.g. channel or message). */
  match: RegExp | ((input: string) => boolean);
  agent: AgentDefinition;
}

export interface AgentRouter {
  route(input: string): AgentDefinition;
}

/**
 * Route inbound work (a channel name, a message, a thread key) to an agent.
 * The Slack transport will feed channel/mention strings through this so the
 * same person consistently answers in the same places.
 */
export const createAgentRouter = (
  rules: AgentRouteRule[],
  fallback: AgentDefinition,
): AgentRouter => {
  // Global/sticky regexes mutate lastIndex on test(). Clone them (so the
  // caller's regex is never touched) keeping all flags — sticky stays
  // anchored — and reset lastIndex before every test for stable results.
  const normalized = rules.map((rule) => ({
    ...rule,
    match: rule.match instanceof RegExp
      ? new RegExp(rule.match.source, rule.match.flags)
      : rule.match,
  }));

  return {
    route(input) {
      for (const rule of normalized) {
        let matched: boolean;
        if (rule.match instanceof RegExp) {
          rule.match.lastIndex = 0;
          matched = rule.match.test(input);
        } else {
          matched = rule.match(input);
        }
        if (matched) {
          return rule.agent;
        }
      }
      return fallback;
    },
  };
};

/** Register a set of agents and get the registry back. */
export const createAgentTeam = (agents: AgentDefinition[]): AgentRegistry => {
  const registry = new AgentRegistry();
  for (const agent of agents) {
    registry.register(agent);
  }
  return registry;
};
