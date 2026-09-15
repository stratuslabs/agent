// The package's one public surface: every export below is re-exported by
// name from the module that owns it. What an agent *is* — its identity,
// its soul file, its skills — sits at the top level; `tools/` holds the
// tool factories an agent is given (memory, delegation, schedules,
// message.send), each with the tool names it owns.

export {
  AVATAR_STYLE,
  generateAgentName,
  generateAvatarTheme,
  AGENT_ID_PATTERN,
  MAX_AGENT_ID_LENGTH,
  isValidAgentId,
  isValidDelegateEntry,
  MAX_SESSION_ID_LENGTH,
  isValidSessionId,
  agentIdWithSuffix,
} from './identity.ts';

export { type DefineAgentInput, defineAgent } from './define.ts';

export {
  isDelegateAllowed,
  type ParsedSoul,
  type ParseSoulOptions,
  parseSoul,
  formatSoul,
} from './soul.ts';

export {
  SKILL_ID_PATTERN,
  SKILL_ID_MAX_LENGTH,
  isValidSkillId,
  isLoadableSkillId,
  SKILL_ID_RULE,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_COMPATIBILITY_MAX_LENGTH,
  type ParsedSkillDocument,
  parseSkillDocument,
  type ValidateSkillDocumentOptions,
  type SkillValidation,
  validateSkillDocument,
  type LazySkillInput,
  createLazySkill,
} from './skills.ts';

export {
  type ScheduleDestination,
  canonicalDestination,
  type ScheduleCadence,
  type ScheduleRecord,
  parseInterval,
  parseCronExpression,
  nextFireAfter,
  describeCadence,
  SCHEDULE_ID_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  type ScheduleCreateInput,
  type SchedulerHandle,
  describeSchedule,
} from './schedules.ts';

export {
  type AgentRouteRule,
  type AgentRouter,
  createAgentRouter,
  createAgentTeam,
} from './router.ts';

export {
  MEMORY_TOOL_NAME,
  createRememberTool,
  RECALL_TOOL_NAME,
  createRecallTool,
  FORGET_TOOL_NAME,
  createForgetTool,
  PIN_TOOL_NAME,
  createPinTool,
  type MemoryToolOptions,
} from './tools/memory.ts';

export {
  DELEGATE_TOOL_NAME,
  DELEGATED_BY_METADATA_KEY,
  ROOT_SESSION_ID_METADATA_KEY,
  DELEGATION_DEPTH_METADATA_KEY,
  DELEGATED_SESSION_ID_MARKER,
  isDelegatedSession,
  delegatingSessionIdOf,
  outstandingDelegationFor,
  withoutDelegation,
  type DelegateDispatch,
  type DelegateToolOptions,
  createDelegateTool,
} from './tools/delegate.ts';

export {
  SCHEDULE_EVERY_TOOL_NAME,
  SCHEDULE_AT_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_CANCEL_TOOL_NAME,
  createScheduleTools,
} from './tools/schedule.ts';

export {
  MESSAGE_SEND_TOOL_NAME,
  type OutboundMessenger,
  createMessageSendTool,
} from './tools/message.ts';

export { GATEWAY_ONLY_TOOL_NAMES } from './tools/gateway-only.ts';
