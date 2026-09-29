import { HostRefusalError, type TokenUsage } from '@stratusagent/core';
import { isValidAgentId } from '@stratusagent/agents';
import { foldedAgentId } from './paths.ts';

/**
 * The `budget` block of a trusted config: how much one home may spend on
 * models per UTC day and per UTC month, and per agent beneath that.
 *
 * In **weighted tokens**, not money. Roadmap 18 (usage accounting) drew
 * that line — a price table is not this repository's to own — and a
 * budget keeps it: the operator (or a hosted deployment provisioning a
 * tenant) converts a plan into a number once, here. The weights are what
 * make that number meaningful, because the four buckets are not priced
 * alike: under prompt caching most of a long conversation's input is cache
 * reads at a tenth of the input rate, and a cap that counted them one for
 * one would stop an agent at a tenth of what the operator meant to allow.
 */
export interface BudgetLimits {
  /** Weighted tokens per UTC day. */
  daily?: number;
  /** Weighted tokens per UTC calendar month. */
  monthly?: number;
}

export type BudgetWeights = Partial<Record<keyof TokenUsage, number>>;

export interface BudgetConfig extends BudgetLimits {
  /** Multiplier per usage bucket. A bucket not named counts 1. */
  weights?: BudgetWeights;
  /** Per-agent limits, applied in addition to the home's own, never instead of it. */
  agents?: Record<string, BudgetLimits>;
}

export type BudgetPeriod = 'daily' | 'monthly';

const BUDGET_PERIODS: readonly BudgetPeriod[] = ['daily', 'monthly'];

const WEIGHT_KEYS: ReadonlyArray<keyof TokenUsage> = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseLimits = (raw: Record<string, unknown>, where: string, configPath: string): BudgetLimits => {
  const limits: BudgetLimits = {};
  for (const period of BUDGET_PERIODS) {
    const value = raw[period];
    if (value === undefined) {
      continue;
    }
    // Refused rather than clamped, like `maxTurns`: a zero or a fraction
    // here is an install where nothing can answer, and the only clue would
    // be every turn failing with a budget message that looks deliberate.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `Invalid ${where}.${period} in config ${configPath}: ${JSON.stringify(value)}. `
        + 'Use a whole number of weighted tokens, 1 or more, or leave it out for no limit.',
      );
    }
    limits[period] = value;
  }
  return limits;
};

/**
 * Validate the `budget` block. Refused when misshapen rather than dropped:
 * a limit silently ignored is spend an operator believes is capped.
 */
export const parseBudgetConfig = (raw: unknown, configPath: string): BudgetConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid budget in config ${configPath}: expected an object like { "daily": 2000000 }.`);
  }
  const budget: BudgetConfig = parseLimits(raw, 'budget', configPath);
  if (raw.weights !== undefined) {
    if (!isPlainObject(raw.weights)) {
      throw new Error(`Invalid budget.weights in config ${configPath}: expected an object keyed by usage bucket.`);
    }
    const weights: BudgetWeights = {};
    for (const [key, value] of Object.entries(raw.weights)) {
      if (!(WEIGHT_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `Invalid budget.weights.${key} in config ${configPath}: the buckets are ${WEIGHT_KEYS.join(', ')}.`,
        );
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(
          `Invalid budget.weights.${key} in config ${configPath}: ${JSON.stringify(value)}. Use a number, 0 or more.`,
        );
      }
      weights[key as keyof TokenUsage] = value;
    }
    budget.weights = weights;
  }
  if (raw.agents !== undefined) {
    if (!isPlainObject(raw.agents)) {
      throw new Error(`Invalid budget.agents in config ${configPath}: expected an object keyed by agent id.`);
    }
    const agents: Record<string, BudgetLimits> = {};
    for (const [agentId, entry] of Object.entries(raw.agents)) {
      if (!isValidAgentId(agentId)) {
        throw new Error(`Invalid budget.agents key in config ${configPath}: ${JSON.stringify(agentId)} is not an agent id.`);
      }
      if (!isPlainObject(entry)) {
        throw new Error(`Invalid budget.agents.${agentId} in config ${configPath}: expected an object like { "daily": 500000 }.`);
      }
      agents[agentId] = parseLimits(entry, `budget.agents.${agentId}`, configPath);
    }
    budget.agents = agents;
  }
  return budget;
};

/**
 * One usage record's weight against a budget. A bucket the provider did
 * not report adds nothing — absent is "not reported", and inventing a zero
 * or anything else here would bill for a measurement nobody made.
 */
export const weightedTokens = (usage: TokenUsage, weights: BudgetWeights = {}): number => {
  let total = 0;
  for (const key of WEIGHT_KEYS) {
    const count = usage[key];
    if (count !== undefined) {
      total += count * (weights[key] ?? 1);
    }
  }
  return total;
};

/**
 * The window a period covers at `now`, in UTC — when it began and when it
 * resets. UTC because a daemon's local zone is the machine's, not the
 * operator's, and a hosted deployment's tenants share one machine: a budget
 * that reset at a different instant depending on where the image happened
 * to run would be a budget nobody could state.
 */
export const budgetWindow = (period: BudgetPeriod, now: Date): { start: string; resetsAt: string } => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === 'daily') {
    const day = now.getUTCDate();
    return {
      start: new Date(Date.UTC(year, month, day)).toISOString(),
      resetsAt: new Date(Date.UTC(year, month, day + 1)).toISOString(),
    };
  }
  return {
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    resetsAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
};

/** A limit that has been reached, with everything the refusal has to say. */
export interface BudgetBreach {
  /** `home` for the block's own limits, `agent` for `budget.agents.<id>`. */
  scope: 'home' | 'agent';
  agentId: string;
  /** For an agent's limit: the `budget.agents` key as the config spells it, which may differ from the id in case. */
  configKey?: string;
  period: BudgetPeriod;
  limit: number;
  spent: number;
  resetsAt: string;
}

/** Weighted spend since `since`, for one agent or (no agent) the whole home. */
export type BudgetSpend = (since: string, agentId?: string) => number;

/**
 * An agent's own limits, matched the way agent identity is everywhere else:
 * folded, so `budget.agents.scout` governs a soul whose id is `Scout`. Two
 * spellings of one id are one agent — the roster refuses to load them as
 * two — and an exact-match lookup here would be a limit the operator wrote
 * down that silently never applies.
 */
const agentLimitsFor = (budget: BudgetConfig, agentId: string): [key: string, limits: BudgetLimits] | undefined => {
  const folded = foldedAgentId(agentId);
  return Object.entries(budget.agents ?? {}).find(([key]) => foldedAgentId(key) === folded);
};

/**
 * The first limit this agent's next call would exceed, or undefined.
 *
 * Judged as "already at or past it", before the call: what a call will
 * cost is not knowable in advance, so a budget can only refuse the call
 * after the one that reached it. One call's worth of overshoot is the
 * price — for a harness provider, one turn's, since its inner calls happen
 * inside one `generate`. The home's limits are checked before the agent's
 * own, so the message names the wider one when both are spent.
 */
export const findBudgetBreach = (
  budget: BudgetConfig,
  agentId: string,
  spend: BudgetSpend,
  now: Date,
): BudgetBreach | undefined => {
  const own = agentLimitsFor(budget, agentId);
  const scopes: Array<{ scope: 'home' | 'agent'; limits: BudgetLimits }> = [
    { scope: 'home', limits: budget },
    ...(own ? [{ scope: 'agent' as const, limits: own[1] }] : []),
  ];
  for (const { scope, limits } of scopes) {
    for (const period of BUDGET_PERIODS) {
      const limit = limits[period];
      if (limit === undefined) {
        continue;
      }
      const window = budgetWindow(period, now);
      const spent = spend(window.start, scope === 'agent' ? agentId : undefined);
      if (spent >= limit) {
        return {
          scope,
          agentId,
          ...(scope === 'agent' && own ? { configKey: own[0] } : {}),
          period,
          limit,
          spent,
          resetsAt: window.resetsAt,
        };
      }
    }
  }
  return undefined;
};

const formatCount = (value: number): string => Math.round(value).toLocaleString('en-US');

/** When a window resets, as a person reads it: `2026-09-30 00:00 UTC`. */
const formatReset = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * The sentence a spent budget stops a turn with. Written for whoever is in
 * the conversation — who may not be the operator — so it says what ran
 * out, when it comes back, and which key the operator changes to bring it
 * back sooner.
 */
export const budgetExceededMessage = (breach: BudgetBreach): string => {
  const which = breach.period === 'daily' ? 'daily' : 'monthly';
  const whose = breach.scope === 'home' ? 'This Stratus install has' : `Agent ${breach.agentId} has`;
  const key = breach.scope === 'home'
    ? `budget.${breach.period}`
    : `budget.agents.${breach.configKey ?? breach.agentId}.${breach.period}`;
  return `${whose} used its ${which} model budget (${formatCount(breach.spent)} of ${formatCount(breach.limit)} weighted tokens), `
    + `so its model is not being called again until the budget resets at ${formatReset(breach.resetsAt)}. `
    + `To continue sooner, the operator can raise ${key} in the trusted config.`;
};

/** Thrown before a provider call when a budget is spent. */
export class BudgetExceededError extends HostRefusalError {
  readonly breach: BudgetBreach;

  constructor(breach: BudgetBreach) {
    super(budgetExceededMessage(breach));
    this.name = 'BudgetExceededError';
    this.breach = breach;
  }
}

/** Where one limit stands right now — a row of `GET /usage` and `stratus usage`. */
export interface BudgetLimitStatus {
  scope: 'home' | 'agent';
  /** Set for an agent's own limit. */
  agentId?: string;
  period: BudgetPeriod;
  limit: number;
  spent: number;
  resetsAt: string;
  /** At or past the limit: the next provider call in its scope is refused. */
  reached: boolean;
}

/**
 * Every configured limit with its current spend, the home's first. One
 * implementation for the control API and the CLI, which would otherwise
 * each re-derive the window and the weighting — and disagree the first
 * time either changed.
 */
export const budgetStatus = (budget: BudgetConfig, spend: BudgetSpend, now: Date): BudgetLimitStatus[] => {
  const rows: BudgetLimitStatus[] = [];
  const scopes: Array<{ scope: 'home' | 'agent'; agentId?: string; limits: BudgetLimits }> = [
    { scope: 'home', limits: budget },
    ...Object.entries(budget.agents ?? {}).map(([agentId, limits]) => ({ scope: 'agent' as const, agentId, limits })),
  ];
  for (const { scope, agentId, limits } of scopes) {
    for (const period of BUDGET_PERIODS) {
      const limit = limits[period];
      if (limit === undefined) {
        continue;
      }
      const window = budgetWindow(period, now);
      const spent = spend(window.start, agentId);
      rows.push({
        scope,
        ...(agentId !== undefined ? { agentId } : {}),
        period,
        limit,
        spent,
        resetsAt: window.resetsAt,
        reached: spent >= limit,
      });
    }
  }
  return rows;
};
