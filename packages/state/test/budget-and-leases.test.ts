import test from 'node:test';
import assert from 'node:assert/strict';

import { HostRefusalError, type AgentDefinition, type CredentialResolver, type ModelProvider } from '@stratusagent/core';
import {
  budgetWindow,
  createFallbackWrappedProvider,
  createLeaseBroker,
  createLeaseResolver,
  CredentialLeaseError,
  findBudgetBreach,
  leaseState,
  newLeaseId,
  parseLeaseDuration,
  validateConfigFile,
  validateLeaseGrant,
  weightedTokens,
  type CredentialLease,
  type LeaseGrant,
  type LeaseStore,
} from '../src/index.ts';

/**
 * A lease store as a map — the contract's atomic operations, minus the
 * database. The fleet.db one is tested in the gateway against real SQLite.
 */
const createLeaseStore = (): LeaseStore & { leases: Map<string, CredentialLease> } => {
  const leases = new Map<string, CredentialLease>();
  const active = (lease: CredentialLease, now: Date): boolean => leaseState(lease, now) === 'active';
  return {
    leases,
    list: (filter = {}) => [...leases.values()].filter((lease) => filter.agentId === undefined || lease.agentId === filter.agentId),
    get: (id) => leases.get(id),
    grant(input: LeaseGrant) {
      const lease: CredentialLease = {
        id: newLeaseId('lease'),
        agentId: input.agentId,
        credential: input.credential,
        grantedAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
        uses: 0,
        reason: input.reason,
      };
      leases.set(lease.id, lease);
      return lease;
    },
    revoke(id, revokedBy, now = new Date()) {
      const lease = leases.get(id);
      if (!lease || lease.revokedAt !== undefined) {
        return undefined;
      }
      lease.revokedAt = now.toISOString();
      if (revokedBy !== undefined) {
        lease.revokedBy = revokedBy;
      }
      return lease;
    },
    consume(agentId, credential, now) {
      const lease = [...leases.values()]
        .filter((candidate) => candidate.agentId === agentId && candidate.credential === credential && active(candidate, now))
        .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))[0];
      if (lease) {
        lease.uses += 1;
      }
      return lease;
    },
    consumeById(id, now) {
      const lease = leases.get(id);
      if (!lease || !active(lease, now)) {
        return undefined;
      }
      lease.uses += 1;
      return lease;
    },
  };
};

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString();

const agent = (id: string, credentials: string[] = []): AgentDefinition => ({ id, name: id, credentials });

test('a budget weighs each bucket separately and ignores what was not reported', () => {
  assert.equal(weightedTokens({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 }), 1110);
  assert.equal(weightedTokens({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 }, { cacheReadTokens: 0.1, outputTokens: 5 }), 250);
  assert.equal(weightedTokens({}), 0);
});

test('budget windows are UTC days and UTC calendar months', () => {
  const now = new Date('2026-09-29T23:30:00-05:00');
  assert.deepEqual(budgetWindow('daily', now), { start: '2026-09-30T00:00:00.000Z', resetsAt: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(budgetWindow('monthly', new Date('2026-12-31T12:00:00Z')), {
    start: '2026-12-01T00:00:00.000Z',
    resetsAt: '2027-01-01T00:00:00.000Z',
  });
});

test('the home\'s limit is judged before an agent\'s, and a limit is reached at, not past, its number', () => {
  const spent = new Map<string | undefined, number>([[undefined, 500], ['ava', 100]]);
  const spend = (_since: string, agentId?: string): number => spent.get(agentId) ?? 0;
  const now = new Date('2026-09-29T12:00:00Z');
  assert.equal(findBudgetBreach({ daily: 501, agents: { ava: { daily: 101 } } }, 'ava', spend, now), undefined);
  assert.equal(findBudgetBreach({ daily: 500, agents: { ava: { daily: 100 } } }, 'ava', spend, now)?.scope, 'home');
  const agentBreach = findBudgetBreach({ monthly: 10_000, agents: { ava: { daily: 100 } } }, 'ava', spend, now);
  assert.deepEqual(agentBreach, { scope: 'agent', agentId: 'ava', period: 'daily', limit: 100, spent: 100, resetsAt: '2026-09-30T00:00:00.000Z' });
  // Another agent is untouched by ava's limit.
  assert.equal(findBudgetBreach({ agents: { ava: { daily: 100 } } }, 'bea', spend, now), undefined);
});

test('a misshapen budget or leases block is refused with the key and the fix, not dropped', () => {
  assert.deepEqual(validateConfigFile({ budget: { daily: 5, weights: { cacheReadTokens: 0.1 }, agents: { ava: { monthly: 9 } } } }, 'c.json').budget, {
    daily: 5,
    weights: { cacheReadTokens: 0.1 },
    agents: { ava: { monthly: 9 } },
  });
  assert.throws(() => validateConfigFile({ budget: { daily: 0 } }, 'c.json'), /Invalid budget\.daily in config c\.json: 0\. Use a whole number/);
  assert.throws(() => validateConfigFile({ budget: { weights: { tokens: 1 } } }, 'c.json'), /budget\.weights\.tokens.*the buckets are/);
  assert.throws(() => validateConfigFile({ budget: { agents: { '../x': {} } } }, 'c.json'), /not an agent id/);
  assert.deepEqual(validateConfigFile({ leases: { credentials: ['github.token', 'provider:anthropic', 'github.token'] } }, 'c.json').leases, {
    credentials: ['github.token', 'provider:anthropic'],
  });
  assert.throws(() => validateConfigFile({ leases: ['github.token'] }, 'c.json'), /Invalid leases in config c\.json/);
  assert.throws(() => validateConfigFile({ leases: { credentials: ['provider:demo'] } }, 'c.json'), /Invalid leases\.credentials entry/);
});

test('a grant has to end, within 90 days, and say why', () => {
  const now = new Date();
  const base = { agentId: 'ava', credential: 'github.token', expiresAt: inAnHour(), reason: 'incident 12' };
  assert.doesNotThrow(() => validateLeaseGrant(base, now));
  assert.throws(() => validateLeaseGrant({ ...base, expiresAt: now.toISOString() }, now), /must expire in the future/);
  assert.throws(() => validateLeaseGrant({ ...base, expiresAt: new Date(now.getTime() + 91 * 86_400_000).toISOString() }, now), /at most 90 days/);
  assert.throws(() => validateLeaseGrant({ ...base, reason: '  ' }, now), /needs a reason/);
  assert.throws(() => validateLeaseGrant({ ...base, maxUses: 0 }, now), /use limit/);
  assert.throws(() => validateLeaseGrant({ ...base, credential: 'provider:demo' }, now), /cannot be leased/);
  assert.equal(parseLeaseDuration('90m'), 5_400_000);
  assert.equal(parseLeaseDuration('2h'), 7_200_000);
  assert.equal(parseLeaseDuration('7d'), 604_800_000);
  assert.equal(parseLeaseDuration('0h'), undefined);
  assert.equal(parseLeaseDuration('2 hours'), undefined);
});

test('a leased credential costs a use of a live lease, and says exactly why when there is none', () => {
  const store = createLeaseStore();
  const records: string[] = [];
  const broker = createLeaseBroker({ store, leased: ['github.token'], onUse: (record) => records.push(`${record.outcome} ${record.credential}`) });
  // Not leased: free, and not recorded.
  assert.equal(broker.use('ava', 'search.apiKey'), undefined);
  assert.throws(() => broker.use('ava', 'github.token'), (error: unknown) =>
    error instanceof CredentialLeaseError
    && error instanceof HostRefusalError
    && /agent ava holds none.*stratus lease grant ava github\.token/.test(error.message));
  const lease = store.grant({ agentId: 'ava', credential: 'github.token', expiresAt: inAnHour(), maxUses: 2, reason: 'deploy' });
  assert.equal(broker.use('ava', 'github.token')?.id, lease.id);
  assert.equal(broker.use('ava', 'github.token')?.id, lease.id);
  assert.throws(() => broker.use('ava', 'github.token'), /has used all 2 of its uses/);
  const revoked = store.grant({ agentId: 'ava', credential: 'github.token', expiresAt: inAnHour(), reason: 'again' });
  store.revoke(revoked.id, 'cli');
  assert.throws(() => broker.use('ava', 'github.token'), /was revoked by cli at/);
  assert.deepEqual(records, ['refused github.token', 'allowed github.token', 'allowed github.token', 'refused github.token', 'refused github.token']);
});

test('an expired lease refuses at its expiry, however many uses it had left', () => {
  const store = createLeaseStore();
  let now = new Date('2026-09-29T12:00:00Z');
  const broker = createLeaseBroker({ store, leased: ['github.token'], now: () => now });
  store.grant({ agentId: 'ava', credential: 'github.token', expiresAt: '2026-09-29T13:00:00.000Z', maxUses: 100, reason: 'window' });
  assert.ok(broker.use('ava', 'github.token'));
  now = new Date('2026-09-29T13:00:00Z');
  assert.throws(() => broker.use('ava', 'github.token'), /expired at 2026-09-29T13:00:00\.000Z/);
});

test('a sub-lease is clamped to its parent, bound to one sub-session, draws on the parent, and dies with it', () => {
  const store = createLeaseStore();
  const broker = createLeaseBroker({ store, leased: ['github.token'] });
  const parent = store.grant({ agentId: 'ava', credential: 'github.token', expiresAt: inAnHour(), maxUses: 5, reason: 'incident' });
  broker.use('ava', 'github.token');
  const [sub] = broker.mintSubLeases({ parentAgentId: 'ava', parentSessionId: 's-1', child: agent('bea'), childSessionId: 's-1:delegate:bea:1:x' });
  assert.ok(sub);
  assert.equal(sub.parentId, parent.id);
  assert.equal(sub.agentId, 'bea');
  assert.equal(sub.sessionId, 's-1:delegate:bea:1:x');
  assert.ok(Date.parse(sub.expiresAt) <= Date.parse(parent.expiresAt));
  assert.equal(sub.maxUses, 4);

  // Only in its own sub-session.
  assert.throws(() => broker.use('bea', 'github.token', { sessionId: 'elsewhere' }), /holds none/);
  broker.use('bea', 'github.token', { sessionId: 's-1:delegate:bea:1:x' });
  assert.equal(store.get(parent.id)?.uses, 2, 'the use was paid for by the parent');

  // A nested delegation lends the sub-lease on, no wider again.
  const [nested] = broker.mintSubLeases({ parentAgentId: 'bea', parentSessionId: 's-1:delegate:bea:1:x', child: agent('cy'), childSessionId: 'nested' });
  assert.equal(nested?.parentId, sub.id);
  assert.equal(nested?.maxUses, 3);
  broker.use('cy', 'github.token', { sessionId: 'nested' });
  assert.equal(store.get(parent.id)?.uses, 3, 'every link up to the stored lease is charged');

  // Revoking the parent ends every sub-lease beneath it, at once.
  store.revoke(parent.id, 'cli');
  assert.throws(() => broker.use('bea', 'github.token', { sessionId: 's-1:delegate:bea:1:x' }), CredentialLeaseError);
  assert.throws(() => broker.use('cy', 'github.token', { sessionId: 'nested' }), CredentialLeaseError);

  broker.releaseSubLeases('s-1:delegate:bea:1:x');
  broker.releaseSubLeases('nested');
  assert.deepEqual(broker.subLeases(), []);
});

test('a delegator with no live lease lends nothing', () => {
  const store = createLeaseStore();
  const broker = createLeaseBroker({ store, leased: ['github.token'] });
  const spent = store.grant({ agentId: 'ava', credential: 'github.token', expiresAt: inAnHour(), maxUses: 1, reason: 'one shot' });
  broker.use('ava', 'github.token');
  assert.equal(leaseState(store.get(spent.id)!, new Date()), 'exhausted');
  assert.deepEqual(broker.mintSubLeases({ parentAgentId: 'ava', parentSessionId: 's', child: agent('bea'), childSessionId: 'c' }), []);
});

test('an unknown leased list refuses every credential rather than freeing them all', () => {
  const store = createLeaseStore();
  const broker = createLeaseBroker({ store, leased: [] });
  broker.setLeased(new Error('config.json: Unexpected token'));
  assert.throws(() => broker.use('ava', 'search.apiKey'), /Which credentials need a lease is unknown right now \(config\.json: Unexpected token\)/);
  broker.setLeased(['github.token']);
  assert.equal(broker.use('ava', 'search.apiKey'), undefined);
});

test('the lease resolver checks the soul first and spends nothing on a key that is not stored', async () => {
  const store = createLeaseStore();
  const broker = createLeaseBroker({ store, leased: ['github.token'] });
  store.grant({ agentId: 'ava', credential: 'github.token', expiresAt: inAnHour(), reason: 'r' });
  const values = new Map([['github.token', 'ghp_x']]);
  const base: CredentialResolver = { resolve: async (_agent, name) => values.get(name) };
  const resolver = createLeaseResolver(base, broker);

  await assert.rejects(resolver.resolve(agent('ava'), 'github.token'), /not allowed to access credential/);
  assert.equal(store.list()[0]?.uses, 0);
  values.delete('github.token');
  assert.equal(await resolver.resolve(agent('ava', ['github.token']), 'github.token'), undefined);
  assert.equal(store.list()[0]?.uses, 0);
  values.set('github.token', 'ghp_x');
  assert.equal(await resolver.resolve(agent('ava', ['github.token']), 'github.token'), 'ghp_x');
  assert.equal(store.list()[0]?.uses, 1);
});

test('a refusal the host made is never answered by the fallback model', async () => {
  let fallbackCalls = 0;
  const primary: ModelProvider = {
    name: 'primary',
    async generate() {
      throw new CredentialLeaseError('lease expired', 'ava', 'provider:anthropic');
    },
  };
  const fallback: ModelProvider = {
    name: 'fallback',
    async generate() {
      fallbackCalls += 1;
      return { parts: [{ type: 'text', text: 'covered for it' }] };
    },
  };
  const wrapped = createFallbackWrappedProvider(primary, fallback, () => {});
  await assert.rejects(
    wrapped.generate({ session: { id: 's', agent: agent('ava'), status: 'running', messages: [], createdAt: '', updatedAt: '' } }),
    /lease expired/,
  );
  assert.equal(fallbackCalls, 0);
});
