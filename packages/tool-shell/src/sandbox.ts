import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Keeps an agent-composed command out of the daemon's home and the user's
 * secrets, whatever the command says.
 *
 * The permission engine judges what a command *says*; this bounds what it
 * can *do*. A command runs with the workspace writable, the rest of the
 * system readable, and these unreadable: the Stratus home outside the
 * agent's own workspace (credentials, config, other agents, sessions), and
 * the usual places a user keeps credentials. The network is left on: an
 * agent that works needs `git push` and `npm install`, and what it can send
 * is its own workspace, not a token.
 *
 * macOS uses `sandbox-exec` with a generated profile; Linux uses `bwrap`
 * (bubblewrap). Neither falls back silently: under `required` an
 * unavailable sandbox refuses the command, and under `auto` it runs
 * unconfined only after saying so once.
 */

export type SandboxMode = 'auto' | 'required' | 'off';

/** Paths under the user's home that hold credentials, refused to every sandboxed command. */
export const DEFAULT_DENIED_HOME_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.config/git/credentials',
  '.config/op',
  '.docker',
  '.fly',
  '.git-credentials',
  '.gnupg',
  '.kube',
  '.netrc',
  '.npmrc',
  '.password-store',
  '.pypirc',
  'Library/Keychains',
];

/**
 * Control sockets of container runtimes. A read-only view of a socket still
 * accepts a connection, and any of these hands out the whole host (`docker
 * run -v /:/host`), so they are refused like the credential stores. Docker
 * Desktop's own socket lives under `~/.docker`, which is denied already.
 */
export const DEFAULT_DENIED_SOCKETS: readonly string[] = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/var/run/crio/crio.sock',
  '/run/buildkit/buildkitd.sock',
];

/**
 * Package-manager caches a build writes outside the workspace. Writable so
 * `npm install` and friends work; nothing in them is a credential.
 */
export const DEFAULT_WRITABLE_HOME_PATHS: readonly string[] = [
  '.npm',
  '.cache',
  '.pnpm-store',
  '.bun/install/cache',
  '.yarn/berry/cache',
  'Library/Caches',
  'Library/pnpm',
];

export interface SandboxPolicy {
  /** The agent's workspace: readable and writable. */
  workspace: string;
  /** Where the command starts. Writable too, when it is outside the workspace. */
  cwd?: string;
  /** Directories refused to the command, reads and writes (the Stratus home among them). */
  denied: string[];
  /** Directories the command may write besides the workspace and temp. */
  writable: string[];
  /** The daemon user's own temp directory (macOS keeps one per user under /var/folders). */
  tmp?: string;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
}

export type SandboxPlan =
  | { kind: 'sandboxed'; command: SandboxedCommand }
  | { kind: 'unavailable'; reason: string };

/** Both spellings of a path: as given, and resolved through its symlinks when it exists. */
export const spellings = (target: string): string[] => {
  const absolute = path.resolve(target);
  try {
    const real = realpathSync(absolute);
    return real === absolute ? [absolute] : [absolute, real];
  } catch {
    return [absolute];
  }
};

/**
 * The Stratus homes an agent's command must not read: the configured one,
 * and the one its workspace sits in when it uses the default layout
 * (`<home>/agents/<id>/workspace`).
 */
export const stratusHomesFor = (workspace: string, processEnv: NodeJS.ProcessEnv, userHome: string): string[] => {
  const homes = new Set<string>();
  homes.add(path.resolve(processEnv.STRATUS_HOME ?? path.join(userHome, '.stratus')));
  const parts = path.resolve(workspace).split(path.sep);
  if (parts.length >= 4 && parts.at(-1) === 'workspace' && parts.at(-3) === 'agents') {
    homes.add(parts.slice(0, -3).join(path.sep) || path.sep);
  }
  return [...homes];
};

const SBPL_UNSAFE = /["\\\n\r\0]/;

const sbplString = (value: string): string => {
  if (SBPL_UNSAFE.test(value)) {
    throw new Error(`Cannot sandbox a path containing a quote, backslash, or newline: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
};

const subpaths = (paths: string[]): string =>
  [...new Set(paths.flatMap(spellings))].map((p) => `(subpath ${sbplString(p)})`).join(' ');

/**
 * The macOS profile. Rules are evaluated in order and the last match wins,
 * so it allows everything, takes writes away, gives back the workspace and
 * temp, takes the denied trees away entirely, and gives the workspace back
 * once more (it may sit inside the Stratus home). The denied trees lose
 * their contents, not their names: `stat` still works, so git and getcwd
 * can walk up through them. Keychain lookups go
 * through securityd rather than the filesystem, so its mach services are
 * refused as well; TLS trust uses trustd and keeps working.
 */
export const darwinProfile = (policy: SandboxPolicy): string => {
  const writable = [policy.workspace, ...(policy.cwd ? [policy.cwd] : []), ...policy.writable, '/private/tmp', ...(policy.tmp ? [policy.tmp] : [])];
  const ancestors = [...new Set([policy.workspace, ...(policy.cwd ? [policy.cwd] : [])].flatMap(spellings).flatMap((dir) => {
    const chain: string[] = [];
    for (let current = path.dirname(dir); ; current = path.dirname(current)) {
      chain.push(current);
      if (path.dirname(current) === current) {
        return chain;
      }
    }
  }))];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${subpaths(writable)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
    ...(policy.denied.length > 0 ? [
      `(deny file-read-data file-read-xattr file-write* ${subpaths(policy.denied)})`,
      // A file deny does not cover connect(2) on a socket inside it. One
      // `remote unix-socket` form per path: given several paths, one form
      // matches only its first (measured on macOS 15.3).
      `(deny network-outbound ${[...new Set(policy.denied.flatMap(spellings))].map((p) => `(remote unix-socket (subpath ${sbplString(p)}))`).join(' ')})`,
    ] : []),
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))',
    // The workspace's ancestors may be listed (not read into), or getcwd
    // and git's repository discovery fail when the workspace sits inside
    // the hidden Stratus home. A listing names files; it reads none.
    ...(ancestors.length > 0 ? [`(allow file-read-data ${ancestors.map((p) => `(literal ${sbplString(p)})`).join(' ')})`] : []),
    // Named operation by operation: an allow of the `file-read*` wildcard
    // does not undo a deny that named `file-read-data`.
    `(allow file-read-data file-read-xattr file-read* file-write* ${subpaths([policy.workspace])})`,
    '',
  ].join('\n');
};

/**
 * The bubblewrap arguments. The root is bound read-only, temp is private,
 * each denied path that exists is covered (an empty tmpfs over a directory,
 * `/dev/null` over a file), and the workspace is bound back last so it
 * shows through a covered Stratus home. A fresh pid and IPC namespace keep
 * the command from signalling the daemon or other agents.
 */
export const bwrapArgs = (policy: SandboxPolicy, shell: string, shellArgs: string[]): string[] => {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const dir of new Set([...policy.writable, ...(policy.cwd ? [policy.cwd] : [])])) {
    if (existsSync(dir)) {
      args.push('--bind', dir, dir);
    }
  }
  for (const denied of new Set(policy.denied.flatMap(spellings))) {
    if (!existsSync(denied)) {
      continue;
    }
    if (statSync(denied).isDirectory()) {
      args.push('--tmpfs', denied);
    } else {
      args.push('--ro-bind', '/dev/null', denied);
    }
  }
  const workspaceSpellings = spellings(policy.workspace);
  const workspaceSource = workspaceSpellings.at(-1)!;
  for (const spelling of workspaceSpellings) {
    args.push('--bind', workspaceSource, spelling);
  }
  args.push('--unshare-pid', '--unshare-ipc', '--die-with-parent', '--new-session');
  if (policy.cwd) {
    args.push('--chdir', policy.cwd);
  }
  args.push('--', shell, ...shellArgs);
  return args;
};

const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

let bwrapProbe: { path: string } | { error: string } | undefined;

/** Whether bwrap can actually start a namespace here (it can't in many containers). Probed once. */
const probeBwrap = (): { path: string } | { error: string } => {
  if (bwrapProbe) {
    return bwrapProbe;
  }
  const found = BWRAP_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    bwrapProbe = { error: 'bubblewrap (bwrap) is not installed. Install it (apt install bubblewrap, dnf install bubblewrap)' };
    return bwrapProbe;
  }
  const result = spawnSync(found, ['--ro-bind', '/', '/', '--unshare-pid', '--', '/bin/true'], { encoding: 'utf8', timeout: 5_000 });
  bwrapProbe = result.status === 0
    ? { path: found }
    : { error: `${found} cannot create a sandbox here (${(result.stderr || result.error?.message || `exit ${result.status}`).trim()})` };
  return bwrapProbe;
};

/** For tests: forget the cached bwrap probe. */
export const resetSandboxProbe = (): void => {
  bwrapProbe = undefined;
};

/** How to run `shell shellArgs…` under the policy on this platform, or why it can't be. */
export const planSandbox = (
  policy: SandboxPolicy,
  shell: string,
  shellArgs: string[],
  platform: NodeJS.Platform = process.platform,
): SandboxPlan => {
  if (platform === 'darwin') {
    if (!existsSync(DARWIN_SANDBOX_EXEC)) {
      return { kind: 'unavailable', reason: `${DARWIN_SANDBOX_EXEC} is missing` };
    }
    return { kind: 'sandboxed', command: { command: DARWIN_SANDBOX_EXEC, args: ['-p', darwinProfile(policy), shell, ...shellArgs] } };
  }
  if (platform === 'linux') {
    const probe = probeBwrap();
    if ('error' in probe) {
      return { kind: 'unavailable', reason: probe.error };
    }
    return { kind: 'sandboxed', command: { command: probe.path, args: bwrapArgs(policy, shell, shellArgs) } };
  }
  return { kind: 'unavailable', reason: `no sandbox is implemented for ${platform}` };
};

export const parseSandboxMode = (value: unknown): SandboxMode => {
  if (value === undefined) {
    return 'auto';
  }
  if (value === 'auto' || value === 'required' || value === 'off') {
    return value;
  }
  throw new Error(`sandbox must be "auto", "required", or "off"; got ${JSON.stringify(value)}.`);
};
