/**
 * Standing channel authorization (`approvals.channels`): the conversations
 * an operator lets an agent read and post in without asking.
 */

/**
 * The tools an operator's standing channel authorization covers. Kernel
 * tools only: a plugin tool registered under the same name is a different
 * tool and is judged the usual way.
 */
export const STANDING_CHANNEL_TOOLS: readonly string[] = ['message.read', 'message.send'];

/**
 * Whether a configured `approvals.channels` entry covers a destination in
 * the workspace the agent's app is connected to right now (`account`, see
 * `DestinationScopeOptions.accountFor`):
 *
 * - `channel:*`: every conversation of that kind the app can reach, in
 *   whatever workspace it is in.
 * - `channel:<workspace>/<id>`: that conversation, only while the app is in
 *   that workspace. A conversation id is unique only within its workspace,
 *   so an id is bound to one, the same way an Always-allow grant is.
 * - `channel:<workspace>/*`: every conversation of that kind in that
 *   workspace.
 *
 * A bare `channel:<id>` names no workspace and covers nothing; the daemon
 * says so at startup (`unboundStandingChannels`). The kind check (channels
 * yes, DMs no) is the caller's.
 */
export const matchesStandingChannel = (
  destination: string,
  account: string | undefined,
  entries: readonly string[],
): boolean => {
  const separator = destination.indexOf(':');
  if (separator <= 0 || separator === destination.length - 1) {
    return false;
  }
  const kind = destination.slice(0, separator);
  const to = destination.slice(separator + 1);
  return entries.some((entry) => {
    if (entry === `${kind}:*`) {
      return true;
    }
    if (!entry.startsWith(`${kind}:`) || account === undefined || account.length === 0) {
      return false;
    }
    const scoped = entry.slice(kind.length + 1);
    const slash = scoped.indexOf('/');
    if (slash <= 0) {
      return false;
    }
    const workspace = scoped.slice(0, slash);
    const id = scoped.slice(slash + 1);
    return workspace === account && (id === '*' || id === to);
  });
};

/** Entries that name a conversation without its workspace, which `matchesStandingChannel` never matches. */
export const unboundStandingChannels = (entries: readonly string[]): string[] =>
  entries.filter((entry) => {
    const separator = entry.indexOf(':');
    const rest = entry.slice(separator + 1);
    return separator > 0 && rest !== '*' && !rest.includes('/');
  });
