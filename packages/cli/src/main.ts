import { redactAnthropicRawTurns } from '@stratusagent/provider-anthropic';
import {
  newerStateMessage,
  readStateStamp,
  runStateMigrations,
  STATE_SCHEMA_VERSION,
} from '@stratusagent/state';
import { runAgentNew } from './commands/agent-new.ts';
import { runAgents } from './commands/agents.ts';
import { runChat } from './commands/chat.ts';
import { runCredential } from './commands/credential.ts';
import { runDashboard } from './commands/dashboard.ts';
import { runDoctor } from './commands/doctor.ts';
import { runLogs } from './commands/logs.ts';
import { runMemory } from './commands/memory.ts';
import { runRestart } from './commands/restart.ts';
import { runSchedules } from './commands/schedules.ts';
import { runServe } from './commands/serve.ts';
import { runService } from './commands/service.ts';
import { runSessionRollover } from './commands/session.ts';
import { runSetup } from './commands/setup.ts';
import { runSkillAdd, runSkillValidate, runSkillReload, runSkills } from './commands/skills.ts';
import { runUpdate } from './commands/update.ts';
import type { CliStreams, CliEnvironment } from './environment.ts';
import { HELP_TEXT } from './help.ts';
import { writeLine, readPromptFromStdin } from './io.ts';
import { parseCommand } from './parse.ts';
import {
  resolveRuntimeConfig,
  warnOnCredentialOverride,
  runSingleLoop,
  printSessionSummary,
  formatRuntimeBanner,
} from './runtime.ts';

export interface CliRunOptions {
  argv: string[];
  streams?: CliStreams;
  env?: CliEnvironment;
}

export const runCli = async ({ argv, streams = process, env = {} }: CliRunOptions): Promise<number> => {
  try {
    const resolvedEnv = argv.includes('--stdin') && env.stdin === undefined
      ? {
          ...env,
          stdin: await readPromptFromStdin(env.stdinStream ?? process.stdin),
        }
      : env;

    const command = parseCommand(argv, resolvedEnv);

    if (command.command === 'help') {
      writeLine(streams.stdout, HELP_TEXT);
      return 0;
    }

    // Migrations run on first use of a newer build — every command, every
    // install path — not only via `stratus update`: state that migrates
    // only sometimes is worse than state that never migrates, because the
    // two populations diverge silently. `update` is excluded because it
    // owns the migration step at its own place in the upgrade sequence
    // (after the service stop and the package upgrade), and `--check` has
    // to be able to report what is pending rather than having just done it.
    if (command.command !== 'update') {
      const stamp = await readStateStamp(resolvedEnv);
      const writesState = command.command === 'serve'
        || command.command === 'setup'
        || command.command === 'chat'
        || command.command === 'run'
        || command.command === 'skill-add'
        || command.command === 'dashboard'
        || (command.command === 'credential' && command.action !== 'list')
        || (command.command === 'schedules' && command.action === 'cancel')
        || (command.command === 'memory' && command.action === 'reassert')
        || command.command === 'session'
        || (command.command === 'service' && (command.action === 'install' || command.action === 'start'));
      if (stamp.schemaVersion > STATE_SCHEMA_VERSION) {
        // Anything that writes under ~/.stratus refuses, not only the
        // daemon: a downgraded build's setup, chat, or run can discard
        // fields and invariants the newer format relies on — the exact
        // hazard the stamp exists to close. Read-only commands warn and
        // continue, because reading logs or the roster is how someone
        // diagnoses their way OUT of this state; so do `service stop`,
        // `status`, and `uninstall`, for the same reason. (`agent new`
        // only prints an identity — it writes nothing.)
        if (writesState) {
          writeLine(streams.stderr, newerStateMessage(stamp.schemaVersion));
          writeLine(streams.stderr, `Refusing \`stratus ${command.command}\` — it writes state the newer format owns. Read-only commands (logs, agents, doctor, service status/stop) still work.`);
          return 1;
        }
        writeLine(streams.stderr, `Warning: ${newerStateMessage(stamp.schemaVersion)}`);
      } else {
        try {
          for (const migration of await runStateMigrations(resolvedEnv)) {
            if (migration.detail !== undefined) {
              writeLine(streams.stderr, `state migration ${migration.id}: ${migration.detail}`);
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // A command that writes state must not run on a home whose stamp
          // could not be written: the labels it would persist are what the
          // stamp protects, and a stamp still reading the old schema lets a
          // downgraded build in afterwards to read an `external` fact as
          // ordinary memory — the exact hole the stamp closes. A read-only
          // command warns and continues, because reading is how someone
          // diagnoses their way out; silence here is how the migrated and
          // unmigrated populations diverge.
          if (writesState) {
            writeLine(streams.stderr, `State migration failed (${reason}).`);
            writeLine(streams.stderr, `Refusing \`stratus ${command.command}\` — it writes state the migration stamps. Fix ~/.stratus (is state.json writable?) or run \`stratus update\`; read-only commands (logs, agents, doctor, memory list, service status/stop) still work.`);
            return 1;
          }
          writeLine(streams.stderr, `Warning: state migration failed (${reason}). Continuing on unmigrated state — \`stratus update\` retries it.`);
        }
      }
    }

    // Every handler is awaited, never bare-returned: a bare `return
    // promise` inside try/catch settles the async function before the
    // catch can see it, so a command that fails at runtime — a gateway
    // that cannot open its store, a missing credential — would escape as
    // a raw rejection instead of the error line and exit code below.
    if (command.command === 'agent-new') {
      return await runAgentNew(command, streams, resolvedEnv);
    }

    if (command.command === 'agents') {
      return await runAgents(command, streams, resolvedEnv);
    }

    if (command.command === 'skill-add') {
      return await runSkillAdd(command, streams, resolvedEnv);
    }

    if (command.command === 'skill-validate') {
      return await runSkillValidate(command, streams, resolvedEnv);
    }

    if (command.command === 'skills') {
      return await runSkills(streams, resolvedEnv);
    }

    if (command.command === 'credential') {
      return await runCredential(command, streams, resolvedEnv);
    }

    if (command.command === 'skill-reload') {
      return await runSkillReload(command, streams, resolvedEnv);
    }

    if (command.command === 'restart') {
      return await runRestart(command, streams, resolvedEnv);
    }

    if (command.command === 'schedules') {
      return await runSchedules(command, streams, resolvedEnv);
    }

    if (command.command === 'memory') {
      return await runMemory(command, streams, resolvedEnv);
    }

    if (command.command === 'session') {
      return await runSessionRollover(command, streams, resolvedEnv);
    }

    if (command.command === 'doctor') {
      return await runDoctor(command, streams, resolvedEnv);
    }

    if (command.command === 'logs') {
      return await runLogs(command, streams, resolvedEnv);
    }

    if (command.command === 'service') {
      return await runService(command, streams, resolvedEnv);
    }

    if (command.command === 'update') {
      return await runUpdate(command, streams, resolvedEnv);
    }

    if (command.command === 'chat') {
      return await runChat(command, streams, resolvedEnv);
    }

    if (command.command === 'setup') {
      return await runSetup(command, streams, resolvedEnv);
    }

    if (command.command === 'dashboard') {
      return await runDashboard(command, streams, resolvedEnv);
    }

    if (command.command === 'serve') {
      return await runServe(command, streams, resolvedEnv);
    }

    const runtime = await resolveRuntimeConfig(command, resolvedEnv);
    await warnOnCredentialOverride(runtime, streams, resolvedEnv);

    if (command.format === 'text') {
      writeLine(streams.stdout, formatRuntimeBanner(runtime));
    }

    const session = await runSingleLoop(command.prompt, streams, {
      events: command.events && command.format === 'text',
      runtime,
      approvals: command.approvals,
      ...(command.maxTurns !== undefined ? { maxTurns: command.maxTurns } : {}),
      ...(command.configPath ? { configPath: command.configPath } : {}),
      env: resolvedEnv,
    });

    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        provider: runtime.provider,
        // Replay state (Claude's raw thinking turns) stays in the stored
        // session but never in user-facing output.
        session: redactAnthropicRawTurns(session),
      }, null, 2));
      return 0;
    }

    printSessionSummary(session, streams);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(streams.stderr, `Error: ${message}`);
    writeLine(streams.stderr, '');
    writeLine(streams.stderr, HELP_TEXT);
    return 1;
  }
};
