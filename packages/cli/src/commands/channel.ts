import {
  credentialsPath,
  listChannelKinds,
  loadChannelTransportSecrets,
  removeChannelTransportSecrets,
  saveChannelTransportSecrets,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine, readSecretFromStdin } from '../io.ts';
import type { ParsedChannelCommand } from '../parse.ts';
import { createSetupPrompter } from '../prompter.ts';
import { rosterSoulsWithConfigured } from '../roster.ts';

/**
 * Slack's two tokens, the only shape the Slack adapter reads: an entry
 * missing either is skipped, so storing any other set under `slack` would
 * disconnect the agent while reporting success.
 */
const SLACK_KEYS = ['appToken', 'botToken'];

/**
 * `stratus channel set|list|remove`: a channel plugin's transport secrets,
 * under `channels.<kind>.<agentId>` in the credentials file — the path a
 * contributed channel reads them from (`transportSecrets(kind)`), and until
 * this the control API's route was the only way to write it.
 *
 * The rules `stratus credential` keeps, kept here: values come from a
 * no-echo prompt or stdin, never argv, where they would land in shell
 * history; nothing ever prints one back. These are gateway infrastructure
 * secrets, never resolved through an agent's credentials — an agent must
 * not read the tokens of the transport carrying it — so there is no soul
 * gate to mention, only the restart that makes a daemon read them.
 */
export const runChannel = async (
  command: ParsedChannelCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  if (command.action === 'list') {
    const kinds = (await listChannelKinds(env)).sort();
    let printed = false;
    for (const kind of kinds) {
      const bindings = Object.entries(await loadChannelTransportSecrets(env, kind)).sort(([a], [b]) => a.localeCompare(b));
      if (bindings.length === 0) {
        continue;
      }
      printed = true;
      writeLine(streams.stdout, `${kind}:`);
      for (const [agentId, secrets] of bindings) {
        writeLine(streams.stdout, `  ${agentId}  ${Object.keys(secrets).sort().join(', ')}`);
      }
    }
    if (!printed) {
      writeLine(streams.stdout, `No channel secrets stored in ${credentialsPath(env)}.`);
    } else {
      writeLine(streams.stdout, '');
      writeLine(streams.stdout, `Values are never printed. They live in ${credentialsPath(env)}, readable only by you.`);
    }
    // A channel can be bound with nothing stored at all — iMessage on this
    // Mac is a config block, not a token — so an empty list here is not
    // "no channels", and saying so saves someone a search.
    writeLine(streams.stdout, 'A channel bound by its plugin\'s config alone stores no secrets and is not listed; `stratus setup` shows both.');
    return 0;
  }

  const kind = command.kind ?? '';
  const agentId = command.agentId ?? '';

  if (command.action === 'remove') {
    if (!await removeChannelTransportSecrets(env, kind, agentId)) {
      writeLine(streams.stderr, `Nothing is stored for ${agentId} on ${kind}. \`stratus channel list\` shows what is.`);
      return 1;
    }
    writeLine(streams.stdout, `Removed ${agentId}'s ${kind} secrets. A running stratusd lets go of them at its next start: \`stratus restart\`.`);
    return 0;
  }

  const keys = command.keys.length > 0 ? command.keys : kind === 'slack' ? SLACK_KEYS : [];
  if (kind === 'slack' && (keys.length !== SLACK_KEYS.length || !SLACK_KEYS.every((key) => keys.includes(key)))) {
    writeLine(streams.stderr, `Slack stores exactly ${SLACK_KEYS.join(' and ')}; name both or neither.`);
    return 1;
  }

  // The adapter skips a binding whose id is not on the roster, so one
  // stored for a typo would sit there doing nothing. Checked only when the
  // roster loaded: a soul that fails to parse is a reason to fix the soul,
  // not to refuse the secret.
  const warnings: string[] = [];
  const roster = await rosterSoulsWithConfigured(env, (line) => warnings.push(line), { includeBuiltIn: true });
  if (roster.complete && !roster.entries.some((entry) => entry.soul.agent.id === agentId)) {
    writeLine(streams.stderr, `No agent ${agentId} is on the roster, so a ${kind} binding for it would never come online. \`stratus agents\` lists who is.`);
    return 1;
  }

  const secrets: Record<string, string> = {};
  const interactive = env.stdin === undefined && env.stdinStream === undefined && process.stdin.isTTY === true;
  if (interactive) {
    const prompter = createSetupPrompter(streams, env);
    try {
      for (const key of keys) {
        secrets[key] = await prompter.askSecret(`${key} (not echoed): `);
      }
    } finally {
      prompter.close();
    }
  } else {
    writeLine(
      streams.stderr,
      `Reading ${keys.join(', ')} from stdin, one per line in that order — never from the command line, where they would land in your shell history. Ctrl-D when done.`,
    );
    const arrived = env.stdin ?? await readSecretFromStdin(env.stdinStream ?? process.stdin);
    // One value per line, so the one trailing terminator `echo` or a
    // heredoc adds is not a line; a value is otherwise kept exactly as
    // typed, as `credential set` keeps it.
    const lines = arrived.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length !== keys.length) {
      writeLine(
        streams.stderr,
        `Expected ${keys.length} line(s) on stdin, one for each of ${keys.join(', ')}; got ${arrived.length === 0 ? 0 : lines.length}. Nothing was stored.`,
      );
      return 1;
    }
    keys.forEach((key, index) => {
      secrets[key] = lines[index]!;
    });
  }

  const empty = keys.find((key) => (secrets[key] ?? '').trim().length === 0);
  if (empty !== undefined) {
    writeLine(streams.stderr, `${empty} was empty, so nothing was stored. A binding missing a secret would never come online.`);
    return 1;
  }

  await saveChannelTransportSecrets(env, kind, agentId, secrets);
  writeLine(streams.stdout, `Stored ${keys.join(', ')} for ${agentId} on ${kind} in ${credentialsPath(env)} (readable only by you).`);
  writeLine(streams.stdout, 'This replaces whatever was stored for that agent on that channel. A running stratusd reads it at its next start: `stratus restart`.');
  return 0;
};
