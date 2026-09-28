// Printed commands must survive copy-paste into a shell, so anything outside
// the safe character set gets single-quoted.
//
// Here rather than in the CLI, which re-exports it, because a command this
// package prints has the same problem: an agent id may hold a space or a
// `;`, and an error that says "run this" must not run something else.
export const quoteShellArg = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
