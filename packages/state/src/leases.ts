import { randomBytes } from 'node:crypto';
import {
  assertCredentialAllowed,
  HostRefusalError,
  type AgentDefinition,
  type CredentialResolver,
  type CredentialUseContext,
} from '@stratusagent/core';
import { isValidAgentId } from '@stratusagent/agents';
import { CREDENTIAL_NAME_PATTERN } from './credentials.ts';
import { CREDENTIAL_PROVIDER_NAMES } from './provider-names.ts';

/**
 * The `leases` block of a trusted config: which credentials may only be
 * used under a lease. Read live, like the budget: the daemon re-reads it
 * before every provider call and every leased resolution, so fencing a key
 * takes effect on its next use.
 *
 * A list of names rather than a flag per credential, and nothing else,
 * because marking is the operator's one decision here — which keys are
 * sensitive enough that holding them is not the same as being allowed to
 * use them right now. Everything about *a* lease (for whom, how long, how
 * many uses, why) is a grant, made later and recorded where it can be
 * revoked. A credential not listed works exactly as it always did.
 *
 * Trusted configs only, like `approvals`: a cloned repository must not be
 * able to take a credential off the list.
 */
export interface LeasesConfig {
  /** Named-credential names, or `provider:anthropic` / `provider:openai` / `provider:codex` for a built-in sign-in. */
  credentials: string[];
}

const PROVIDER_CREDENTIAL_PATTERN = new RegExp(`^provider:(${CREDENTIAL_PROVIDER_NAMES.join('|')})$`);

/** Whether a name can be leased: a named credential, or a built-in provider's sign-in. */
export const isLeasableCredentialName = (name: string): boolean =>
  CREDENTIAL_NAME_PATTERN.test(name) || PROVIDER_CREDENTIAL_PATTERN.test(name);

export const parseLeasesConfig = (raw: unknown, configPath: string): LeasesConfig | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const block = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  // A key the block does not have is refused, not skipped: a misspelled
  // `credentails` beside a real list would leave every name in it unfenced
  // while the config reads as fencing them.
  const unknown = block ? Object.keys(block).filter((key) => key !== 'credentials') : [];
  if (unknown.length > 0) {
    throw new Error(
      `Invalid leases in config ${configPath}: unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}. It takes only "credentials".`,
    );
  }
  const credentials = block?.credentials;
  // Refused rather than dropped: a leased list silently ignored is a key an
  // operator believes is fenced and every agent holding it can use freely.
  if (!Array.isArray(credentials) || credentials.some((name) => typeof name !== 'string')) {
    throw new Error(
      `Invalid leases in config ${configPath}: expected { "credentials": ["name", …] }, the credentials that may only be used under a lease.`,
    );
  }
  for (const name of credentials as string[]) {
    if (!isLeasableCredentialName(name)) {
      throw new Error(
        `Invalid leases.credentials entry in config ${configPath}: ${JSON.stringify(name)}. `
        + `Name a stored credential (as \`stratus credentials\` lists it) or a sign-in as ${CREDENTIAL_PROVIDER_NAMES.map((p) => `provider:${p}`).join(', ')}.`,
      );
    }
  }
  return { credentials: [...new Set(credentials as string[])] };
};

/**
 * One grant of one credential to one agent, bounded in time and optionally
 * in uses.
 *
 * `expiresAt` is required: a lease that never ends is a grant, and grants
 * are what the soul's `credentials:` list already is. Uses are counted
 * durably, so a daemon restart neither resets a count nor extends a lease
 * — the one kind that does end with the process is the delegated
 * sub-lease, which is minted for one sub-session and never stored.
 */
export interface CredentialLease {
  id: string;
  agentId: string;
  credential: string;
  grantedAt: string;
  expiresAt: string;
  /** Absent means no use limit inside the window. */
  maxUses?: number;
  uses: number;
  /** Why it was granted, in the operator's words — required, because an audit trail without one is a list of ids. */
  reason: string;
  /** Who granted it: `cli`, `api:<label>`, `dashboard:<label>`. */
  grantedBy?: string;
  revokedAt?: string;
  revokedBy?: string;
  /** Set on a delegated sub-lease: the lease (or sub-lease) it draws on. */
  parentId?: string;
  /** Set on a delegated sub-lease: the one sub-session it may be used in. */
  sessionId?: string;
}

export type LeaseState = 'active' | 'expired' | 'exhausted' | 'revoked';

export const leaseState = (lease: CredentialLease, now: Date): LeaseState => {
  if (lease.revokedAt !== undefined) {
    return 'revoked';
  }
  if (Date.parse(lease.expiresAt) <= now.getTime()) {
    return 'expired';
  }
  if (lease.maxUses !== undefined && lease.uses >= lease.maxUses) {
    return 'exhausted';
  }
  return 'active';
};

export interface LeaseGrant {
  agentId: string;
  credential: string;
  expiresAt: string;
  maxUses?: number;
  reason: string;
  grantedBy?: string;
}

/**
 * Where granted leases are kept. The daemon's is a table in `fleet.db`
 * (`SqliteLeaseStore` in `@stratusagent/gateway`); every mutation is one
 * atomic statement there, because a CLI revoke and a daemon's use can race
 * and a use counted twice or not at all is the defect a lease exists to
 * rule out.
 */
export interface LeaseStore {
  list(filter?: { agentId?: string }): CredentialLease[];
  get(id: string): CredentialLease | undefined;
  grant(input: LeaseGrant): CredentialLease;
  revoke(id: string, revokedBy?: string, now?: Date): CredentialLease | undefined;
  /**
   * Take one use of the agent's active lease on `credential` — the one
   * expiring soonest, so the shortest grant is spent first — or return
   * undefined when none is active. Atomic.
   */
  consume(agentId: string, credential: string, now: Date): CredentialLease | undefined;
  /** Take one use of this lease if it is still active. Atomic. */
  consumeById(id: string, now: Date): CredentialLease | undefined;
}

/** Thrown when a leased credential is asked for with no active lease to pay for the use. */
export class CredentialLeaseError extends HostRefusalError {
  readonly agentId: string;
  readonly credential: string;

  constructor(message: string, agentId: string, credential: string) {
    super(message);
    this.name = 'CredentialLeaseError';
    this.agentId = agentId;
    this.credential = credential;
  }
}

/** `30m`, `2h`, `7d` → milliseconds. Undefined for anything else. */
export const parseLeaseDuration = (value: string): number | undefined => {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return amount > 0 ? amount * unit : undefined;
};

/** The longest a single grant may run. A lease that outlives a quarter is a standing grant with extra steps. */
export const MAX_LEASE_MS = 90 * 86_400_000;

/**
 * Check a grant before it is stored, with the sentence each refusal needs.
 * One implementation for the CLI and the control API, so the two cannot
 * disagree about what a valid lease is.
 */
export const validateLeaseGrant = (input: LeaseGrant, now: Date): void => {
  if (!isValidAgentId(input.agentId)) {
    throw new Error(`${JSON.stringify(input.agentId)} is not an agent id. \`stratus agents\` lists the roster.`);
  }
  if (!isLeasableCredentialName(input.credential)) {
    throw new Error(
      `${JSON.stringify(input.credential)} cannot be leased. Name a stored credential or a sign-in as ${CREDENTIAL_PROVIDER_NAMES.map((p) => `provider:${p}`).join(', ')}.`,
    );
  }
  const expires = Date.parse(input.expiresAt);
  if (Number.isNaN(expires) || expires <= now.getTime()) {
    throw new Error('A lease must expire in the future. Give a duration like 30m, 2h, or 7d.');
  }
  if (expires - now.getTime() > MAX_LEASE_MS) {
    throw new Error('A lease may run for at most 90 days. For a key an agent should always hold, leave it off leases.credentials instead.');
  }
  if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    throw new Error(`Invalid use limit ${String(input.maxUses)}: use a whole number, 1 or more, or leave it out for no limit.`);
  }
  if (input.reason.trim().length === 0) {
    throw new Error('A lease needs a reason: say why this agent may use this key, for whoever reads the record later.');
  }
};

export const newLeaseId = (prefix: 'lease' | 'sub'): string => `${prefix}_${randomBytes(8).toString('hex')}`;

/** What the broker reports for every leased resolution — the audit record. */
export interface LeaseUseRecord {
  agentId: string;
  credential: string;
  outcome: 'allowed' | 'refused';
  sessionId?: string;
  use?: string;
  leaseId?: string;
  parentLeaseId?: string;
  reason?: string;
}

export interface LeaseBrokerOptions {
  store: LeaseStore;
  /** `leases.credentials` — the names that need a lease. Replaced later with `setLeased`. */
  leased: Iterable<string>;
  now?: () => Date;
  onUse?: (record: LeaseUseRecord) => void;
}

export interface LeaseBroker {
  isLeased(credential: string): boolean;
  /**
   * Replace the leased list — a host re-reading its config. An `Error`
   * instead of a list means the list is unknown (the config cannot be
   * read): every credential is then treated as leased and refused, with
   * that error in the sentence, until a list arrives. Unknown must never
   * read as "nothing is leased", which would unfence every key it names.
   */
  setLeased(leased: Iterable<string> | Error): void;
  /**
   * Pay for one use of `credential` by `agentId`, or throw a
   * `CredentialLeaseError` naming why not and what fixes it. A credential
   * not on the leased list is free and returns undefined.
   */
  use(agentId: string, credential: string, context?: CredentialUseContext): CredentialLease | undefined;
  /**
   * Hand a delegated agent the leased credentials its delegator holds,
   * each as a sub-lease no wider than what it draws on: the same or an
   * earlier expiry, no more uses than the parent has left, and bound to the
   * one sub-session. Every use also spends one of the parent's, and a
   * parent revoked, expired, or used up ends its sub-leases with it.
   *
   * A sub-lease is permission to *use* a key now, never permission to hold
   * one: a named credential is still resolved only for a delegate whose own
   * soul lists it (`assertCredentialAllowed` runs before any lease is
   * consulted), so lending one the delegate's soul does not name widens
   * nothing — it simply goes unused.
   */
  mintSubLeases(input: {
    parentAgentId: string;
    parentSessionId: string;
    child: AgentDefinition;
    childSessionId: string;
  }): CredentialLease[];
  /** End one live sub-lease now, and every sub-lease drawn from it. Undefined when there is no such live sub-lease. */
  revokeSubLease(id: string, revokedBy?: string): CredentialLease | undefined;
  /** Drop the sub-leases minted for a sub-session, once its delegated turn is over. */
  releaseSubLeases(childSessionId: string): void;
  /** The live sub-leases, for a listing. */
  subLeases(): CredentialLease[];
}

export const createLeaseBroker = (options: LeaseBrokerOptions): LeaseBroker => {
  let leased: Set<string> | Error = new Set(options.leased);
  const now = options.now ?? (() => new Date());
  const subLeases = new Map<string, CredentialLease>();

  const report = (record: LeaseUseRecord): void => {
    options.onUse?.(record);
  };

  /**
   * Take one use of a sub-lease and of everything above it, or of none.
   * A chain is judged whole before anything is counted: a sub-lease whose
   * parent is spent must not burn its own use on the way to finding out.
   */
  const consumeChain = (lease: CredentialLease, at: Date): boolean => {
    const chain: CredentialLease[] = [];
    let current: CredentialLease | undefined = lease;
    while (current?.parentId !== undefined && current.sessionId !== undefined) {
      if (leaseState(current, at) !== 'active') {
        return false;
      }
      chain.push(current);
      const parentId: string = current.parentId;
      current = subLeases.get(parentId) ?? options.store.get(parentId);
    }
    if (!current || leaseState(current, at) !== 'active') {
      return false;
    }
    // The stored root is the one counter another process can race, so it
    // is taken atomically and first; the in-memory links below it follow.
    if (!options.store.consumeById(current.id, at)) {
      return false;
    }
    for (const link of chain) {
      link.uses += 1;
    }
    return true;
  };

  const refusalFor = (agentId: string, credential: string, at: Date): string => {
    const grant = `\`stratus lease grant ${agentId} ${credential} --for 1h --reason "…"\``;
    // The most recent grant is the one worth explaining — the lease the
    // operator will think of. Later in the listing wins a tie, since two
    // grants can share a millisecond and the listing is in grant order.
    const latest = options.store.list({ agentId })
      .filter((lease) => lease.credential === credential)
      .reduce<CredentialLease | undefined>((found, lease) => (!found || lease.grantedAt >= found.grantedAt ? lease : found), undefined);
    if (!latest) {
      return `${credential} may only be used under a lease, and agent ${agentId} holds none. An operator can grant one with ${grant}.`;
    }
    const state = leaseState(latest, at);
    const why = state === 'revoked'
      ? `was revoked${latest.revokedBy ? ` by ${latest.revokedBy}` : ''} at ${latest.revokedAt}`
      : state === 'exhausted'
        ? `has used all ${String(latest.maxUses)} of its uses`
        : `expired at ${latest.expiresAt}`;
    return `Agent ${agentId}'s lease on ${credential} (${latest.id}) ${why}, so the key was not used. An operator can grant a new one with ${grant}.`;
  };

  return {
    isLeased: (credential) => leased instanceof Error || leased.has(credential),

    setLeased(next) {
      leased = next instanceof Error ? next : new Set(next);
    },

    use(agentId, credential, context = {}) {
      if (!(leased instanceof Error) && !leased.has(credential)) {
        return undefined;
      }
      const at = now();
      const base = {
        agentId,
        credential,
        ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
        ...(context.use !== undefined ? { use: context.use } : {}),
      };
      if (leased instanceof Error) {
        // The config's own error stays in the daemon's warning: this
        // sentence can reach a chat, and a file path is not the reader's.
        const reason = `Which credentials need a lease is unknown right now, because the config could not be read, so ${credential} was not used. The operator can fix the config's leases block, and the next use will be judged by it.`;
        report({ ...base, outcome: 'refused', reason });
        throw new CredentialLeaseError(reason, agentId, credential);
      }
      // The agent's own lease first: delegation never took away what an
      // agent already held, and a sub-lease is the delegator's authority
      // lent for one task, not a replacement for the delegate's own.
      const own = options.store.consume(agentId, credential, at);
      if (own) {
        report({ ...base, outcome: 'allowed', leaseId: own.id });
        return own;
      }
      let borrowed: CredentialLease | undefined;
      if (context.sessionId !== undefined) {
        for (const lease of subLeases.values()) {
          if (lease.sessionId === context.sessionId && lease.agentId === agentId && lease.credential === credential) {
            if (consumeChain(lease, at)) {
              report({ ...base, outcome: 'allowed', leaseId: lease.id, ...(lease.parentId ? { parentLeaseId: lease.parentId } : {}) });
              return lease;
            }
            borrowed = lease;
          }
        }
      }
      // A delegate that did borrow one is told about the lease it borrowed,
      // not that it holds none of its own — the fix is the delegator's.
      const reason = borrowed
        ? `The lease ${agentId} borrowed for ${credential} (${borrowed.id}, from ${borrowed.parentId ?? 'its delegator'}) has ended — revoked, expired, or used up above it — so the key was not used. The delegating agent needs a live lease of its own.`
        : refusalFor(agentId, credential, at);
      report({ ...base, outcome: 'refused', reason });
      throw new CredentialLeaseError(reason, agentId, credential);
    },

    mintSubLeases({ parentAgentId, parentSessionId, child, childSessionId }) {
      const at = now();
      const minted: CredentialLease[] = [];
      if (leased instanceof Error) {
        return [];
      }
      for (const credential of leased) {
        const parents = [
          ...options.store.list({ agentId: parentAgentId }),
          ...[...subLeases.values()].filter((lease) => lease.sessionId === parentSessionId && lease.agentId === parentAgentId),
        ].filter((lease) => lease.credential === credential && leaseState(lease, at) === 'active');
        // The latest-expiring parent: the sub-lease is clamped to it
        // anyway, and lending the shortest one would end the delegate's
        // task early for no narrowing the clamp does not already give.
        const parent = parents.sort((left, right) => right.expiresAt.localeCompare(left.expiresAt))[0];
        if (!parent) {
          continue;
        }
        const sub: CredentialLease = {
          id: newLeaseId('sub'),
          agentId: child.id,
          credential,
          grantedAt: at.toISOString(),
          expiresAt: parent.expiresAt,
          ...(parent.maxUses !== undefined ? { maxUses: parent.maxUses - parent.uses } : {}),
          uses: 0,
          reason: `delegated by ${parentAgentId} (${parent.id})`,
          grantedBy: `delegation:${parentAgentId}`,
          parentId: parent.id,
          sessionId: childSessionId,
        };
        subLeases.set(sub.id, sub);
        minted.push({ ...sub });
      }
      return minted;
    },

    revokeSubLease(id, revokedBy) {
      const lease = subLeases.get(id);
      if (!lease || lease.revokedAt !== undefined) {
        return undefined;
      }
      // Marked rather than deleted: a nested sub-lease drawing on this one
      // finds its parent revoked on its next use and refuses with it.
      lease.revokedAt = now().toISOString();
      if (revokedBy !== undefined) {
        lease.revokedBy = revokedBy;
      }
      return { ...lease };
    },

    releaseSubLeases(childSessionId) {
      for (const [id, lease] of subLeases) {
        if (lease.sessionId === childSessionId) {
          subLeases.delete(id);
        }
      }
    },

    subLeases: () => [...subLeases.values()].map((lease) => ({ ...lease })),
  };
};

/**
 * A `CredentialResolver` that makes a leased credential cost a lease use.
 *
 * Order is load-bearing. The allowlist first, so an agent whose soul does
 * not list the key is refused as it always was and never touches a lease;
 * then the value, so a key that is not stored at all fails as "not found"
 * without spending a use on nothing; then the lease, which is the last
 * word. Credentials not on the leased list pass straight through.
 */
export const createLeaseResolver = (base: CredentialResolver, broker: LeaseBroker): CredentialResolver => ({
  async resolve(agent, name, context) {
    assertCredentialAllowed(agent, name);
    const value = await base.resolve(agent, name, context);
    if (value === undefined) {
      return undefined;
    }
    broker.use(agent.id, name, context);
    return value;
  },
});
