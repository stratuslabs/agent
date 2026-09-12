import type { StratusConfigFile } from '@stratusagent/state';
import type { ServiceRunner } from './service.ts';

export interface CliStreams {
  stdout: Pick<typeof process.stdout, 'write'>;
  stderr: Pick<typeof process.stderr, 'write'>;
}

export interface CliEnvironment {
  stdin?: string;
  stdinStream?: NodeJS.ReadableStream;
  approvalInput?: NodeJS.ReadableStream;
  /**
   * Whether a person is at a terminal, for the approval default. Read from
   * `process.stdin.isTTY` when absent; injectable because a test cannot
   * make its stdin one.
   */
  terminal?: boolean;
  setupInput?: NodeJS.ReadableStream;
  templateInput?: NodeJS.ReadableStream;
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Home directory override (tests). Defaults to os.homedir(). */
  homeDir?: string;
  fetch?: typeof fetch;
  openExternal?: (url: string) => Promise<void> | void;
  dashboardAutoShutdownMs?: number;
  /** Shuts down `stratus serve` the way SIGTERM would (tests). */
  shutdownSignal?: AbortSignal;
  /**
   * Starts the fresh daemon an announced restart asks for and resolves
   * with its exit code. Injected so tests never spawn a process; the
   * default runs this CLI's own entrypoint with the serve arguments given.
   */
  serveRespawn?: (argv: string[], handoff: RestartHandoff) => Promise<RespawnResult>;
  /**
   * The link between a supervised daemon and its supervisor (tests): what
   * the daemon sends up — the port it bound, the dashboard sessions it
   * hands on — and what it receives. The default is the IPC channel a
   * supervisor opens when it spawns a daemon, and does nothing where
   * there is none.
   */
  supervisorLink?: SupervisorLink;
  /** Ends the process at once (tests). Default `process.exit`. */
  exitProcess?: (code: number) => void;
  /** Runs launchctl/systemctl. Injected so tests never touch the real one. */
  serviceRunner?: ServiceRunner;
  /** Service-manager platform override (tests) — which unit format and manager commands apply. */
  servicePlatform?: NodeJS.Platform;
  /** Reports whether an optional package is installed. Injected so tests do not assert on their own node_modules. */
  packageResolver?: PackageResolver;
  /** Installs optional packages. Injected so tests never run npm. */
  packageInstaller?: PackageInstaller;
  /** Looks up a package's latest published version. Injected so tests never ask npm. */
  packageVersionFetcher?: PackageVersionFetcher;
}

/**
 * A dashboard session as it crosses the restart hand-off: structurally the
 * control API's `DashboardSession`, declared here rather than imported.
 * That package is an optional peer, and a type import of it is kept in
 * this package's declarations — every TypeScript consumer of the CLI would
 * then need the optional package installed just to type-check.
 */
export interface DashboardSession {
  id: string;
  /** Epoch milliseconds; a handed session keeps the expiry it was minted with. */
  expiresAt: number;
  /** A fingerprint of the bearer token it was minted under; the replacement adopts it only under the same one. */
  vouchedBy: string;
}

/** What a daemon and its supervisor say to each other. See SupervisorLink. */
export type SupervisorMessage =
  | { type: 'stratusd.bound-api-port'; port: number }
  | { type: 'stratusd.sessions'; sessions: DashboardSession[] };

/** One end of the daemon–supervisor channel. */
export interface SupervisorLink {
  send(message: SupervisorMessage): void;
  receive(handler: (message: SupervisorMessage) => void): void;
}

/**
 * What a supervisor hands the daemon it starts: the port its predecessor
 * bound (a hint, see BOUND_API_PORT_ENV) and the dashboard sessions the
 * predecessor had live when it stopped, so `stratus restart` does not log
 * a browser out. In memory end to end; nothing here is written down.
 */
export interface RestartHandoff {
  boundApiPort?: number;
  sessions: DashboardSession[];
}

/** How a daemon the supervisor started ended, and what it handed back before it did. */
export interface RespawnResult {
  code: number;
  boundApiPort?: number;
  sessions?: DashboardSession[];
}

export interface PackageInstallResult {
  ok: boolean;
  /** Why it failed, as a line the operator can act on. Empty on success. */
  message: string;
}

/** Installs optional packages globally. */
export type PackageInstaller = (packages: string[]) => Promise<PackageInstallResult>;

/** The latest published version of a package, or undefined when the registry did not answer. */
export type PackageVersionFetcher = (packageName: string) => Promise<string | undefined>;

export type CliConfigFile = StratusConfigFile;

/** Reports whether an optional package is installed. */
export type PackageResolver = (specifier: string) => boolean;
