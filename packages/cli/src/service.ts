import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Running `stratus serve` as a managed service.
 *
 * `serve` itself stays a plain foreground process — debuggable, drains on
 * SIGTERM, composes with any supervisor. Everything about surviving logout,
 * crashes, and reboots belongs here, in the platform's own service manager,
 * rather than in a hand-rolled daemonizer.
 */

export type ServicePlatform = 'launchd' | 'systemd';

/** Reverse-DNS on macOS, a plain unit name on Linux. */
export const SERVICE_LABEL = 'com.stratusagent.stratusd';
export const SYSTEMD_UNIT = 'stratusd.service';

export interface ServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a service-manager command. Injectable so tests never touch launchctl. */
export type ServiceRunner = (command: string, args: string[]) => Promise<ServiceCommandResult>;

export interface ServiceEnvironment {
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Absolute path of the node binary that should run the daemon. */
  execPath?: string;
  /** Absolute path of the CLI entrypoint (bin.js). */
  scriptPath?: string;
  /** User id, for launchctl's `gui/<uid>` domain. */
  uid?: number;
  run?: ServiceRunner;
}

export const servicePlatform = (env: ServiceEnvironment = {}): ServicePlatform | undefined => {
  const platform = env.platform ?? process.platform;
  if (platform === 'darwin') {
    return 'launchd';
  }
  if (platform === 'linux') {
    return 'systemd';
  }
  return undefined;
};

const homeOf = (env: ServiceEnvironment): string => env.homeDir ?? os.homedir();

export const serviceUnitPath = (env: ServiceEnvironment = {}): string =>
  servicePlatform(env) === 'launchd'
    ? path.join(homeOf(env), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    : path.join(homeOf(env), '.config', 'systemd', 'user', SYSTEMD_UNIT);

/** Escapes text for an XML property list value. */
const xml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export interface ServiceDefinition {
  /** node, then the CLI entrypoint, then the subcommand. */
  argv: string[];
  logDir: string;
  workingDirectory: string;
  /** Start automatically when the user logs in. */
  runAtLogin: boolean;
}

export const launchdPlist = (definition: ServiceDefinition): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${definition.argv.map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <${definition.runAtLogin ? 'true' : 'false'}/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(definition.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xml(path.join(definition.logDir, 'stratusd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(definition.logDir, 'stratusd.err.log'))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;

export const systemdUnit = (definition: ServiceDefinition): string => `[Unit]
Description=Stratus Agent daemon (stratusd)
After=network-online.target

[Service]
Type=simple
ExecStart=${definition.argv.map((argument) => JSON.stringify(argument)).join(' ')}
WorkingDirectory=${definition.workingDirectory}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;

export const serviceDefinition = (env: ServiceEnvironment, runAtLogin: boolean): ServiceDefinition => ({
  // The node binary and script are resolved from the running process, not
  // from PATH: a service manager starts with a minimal environment, and a
  // bare `stratus` would depend on a shell profile it never loads.
  argv: [env.execPath ?? process.execPath, env.scriptPath ?? process.argv[1] ?? 'stratus', 'serve'],
  logDir: path.join(homeOf(env), '.stratus', 'logs'),
  workingDirectory: homeOf(env),
  runAtLogin,
});

/** A service command that has not answered by now is not going to. */
export const SERVICE_COMMAND_TIMEOUT_MS = 15_000;

const defaultRunner: ServiceRunner = async (command, args) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ServiceCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // systemctl --user blocks indefinitely without a session bus, and
    // launchctl can wedge on a broken domain. Setup and `stratus service`
    // must report a problem rather than hang on someone's terminal.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 124, stdout, stderr: `${command} did not respond within ${SERVICE_COMMAND_TIMEOUT_MS / 1000}s` });
    }, SERVICE_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ code: 127, stdout, stderr: String(error) }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr }));
  });
};

const runnerFor = (env: ServiceEnvironment): ServiceRunner => env.run ?? defaultRunner;
const uidOf = (env: ServiceEnvironment): number => env.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);

export interface ServiceStatus {
  platform: ServicePlatform;
  /** A unit file exists on disk. */
  installed: boolean;
  /** The service manager reports it running. */
  running: boolean;
  /** Starts automatically at login. */
  runAtLogin: boolean;
  unitPath: string;
  /** Present when the platform's status command failed outright. */
  detail?: string;
}

export const readServiceStatus = async (env: ServiceEnvironment = {}): Promise<ServiceStatus | undefined> => {
  const platform = servicePlatform(env);
  if (!platform) {
    return undefined;
  }
  const unitPath = serviceUnitPath(env);
  const contents = await readFile(unitPath, 'utf8').catch(() => undefined);
  if (contents === undefined) {
    return { platform, installed: false, running: false, runAtLogin: false, unitPath };
  }
  // A unit on disk that the manager has not been told about is installed
  // but inert, so "installed" and "running" are asked separately.
  const runAtLogin = platform === 'launchd'
    ? /<key>RunAtLoad<\/key>\s*<true\/>/.test(contents)
    : true;
  const run = runnerFor(env);
  if (platform === 'launchd') {
    const result = await run('launchctl', ['print', `gui/${uidOf(env)}/${SERVICE_LABEL}`]);
    return {
      platform,
      installed: true,
      // `state = running` appears only while the process is alive; a loaded
      // but stopped job prints `state = not running`.
      running: result.code === 0 && /state\s*=\s*running/.test(result.stdout),
      runAtLogin,
      unitPath,
    };
  }
  const result = await run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
  return {
    platform,
    installed: true,
    running: result.stdout.trim() === 'active',
    runAtLogin,
    unitPath,
  };
};

export interface ServiceActionResult {
  ok: boolean;
  /** Lines to show the user, in order. */
  messages: string[];
}

export const installService = async (
  env: ServiceEnvironment = {},
  options: { runAtLogin?: boolean } = {},
): Promise<ServiceActionResult> => {
  const platform = servicePlatform(env);
  if (!platform) {
    return {
      ok: false,
      messages: [`No service manager for ${env.platform ?? process.platform}. Run \`stratus serve\` yourself, or supervise it however you prefer.`],
    };
  }
  const runAtLogin = options.runAtLogin ?? true;
  const unitPath = serviceUnitPath(env);
  const definition = serviceDefinition(env, runAtLogin);
  await mkdir(path.dirname(unitPath), { recursive: true });
  await mkdir(definition.logDir, { recursive: true, mode: 0o700 });
  await writeFile(
    unitPath,
    platform === 'launchd' ? launchdPlist(definition) : systemdUnit(definition),
    { mode: 0o644 },
  );

  const run = runnerFor(env);
  const messages = [`Wrote ${unitPath}`];
  if (platform === 'launchd') {
    const domain = `gui/${uidOf(env)}`;
    // Replacing an existing job: bootout first, or bootstrap refuses with
    // "service already loaded" and the new unit never takes effect.
    await run('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]);
    const result = await run('launchctl', ['bootstrap', domain, unitPath]);
    if (result.code !== 0) {
      return { ok: false, messages: [...messages, `launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim()}`] };
    }
    messages.push('stratusd is running, and will start again when you log in.');
    // Said plainly rather than left to be discovered: a LaunchAgent is
    // tied to a login session, so a headless machine that reboots without
    // one comes back with no agents running.
    messages.push('Note: a LaunchAgent starts at login, not at power-on. For a machine that should recover from a reboot unattended, turn on automatic login in System Settings.');
    return { ok: true, messages };
  }

  const reload = await run('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) {
    return { ok: false, messages: [...messages, `systemctl daemon-reload failed: ${reload.stderr.trim()}`] };
  }
  const enable = await run('systemctl', ['--user', ...(runAtLogin ? ['enable', '--now'] : ['start']), SYSTEMD_UNIT]);
  if (enable.code !== 0) {
    return { ok: false, messages: [...messages, `systemctl failed: ${enable.stderr.trim()}`] };
  }
  messages.push(runAtLogin
    ? 'stratusd is running, and will start again when you log in.'
    : 'stratusd is running. It will not start automatically.');
  if (runAtLogin) {
    messages.push('Note: a user service starts at login. `loginctl enable-linger` keeps it running on a machine you do not stay logged in to.');
  }
  return { ok: true, messages };
};

export const uninstallService = async (env: ServiceEnvironment = {}): Promise<ServiceActionResult> => {
  const platform = servicePlatform(env);
  if (!platform) {
    return { ok: false, messages: [`No service manager for ${env.platform ?? process.platform}.`] };
  }
  const unitPath = serviceUnitPath(env);
  const run = runnerFor(env);
  if (platform === 'launchd') {
    await run('launchctl', ['bootout', `gui/${uidOf(env)}/${SERVICE_LABEL}`]);
  } else {
    await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  }
  // Removed after the manager has been told to forget it, so a failed stop
  // never leaves a running job with no unit file to stop it by.
  await rm(unitPath, { force: true });
  if (platform === 'systemd') {
    await run('systemctl', ['--user', 'daemon-reload']);
  }
  return { ok: true, messages: [`Removed ${unitPath}. stratusd is stopped and will not start at login.`] };
};

export const startService = async (env: ServiceEnvironment = {}): Promise<ServiceActionResult> => {
  const platform = servicePlatform(env);
  if (!platform) {
    return { ok: false, messages: [`No service manager for ${env.platform ?? process.platform}.`] };
  }
  const run = runnerFor(env);
  const result = platform === 'launchd'
    // kickstart -k restarts a job that is already running, which is what
    // "start" means after a config change.
    ? await run('launchctl', ['kickstart', '-k', `gui/${uidOf(env)}/${SERVICE_LABEL}`])
    : await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  return result.code === 0
    ? { ok: true, messages: ['stratusd started.'] }
    : { ok: false, messages: [`Could not start stratusd: ${result.stderr.trim() || result.stdout.trim()}`, 'Is it installed? Run `stratus service install`.'] };
};

export const stopService = async (env: ServiceEnvironment = {}): Promise<ServiceActionResult> => {
  const platform = servicePlatform(env);
  if (!platform) {
    return { ok: false, messages: [`No service manager for ${env.platform ?? process.platform}.`] };
  }
  const run = runnerFor(env);
  const result = platform === 'launchd'
    ? await run('launchctl', ['bootout', `gui/${uidOf(env)}/${SERVICE_LABEL}`])
    : await run('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
  return result.code === 0
    ? { ok: true, messages: ['stratusd stopped. It will start again at login unless you uninstall it.'] }
    : { ok: false, messages: [`Could not stop stratusd: ${result.stderr.trim() || result.stdout.trim()}`] };
};
