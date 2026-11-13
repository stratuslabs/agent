/*
 * The events a run emits and the bus that carries them: `StratusEvent`,
 * the union of session, provider, tool, approval, credential and memory
 * events the gateway, channels and dashboard subscribe to, and `EventBus`,
 * which awaits its handlers in order and reports a handler's error without
 * interrupting the run. `index.ts` re-exports every name, so the package's
 * one public entry is unchanged.
 */
import type {
  AlwaysMeans,
  ApprovalAnswer,
  ApprovalDelegationOrigin,
  ApprovalResolutionReason,
  ApprovalScheduleDestination,
  ApprovalVerdict,
  CredentialDelivery,
  CredentialScope,
  JsonObject,
  MemoryPassKind,
  MemoryPassMode,
  MemoryPassReason,
  MemoryPassStatus,
  ProviderDelta,
  ProviderPart,
  SessionStatus,
  StoppedEarlyReason,
  ToolCall,
  ToolResult,
  ToolRisk,
  TrustLevel,
  UsageRecord,
} from './index.ts';

export type StratusEvent =
  | { type: 'session.created'; sessionId: string; agentId: string }
  | { type: 'session.updated'; sessionId: string; status: SessionStatus }
  /**
   * A message entered the session without a turn — `AgentRunner.observe`.
   * Its own event rather than a `session.updated`, because a renderer that
   * takes `running` as "a reply is coming" would open a placeholder for a
   * turn that never speaks. By name only, like everything the log keeps.
   */
  | { type: 'session.observed'; sessionId: string; agentId: string }
  | { type: 'provider.delta'; sessionId: string; delta: ProviderDelta }
  | { type: 'provider.response'; sessionId: string; parts: ProviderPart[] }
  | { type: 'tool.called'; sessionId: string; call: ToolCall }
  | { type: 'tool.completed'; sessionId: string; result: ToolResult }
  | { type: 'tool.denied'; sessionId: string; call: ToolCall }
  /**
   * Why a call was allowed or refused, when the approval policy reports it
   * (`ApprovalContext.decided`). By name, like the log: the call's id and
   * tool, never its input, so a surface can show the decision beside the
   * `tool.called` or `tool.denied` with the same `callId`. A call judged
   * again can have several; the last stands. The runner sends one itself,
   * layer `trust`, when it refuses a call whose label dropped twice while
   * it was being approved.
   */
  | {
      type: 'permission.decided';
      sessionId: string;
      agentId: string;
      callId: string;
      toolName: string;
      risk: ToolRisk;
      allowed: boolean;
      layer: string;
      reason: string;
      verdict?: ApprovalVerdict;
      reviewCode?: string;
      shadow?: boolean;
    }
  /**
   * A gated call is parked, waiting for a human somewhere else. Channels
   * render it (Slack buttons) and resolve it through the gateway; nothing
   * about the request is channel-specific, so the dashboard consumes the
   * same event.
   *
   * `metadata` is the session's, carried because it says where the turn is
   * happening — a channel that renders the request into the conversation it
   * came from needs that without reaching into the store.
   */
  | {
      type: 'tool.approval-requested';
      sessionId: string;
      agentId: string;
      /** Opaque id the decision is quoted back with. */
      requestId: string;
      call: ToolCall;
      risk: ToolRisk;
      /**
       * The origin this call would act on, for a tool judged by one
       * (`Tool.originFor`). Carried because the call's own arguments do not
       * say: a renderer showing `browser.act` with `{"selector":"#submit"}`
       * and an **Always allow** button would be asking somebody to widen a
       * site they were never shown.
       */
      origin?: string;
      /**
       * True when answering `always` runs this call once and remembers
       * nothing. A renderer must not offer an unconditional "always" for
       * one of these — the button would promise a standing grant the engine
       * will not create. See `Tool.originFor` and `ToolRisk`.
       */
      oneShot?: boolean;
      /**
       * What `always` would remember, when it would remember something —
       * see `AlwaysMeans`. A renderer that reports the outcome of an
       * `always` reads this rather than guessing at a lifetime: a grant
       * that survives restarts and one that dies with the session are the
       * same button, and only the request knows which it is.
       */
      always?: AlwaysMeans;
      /**
       * Why the review posture is asking, in one line: the reviewer's words
       * or the rule that asked. A renderer shows it as plain text beside the
       * call; it can echo the call's input, which this event carries anyway.
       */
      reviewNote?: string;
      metadata?: JsonObject;
      /**
       * Where the work was asked for, when this call is in a delegated
       * sub-session (`agent.delegate`): the agent and session at the root of
       * the chain, and that session's metadata. A sub-session has no
       * conversation of its own and its agent may have no channel at all,
       * so a renderer that asks in the conversation it came from asks here.
       * Set by the gateway from its own records, never from a caller.
       */
      delegatedFrom?: ApprovalDelegationOrigin;
      /**
       * Where the schedule this call is running for reports, when it is a
       * live scheduled firing whose schedule was approved with a
       * destination. Not set for work a firing delegates. A firing has no conversation of
       * its own, and that destination is one a person already approved as
       * where it speaks, so a renderer with no approval channel of its own
       * asks there. Set by the gateway from the scheduler's own records,
       * never from session metadata a caller could write.
       */
      scheduleDestination?: ApprovalScheduleDestination;
      /**
       * When the request gives up and denies itself, ISO-8601. Absent when
       * it never will — a deadline of "now" would be a worse lie than
       * saying nothing.
       */
      expiresAt?: string;
    }
  | {
      type: 'tool.approval-resolved';
      sessionId: string;
      requestId: string;
      answer: ApprovalAnswer;
      reason: ApprovalResolutionReason;
      /** Who decided, when a person did. Channel-native id (a Slack user). */
      actor?: string;
    }
  /**
   * An agent asked for a named credential it does not hold
   * (`credential.request`), and it has already been put to someone: a form
   * in the conversation it asked in (`via: 'form'`), or a one-time link the
   * agent was handed to pass on (`via: 'link'`). The request is delivered
   * first and announced after, so this is a record of a question that was
   * asked, never a request for someone to render one. Nothing about it is
   * a secret, and nothing that answers it ever travels on the bus. `scope` is whose the key would be: the
   * agent's own (`agent`, the default) or the fleet's (`shared`).
   *
   * `metadata` is the session's, for the same reason an approval request
   * carries it: it says which conversation to ask in.
   */
  | {
      type: 'credential.requested';
      sessionId: string;
      agentId: string;
      requestId: string;
      name: string;
      scope: CredentialScope;
      /** The agent's own words on what it needs the key for. Untrusted text. */
      reason?: string;
      /** How it was put to someone. Absent from hosts before links existed, which only had forms. */
      via?: CredentialDelivery;
      /** A new value for a key the agent already holds, swapped in place. Always a form, never a link. */
      replace?: boolean;
      /** The variable the agent's shell commands will read the key from once it is added. */
      env?: string;
      metadata?: JsonObject;
    }
  /**
   * A requested credential was stored for the agent that asked, and granted
   * to it. Names only; the value went to the credential store and nowhere
   * else.
   *
   * Emitted once the key is stored, whether or not the grant then landed:
   * a key added from a chat is a change on disk, and a shared one is
   * already usable by every agent granted that name, so it is recorded even
   * when the soul write failed. `grantError` says it did, and why.
   */
  | {
      type: 'credential.provided';
      sessionId: string;
      agentId: string;
      requestId: string;
      name: string;
      scope: CredentialScope;
      /** Who provided it. Channel-native id (a Slack user). */
      actor?: string;
      /** The value replaced one already stored, rather than being added. */
      replace?: boolean;
      /** The variable the agent's shell commands now read the key from. */
      env?: string;
      /** Set when the key was stored but could not be added to the soul. */
      grantError?: string;
    }
  | {
      type: 'session.completed';
      sessionId: string;
      /**
       * The session's usage records — every provider call it has ever made,
       * not only this run's, because that is the stored form and a resumed
       * session's earlier turns are just as real. Absent when nothing
       * reported; a consumer must not read that as zero.
       *
       * A failed run's records are not lost by being missing here: they are
       * saved onto the session before `session.failed` goes out, and
       * `GET /sessions/:id` carries them.
       */
      usage?: UsageRecord[];
    }
  | {
      type: 'session.failed';
      sessionId: string;
      error: string;
      /**
       * True when the host stopped the turn on purpose (`HostRefusalError`):
       * `error` is then a sentence meant for the person in the conversation,
       * and a renderer shows it as it is rather than as a malfunction.
       */
      refused?: true;
    }
  /**
   * Usage a provider call just reported, as it lands: the records added to
   * the session since the last announcement, in the order they were
   * recorded. A harness reporting inner calls through the sink is announced
   * as each report arrives, while its `generate` is still running, so a
   * daemon that dies mid-call has already told a ledger what was spent.
   *
   * Per call rather than once per turn because a turn can make many calls,
   * and a host enforcing a budget has to know what the call before this one
   * spent before it allows the next. `session.completed` arrives too late
   * for that and is never sent for a turn that failed. Emitted for a failed
   * attempt too, whenever it reported anything: the tokens of a call that
   * threw were still spent. `agentId` rides along so a consumer
   * attributing spend to an agent needs no store read.
   *
   * Counts and attribution only, the same records `session.completed`
   * carries, ids included.
   */
  | { type: 'session.usage'; sessionId: string; agentId: string; records: UsageRecord[] }
  /**
   * The session's trust label went down. `source` names what lowered it —
   * a tool, by name, or `memory` (an injected or recalled entry), `sender`
   * (the turn's principal), `legacy` (a transcript from before provenance
   * was tracked). Never the content: this is what the daemon log records,
   * and the log is a trace, not a transcript.
   */
  | { type: 'session.tainted'; sessionId: string; trust: TrustLevel; source: string }
  /**
   * The conversation outgrew the model's context window, so its oldest
   * messages are no longer sent. `droppedMessages` is what this trim gave
   * up; `floor` is the total now held back.
   *
   * Counts only — no content, for the same reason `session.tainted` names
   * only its source: this is what the daemon log records, and the log is a
   * trace, not a second transcript. Worth an event at all because it is
   * otherwise invisible: the answers stay plausible while the agent
   * quietly stops being able to remember the start of the conversation.
   *
   * `summarized` is true when a summary (`CONTEXT_SUMMARY_METADATA_KEY`)
   * now stands in for everything below the window, and false when this cut
   * went without one — the summary call failed, and the model is told the
   * messages are gone. Absent from an emitter older than summaries.
   */
  | { type: 'session.context-trimmed'; sessionId: string; droppedMessages: number; floor: number; summarized?: boolean }
  /**
   * A memory pass ended (spec 962). Counts and statuses, never content.
   * `sessionId` is the pass's own session (`memoryPassSessionId`), so every
   * event still names one; a refused pass names it too, though it never ran.
   */
  | {
    type: 'memory.pass-completed';
    sessionId: string;
    agentId: string;
    passId: string;
    kind: MemoryPassKind;
    mode: MemoryPassMode;
    status: MemoryPassStatus;
    reason?: MemoryPassReason;
    saved: number;
    superseded: number;
  }
  /**
   * A message used its step budget and, with auto-continue on for its
   * agent, was given another instead of wrapping up (`AgentRunnerOptions.autoContinue`).
   * `continuation` counts from 1 within the message; `turns` is the
   * allowance just granted.
   */
  | { type: 'session.continued'; sessionId: string; continuation: number; turns: number }
  /**
   * The message ended in a wrap-up instead of finishing (`Session.stoppedEarly`):
   * emitted just before its `session.completed`. Counts only, like
   * `session.continued`, because the daemon log records it; the summary is
   * the turn's reply.
   */
  | { type: 'session.stopped-early'; sessionId: string; reason: StoppedEarlyReason; continuations: number }
  /**
   * A background task started, or ended (AGT-211): `agent.delegate` with
   * `background: true` wrote it, or settling wrote how it ended. Ids only,
   * never what the task was asked or answered, which stay in its two
   * sessions. `sessionId` and `agentId` are the conversation and agent that
   * started it, where its outcome goes; `workerSessionId` and
   * `workerAgentId` are the ones doing the work, which may be the same
   * agent. Its end is sent once it is written, before the outcome is added
   * to the conversation, and a task ends once: only a restored home that
   * shows a task the row called finished was cut off sends
   * `task.interrupted` after it.
   */
  | {
      type: TaskEventType;
      sessionId: string;
      agentId: string;
      taskId: string;
      workerSessionId: string;
      workerAgentId: string;
    };

/** The background task events: one when a task starts, one for how it ended. */
export type TaskEventType = 'task.started' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.interrupted';

export type TaskEvent = Extract<StratusEvent, { type: TaskEventType }>;

export type EventHandler = (event: StratusEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Called when a subscriber throws. Handler errors never interrupt the run. */
  onError?: (error: unknown, event: StratusEvent) => void;
}

export interface SubscribeOptions {
  /**
   * Run this handler before previously registered ones. Emission awaits
   * handlers in order, so a slow consumer delays everyone after it — a
   * liveness observer (an activity watchdog) must sit in front, or the
   * activity it exists to notice reaches it only after the delay it is
   * timing against.
   */
  prepend?: boolean;
}

export class EventBus {
  private handlers: EventHandler[] = [];
  private readonly onError: EventBusOptions['onError'];

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError;
  }

  subscribe(handler: EventHandler, options: SubscribeOptions = {}): () => void {
    if (options.prepend) {
      this.handlers.unshift(handler);
    } else {
      this.handlers.push(handler);
    }
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  async emit(event: StratusEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      try {
        await handler(event);
      } catch (error) {
        this.onError?.(error, event);
      }
    }
  }
}
