/**
 * Re-exported, not re-implemented: the risk ordering moved to the kernel
 * when the plugin loader became its second consumer, and this package
 * published the name first.
 */
export { atLeastAsRisky } from '@stratusagent/core';

export {
  builtInReviewRule,
  describeReviewRule,
  matchReviewRule,
  parseReviewRule,
  readReviewAnswer,
  REVIEW_CODES,
  ReviewFailure,
  type BuiltInReviewHit,
  type BuiltInReviewRuleName,
  type ReviewAnswer,
  type ReviewCode,
  type ReviewedCall,
  type Reviewer,
  type ReviewOptions,
  type ReviewRequest,
  type ReviewRule,
  type ReviewSettings,
} from './review.ts';

export { downloadInsideWorkspace, gitInsideWorkspace, gitPushInsideWorkspace, readsInsideWorkspace } from './workspace.ts';

export {
  analyzeCommand,
  commandScopeFromPrefix,
  describeCommandScope,
  findCoveringScopes,
  findMatchingScope,
  matchesScope,
  normalizeCommandScope,
  NUMERIC_FLAG,
  parseCommandScope,
  sameScope,
  SAFE_COMMAND_SCOPES,
  type CommandAnalysis,
  type CommandScope,
} from './commands.ts';
export {
  describeOriginScope,
  findMatchingOriginScope,
  matchesOriginScope,
  originScopeFor,
  parseOriginScope,
  sameOriginScope,
  normalizeTrustedDomain,
  SHARED_SUFFIXES,
  trustedDomainProblem,
  trustedDomainOf,
  type OriginScope,
} from './origins.ts';
export {
  describeToolGrant,
  findMatchingToolGrant,
  matchesToolGrant,
  parseToolGrant,
  sameToolGrant,
  type ToolGrant,
} from './grants.ts';
export {
  describeDestinationGrant,
  findMatchingDestinationGrant,
  matchesDestinationGrant,
  parseDestinationGrant,
  sameDestinationGrant,
  type DestinationGrant,
} from './destinations.ts';
export {
  createFileCommandWhitelist,
  describeAgentGrants,
  whitelistPathFor,
  LEGACY_WHITELIST_SUFFIX,
  legacyWhitelistPathFor,
  resolveWhitelistPath,
  WhitelistUnreadableError,
  type AgentGrants,
  type AgentGrantsListing,
  type AgentGrantStore,
  type CommandNameStore,
  type CommandWhitelistStore,
  type DestinationWhitelistStore,
  type OriginWhitelistStore,
  type ToolGrantStore,
} from './whitelist.ts';
export {
  analyzeCompound,
  GRANTABLE_BY_NAME,
  grantableByName,
  judgeCompound,
  NOT_GRANTABLE_BY_NAME,
  parseCommandNameGrant,
  SUBCOMMAND_COMMANDS,
  type CommandNameGrant,
  type CompoundCommand,
  type CompoundCoverage,
  type CompoundJudgement,
  type CompoundStage,
  type Redirect,
} from './compound.ts';

export {
  assertDerivedStatePath,
  assertDerivedStatePathSync,
  linkedDerivedComponent,
  linkedDerivedComponentMessage,
  linkedDerivedComponentSync,
  isSymlinkedStatePath,
  isSymlinkedStatePathSync,
  symlinkedStateDirectoryMessage,
  symlinkedStateFileMessage,
} from './state-directory.ts';

export {
  type ApprovalRequest,
  type ApprovalRequester,
  type CommandScopeOptions,
  type ConversationKind,
  type DecisionLayer,
  type DestinationScopeOptions,
  type OriginScopeOptions,
  type PermissionDecision,
  type PermissionMode,
  type PermissionPolicyOptions,
  type ToolGrantOptions,
} from './options.ts';

export {
  matchesStandingChannel,
  STANDING_CHANNEL_TOOLS,
  unboundStandingChannels,
} from './standing-channels.ts';

export {
  createPermissionPolicy,
  DEFAULT_REVIEW_TIMEOUT_MS,
} from './policy.ts';
