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
  /** Directory the install ran from; becomes the unit's working directory. */
  cwd?: string;
  /** Absolute path of the node binary that should run the daemon. */
  execPath?: string;
  /** Absolute path of the CLI entrypoint (bin.js). */
  scriptPath?: string;
  /** Node flags the entrypoint needs. Defaults to this process's own. */
  execArgv?: string[];
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

export interface ServiceInstallOptions {
  runAtLogin?: boolean;
  /**
   * Config the daemon should load, absolute. The unit runs from the home
   * directory, so a relative path — or none, when setup wrote somewhere
   * other than the discovered location — would start the daemon on a
   * different config than the one just saved, with a different roster.
   */
  configPath?: string;
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
${definition.runAtLogin ? `  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
` : ''}  <key>WorkingDirectory</key>
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

/**
 * systemd expands `%` specifiers in unit values — including inside quoted
 * ExecStart arguments — so a path containing one (say a directory named
 * `100%`) would silently become something else entirely, or a nonexistent
 * executable. systemd.unit(5) spells a literal percent `%%`.
 */
const systemdValue = (value: string): string => value.replace(/%/g, '%%');

/**
 * ExecStart is a command line, so systemd expands `${VAR}` there on top of
 * the `%` specifiers — and JSON quoting does not disable it. A path
 * containing a literal `${HOME}` would reach the daemon as something else
 * entirely. systemd.service(5) spells a literal dollar `$$`.
 */
const systemdArgument = (value: string): string => systemdValue(value).replace(/\$/g, '$$$$');

export const systemdUnit = (definition: ServiceDefinition): string => `[Unit]
Description=Stratus Agent daemon (stratusd)
After=network-online.target

[Service]
Type=simple
ExecStart=${definition.argv.map((argument) => systemdArgument(JSON.stringify(argument))).join(' ')}
WorkingDirectory=${systemdValue(definition.workingDirectory)}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;

export const serviceDefinition = (
  env: ServiceEnvironment,
  runAtLogin: boolean,
  configPath?: string,
): ServiceDefinition => ({
  // The node binary and script are resolved from the running process, not
  // from PATH: a service manager starts with a minimal environment, and a
  // bare `stratus` would depend on a shell profile it never loads.
  argv: [
    env.execPath ?? process.execPath,
    // The flags this process needed to load its own entrypoint. Running
    // from a source checkout, that is --experimental-strip-types for a
    // .ts bin — drop it and the managed daemon cannot start at all while
    // the foreground command works. Inspector flags are filtered: they
    // would leave the service waiting on a debugger or holding a port.
    ...(env.execArgv ?? process.execArgv).filter((flag) => !flag.startsWith('--inspect')),
    env.scriptPath ?? process.argv[1] ?? 'stratus',
    'serve',
    // launchd redirects stdout to a plain file it holds open, and nothing
    // rotates it — a daemon printing an event line per Slack dispatch
    // would grow that file for its whole lifetime. Every one of those
    // lines is already in ~/.stratus/logs, which DOES rotate and is what
    // `stratus logs` reads, so the managed process keeps stdout to
    // lifecycle and warnings instead of duplicating the stream.
    '--no-events',
    ...(configPath ? ['--config', configPath] : []),
  ],
  logDir: path.join(homeOf(env), '.stratus', 'logs'),
  // Where the install ran, not the home directory: a config's `soul` (and
  // any other relative path in it) resolves against the process working
  // directory, so forcing home would make the service load a different —
  // or missing — soul than `stratus serve --config …` does from the same
  // project. Falls back to home when there is nothing better.
  workingDirectory: env.cwd ?? homeOf(env),
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

/** What `systemctl is-active` prints when it actually knows the answer. */
const KNOWN_ACTIVE_STATES = new Set([
  'active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance',
]);

/** What `systemctl is-enabled` prints when it actually knows the answer. */
const KNOWN_ENABLEMENT_STATES = new Set([
  'enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias',
  'masked', 'masked-runtime', 'static', 'indirect', 'disabled', 'generated', 'transient',
]);

export interface ServiceStatus {
  platform: ServicePlatform;
  /** A unit file exists on disk. */
  installed: boolean;
  /**
   * The service manager reports it running; undefined when the manager did
   * not answer (a timeout, a broken user bus). "No answer" is not "no":
   * reading it as stopped lets a transient failure justify actions — a
   * rewrite-and-boot-out during `stratus update`, say — that turn a
   * running daemon into an outage.
   */
  running: boolean | undefined;
  /** Starts automatically at login; undefined when the manager could not say. */
  runAtLogin: boolean | undefined;
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
  const run = runnerFor(env);
  // Whether a daemon is alive is the manager's answer, never the file's —
  // asked the same way whatever the unit file turned out to be. A manager
  // that did not answer is undefined, not false: only a recognizable "no"
  // (a job launchd cannot find, a systemd state word) reads as stopped.
  const isRunning = async (): Promise<boolean | undefined> => {
    if (platform === 'launchd') {
      const printed = await run('launchctl', ['print', `gui/${uidOf(env)}/${SERVICE_LABEL}`]);
      if (printed.code === 0) {
        // `state = running` appears only while the process is alive; a
        // loaded but stopped job prints `state = not running`.
        return /state\s*=\s*running/.test(printed.stdout);
      }
      return /could not find|no such/i.test(`${printed.stderr} ${printed.stdout}`) ? false : undefined;
    }
    const active = await run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
    const state = active.stdout.trim();
    if (KNOWN_ACTIVE_STATES.has(state)) {
      return state === 'active';
    }
    return undefined;
  };

  let contents: string;
  try {
    contents = await readFile(unitPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // The unit is there and we cannot read it. Reporting "not installed"
      // would hide a live daemon, and asserting it is stopped without
      // asking would do the same — so the manager still gets asked.
      return {
        platform,
        installed: true,
        running: await isRunning(),
        runAtLogin: undefined,
        unitPath,
        detail: `${unitPath} exists but could not be read (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    return { platform, installed: false, running: false, runAtLogin: false, unitPath };
  }
  // A unit on disk that the manager has not been told about is installed
  // but inert, so "installed" and "running" are asked separately.
  // launchd's answer is in the plist; systemd's is the enablement symlink,
  // which the unit file itself says nothing about — a unit installed with
  // --no-login would otherwise be reported as starting at login.
  let runAtLogin: boolean | undefined;
  if (platform === 'launchd') {
    runAtLogin = /<key>RunAtLoad<\/key>\s*<true\/>/.test(contents);
  } else {
    const enabled = await run('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT]);
    const state = enabled.stdout.trim();
    // is-enabled exits non-zero for "disabled", so the exit code alone
    // cannot separate a real answer from a broken user bus or a timeout.
    // Reading silence as "disabled" would let a transient failure turn an
    // enabled service into a --no-login one on the next save.
    runAtLogin = KNOWN_ENABLEMENT_STATES.has(state) ? state === 'enabled' : undefined;
  }
  return {
    platform,
    installed: true,
    running: await isRunning(),
    runAtLogin,
    unitPath,
  };
};

export interface ServiceActionResult {
  ok: boolean;
  /** Lines to show the user, in order. */
  messages: string[];
}

export interface ServiceCommandInfo {
  /** node, flags, entrypoint, subcommand — as the unit would run them. */
  argv: string[];
  /** The interpreter the unit names: argv[0]. */
  execPath?: string;
  /** The entrypoint: the first argv entry after the interpreter that is not a flag. */
  scriptPath?: string;
  /** The `--config` the unit pins the daemon to, if any. */
  configPath?: string;
  /**
   * The directory the unit runs the daemon from. Relative paths in the
   * pinned config (a `soul`, say) resolve against it, so a rewrite that
   * substituted the rewriting command's own cwd would restart the daemon
   * on different files.
   */
  workingDirectory?: string;
}

const unxml = (value: string): string => value
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/**
 * What the installed unit would actually run — parsed back out of the unit
 * file. This is how `stratus update` preserves an existing unit's `--config`
 * across a rewrite, and how it notices the failure that motivates the
 * rewrite in the first place: a unit whose absolute node path (say an nvm
 * version directory) no longer exists, which stops the service without
 * anything saying so.
 */
export const readServiceCommand = async (env: ServiceEnvironment = {}): Promise<ServiceCommandInfo | undefined> => {
  let contents: string;
  try {
    contents = await readFile(serviceUnitPath(env), 'utf8');
  } catch {
    return undefined;
  }
  let argv: string[] = [];
  let workingDirectory: string | undefined;
  if (servicePlatform(env) === 'launchd') {
    const section = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents);
    if (!section?.[1]) {
      return undefined;
    }
    argv = [...section[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1] ?? ''));
    const directory = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(contents);
    workingDirectory = directory?.[1] !== undefined ? unxml(directory[1]) : undefined;
  } else {
    const line = /^ExecStart=(.*)$/m.exec(contents);
    if (!line?.[1]) {
      return undefined;
    }
    // Written as systemdArgument(JSON.stringify(arg)): reverse the `%%`
    // and `$$` specifier escapes, then undo the JSON quoting.
    argv = (line[1].match(/"(?:[^"\\]|\\.)*"/g) ?? [])
      .map((token) => JSON.parse(token.replace(/\$\$/g, '$').replace(/%%/g, '%')) as string);
    const directory = /^WorkingDirectory=(.*)$/m.exec(contents);
    // Written with systemdValue (only `%` is escaped in unit values).
    workingDirectory = directory?.[1] !== undefined ? directory[1].replace(/%%/g, '%') : undefined;
  }
  if (argv.length === 0) {
    return undefined;
  }
  // The entrypoint is the argument just before `serve` — that is the shape
  // `serviceDefinition` writes: node, its flags, the script, the
  // subcommand. "First non-flag after node" is not good enough, because a
  // node option can take its value as a separate element (`--require
  // /path/preload.cjs`), and execArgv is copied into the unit verbatim.
  const serveIndex = argv.indexOf('serve');
  const scriptPath = serveIndex > 1
    ? argv[serveIndex - 1]
    : argv.slice(1).find((argument) => !argument.startsWith('-'));
  const configIndex = argv.indexOf('--config');
  const configPath = configIndex !== -1 ? argv[configIndex + 1] : undefined;
  return {
    argv,
    ...(argv[0] !== undefined ? { execPath: argv[0] } : {}),
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
  };
};

export const installService = async (
  env: ServiceEnvironment = {},
  options: ServiceInstallOptions = {},
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
  const definition = serviceDefinition(env, runAtLogin, options.configPath);
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
    if (!runAtLogin) {
      // RunAtLoad is false, so bootstrap alone loads the job without
      // starting it. KeepAlive is omitted in that case too: launchd's
      // SuccessfulExit condition implies RunAtLoad, which would restart
      // the job at every login and quietly contradict --no-login.
      const started = await run('launchctl', ['kickstart', `${domain}/${SERVICE_LABEL}`]);
      if (started.code !== 0) {
        return { ok: false, messages: [...messages, `launchctl kickstart failed: ${started.stderr.trim() || started.stdout.trim()}`] };
      }
      messages.push('stratusd is running. It will not start at login, and will not be restarted if it crashes.');
      return { ok: true, messages };
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
  if (!runAtLogin) {
    // A prior `install` left an enablement symlink; `start` alone would
    // leave it in place and the unit would keep starting at login. A
    // failure here has to stop us claiming otherwise.
    const disable = await run('systemctl', ['--user', 'disable', SYSTEMD_UNIT]);
    const notEnabled = /not (?:enabled|found)|No such file/i.test(`${disable.stderr} ${disable.stdout}`);
    if (disable.code !== 0 && !notEnabled) {
      return {
        ok: false,
        messages: [...messages, `Could not remove the login trigger: ${disable.stderr.trim() || disable.stdout.trim()}`],
      };
    }
  }
  const enable = await run('systemctl', ['--user', ...(runAtLogin ? ['enable', '--now'] : ['start']), SYSTEMD_UNIT]);
  if (enable.code !== 0) {
    return { ok: false, messages: [...messages, `systemctl failed: ${enable.stderr.trim()}`] };
  }
  // `enable --now` and `start` both no-op on an already-active unit, so a
  // rerun would report the new argv as installed while the old process —
  // with the old config path — kept running. launchd needs no equivalent:
  // bootout + bootstrap replaces the job outright.
  const restart = await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  if (restart.code !== 0) {
    return { ok: false, messages: [...messages, `systemctl restart failed: ${restart.stderr.trim() || restart.stdout.trim()}`] };
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
  const stopped = platform === 'launchd'
    ? await run('launchctl', ['bootout', `gui/${uidOf(env)}/${SERVICE_LABEL}`])
    : await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  // Removing the unit after a FAILED stop would strand a live daemon with
  // nothing left to stop it by, while telling the user it was shut down.
  // A job that was never loaded is not a failure — there is nothing to stop.
  const alreadyGone = /not (?:find|loaded)|No such process|could not find/i.test(`${stopped.stderr} ${stopped.stdout}`);
  if (stopped.code !== 0 && !alreadyGone) {
    return {
      ok: false,
      messages: [
        `Could not stop stratusd: ${stopped.stderr.trim() || stopped.stdout.trim()}`,
        `${unitPath} was left in place — removing it would leave the daemon running with nothing to stop it by.`,
      ],
    };
  }
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
  if (platform === 'systemd') {
    const result = await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
    return result.code === 0
      ? { ok: true, messages: ['stratusd started.'] }
      : { ok: false, messages: [`Could not start stratusd: ${result.stderr.trim() || result.stdout.trim()}`, 'Is it installed? Run `stratus service install`.'] };
  }

  // `stop` boots the job out of the domain entirely, and kickstart only
  // runs a job that is already there — so start after stop would fail
  // until something bootstrapped the plist again. Bootstrapping first
  // makes the documented stop/start pair work; it is expected to fail
  // when the job is still loaded, which is fine.
  const domain = `gui/${uidOf(env)}`;
  await run('launchctl', ['bootstrap', domain, serviceUnitPath(env)]);
  // -k restarts a job that is already running, which is what "start"
  // means after a config change.
  const result = await run('launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`]);
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
  // Asked before stopping, while the job is still there to ask about: a
  // unit installed with --no-login will NOT come back at the next login,
  // and telling someone it will leaves their agents offline indefinitely.
  const status = await readServiceStatus(env);
  const result = platform === 'launchd'
    ? await run('launchctl', ['bootout', `gui/${uidOf(env)}/${SERVICE_LABEL}`])
    : await run('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
  return result.code === 0
    ? {
        ok: true,
        messages: [status?.runAtLogin === undefined
          // The manager could not say, so neither can we — promising either
          // outcome is how agents end up offline while someone waits.
          ? 'stratusd stopped. Whether it starts again at login could not be determined — check `stratus service status`.'
          : status.runAtLogin
            ? 'stratusd stopped. It will start again at your next login unless you uninstall it.'
            : 'stratusd stopped. It will NOT start again on its own — run `stratus service start` when you want it back.'],
      }
    : { ok: false, messages: [`Could not stop stratusd: ${result.stderr.trim() || result.stdout.trim()}`] };
};
