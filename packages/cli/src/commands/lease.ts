import {
  fleetDbPath,
  foldedAgentId,
  leaseState,
  listAgentSummaries,
  parseLeaseDuration,
  stratusHomePath,
  validateLeaseGrant,
  type CredentialLease,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedLeaseCommand } from '../parse.ts';

const describe = (lease: CredentialLease, now: Date): string => {
  const state = leaseState(lease, now);
  const uses = lease.maxUses !== undefined ? `${lease.uses}/${lease.maxUses} uses` : `${lease.uses} use(s)`;
  const ended = state === 'revoked'
    ? `revoked ${lease.revokedAt ?? ''}${lease.revokedBy ? ` by ${lease.revokedBy}` : ''}`
    : state === 'active'
      ? `until ${lease.expiresAt}`
      : `${state} (${lease.expiresAt})`;
  return `${lease.id}  ${lease.agentId}  ${lease.credential}  ${ended}  ${uses}  — ${lease.reason}${lease.grantedBy ? ` (granted by ${lease.grantedBy})` : ''}`;
};

/**
 * `stratus lease grant | list | revoke` — the operator's hand on which
 * agent may use a fenced credential, for how long, how often, and why.
 *
 * On `fleet.db` directly rather than through a running daemon, unlike
 * `stratus grants`: the daemon holds no copy of a lease, it reads the row on
 * every use, and each change is one atomic statement — so a revoke here is
 * the very next use's answer whether or not a daemon is serving. What this
 * cannot show is a delegated sub-lease, which lives only in the daemon that
 * minted it; `GET /leases` lists those.
 */
export const runLease = async (
  command: ParsedLeaseCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const { SqliteLeaseStore } = await import('@stratusagent/gateway');
  const store = new SqliteLeaseStore(fleetDbPath(env), { stateHome: stratusHomePath(env) });
  const now = new Date();
  try {
    if (command.action === 'grant') {
      const ms = parseLeaseDuration(command.duration ?? '');
      if (ms === undefined) {
        writeLine(streams.stderr, `Error: invalid --for ${command.duration ?? ''}: use minutes, hours, or days, like 30m, 2h, or 7d.`);
        return 1;
      }
      const grant = {
        agentId: command.agentId ?? '',
        credential: command.credential ?? '',
        expiresAt: new Date(now.getTime() + ms).toISOString(),
        reason: command.reason ?? '',
        grantedBy: 'cli',
        ...(command.maxUses !== undefined ? { maxUses: command.maxUses } : {}),
      };
      try {
        validateLeaseGrant(grant, now);
      } catch (error) {
        writeLine(streams.stderr, `Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      // The roster the daemon serves, matched folded as identity is: a lease
      // for an id nothing runs as would report granted and sit in the record
      // as though it meant something, while the agent it was meant for stays
      // refused. The same check `POST /leases` makes.
      // Under the config the daemon was started with, when it was given one:
      // a default soul it names is served, and is on the roster, only there.
      const roster = await listAgentSummaries(env, () => {}, command.configPath);
      if (!roster.some((agent) => foldedAgentId(agent.id) === foldedAgentId(grant.agentId))) {
        writeLine(streams.stderr, `Error: no agent has id ${grant.agentId}, so a lease granted to it would never be used. \`stratus agents\` lists the roster.`);
        return 1;
      }
      const lease = store.grant(grant);
      if (command.format === 'json') {
        writeLine(streams.stdout, JSON.stringify({ lease: { ...lease, state: leaseState(lease, now) } }, null, 2));
        return 0;
      }
      writeLine(streams.stdout, `Granted ${lease.id}: ${lease.agentId} may use ${lease.credential} until ${lease.expiresAt}`
        + `${lease.maxUses !== undefined ? `, at most ${lease.maxUses} time(s)` : ''}.`);
      writeLine(streams.stdout, `It only matters while ${lease.credential} is listed in leases.credentials, and the soul still has to list it under credentials:.`);
      writeLine(streams.stdout, `End it early: stratus lease revoke ${lease.id}`);
      return 0;
    }

    if (command.action === 'revoke') {
      const lease = store.revoke(command.leaseId ?? '', 'cli');
      if (!lease) {
        writeLine(streams.stderr, `No active lease has id ${command.leaseId ?? ''}. \`stratus lease list --all\` shows every lease, ended ones included.`);
        return 1;
      }
      writeLine(streams.stdout, `Revoked ${lease.id}: ${lease.agentId} can no longer use ${lease.credential} under it.`);
      return 0;
    }

    const leases = store.list(command.agentId !== undefined ? { agentId: command.agentId } : {})
      .filter((lease) => command.all === true || leaseState(lease, now) === 'active');
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ leases: leases.map((lease) => ({ ...lease, state: leaseState(lease, now) })) }, null, 2));
      return 0;
    }
    if (leases.length === 0) {
      writeLine(streams.stdout, command.all === true ? 'No leases have been granted.' : 'No active leases. `stratus lease list --all` includes ended ones.');
      return 0;
    }
    for (const lease of leases) {
      writeLine(streams.stdout, describe(lease, now));
    }
    return 0;
  } finally {
    store.close();
  }
};
