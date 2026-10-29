/**
 * Which environment variables a stored credential may be put in for a shell
 * command, decided once for every surface that sets or asks for one: tool-shell
 * when it runs the command, the gateway when an agent asks for a key with
 * `env`, the CLI when an operator binds one, and the credential link page.
 * Two copies of this list drifted is the reason it lives here: a name the
 * request-time check let through and the command-time check refused would
 * be a form an approver answered for nothing.
 */

/**
 * Environment variables that carry options for a command the permission
 * engine judges by its arguments. tool-shell never passes them to a child.
 */
// Not POSIXLY_CORRECT here: macOS's /bin/sh exports it to every command it
// runs, so the permission engine reads arguments both ways instead (see
// `operandsToo` in @stratusagent/permissions). It is a shell startup variable
// below, which keeps it out of a credential.
export const COMMAND_OPTION_VARIABLES = ['RIPGREP_CONFIG_PATH', 'GREP_OPTIONS', 'GZIP'] as const;

/**
 * Variables that make git use a repository other than the one the command
 * runs in, which the permission engine finds from the working directory.
 * Identity and config (`GIT_CONFIG_GLOBAL`, author names) are untouched.
 */
export const GIT_REPOSITORY_VARIABLES: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
];

/**
 * Variables that make a shell run code before the command, or read it
 * differently from the permission engine. `CDPATH` sends a relative `cd`
 * somewhere other than the working directory the engine follows it from.
 * `BASHOPTS`, `SHELLOPTS` and `POSIXLY_CORRECT` switch on shell options at
 * startup (`cdable_vars` makes `cd HOME` follow `$HOME`).
 */
export const SHELL_STARTUP_VARIABLES: readonly string[] = [
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'CDPATH', 'BASHOPTS', 'SHELLOPTS', 'POSIXLY_CORRECT',
];

/** Variables a credential must not replace: what finds programs and where they keep their files. */
const RESERVED_CREDENTIAL_VARIABLES: readonly string[] = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'PWD', 'IFS'];

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What a variable an agent names must look like: a secret's. The model picks
 * the name, and a variable can change what an allowed command does
 * (`GIT_SSH_COMMAND`, `NODE_OPTIONS`, `LD_PRELOAD`), which would get around
 * the permission engine's judgment of the command text. Every name a CLI
 * reads a token from that we know of has one of these endings. Anything
 * else (`DATABASE_URL`) is an operator's call, made on the machine.
 */
const REQUESTED_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*_(TOKEN|KEY|SECRET|PASSWORD|SID|ID)$/;

/**
 * Why `variable` cannot carry a credential into a shell command, or
 * undefined when it can. A sentence for whoever chose it.
 *
 * `requested: true` is the rule for a name an agent asked for
 * (`credential.request`'s `env`), which must also look like a secret's.
 * Without it, the operator's rule: only the refused list applies, the same
 * one tool-shell's `credentialsEnv` has always kept.
 */
export const credentialVariableProblem = (variable: string, options: { requested?: boolean } = {}): string | undefined => {
  if (!VARIABLE_NAME.test(variable)) {
    return `${JSON.stringify(variable)} is not an environment variable name. Use letters, digits and underscores, not starting with a digit.`;
  }
  if (RESERVED_CREDENTIAL_VARIABLES.includes(variable)
    || (COMMAND_OPTION_VARIABLES as readonly string[]).includes(variable)
    || SHELL_STARTUP_VARIABLES.includes(variable)
    || GIT_REPOSITORY_VARIABLES.includes(variable)
    || variable.startsWith('BASH_FUNC_')) {
    return `A credential can't be put in ${variable}, because it changes how commands are found or run. `
      + 'Use the variable a CLI reads its token from, such as GH_TOKEN.';
  }
  if (options.requested === true && !REQUESTED_VARIABLE_NAME.test(variable)) {
    return `${variable} doesn't look like a secret's variable. An agent may only ask for one in uppercase ending in `
      + '_TOKEN, _KEY, _SECRET, _PASSWORD, _SID or _ID (GH_TOKEN, TWILIO_AUTH_TOKEN). '
      + 'Any other name is your operator\'s to bind on the machine with `stratus credential env`.';
  }
  return undefined;
};
