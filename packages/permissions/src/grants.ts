/**
 * The standing-grant engine: which *tools* an agent may run unattended,
 * by name, until an operator says otherwise.
 *
 * The third vocabulary the whitelist file speaks, beside command scopes
 * and origins, and the coarsest: a grant here is the whole tool. That is
 * only safe for a tool whose risk lives in its identity rather than its
 * arguments — which is exactly what a tool with no scope hook is saying
 * about itself. A tool that offers `commandFor` or `originFor` has said
 * the opposite, and never receives one of these; the engine keeps that
 * structural rather than remembered, by resolving scopes first.
 *
 * A grant is scoped to the tool *as it was when granted*, so it records the
 * package that contributed it and stops applying when that changes: a
 * different package claiming a granted name — one plugin swapped for
 * another, a bridged server's tool taken over — asks again, and the listing
 * says why. A kernel tool records no package, and matches only a kernel one.
 *
 * The same package upgraded **in place** keeps its grants, and that is a
 * decision rather than a gap. Pinning identity to a version would revoke
 * every grant on every routine upgrade, which trains an operator to
 * re-approve without reading and buys nothing against the case that
 * actually worries anyone — a package whose new version is hostile is one
 * whose next version is too. 28 scoped this to recording the package,
 * "the only thing that makes the question answerable later"; answering it
 * properly wants an integrity identifier the plugin host does not have
 * yet, and belongs with whatever introduces one. Until then the operator's
 * remedy is `stratus grants revoke` after an upgrade they distrust, which
 * is why the listing shows the package it was granted from.
 */

/** One standing permission to run a tool: the tool, and its provenance. */
export interface ToolGrant {
  /** `namespace.verb`, as the tool registered. */
  tool: string;
  /** The plugin package that contributed it when granted; absent for a kernel tool. */
  package?: string;
  /** When the operator answered, ISO-8601. */
  grantedAt: string;
  /** Who answered, in the ids of the channel that asked; absent at a terminal. */
  grantedBy?: string;
}

/**
 * Whether a grant covers a call to `tool` as contributed by `contributor`
 * right now. Both halves must agree: the same name from a different
 * package is a different tool, and so is the same name from no package.
 */
export const matchesToolGrant = (tool: string, contributor: string | undefined, grant: ToolGrant): boolean =>
  grant.tool === tool && grant.package === contributor;

/** The first grant covering this call, if any covers it. */
export const findMatchingToolGrant = (
  tool: string,
  contributor: string | undefined,
  grants: readonly ToolGrant[],
): ToolGrant | undefined => grants.find((grant) => matchesToolGrant(tool, contributor, grant));

/** One line an operator can read in a log or a grant listing. */
export const describeToolGrant = (grant: ToolGrant): string =>
  grant.package === undefined ? grant.tool : `${grant.tool} (${grant.package})`;

/**
 * Whether two grants are the same permission. One per tool per agent: a
 * second "always" on a tool already granted from another package replaces
 * the first rather than sitting beside it, because the operator answered
 * about the tool they were shown, and two rows for one name would leave a
 * listing that cannot say which one applies.
 */
export const sameToolGrant = (left: ToolGrant, right: ToolGrant): boolean =>
  left.tool === right.tool;

/**
 * Read one grant out of a whitelist file, or refuse it. A row with no
 * tool name grants nothing; a row with no timestamp is kept, dated to
 * the epoch rather than invented, so a hand-written grant is still a grant
 * and still visibly one nobody answered at a prompt.
 */
export const parseToolGrant = (raw: unknown): ToolGrant | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.tool !== 'string' || source.tool.length === 0) {
    return undefined;
  }
  return {
    tool: source.tool,
    ...(typeof source.package === 'string' && source.package.length > 0 ? { package: source.package } : {}),
    grantedAt: typeof source.grantedAt === 'string' ? source.grantedAt : new Date(0).toISOString(),
    ...(typeof source.grantedBy === 'string' && source.grantedBy.length > 0 ? { grantedBy: source.grantedBy } : {}),
  };
};
