import {
  credentialsPath,
  hasAgentSignInEntry,
  loadAgentSignIns,
  removeAgentSignIn,
  saveAgentSignIn,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine, readSecretFromStdin } from '../io.ts';
import type { ParsedSignInCommand } from '../parse.ts';
import { createSetupPrompter } from '../prompter.ts';
import { rosterSoulsWithConfigured } from '../roster.ts';

/**
 * `stratus signin set|list|remove`: one agent's own provider sign-in, under
 * `agentSignIns.<agentId>.anthropic` in the credentials file — a second
 * Claude subscription for one agent while the rest of the fleet stays on
 * the shared sign-in `stratus setup` stores.
 *
 * The rules `stratus credential` and `stratus channel` keep, kept here: the
 * token comes from a no-echo prompt or stdin, never argv; nothing prints it
 * back. And it is not a named credential: no soul lists it and no tool can
 * resolve it, because it is the account the agent's model calls bill to,
 * not a capability the agent holds.
 *
 * A running daemon re-reads the file on every turn, so none of this needs a
 * restart: the agent's next turn runs on what is stored then.
 */
export const runSignIn = async (
  command: ParsedSignInCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  if (command.action === 'list') {
    const agents = Object.keys(await loadAgentSignIns(env)).sort();
    if (agents.length === 0) {
      writeLine(streams.stdout, 'No agent has a sign-in of its own; every agent uses the shared sign-in from `stratus setup`.');
      return 0;
    }
    writeLine(streams.stdout, 'Agents with their own Claude sign-in (everyone else uses the shared one):');
    for (const agentId of agents) {
      writeLine(streams.stdout, `  ${agentId}  anthropic`);
    }
    writeLine(streams.stdout, '');
    writeLine(streams.stdout, `Tokens are never printed. They live in ${credentialsPath(env)}, readable only by you.`);
    return 0;
  }

  const agentId = command.agentId ?? '';
  const provider = command.provider ?? 'anthropic';

  if (command.action === 'remove') {
    if (!await removeAgentSignIn(env, agentId, provider)) {
      writeLine(streams.stderr, `${agentId} has no sign-in of its own. \`stratus signin list\` shows who does.`);
      return 1;
    }
    writeLine(streams.stdout, `Removed ${agentId}'s own Claude sign-in. Its next turn runs on the shared sign-in; a turn already running finishes on the old one.`);
    return 0;
  }

  // A token stored under an id nobody has would bill nothing and fail
  // nothing, so a typo would look like it worked. Checked only when the
  // roster loaded, as `stratus channel set` does.
  const warnings: string[] = [];
  const roster = await rosterSoulsWithConfigured(env, (line) => warnings.push(line), { includeBuiltIn: true });
  if (roster.complete && !roster.entries.some((entry) => entry.soul.agent.id === agentId)) {
    writeLine(streams.stderr, `No agent ${agentId} is on the roster, so a sign-in stored for it would never be used. \`stratus agents\` lists who is.`);
    return 1;
  }

  let value: string;
  const interactive = env.stdin === undefined && env.stdinStream === undefined && process.stdin.isTTY === true;
  if (interactive) {
    writeLine(streams.stdout, 'Run `claude setup-token` signed in to the subscription this agent should use, then paste the token.');
    const prompter = createSetupPrompter(streams, env);
    try {
      value = await prompter.askSecret(`Setup token for ${agentId} (not echoed): `);
    } finally {
      prompter.close();
    }
  } else {
    writeLine(
      streams.stderr,
      `Reading ${agentId}'s setup token from stdin — never from the command line, where it would land in your shell history. Ctrl-D when done.`,
    );
    const arrived = env.stdin ?? await readSecretFromStdin(env.stdinStream ?? process.stdin);
    value = arrived.replace(/\r?\n$/, '');
  }
  value = value.trim();

  if (value.length === 0) {
    writeLine(streams.stderr, `Nothing arrived, so ${agentId}'s sign-in was not changed.`);
    return 1;
  }
  // An API key here would be sent as a subscription token and refused on
  // every turn; saying so now beats an authentication failure in Slack.
  if (/^sk-ant-api/.test(value)) {
    writeLine(streams.stderr, 'That is an Anthropic API key, not a setup token. Run `claude setup-token` and paste what it prints. Nothing was stored.');
    return 1;
  }

  const replacing = await hasAgentSignInEntry(env, agentId, provider);
  await saveAgentSignIn(env, agentId, provider, { type: 'oauth_token', value });
  writeLine(
    streams.stdout,
    `${replacing ? 'Replaced' : 'Stored'} ${agentId}'s own Claude sign-in in ${credentialsPath(env)} (readable only by you). `
    + 'It outranks the shared sign-in for that agent only.',
  );
  writeLine(
    streams.stdout,
    `A running stratusd uses it from ${agentId}'s next turn, no restart. A turn already running finishes on the sign-in it started with. `
    + `Undo with \`stratus signin remove anthropic --agent ${agentId}\`.`,
  );
  return 0;
};
