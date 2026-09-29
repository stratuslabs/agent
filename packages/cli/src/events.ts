import type { StratusEvent } from '@stratusagent/core';
import { FORGET_TOOL_NAME, MEMORY_TOOL_NAME, PIN_TOOL_NAME } from '@stratusagent/agents';

export const formatEvent = (event: StratusEvent): string | null => {
  switch (event.type) {
    case 'session.created':
      return `• session.created ${event.sessionId}`;
    case 'session.updated':
      return `• session.updated ${event.status}`;
    case 'session.observed':
      return `• session.observed ${event.sessionId}`;
    case 'provider.response':
      return `• provider.response ${event.parts.length} part(s)`;
    case 'tool.called':
      return `• tool.called ${event.call.toolName}`;
    case 'tool.completed':
      return `• tool.completed ${event.result.toolName} ok=${String(event.result.ok)}`;
    case 'tool.denied':
      return `• tool.denied ${event.call.toolName}`;
    case 'tool.approval-requested':
      return `• tool.approval-requested ${event.call.toolName} (${event.risk}) for ${event.agentId}`;
    case 'tool.approval-resolved':
      return `• tool.approval-resolved ${event.answer} (${event.reason})${event.actor ? ` by ${event.actor}` : ''}`;
    case 'credential.requested':
      return `• credential.requested ${event.name} (${event.scope}) for ${event.agentId}`;
    case 'credential.provided':
      return `• credential.provided ${event.name} (${event.scope}) for ${event.agentId}${event.actor ? ` by ${event.actor}` : ''}`
        + (event.grantError !== undefined ? ' — stored, not granted' : '');
    case 'session.completed':
      return `• session.completed ${event.sessionId}`;
    case 'credential.leased':
      return `• credential.leased ${event.name} for ${event.agentId} ${event.outcome}${event.leaseId ? ` (${event.leaseId})` : ''}`;
    case 'session.failed':
      return `• session.failed ${event.error}`;
    case 'session.tainted':
      return `• session.tainted ${event.trust} (${event.source})`;
    case 'session.context-trimmed':
      return `• session.context-trimmed dropped=${event.droppedMessages} floor=${event.floor}`;
    default:
      return null;
  }
};

/**
 * The fields worth keeping per event type. Tool inputs and message text
 * are deliberately excluded: the log is a trace of what happened, not a
 * second copy of the transcript.
 *
 * The approval pair is the one place the trace carries a person's id, and
 * it earns it: `always` widens what an agent may do unattended for the rest
 * of the session, and "who decided that" is unanswerable afterwards from
 * anything else. The refusal path is warned about by `onDecision`, but an
 * *approval* produces no warning at all — without these two records a
 * granted permission leaves no trace whatsoever. Still no tool input: what
 * was asked is here, what it was asked with is not.
 */
export const eventDetail = (event: StratusEvent): Record<string, unknown> | undefined => {
  switch (event.type) {
    case 'session.updated':
      return { status: event.status };
    case 'provider.response':
      return { parts: event.parts.length };
    case 'tool.called':
    case 'tool.denied':
      return { tool: event.call.toolName };
    case 'tool.completed': {
      // A memory write, retirement, supersession, or pin names the entry it
      // touched — the id is a reference, not content, and "when did the
      // agent learn, drop, replace, or pin this" is unanswerable later
      // without it. The fact itself stays out of the trace, like every
      // other tool input and output.
      const output = event.result.output;
      const fields = (event.result.toolName === MEMORY_TOOL_NAME || event.result.toolName === FORGET_TOOL_NAME
        || event.result.toolName === PIN_TOOL_NAME)
        && event.result.ok && typeof output === 'object' && output !== null && !Array.isArray(output)
        ? output
        : undefined;
      const entry = typeof fields?.id === 'string' ? fields.id : undefined;
      const supersedes = typeof fields?.supersedes === 'string' ? fields.supersedes : undefined;
      const pinned = event.result.toolName === PIN_TOOL_NAME && typeof fields?.pinned === 'boolean'
        ? fields.pinned
        : undefined;
      return {
        tool: event.result.toolName,
        ok: event.result.ok,
        ...(entry !== undefined ? { entry } : {}),
        ...(supersedes !== undefined ? { supersedes } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
      };
    }
    case 'tool.approval-requested':
      return { tool: event.call.toolName, risk: event.risk, requestId: event.requestId };
    case 'tool.approval-resolved':
      return {
        requestId: event.requestId,
        answer: event.answer,
        reason: event.reason,
        ...(event.actor ? { actor: event.actor } : {}),
      };
    // A credential's name and whose it is, and who provided it — the same
    // reason the approval pair names its actor: a key added from a chat is
    // a change to what an agent can do, and "who did that" has no other
    // record. The agent's reason is its own text and stays out; the value
    // never reaches the bus at all.
    case 'credential.requested':
      return { name: event.name, scope: event.scope, requestId: event.requestId };
    case 'credential.provided':
      return {
        name: event.name,
        scope: event.scope,
        requestId: event.requestId,
        ...(event.actor ? { actor: event.actor } : {}),
        ...(event.grantError !== undefined ? { grantError: event.grantError } : {}),
      };
    // Every leased use, allowed or refused — the audit trail a lease
    // exists to leave. The lease that paid, never the key; `use` is the
    // caller's label for what the key was for.
    case 'credential.leased':
      return {
        name: event.name,
        outcome: event.outcome,
        ...(event.leaseId !== undefined ? { leaseId: event.leaseId } : {}),
        ...(event.parentLeaseId !== undefined ? { parentLeaseId: event.parentLeaseId } : {}),
        ...(event.use !== undefined ? { use: event.use } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
    // Counts and attribution per provider call, the ledger's own rows —
    // what `stratus usage` sums, kept in the trace so a spend can be
    // followed to the turn that made it.
    case 'session.usage':
      return { records: event.records };
    case 'session.failed':
      return { error: event.error, ...(event.refused ? { refused: true } : {}) };
    case 'session.tainted':
      // The label and what lowered it — a tool's name, or `memory`,
      // `sender`, `legacy`. Never the content that did: same rule as every
      // other event here.
      return { trust: event.trust, source: event.source };
    case 'session.context-trimmed':
      // Counts, never the messages: the conversation that fell out of the
      // window is exactly the kind of thing the log does not carry.
      return { droppedMessages: event.droppedMessages, floor: event.floor };
    default:
      return undefined;
  }
};
