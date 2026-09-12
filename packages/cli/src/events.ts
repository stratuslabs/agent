import type { StratusEvent } from '@stratusagent/core';
import { FORGET_TOOL_NAME, MEMORY_TOOL_NAME } from '@stratusagent/agents';

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
    case 'session.completed':
      return `• session.completed ${event.sessionId}`;
    case 'session.failed':
      return `• session.failed ${event.error}`;
    case 'session.tainted':
      return `• session.tainted ${event.trust} (${event.source})`;
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
      // A memory write or retirement names the entry it touched — the id
      // is a reference, not content, and "when did the agent learn/drop
      // this" is unanswerable later without it. The fact itself stays out
      // of the trace, like every other tool input and output.
      const output = event.result.output;
      const entry = (event.result.toolName === MEMORY_TOOL_NAME || event.result.toolName === FORGET_TOOL_NAME)
        && event.result.ok && typeof output === 'object' && output !== null && !Array.isArray(output)
        && typeof output.id === 'string'
        ? output.id
        : undefined;
      return { tool: event.result.toolName, ok: event.result.ok, ...(entry !== undefined ? { entry } : {}) };
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
    case 'session.failed':
      return { error: event.error };
    case 'session.tainted':
      // The label and what lowered it — a tool's name, or `memory`,
      // `sender`, `legacy`. Never the content that did: same rule as every
      // other event here.
      return { trust: event.trust, source: event.source };
    default:
      return undefined;
  }
};
