import path from 'node:path';
import {
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  loadConfigFile,
  resolveConfigLocation,
} from '@stratusagent/state';
import {
  installService,
  readServiceStatus,
  startService,
  stopService,
  uninstallService,
} from '../service.ts';
import { serviceEnvFor } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedServiceCommand } from '../parse.ts';

/**
 * `stratus service` — run the daemon under launchd or systemd, so it
 * survives logout, crashes, and reboots. `serve` itself stays a plain
 * foreground process; this only tells the platform how to keep it up.
 */
export const runService = async (
  command: ParsedServiceCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const serviceEnv = serviceEnvFor(env);

  if (command.action === 'status') {
    const status = await readServiceStatus(serviceEnv);
    if (!status) {
      writeLine(streams.stdout, `No service manager for ${process.platform}. Run \`stratus serve\` yourself.`);
      return 1;
    }
    writeLine(streams.stdout, `stratusd  ${status.running === undefined
      ? 'state unknown — the service manager did not answer'
      : status.running ? 'running' : status.installed ? 'installed, not running' : 'not installed'}`);
    writeLine(streams.stdout, `  manager   ${status.platform}`);
    writeLine(streams.stdout, `  unit      ${status.unitPath}`);
    if (status.detail) {
      writeLine(streams.stdout, `  note      ${status.detail}`);
    }
    if (status.installed) {
      writeLine(streams.stdout, `  at login  ${status.runAtLogin === undefined
        ? 'unknown — the service manager did not answer'
        : status.runAtLogin ? 'yes' : 'no'}`);
    }
    writeLine(streams.stdout, status.installed
      ? '  logs      stratus logs -f'
      : '  install   stratus service install');
    return status.running === true ? 0 : 1;
  }

  // A service manager passes none of this shell's environment on, so a
  // config selected by STRATUS_CONFIG has to be baked into the unit
  // exactly as --config is. Without it the daemon rediscovers from the
  // install directory and can come up on a different roster entirely.
  const processEnv = readProcessEnv(env);
  const selectedConfig = command.configPath
    ?? readNonEmptyString(processEnv.STRATUS_CONFIG);
  if (command.action === 'install') {
    // A config the daemon cannot parse kills it during gateway.start(),
    // and the manager — having accepted the start — restarts it on a
    // loop. Better to refuse now, while there is someone reading stderr.
    // Without an explicit selection the unit carries no --config flag and
    // discovers from its working directory — the same directory this is
    // running in — so the discovered file has to be validated too, not
    // just an explicitly named one.
    let configToCheck: string | undefined;
    if (selectedConfig) {
      configToCheck = path.resolve(readWorkingDirectory(env), String(selectedConfig));
    } else {
      try {
        configToCheck = (await resolveConfigLocation({}, env))?.path;
      } catch (error) {
        // Discovery throws when a candidate exists but cannot be read.
        // Treating that as "no config" would install a daemon that hits
        // the same error on its first dispatch.
        writeLine(streams.stderr, `Not installing: ${error instanceof Error ? error.message : String(error)}`);
        writeLine(streams.stderr, 'The daemon would fail the same way on startup. Fix the file, or move it aside.');
        return 1;
      }
    }
    if (configToCheck) {
      try {
        await loadConfigFile(configToCheck);
      } catch (error) {
        writeLine(streams.stderr, `Not installing: ${configToCheck} cannot be used (${error instanceof Error ? error.message : String(error)}).`);
        writeLine(streams.stderr, 'The daemon would exit on startup and be restarted in a loop. Fix the file, or move it aside.');
        return 1;
      }
    }
  }

  const action = command.action === 'install'
    ? installService(serviceEnv, {
        ...(command.runAtLogin === false ? { runAtLogin: false } : {}),
        // Absolute: resolved against the directory the install ran in.
        ...(selectedConfig ? { configPath: path.resolve(readWorkingDirectory(env), String(selectedConfig)) } : {}),
      })
    : command.action === 'uninstall'
      ? uninstallService(serviceEnv)
      : command.action === 'start'
        ? startService(serviceEnv)
        : stopService(serviceEnv);

  const result = await action;
  for (const message of result.messages) {
    writeLine(result.ok ? streams.stdout : streams.stderr, message);
  }
  return result.ok ? 0 : 1;
};
