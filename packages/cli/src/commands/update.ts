import { readFile, writeFile } from 'node:fs/promises';
import {
  newerStateMessage,
  pendingStateMigrations,
  readStateStamp,
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
import { serviceEnvFor } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine, pathExists } from '../io.ts';
import {
  defaultPackageVersionFetcher,
  compareVersions,
  defaultPackageInstaller,
  defaultInstalledVersionReader,
  CLI_VERSION,
  CLI_PACKAGE_NAME,
} from '../npm.ts';
import type { ParsedUpdateCommand } from '../parse.ts';
import {
  FIRST_PARTY_CAPABILITY_PACKAGES,
  FIRST_PARTY_COMPANION_PACKAGES,
} from '../plugin-catalog.ts';

/** One first-party package this machine has, and how it compares to the CLI's target. */
interface CompanionPackage {
  name: string;
  version: string;
  stale: boolean;
}

/**
 * The first-party packages installed beside the CLI, and whether each one
 * lags the version the CLI is heading for.
 *
 * The gap this closes: the CLI and its companions are separate global
 * installs, so upgrading `@stratusagent/cli` left every one of them at
 * whatever version was installed the day setup first ran. A Slack adapter
 * two releases behind the daemon loading it is not a configuration anyone
 * chose, and nothing reported it — `doctor` says "installed", which was
 * true of the stale one too.
 *
 * Read from each package's own manifest rather than asked of npm: the
 * question is what this machine has, one registry round trip per package
 * would answer a different one, and they ship in lockstep so the CLI's
 * target version is theirs.
 */
const readCompanions = async (
  target: string,
  env: CliEnvironment,
): Promise<CompanionPackage[]> => {
  const read = env.installedVersionReader ?? defaultInstalledVersionReader;
  const found: CompanionPackage[] = [];
  for (const name of [...FIRST_PARTY_COMPANION_PACKAGES, ...FIRST_PARTY_CAPABILITY_PACKAGES]) {
    const version = await read(name);
    if (version !== undefined) {
      found.push({ name, version, stale: compareVersions(target, version) > 0 });
    }
  }
  return found;
};

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
export const runUpdate = async (
  command: ParsedUpdateCommand,
  streams: CliStreams,
  env: CliEnvironment,
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

  if (stateNewer) {
    writeLine(streams.stderr, newerStateMessage(stamp.schemaVersion));
    return 1;
  }

  if (status?.installed && (status.runAtLogin === undefined || status.running === undefined)) {
    // The rewrite has to re-state the login setting and restore the prior
    // run state, and the manager could not say what either currently is.
    // Guessing would let a transient status failure convert a deliberate
    // --no-login install, or rewrite-and-stop a daemon that was actually
    // running — refuse instead, before anything has been stopped.
    writeLine(streams.stderr, `Not updating: whether stratusd ${status.running === undefined ? 'is running' : 'starts at login'} could not be determined (the service manager did not answer), and the unit rewrite would have to guess. Check \`stratus service status\` and retry.`);
    return 1;
  }

  const wasRunning = status?.running === true;
  if (wasRunning) {
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
  const upgrading = latest === undefined ? [] : [
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
    if (installed.ok) {
      // This process is still the old build; migrations the new version
      // adds run when it first starts — which the restart below is.
      out('Upgraded. Migrations the new version adds run on its first start.');
    } else {
      upgradeFailed = true;
      writeLine(streams.stderr, `npm install failed: ${installed.message || 'unknown error'} — continuing with migrations and the unit rewrite.`);
    }
  } else {
    out(latest === undefined
      ? 'Skipping the package upgrade — npm did not answer.'
      : 'Package already up to date.');
  }

  let applied: AppliedStateMigration[];
  try {
    applied = await runStateMigrations(env);
  } catch (error) {
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
