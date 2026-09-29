import type { DatabaseSync } from 'node:sqlite';
import { newLeaseId, type CredentialLease, type LeaseGrant, type LeaseStore } from '@stratusagent/state';
import { openStratusDatabase, tightenSqliteFile, type SqliteSessionStoreOptions } from './sessions.ts';

const LEASES_TABLE = `
  CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    credential TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    granted_by TEXT,
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS leases_agent_credential ON leases (agent_id, credential);
`;

/** The condition a lease has to meet to pay for a use — one spelling, used by both consume paths. */
const ACTIVE = 'revoked_at IS NULL AND expires_at > ? AND (max_uses IS NULL OR uses < max_uses)';

const leaseFrom = (row: Record<string, unknown>): CredentialLease => ({
  id: String(row.id),
  agentId: String(row.agent_id),
  credential: String(row.credential),
  grantedAt: String(row.granted_at),
  expiresAt: String(row.expires_at),
  ...(typeof row.max_uses === 'number' ? { maxUses: row.max_uses } : {}),
  uses: Number(row.uses),
  reason: String(row.reason),
  ...(typeof row.granted_by === 'string' ? { grantedBy: row.granted_by } : {}),
  ...(typeof row.revoked_at === 'string' ? { revokedAt: row.revoked_at } : {}),
  ...(typeof row.revoked_by === 'string' ? { revokedBy: row.revoked_by } : {}),
});

/**
 * Granted credential leases, in `fleet.db`.
 *
 * SQLite rather than a JSON file because the count is the point: a use is
 * spent by the daemon while `stratus lease revoke` may be ending the lease
 * from another process, and both have to be one atomic statement for "used
 * five times, then revoked" to mean exactly that. Every consume is a single
 * conditional `UPDATE … RETURNING`, so a use is counted once, only against
 * a lease still active at that instant, and a revoked or used-up lease is
 * never charged.
 *
 * Rows are kept after a lease ends — expired, exhausted, revoked — because
 * the listing is also the audit trail of who was allowed what and why.
 */
export class SqliteLeaseStore implements LeaseStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteSessionStoreOptions = {}) {
    this.db = openStratusDatabase(filePath, options);
    this.db.exec(LEASES_TABLE);
    tightenSqliteFile(filePath);
  }

  list(filter: { agentId?: string } = {}): CredentialLease[] {
    const rows = (filter.agentId !== undefined
      ? this.db.prepare('SELECT * FROM leases WHERE agent_id = ? ORDER BY granted_at ASC, rowid ASC').all(filter.agentId)
      : this.db.prepare('SELECT * FROM leases ORDER BY granted_at ASC, rowid ASC').all()) as Array<Record<string, unknown>>;
    return rows.map(leaseFrom);
  }

  get(id: string): CredentialLease | undefined {
    const row = this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? leaseFrom(row) : undefined;
  }

  grant(input: LeaseGrant): CredentialLease {
    const lease: CredentialLease = {
      id: newLeaseId('lease'),
      agentId: input.agentId,
      credential: input.credential,
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(input.expiresAt).toISOString(),
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      uses: 0,
      reason: input.reason,
      ...(input.grantedBy !== undefined ? { grantedBy: input.grantedBy } : {}),
    };
    this.db
      .prepare(`INSERT INTO leases (id, agent_id, credential, granted_at, expires_at, max_uses, uses, reason, granted_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(lease.id, lease.agentId, lease.credential, lease.grantedAt, lease.expiresAt,
        lease.maxUses ?? null, lease.reason, lease.grantedBy ?? null);
    return lease;
  }

  revoke(id: string, revokedBy?: string, now: Date = new Date()): CredentialLease | undefined {
    // Only a lease not already revoked: revoking twice must not rewrite
    // who ended it and when.
    const row = this.db
      .prepare('UPDATE leases SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL RETURNING *')
      .get(now.toISOString(), revokedBy ?? null, id) as Record<string, unknown> | undefined;
    return row ? leaseFrom(row) : undefined;
  }

  consume(agentId: string, credential: string, now: Date): CredentialLease | undefined {
    const at = now.toISOString();
    const row = this.db.prepare(`
      UPDATE leases SET uses = uses + 1
      WHERE id = (
        SELECT id FROM leases WHERE agent_id = ? AND credential = ? AND ${ACTIVE}
        ORDER BY expires_at ASC LIMIT 1
      ) AND ${ACTIVE}
      RETURNING *
    `).get(agentId, credential, at, at) as Record<string, unknown> | undefined;
    return row ? leaseFrom(row) : undefined;
  }

  consumeById(id: string, now: Date): CredentialLease | undefined {
    const row = this.db
      .prepare(`UPDATE leases SET uses = uses + 1 WHERE id = ? AND ${ACTIVE} RETURNING *`)
      .get(id, now.toISOString()) as Record<string, unknown> | undefined;
    return row ? leaseFrom(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
