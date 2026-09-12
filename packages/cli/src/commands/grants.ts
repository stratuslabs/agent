import {
  createFileCommandWhitelist,
  describeAgentGrants,
  describeToolGrant,
  whitelistPathFor,
  type AgentGrantsListing,
  type ToolGrant,
} from '@stratusagent/permissions';
import { agentsDirPath, gatewayInfoPath } from '@stratusagent/state';
import { callRunningGateway, gatewayErrorMessage, readGatewayInfo } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedGrantsCommand } from '../parse.ts';

/** What `GET /agents/:id/grants` answers, and what the files answer when no daemon is serving. */
interface GrantsListing extends AgentGrantsListing {
  agentId: string;
  tools: Array<ToolGrant & { stale?: string }>;
}

/**
 * `stratus grants <agent>` and `stratus grants revoke <agent> …` — the
 * operator's view of what an agent may do unattended, and the way to take
 * one back.
 *
 * Through the running daemon when one says it is serving, and only then
 * from the files, because of the daemon's cache: the store reads each
 * agent's file once per process, so a revoke that edited the file behind a
 * live daemon would leave the policy honouring a grant the listing no
 * longer shows until the next restart. Going through `POST
 * /agents/:id/grants/revoke` is what makes a revoke the next call's answer.
 * A daemon that `gateway.json` names but that does not answer falls back
 * to the files with a warning saying exactly that, since the file is still
 * the truth for the next daemon to start.
 */
export const runGrants = async (
  command: ParsedGrantsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const agentId = command.agentId;
  const encoded = encodeURIComponent(agentId);
  const base = command.gateway
    ? command.gateway.replace(/\/+$/, '')
    : (await readGatewayInfo(env))?.url.replace(/\/+$/, '');

  const revocation = command.action === 'revoke'
    ? command.tool !== undefined
      ? { tool: command.tool }
      : command.scope !== undefined
        ? { scope: command.scope }
        : { origin: command.origin ?? '' }
    : undefined;
  const named = revocation?.tool ?? revocation?.scope ?? revocation?.origin ?? '';

  const fromFiles = async (): Promise<number> => {
    const store = createFileCommandWhitelist({
      directory: agentsDirPath(env),
      warn: (line) => writeLine(streams.stderr, `Warning: ${line}`),
    });
    if (revocation) {
      const revoked = revocation.tool !== undefined
        ? await store.forgetTool(agentId, revocation.tool)
        : revocation.scope !== undefined
          ? await store.forgetScope(agentId, revocation.scope)
          : await store.forgetOrigin(agentId, revocation.origin ?? '');
      return reportRevocation(revoked);
    }
    const listing: GrantsListing = { agentId, ...describeAgentGrants(await store.grantsFor(agentId)) };
    return render(listing, `${whitelistPathFor(agentsDirPath(env), agentId)}`);
  };

  const reportRevocation = (revoked: boolean): number => {
    if (!revoked) {
      writeLine(streams.stderr, `${agentId} has no such grant. \`stratus grants ${agentId}\` lists what exists.`);
      return 1;
    }
    writeLine(streams.stdout, `Revoked ${named} for ${agentId}.`);
    return 0;
  };

  const render = (listing: GrantsListing, source: string): number => {
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ ...listing, source }, null, 2));
      return 0;
    }
    const total = listing.tools.length + listing.scopes.length + listing.origins.length;
    if (total === 0) {
      writeLine(streams.stdout, `${agentId} has no standing grants beyond the built-in safe list (${source}).`);
      writeLine(streams.stdout, 'An "always allow" answered on one of its gated calls creates one.');
      return 0;
    }
    writeLine(streams.stdout, `${agentId} may do this unattended, beyond the built-in safe list (${source}):`);
    if (listing.tools.length > 0) {
      writeLine(streams.stdout, '  tools');
      for (const grant of listing.tools) {
        const by = grant.grantedBy ? ` by ${grant.grantedBy}` : '';
        const stale = grant.stale ? `  — stale: ${grant.stale}` : '';
        writeLine(streams.stdout, `    ${describeToolGrant(grant)}  (granted ${grant.grantedAt}${by})${stale}`);
      }
    }
    if (listing.scopes.length > 0) {
      writeLine(streams.stdout, '  commands');
      for (const row of listing.scopes) {
        writeLine(streams.stdout, `    ${row.description}`);
      }
    }
    if (listing.origins.length > 0) {
      writeLine(streams.stdout, '  sites');
      for (const row of listing.origins) {
        writeLine(streams.stdout, `    ${row.origin}`);
      }
    }
    writeLine(streams.stdout, `Take one back: stratus grants revoke ${agentId} --tool <name> | --scope "<command>" | --origin <origin>`);
    return 0;
  };

  if (!base) {
    return fromFiles();
  }

  let response: Response;
  try {
    response = revocation
      ? await callRunningGateway(env, command, base, `/api/v1/agents/${encoded}/grants/revoke`, revocation)
      : await callRunningGateway(env, command, base, `/api/v1/agents/${encoded}/grants`, undefined, 'GET');
  } catch (error) {
    if (command.gateway) {
      throw error;
    }
    // Named by the file, not answering: a daemon that crashed leaves the
    // file behind. The files are still the truth for the next one to
    // start, so act on them — and say so, because if a daemon *is* alive
    // behind a broken API it keeps its cached view until it restarts.
    writeLine(
      streams.stderr,
      `Warning: ${gatewayInfoPath(env)} names a daemon at ${base}, but it did not answer `
      + `(${error instanceof Error ? error.message : String(error)}). `
      + `${revocation ? 'Revoking in' : 'Reading'} ${whitelistPathFor(agentsDirPath(env), agentId)} instead; `
      + 'a daemon that is running will not notice until it restarts.',
    );
    return fromFiles();
  }
  if (response.status === 404 && revocation) {
    return reportRevocation(false);
  }
  if (!response.ok) {
    writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
    return 1;
  }
  if (revocation) {
    return reportRevocation(true);
  }
  return render(await response.json() as GrantsListing, `from the daemon at ${base}`);
};
