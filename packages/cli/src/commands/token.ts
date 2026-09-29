import { apiTokensPath, createApiToken, loadApiTokens, revokeApiToken } from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedTokenCommand } from '../parse.ts';

/**
 * `stratus token create|list|revoke`: member tokens for the control API.
 *
 * These work on `~/.stratus/api-tokens.json` directly rather than through
 * the daemon, for the same reason `stratus credential` does: issuing access
 * is done at the machine, by whoever can already read the operator token.
 * A running daemon reads the file on every member request, so what these
 * change takes effect there without a restart.
 *
 * The token is printed once, on stdout and alone, so `stratus token create
 * ci > ci.token` captures exactly it; everything said about it goes to
 * stderr. Only its hash is stored, so there is no command that shows it
 * again.
 */
export const runToken = async (
  command: ParsedTokenCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  try {
    if (command.action === 'list') {
      const tokens = await loadApiTokens(env);
      if (command.format === 'json') {
        // Never the hash either: nothing reading this needs it, and an
        // audit listing is exactly the output that gets pasted around.
        writeLine(streams.stdout, JSON.stringify({
          tokens: tokens.map(({ id, name, role, createdAt }) => ({ id, name, role, createdAt })),
        }, null, 2));
        return 0;
      }
      if (tokens.length === 0) {
        writeLine(streams.stdout, `No member tokens in ${apiTokensPath(env)}. The operator token is ~/.stratus/gateway-token.`);
        writeLine(streams.stdout, 'Create one for a teammate or a tenant with `stratus token create <name>`.');
        return 0;
      }
      for (const token of tokens) {
        writeLine(streams.stdout, `${token.id}  ${token.name}  ${token.role}  created ${token.createdAt}`);
      }
      return 0;
    }

    const target = command.target ?? '';

    if (command.action === 'revoke') {
      const revoked = await revokeApiToken(env, target);
      if (!revoked) {
        writeLine(streams.stderr, `No member token has the id or name ${target}. \`stratus token list\` shows what exists.`);
        return 1;
      }
      writeLine(
        streams.stdout,
        `Revoked ${revoked.name} (${revoked.id}). A running daemon refuses it, and every dashboard session opened with it, from its next request.`,
      );
      return 0;
    }

    const { token, record } = await createApiToken(env, { name: target, role: command.role });
    writeLine(streams.stderr, `Created member token ${record.name} (${record.id}). This is the only time it is shown — only its hash is stored:`);
    writeLine(streams.stdout, token);
    writeLine(
      streams.stderr,
      'Send it as `Authorization: Bearer <token>` (or STRATUS_GATEWAY_TOKEN for the CLI). A member manages the roster, '
      + 'talks to agents, reads sessions and events, and answers approvals, but cannot change the config, the provider '
      + `sign-ins, or restart the daemon. Revoke it with \`stratus token revoke ${record.id}\`.`,
    );
    return 0;
  } catch (error) {
    writeLine(streams.stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
};
