import {
  appendCredentialAudit,
  bindCredentialEnv,
  credentialsPath,
  loadCredentialEnvBindings,
  loadNamedCredentials,
  quoteShellArg,
  removeNamedCredential,
  saveNamedCredentials,
  unbindCredentialEnv,
  type StateEnvironment,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine, readSecretFromStdin } from '../io.ts';
import type { ParsedCredentialCommand } from '../parse.ts';

/**
 * The audit line for a binding made on the machine. Written after the
 * change, like the gateway's, and warned about rather than undoing a
 * binding that already landed.
 */
const auditBinding = async (
  env: StateEnvironment,
  streams: CliStreams,
  entry: { action: 'bind' | 'unbind'; name: string; agentId: string; variable: string },
): Promise<void> => {
  try {
    await appendCredentialAudit(env, {
      action: entry.action,
      name: entry.name,
      agentId: entry.agentId,
      via: 'cli',
      env: entry.variable,
      bindingFor: entry.agentId,
    });
  } catch (error) {
    writeLine(streams.stderr, `The binding changed, but the audit line could not be written (${error instanceof Error ? error.message : String(error)}).`);
  }
};

/**
 * `stratus credential set|list|remove|env`: the place a named credential goes.
 *
 * A credential nobody can add is a credential nobody has, which is why this
 * exists at all — a search backend asks for `search.apiKey` and until now
 * there was nowhere to put one. Three rules it keeps, all of them
 * deliberate:
 *
 * The value is read from **stdin, never from a flag**. A secret in argv is
 * a secret in shell history and in every `ps` on the machine.
 *
 * Nothing here ever prints a value back. `list` reports names and which
 * agents have their own, the same posture the control API's credential read
 * already keeps.
 *
 * And storing one grants no agent anything: the agent's soul still has to
 * list the name under `credentials:`, which is the per-identity gate.
 */
export const runCredential = async (
  command: ParsedCredentialCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const named = await loadNamedCredentials(env);

  if (command.action === 'list') {
    const shared = Object.keys(named.shared).sort();
    const agents = Object.entries(named.agents).sort(([a], [b]) => a.localeCompare(b));
    const bindings = Object.entries(await loadCredentialEnvBindings(env)).sort(([a], [b]) => a.localeCompare(b));
    if (shared.length === 0 && agents.length === 0 && bindings.length === 0) {
      writeLine(streams.stdout, `No named credentials stored in ${credentialsPath(env)}.`);
      writeLine(streams.stdout, 'A search backend wants `stratus credential set search.apiKey`.');
      return 0;
    }
    if (shared.length > 0) {
      writeLine(streams.stdout, 'Shared with the whole fleet:');
      for (const name of shared) {
        writeLine(streams.stdout, `  ${name}`);
      }
    }
    for (const [agentId, entries] of agents) {
      writeLine(streams.stdout, `Only ${agentId}:`);
      for (const name of Object.keys(entries).sort()) {
        writeLine(streams.stdout, `  ${name}`);
      }
    }
    // Which keys each agent's shell commands can read, and as what: the
    // part of a key's reach that a soul's credentials: list doesn't show.
    for (const [agentId, variables] of bindings) {
      writeLine(streams.stdout, `${agentId}'s shell reads:`);
      for (const [variable, name] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
        writeLine(streams.stdout, `  ${variable} from ${name}`);
      }
    }
    // Names, never values — and say so, so nobody goes looking for a flag
    // that prints one.
    writeLine(streams.stdout, '');
    writeLine(streams.stdout, `Values are never printed. They live in ${credentialsPath(env)}, readable only by you.`);
    return 0;
  }

  const name = command.name ?? '';

  if (command.action === 'remove') {
    const scope = command.agentId;
    // The bindings that read it go in the same write (removeNamedCredential).
    if (!(await removeNamedCredential(env, { name, ...(scope !== undefined ? { agentId: scope } : {}) }))) {
      writeLine(
        streams.stderr,
        scope === undefined
          ? `No shared credential named ${name}. \`stratus credentials\` lists what is stored.`
          : `Agent ${scope} has no credential of its own named ${name}. \`stratus credentials\` lists what is stored.`,
      );
      return 1;
    }
    writeLine(streams.stdout, scope === undefined ? `Removed ${name}.` : `Removed ${name} for ${scope}.`);
    return 0;
  }

  if (command.action === 'env') {
    // The parser requires both for `env`.
    const agentId = command.agentId ?? '';
    const variable = command.env ?? '';
    if (command.remove === true) {
      const was = await unbindCredentialEnv(env, { agentId, variable });
      if (was === undefined) {
        writeLine(streams.stderr, `${agentId}'s shell has no credential bound to ${variable}. \`stratus credentials\` lists the bindings.`);
        return 1;
      }
      await auditBinding(env, streams, { action: 'unbind', name: was, agentId, variable });
      writeLine(streams.stdout, `${agentId}'s shell no longer reads ${was} as ${variable}, from its next command.`);
      return 0;
    }
    const was = await bindCredentialEnv(env, { agentId, variable, name });
    await auditBinding(env, streams, { action: 'bind', name, agentId, variable });
    writeLine(
      streams.stdout,
      `${agentId}'s shell commands read ${name} as ${variable} from their next command${was !== undefined && was !== name ? ` (it was ${was})` : ''}. No restart needed.`,
    );
    writeLine(streams.stdout, `Only while ${agentId}'s soul lists it under credentials: and a value is stored. Undo: stratus credential env ${name} ${variable} --agent ${quoteShellArg(agentId)} --remove`);
    return 0;
  }

  writeLine(
    streams.stderr,
    `Reading the value for ${name} from stdin — it is never taken from the command line, where it would land in your shell history. Ctrl-D when done.`,
  );
  const arrived = env.stdin ?? await readSecretFromStdin(env.stdinStream ?? process.stdin);
  // One trailing line terminator and nothing else. `echo "$KEY" |` appends a
  // newline that is not part of the key and `printf %s` appends nothing, so
  // both spellings have to work — while a key whose own value ends in a
  // space must survive either of them, which a blanket trim would not allow.
  const value = arrived.replace(/\r?\n$/, '');
  if (value.trim().length === 0) {
    writeLine(streams.stderr, `Nothing arrived on stdin, so ${name} was not stored. Pipe the value in: \`printf %s "$KEY" | stratus credential set ${name}\`.`);
    return 1;
  }

  if (command.agentId === undefined) {
    named.shared[name] = value;
  } else {
    named.agents[command.agentId] = { ...(named.agents[command.agentId] ?? {}), [name]: value };
  }
  await saveNamedCredentials(env, named);
  writeLine(
    streams.stdout,
    command.agentId === undefined
      ? `Stored ${name} in ${credentialsPath(env)} (readable only by you).`
      : `Stored ${name} for ${command.agentId} in ${credentialsPath(env)} (readable only by you). It outranks the shared entry for that agent.`,
  );
  if (command.env !== undefined && command.agentId !== undefined) {
    await bindCredentialEnv(env, { agentId: command.agentId, variable: command.env, name });
    await auditBinding(env, streams, { action: 'bind', name, agentId: command.agentId, variable: command.env });
    writeLine(streams.stdout, `${command.agentId}'s shell commands read it as ${command.env} from their next command. No restart needed.`);
  }
  // Storing grants nothing: the soul is the second gate, and an operator
  // who stops here gets "not allowed to access credential" on every call.
  writeLine(streams.stdout, `Each agent that may use it still needs \`credentials: [${name}]\` in its soul.`);
  return 0;
};
