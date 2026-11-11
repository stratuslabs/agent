import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  type Message,
  filePathsOf,
  postOf,
  isUnaddressedTurn,
  carriesKey,
  SENDER_TRUST_METADATA_KEY,
  workItemState,
  turnMessageOf,
  turnKeyOf,
  leftForNextStart,
  sessionWriteTrust,
  AgentRegistry,
  AgentRunner,
  InMemorySessionStore,
  MEMORY_PASS_MAX_MODEL_CALLS,
  MEMORY_PASS_RULES,
  ChannelRegistry,
  ContributionRegistry,
  createRoutedMemoryStore,
  EventBus,
  RunAbortedError,
  SkillRegistry,
  ToolRegistry,
  createSkillReadTool,
  missingSkillRequirements,
  describeToolAllowlistFinding,
  unmatchedToolAllowlist,
  SESSION_TRUST_METADATA_KEY,
  latestTurnReply,
  conversationContextFrom,
  STRATUS_SKILL_ID,
  type AgentDefinition,
  type AgentRuntimeContext,
  type AgentMemoryStore,
  type ApprovalContext,
  type ApprovalPolicy,
  type ApprovalRefusal,
  type Executor,
  type ExecutorContribution,
  type JsonObject,
  type MemoryStoreContribution,
  type ProviderCallGuard,
  type ProviderContribution,
  type Session,
  type Tool,
  type StratusEvent,
  type UnlistedTools,
  type TrustLevel,
} from '@stratusagent/core';
import {
  CREDENTIAL_REQUEST_TOOL_NAME,
  createForgetTool,
  createPinTool,
  canonicalDestination,
  createMessageSendTool,
  createMessageSayTool,
  createMessageReadTool,
  createChannelArchiveTool,
  createChannelCreateTool,
  createChannelInviteTool,
  createChannelJoinTool,
  directMessageReadRefusal,
  createRecallTool,
  createRememberTool,
  createScheduleTools,
  DELEGATED_SESSION_ID_MARKER,
  MESSAGE_SEND_TOOL_NAME,
  reportsToHint,
  type ParsedSoul,
  type ScheduleDestination,
  loadStratusSkill,
  STRATUS_SKILL_PATH,
} from '@stratusagent/agents';
import type { AgentSource } from './agent-source.ts';
import type { MergeBatch } from './merge-batch.ts';
import { createApprovalBroker } from './approvals.ts';
import { createCredentialRequests } from './credential-requests.ts';
import { createDispatch } from './dispatch.ts';
import { createFleetReader } from './fleet.ts';
import { createMemoryPassHost, type MemoryPassModelRun } from './memory-passes.ts';
import { createRecovery } from './recovery.ts';
import { callShownWhole, readReviewReply, REVIEW_RULES, reviewCaseText } from './review.ts';
import {
  createEventIntake,
  summarizeEvents,
  type EventIntake,
} from './event-intake.ts';
import { SqliteEventStore } from './events.ts';
import {
  createSchedulerRuntime,
  isScheduleSessionId,
  SqliteScheduleStore,
  SCHEDULE_SESSION_ID_PREFIX,
  undeliveredSendError,
} from './schedules.ts';
import { ShardedSessionStore } from './sessions.ts';
import { createSubAgents } from './sub-agents.ts';
import { createSteering } from './steering.ts';
import { createTurnDispatch } from './turn-dispatch.ts';
import {
  type ChannelReloadOutcome,
  DEFAULT_CHANNEL_RELOAD_TIMEOUT_MS,
  DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
  DEFAULT_STOP_DRAIN_TIMEOUT_MS,
  GatewayStoppingError,
  type IntakeState,
  MAX_PAUSED_MESSAGE_LENGTH,
  PauseMessageError,
  readIntakeState,
  RESTARTING_TURN_ERROR,
  type RestartStatus,
  RestartUnsupportedError,
  STOPPING_TURN_ERROR,
  writeIntakeState,
} from './lifecycle.ts';
import type {
  DispatchInput,
  Gateway,
  GatewayChannelAdapter,
  GatewayOptions,
  GatewayPluginStatus,
  GatewayReviewRequest,
  ObserveInput,
  PendingApproval,
} from './types.ts';
import {
  crossIdentityError,
  isSubAgentSession,
  RESERVED_SESSION_METADATA_KEYS,
  reservedSessionMetadataKey,
  ROLLED_OVER_FROM_METADATA_KEY,
  ROLLED_OVER_SESSION_ID_MARKER,
  ROLLED_OVER_TO_METADATA_KEY,
  SUB_AGENT_SESSION_ID_MARKER,
} from './session-keys.ts';

export {
  claimHome,
  homeLockPath,
  HomeClaimedError,
  type HomeClaim,
} from './lock.ts';
export {
  SqliteSessionStore,
  ShardedSessionStore,
  FleetSessionIndex,
  SessionIdTakenError,
  tightenSqliteFile,
  type SqliteSessionStoreOptions,
  type ShardedSessionStoreOptions,
  type SessionIndexRow,
  type SessionListRow,
  type SessionReconcileReport,
} from './sessions.ts';
export {
  SqliteScheduleStore,
  createSchedulerRuntime,
  isScheduleSessionId,
  SCHEDULE_SESSION_ID_PREFIX,
  type PreviousRun,
  type ScheduleStoreLike,
  undeliveredSendError,
  type SchedulerLimits,
  type SchedulerRuntime,
  type SchedulerRuntimeOptions,
} from './schedules.ts';
export {
  SqliteEventStore,
  EVENT_BLOCK_MAX_BYTES,
  EVENT_DEDUP_WINDOW_MS,
  EVENT_DELIVERY_ROW_CAP,
  eventCoalescingKey,
  eventDispatchKey,
  eventSessionId,
  renderEventBlock,
  type AcceptedEventDelivery,
  type EventDeliveryRow,
  type EventDeliveryStatus,
  type EventFiringRow,
  type EventFiringStatus,
  type EventSourceActivity,
  type NewEventFiring,
  type RefusedEventDelivery,
} from './events.ts';
export { type MemoryPassDetail } from './memory-passes.ts';
// The review posture's fixed prompt and case, for the review-step eval
// (`packages/cli/eval/review-step`), which measures the prompt production
// sends rather than a copy of it.
export { REVIEW_RULES, readReviewReply, reviewCaseText, type ReviewCaseInput } from './review.ts';
export {
  createEventIntake,
  mapGithubDelivery,
  parseStandardWebhookEvent,
  verifyGithubSignature,
  verifyStandardWebhookSignature,
  DEFAULT_EVENT_MAX_BODY_BYTES,
  EVENT_SOURCE_REQUESTS_PER_MINUTE,
  type EventIntake,
  type EventIntakeCounters,
  type EventIntakeOptions,
  type EventIntakeRequest,
  type EventIntakeResponse,
  type EventSourceConfig,
  type EventSourceCounters,
  type EventSourceSummary,
  type EventsSummary,
  type EventTrigger,
} from './event-intake.ts';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import {
  loadPlugins,
  type LoadedPlugin,
  type PluginLoadFailure,
} from '@stratusagent/plugins';
import {
  BUILTIN_EXECUTOR_NAME,
  BUILTIN_MEMORY_STORE_NAME,
  BUILTIN_PROVIDER_NAMES,
  createDemoTool,
  createFileCredentialResolver,
  credentialValuesFor,
  resolveDaemonCredential,
  createHomeMemoryStore,
  drainSharedMemory,
  hasBracketedLegacyStateIn,
  createRuntimeProvider,
  describeServingModel,
  DEFAULT_STRATUS_AGENT,
  isRegisteredProviderName,
  loadChannelTransportSecrets,
  registeredProviderNameOf,
  loadOperatorSkills,
  loadRosterSouls,
  FALLBACK_ACTIVE_METADATA_KEY,
  loadSoulFile,
  withSoulFileLock,
  migrateLegacyMemory,
  PROVIDER_STATE_METADATA_KEYS,
  ConfigFileError,
  loadConfigFile,
  resolveConfigLocation,
  resolveConfiguredSoul,
  resolveRuntimeConfig,
  runsOnHarness,
  applySoulPins,
  assertStateCompatible,
  unlistedToolsFor,
  stratusHomePath,
  fleetDbIn,
  createAgentWorkspaces,
  createPluginStateDirectories,
  createHostProtectedPaths,
  type FallbackRuntime,
  type OperatorSkillInfo,
  type RosterEntry,
  type RuntimeConfig,
  type RuntimeSelection,
  foldedAgentId,
} from '@stratusagent/state';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/**
 * How long a parked call waits for a person. Long enough to survive a
 * meeting, short enough that a request nobody saw does not hold a turn (and
 * the Slack thread it is answering) open indefinitely.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 900_000;
/**
 * Node's largest `setTimeout` delay. Anything above it does not become a
 * long wait — it silently becomes a 1ms one, so a config asking for a
 * 30-day approval window would expire every request almost immediately.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * A soul's provider/model pins, and the daemon-wide defaults they demote.
 *
 * The implementation lives in `@stratusagent/state`, beside the resolver
 * whose precedence it manipulates — it never had a gateway dependency. It is
 * re-exported here because this is where callers were told to import it from,
 * and because "what will a served agent actually resolve to" is a gateway
 * question even when the rule answering it is not gateway code.
 */
export { applySoulPins, type SoulPinContext } from '@stratusagent/state';

/**
 * The always-on Stratus process. One gateway holds the roster, the durable
 * session store, the shared event bus, and a pool of runners keyed by
 * resolved provider configuration — each agent runs on its own provider,
 * model, and credentials, delegation included.
 */
export const createGateway = (options: GatewayOptions = {}): Gateway => {
  const env = options.env ?? {};
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const bus = new EventBus({
    onError: (error) => warn(`event handler failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  // The default state directory is the gateway-owned ~/.stratus, which is
  // tightened to owner-only; a caller-supplied one may sit in a shared
  // directory that must not be chmodded from under other processes.
  const stateDir = options.stateDir ?? stratusHomePath(env);
  const store = new ShardedSessionStore({
    stateDir,
    ...(options.stateDir ? {} : { ownedDirectory: true }),
  });
  // The built-in store, behind a route that can change its mind: the memory
  // tools and every runner are built before a plugin has loaded, so the
  // store they hold is the one that answers *per call* with whichever was
  // selected once the plugins are up. Per call, not per start, is also
  // what keeps a contributed store per-agent-resolvable rather than
  // process-global.
  const fileMemory = createHomeMemoryStore(env);
  let selectedMemory: AgentMemoryStore = fileMemory;
  // The built-in store takes a list in `supersedes`; a plugin's says so.
  let selectedMemorySupersedesMany = true;
  const memory = createRoutedMemoryStore(() => selectedMemory);
  let selectedExecutor: Executor | undefined;

  // What loaded plugins contributed besides tools and skills. The loader
  // commits into these; the gateway reads them by name — a provider when a
  // runner is built, the executor and memory store once at start, the
  // channels when serving begins.
  const providerContributions = new ContributionRegistry<ProviderContribution>();
  const channelContributions = new ChannelRegistry();
  for (const claim of options.hostChannelClaims ?? []) {
    channelContributions.claim(claim.kind, claim.agents);
  }
  const memoryContributions = new ContributionRegistry<MemoryStoreContribution>();
  const executorContributions = new ContributionRegistry<ExecutorContribution>();
  // The guards plugins registered (a budget), asked before every model call
  // any runner below makes, sub-agents' included. Filled by the loader at
  // start, before the first runner is built.
  const providerCallGuards: ProviderCallGuard[] = [];

  // ---- schedules ----------------------------------------------------------

  // The same database sessions live in — one file to back up — through the
  // schedule store's own connection (see its docs for why).
  const scheduleStore = new SqliteScheduleStore(fleetDbIn(stateDir), { stateHome: stateDir });

  // ---- events (card 590) ---------------------------------------------------

  // Opened for the first source, so a daemon that never takes events never
  // grows the tables: at construction for the config's sources, or when the
  // first plugin feeding a source loads (phase 2), which is at start(),
  // before the scheduler's start-up pass. Its own connection to fleet.db,
  // like schedules'.
  const eventSources = options.events?.sources ?? {};
  /** Sources plugins feed: source id to the package that declared it, filled as each loads. */
  const pluginEventSources = new Map<string, string>();
  const eventSourceIds = (): string[] => [...Object.keys(eventSources), ...pluginEventSources.keys()];
  let eventStore: SqliteEventStore | undefined;
  let eventIntake: EventIntake | undefined;
  const openEvents = (): { store: SqliteEventStore; intake: EventIntake } => {
    if (!eventStore || !eventIntake) {
      eventStore = new SqliteEventStore(fleetDbIn(stateDir), { stateHome: stateDir });
      eventIntake = createEventIntake({
        store: eventStore,
        sources: () => eventSources,
        pluginSources: () => [...pluginEventSources.keys()],
        // The daemon's own credential, read per delivery: a stored or
        // rotated secret works on the next one, with no restart.
        secret: (name) => resolveDaemonCredential(env, name),
        // The triggers are schedules: `schedule.on` rows on this source.
        // Late-bound, because the scheduler is built further down.
        triggers: (sourceId) => scheduler.eventTriggers(sourceId),
        ...(options.events?.maxBodyBytes !== undefined ? { maxBodyBytes: options.events.maxBodyBytes } : {}),
        warn,
      });
    }
    return { store: eventStore, intake: eventIntake };
  };
  if (Object.keys(eventSources).length > 0) {
    openEvents();
  }

  const startedChannels: GatewayChannelAdapter[] = [];

  /**
   * The started adapter of one kind that speaks for an agent and has the
   * capability asked for. `carriesOthers` says there were capable adapters
   * of that kind, just none carrying this agent, which callers word
   * differently from there being none at all.
   *
   * One kind may be served by several adapters carrying disjoint
   * agents — two plugins, or the host's adapter beside a plugin's — and
   * the one that speaks for this agent is the one whose claims include
   * it: a contribution's agent list, or the host's declared claims for
   * an adapter no plugin contributed. A host that declared no claims for
   * the kind left its adapter unclaimed, and an unclaimed adapter speaks
   * for anyone, as the single host adapter always did. A claim miss is
   * a refusal, never the first adapter that happens to be running: that
   * adapter posts under another agent's transport identity, and it is
   * exactly what a failed start of the right adapter would leave behind.
   */
  const channelCarrying = (
    kind: string,
    agentId: string,
    capable: (candidate: GatewayChannelAdapter) => boolean,
  ): { adapter?: GatewayChannelAdapter; carriesOthers: boolean } => {
    const candidates = startedChannels.filter((candidate) => candidate.name === kind && capable(candidate));
    const contributed = channelContributions.list();
    const hostClaims = (options.hostChannelClaims ?? []).filter((claim) => claim.kind === kind);
    const carries = (candidate: GatewayChannelAdapter): boolean => {
      const entry = contributed.find((contribution) => contribution.adapter === candidate);
      if (entry) {
        return entry.agents.includes(agentId);
      }
      return hostClaims.length === 0 || hostClaims.some((claim) => claim.agents.includes(agentId));
    };
    const adapter = candidates.find(carries);
    return adapter ? { adapter, carriesOthers: false } : { carriesOthers: candidates.length > 0 };
  };

  /**
   * The write side of an addressable destination, through whichever
   * started channel serves its kind. Resolution happens per call against
   * the live adapter list, so a channel that failed to start is honestly
   * "cannot address" rather than a stale reference — and rejecting is how
   * both callers (schedule creation, `message.send`) hear why.
   */
  const outboundFor = async (
    agentId: string,
    destination: ScheduleDestination,
    thread?: string,
    speaker?: { sessionId: string; trust: TrustLevel },
  ): Promise<{ post(text: string): Promise<unknown> }> => {
    const { adapter, carriesOthers } = channelCarrying(destination.channel, agentId, (candidate) => candidate.resolveOutbound !== undefined);
    if (!adapter?.resolveOutbound && carriesOthers) {
      throw new Error(
        `No running '${destination.channel}' channel carries agent ${agentId} — `
        + `the running ${destination.channel} adapters carry other agents, so a message from ${agentId} has no transport identity to post under.`,
      );
    }
    if (!adapter?.resolveOutbound) {
      throw new Error(
        `No running channel can deliver to '${destination.channel}' destinations — `
        + (startedChannels.length === 0
          ? 'no channel adapters are running.'
          : `running channels: ${startedChannels.map((candidate) => candidate.name).join(', ')}.`),
      );
    }
    return adapter.resolveOutbound({ agentId, to: destination.to, ...(thread !== undefined ? { thread } : {}), ...(speaker !== undefined ? { speaker } : {}) });
  };

  const scheduler = createSchedulerRuntime({
    store: scheduleStore,
    // Late-bound on purpose: firings go through the gateway's own dispatch
    // path — single-flight, watchdog, refusal while stopping — never a
    // second runner. Through the firing-only entry, which is allowed into
    // the reserved `schedule:` namespace the public `dispatch` refuses.
    dispatch: (input) => dispatchScheduledFiring(input),
    validateDestination: async (agentId, destination) => {
      await outboundFor(agentId, destination);
    },
    sessionStatus: async (sessionId) => (await store.get(sessionId))?.status,
    // Card 858: the previous firing, for the next one's checkpoint. The
    // reply and its label, never the transcript.
    previousRun: async (sessionId) => {
      const session = await store.get(sessionId);
      if (!session) {
        return undefined;
      }
      const reply = latestTurnReply(session);
      return {
        status: session.status,
        ...(session.stoppedEarly !== undefined ? { stoppedEarly: session.stoppedEarly } : {}),
        ...(reply !== undefined ? { reply } : {}),
        trust: sessionWriteTrust(session),
      };
    },
    // AGT-335: a completed firing that tried to report and never got
    // through. Tool results only, never the transcript's words.
    undeliveredSend: async (sessionId, destination) => {
      const session = await store.get(sessionId);
      return session ? undeliveredSendError(session, destination) : undefined;
    },
    // The runtime's own line, so no speaker: it is nobody's turn to hear.
    notify: async (agentId, destination, text) => {
      const connection = await outboundFor(agentId, destination, destination.thread);
      await connection.post(text);
    },
    hasAgent: (agentId) => registry.get(agentId) !== undefined,
    ...(options.schedules ? { limits: options.schedules } : {}),
    // The same stamp check every turn runs, before a slot is claimed — see
    // `SchedulerRuntimeOptions.ready`.
    ready: () => assertStateCompatible(env),
    paused: () => intakeState.paused,
    ...(eventStore ? { events: { store: eventStore, sources: eventSourceIds } } : {}),
    log,
    warn,
  });

  // ---- approval brokering -------------------------------------------------

  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  // Refused at construction, not absorbed: a negative or NaN timeout fails
  // the `> 0` test below and quietly means "never expire" — the one
  // behavior documented for an explicit 0, and the last one a caller who
  // typed a bad number wants. Config-file values are already rejected with
  // a better message; this catches the programmatic path.
  if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 0) {
    throw new Error(
      `approvalTimeoutMs must be a non-negative number of milliseconds (0 to wait indefinitely); received ${String(options.approvalTimeoutMs)}.`,
    );
  }
  // Clamped, not trusted: a delay past Node's timer range is not a long
  // wait, it is a 1ms one, so an over-large value would turn every approval
  // into an instant expiry — the opposite of what it asked for. The CLI
  // rejects these at config load with a better message; this is the
  // backstop for a programmatic caller.
  const effectiveApprovalTimeoutMs = Math.min(approvalTimeoutMs, MAX_TIMER_DELAY_MS);
  if (approvalTimeoutMs > MAX_TIMER_DELAY_MS) {
    warn(
      `approval timeout ${approvalTimeoutMs}ms is above Node's maximum timer delay; using ${MAX_TIMER_DELAY_MS}ms (~24.8 days)`,
    );
  }

  // `stopping` is read late: it is declared further down, with shutdown.
  const {
    pendingApprovals,
    approvalEmissions,
    liveSubAgentIds,
    idAtFirstCall,
    hostIdOf,
    isHostSubAgent,
    requestApproval,
    resolveApproval,
    suspendWatchdog,
    approvalWaits,
    holdApprovalWait,
  } = createApprovalBroker({
    warn,
    bus,
    store,
    scheduler,
    effectiveApprovalTimeoutMs,
    isStopping: () => stopping,
  });










  const configuredApprovals = typeof options.approvals === 'function'
    ? options.approvals({
        request: requestApproval,
        // Late-bound: the side call is built further down this function.
        review: (request) => reviewCall(request),
        // Rejects when the soul or the credential store can't be read: the
        // permission engine then asks a person, rather than checking the
        // call against no secrets at all.
        secretsFor: async (agentId) => {
          const { definition } = await refreshAgent(agentId);
          return credentialValuesFor(createFileCredentialResolver(env), definition);
        },
        // Late-bound like `review`: the set is declared with the side call.
        offPath: (task) => keepUntilStopped(task),
        destinations: {
          isPreauthorized: (session, destination) => scheduler.isPreauthorized(session, destination),
          accountFor: (agentId, destination) => {
            const separator = destination.indexOf(':');
            if (separator <= 0) {
              return undefined;
            }
            const kind = destination.slice(0, separator);
            return channelCarrying(kind, agentId, (candidate) => candidate.accountFor !== undefined)
              .adapter?.accountFor?.(agentId);
          },
          conversationKindFor: async (agentId, destination) => {
            const separator = destination.indexOf(':');
            if (separator <= 0) {
              return undefined;
            }
            const kind = destination.slice(0, separator);
            const adapter = channelCarrying(kind, agentId, (candidate) => candidate.conversationKindFor !== undefined).adapter;
            try {
              return await adapter?.conversationKindFor?.(agentId, destination.slice(separator + 1));
            } catch {
              // Unknown, so the call asks: never a reason to allow.
              return undefined;
            }
          },
        },
        contributorOf: (toolName) => toolProvenance().get(toolName)?.package,
      })
    : options.approvals;

  /**
   * A live firing's refused message.send, told where its schedule reports
   * (AGT-336). The policy refuses before the tool runs, so the tool's own
   * hint for a send the channel rejected (AGT-335) never sees it, and a
   * headless refusal alone leaves the agent nowhere to retry. Only the
   * agent's words change: the policy has already reported its decision in
   * its own words, so the log and `permission.decided` read as before. A
   * send that named the schedule's destination was refused for some other
   * reason, and any other session gets the policy's answer untouched.
   */
  const withRefusalReportHint = (context: ApprovalContext, answer: boolean | ApprovalRefusal): boolean | ApprovalRefusal => {
    if (context.call.toolName !== MESSAGE_SEND_TOOL_NAME) {
      return answer;
    }
    const reportsTo = scheduler.approvalDestinationFor(context.session);
    if (reportsTo === undefined || context.tool.destinationFor?.(context.call.input) === canonicalDestination(reportsTo)) {
      return answer;
    }
    const given = typeof answer === 'object' && answer !== null && typeof answer.reason === 'string' ? answer.reason.trim() : '';
    // The runner's own words for a refusal that gave none, kept.
    const reason = given || `Tool call denied by approval policy: ${context.call.toolName}`;
    return { allowed: false, reason: `${reason}${/[.!?…]$/.test(reason) ? '' : '.'} ${reportsToHint(reportsTo)}` };
  };

  /**
   * Every approval opens a tool phase, whatever policy answers it.
   *
   * `tool.approval-requested` is the broker's event, so it exists only for
   * the remote path; a policy handed straight to the gateway emits nothing
   * at all, and `tool.called` comes only *after* the answer. Without this,
   * a slow custom policy on a streaming provider that hosts its own loop
   * would be indistinguishable from a stalled turn — the case this
   * watchdog work exists to stop, arriving through a different door.
   */
  const approvals: ApprovalPolicy | undefined = configuredApprovals
    ? {
        async approve(context) {
          const release = holdApprovalWait(context.session.id);
          try {
            const answer = await configuredApprovals.approve(context);
            return answer === true ? answer : withRefusalReportHint(context, answer);
          } finally {
            // Every path out, including a policy that throws. What happens
            // after the answer is the tool events' business, and they are
            // observed by the watchdog itself.
            release();
          }
        },
      }
    : undefined;
  const registry = new AgentRegistry();
  const sources = new Map<string, AgentSource>();

  // ---- roster -------------------------------------------------------------

  const registerSource = (source: AgentSource): void => {
    registry.register(source.definition);
    sources.set(source.definition.id, source);
  };

  /**
   * An id already registered that would open `agentId`'s state directory
   * while being a different id — `ava` when asked about `Ava`, on the
   * filesystems that fold them together.
   *
   * `foldedAgentId` owns which pairs those are. What this adds is the
   * "already registered" half, for the one registration that does not come
   * through `loadRosterSouls` and so was never folded against anything.
   */
  const stateDirectoryPeer = (agentId: string): string | undefined => {
    const folded = foldedAgentId(agentId);
    for (const other of sources.keys()) {
      if (other !== agentId && foldedAgentId(other) === folded) {
        return other;
      }
    }
    return undefined;
  };

  /**
   * The agent an agentId-less dispatch routes to: the configured default
   * soul when one is set (what `stratus setup` writes to config.json),
   * the built-in Stratus definition otherwise. Re-resolved per call so an
   * edited default soul reaches conversations without a restart — the
   * runtime config already re-reads it, and the identity (persona, tool
   * allowlist, memory id) must follow along, not stay pinned to the
   * built-in definition.
   */
  let lastDefaultAgentId: string | undefined;
  /**
   * What the last default resolution read, for the roster load to judge
   * — the soul is re-read on every resolution, so a `tools:` key removed
   * after startup is seen here, where the registered source would still
   * carry the old definition until the next dispatch refreshes it.
   */
  let lastDefaultResolved: { soul: ParsedSoul; path: string } | undefined;
  // The last successfully loaded config snapshot, serving dispatches while
  // the file on disk is temporarily broken (an operator mid-edit).
  let lastGoodConfigSnapshot: NonNullable<RuntimeSelection['presetConfig']> | undefined;
  /**
   * Read from the home once, on first use, which is after the migrations
   * `serve` runs before it starts the gateway. It changes only when 0005
   * first records it, and that happens before a daemon of this build runs.
   */
  let unlistedToolsRead: UnlistedTools | undefined;
  const unlistedTools = (): UnlistedTools => options.unlistedTools ?? (unlistedToolsRead ??= unlistedToolsFor(env));
  /**
   * Said at load, because an omitted `tools` list is a quiet downgrade on a
   * home this build set up: it is only the tools registered as safe, so an
   * agent whose soul never wrote the key cannot run a shell, write a file
   * or send a message, and nothing else says why. On a home an older build
   * set up it is every tool, as it always was there, and the line says so
   * the way it always did. The built-in agent is exempt: it has no file,
   * and says `tools: ["*"]` in code.
   */
  const warnNoToolsList = (agentId: string, soulPath: string): void => {
    warn(unlistedTools() === 'every'
      ? `agent ${agentId} has no tools: list, so it may call every tool this daemon loads — `
        + `add tools: [...] to ${soulPath} to say which`
      : `agent ${agentId} has no tools: list, so it gets only safe tools (reads and memory) — `
        + `add tools: [...] to ${soulPath} to give it more, or tools: ["*"] for every tool`);
  };

  const defaultAgentId = async (): Promise<string> => {
    // Identity only — never full runtime resolution: credential checks do
    // not belong here, or a daemon default provider without installed keys
    // would throw while the soul pins a provider that has them, taking
    // loadRoster (and the whole gateway) down with it. Provider resolution
    // happens at dispatch, where pin demotion applies.
    let resolved: { soul: ParsedSoul; path: string } | undefined;
    try {
      resolved = await resolveConfiguredSoul({ ...options.selection }, env);
    } catch (error) {
      warn(`could not load the configured default soul: ${error instanceof Error ? error.message : String(error)}`);
      // A transiently unreadable default keeps routing to the last known
      // default agent (whose source serves from cache) rather than
      // silently switching identities to the built-in.
      return lastDefaultAgentId ?? DEFAULT_STRATUS_AGENT.id;
    }
    if (!resolved) {
      // The operator removed the default soul on purpose: the built-in is
      // now the cached answer too, so a later transient read failure
      // cannot resurrect the retired soul's identity.
      lastDefaultAgentId = DEFAULT_STRATUS_AGENT.id;
      lastDefaultResolved = undefined;
      return DEFAULT_STRATUS_AGENT.id;
    }
    const id = resolved.soul.agent.id;
    // The roster refuses two *souls* whose ids name one state directory,
    // but this soul never went through it: a config-only default is
    // resolved here, by path, and registered by exact id. So `Ava` in
    // config beside `ava` on the roster — or `Stratus` beside the built-in
    // — passed as two agents sharing one `agents/<id>/`, which is one
    // `whitelist.json` and therefore one agent acting on the other's
    // unattended grants.
    //
    // Warned and dropped rather than thrown: this runs on every
    // agentId-less dispatch, and a configuration mistake must not turn
    // every such turn into an error. Dropping routes to the built-in,
    // which is the documented answer when there is no usable default, and
    // leaves the colliding agent serving from its own directory alone.
    const peer = stateDirectoryPeer(id);
    if (peer !== undefined) {
      warn(
        `the configured default soul at ${resolved.path} declares the agent id ${id}, which names the same `
        + `state directory as ${peer} — sessions, memories, and the grants that say what may run unattended. `
        + `Ignoring it and routing to ${DEFAULT_STRATUS_AGENT.id}; rename one of the two ids.`,
      );
      lastDefaultAgentId = DEFAULT_STRATUS_AGENT.id;
      lastDefaultResolved = undefined;
      return DEFAULT_STRATUS_AGENT.id;
    }
    lastDefaultResolved = resolved;
    // The normal setup layout has the default soul in ~/.stratus/agents
    // too: keep the roster registration — its soulPath drives per-dispatch
    // refresh. A config-only soul registers with the path it resolved
    // from, so it refreshes (and keeps its pins current) exactly like a
    // roster soul, resumed sessions included. A repointed config (same
    // agent id, different file) replaces the source, or moves and
    // replacements would silently keep refreshing the old file.
    const existing = sources.get(id);
    const pathChanged = Boolean(existing?.soulPath && existing.soulPath !== resolved.path);
    if (!existing?.soulPath || pathChanged) {
      registerSource({
        definition: resolved.soul.agent,
        soul: resolved.soul,
        soulPath: resolved.path,
      });
    }
    lastDefaultAgentId = id;
    return id;
  };

  /**
   * Build the roster from what is on disk right now.
   *
   * Runs at start and again on every `reloadRoster()`, which is why it
   * tracks what it registered rather than only adding: a soul file deleted
   * since the last pass has to stop being dispatchable, and re-registering
   * the survivors over a map nothing removes from would leave it addressable
   * — by id, and from every channel — for the rest of the daemon's life.
   */
  const loadRoster = async (): Promise<void> => {
    const seen = new Set<string>();
    const registerFresh = (source: AgentSource): void => {
      registerSource(source);
      seen.add(source.definition.id);
    };

    // The built-in id is reserved BEFORE ordinary roster entries load: a
    // roster file that happens to declare id "stratus" must not hijack
    // the documented built-in fallback for agentId-less dispatches — the
    // guard below skips it with a warning. Only the explicitly
    // configured default soul may take the id over (defaultAgentId
    // replaces a pathless source).
    registerFresh({ definition: { ...DEFAULT_STRATUS_AGENT } });
    // Throws on two roster files claiming one id: that is a collision with
    // no correct winner, and refusing to serve beats letting sort order
    // decide whose sessions, memory, and credentials an agent inherits.
    const entries: RosterEntry[] = await loadRosterSouls(env, warn);
    // Which souls this pass named for having no tools: list, so the
    // configured default is not named twice when it is one of them.
    const namedThisPass = new Set<string>();
    for (const entry of entries) {
      // Against ids claimed by THIS pass, not by any earlier one: a reload
      // must be free to re-register the agent it just re-read, and only the
      // built-in above can legitimately block a roster file.
      if (seen.has(entry.soul.agent.id)) {
        // Only reachable for the reserved built-in id now — roster-vs-
        // roster duplicates never get this far. Reserved is not the same
        // failure as duplicated: a soul may not take the fallback over,
        // and must not be able to take the daemon down by trying.
        warn(`agent id ${entry.soul.agent.id} is reserved for the built-in agent; ignoring ${entry.path}`);
        continue;
      }
      registerFresh({ definition: entry.soul.agent, soulPath: entry.path, soul: entry.soul });
      if (entry.soul.agent.tools === undefined) {
        warnNoToolsList(entry.soul.agent.id, entry.path);
        namedThisPass.add(entry.path);
      }
    }
    // The configured default soul is part of the roster too — it is what
    // an agentId-less dispatch answers as. It may live outside the agents
    // directory, and it survives a read failure by name, so what it
    // resolves to is kept whether or not this pass re-registered it.
    const defaultId = await defaultAgentId();
    seen.add(defaultId);
    // The same notice for a default soul that lives outside the agents
    // directory — the one path into the roster that skips the loop above
    // — on every load, judged on what the resolution just read rather
    // than on the registered source, so a key removed after startup is
    // reported at the next reload. A roster-backed default was named by
    // the loop, and is not named twice.
    if (lastDefaultResolved !== undefined
      && lastDefaultResolved.soul.agent.tools === undefined
      && !namedThisPass.has(lastDefaultResolved.path)) {
      warnNoToolsList(defaultId, lastDefaultResolved.path);
    }

    for (const id of [...sources.keys()]) {
      if (!seen.has(id)) {
        sources.delete(id);
        registry.unregister(id);
      }
    }

    // Advisory, per the skills spec: a skill may say which toolsets its
    // procedure expects (`requires:`), and an agent enabling it without
    // them gets a warning at load — never a refusal, because a skill is
    // prose and can degrade. The check itself is the kernel's
    // (`missingSkillRequirements`), shared with the CLI's local runs so
    // both hosts warn about the same configuration.
    //
    // The tools advisory rides along, and belongs to THIS load rather
    // than the skills reload below: the registry only gains tools when
    // plugins load, which happens once, before the roster (see `start`).
    // An entry naming a tool nobody registered does nothing, and a whole
    // allowlist of them grants an agent nothing — which is not a quiet
    // degradation, because a persona that still says "use memory.remember"
    // then meets a provider that was shown no such tool, and a model told
    // to use a tool it has not got tends to write the call out as prose,
    // with a plausible result attached.
    const registeredTools = tools.describe().map((tool) => tool.name);
    // Namespaces a loaded plugin is allowed to fill later, so a bridge
    // whose server is still reconnecting is not reported as a typo.
    const discoveredNamespaces = loadedPlugins.flatMap(
      (plugin) => plugin.manifest.contributes.toolsDiscovered.map((declared) => declared.namespace),
    );
    for (const agent of registry.list()) {
      for (const { skill, missing } of missingSkillRequirements(agent, skillCatalog)) {
        warn(`agent ${agent.id} enables skill ${skill.id}, which expects tools the agent is not allowed: ${missing.join(', ')}`);
      }
      const finding = unmatchedToolAllowlist(agent, registeredTools, {
        mayRegister: discoveredNamespaces,
      });
      for (const line of finding ? describeToolAllowlistFinding(agent.id, finding) : []) {
        warn(line);
      }
    }
  };

  /**
   * Rebuild the skill catalog from what is on disk right now, into a fresh
   * registry, and swap it in whole. See `Gateway.reloadSkills`.
   *
   * Strict on the operator directory: the previous set is still serving,
   * so a file that will not load is a reason to keep it, not to serve the
   * rest. The plugins' skills are re-registered from the load records, in
   * load order, after the operator's — the order `start()` used, which is
   * what makes an operator's bare id win its alias and a bare id two
   * plugins want stay contested. Nothing is imported again: a plugin is
   * code, and code gets a restart.
   */
  const loadSkills = async (): Promise<void> => {
    const next = new SkillRegistry();
    await registerBuiltinSkills(next, true);
    const operator = await loadOperatorSkills(env, next, warn, { strict: true });
    for (const plugin of loadedPlugins) {
      for (const record of plugin.skills) {
        // The live catalog holds the very `Skill` the loader staged, under
        // its canonical id; a rebuild re-registers that object rather than
        // re-reading the plugin's file, so a plugin's skills are exactly
        // what loaded with it until it is loaded again.
        const skill = skillCatalog.resolve(record.id);
        if (!skill) {
          throw new Error(`Plugin ${plugin.package} lists skill ${record.id}, but the catalog no longer holds it. Restart the daemon.`);
        }
        next.register(skill);
        next.registerAlias(record.bareId, skill.id);
      }
    }

    const before = new Set(operatorSkills.map((skill) => skill.id));
    const after = new Set(operator.map((skill) => skill.id));
    skillCatalog.replaceWith(next);
    operatorSkills = operator;

    const added = operator.filter((skill) => !before.has(skill.id)).map((skill) => skill.id);
    const removed = [...before].filter((id) => !after.has(id));
    const change = [
      ...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
      ...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
    ];
    log(`skills reloaded — ${skillCatalog.list().length} skill(s)${change.length > 0 ? `: ${change.join('; ')}` : ' (no change)'}`);
    // The same advisory check the roster load runs: a removed skill an
    // agent still lists, or a new one whose `requires:` the agent's tools
    // do not cover, is worth a line now rather than at the next restart.
    for (const agent of registry.list()) {
      for (const { skill, missing } of missingSkillRequirements(agent, skillCatalog)) {
        warn(`agent ${agent.id} enables skill ${skill.id}, which expects tools the agent is not allowed: ${missing.join(', ')}`);
      }
    }
  };

  /**
   * Roster and skill rebuilds, one at a time.
   *
   * `loadRoster` prunes by comparing the registry against the ids *this pass*
   * saw, so two overlapping passes destroy each other's work: the older one
   * snapshots a roster without agent B, the newer one registers B and
   * finishes, and then the older one reaches its prune and unregisters B —
   * which two clients creating agents at once will do, each having been told
   * 201 for an agent that is no longer dispatchable. Skill reloads share the
   * chain: each is a whole-catalog swap, and the roster load reads the
   * catalog for its advisory warnings.
   *
   * A chain rather than a lock: a reload is idempotent, so a caller arriving
   * mid-rebuild wants the *next* complete one, and waiting for it is exactly
   * what this gives them.
   */
  let reloads: Promise<unknown> = Promise.resolve();
  const reloadsInOrder = async (work: () => Promise<void>): Promise<void> => {
    const next = reloads.then(work, work);
    // Swallowed for the chain only — the caller still sees the rejection, but
    // a roster that failed to load must not block every reload after it.
    reloads = next.catch(() => undefined);
    await next;
  };

  const channelReloadTimeoutMs = options.channelReloadTimeoutMs ?? DEFAULT_CHANNEL_RELOAD_TIMEOUT_MS;

  /**
   * After a roster reload, each started channel that can picks up the
   * agents it carries now (a new agent's stored app, one whose soul or
   * secrets are gone). One at a time, in start order, so the log reads in
   * the order an operator configured them. A channel that fails is
   * logged and the rest still reload: one bad app must not hold back the
   * others, the rule `startChannels` follows. A channel still reloading
   * after the bound is left to finish on its own, and what it ends with is
   * logged then, so a hung Slack call cannot hold every later reload.
   */
  const reloadChannels = async (): Promise<ChannelReloadOutcome[]> => {
    const outcomes: ChannelReloadOutcome[] = [];
    for (const adapter of [...startedChannels]) {
      if (stopping || channelsClosed) {
        return outcomes;
      }
      if (typeof adapter.reload !== 'function') {
        continue;
      }
      const reload = adapter.reload.bind(adapter);
      // Settles with the failure, never rejects: one that comes after the
      // bound has nobody awaiting it, and would take the daemon down.
      const settled = (async () => reload())().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), channelReloadTimeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([settled.then((failure) => ({ failure })), bound]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        warn(`channel ${adapter.name} is still reloading after ${channelReloadTimeoutMs} ms; the roster reload goes on without it`);
        void settled.then((failure) => {
          if (failure !== undefined) {
            warn(`channel ${adapter.name} could not reload: ${failure}`);
          } else {
            log(`channel ${adapter.name} finished reloading`);
          }
        });
        outcomes.push({ name: adapter.name, outcome: 'still-reloading' });
        continue;
      }
      if (outcome.failure !== undefined) {
        warn(`channel ${adapter.name} could not reload: ${outcome.failure}`);
        outcomes.push({ name: adapter.name, outcome: 'failed', reason: outcome.failure });
        continue;
      }
      outcomes.push({ name: adapter.name, outcome: 'reloaded' });
    }
    return outcomes;
  };

  /**
   * A session pins its agent id, never a snapshot of the agent: the soul
   * file is re-read on every dispatch, so an edited persona (or tool
   * allowlist) reaches existing conversations on their next turn.
   */
  const refreshAgent = async (agentId: string): Promise<AgentSource> => {
    const source = sources.get(agentId);
    if (!source) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (source.soulPath) {
      let soul: ParsedSoul | undefined;
      try {
        soul = await loadSoulFile(source.soulPath);
      } catch (error) {
        warn(`could not refresh ${source.soulPath}: ${error instanceof Error ? error.message : String(error)}; keeping the loaded definition`);
        // Serve from cache WITHOUT the failing path: the dispatch resolves
        // from the cached soul snapshot, and the registered source keeps
        // its path for the next refresh attempt.
        return {
          definition: source.definition,
          ...(source.soul ? { soul: source.soul } : {}),
        };
      }
      if (soul.agent.id !== agentId) {
        // The file now belongs to a different agent. Serving this agent
        // anyway would resolve provider/model pins from that other
        // agent's soul — another identity's billing path — so the
        // dispatch is refused rather than run on ambiguous config.
        throw new Error(
          `Soul ${source.soulPath} now declares agent ${soul.agent.id}, not ${agentId} — refusing the dispatch so ${agentId}'s sessions cannot run on another agent's provider pins. Restore the soul's identity, or address the agent by its new id.`,
        );
      }
      const refreshed: AgentSource = { definition: soul.agent, soulPath: source.soulPath, soul };
      registerSource(refreshed);
      return refreshed;
    }
    return source;
  };

  const agentWorkspaces = createAgentWorkspaces(env);
  /**
   * What an agent is told about how it runs, from the source this dispatch
   * refreshed and never from `sources` again. The persona the turn runs on
   * came from that snapshot, and a repointed default soul can replace the
   * registered source while the turn is still in preflight: read afresh,
   * the agent would be told a file it is not running on is its soul.
   *
   * `soulReloads` is true because `refreshAgent` re-reads the file on every
   * dispatch. A refresh that failed serves from cache and carries no path,
   * so the agent is told nothing about a soul file for that turn rather
   * than something the daemon could not just read. The built-in agent has
   * no file, so it is told only where its workspace is.
   *
   * The language and the model come from the config this same dispatch
   * resolved for that source, for the same reason: the turn runs on it.
   */
  const runtimeContextFor = (
    source: AgentSource,
    config: RuntimeConfig,
    onFallback: boolean,
    // The turn's own metadata, where a channel records who can read the
    // conversation now; a recovered turn has none and passes the session's.
    metadata: JsonObject | undefined,
    // A sub-agent has no soul of its own, and its parent's is not its to edit.
    subAgent = false,
  ): AgentRuntimeContext => {
    const conversation = conversationContextFrom(metadata);
    return {
      ...(source.soulPath !== undefined && !subAgent ? { soulPath: source.soulPath, soulReloads: true } : {}),
      workspace: agentWorkspaces.forAgent(source.definition.id),
      ...(config.language !== undefined ? { language: config.language } : {}),
      model: describeServingModel(config, onFallback),
      ...(conversation !== undefined ? { conversation } : {}),
    };
  };

  // ---- runner pool --------------------------------------------------------

  const tools = new ToolRegistry();
  // Which package each tool came from. Kernel tools are absent from this
  // map, which is how `tools()` reports them as the kernel's. Derived per
  // read from the plugins' live tool records rather than snapshotted at
  // load, because the records can change while the daemon runs: a bridge
  // registers what its server advertises, and a tool discovered on
  // reconnect would otherwise show as the kernel's.
  const toolProvenance = (): Map<string, { package: string; trusted: boolean }> => {
    const provenance = new Map<string, { package: string; trusted: boolean }>();
    for (const plugin of loadedPlugins) {
      for (const tool of plugin.tools) {
        provenance.set(tool.name, { package: plugin.package, trusted: plugin.trusted });
      }
    }
    return provenance;
  };
  let loadedPlugins: LoadedPlugin[] = [];
  let pluginFailures: PluginLoadFailure[] = [];
  const skillCatalog = new SkillRegistry();
  let operatorSkills: OperatorSkillInfo[] = [];
  /**
   * The skills that ship with Stratus, first into every catalog, so the id
   * is theirs before an operator directory or a plugin can claim it. A file
   * missing from a broken install is said once and costs the agents their
   * reference, never the daemon its start.
   */
  const registerBuiltinSkills = async (registry: SkillRegistry, reloading = false): Promise<void> => {
    try {
      registry.register(await loadStratusSkill());
    } catch (error) {
      // On a reload the swap keeps the copy already serving
      // (`SkillRegistry.replaceWith`), so only a start goes without it.
      const consequence = reloading ? 'the copy loaded at start keeps serving' : 'agents will not have it';
      warn(`the built-in stratus skill did not load (${error instanceof Error ? error.message : String(error)}); ${consequence}. Reinstall Stratus.`);
    }
  };
  tools.register(createDemoTool());
  tools.register(createRememberTool(memory));
  tools.register(createRecallTool(memory));
  tools.register(createForgetTool(memory));
  tools.register(createPinTool(memory));
  // Registered here rather than left to the first runner, so `tools()`
  // lists the reader before anything dispatches. The allowlist resolver
  // mirrors the runner's own sourcing — the definition travelling with the
  // session, then the roster — so the tool refuses exactly what the
  // runner's gates refuse.
  tools.register(createSkillReadTool(skillCatalog, {
    allowlistFor: (session) => session.agent.skills ?? registry.get(session.agent.id)?.skills,
  }));
  // Delegation is dispatcher-backed, not runner-capturing: the target agent
  // runs through the same per-provider routing as a direct dispatch, so a
  // delegated specialist uses their own provider and credentials.
  // Scheduling and outbound speech are gateway-registered for the same
  // reason delegation is: the tools need the dispatcher, the store, and
  // the channels, and the plugin context carries none of them. Souls still
  // opt in by allowlist (`schedule.*`, `message.send`) like any other tool.
  for (const scheduleTool of createScheduleTools(scheduler.handle)) {
    tools.register(scheduleTool);
  }
  tools.register(createMessageSendTool(async ({ agentId, destination, text, thread, speaker }) => {
    const connection = await outboundFor(agentId, destination, thread, speaker);
    const posted = await connection.post(text);
    // The channel contract's `OutboundMessageRef`, read structurally: the
    // gateway's mirror of the adapter types `post` loosely, and an adapter
    // that reports no id simply has none to hand back.
    const ts = typeof posted === 'object' && posted !== null ? (posted as { ts?: unknown }).ts : undefined;
    return typeof ts === 'string' && ts.length > 0 ? { id: ts } : {};
  }, {
    defaultThread: (session, destination) => scheduler.reportThreadFor(session, destination),
    // Bound exactly as an approval's destination is: a live firing, its schedule.
    reportsTo: (session) => scheduler.approvalDestinationFor(session),
  }));
  // A mid-task message goes where the conversation is, through the channel
  // carrying this agent there, and nowhere else (card 1009). A session no
  // channel started (a terminal run, a schedule nobody watches) has nobody
  // to say it to before the reply.
  tools.register(createMessageSayTool(async ({ session, text }) => {
    const agentId = session.agent.id;
    const kind = session.metadata?.channel;
    const { adapter } = typeof kind === 'string'
      ? channelCarrying(kind, agentId, (candidate) => candidate.say !== undefined)
      : { adapter: undefined };
    if (!adapter?.say) {
      throw new Error(typeof kind === 'string'
        ? `This conversation's channel (${kind}) cannot take a mid-task message. Say it in your reply.`
        : 'This conversation is not in a channel that can take a mid-task message. Say it in your reply.');
    }
    await adapter.say({ sessionId: session.id, agentId, text });
  }));
  // The same carrying rule again: a channel is created by the asking
  // agent's own app, whose token never leaves the adapter, and so becomes
  // that app's to post in and read.
  tools.register(createChannelCreateTool(async ({ agentId, channel, ...request }) => {
    const { adapter, carriesOthers } = channelCarrying(channel, agentId, (candidate) => candidate.createConversation !== undefined);
    if (!adapter?.createConversation) {
      throw new Error(carriesOthers
        ? `No running '${channel}' channel carries agent ${agentId}, so it has no app to create a channel with.`
        : `No running channel can create '${channel}' conversations.`);
    }
    return adapter.createConversation({ agentId, ...request });
  }));
  // Joining and inviting follow the same rule: the asking agent's own app
  // does it, so membership stays per app and its token stays in the adapter.
  tools.register(createChannelJoinTool(async ({ agentId, channel, conversation }) => {
    const { adapter, carriesOthers } = channelCarrying(channel, agentId, (candidate) => candidate.joinConversation !== undefined);
    if (!adapter?.joinConversation) {
      throw new Error(carriesOthers
        ? `No running '${channel}' channel carries agent ${agentId}, so it has no app to join a channel with.`
        : `No running channel can join '${channel}' conversations.`);
    }
    return adapter.joinConversation({ agentId, conversation });
  }));
  tools.register(createChannelInviteTool(async ({ agentId, channel, ...request }) => {
    const { adapter, carriesOthers } = channelCarrying(channel, agentId, (candidate) => candidate.inviteToConversation !== undefined);
    if (!adapter?.inviteToConversation) {
      throw new Error(carriesOthers
        ? `No running '${channel}' channel carries agent ${agentId}, so it has no app to invite anyone with.`
        : `No running channel can invite people to '${channel}' conversations.`);
    }
    return adapter.inviteToConversation({ agentId, ...request });
  }));
  /**
   * Why a `channel.archive` call would archive the conversation its work was
   * asked from, or can't tell, as a sentence; undefined when it may go on.
   * That conversation is never archived: the answer to it would have
   * nowhere to go, and the agent can't unarchive.
   *
   * An ordinary session is its own origin. A sub-agent's or a delegated
   * run's is the root turn that started the chain, read off the id the
   * host minted for it (each child id is its parent's plus a marker, so the
   * root is the text before the first one), never off metadata a tool in
   * the slice could rewrite. The id is the one the session had at its first
   * tool call, for the same reason. The origin's conversation is asked of
   * the adapter of this kind that carries the origin's agent. When it can't
   * be told (the root is gone; no adapter, no `sessionConversation`, a
   * lookup that fails, or no answer for a session whose id is this
   * channel's), the call is refused: an archive the agent can't undo
   * doesn't run on a guess. A session that isn't this channel's at all (an
   * API call, a schedule, a turn on another transport) has no conversation
   * here to protect.
   */
  const archiveRefusal = async (
    kind: string,
    conversation: string,
    session: Session,
    archiving: GatewayChannelAdapter,
  ): Promise<string | undefined> => {
    const unknown = (why: string): string =>
      `${kind} ${conversation} was not archived: ${why}, so Stratus can't tell which conversation this work was asked from, `
      + 'and that one is never archived. Ask for the archive from a conversation.';
    const id = hostIdOf(session);
    const marks = [SUB_AGENT_SESSION_ID_MARKER, DELEGATED_SESSION_ID_MARKER]
      .map((marker) => id.indexOf(marker))
      .filter((at) => at >= 0);
    let origin = { agentId: session.agent.id, sessionId: id };
    let adapter: GatewayChannelAdapter | undefined = archiving;
    if (marks.length > 0) {
      const rootId = id.slice(0, Math.min(...marks));
      let root: Session | undefined;
      try {
        root = rootId ? await store.get(rootId) : undefined;
      } catch (error) {
        warn(`${id}: could not read the root session ${rootId} to check a channel.archive (${error instanceof Error ? error.message : String(error)})`);
        root = undefined;
      }
      if (!root) {
        return unknown('this run was started by another session that no longer exists');
      }
      origin = { agentId: root.agent.id, sessionId: root.id };
      adapter = channelCarrying(kind, origin.agentId, () => true).adapter;
    }
    // Channel session ids lead with their kind (`channelSessionKey`).
    const onThisChannel = origin.sessionId.startsWith(`${kind}:`);
    if (!adapter) {
      return onThisChannel ? unknown(`no running '${kind}' channel carries the agent this work was asked of`) : undefined;
    }
    if (!adapter.sessionConversation) {
      return unknown(`the running '${kind}' channel can't say which conversation a session is in`);
    }
    let origins: string | undefined;
    try {
      origins = adapter.sessionConversation(origin.agentId, origin.sessionId);
    } catch (error) {
      warn(`${id}: could not tell which conversation ${origin.sessionId} is in to check a channel.archive (${error instanceof Error ? error.message : String(error)})`);
      return unknown(`the running '${kind}' channel couldn't say which conversation this work was asked from`);
    }
    if (origins === undefined) {
      return onThisChannel ? unknown(`the running '${kind}' channel can't say which of its conversations this work was asked from`) : undefined;
    }
    return origins === conversation
      ? `${kind} ${conversation} is the conversation this work was asked from, so it was not archived: `
        + 'the reply would have nowhere to go. Ask for the archive from another conversation.'
      : undefined;
  };
  const archivingAdapter = (kind: string, agentId: string) =>
    channelCarrying(kind, agentId, (candidate) => candidate.archiveConversation !== undefined);
  const noArchivingAdapter = (kind: string, agentId: string, carriesOthers: boolean): string => carriesOthers
    ? `No running '${kind}' channel carries agent ${agentId}, so it has no app to archive a channel with.`
    : `No running channel can archive '${kind}' conversations.`;
  tools.register(createChannelArchiveTool(async ({ agentId, channel, conversation }, session) => {
    const { adapter, carriesOthers } = archivingAdapter(channel, agentId);
    if (!adapter?.archiveConversation) {
      throw new Error(noArchivingAdapter(channel, agentId, carriesOthers));
    }
    const refusal = await archiveRefusal(channel, conversation, session, adapter);
    if (refusal !== undefined) {
      throw new Error(refusal);
    }
    return adapter.archiveConversation({ agentId, conversation });
  }, {
    // The same check before anyone is asked: an approval, Always allow
    // above all, for an archive that is bound to be refused is a question
    // with no useful answer. Held as an approval wait, like message.read's,
    // since it runs before any tool event and may read the store.
    refusalFor: async ({ agentId, channel, conversation }, session) => {
      const { adapter, carriesOthers } = archivingAdapter(channel, agentId);
      if (!adapter?.archiveConversation) {
        return noArchivingAdapter(channel, agentId, carriesOthers);
      }
      const release = holdApprovalWait(session.id);
      try {
        return await archiveRefusal(channel, conversation, session, adapter);
      } finally {
        release();
      }
    },
  }));
  tools.register(createMessageReadTool(async ({ agentId, source, ...window }) => {
    // The same carrying rule as outbound: a read goes through the app of
    // the agent asking, never whichever adapter of that kind is running,
    // because membership is the read boundary and it is per app.
    const { adapter, carriesOthers } = channelCarrying(source.channel, agentId, (candidate) => candidate.readConversation !== undefined);
    if (!adapter?.readConversation) {
      throw new Error(carriesOthers
        ? `No running '${source.channel}' channel carries agent ${agentId}, so it has no app to read ${source.to} with.`
        : `No running channel can read '${source.channel}' conversations.`);
    }
    return adapter.readConversation({ agentId, conversation: source.to, ...window });
  }, {
    // A direct message is refused before anyone is asked: approving a read
    // the channel will refuse anyway only teaches people to click yes.
    // Asked of the same app the read would go through; a channel that
    // cannot say leaves the call to ask, and its own rule still applies.
    // The one DM let through is the one this session lives in, by the
    // adapter's own `sessionConversation`, which its read checks again.
    // It is still gated like any read, so the policy is asked next.
    //
    // Held as an approval wait, because that is the phase it stands in
    // for: it runs before any tool event, so on a streaming provider that
    // hosts its own loop a slow lookup would otherwise read as a stalled
    // model and the watchdog would abort a healthy turn.
    refusalFor: async ({ agentId, sessionId, source }) => {
      const { adapter } = channelCarrying(source.channel, agentId, (candidate) => candidate.conversationKindFor !== undefined);
      if (!adapter?.conversationKindFor) {
        return undefined;
      }
      let kind: 'channel' | 'direct' | undefined;
      const release = holdApprovalWait(sessionId);
      try {
        kind = await adapter.conversationKindFor(agentId, source.to);
      } catch {
        kind = undefined;
      } finally {
        release();
      }
      if (kind !== 'direct') {
        return undefined;
      }
      let own: string | undefined;
      try {
        own = adapter.sessionConversation?.(agentId, sessionId);
      } catch {
        own = undefined;
      }
      return own !== undefined && own === source.to ? undefined : directMessageReadRefusal(`${source.channel}:${source.to}`);
    },
  }));
  const { provideCredential } = createCredentialRequests({
    env,
    warn,
    bus,
    startedChannels,
    channelCarrying,
    registry,
    sources,
    unlistedTools,
    tools,
  });






  // dispatchInternal and onSessionChain are declared further down: late-bound.
  const { bindToolCalls, subAgents } = createSubAgents({
    options,
    store,
    registry,
    unlistedTools,
    tools,
    dispatchInternal: (...args) => dispatchInternal(...args),
    onSessionChain: (...args) => onSessionChain(...args),
    liveSubAgentIds,
    idAtFirstCall,
    hostIdOf,
    isHostSubAgent,
  });






  const runners = new Map<string, AgentRunner>();

  // Every provider-construction input participates in the key — model,
  // endpoint, credentials, system prompt, fallback config. A rotated
  // credential therefore resolves to a NEW runner on the next dispatch
  // instead of silently reusing a provider built with the old secret.
  // (Hashed so raw secrets never sit in a map key; the soul is excluded
  // because provider construction ignores it.)
  const runnerKeyFor = (config: RuntimeConfig): string => {
    const { soul: _soul, soulPath: _soulPath, fetch: _fetch, ...providerInputs } = config as RuntimeConfig & {
      soul?: unknown;
      soulPath?: unknown;
      fetch?: unknown;
    };
    return createHash('sha256').update(JSON.stringify(providerInputs)).digest('hex');
  };

  // A sub-agent's runner has no memory store, so no turn of it injects or
  // reads the agent's memory; no skill catalog, so its prompt is its
  // instruction and its tools; and grants nothing to every agent, since
  // the credential request asks a person.
  const runnerFor = (config: RuntimeConfig, agentId: string, subAgent = false): AgentRunner => {
    // The budget is a provider-construction input too (the harness
    // runtimes take it as their inner limit), so it is part of the key:
    // two agents on one model with different budgets get their own runners.
    const maxTurns = options.maxTurnsFor?.(agentId) ?? options.maxTurns;
    const autoContinue = options.autoContinueFor?.(agentId);
    const key = `${runnerKeyFor(config)}:${maxTurns ?? 'default'}:${autoContinue ?? 'off'}${subAgent ? ':sub' : ''}`;
    const existing = runners.get(key);
    if (existing) {
      return existing;
    }

    // The Claude Code runtime executes kernel tools by calling back into
    // the runner built just below — late-bound because the runner needs
    // the provider first.
    let hostedRunner: AgentRunner | undefined;
    const provider = createRuntimeProvider(
      config,
      (error) => warn(`default model failed (${error instanceof Error ? error.message : String(error)}); using the fallback model`),
      async (session, call, context) => {
        if (!hostedRunner) {
          throw new Error('The Stratus runtime is not ready to execute tools yet.');
        }
        return hostedRunner.executeHostedToolCall(session, call, context);
      },
      maxTurns,
      // The sticky-fallback switch is durable the moment it happens, not
      // when the turn's next save lands — a daemon killed mid-fallback
      // must not retry the primary on restart.
      (session) => store.save(session),
      providerContributions,
    );

    const runner = new AgentRunner({
      provider,
      tools,
      // Runners are built on dispatch, after the plugins loaded and the
      // selection below ran, so a contributed executor is in place for
      // the first turn.
      executor: bindToolCalls(selectedExecutor ?? createLocalCommandExecutor()),
      ...(approvals ? { approvals } : {}),
      store,
      bus,
      agents: registry,
      // Asking a person for a key is harmless to grant: they decide
      // everything after the question, so no soul has to list it.
      grantedToEveryAgent: subAgent ? [] : [CREDENTIAL_REQUEST_TOOL_NAME],
      unlistedTools: unlistedTools(),
      ...(subAgent ? {} : { skills: skillCatalog, memory }),
      streaming: true,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(autoContinue !== undefined
        ? { autoContinue, waitingInput: (sessionId: string) => (waitingDispatches.get(sessionId) ?? 0) > 0 }
        : {}),
      providerCallGuards,
    });
    hostedRunner = runner;
    runners.set(key, runner);
    return runner;
  };

  /**
   * The runner that hears and never speaks. `observe` runs no turn, so it
   * needs no provider — and resolving one anyway would refuse an overhear
   * whenever the agent's runtime cannot currently be built: credentials
   * missing after a restart, a sign-in that lapsed. That is precisely the
   * window in which the agent cannot answer and the thread carries on
   * without it, so it is the window in which hearing matters most, and
   * what it heard is there once the configuration is repaired.
   *
   * A runner rather than a store write, because the label a speaker
   * lowers the session to is the runner's rule and there is one
   * implementation of it. Same store and bus as every speaking runner, so
   * a message it appends is the message the next turn reads, and its
   * event goes where every other event goes.
   */
  const observer = new AgentRunner({
    provider: {
      name: 'observer',
      async generate(): Promise<never> {
        throw new Error('The observing runner never runs a turn.');
      },
    },
    store,
    bus,
  });

  // ---- watchdog -----------------------------------------------------------

  /**
   * True when this configuration's provider actually emits deltas: the
   * Anthropic API path streams; the Claude Code runtime, OpenAI-compatible
   * adapters, and the demo provider resolve in one piece. An activity
   * watchdog is only honest where activity signals exist — for
   * non-streaming providers the idle timer would be a wall-clock timeout
   * that kills slow-but-healthy turns, so it stays off for them (their
   * tool phases are covered by executor timeouts regardless).
   */
  const fallbackStreamsDeltas = (fallback: FallbackRuntime): boolean =>
    // The same two modes as a primary. A subscription fallback that is not
    // recognised as streaming gets no watchdog at all once a session
    // switches to it, so a stall there would run to the provider's own
    // ten-minute timer instead of the idle timeout the operator set.
    (fallback.provider === 'anthropic' && Boolean(fallback.apiKey || fallback.authToken))
    // The codex harness streams item snapshots in every auth mode.
    || fallback.provider === 'codex'
    // A contributed fallback says for itself, exactly as a contributed
    // primary does below; a session that switched to one must not lose
    // the watchdog the plugin declared it could have.
    || (isRegisteredProviderName(fallback.provider)
      && providerContributions.get(registeredProviderNameOf(fallback.provider))?.streams === true);

  const streamsDeltas = (config: RuntimeConfig): boolean =>
    // Both Anthropic modes stream now: an API key through the Messages
    // API, a subscription token through the Agent SDK's partial messages —
    // and the codex harness streams item snapshots in every auth mode. A
    // contributed provider says for itself, and one that did not say is
    // read as not streaming: a watchdog armed over a silent-until-done
    // call would abort every long turn.
    (config.provider === 'anthropic' && Boolean(config.apiKey || config.authToken))
    || config.provider === 'codex'
    || (isRegisteredProviderName(config.provider)
      && providerContributions.get(registeredProviderNameOf(config.provider))?.streams === true);

  /**
   * Progress-based abort, armed only while the turn is actually awaiting a
   * streaming provider — the one phase where silence means a stall. Tool
   * executions and approval waits emit no deltas (executor timeouts cover
   * them), so the timer suspends at each provider.response and re-arms once
   * every tool call from that response has settled and the loop heads back
   * to the provider. A reset delta marks the mid-turn, session-sticky
   * switch to the fallback provider, and the timer follows the active
   * provider through it: switching to a non-streaming fallback suspends it
   * for the rest of the turn (silence is healthy there), while a streaming
   * fallback taking over from a non-streaming primary arms it for the
   * first time.
   */
  const withWatchdog = async <T>(
    sessionId: string,
    external: AbortSignal | undefined,
    idleEnabled: boolean,
    fallbackStreams: boolean,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const effectiveIdleMs = idleEnabled || fallbackStreams ? idleTimeoutMs : 0;
    if (effectiveIdleMs <= 0 && !external) {
      // No watchdog and nobody outside to cancel it — but still a turn an
      // announced restart must be able to cut short at the window.
      const idle = new AbortController();
      trackTurn(sessionId, idle);
      if (abortingWith !== undefined) {
        idle.abort(shutdownAbort());
      }
      try {
        return await run(idle.signal);
      } finally {
        untrackTurn(sessionId, idle);
      }
    }

    const controller = new AbortController();
    trackTurn(sessionId, controller);
    if (abortingWith !== undefined) {
      controller.abort(shutdownAbort());
    }
    // The external reason travels: a caller that aborted with its own
    // `RunAbortedError` gets it recorded on the session, like the watchdog's.
    const onExternalAbort = (): void => controller.abort(external?.reason);
    if (external?.aborted) {
      controller.abort(external.reason);
    } else {
      external?.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    // Whether the provider currently serving this turn streams deltas —
    // the primary until a reset delta announces the sticky fallback switch.
    let streamingActive = idleEnabled;
    let pendingTools = 0;
    /**
     * Tool calls this turn has started and not finished.
     *
     * `pendingTools` above reads a count off `provider.response`, which
     * only a provider that hands its calls back to the kernel loop emits.
     * A provider hosting its own loop dispatches inside `generate`, so that
     * count is zero for the whole of a hosted tool. These are the kernel's
     * own tool events, which every path emits because every path runs its
     * tools through the same executor — and they are turn-local, so an
     * aborted turn takes them with it rather than leaving anything behind.
     */
    const openToolCalls = new Set<string>();
    // Set at a text-only provider.response: the turn is wrapping up
    // (saves, completion events); nothing left for the timer to guard.
    let turnSettling = false;
    /**
     * What the watchdog last heard, for the warning it logs when it fires.
     *
     * "No activity for 120000ms" alone could not tell a provider that went
     * quiet mid-stream from one whose progress never reached the bus at
     * all, and that is the first question every abort raised. Event and
     * delta types only, never content: this lands in the daemon log.
     */
    let lastHeard = 'nothing since the turn began';
    let deltasHeard = 0;

    const suspendTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const armTimer = (): void => {
      if (effectiveIdleMs <= 0) {
        return;
      }
      suspendTimer();
      // Deliberately not unref'd: while a provider await is in flight, this
      // timer is what guarantees the process can always make progress on it.
      timer = setTimeout(() => {
        warn(
          `watchdog: no activity on session ${sessionId} for ${effectiveIdleMs}ms; aborting the turn `
          + `(last heard: ${lastHeard}; ${deltasHeard} provider deltas this turn)`,
        );
        // The reason rides on the signal, because the runner is what fails
        // the session: it writes `lastError` and emits `session.failed`
        // before this wrapper ever sees the rejection. Rethrowing a better
        // message from here reached the dispatcher and nobody else — the
        // record and the event both said "Run aborted", which is also what
        // a person cancelling looks like.
        controller.abort(new RunAbortedError(`Run aborted: no activity for ${effectiveIdleMs}ms`));
      }, effectiveIdleMs);
    };

    // Two subscriptions bracket every event's fan-out. The PREPENDED
    // observer runs before any external consumer: it updates phase state
    // and stops the clock — while the remaining (possibly slow, throttled)
    // subscribers process this event, the provider is not being awaited,
    // so elapsed time is consumer time, not provider silence. The APPENDED
    // marker runs last: control is about to return to the runner and its
    // provider await, so the timer arms only when a streaming provider is
    // actually the thing being waited on (never during tool phases,
    // post-switch silent fallbacks, or turn wrap-up).
    const unsubscribeObserver = bus.subscribe((event: StratusEvent) => {
      if (!('sessionId' in event) || event.sessionId !== sessionId) {
        return;
      }
      if (event.type === 'provider.delta') {
        deltasHeard += 1;
        lastHeard = `provider.delta ${event.delta.type}`;
      } else {
        lastHeard = event.type;
      }
      switch (event.type) {
        case 'provider.delta':
          // Only a *fallback* reset marks the mid-turn, session-sticky
          // switch that the timer follows. A provider retrying its own
          // attempt abandons its partial output too, but nothing about
          // who is serving the turn changed — reading that as a switch
          // would disarm the watchdog for the rest of a turn that is
          // still running on the provider it started on.
          if (event.delta.type === 'reset' && event.delta.reason === 'fallback') {
            streamingActive = fallbackStreams;
          }
          break;
        case 'provider.response':
          // The provider finished; the loop enters its tool phase
          // (approval waits included) — or, with no tool calls, the turn
          // is over. The response says exactly how many tool calls must
          // settle before the loop returns to the provider.
          pendingTools = event.parts.filter((part) => part.type !== 'text').length;
          if (pendingTools === 0) {
            turnSettling = true;
          }
          break;
        case 'tool.approval-requested':
          // Redundant with the approval wrapper for a gateway-owned
          // transport, and not redundant for a recovered turn, whose
          // request is re-announced without going through a policy again.
          openToolCalls.add(event.call.id);
          break;
        case 'tool.called':
          openToolCalls.add(event.call.id);
          break;
        case 'tool.completed':
          // Completion names the call through its result; denial carries
          // the call itself. Both settle it.
          openToolCalls.delete(event.result.callId);
          pendingTools = Math.max(0, pendingTools - 1);
          break;
        case 'tool.denied':
          openToolCalls.delete(event.call.id);
          pendingTools = Math.max(0, pendingTools - 1);
          break;
        default:
          break;
      }
      suspendTimer();
    }, { prepend: true });

    const unsubscribeDrain = bus.subscribe((event: StratusEvent) => {
      if (!('sessionId' in event) || event.sessionId !== sessionId) {
        return;
      }
      if (
        streamingActive
        && pendingTools === 0
        && openToolCalls.size === 0
        && (approvalWaits.get(sessionId) ?? 0) === 0
        && !turnSettling
      ) {
        armTimer();
      }
    });

    suspendWatchdog.set(sessionId, suspendTimer);

    if (streamingActive) {
      armTimer();
    }

    try {
      return await run(controller.signal);
    } finally {
      suspendTimer();
      unsubscribeObserver();
      unsubscribeDrain();
      suspendWatchdog.delete(sessionId);
      untrackTurn(sessionId, controller);
      external?.removeEventListener('abort', onExternalAbort);
    }
  };

  // ---- dispatch -----------------------------------------------------------

  // Single-flight per session: a second message to a busy session queues
  // behind the in-flight turn instead of interleaving with it. Sessions
  // are independent — different conversations run concurrently.
  const sessionChains = new Map<string, Promise<unknown>>();
  /**
   * Work queued on each session's chain that has not started, of every
   * kind (a dispatch, an overheard message, a recovery). What says whether
   * a merged-turn batch is first in line behind the running turn, which
   * steering needs (card 948): a batch with anything ahead of it would be
   * answered before what was said first.
   */
  const queuedWork = new Map<string, number>();
  const releaseQueued = (sessionId: string): void => {
    const left = (queuedWork.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      queuedWork.set(sessionId, left);
    } else {
      queuedWork.delete(sessionId);
    }
  };
  /**
   * Dispatches queued behind a session's running turn, per session: what
   * tells an auto-continuing turn that somebody wrote meanwhile, so it
   * wraps up and lets them in rather than keep the session to itself.
   */
  const waitingDispatches = new Map<string, number>();
  const inflight = new Set<Promise<unknown>>();
  let stopping = false;
  // Open until `startServing` reads what the last process left, which it
  // does before any channel or the scheduler can deliver work.
  let intakeState: IntakeState = { paused: false };
  // A copy for callers, saying while paused whether this is the pause an
  // unreadable file started (see `IntakeState.unreadable`).
  const intakeView = (): IntakeState => (intakeState.paused
    ? { ...intakeState, unreadable: intakeState.unreadable === true }
    : { ...intakeState });
  let heldState = options.held === true;
  /** What a held start left for `promote()`: the channels it did not start, and the sweeps it did not run. */
  let deferredStart: { adapters: GatewayChannelAdapter[]; orphaned: ReadonlySet<string>; abandoned: string[] } | undefined;
  // Pause and resume run one at a time, each writing the file and then the
  // state, so the two always agree: overlapping, a pause's write could land
  // after a resume removed the file, leaving the daemon paused in memory
  // and open on disk — open again after the next restart.
  let intakeChain: Promise<unknown> = Promise.resolve();
  const intakeTransition = <T>(work: () => Promise<T>): Promise<T> => {
    const run = intakeChain.then(work);
    intakeChain = run.catch(() => undefined);
    return run;
  };
  /**
   * The abort handle of every turn running right now. A restart's drain
   * window ends by aborting these — the same signal the watchdog fires —
   * so a turn that outlives the window fails as aborted, its session
   * saved, instead of being cut off by a process exit and found as
   * abandoned by the next one. Keyed by session, so a stop for one
   * conversation (`abortTurns`) reaches every turn running there, a
   * recovered one included, and nothing else.
   */
  const turnControllers = new Map<string, Set<AbortController>>();
  const trackTurn = (sessionId: string, controller: AbortController): void => {
    const running = turnControllers.get(sessionId);
    if (running) {
      running.add(controller);
    } else {
      turnControllers.set(sessionId, new Set([controller]));
    }
  };
  const untrackTurn = (sessionId: string, controller: AbortController): void => {
    const running = turnControllers.get(sessionId);
    running?.delete(controller);
    if (running?.size === 0) {
      turnControllers.delete(sessionId);
    }
  };
  /**
   * Set once a restart's or a stop's window has closed and the turns in it
   * were aborted, to the reason they were aborted with. A turn that starts
   * after that — one queued behind the aborted turn on the same session,
   * accepted before the announcement — is aborted the moment it gets its
   * controller, with the same reason, rather than running unseen until the
   * shutdown closes the store under it and leaves it recorded as nothing
   * at all.
   */
  let abortingWith: string | undefined;
  /**
   * Set once `start()` has finished. A restart before that would stop the
   * channels started so far and close the stores while the rest of
   * startup is still running — reachable, since the control API can be
   * up and answering `POST /restart` while a later channel is still
   * connecting — and the startup then fails on a closed store instead of
   * the daemon coming back.
   */
  let serving = false;
  /** Set once `restart()` announced; the refusal a caller reads says why. */
  let restartStatus: RestartStatus | undefined;
  const refusal = (): Error => restartStatus
    ? new GatewayStoppingError('stratusd is restarting and will accept new work once it is back up.', true)
    : new GatewayStoppingError('The gateway is stopping and no longer accepts new work.', false);
  /**
   * What the caller of a keyed turn the shutdown cut short hears: the same
   * refusal, since its message is no more answered than one refused at the
   * door (a channel keeps it for the next start, as it keeps those), and
   * worded for a turn that ran and will be continued.
   */
  const leftForNext = (): Error => restartStatus
    ? new GatewayStoppingError('stratusd is restarting; this turn was cut short and continues once it is back up.', true)
    : new GatewayStoppingError('stratusd is stopping; this turn was cut short and continues when it is started again.', false);
  /**
   * The abort a stop's or restart's window ends a turn with. Resumable: a
   * keyed turn is left for the next start to continue once, as a crash
   * leaves it, rather than failed (`RunAbortedError.resumable`); every
   * other turn is failed with the reason, as before.
   */
  const shutdownAbort = (): RunAbortedError => new RunAbortedError(abortingWith, { resumable: true });

  /**
   * The turn id running on each session, for callers that named one.
   *
   * Set when the chained work actually starts — not when the dispatch was
   * queued — because a message waiting behind another turn has not begun,
   * and stamping events with it would attribute the running turn's output to
   * the queued one. Single-flight per session is what makes one entry per
   * session sufficient.
   */
  const activeTurns = new Map<string, string>();
  /**
   * The runtime each running turn resolved when it started, by session. A
   * reviewer call for one of its calls runs on it (`reviewCall`), so a soul
   * or config edited mid-turn can't send that turn's request to a provider
   * that wasn't serving it. Exact for the same reason `activeTurns` is: one
   * turn per session at a time, set and cleared inside the session chain.
   */
  const turnRuntimes = new Map<string, { source: AgentSource; config: RuntimeConfig }>();
  const onTurnRuntime = async <T>(
    sessionId: string,
    runtime: { source: AgentSource; config: RuntimeConfig },
    work: () => Promise<T>,
  ): Promise<T> => {
    turnRuntimes.set(sessionId, runtime);
    try {
      return await work();
    } finally {
      if (turnRuntimes.get(sessionId) === runtime) {
        turnRuntimes.delete(sessionId);
      }
    }
  };
  /**
   * Keyed dispatches not yet settled, by session and key — what a repeat
   * attaches to. In memory on purpose: it only has to cover the turns this
   * process is running, and the transcript covers the rest.
   */
  // Nested rather than one joined string: both halves are the caller's, and
  // no separator is one a caller cannot also put inside a key. The agent
  // the dispatch named rides along, so a repeat naming another is not
  // handed a session that is not its agent's.
  // `confirmed` once the chain has seen the dispatch past the identity
  // check with a key the session had not seen (`claimLiveItem`); until
  // then the entry is a claim that may yet be refused. `addressed` is false
  // for a turn nobody asked for, which `holdsMessage` does not count.
  const liveWorkItems = new Map<string, Map<string, { turn: Promise<Session>; agentId: string | undefined; confirmed: boolean; addressed: boolean }>>();
  /**
   * The merged turn still taking messages, per session (card 423): led by
   * the first opted-in dispatch that queued behind a running turn, closed
   * the moment that dispatch reaches the head of the chain. See
   * `DispatchInput.onAbsorbed`.
   */
  const openBatches = new Map<string, MergeBatch>();
  /** The start-up snapshot `recoverParkedTurns` judges orphans from, for a repeat that gets there first. */
  let orphanedAtStart: ReadonlySet<string> = new Set();

  /**
   * The runtime one agent would run on right now — config snapshot, soul
   * pins, degradation and all.
   *
   * Extracted so recovery resolves it exactly as a dispatch does. A second
   * copy of this chain is the difference between a recovered turn finishing
   * on its agent's provider and finishing on the daemon's default, and it
   * would drift the first time either side gained a rule.
   */
  const runtimeForAgent = async (source: AgentSource): Promise<RuntimeConfig> => {
    // Config re-resolves per dispatch, so a changed model, credential, or
    // soul pin applies without a restart. The pool dedupes runners by the
    // resolved configuration. The gateway-wide selection and the daemon's
    // environment are defaults, not overrides: resolveRuntimeConfig gives
    // both higher precedence than the soul (they are explicit flags and
    // env vars on the CLI), so any default the soul pins over is dropped
    // here — an agent pinned to a provider keeps it whatever the gateway
    // was started with, and a default model never rides along to a
    // different provider than it was chosen for.
    const selection: RuntimeSelection = { ...options.selection };
    let resolveEnv = env;

    // One config read per dispatch, through a last-known-good cache: a
    // config.json an operator saved mid-edit must neither fail dispatches
    // (a daemon keeps serving) nor silently change what it configured —
    // discarding a broken config wholesale would flip a config-provided
    // provider back to the demo default, durably recording canned replies
    // in a real conversation. With no known-good snapshot to fall back
    // on, failing is the honest outcome. Credential and provider errors
    // are never masked — only the file itself degrades.
    let configSnapshot: NonNullable<RuntimeSelection['presetConfig']>;
    try {
      const location = await resolveConfigLocation(
        options.selection?.configPath ? { configPath: options.selection.configPath } : {},
        env,
      );
      configSnapshot = location
        ? { config: await loadConfigFile(location.path), trusted: location.trusted, path: location.path }
        : { config: {}, trusted: true };
      lastGoodConfigSnapshot = configSnapshot;
    } catch (error) {
      if (!(error instanceof ConfigFileError) || !lastGoodConfigSnapshot) {
        throw error;
      }
      warn(`${error.message}; using the last known-good config`);
      configSnapshot = lastGoodConfigSnapshot;
    }
    selection.presetConfig = configSnapshot;

    const pins = source.soul;
    if (pins) {
      // One soul read per dispatch: resolution uses the exact snapshot
      // refreshAgent just loaded and identity-checked. Handing the path
      // to resolveRuntimeConfig instead would read the file a second
      // time, racing a concurrent replacement — this turn could keep one
      // agent's definition while adopting another's provider pins.
      const normalized = applySoulPins(pins, selection, env, {
        ...(options.selection?.provider !== undefined ? { selectionProvider: options.selection.provider } : {}),
        ...(configSnapshot.config.provider !== undefined ? { configProvider: configSnapshot.config.provider } : {}),
        configPresent: configSnapshot.path !== undefined,
      });
      resolveEnv = normalized.env;
    } else {
      // A soul-less agent (the built-in default) resolves with no soul at
      // all: the config file's default soul belongs to another identity —
      // and when the default route degrades to the built-in, it is exactly
      // because that file is currently unusable.
      selection.presetSoul = null;
    }

    // The preset snapshot means resolution reads no config file — every
    // failure from here is a credential or provider problem and surfaces.
    return resolveRuntimeConfig(selection, resolveEnv);
  };

  /**
   * Whether the turn about to run streams deltas, which arms the idle
   * watchdog — on the sticky fallback when the session already switched to
   * it, since that is the provider the turn will be served by.
   */
  const watchdogStreamsFor = (
    session: Pick<Session, 'metadata'> | undefined,
    config: RuntimeConfig,
  ): { switchedToFallback: boolean; effectiveStreams: boolean; fallbackStreams: boolean } => {
    const switchedToFallback = session?.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true;
    const fallbackStreams = config.provider !== 'demo' && config.fallback
      ? fallbackStreamsDeltas(config.fallback)
      : false;
    const effectiveStreams = switchedToFallback && config.provider !== 'demo' && config.fallback
      ? fallbackStreamsDeltas(config.fallback)
      : streamsDeltas(config);
    return { switchedToFallback, effectiveStreams, fallbackStreams };
  };

  /**
   * Whether a turn on this config could be served by a harness
   * (`runsOnHarness`): the primary or, since a turn can switch mid-run, the
   * fallback. Once a session has switched for good the primary is never
   * called again, and only the fallback counts.
   */
  const reachesHarness = (config: RuntimeConfig, switchedToFallback: boolean): boolean => {
    const fallback = config.provider !== 'demo' ? config.fallback : undefined;
    return switchedToFallback && fallback !== undefined
      ? runsOnHarness(fallback)
      : runsOnHarness(config) || (fallback !== undefined && runsOnHarness(fallback));
  };

  /**
   * A keyed turn the shutdown cut short and the runner left for the next
   * start (`leftForNextStart`): its caller is told so, the way a message
   * refused at the door is, and keeps it for the next daemon, which
   * continues the turn. Read back on the chain, so it is this dispatch's
   * own message the session is still running on.
   */
  const settleLeftForNextStart = async (input: DispatchInput, turn: Promise<Session>): Promise<Session> => {
    try {
      return await turn;
    } catch (error) {
      if (error instanceof RunAbortedError && error.resumable) {
        const left = await store.get(input.sessionId).catch(() => undefined);
        // The dispatch's own key, or, for an unkeyed one whose turn took
        // keyed messages in at a tool step (card 948), the key the turn has
        // from them: its steered callers are told what a keyed caller is.
        const key = input.idempotencyKey ?? (left === undefined ? undefined : turnKeyOf(turnMessageOf(left)));
        if (left !== undefined && key !== undefined && workItemState(left, key) === 'unfinished' && leftForNextStart(left, error)) {
          throw leftForNext();
        }
      }
      throw error;
    }
  };

  // `selectedExecutor` is read late: plugins set it when they start.
  const { dispatchInternal } = createTurnDispatch({
    options,
    env,
    store,
    getSelectedExecutor: () => selectedExecutor,
    defaultAgentId,
    refreshAgent,
    runtimeContextFor,
    runnerFor,
    withWatchdog,
    onTurnRuntime,
    runtimeForAgent,
    watchdogStreamsFor,
    reachesHarness,
    settleLeftForNextStart,
  });

  // `stopping`, `abortingWith` and `orphanedAtStart` are read late, and
  // `onSessionChain` is declared further down.
  const {
    recoverParkedTurns,
    listOrphanedDelegations,
    listAbandonedTurns,
    failAbandonedTurns,
    settleRepeat,
    archivedRepeat,
    settleUnfinished,
  } = createRecovery({
    log,
    warn,
    bus,
    store,
    scheduler,
    effectiveApprovalTimeoutMs,
    refreshAgent,
    runtimeContextFor,
    runnerFor,
    withWatchdog,
    isStopping: () => stopping,
    trackTurn,
    untrackTurn,
    getAbortingWith: () => abortingWith,
    shutdownAbort,
    activeTurns,
    onTurnRuntime,
    getOrphanedAtStart: () => orphanedAtStart,
    runtimeForAgent,
    watchdogStreamsFor,
    reachesHarness,
    onSessionChain: (...args) => onSessionChain(...args),
  });















  // `stopping` is read late: it is set at shutdown.
  const { takeSteered } = createSteering({
    log,
    store,
    releaseQueued,
    waitingDispatches,
    isStopping: () => stopping,
    liveWorkItems,
    openBatches,
    archivedRepeat,
  });

  /**
   * Settles a keyed item the last process left unfinished before any other
   * message joins its session. Channels are up before the sweeps reach it,
   * and a different message resumed onto it would become the session's
   * newest, so `workItemState` would call the old item finished: its
   * redelivery would then run nothing although its turn never finished.
   *
   * Keyed items only. An unkeyed turn's caller was promised nothing, and a
   * message resuming it is the long-standing way such a session recovers.
   */
  const settleOrphanedItem = async (sessionId: string): Promise<void> => {
    const session = await store.get(sessionId);
    const key = session === undefined ? undefined : turnKeyOf(turnMessageOf(session));
    if (session !== undefined && key !== undefined && workItemState(session, key) === 'unfinished') {
      // A continuation that fails has failed its session, which is settled
      // too; the message waiting behind it runs either way.
      await settleUnfinished(session).catch((error: unknown) => {
        warn(`could not settle ${sessionId}'s unfinished turn before the next message: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Settling can leave it unfinished — a shutdown that began after this
      // message was accepted skips recovery — and the message must not run
      // over it then, or the old key reads finished with its turn never run.
      const after = await store.get(sessionId);
      if (after !== undefined && workItemState(after, key) === 'unfinished') {
        throw stopping
          ? refusal()
          : new Error(`Session ${sessionId} has an unfinished turn that could not be settled, so this message was not added behind it. Send it again.`);
      }
    }
  };

  /**
   * Runs `work` as the session's next turn: queued behind whatever that
   * session is already doing, and tracked so shutdown drains it.
   *
   * Recovery goes through here as well as dispatch, and must. Channels are
   * live before a sweep finishes, so an inbound message for a parked
   * session could otherwise `resume()` alongside `recoverPendingApproval()`
   * — one closing the parked call as interrupted while the other re-enters
   * it, both saving divergent copies of the same transcript, and the tool
   * possibly running twice. Single-flight per session is the invariant that
   * stops that, and it only holds if everything that writes a session goes
   * through it.
   */
  const onSessionChain = <T>(
    sessionId: string,
    work: () => Promise<T>,
    /** True once this work no longer counts as queued: a batch steered into the turn ahead (`takeSteered` released it). */
    released?: () => boolean,
  ): Promise<T> => {
    const previous = sessionChains.get(sessionId) ?? Promise.resolve();
    queuedWork.set(sessionId, (queuedWork.get(sessionId) ?? 0) + 1);
    const start = (): Promise<T> => {
      if (released?.() !== true) {
        releaseQueued(sessionId);
      }
      return work();
    };
    const turn = previous.then(start, start);

    const settled = turn.catch(() => {});
    sessionChains.set(sessionId, settled);
    inflight.add(settled);
    void settled.finally(() => {
      inflight.delete(settled);
      if (sessionChains.get(sessionId) === settled) {
        sessionChains.delete(sessionId);
      }
    });

    return turn;
  };

  // ---- memory passes (spec 962) -------------------------------------------

  /** The session ids of the side runs running now: reviewer calls and memory passes. */
  const sideRuns = new Set<string>();

  /**
   * A pass's one model turn: the agent's provider and credentials, exactly
   * the model asked for and never the fallback (cost stays what the
   * operator chose), only the pass's two tools, no persona, skills, memory
   * injection or delegates, and a session that is never stored. Its calls
   * go through the same provider-call guards as every turn, and its events
   * through the same bus, so a budget sees and counts them.
   */
  const runSideModel = async (run: {
    agentId: string;
    sessionId: string;
    model: string | undefined;
    instructions: string;
    prompt: string;
    trust: TrustLevel;
    tools: readonly Tool[];
    /** Tool steps before the wrap-up; 0 tools still needs 1 for the answer. */
    maxTurns: number;
    signal: AbortSignal;
    /** A running turn's own runtime (`turnRuntimes`); the agent's current one when omitted. */
    runtime?: { source: AgentSource; config: RuntimeConfig };
  }): Promise<Session> => {
    const source = run.runtime?.source ?? await refreshAgent(run.agentId);
    const resolved = run.runtime?.config ?? await runtimeForAgent(source);
    const { fallback: _fallback, ...primary } = resolved as RuntimeConfig & { fallback?: unknown };
    const config = (run.model !== undefined ? { ...primary, model: run.model } : primary) as RuntimeConfig;
    const tools = new ToolRegistry();
    for (const tool of run.tools) {
      tools.register(tool);
    }
    const { maxTurns } = run;
    let passRunner: AgentRunner | undefined;
    const provider = createRuntimeProvider(
      config,
      () => {},
      async (session, call, context) => {
        if (!passRunner) {
          throw new Error('The Stratus runtime is not ready to execute tools yet.');
        }
        return passRunner.executeHostedToolCall(session, call, context);
      },
      maxTurns,
      async () => {},
      providerContributions,
    );
    passRunner = new AgentRunner({
      provider,
      tools,
      store: new InMemorySessionStore(),
      bus,
      maxTurns,
      providerCallGuards,
    });
    const definition: AgentDefinition = {
      id: source.definition.id,
      name: source.definition.name,
      instructions: run.instructions,
      tools: run.tools.map((tool) => tool.name),
      skills: [],
      delegates: [],
      ...(source.definition.credentials !== undefined ? { credentials: [...source.definition.credentials] } : {}),
    };
    // Its events go on the shared bus like a turn's, for what counts provider
    // calls there (`session.usage`), and are known as a side run's for as
    // long as it runs (`isSideRun`), so a surface that shows conversations
    // can leave it out.
    sideRuns.add(run.sessionId);
    try {
      return await passRunner.run({
        sessionId: run.sessionId,
        agent: definition,
        userMessage: run.prompt,
        metadata: {
          provider: config.provider,
          ...(config.provider !== 'demo' && config.model !== undefined ? { model: config.model } : {}),
          [SENDER_TRUST_METADATA_KEY]: run.trust,
        },
        signal: run.signal,
      });
    } finally {
      sideRuns.delete(run.sessionId);
    }
  };

  const runMemoryPassModel = async (run: MemoryPassModelRun): Promise<void> => {
    await runSideModel({
      agentId: run.agentId,
      sessionId: run.sessionId,
      model: run.model,
      instructions: MEMORY_PASS_RULES,
      prompt: run.prompt,
      // The slice's label: the pass reads at the conversation's trust.
      trust: run.trust,
      tools: run.tools,
      // A step budget of n is n tool steps and one wrap-up, so this is the
      // pass's model-call cap.
      maxTurns: MEMORY_PASS_MAX_MODEL_CALLS - 1,
      signal: run.signal,
    });
  };

  // ---- the review posture's reviewer (spec 964) ----------------------------

  /**
   * Reviewer calls still running, and the shadow reviews the policy hands
   * over whole (`ApprovalTransport.offPath`). A turn awaits its own, but a
   * shadow review runs off the call path and can outlast its turn, still
   * reading credentials before its reviewer call starts, and a provider
   * that ignores its abort after the review's timeout keeps one going with
   * nothing waiting on it. A shutdown aborts these once the turns have
   * drained and waits for them, so none is still using a provider when the
   * plugins are disposed, and no decision they report is lost.
   */
  const reviewsRunning = new Set<Promise<unknown>>();
  const stopReviews = new AbortController();
  const keepUntilStopped = (task: Promise<unknown>): void => {
    reviewsRunning.add(task);
    const untrack = (): void => {
      reviewsRunning.delete(task);
    };
    task.then(untrack, untrack);
  };

  const reviewCall = async (request: GatewayReviewRequest): Promise<{ reply: Record<string, unknown> } | { failed: string }> => {
    if (request.command !== undefined && !callShownWhole(request.call)) {
      // A command line the case can't show whole could hide its end, and
      // the reviewer would judge only the part it saw: a person decides.
      return { failed: 'command-too-long' };
    }
    const firing = scheduler.firingPromptFor(request.session);
    const prompt = reviewCaseText({
      session: request.session,
      call: request.call,
      tool: request.tool,
      risk: request.risk,
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      ...(request.destination !== undefined ? { destination: request.destination } : {}),
      ...(firing !== undefined ? { firing } : {}),
      delegated: isSubAgentSession(request.session),
    });
    if (stopReviews.signal.aborted) {
      return { failed: 'cancelled' };
    }
    const signal = AbortSignal.any([request.signal, stopReviews.signal]);
    // On the reviewed turn's own runtime while it runs. A review after it
    // has ended (a shadow review can outlast its turn) takes the agent's
    // current one, which is where the session's next turn sends the same
    // conversation anyway.
    const runtime = turnRuntimes.get(request.session.id);
    const running = runSideModel({
      agentId: request.session.agent.id,
      sessionId: `review:${randomUUID()}`,
      model: request.model,
      instructions: REVIEW_RULES,
      prompt,
      // The case quotes a call an outside page may have shaped.
      trust: 'external',
      tools: [],
      maxTurns: 1,
      signal,
      ...(runtime !== undefined ? { runtime } : {}),
    });
    keepUntilStopped(running);
    let answered: Session;
    try {
      answered = await running;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { failed: /budget/i.test(message) ? 'budget' : signal.aborted ? 'cancelled' : 'provider-error' };
    }
    if (answered.status === 'failed') {
      return { failed: signal.aborted ? 'cancelled' : 'provider-error' };
    }
    const reply = [...answered.messages].reverse().find((message) => message.role === 'assistant' && message.content.trim().length > 0);
    const parsed = reply === undefined ? undefined : readReviewReply(reply.content);
    return parsed === undefined ? { failed: 'unparseable' } : { reply: parsed };
  };

  const memoryPassHost = createMemoryPassHost({
    // Beside each agent's memory.jsonl, under the home the memory store uses.
    stateDir: stratusHomePath(env),
    stateHome: stratusHomePath(env),
    run: randomUUID(),
    memory,
    supersedesMany: () => selectedMemorySupersedesMany,
    sessions: store,
    chain: {
      idle: (sessionId) => !sessionChains.has(sessionId),
      queue: (sessionId, work) => onSessionChain(sessionId, work),
    },
    hasAgent: (agentId) => sources.has(agentId),
    isSubAgentSession: (session) => isSubAgentSession(session),
    defaultModel: async (agentId) => {
      const config = await runtimeForAgent(await refreshAgent(agentId));
      return config.provider !== 'demo' ? config.model : undefined;
    },
    runModel: runMemoryPassModel,
    emit: (event) => {
      void bus.emit(event);
    },
    log,
  });

  /**
   * A scheduled firing's own dispatch — single-flight and stopping-aware
   * like the public one, but permitted into the reserved `schedule:`
   * namespace the public one refuses. Firings are the only writers of that
   * namespace, which is what keeps the destination carve-out unforgeable:
   * an external message can never share, resume, or race a firing's
   * session, so `isPreauthorized` can trust that a `schedule:` session
   * running is the scheduler's turn and no one else's.
   */
  const dispatchScheduledFiring = (input: DispatchInput): Promise<Session> => {
    if (stopping) {
      throw refusal();
    }
    return onSessionChain(input.sessionId, async () => {
      // A keyed firing (an event trigger's batch) that the session already
      // holds is that turn, not a new one: a daemon that died after the
      // turn and before the firing was recorded re-sends it at the next
      // start, and must answer with the finished turn (or settle the
      // unfinished one, as the start-up sweep would) instead of running the
      // event again. The same check the public door makes, on the chain.
      if (input.idempotencyKey !== undefined) {
        const repeated = await settleRepeat(input.sessionId, input.idempotencyKey, input.agentId, input.turnId, input.onRepeat);
        if (repeated !== undefined) {
          return repeated;
        }
      }
      return dispatchInternal(input);
    });
  };

  // `stopping`, `intakeState` and `heldState` are read late.
  const { dispatch } = createDispatch({
    store,
    sessionChains,
    queuedWork,
    waitingDispatches,
    isStopping: () => stopping,
    getIntakeState: () => intakeState,
    isHeld: () => heldState,
    refusal,
    activeTurns,
    liveWorkItems,
    openBatches,
    settleOrphanedItem,
    onSessionChain,
    dispatchInternal,
    settleRepeat,
    takeSteered,
  });

  const observe = async (input: ObserveInput): Promise<Session | undefined> => {
    if (stopping) {
      throw refusal();
    }
    // The same two doors `dispatch` guards, for the same reasons: a message
    // overheard into a firing's session would sit in the scheduler's
    // context, and a metadata key only the daemon may write is not one a
    // channel gets to supply by hearing something.
    if (isScheduleSessionId(input.sessionId)) {
      throw new Error(
        `Session ids beginning with "${SCHEDULE_SESSION_ID_PREFIX}" are reserved for scheduled firings and cannot be observed into externally.`,
      );
    }
    const reserved = reservedSessionMetadataKey(input.metadata);
    if (reserved !== undefined) {
      throw new Error(
        `Session metadata key "${reserved}" is reserved for the daemon's own records and cannot be supplied by an observe. Reserved keys: ${RESERVED_SESSION_METADATA_KEYS.join(', ')}.`,
      );
    }

    // Heard after the batch waiting on this session opened, so anything
    // said after it must not be answered ahead of it: the batch takes no
    // more, and a later message leads the next one (card 423).
    openBatches.delete(input.sessionId);
    return onSessionChain(input.sessionId, async () => {
      assertStateCompatible(env);
      const existing = await store.get(input.sessionId);
      if (!existing) {
        // Not a refusal: a channel asks this for every message in every
        // thread its app can see, and "not in that one" is the ordinary
        // answer. The chain has already run whatever dispatch was queued
        // ahead, so this is a session the agent was genuinely never
        // invited to, not one that is still being created.
        return undefined;
      }
      if (input.agentId !== undefined && existing.agent.id !== input.agentId) {
        throw crossIdentityError(input.sessionId, existing.agent.id, input.agentId);
      }
      const continuedAs = existing.metadata?.[ROLLED_OVER_TO_METADATA_KEY];
      if (typeof continuedAs === 'string') {
        throw new Error(
          `Session ${input.sessionId} was rolled over; it is an archived transcript and the conversation continues as ${continuedAs}.`,
        );
      }
      return observer.observe({
        sessionId: input.sessionId,
        message: input.message,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
    });
  };

  /** Every call parked on a human, oldest first: `pendingApprovals()` and the fleet reader's one rule. */
  const listPendingApprovals = (): PendingApproval[] => [...pendingApprovals.values()]
    .map((parked) => parked.pending)
    .sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));

  /**
   * Load what the config asked for, and say what did not load.
   *
   * A plugin that fails is a warning rather than a refusal to start: a
   * daemon that will not boot because of a mistyped package name takes the
   * whole fleet down over one line of config, and the agents whose tools
   * did load are still worth serving. What is never degraded is the
   * security half — an undeclared name or a collision refuses that plugin
   * whole, inside the loader.
   */
  const startPlugins = async (): Promise<void> => {
    const configured = options.plugins ?? {};
    if (Object.keys(configured).length === 0) {
      return;
    }
    const result = await loadPlugins({
      config: configured,
      host: options.pluginHost ?? {
        resolve: (specifier) => import.meta.resolve(specifier),
        import: (specifier) => import(specifier),
      },
      tools,
      skills: skillCatalog,
      bus,
      providers: providerContributions,
      channels: channelContributions,
      memory: memoryContributions,
      executors: executorContributions,
      // The host-owned path for a channel's transport secrets: the same
      // `channels.<kind>.<agentId>` namespace Slack's tokens live in, read
      // for the kind the plugin declared, and never through the
      // agent-scoped resolver below.
      channelSecrets: (kind) => loadChannelTransportSecrets(env, kind),
      // The file-backed resolver, so a plugin needing a key reaches the
      // *calling* agent's — its allowlist checked, its own entry before the
      // fleet's shared one.
      credentials: createFileCredentialResolver(env),
      workspaces: agentWorkspaces,
      stateDirectories: createPluginStateDirectories(env),
      // The daemon's home, minus the agents' workspaces, whatever roots a
      // plugin's config grants. See `createHostProtectedPaths`.
      protectedPaths: createHostProtectedPaths(env, {
        ...(options.selection?.configPath ? { configPath: options.selection.configPath } : {}),
        // Where the stores were actually opened, when a host moved them.
        ...(options.stateDir !== undefined ? { stateDir } : {}),
      }),
      // The structured log, so a plugin's lifecycle lines — an MCP server
      // that dropped, a reconnect that failed — are in `stratus logs` and
      // not only on a stderr the service manager owns.
      log,
      warn,
      subAgents,
      memoryPasses: memoryPassHost.handle,
      // Metadata only, from the reads the control API makes, with a log
      // line per read naming the plugin. See `createFleetReader`.
      fleet: (packageName) => createFleetReader({
        agents: () => registry.list(),
        store,
        schedules: () => scheduler.list(),
        pendingApprovals: listPendingApprovals,
        onRead: (method) => log(`fleet read: ${method} by plugin ${packageName}`),
      }),
      providerCallGuards,
      eventSources: {
        reserved: Object.keys(eventSources),
        register: (packageName, sourceIds) => {
          if (!eventStore) {
            // The first source on a daemon whose config has none: the
            // scheduler was built without events, so it takes them now,
            // before its start-up pass reads what is waiting. First, so a
            // store that won't open refuses the plugin with no source left
            // behind.
            scheduler.attachEvents({ store: openEvents().store, sources: eventSourceIds });
          }
          for (const sourceId of sourceIds) {
            pluginEventSources.set(sourceId, packageName);
          }
        },
        ingest: async (packageName, sourceId, event) => {
          if (pluginEventSources.get(sourceId) !== packageName) {
            throw new Error(`Plugin ${packageName} does not feed event source "${sourceId}" on this daemon.`);
          }
          // The store closes last in a stop. Until then an event is kept
          // and goes out from the next start; after, refused, so a poller
          // keeps its cursor where it was.
          if (storesClosed) {
            throw new Error('stratusd has stopped, so this event was not stored. Feed it again once the daemon is back.');
          }
          const answer = openEvents().intake.ingest(sourceId, event);
          // Sent now rather than at the next tick; the scheduler decides
          // hold or fire, and does nothing while it is stopped or not yet
          // started.
          if (answer.status === 'matched') {
            scheduler.kickEvents();
          }
          return answer;
        },
      },
    });
    loadedPlugins = result.loaded;
    pluginFailures = result.failures;

    for (const plugin of result.loaded) {
      const contributed = [
        ...plugin.tools.map((tool) => `${tool.name} (${tool.risk})`),
        ...plugin.skills.map((skill) => `skill ${skill.id}`),
        ...plugin.contributions.providers.map((name) => `provider ${name}`),
        ...plugin.contributions.channels.map((channel) => `channel ${channel.kind} for ${channel.agents.join(', ') || 'no agent'}`),
        ...plugin.contributions.memory.map((name) => `memory store ${name}`),
        ...plugin.contributions.executors.map((name) => `executor ${name}`),
        ...(plugin.providerCallGuards > 0 ? ['guards model calls'] : []),
        ...plugin.eventSources.map((sourceId) => `event source ${sourceId}`),
      ];
      log(`plugin ${plugin.package} loaded — ${contributed.join(', ') || 'no tools'}`);
    }
    for (const failure of result.failures) {
      warn(`plugin ${failure.package} did not load: ${failure.reason}`);
    }
  };

  /**
   * Which package registered a name, for the log line and the refusal.
   * From the load records rather than a second map: they are the record.
   */
  const contributorOf = (kind: 'executors' | 'memory', name: string): string | undefined =>
    loadedPlugins.find((plugin) => plugin.contributions[kind].includes(name))?.package;

  /**
   * Put the operator's executor and memory-store selections into effect,
   * or refuse to start. Refuse, not warn: the built-in executor runs
   * commands on this host, and an operator who selected a sandbox that
   * failed to load must not find their agents on the host anyway; a
   * memory store the same, one write later. A name no plugin registered
   * is named with what is, so a typo reads as one.
   */
  const applyContributionSelections = (): void => {
    const executorName = options.executor;
    if (executorName !== undefined && executorName !== BUILTIN_EXECUTOR_NAME) {
      const contribution = executorContributions.get(executorName);
      if (!contribution) {
        throw new Error(
          `The config selects executor ${executorName}, which no loaded plugin registers`
          + (executorContributions.names().length > 0 ? ` (registered: ${executorContributions.names().join(', ')})` : '')
          + `. Enable the plugin that contributes it, or set executor to ${BUILTIN_EXECUTOR_NAME}.`,
        );
      }
      selectedExecutor = contribution.executor;
      log(`executor ${executorName} selected, from ${contributorOf('executors', executorName) ?? 'a plugin'}`);
    }
    const memoryName = options.memoryStore;
    if (memoryName !== undefined && memoryName !== BUILTIN_MEMORY_STORE_NAME) {
      const contribution = memoryContributions.get(memoryName);
      if (!contribution) {
        throw new Error(
          `The config selects memoryStore ${memoryName}, which no loaded plugin registers`
          + (memoryContributions.names().length > 0 ? ` (registered: ${memoryContributions.names().join(', ')})` : '')
          + `. Enable the plugin that contributes it, or set memoryStore to ${BUILTIN_MEMORY_STORE_NAME}.`,
        );
      }
      selectedMemory = contribution.store;
      selectedMemorySupersedesMany = contribution.supersedesMany === true;
      log(`memory store ${memoryName} selected, from ${contributorOf('memory', memoryName) ?? 'a plugin'}`);
    }
  };

  /**
   * Load the operator's `~/.stratus/skills/` into the catalog. Before the
   * plugins, deliberately: an operator's bare id outranks a plugin's bare
   * alias for the same name, and the plugin's skill stays reachable by its
   * qualified `<package>:<skill>` form.
   */
  const startSkills = async (): Promise<void> => {
    await registerBuiltinSkills(skillCatalog);
    operatorSkills = await loadOperatorSkills(env, skillCatalog, warn);
    for (const skill of operatorSkills) {
      log(`skill ${skill.id} loaded from ${skill.path}`);
    }
  };

  /**
   * Everything after the plugins: the roster, the channels, and the sweeps
   * that need both. Split out so `start()` can wrap it in the cleanup a
   * failure here requires — see the call site.
   */
  const startServing = async (): Promise<void> => {
    // The stamp, once more, before anything here writes: the CLI checked it
    // before `serve`, but a newer build can stamp the home between that
    // check and this start, and the sweeps below save sessions in this
    // build's shape. Checked before the channels bind rather than after —
    // the control API announces its address the moment it is up, and every
    // I/O await between that announcement and `serving = true` is a window
    // in which a restart asked for at once is refused as "still starting".
    // The scheduler's own readiness check, which runs after the channels,
    // covers a stamp that advances while a slow channel is coming up, and
    // it is synchronous for the same reason: the check is a file read, and
    // an async one in that stretch failed CI's restart tests twice.
    assertStateCompatible(env);
    // A home whose pre-15a state has not been moved yet is refused rather
    // than served, because serving it is the quiet failure: the stores open
    // on the new paths, find nothing, and the fleet starts writing a second
    // population beside every session, schedule, and grant it already had.
    //
    // Refused rather than migrated, even though this process is the daemon:
    // the move needs the home to *itself*, and holding the claim is
    // something the host does (`claimHome`) — a gateway that migrated on
    // its own would be asserting an exclusivity nobody gave it. `stratus
    // serve` runs the migration before it ever gets here, so this only
    // fires for a host wiring the gateway up itself.
    // Against `stateDir` — the directory the stores were actually opened
    // on — rather than the one `env` names. A host that pointed them
    // somewhere else would otherwise be told its home is fine while the
    // sessions it is stranding sit in the directory it chose.
    if (await hasBracketedLegacyStateIn(stateDir)) {
      throw new Error(
        `${stateDir} still holds pre-per-agent state (a shared sessions.db, or an <id>.whitelist.json beside the souls), `
        + 'and serving it now would strand every session, schedule, and grant in it. '
        + (stateDir === stratusHomePath(env)
          ? 'Run `stratus update`, or — for a host starting the gateway itself — claim the home with `claimHome` and '
            + 'await `runStateMigrations(env, { exclusive: true })` from @stratusagent/state before calling start().'
          : 'This is a state directory of your own choosing, which `stratus update` does not migrate: move that state '
            + 'into the layout yourself, or point `stateDir` at a directory that has been through it.'),
      );
    }
    // Before the sweeps below read a single session id: the index and the
    // per-agent stores are two durable writes where the shared database had
    // one primary key, and a crash between them left them disagreeing.
    // Reconciling here is what makes that disagreement resolve one way —
    // a claim with no conversation released, a conversation the index lost
    // re-indexed — rather than leaving an abandoned turn unreachable by the
    // sweep that was supposed to fail it honestly.
    const reconciled = await store.reconcile();
    if (reconciled.released.length > 0 || reconciled.reindexed.length > 0) {
      log(
        `session index reconciled: ${reconciled.reindexed.length} re-indexed, `
        + `${reconciled.released.length} claim(s) released`,
      );
    }
    await loadRoster();
    // Agents loaded and the memory store chosen: a plugin that turned memory
    // passes on in its setup had neither, so the claims a crash left open
    // are settled now, before any turn can end and ask for a pass.
    await memoryPassHost.ready();
    intakeState = await readIntakeState(env, warn);
    if (intakeState.paused) {
      log(`intake is paused (since ${intakeState.since ?? 'unknown'}); new work will be refused until it resumes`);
    }
    const named = registry.list().map((agent) => agent.name).join(', ');
    log(`stratusd ready — ${registry.list().length} agent(s): ${named}`);

    // Read before anything can dispatch, so this is exactly what the
    // last process left running and not a turn of ours caught in flight.
    // Applied further down, once there is somewhere for the failure to
    // be heard.
    const abandoned = await listAbandonedTurns();
    // Likewise: which parked sub-sessions have a parent still inside its
    // agent.delegate call is only answerable while nothing can resume that
    // parent. See listOrphanedDelegations.
    const orphaned = await listOrphanedDelegations();
    orphanedAtStart = orphaned;

    // Channels come up after the roster so their first inbound message
    // already has agents to dispatch to. One failing adapter must not
    // keep the rest (or the gateway) down. The host's adapters first, then
    // the plugins' in load order — the `plugins` block's order, which is
    // the one an operator can read.
    const adapters: GatewayChannelAdapter[] = [
      ...(options.channels ?? []),
      ...channelContributions.list().map((contribution) => contribution.adapter),
    ];
    if (heldState) {
      // Held: only the operator's surface comes up, and everything that
      // would touch work waits for promote(), in the same order.
      await startChannels(adapters.filter((adapter) => adapter.servesWhileHeld === true));
      deferredStart = { adapters: adapters.filter((adapter) => adapter.servesWhileHeld !== true), orphaned, abandoned };
      log('stratusd is held: answering health only, until promoted');
      return;
    }
    await startChannels(adapters);
    await beginWork(orphaned, abandoned);
  };

  const startChannels = async (adapters: GatewayChannelAdapter[]): Promise<void> => {
    for (const adapter of adapters) {
      // A stop that began while an earlier channel was starting stops what
      // is up; starting more after it would leave one it never sees, or
      // one whose start never returns holding the stop open.
      if (stopping) {
        return;
      }
      try {
        await adapter.start(gateway);
        // A shutdown that gave up waiting on this start has already stopped
        // the channels it could see; one that comes up after that is
        // stopped here, or it would stay connected beside the next daemon.
        if (channelsClosed) {
          try {
            await adapter.stop();
          } catch (stopError) {
            warn(`channel ${adapter.name} started after the shutdown stopped the channels, and failed to stop: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
          }
          return;
        }
        startedChannels.push(adapter);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!adapter.required) {
          warn(`channel ${adapter.name} failed to start: ${reason}`);
        }
        // A start() that rejected may still hold sockets or listeners it
        // acquired before failing; it never reaches startedChannels, so
        // this is its only cleanup.
        try {
          await adapter.stop();
        } catch (stopError) {
          warn(`channel ${adapter.name} cleanup after failed start also failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
        }
        if (adapter.required) {
          // Before the scheduler and the sweeps below, deliberately: a
          // daemon that is not going to serve must not fire a catch-up
          // slot or re-ask a parked approval on its way out. The channels
          // already up are left to the shutdown this throw becomes, which
          // denies what they parked and lets those denials reach them
          // BEFORE it stops them — stopped here, a channel that had parked
          // a gated turn in the window would never learn to retract its
          // buttons.
          throw new Error(`${adapter.name} could not start, and the gateway cannot serve without it: ${reason}`);
        }
      }
    }
  };

  const beginWork = async (
    orphaned: ReadonlySet<string>,
    abandoned: string[],
  ): Promise<void> => {
    // After the channels, so a catch-up firing has somewhere to report and
    // the missed-window log lines land in a gateway whose surfaces are
    // listening. The sweep inside is quick (store reads); the firings it
    // may start are tracked, not awaited.
    await scheduler.start();

    // Last, and not awaited: recovery re-asks, so it needs the channels
    // above already listening — but a turn parked behind a slow approver
    // must not hold up start(), or a daemon with one outstanding request
    // would refuse to finish booting.
    void recoverParkedTurns(orphaned).catch((error) => {
      warn(`recovering parked turns failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    // Not awaited for the same reason, and independent of the sweep
    // above: these sessions are not parked, so the two never touch the
    // same one.
    void failAbandonedTurns(abandoned).catch((error) => {
      warn(`failing abandoned turns failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  let promoting: Promise<void> | undefined;
  /**
   * Why the work of a promotion could not begin, once it could not. Final:
   * the scheduler stops for good when its readiness check fails (a newer
   * build stamped the home), so a retry would report success with every
   * schedule silently off. The daemon stays held and says why until it is
   * restarted.
   */
  let promotionFailure: Error | undefined;

  const promote = async (): Promise<void> => {
    if (!heldState) {
      return;
    }
    if (stopping) {
      throw refusal();
    }
    // One promotion at a time: a second call while the first is connecting
    // channels waits for it rather than starting them twice.
    if (promotionFailure !== undefined) {
      throw promotionFailure;
    }
    promoting ??= (async () => {
      const pending = deferredStart;
      if (pending === undefined) {
        throw new Error('The gateway is held but has not finished starting; promote it once health answers.');
      }
      // Skipping any a failed earlier promotion already started, so a retry
      // never starts one twice.
      await startChannels(pending.adapters.filter((adapter) => !startedChannels.includes(adapter)));
      // A stop that began while the channels were connecting has waited
      // for this (see shutdown), and now stops them all. Nothing past here
      // may start once it has.
      if (stopping) {
        throw refusal();
      }
      // Held until the work has actually begun: a scheduler that refuses to
      // start (a newer build stamped the home meanwhile) must leave the
      // daemon held, reporting so, and a retry able to try again.
      try {
        await beginWork(pending.orphaned, pending.abandoned);
      } catch (error) {
        promotionFailure = new Error(
          `This daemon could not begin its work and stays held until it is restarted: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw promotionFailure;
      }
      deferredStart = undefined;
      heldState = false;
      log('stratusd promoted: channels connected, schedules running');
      if (options.onPromoted) {
        // Synchronous throws too: the promotion has happened either way.
        try {
          await options.onPromoted();
        } catch (error) {
          warn(`recording the promotion failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().finally(() => {
      promoting = undefined;
    });
    return promoting;
  };

  /**
   * Both stores, once. Reached from `stop()` and from a `start()` that
   * failed, and a host may call the one after the other; node:sqlite
   * refuses a second close, so this remembers.
   */
  let storesClosed = false;
  const closeStores = (): void => {
    if (storesClosed) {
      return;
    }
    storesClosed = true;
    scheduleStore.close();
    eventStore?.close();
    store.close();
  };

  /**
   * Release what the plugins acquired, reporting rather than throwing.
   * Resolves with whether every plugin let go: a dispose that rejected may
   * still hold the browser or socket it was closing, which a restart has
   * to know before it starts a daemon beside it.
   */
  const disposePlugins = async (): Promise<boolean> => {
    let released = true;
    await Promise.allSettled(loadedPlugins.map(async (plugin) => {
      try {
        await plugin.instance.dispose?.();
      } catch (error) {
        released = false;
        warn(`plugin ${plugin.package} failed to shut down: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    loadedPlugins = [];
    return released;
  };

  /** Set once a shutdown has stopped the started channels; a start that finishes after it stops its own. */
  let channelsClosed = false;

  /** Resolves with `true` when `work` settles before `ms` elapse. */
  const settlesWithin = (work: Promise<unknown>, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void work.then(
        () => { clearTimeout(timer); resolve(true); },
        () => { clearTimeout(timer); resolve(true); },
      );
    });

  let stopped: Promise<void> | undefined;

  /**
   * The one shutdown sequence — for a stop, for a restart, and for a
   * start() that failed, whose caller never reaches stop().
   *
   * `abortAfterMs` is how long in-flight turns get before what is still
   * running is aborted, with `kind` as the reason: a restart so the daemon
   * can come back instead of waiting on one stuck turn, a stop so the
   * abort happens here and not as the service manager's SIGKILL, which
   * would leave the turn unrecorded and its shell commands' process groups
   * running after the daemon. Undefined waits however long it takes: only
   * a start() that failed, whose turns are the few a channel accepted in
   * the moment before. Resolves with whether everything finished — after an abort,
   * a turn that still ignores its signal for a second window is shut down
   * around, and the host is told so it can exit rather than start a new
   * daemon beside it. Every wait after the window opens is bounded by it,
   * the scheduler's own drain included: that drain tracks the same firing
   * the turn drain gave up on, and an unbounded wait there would hold the
   * restart forever on exactly the turn the window exists for.
   */
  const shutdown = async (abortAfterMs: number | undefined, kind: 'restart' | 'stop' = 'restart'): Promise<boolean> => {
    // Refuse new work first; then let channels finish rendering their
    // in-flight turns (already-started dispatches keep running), drain,
    // and close.
    stopping = true;
    // No new firings from here: the tick stops before anything drains,
    // so the drain below is over a set that can only shrink. A tick
    // already past its `stopping` check loses to `dispatch`'s own
    // refusal — the second gate is why this needs no handshake.
    scheduler.stop();
    // Memory passes are low priority: aborted at once rather than drained,
    // settled from what they wrote, then the stop records. Awaited before
    // the stores close, since a settle reads the memory store.
    const passesClosed = memoryPassHost.close().catch((error: unknown) => {
      warn(`memory passes did not close cleanly: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Deny what is parked before draining, or the drain waits out every
    // outstanding approval timeout — a shutdown would hang for as long as
    // the longest request had left. Each denial is a real decision the
    // turn continues from, so the drain below still finishes those turns.
    for (const parked of [...pendingApprovals.values()]) {
      parked.settle('deny', 'cancelled');
    }
    // Everything a restart's window has to cover, in the order a stop
    // does it. The approval resolutions reach their subscribers before the
    // channels go down, or a channel that renders approvals never learns
    // to retract the buttons it is still showing; the channels' stop awaits
    // the rendering they have in flight, which is a running turn's output.
    // All three inside the window: a subscriber or a channel stalled on a
    // stuck turn would otherwise hold the restart outside it.
    // A channel whose stop rejected may still hold its connection — and a
    // replacement daemon opening another would be two of them answering
    // the same messages. Reported, and for a restart, counted as not
    // drained; a plain stop goes on closing either way.
    let channelsReleased = true;
    // Once, whichever path gets there first: the end of the drain, or the
    // window giving up on a turn that ignores its abort.
    let channelsStopping: Promise<void> | undefined;
    const stopChannels = (): Promise<void> => {
      channelsStopping ??= (async () => {
        channelsClosed = true;
        const stopping = [...startedChannels];
        startedChannels.length = 0;
        const stops = await Promise.allSettled(stopping.map((adapter) => adapter.stop()));
        stops.forEach((result, index) => {
          if (result.status === 'rejected') {
            channelsReleased = false;
            warn(`channel ${stopping[index]?.name} failed to stop: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          }
        });
      })();
      return channelsStopping;
    };
    const drain = (async () => {
      await passesClosed;
      // A promotion still connecting channels finishes first, so every
      // channel it started is in the list stopped below; seeing `stopping`,
      // it starts nothing after that.
      await promoting?.catch(() => undefined);
      await Promise.allSettled([...approvalEmissions]);
      // The turns first, with the channels still connected. A channel that
      // disconnects at the start of a drain cannot hear anyone for as long
      // as the drain lasts, and a long turn makes that minutes: a message
      // sent then reached no daemon at all, with no reply and no log line.
      // Connected, it is refused with `GatewayStoppingError`, which the
      // channel can answer and keep for the next daemon. Until the set stays
      // empty: a turn queued behind one that finished joins it.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
      // Then the reviews no turn is waiting on: aborted rather than drained,
      // since what they report is about turns already over, and waited for.
      stopReviews.abort(new Error('The daemon is stopping.'));
      while (reviewsRunning.size > 0) {
        await Promise.allSettled([...reviewsRunning]);
      }
      // Then the channels, whose stop awaits the rendering they still have
      // in flight: the outcomes of the turns that just finished.
      await stopChannels();
    })();
    // One deadline for the whole bounded shutdown: the drain window, then
    // one more window that everything after it shares (the aborted turns'
    // record, the scheduler's drain, the plugins' dispose). A service
    // manager's stop timeout is sized for exactly that (see the CLI's
    // SERVICE_STOP_TIMEOUT_SECONDS); a window per phase would add up past
    // it and land its SIGKILL mid-cleanup.
    const deadline = abortAfterMs === undefined ? undefined : Date.now() + 2 * abortAfterMs;
    const remaining = (): number =>
      deadline === undefined || abortAfterMs === undefined ? 0 : Math.min(abortAfterMs, Math.max(0, deadline - Date.now()));
    let drained = true;
    if (abortAfterMs === undefined) {
      await drain;
    } else if (await settlesWithin(drain, abortAfterMs)) {
      drained = channelsReleased;
    } else {
      warn(`${kind}: ${inflight.size} turn(s) still running after ${abortAfterMs}ms; aborting them`);
      // The watchdog's own mechanism: the runner fails each session with
      // the reason on the signal, saves it, and emits session.failed —
      // so the next daemon finds a finished turn, not an abandoned one.
      // Except a keyed turn, which the resumable abort leaves running for
      // the next daemon to continue once, as a crash would have left it
      // (`shutdownAbort`); its caller is refused (`leftForNext`).
      // Before the loop, so a turn queued behind one aborted here, which
      // starts as soon as that one settles, is aborted the same way.
      abortingWith = kind === 'stop' ? STOPPING_TURN_ERROR : RESTARTING_TURN_ERROR;
      stopReviews.abort(new Error('The daemon is stopping.'));
      for (const running of turnControllers.values()) {
        for (const controller of running) {
          controller.abort(shutdownAbort());
        }
      }
      drained = await settlesWithin(drain, remaining());
      if (!drained) {
        warn(`${kind}: ${inflight.size} turn(s) did not stop after being aborted; shutting down around them`);
        // The drain never got to the channels. Stopped here instead, so a
        // host that goes on to start the next daemon does not find this one
        // still connected beside it; a channel's stop takes its intake down
        // before it waits on anything, so this ends what it can hear even if
        // it never settles.
        await settlesWithin(stopChannels(), remaining());
      }
      drained = drained && channelsReleased;
    }
    // After the turn drain: a firing's wrapper settles after its
    // dispatch does (it retires spent one-shots), so this is the last
    // writer of the schedule table. Bounded once the turn drain has given
    // up: the wrapper it would wait for is around the very turn that
    // ignored its abort.
    const schedulerDrain = scheduler.drain();
    const schedulerWindow = remaining();
    if (drained || abortAfterMs === undefined) {
      await schedulerDrain;
    } else if (!(await settlesWithin(schedulerDrain, schedulerWindow))) {
      warn(`${kind}: a scheduled firing did not stop within ${schedulerWindow}ms after being aborted; shutting down around it`);
    }
    // After the turns that might still be using them. A plugin holding a
    // browser is the reason this exists, and closing it out from under a
    // running screenshot would fail that turn rather than tidy up. Bounded
    // for a restart, whose likeliest reason is a plugin that misbehaves:
    // a dispose that never settles must not be what keeps the daemon from
    // coming back, and a plugin still holding on is one more thing the
    // host should not start a new daemon beside.
    const disposal = disposePlugins();
    const disposalWindow = remaining();
    if (abortAfterMs === undefined) {
      await disposal;
    } else if (await settlesWithin(disposal, disposalWindow)) {
      // A dispose that rejected has already been named; what it may still
      // hold is the same problem as one that never answered.
      drained = drained && await disposal;
    } else {
      warn(`${kind}: a plugin did not release what it holds within ${disposalWindow}ms; shutting down around it`);
      drained = false;
    }
    closeStores();
    log('stratusd stopped');
    return drained;
  };

  const gateway: Gateway = {
    bus,
    store,

    async start() {
      try {
        await migrateLegacyMemory(env);
        // And anything still in the shared `memory.jsonl` a pre-15a build
        // left (or a still-running one of those recreated). Not a
        // migration and never stamped — see `drainSharedMemory`.
        const drained = await drainSharedMemory(env);
        if (drained) {
          log(`shared memory drained: ${drained}`);
        }
        // Before the roster and before channels: a turn must never arrive
        // for an agent whose soul lists a tool the daemon has not
        // registered yet, which would refuse the call as "not permitted"
        // and blame the soul. Skills first for the same reason — and before
        // the plugins, so the operator's bare ids win their aliases (see
        // startSkills).
        await startSkills();
        await startPlugins();
        applyContributionSelections();
        await startServing();
      } catch (error) {
        // A `start()` that rejects never reaches its caller's shutdown path
        // — `stratus serve` awaits it *before* the try/finally that calls
        // `stop()` — so it is the shutdown, in full: a duplicate agent id
        // in the roster would otherwise leave a plugin's browser, socket,
        // or subscription held for the life of a process that is on its
        // way out; the two stores opened before any of this ran would keep
        // their descriptors, four more per attempt in a host that retries
        // a port it cannot bind; and a turn a channel that did come up had
        // already accepted must finish and save before the store it saves
        // to is closed, exactly as it would under a stop().
        await shutdown(undefined);
        throw error;
      }
      serving = true;
    },

    // Drain: channels stop taking messages, in-flight turns get the stop
    // window to finish and are aborted after it, new dispatches are
    // refused, then the database closes. SIGTERM handling in `stratus
    // serve` calls this. Idempotent: a restart stops the gateway itself
    // before handing the process to the host, whose own shutdown path then
    // calls this again and must find nothing to do — and a start() that
    // failed has already run the same sequence.
    stop() {
      if (stopped === undefined) {
        const requested = options.stopDrainTimeoutMs ?? DEFAULT_STOP_DRAIN_TIMEOUT_MS;
        // A stop cannot refuse to happen over its own setting, so a window
        // that would misfire (negative, NaN, or past Node's timer limit,
        // where setTimeout fires at once) falls back rather than throwing.
        const usable = Number.isFinite(requested) && requested >= 0 && requested <= MAX_TIMER_DELAY_MS;
        if (!usable) {
          warn(`stop drain window ${String(requested)}ms is not usable; using ${DEFAULT_STOP_DRAIN_TIMEOUT_MS}ms`);
        }
        stopped = shutdown(usable ? requested : DEFAULT_STOP_DRAIN_TIMEOUT_MS, 'stop').then(() => undefined);
      }
      return stopped;
    },

    dispatch,
    observe,

    async holdsMessage(sessionId: string, idempotencyKey: string) {
      // A dispatch still queued behind another turn holds the message too:
      // its key reaches the transcript only when the chain gets to it. By
      // the same rule as the transcript below — a judged turn still waiting
      // to run did not take the message either.
      if (liveWorkItems.get(sessionId)?.get(idempotencyKey)?.addressed === true) {
        return true;
      }
      const session = await store.get(sessionId);
      if (session === undefined) {
        return false;
      }
      const transcript = workItemState(session, idempotencyKey) !== undefined ? session : await archivedRepeat(session, idempotencyKey);
      // Accepted as addressed: a turn nobody asked for (`addressed: false`,
      // stored overheard) was this agent hearing the message, not taking it.
      const keyed = transcript?.messages.findLast((message) => carriesKey(message, idempotencyKey));
      return keyed !== undefined && keyed.overheard !== true;
    },

    async sessionRouting(sessionId: string) {
      const session = await store.get(sessionId);
      if (!session) {
        return undefined;
      }
      // The reply, not the record: a channel that finishes a turn it did
      // not start needs the one message to post, and the transcript stays
      // the session's own. The latest turn's text only — a turn that
      // produced none has no reply, and an earlier turn's answer is not it.
      const reply = latestTurnReply(session);
      // When this agent last spoke, which is a different question from when
      // its session last changed: a turn saves on tool results, approval
      // checkpoints, and a recovery resuming, all without having said
      // anything. A channel ordering two agents by "who spoke last" has to
      // read the speaking.
      // Speaking is text, or a file: a tool result carrying one is posted
      // into the thread by the channel (`filePathsOf`, the kernel's one
      // reading of that convention), and a chart with no words is the last
      // thing said as surely as a sentence — the in-process handover record
      // already treats it so, and the durable answer must agree with it
      // across a restart. What the session records is what the agent
      // said, for text and file alike, not what the channel delivered: a
      // post Slack refused or an upload that failed reads as spoken here.
      // The channel's own record has the delivery, and this is the
      // reconstruction for a process that lost it. Still open: a delivery
      // record the channel writes back into the session would make this
      // exact (a refused post, a failed upload, a line streamed into a
      // placeholder by a process that died before saving its reply). It is
      // a new gateway seam, and it has to be ordered against the overhears
      // queued on the same session chain, so it is not built yet.
      // A post a tool handed the thread (`postOf`, AGT-324) is speaking the
      // same way a file is.
      const spoken = (message: Message): boolean =>
        (message.role === 'assistant' && message.content.trim().length > 0)
        || (message.role === 'tool' && message.toolResult !== undefined
          && (filePathsOf(message.toolResult).length > 0 || postOf(message.toolResult) !== undefined));
      const spokeIndex = session.messages.findLastIndex(spoken);
      const lastSpokeAt = spokeIndex >= 0 ? session.messages[spokeIndex]?.createdAt : undefined;
      return {
        agentId: session.agent.id,
        metadata: session.metadata ?? {},
        ...(lastSpokeAt !== undefined ? { lastSpokeAt } : {}),
        ...(reply !== undefined ? { reply } : {}),
        ...(isUnaddressedTurn(session) ? { unaddressed: true } : {}),
      };
    },

    rolloverSession(sessionId: string) {
      // On the session's own chain, so no turn can start between the read
      // and the two writes and save the old transcript over the fresh row.
      return onSessionChain(sessionId, async () => {
        // The same stamp check a turn runs: a rollover rewrites a session
        // in this build's shape, and a newer build may have stamped the
        // home with fields this one would drop on the way through.
        assertStateCompatible(env);
        const existing = await store.get(sessionId);
        if (!existing) {
          throw new Error(`No session with id ${sessionId}. GET /sessions lists what exists.`);
        }
        if (existing.status === 'running' || existing.status === 'pending_approval') {
          throw new Error(`Session ${sessionId} has a turn in flight (${existing.status}); roll it over once the turn has finished.`);
        }
        if (typeof existing.metadata?.[ROLLED_OVER_TO_METADATA_KEY] === 'string') {
          throw new Error(`Session ${sessionId} is an archived transcript; roll over the live session ${String(existing.metadata[ROLLED_OVER_TO_METADATA_KEY])} instead.`);
        }
        const now = new Date().toISOString();
        // The time for a reader, a random suffix for uniqueness: two rollovers
        // of one session are serialized on its chain, but inside one
        // millisecond they would mint the same id, and `save` replaces — the
        // second would write the emptied row over the first archive and lose
        // the transcript the rollover exists to keep.
        const archivedAs = `${sessionId}${ROLLED_OVER_SESSION_ID_MARKER}${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        // The archive is the old row whole — messages, usage, provider
        // replay state, its label — under a new id. `save` keeps the
        // timestamps it is given, so the archive's `createdAt` is the
        // conversation's, not the rollover's.
        await store.save({
          ...existing,
          id: archivedAs,
          metadata: { ...(existing.metadata ?? {}), [ROLLED_OVER_TO_METADATA_KEY]: sessionId },
        });
        // What the fresh row keeps is what a channel needs to keep finding
        // the conversation — its routing metadata. What it does not keep:
        // the daemon's own records (a parked call, delegation markers, the
        // label being left behind) and every provider's view of the old
        // transcript, which would resume the old thread verbatim.
        const dropped = new Set<string>([...RESERVED_SESSION_METADATA_KEYS, ...PROVIDER_STATE_METADATA_KEYS]);
        const carried: JsonObject = {};
        for (const [key, value] of Object.entries(existing.metadata ?? {})) {
          if (!dropped.has(key)) {
            carried[key] = value;
          }
        }
        await store.save({
          id: sessionId,
          agent: existing.agent,
          status: 'idle',
          messages: [],
          createdAt: now,
          updatedAt: now,
          metadata: {
            ...carried,
            [SESSION_TRUST_METADATA_KEY]: 'user',
            [ROLLED_OVER_FROM_METADATA_KEY]: archivedAs,
          },
        });
        log(`session ${sessionId} rolled over; its transcript so far is archived as ${archivedAs}`);
        return { sessionId, archivedAs };
      });
    },

    agents() {
      return registry.list();
    },

    async reloadRoster() {
      return (await gateway.reloadRosterAndChannels()).agents;
    },

    async reloadRosterAndChannels() {
      let roster: AgentDefinition[] = [];
      let channels: ChannelReloadOutcome[] = [];
      await reloadsInOrder(async () => {
        // Under the soul lock, so a repoint cannot land between a credential
        // grant's check of the served path and its write (`grantSoulCredential`).
        await withSoulFileLock(loadRoster);
        roster = registry.list();
        log(`roster reloaded — ${roster.length} agent(s): ${roster.map((agent) => agent.name).join(', ')}`);
        // Outside the soul lock, which guards files and must not wait on a
        // network; inside the reload chain, so two reloads never interleave
        // their channel work (the bound keeps one from holding it).
        channels = await reloadChannels();
      });
      return { agents: roster, channels };
    },

    async reloadSkills() {
      try {
        await reloadsInOrder(loadSkills);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warn(`skills reload refused — ${reason}; the previously loaded skills are still serving`);
        throw new Error(`Skills were not reloaded: ${reason} The previously loaded skills are still serving; fix the file and reload again.`);
      }
      return gateway.skills();
    },

    restart(request = {}) {
      if (!options.onRestart) {
        throw new RestartUnsupportedError();
      }
      if (restartStatus) {
        return restartStatus;
      }
      if (stopping) {
        throw new Error('The gateway is already stopping, and a stop does not come back on its own.');
      }
      if (!serving) {
        throw new Error('stratusd is still starting; ask for a restart again once it is serving.');
      }
      const requested = request.drainTimeoutMs ?? options.restartDrainTimeoutMs ?? DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
      // Checked here and not only at the HTTP route: a host calling this
      // directly with a negative or NaN window would get a timer that
      // fires at once, aborting every turn it meant to let finish. Refused
      // before anything is announced, so a bad argument is not a restart.
      if (!Number.isFinite(requested) || requested < 0) {
        throw new Error(`The restart drain window must be a non-negative number of milliseconds, not ${String(requested)}.`);
      }
      // Above Node's maximum timer delay a setTimeout fires at once, so a
      // window asked for as "very long" would abort every turn immediately
      // — the same clamp the approval timeout gets, for the same reason.
      const drainTimeoutMs = Math.min(requested, MAX_TIMER_DELAY_MS);
      if (requested > MAX_TIMER_DELAY_MS) {
        warn(`restart drain window ${requested}ms is above Node's maximum timer delay; using ${MAX_TIMER_DELAY_MS}ms (~24.8 days)`);
      }
      const status: RestartStatus = {
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
        drainTimeoutMs,
        inflight: inflight.size,
      };
      restartStatus = status;
      // Said now, while stdout and the structured log both still work: a
      // process on its way down is the one whose last lines matter, and
      // the one least able to write them.
      log(
        `restart requested${status.reason ? ` (${status.reason})` : ''} — refusing new turns; `
        + `${status.inflight} turn(s) in flight, draining for up to ${drainTimeoutMs}ms`,
      );
      const onRestart = options.onRestart;
      const draining = shutdown(drainTimeoutMs);
      // The host's own shutdown path calls stop() next; it must find this
      // one rather than start a second.
      stopped = draining.then(() => undefined);
      void draining
        .then((drained) => onRestart({ ...(status.reason !== undefined ? { reason: status.reason } : {}), drained }))
        .catch((error) => {
          warn(`restart failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      return status;
    },

    async checkRestart() {
      await options.restartPreflight?.();
    },

    activeTurnId(sessionId) {
      return activeTurns.get(sessionId);
    },

    isSideRun(sessionId) {
      return sideRuns.has(sessionId);
    },

    abortTurns(sessionId, reason) {
      const running = turnControllers.get(sessionId) ?? new Set<AbortController>();
      for (const controller of running) {
        if (!controller.signal.aborted) {
          controller.abort(new RunAbortedError(reason));
        }
      }
      return running.size;
    },

    pendingApprovals() {
      return listPendingApprovals();
    },

    schedules() {
      return scheduler.list();
    },

    cancelSchedule(scheduleId) {
      return scheduler.cancel(scheduleId);
    },

    async receiveEvent(request) {
      if (!eventIntake) {
        return { status: 404, body: { error: 'unknown_source', message: 'No event source is configured at this path.' } };
      }
      const answer = await eventIntake.receive(request);
      // The delivery and its firings are committed; send them now rather
      // than at the next tick. The scheduler decides hold or fire, and does
      // nothing while it is stopped or not yet started.
      if (answer.body.status === 'matched') {
        scheduler.kickEvents();
      }
      return answer;
    },

    eventSummary() {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      if (!eventStore || !eventIntake) {
        return { since, sources: {}, unknownSource: 0 };
      }
      return summarizeEvents({
        sourceIds: eventSourceIds(),
        plugins: Object.fromEntries(pluginEventSources),
        since,
        activity: eventStore.activity(since),
        counters: eventIntake.counters(),
      });
    },

    eventDeliveries(options = {}) {
      return eventStore?.deliveries(options) ?? [];
    },

    memoryPasses(agentId) {
      return memoryPassHost.passes(agentId);
    },

    memoryPass(agentId, passId) {
      return memoryPassHost.pass(agentId, passId);
    },

    tools() {
      // From the registry, not from the load records: the risk reported is
      // the one a call will actually be judged at, floor applied, and a
      // second list assembled from manifests would drift from it the first
      // time a floor was raised.
      const provenanceByName = toolProvenance();
      return tools.describe().map((descriptor) => {
        const provenance = provenanceByName.get(descriptor.name);
        const tool = tools.get(descriptor.name);
        const hooks = ([
          ['command', tool?.commandFor],
          ['origin', tool?.originFor],
          ['destination', tool?.destinationFor],
        ] as const).filter(([, hook]) => hook !== undefined).map(([name]) => name);
        return {
          name: descriptor.name,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          risk: descriptor.risk ?? 'gated',
          ...(provenance ? { package: provenance.package, trusted: provenance.trusted } : {}),
          ...(hooks.length === 1 ? { scopedBy: hooks[0] } : {}),
        };
      });
    },

    skills() {
      // From the registry, not from the load records: the registry is the
      // live answer for which bare aliases still resolve — a plugin loaded
      // later can have retired one a record still remembers.
      const provenance = new Map<string, { package?: string; path: string }>([[STRATUS_SKILL_ID, { path: STRATUS_SKILL_PATH }]]);
      for (const info of operatorSkills) {
        provenance.set(info.id, { path: info.path });
      }
      for (const plugin of loadedPlugins) {
        for (const skill of plugin.skills) {
          provenance.set(skill.id, { package: plugin.package, path: skill.path });
        }
      }
      return skillCatalog.list().map((skill) => {
        const alias = skillCatalog.idsFor(skill.id).find((id) => id !== skill.id);
        const from = provenance.get(skill.id);
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          ...(alias !== undefined ? { alias } : {}),
          ...(from?.package !== undefined ? { package: from.package } : {}),
          ...(from !== undefined ? { path: from.path } : {}),
          ...(skill.builtin === true ? { builtin: true } : {}),
        };
      });
    },

    plugins() {
      const loaded: GatewayPluginStatus[] = loadedPlugins.map((plugin) => ({
        package: plugin.package,
        name: plugin.name,
        trusted: plugin.trusted,
        tools: plugin.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          risk: tool.risk,
          package: plugin.package,
          trusted: plugin.trusted,
        })),
        // The alias comes from the live registry, exactly as `skills()`
        // derives it: a plugin loaded later can have retired it, and this
        // listing must not advertise a bare id `skill.read` would refuse.
        skills: plugin.skills.map((skill) => {
          const alias = skillCatalog.idsFor(skill.id).find((id) => id !== skill.id);
          return {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            ...(alias !== undefined ? { alias } : {}),
            package: plugin.package,
            path: skill.path,
          };
        }),
        providers: plugin.contributions.providers,
        channels: plugin.contributions.channels,
        memory: plugin.contributions.memory,
        executors: plugin.contributions.executors,
      }));
      const failed: GatewayPluginStatus[] = pluginFailures.map((failure) => ({
        package: failure.package,
        error: failure.reason,
      }));
      return [...loaded, ...failed];
    },

    providers() {
      const contributed = loadedPlugins.flatMap((plugin) =>
        plugin.contributions.providers.map((name) => ({ name, package: plugin.package })));
      return [...BUILTIN_PROVIDER_NAMES.map((name) => ({ name })), ...contributed];
    },

    async servedSouls() {
      // From the registry rather than `sources` directly, so the order and
      // the membership are the roster's own — one entry per agent `agents()`
      // reports, and no entry for a source the registry no longer serves.
      return Promise.all(registry.list().map(async (agent) => {
        const source = sources.get(agent.id);
        // Re-read, not re-registered: this is a read, and a caller asking
        // what the daemon would bill must not reshape the roster as a side
        // effect. `refreshAgent` still owns that on the dispatch path.
        const fresh = source?.soulPath
          ? await loadSoulFile(source.soulPath).catch(() => undefined)
          : undefined;
        if (fresh && fresh.agent.id !== agent.id) {
          // The file was given to another agent. `refreshAgent` refuses every
          // dispatch for this id until the roster reloads, so there is no
          // runtime being served under it — reporting the cached pins would
          // claim billing for turns that cannot run, and reporting no soul at
          // all would claim the daemon-wide default instead. It is omitted.
          return undefined;
        }
        // Unreadable is the one case the cache answers for: the gateway goes
        // on dispatching from the soul it loaded, so those pins are live.
        const soul = fresh ?? source?.soul;
        return { id: agent.id, ...(soul ? { soul } : {}) };
      })).then((entries) => entries.filter((entry) => entry !== undefined));
    },

    resolveApproval,

    intake() {
      return intakeView();
    },

    async pauseIntake(input = {}) {
      let message: string | undefined;
      if (input.message !== undefined) {
        const trimmed = input.message.trim();
        if (trimmed.length === 0) {
          throw new PauseMessageError('A pause message cannot be empty; leave it out to use the default.');
        }
        if (trimmed.length > MAX_PAUSED_MESSAGE_LENGTH) {
          throw new PauseMessageError(`A pause message is at most ${MAX_PAUSED_MESSAGE_LENGTH} characters; this one is ${trimmed.length}.`);
        }
        message = trimmed;
      }
      return intakeTransition(async () => {
        const next: IntakeState = {
          paused: true,
          ...(message !== undefined ? { message } : {}),
          since: intakeState.paused && intakeState.since ? intakeState.since : new Date().toISOString(),
        };
        // Durable first: a pause the process reports but would forget at
        // the next crash is the gap the file exists to close.
        await writeIntakeState(env, next);
        intakeState = next;
        log('intake paused: new work will be refused until it resumes');
        return intakeView();
      });
    },

    held() {
      return heldState;
    },

    promote,

    async resumeIntake() {
      return intakeTransition(async () => {
        await writeIntakeState(env, { paused: false });
        if (intakeState.paused) {
          log('intake resumed');
        }
        intakeState = { paused: false };
        return intakeView();
      });
    },
    provideCredential,
  };

  return gateway;
};

// Restart, stop and pause, in their own module (see the top of lifecycle.ts).
export {
  type ChannelReloadOutcome,
  DEFAULT_CHANNEL_RELOAD_TIMEOUT_MS,
  DEFAULT_PAUSED_MESSAGE,
  DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
  DEFAULT_STOP_DRAIN_TIMEOUT_MS,
  GatewayStoppingError,
  HELD_MESSAGE,
  IntakePausedError,
  type IntakeState,
  MAX_PAUSED_MESSAGE_LENGTH,
  PauseMessageError,
  RESTARTING_TURN_ERROR,
  type RestartOutcome,
  type RestartRequest,
  type RestartStatus,
  RestartUnsupportedError,
  STOPPING_TURN_ERROR,
} from './lifecycle.ts';

// The gateway's public types, in their own module (see the top of types.ts).
export {
  type ApprovalRequester,
  type ApprovalTransport,
  type DispatchInput,
  type Gateway,
  type GatewayApprovalRequest,
  type GatewayChannelAdapter,
  type GatewayOptions,
  type GatewayPluginStatus,
  type GatewayProviderStatus,
  type GatewayReviewRequest,
  type GatewaySkill,
  type GatewayTool,
  type ObserveInput,
  type PendingApproval,
  type ProvideCredentialInput,
  type ProvideCredentialResult,
  type ResolveApprovalInput,
  type SessionRouting,
} from './types.ts';

// Reserved session keys and markers, in their own module (see the top of session-keys.ts).
export {
  ABANDONED_TURN_ERROR,
  DEFAULT_SUB_AGENTS_PER_TURN,
  EXECUTOR_METADATA_KEY,
  isSubAgentSession,
  ORPHANED_DELEGATION_ERROR,
  RESERVED_SESSION_METADATA_KEYS,
  reservedSessionMetadataKey,
  ROLLED_OVER_FROM_METADATA_KEY,
  ROLLED_OVER_SESSION_ID_MARKER,
  ROLLED_OVER_TO_METADATA_KEY,
  SUB_AGENT_METADATA_KEY,
  SUB_AGENT_SESSION_ID_MARKER,
} from './session-keys.ts';
