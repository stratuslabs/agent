import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  newerStateMessage,
  pendingStateMigrations,
  readStateStamp,
  applyPerAgentWorkspaces,
  workspaceRepairPending,
  runStateMigrations,
  STATE_SCHEMA_VERSION,
  type AppliedStateMigration,
} from '@stratusagent/state';
import {
  installService,
  readServiceCommand,
  readServiceStatus,
  serviceUnitPath,
  startService,
  stopService,
} from '../service.ts';
import { legacyDaemonServing, serviceEnvFor } from '../daemon.ts';
import { installedUnitConfigError } from './service.ts';
import type { CliStreams, CliEnvironment, UpdateResume } from '../environment.ts';
import { writeLine, pathExists } from '../io.ts';
import {
  defaultPackageVersionFetcher,
  compareVersions,
  defaultPackageInstaller,
  CLI_VERSION,
  CLI_PACKAGE_NAME,
} from '../npm.ts';
import type { ParsedUpdateCommand } from '../parse.ts';
import { readCompanions } from '../companions.ts';

/**
 * `stratus update` — the whole upgrade dance, in the order that cannot lose
 * data: stop the service (so no daemon holds the session database while
 * state migrates), upgrade the package, run pending migrations, rewrite the
 * service unit with current paths, restart.
 *
 * The unit rewrite is the step that repairs the failure nothing else
 * surfaces: the unit embeds absolute node and entrypoint paths (a service
 * manager loads no shell profile, so it must), and upgrading node — under
 * nvm, a whole new version directory — leaves the unit pointing at an
 * interpreter that no longer exists. The service stops working and nothing
 * says so; the agents just stop answering.
 *
 * Each step degrades independently: an unreachable npm skips the version
 * check and package upgrade but still migrates and rewrites the unit —
 * which is exactly the repair the offline case needs.
 */
/**
 * Hold the home for the duration of the migration, or say why we could not.
 *
 * `stratus update` stops the *managed* service, which is not the same
 * question as whether anything is serving: a daemon in a foreground
 * `stratus serve`, or under a supervisor this command knows nothing about,
 * leaves `readServiceStatus` with nothing to report and nothing to stop.
 * Asserting exclusivity there would move the session database and the grant
 * files out from under a daemon still writing them — losing the turns it
 * saves afterwards, and reviving the grants it revokes.
 *
 * So the same two checks `serve` uses decide it: the home claim, and the
 * probe for a daemon old enough to predate the claim. Failing either, the
 * marked migrations stay pending and the operator is told what to stop —
 * a deferral is recoverable, and moving live state is not.
 */
const claimExclusiveHome = async (
  env: CliEnvironment,
  gateway: typeof import('@stratusagent/gateway'),
): Promise<{ held: boolean; reason: string; release: () => void }> => {
  const { claimHome, HomeClaimedError } = gateway;
  let claim: { release: () => void };
  try {
    claim = claimHome(env);
  } catch (error) {
    if (error instanceof HomeClaimedError) {
      return { held: false, reason: 'its lock is held', release: () => {} };
    }
    throw error;
  }
  if (await legacyDaemonServing(env)) {
    claim.release();
    return { held: false, reason: 'a daemon predating the lock is still answering', release: () => {} };
  }
  return { held: true, reason: '', release: () => claim.release() };
};

/**
 * Set on the process `stratus update` hands its second half to, saying
 * whether the daemon was running before the first half stopped it. An
 * environment variable rather than a flag: it is a hand-off between two
 * builds of this command, not something an operator types.
 */
export const UPDATE_RESUME_ENV = 'STRATUS_UPDATE_RESUME';

const readResume = (env: CliEnvironment): UpdateResume | undefined => {
  const value = (env.processEnv ?? process.env)[UPDATE_RESUME_ENV];
  return value === 'running' || value === 'stopped' ? value : undefined;
};

/** What the second half sends up once it is running, so a crash before it is not mistaken for its answer. */
export const UPDATE_RESUMED_MESSAGE = 'stratus.update.resumed';

/**
 * Run `stratus update` again on the build npm just put on disk, and wait.
 *
 * The process that ran the install is the old build, and Node cannot swap
 * it out: everything already imported stays the old code in the module
 * cache, while anything imported for the first time is read from the new
 * files and resolves its own imports against that cache. A new module
 * asking an old one for an export it does not have fails the migration
 * ("does not provide an export named …") — 0.11.7's `FileLockHeldError`,
 * 0.11.8's `createPluginStateDirectories`. Preloading one module at a time
 * only fixes the import someone already tripped over; a fresh process has
 * nothing cached and runs the new build whole.
 *
 * Its exit code is the update's only once it has said it took over. A new
 * build that dies before that, on a missing entrypoint or a module that
 * throws as it loads, exits without ever reaching the recovery that
 * restarts the daemon, so it resolves `undefined` and this process
 * finishes the update itself instead.
 */
export const defaultUpdateContinuation = (
  env: CliEnvironment,
  entrypoint: string = (() => {
    const modulePath = fileURLToPath(import.meta.url);
    return path.join(path.dirname(modulePath), '..', `bin${path.extname(modulePath)}`);
  })(),
) => (resume: UpdateResume): Promise<number | undefined> =>
  new Promise((resolve) => {
    let resumed = false;
    const child = spawn(process.execPath, [...process.execArgv, entrypoint, 'update'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      cwd: env.cwd ?? process.cwd(),
      env: { ...(env.processEnv ?? process.env), [UPDATE_RESUME_ENV]: resume },
    });
    child.on('message', (message) => {
      if (message === UPDATE_RESUMED_MESSAGE) {
        resumed = true;
        // The channel would keep the child alive; it has said all it needs to.
        child.disconnect();
      }
    });
    child.once('error', () => resolve(undefined));
    child.once('exit', (code) => resolve(resumed ? code ?? 1 : undefined));
  });

/** Tell the first half this process has taken over the update. */
const announceResumed = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof process.send !== 'function' || !process.connected) {
      resolve();
      return;
    }
    process.send(UPDATE_RESUMED_MESSAGE, undefined, {}, () => resolve());
  });

export const runUpdate = async (
  command: ParsedUpdateCommand,
  streams: CliStreams,
  env: CliEnvironment,
): Promise<number> => {
  // Set when this process is the second half of an update an older build
  // began: the daemon is already stopped and the packages already
  // installed, so neither happens again.
  const resume = command.check ? undefined : readResume(env);
  if (resume === undefined) {
    return runUpdateSteps(command, streams, env, undefined);
  }
  // Once this process says it took over, its exit is the update's answer,
  // and the first half will not restart anything. So from here every way
  // out has to leave a daemon that was running running again — including a
  // throw from a version lookup, a status read, or a state file, none of
  // which have a recovery of their own. Starting a service that the steps
  // already restarted is harmless; leaving the fleet down is not.
  await announceResumed();
  try {
    return await runUpdateSteps(command, streams, env, resume);
  } catch (error) {
    writeLine(streams.stderr, `Update failed: ${error instanceof Error ? error.message : String(error)}`);
    if (resume === 'running') {
      const restarted = await startService(serviceEnvFor(env));
      for (const message of restarted.messages) {
        writeLine(restarted.ok ? streams.stdout : streams.stderr, message);
      }
      writeLine(streams.stderr, restarted.ok
        ? 'stratusd was restarted. Fix the failure and run `stratus update` again.'
        : 'stratusd could not be restarted either — bring it back with `stratus service start`.');
    }
    return 1;
  }
};

const runUpdateSteps = async (
  command: ParsedUpdateCommand,
  streams: CliStreams,
  env: CliEnvironment,
  resume: UpdateResume | undefined,
): Promise<number> => {
  const serviceEnv = serviceEnvFor(env);
  const out = (line: string): void => writeLine(streams.stdout, line);

  const latest = await (env.packageVersionFetcher ?? defaultPackageVersionFetcher)(CLI_PACKAGE_NAME);
  const upgradeAvailable = latest !== undefined && compareVersions(latest, CLI_VERSION) > 0;

  // A stamp from a newer build makes every later step wrong, not just the
  // migration one: this build would migrate — and stop the daemon to do it —
  // against a format it does not understand. Checked here, before anything
  // has a side effect.
  const stamp = await readStateStamp(env);
  const stateNewer = stamp.schemaVersion > STATE_SCHEMA_VERSION;

  const status = await readServiceStatus(serviceEnv).catch(() => undefined);
  const unit = status?.installed ? await readServiceCommand(serviceEnv) : undefined;
  const unitNotes: string[] = [];
  if (status?.installed && unit?.execPath !== undefined) {
    if (!(await pathExists(unit.execPath))) {
      unitNotes.push(`the unit's interpreter no longer exists: ${unit.execPath} — stratusd cannot start until the unit is rewritten`);
    } else if (unit.execPath !== process.execPath) {
      unitNotes.push(`the unit runs ${unit.execPath}; this shell runs ${process.execPath}`);
    }
    if (unit.scriptPath !== undefined && !(await pathExists(unit.scriptPath))) {
      unitNotes.push(`the unit's entrypoint no longer exists: ${unit.scriptPath}`);
    } else if (unit.scriptPath !== undefined && process.argv[1] !== undefined && unit.scriptPath !== process.argv[1]) {
      // A versioned package directory can keep the old file alive after an
      // upgrade — the daemon then runs the old CLI indefinitely with
      // nothing missing on disk to notice.
      unitNotes.push(`the unit runs entrypoint ${unit.scriptPath}; this shell runs ${process.argv[1]}`);
    }
  }

  const pending = await pendingStateMigrations(env);
  // The newer of what npm offers and what this build already is, never just
  // the registry's answer: a dist-tag rollback, a stale mirror, or a CLI
  // installed by explicit version all answer with something older, and a
  // companion matching *that* would read as current while the process
  // loading it is newer — the exact mismatch this exists to end. Held to
  // this build, which is also why the target needs no network to be right.
  const target = latest !== undefined && compareVersions(latest, CLI_VERSION) > 0
    ? latest
    : CLI_VERSION;
  // Against the version this run is heading for, not the one it is on: a
  // CLI already current still leaves a companion behind, which is the whole
  // case this reports.
  const companions = await readCompanions(target, env);
  const stale = companions.filter((entry) => entry.stale);

  out(`stratus ${CLI_VERSION}`);
  out(latest === undefined
    ? '  latest      unknown — npm did not answer'
    : `  latest      ${latest}${upgradeAvailable ? ' — update available' : ' — up to date'}`);
  out(`  state       schema ${stamp.schemaVersion}${stateNewer
    ? ` — written by a NEWER build than this one (which understands ${STATE_SCHEMA_VERSION})`
    : `, ${pending.length === 0 ? 'no pending migrations' : `${pending.length} pending migration${pending.length === 1 ? '' : 's'}`}`}`);
  out(`  service     ${status === undefined
    ? `no service manager for ${process.platform}`
    : status.installed
      ? (status.running === undefined ? 'installed, state unknown' : status.running ? 'installed, running' : 'installed, not running')
      : 'not installed'}`);
  for (const note of unitNotes) {
    out(`  unit        ${note}`);
  }
  if (companions.length > 0) {
    // A count and then only what would change, like every other line here:
    // this reports state, not an inventory — `stratus plugins` is the
    // command that lists what is installed.
    out(`  packages    ${companions.length} first-party alongside the CLI, ${stale.length === 0 ? 'none behind' : `${stale.length} behind`}`);
    for (const entry of stale) {
      out(`              ${entry.name} ${entry.version} → ${target}`);
    }
  }

  if (command.check) {
    for (const migration of pending) {
      out(`  pending     ${migration.id} — ${migration.description}`);
    }
    if (stateNewer) {
      out('This build cannot update that state — upgrade the package itself (`npm install -g @stratusagent/cli`).');
      return 1;
    }
    const actionable = upgradeAvailable || pending.length > 0 || unitNotes.length > 0 || stale.length > 0;
    out(actionable
      ? 'Run `stratus update` to apply the above.'
      : 'Nothing to do.');
    // Actionable exits 1, so a cron job or script can notice.
    return actionable ? 1 : 0;
  }

  // In the second half of an update, the first half already stopped the
  // daemon: a refusal here must bring it back, or the fleet stays down
  // over a check that changed nothing.
  const refuse = async (lines: string[]): Promise<number> => {
    for (const line of lines) {
      writeLine(streams.stderr, line);
    }
    if (resume === 'running') {
      const restarted = await startService(serviceEnv);
      for (const message of restarted.messages) {
        writeLine(restarted.ok ? streams.stdout : streams.stderr, message);
      }
      writeLine(streams.stderr, restarted.ok
        ? 'stratusd was restarted on its previous unit.'
        : 'stratusd could not be restarted either — bring it back with `stratus service start`.');
    }
    return 1;
  };

  if (stateNewer) {
    return refuse([newerStateMessage(stamp.schemaVersion)]);
  }

  if (status?.installed && (status.runAtLogin === undefined || status.running === undefined)) {
    // The rewrite has to re-state the login setting and restore the prior
    // run state, and the manager could not say what either currently is.
    // Guessing would let a transient status failure convert a deliberate
    // --no-login install, or rewrite-and-stop a daemon that was actually
    // running — refuse instead, before anything has been stopped.
    return refuse([`Not updating: whether stratusd ${status.running === undefined ? 'is running' : 'starts at login'} could not be determined (the service manager did not answer), and the unit rewrite would have to guess. Check \`stratus service status\` and retry.`]);
  }

  // Before anything is stopped: the update restarts the service, and a
  // daemon that then refuses its config would leave the fleet down with
  // the update reporting it running (see `installedUnitConfigError`).
  if (status?.installed) {
    const unitError = await installedUnitConfigError(env, serviceEnv);
    if (unitError) {
      return refuse([
        `Not updating: ${unitError.message}`,
        resume === undefined
          ? 'The updated daemon would refuse to start on it, so nothing was stopped. Fix the file and run `stratus update` again.'
          : 'The updated daemon would refuse to start on it. Fix the file and run `stratus update` again.',
      ]);
    }
  }

  // Loaded before npm replaces anything on disk. Everything this process
  // imported statically is the old build, held in the module cache; a
  // module first imported *after* the install is read from the new files,
  // and its own imports of a package already loaded resolve to the old
  // copy in that cache. 0.11.7's gateway imports `FileLockHeldError` from
  // `@stratusagent/state`, which a 0.11.6 process has loaded without it,
  // so every upgrade to 0.11.7 failed its migrations on a missing export.
  // Loaded here, the whole run stays the old build, as the line after the
  // install says it is. And before the stop, not just before the install:
  // a load that fails then leaves the daemon serving, where one failing
  // after the stop sat outside the recovery that restarts it.
  let gateway: typeof import('@stratusagent/gateway');
  try {
    gateway = await (env.gatewayLoader ?? (() => import('@stratusagent/gateway')))();
  } catch (error) {
    if (resume === undefined) {
      throw error;
    }
    return refuse([`Could not load the gateway: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const wasRunning = resume === undefined ? status?.running === true : resume === 'running';
  if (wasRunning && resume === undefined) {
    // No daemon may hold the session database while state migrates — this
    // bracket is the one place an update could otherwise lose data.
    out('Stopping stratusd for the update…');
    const stopped = await stopService(serviceEnv);
    for (const message of stopped.messages) {
      writeLine(stopped.ok ? streams.stdout : streams.stderr, message);
    }
    if (!stopped.ok) {
      writeLine(streams.stderr, 'Not updating while the daemon may still be running.');
      return 1;
    }
  }

  let upgradeFailed = false;
  // The CLI and every companion that lags it, in one npm call: they are
  // one release, and installing them separately leaves a window where the
  // daemon and the adapter it loads disagree about their own version.
  //
  // Nothing at all when the registry did not answer, companions included:
  // `@latest` cannot resolve without it, so the install would fail after
  // printing a line promising a version npm never confirmed. Staleness is
  // still *reported* offline — it is measured against this build, which
  // needs no network — so `--check` says what an online update would fix.
  const upgrading = latest === undefined || resume !== undefined ? [] : [
    ...(upgradeAvailable ? [`${CLI_PACKAGE_NAME}@latest`] : []),
    // `@latest` only where latest IS the target. Where this build is the
    // newer one, `@latest` would install the very version the target just
    // refused to be, so the companion is asked for by exact version — the
    // one this CLI shipped alongside.
    ...stale.map((entry) => `${entry.name}@${target === latest ? 'latest' : target}`),
  ];
  if (upgrading.length > 0) {
    if (upgradeAvailable) {
      out(`Upgrading ${CLI_PACKAGE_NAME} ${CLI_VERSION} → ${latest}…`);
    }
    for (const entry of stale) {
      out(`Upgrading ${entry.name} ${entry.version} → ${target}…`);
    }
    const installed = await (env.packageInstaller ?? defaultPackageInstaller)(upgrading);
    if (installed.ok && upgradeAvailable) {
      // This process is still the old build, so the rest of the update —
      // the migrations above all — runs in a fresh one on the new build.
      out('Upgraded. Continuing the update on the new build…');
      const code = await (env.updateContinuation ?? defaultUpdateContinuation(env))(wasRunning ? 'running' : 'stopped');
      if (code !== undefined) {
        return code;
      }
      // It never took over: it could not be started, or died loading.
      // Carry on here rather than leave a stopped daemon behind; this run
      // restarts it if its own migration fails.
      writeLine(streams.stderr, 'The new build did not take over the update — continuing on this one.');
    } else if (installed.ok) {
      // Only companions changed. This process's own modules are untouched,
      // so the rest of the update is safe to run here.
      out('Upgraded.');
    } else {
      upgradeFailed = true;
      writeLine(streams.stderr, `npm install failed: ${installed.message || 'unknown error'} — continuing with migrations and the unit rewrite.`);
    }
  } else if (resume === undefined) {
    out(latest === undefined
      ? 'Skipping the package upgrade — npm did not answer.'
      : 'Package already up to date.');
  }

  // Stopping the *managed* service is not the same as having the home to
  // ourselves, and the marked migrations are told which one this is. A
  // daemon running in a foreground `stratus serve`, or under a supervisor
  // this command knows nothing about, leaves `readServiceStatus` reporting
  // nothing to stop — and asserting exclusivity there would move the
  // session database and the grant files out from under a daemon still
  // writing them. So exclusivity is *established*, the way `serve`
  // establishes it, rather than assumed from the stop above.
  // Inside the recovery block, not before it. Establishing exclusivity can
  // fail on its own — a lock file that will not open, a home whose
  // permissions changed — and this command has already stopped the managed
  // service by the time it gets here. Thrown from outside, that left the
  // fleet down with no restart and no unit rewrite, over an error that had
  // nothing to do with the migrations.
  let claim: Awaited<ReturnType<typeof claimExclusiveHome>> | undefined;
  let applied: AppliedStateMigration[];
  try {
    claim = await claimExclusiveHome(env, gateway);
    if (!claim.held) {
      writeLine(
        streams.stderr,
        `Another stratusd is serving this home (${claim.reason}), so the per-agent state move is left pending — `
        + 'everything else still applied. Stop that daemon and run `stratus update` again to finish it.',
      );
    }
    applied = await runStateMigrations(env, claim.held ? { exclusive: true } : {});
    // And the workspace pass again, for the same reason `serve` runs it:
    // the schema stamp is not what makes that move safe, so a workspace an
    // older build left at the legacy path is folded whenever something
    // holding the home comes past. This is the remedy for a home that has
    // no daemon at all — `stratus run` takes no claim, so it cannot do this,
    // and `stratus doctor` names it and points here.
    if (claim.held && await workspaceRepairPending(env)) {
      const repaired = await applyPerAgentWorkspaces(env);
      if (repaired !== undefined) {
        writeLine(streams.stdout, `workspace layout: ${repaired}`);
      }
    }
  } catch (error) {
    claim?.release();
    // A daemon stopped for an update that then failed must not stay down:
    // the old unit is still in place (the rewrite has not happened), so
    // restarting restores the world the update found. The failure is still
    // a failure — but an offline fleet on top of it is not.
    writeLine(streams.stderr, `State migration failed: ${error instanceof Error ? error.message : String(error)}`);
    if (wasRunning) {
      const restarted = await startService(serviceEnv);
      for (const message of restarted.messages) {
        writeLine(restarted.ok ? streams.stdout : streams.stderr, message);
      }
      writeLine(streams.stderr, restarted.ok
        ? 'stratusd was restarted on its previous unit. Fix the migration failure and run `stratus update` again.'
        : 'stratusd could not be restarted either — bring it back with `stratus service start` once the failure is fixed.');
    }
    return 1;
  }
  // Before the restart below: the replacement claims the home next, and a
  // claim this process still held would refuse it. Idempotent, so the
  // failure path above having released it already costs nothing.
  claim.release();
  if (applied.length === 0) {
    out('No pending state migrations.');
  }
  for (const migration of applied) {
    out(`Migrated: ${migration.description}${migration.detail !== undefined ? ` — ${migration.detail}` : ''}`);
  }

  if (status?.installed) {
    out('Rewriting the service unit with current node and entrypoint paths…');
    // The rewrite overwrites the unit before it bootstraps, so a failure
    // in between must be able to put the old definition back — otherwise
    // a stopped daemon is left with neither unit to start from.
    const previousUnit = await readFile(serviceUnitPath(serviceEnv), 'utf8').catch(() => undefined);
    const install = await installService(
      // The unit's own working directory survives the rewrite: relative
      // paths in the pinned config (a `soul`) resolve against it, so a
      // rewrite run from some other directory must not substitute its own.
      unit?.workingDirectory !== undefined ? { ...serviceEnv, cwd: unit.workingDirectory } : serviceEnv,
      {
        ...(status.runAtLogin === false ? { runAtLogin: false } : {}),
        // The config the existing unit was pinned to survives the rewrite —
        // a unit rewritten onto a different roster is its own outage.
        ...(unit?.configPath !== undefined ? { configPath: unit.configPath } : {}),
      },
    );
    for (const message of install.messages) {
      writeLine(install.ok ? streams.stdout : streams.stderr, message);
    }
    if (!install.ok) {
      if (wasRunning) {
        // The fleet was up when the update began and must not stay down
        // over a failed rewrite: restore the previous unit definition and
        // start it again. The exit code stays 1 — the update failed — but
        // the world it found is put back.
        if (previousUnit !== undefined) {
          await writeFile(serviceUnitPath(serviceEnv), previousUnit, { mode: 0o644 }).catch((error: unknown) => {
            writeLine(streams.stderr, `Could not restore the previous unit either: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        const restarted = await startService(serviceEnv);
        for (const message of restarted.messages) {
          writeLine(restarted.ok ? streams.stdout : streams.stderr, message);
        }
        writeLine(streams.stderr, restarted.ok
          ? 'The unit rewrite failed, so stratusd was restarted on its previous unit. Fix the failure above and run `stratus update` again.'
          : 'The unit rewrite failed AND stratusd could not be restarted — bring it back with `stratus service start`, or `stratus service install` to rewrite the unit by hand.');
      }
      return 1;
    }
    if (!wasRunning) {
      // installService starts the daemon; a service that was deliberately
      // stopped before the update stays that way.
      const stopped = await stopService(serviceEnv);
      if (!stopped.ok) {
        // The update itself succeeded, but the user's prior state was not
        // restored: an intentionally stopped daemon is now running. That
        // is a failure a script must see, not a footnote.
        writeLine(streams.stderr, 'stratusd was not running before the update, and stopping it again failed — it is now RUNNING. Stop it with `stratus service stop`.');
        return 1;
      }
      out('stratusd was not running before the update, so it was left stopped.');
    }
  } else if (status !== undefined) {
    out('No service installed — nothing to rewrite. `stratus service install` sets one up.');
  }

  return upgradeFailed ? 1 : 0;
};
