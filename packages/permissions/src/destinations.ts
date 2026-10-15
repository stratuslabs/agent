/**
 * Standing grants for a tool judged by destination (`Tool.destinationFor`):
 * `message.read` of one conversation, `message.send` to one conversation.
 *
 * Per tool and per destination, never wider. A tool-wide grant on
 * `message.read` would be a standing yes to every conversation the app is
 * in, which anyone who can talk to the agent could then have it quote
 * anywhere; a grant on one conversation is the answer the approver
 * actually gave, about the conversation they were shown. And per tool,
 * because being allowed to read a channel is not being allowed to post in
 * it.
 */
export interface DestinationGrant {
  /** `namespace.verb`, as the tool registered. */
  tool: string;
  /**
   * The destination as the tool names it (`destinationFor`), which for the
   * message tools is `channel:to` — `slack:C0123ABCD`. Compared exactly.
   */
  destination: string;
  /**
   * The workspace the destination was in when the approver answered, as
   * the channel names it (a Slack team id). A conversation id is unique
   * only within its workspace, so a grant made in one is no answer about
   * the same id in another: it matches only while the agent's channel
   * reports this same account. Absent for a channel that has no such
   * notion, and then it matches only while the channel still reports none.
   */
  account?: string;
  /** When the approver answered, ISO-8601. */
  grantedAt: string;
  /** Who answered, in the ids of the channel that asked; absent at a terminal. */
  grantedBy?: string;
}

/**
 * `account` is the workspace the agent's channel reports now. Compared
 * exactly, absent included: a grant from a known workspace never matches
 * while the workspace is unknown (the app is not connected), and a grant
 * with none never matches once the channel reports one.
 */
export const matchesDestinationGrant = (
  tool: string,
  destination: string,
  account: string | undefined,
  grant: DestinationGrant,
): boolean => grant.tool === tool && grant.destination === destination && grant.account === account;

export const findMatchingDestinationGrant = (
  tool: string,
  destination: string,
  account: string | undefined,
  grants: readonly DestinationGrant[],
): DestinationGrant | undefined => grants.find((grant) => matchesDestinationGrant(tool, destination, account, grant));

/** One line an operator can read in a log or a grant listing. */
export const describeDestinationGrant = (grant: DestinationGrant): string =>
  `${grant.destination}${grant.account === undefined ? '' : ` in ${grant.account}`} (${grant.tool})`;

/**
 * One row per tool and destination: a second answer replaces the first,
 * including one from another workspace, so approving again after an
 * agent's app moved workspaces drops the old workspace's grant.
 */
export const sameDestinationGrant = (left: DestinationGrant, right: DestinationGrant): boolean =>
  left.tool === right.tool && left.destination === right.destination;

/**
 * Read one grant out of a whitelist file, or refuse it. Both the tool and
 * the destination are required: a row missing either would otherwise have
 * to be widened to something nobody approved.
 */
export const parseDestinationGrant = (raw: unknown): DestinationGrant | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.tool !== 'string' || source.tool.length === 0) {
    return undefined;
  }
  if (typeof source.destination !== 'string' || source.destination.length === 0) {
    return undefined;
  }
  return {
    tool: source.tool,
    destination: source.destination,
    ...(typeof source.account === 'string' && source.account.length > 0 ? { account: source.account } : {}),
    grantedAt: typeof source.grantedAt === 'string' ? source.grantedAt : new Date(0).toISOString(),
    ...(typeof source.grantedBy === 'string' && source.grantedBy.length > 0 ? { grantedBy: source.grantedBy } : {}),
  };
};
