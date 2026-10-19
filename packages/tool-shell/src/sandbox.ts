import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
  // Tokens developer CLIs store after a login.
  '.cargo/credentials.toml',
  '.cargo/credentials',
  '.gem/credentials',
  '.config/hub',
  '.config/glab-cli',
  '.terraform.d/credentials.tfrc.json',
  '.vault-token',
  '.pulumi/credentials.json',
  '.m2/settings.xml',
  '.m2/settings-security.xml',
  '.gradle/gradle.properties',
  '.composer/auth.json',
  '.config/composer/auth.json',
  '.databrickscfg',
  '.config/doctl',
  '.oci',
  '.config/hcloud',
  '.claude/.credentials.json',
  '.codex/auth.json',
  // SSH agents that keep their socket under the home: 1Password (Linux and
  // macOS) and Secretive. An agent signs with keys no file check sees.
  '.1password',
  'Library/Group Containers/2BUA8C4S2C.com.1password',
  'Library/Containers/com.maxgoedjen.Secretive.SecretAgent',
  // Tokens kept inside a cache directory that is otherwise writable.
  '.cache/huggingface/token',
  '.cache/huggingface/stored_tokens',
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
 * The user's runtime directories, `$XDG_RUNTIME_DIR` and `/run/user/<uid>`,
 * denied whole. Everything there is a per-user service endpoint: D-Bus and
 * the systemd manager (either starts a same-user process outside the
 * sandbox), rootless Docker and Podman, gpg-agent and systemd's ssh-agent
 * (either signs with keys whose files are hidden). Naming entries one by
 * one kept missing the next one. An abstract-namespace socket has no path
 * to cover; the network is not unshared, so one listening there stays
 * reachable.
 */
export const userRuntimeEndpoints = (processEnv: NodeJS.ProcessEnv, uid: number | undefined): string[] => {
  const dirs = new Set<string>();
  if (processEnv.XDG_RUNTIME_DIR && path.isAbsolute(processEnv.XDG_RUNTIME_DIR)) {
    dirs.add(processEnv.XDG_RUNTIME_DIR);
  }
  if (uid !== undefined) {
    dirs.add(`/run/user/${uid}`);
  }
  return [...dirs];
};

/**
 * Variables that move a credential store out of its default place, and what
 * under the moved location is the credential ('' for the location itself).
 * The daemon's environment decides where the CLIs it runs keep tokens, so
 * the moved store is denied even when the variable is not forwarded to the
 * command: the command reads the file, not the variable.
 */
const RELOCATED_CREDENTIAL_STORES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['GH_CONFIG_DIR', ['']],
  ['DOCKER_CONFIG', ['']],
  ['AWS_SHARED_CREDENTIALS_FILE', ['']],
  ['AWS_CONFIG_FILE', ['']],
  ['GNUPGHOME', ['']],
  ['CLOUDSDK_CONFIG', ['']],
  ['AZURE_CONFIG_DIR', ['']],
  ['NPM_CONFIG_USERCONFIG', ['']],
  ['npm_config_userconfig', ['']],
  ['PASSWORD_STORE_DIR', ['']],
  ['CARGO_HOME', ['credentials.toml', 'credentials']],
  ['PULUMI_HOME', ['credentials.json']],
  ['TF_CLI_CONFIG_FILE', ['']],
  ['GRADLE_USER_HOME', ['gradle.properties']],
  ['COMPOSER_HOME', ['auth.json']],
  ['DATABRICKS_CONFIG_FILE', ['']],
  ['CLAUDE_CONFIG_DIR', ['.credentials.json']],
  ['CODEX_HOME', ['auth.json']],
  ['HF_HOME', ['token', 'stored_tokens']],
  ['HF_TOKEN_PATH', ['']],
  ['GLAB_CONFIG_DIR', ['']],
  ['HUB_CONFIG', ['']],
  ['OP_CONFIG_DIR', ['']],
];

/** XDG base directories, and the prefix of the default home entries each one moves. */
const XDG_BASES: ReadonlyArray<readonly [string, string]> = [
  ['XDG_CONFIG_HOME', '.config/'],
  ['XDG_CACHE_HOME', '.cache/'],
];

/** Container runtime endpoints a variable names (`unix:///path`), like the default sockets. */
const SOCKET_HOSTS = ['DOCKER_HOST', 'CONTAINER_HOST'];

/**
 * The credential stores, and container sockets, that the daemon's
 * environment moves elsewhere. A relative value is ignored (it names no
 * fixed place), and so is one that is or holds the user's home or the
 * workspace: denying it would hide the whole system or the agent's own work,
 * and the home's own credential paths are denied by name already.
 */
export const relocatedCredentials = (processEnv: NodeJS.ProcessEnv, userHome: string, workspace: string): string[] => {
  const found: string[] = [];
  const add = (target: string) => {
    if (!path.isAbsolute(target)) {
      return;
    }
    const resolved = path.resolve(target);
    if (isWithin(resolved, path.resolve(userHome)) || isWithin(resolved, path.resolve(workspace))) {
      return;
    }
    found.push(resolved);
  };
  for (const [name, entries] of RELOCATED_CREDENTIAL_STORES) {
    const value = processEnv[name];
    if (value && path.isAbsolute(value)) {
      for (const entry of entries) {
        add(path.join(value, entry));
      }
    }
  }
  for (const [name, prefix] of XDG_BASES) {
    const value = processEnv[name];
    if (value && path.isAbsolute(value)) {
      for (const entry of DEFAULT_DENIED_HOME_PATHS) {
        if (entry.startsWith(prefix)) {
          add(path.join(value, entry.slice(prefix.length)));
        }
      }
    }
  }
  for (const entry of (processEnv.KUBECONFIG ?? '').split(path.delimiter)) {
    add(entry);
  }
  for (const name of SOCKET_HOSTS) {
    const value = processEnv[name];
    if (value?.startsWith('unix://')) {
      add(value.slice('unix://'.length));
    }
  }
  return found;
};

/**
 * SSH agent sockets outside the home and runtime directory: the one
 * `$SSH_AUTH_SOCK` names, and on macOS every launchd session directory in
 * `/private/tmp` (launchd's own agent listens in one, under a random name a
 * command can list). `/private/tmp` is otherwise writable to the command;
 * Linux gives it a private `/tmp` already.
 */
export const credentialAgentEndpoints = (
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  privateTmpEntries: () => readonly string[] = () => {
    try {
      return readdirSync('/private/tmp');
    } catch {
      return [];
    }
  },
): string[] => {
  const found: string[] = [];
  if (processEnv.SSH_AUTH_SOCK && path.isAbsolute(processEnv.SSH_AUTH_SOCK)) {
    found.push(processEnv.SSH_AUTH_SOCK);
  }
  if (platform === 'darwin') {
    for (const entry of privateTmpEntries()) {
      if (entry.startsWith('com.apple.launchd.')) {
        found.push(path.join('/private/tmp', entry));
      }
    }
  }
  return found;
};

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

/**
 * Whether a default writable path is one this platform uses. `Library` is
 * macOS's; elsewhere it would only be a folder created for nothing.
 */
export const writableHomePathsFor = (platform: NodeJS.Platform): string[] =>
  DEFAULT_WRITABLE_HOME_PATHS.filter((entry) => platform === 'darwin' || !entry.startsWith('Library/'));

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

/** Whether `child` is `parent` or beneath it. */
const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * The denied paths that sit inside the workspace, every spelling. The
 * workspace is given back after the denials (it may sit inside the hidden
 * Stratus home), so these are denied once more after it: a workspace that
 * is an ancestor of something hidden (a fallback of `~` or `/`, or an
 * operator's `deniedPaths` entry inside it) must not show it again.
 */
const deniedInside = (policy: SandboxPolicy): string[] => {
  const workspace = spellings(policy.workspace);
  return [...new Set(policy.denied.flatMap(spellings))].filter((denied) => workspace.some((dir) => isWithin(dir, denied)));
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

/** Deny reading, writing, and connecting to sockets under `paths`. */
const denyRules = (paths: string[]): string[] => paths.length === 0 ? [] : [
  `(deny file-read-data file-read-xattr file-write* ${subpaths(paths)})`,
  // A file deny does not cover connect(2) on a socket inside it. One
  // `remote unix-socket` form per path: given several paths, one form
  // matches only its first (measured on macOS 15.3).
  `(deny network-outbound ${[...new Set(paths.flatMap(spellings))].map((p) => `(remote unix-socket (subpath ${sbplString(p)}))`).join(' ')})`,
];

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
    ...denyRules(policy.denied),
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))',
    // The workspace's ancestors may be listed (not read into), or getcwd
    // and git's repository discovery fail when the workspace sits inside
    // the hidden Stratus home. A listing names files; it reads none.
    ...(ancestors.length > 0 ? [`(allow file-read-data ${ancestors.map((p) => `(literal ${sbplString(p)})`).join(' ')})`] : []),
    // Named operation by operation: an allow of the `file-read*` wildcard
    // does not undo a deny that named `file-read-data`.
    `(allow file-read-data file-read-xattr file-read* file-write* ${subpaths([policy.workspace])})`,
    ...denyRules(deniedInside(policy)),
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
/**
 * The daemon's temp directory when it is not under `/tmp`, which gets a
 * private tmpfs of its own the way `/tmp` does, so tools that honor
 * `TMPDIR` can write there. Not one that holds the workspace or the
 * starting directory (`TMPDIR=$HOME`): an empty tmpfs there would hide the
 * toolchains a command needs.
 */
const privateTmpFor = (policy: SandboxPolicy): string | undefined => {
  if (!policy.tmp) {
    return undefined;
  }
  const tmp = path.resolve(policy.tmp);
  if (tmp === '/' || isWithin('/tmp', tmp) || !existsSync(tmp) || !statSync(tmp).isDirectory()) {
    return undefined;
  }
  const held = [policy.workspace, ...(policy.cwd ? [policy.cwd] : [])].flatMap(spellings);
  return held.some((dir) => isWithin(tmp, dir)) ? undefined : tmp;
};

export const bwrapArgs = (policy: SandboxPolicy, shell: string, shellArgs: string[]): string[] => {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  const tmp = privateTmpFor(policy);
  if (tmp) {
    args.push('--tmpfs', tmp);
  }
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
  for (const denied of deniedInside(policy)) {
    if (existsSync(denied)) {
      args.push(statSync(denied).isDirectory() ? '--tmpfs' : '--ro-bind', ...(statSync(denied).isDirectory() ? [denied] : ['/dev/null', denied]));
    }
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
