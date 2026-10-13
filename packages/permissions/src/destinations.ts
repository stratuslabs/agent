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
  /** When the approver answered, ISO-8601. */
  grantedAt: string;
  /** Who answered, in the ids of the channel that asked; absent at a terminal. */
  grantedBy?: string;
}

export const matchesDestinationGrant = (tool: string, destination: string, grant: DestinationGrant): boolean =>
  grant.tool === tool && grant.destination === destination;

export const findMatchingDestinationGrant = (
  tool: string,
  destination: string,
  grants: readonly DestinationGrant[],
): DestinationGrant | undefined => grants.find((grant) => matchesDestinationGrant(tool, destination, grant));

/** One line an operator can read in a log or a grant listing. */
export const describeDestinationGrant = (grant: DestinationGrant): string => `${grant.destination} (${grant.tool})`;

/** One row per tool and destination: a second answer replaces the first. */
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
    grantedAt: typeof source.grantedAt === 'string' ? source.grantedAt : new Date(0).toISOString(),
    ...(typeof source.grantedBy === 'string' && source.grantedBy.length > 0 ? { grantedBy: source.grantedBy } : {}),
  };
};
