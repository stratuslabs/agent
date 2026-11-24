/**
 * Where a conversation came from, read off its session id.
 *
 * The id is the only place this is written down: `web:<agent>:<uuid>` from
 * this page, `slack:<agent>:<team>:<conversation>[:<thread>]` from Slack
 * (a `D…` conversation is a direct message), `schedule:<id>:<slot>` for a
 * schedule's run, `schedule:<trigger id>:event-<key>` for an event
 * trigger's (the gateway runs those in the reserved schedule namespace),
 * and `…:delegate:…` appended when another agent handed the work over.
 * Anything else is shown by its prefix rather than guessed at.
 */
export const sourceOf = (sessionId, { schedules = [] } = {}) => {
  const id = String(sessionId ?? '');
  const parts = id.split(':');
  // The marker is appended after a whole address (prefix, agent, at least
  // one part), so an agent whose id is "delegate" isn't mistaken for it.
  if (parts.indexOf('delegate', 3) >= 3) {
    return { kind: 'delegated', icon: 'users', label: 'Delegated' };
  }
  switch (parts[0]) {
    case 'web':
      return { kind: 'web', icon: 'globe', label: 'Web' };
    case 'slack': {
      const dm = (parts[3] ?? '').startsWith('D');
      return { kind: 'slack', icon: dm ? 'message-circle' : 'hash', label: dm ? 'Slack · DM' : 'Slack' };
    }
    case 'schedule': {
      const schedule = schedules.find((candidate) => candidate.id === parts[1]);
      const prompt = schedule?.prompt ? { prompt: schedule.prompt } : {};
      if ((parts[2] ?? '').startsWith('event-')) {
        // The trigger's own record says which source it listens to.
        const source = /^on (.+) events$/.exec(String(schedule?.cadence ?? ''))?.[1];
        return { kind: 'event', icon: 'zap', label: source ? `Event · ${source}` : 'Event', ...prompt };
      }
      return { kind: 'schedule', icon: 'calendar-clock', label: 'Schedule', ...prompt };
    }
    default:
      return { kind: 'other', icon: 'message-circle', label: parts[0] || 'Conversation' };
  }
};

/** A text's first non-empty line, cut to `max` characters with an ellipsis. */
export const firstLine = (text, max = 80) => {
  const line = String(text ?? '').trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What a conversation is called in a list.
 *
 * The session list carries no title yet, so until it does this says where
 * the conversation came from, which is true, rather than showing an id. A
 * schedule's run has a better name than that: the schedule's own prompt.
 */
export const conversationTitle = (session, context = {}) => {
  if (typeof session.title === 'string' && session.title.trim()) {
    return firstLine(session.title);
  }
  const source = sourceOf(session.id, context);
  switch (source.kind) {
    case 'schedule':
      return source.prompt ? firstLine(source.prompt) : 'Scheduled run';
    case 'web':
      return 'Web conversation';
    case 'slack':
      return source.label === 'Slack · DM' ? 'Slack DM' : 'Slack conversation';
    case 'event':
      return source.prompt ? firstLine(source.prompt) : 'Event run';
    case 'delegated':
      return 'Delegated work';
    default:
      return 'Conversation';
  }
};
