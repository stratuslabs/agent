import { ago, clock, duration, el, when } from '../lib/dom.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { statusLine } from '../lib/status.js';
import { conversationTitle, firstLine, sourceOf } from '../lib/sources.js';
import { navigate, statusOf, store } from '../app.js';
import { answeredRow, approvalStack } from './approval.js';

const greeting = (now = new Date()) => {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};

/** The agent a fresh chat goes to: the configured default, else the first on the roster. */
export const defaultAgent = () => store.agents.find((agent) => agent.default) ?? store.agents[0];

/** A conversation's status, as a badge, for the states worth a second look. */
export const sessionBadge = (status) => {
  switch (status) {
    case 'running': return el('span', { class: 'badge accent' }, 'Working');
    case 'pending_approval': return el('span', { class: 'badge warn' }, 'Needs you');
    case 'failed': return el('span', { class: 'badge bad' }, 'Failed');
    default: return null;
  }
};

const offlineBanner = () => el('div', { class: 'banner', role: 'status' },
  icon('unplug', 16),
  el('div', {},
    el('div', { class: 'title' }, `Can’t reach Stratus since ${clock(new Date(store.offlineSince).toISOString())}. What you see may be out of date.`),
    el('div', { class: 'detail' }, 'Start it again on the machine running Stratus, for example with ', el('code', {}, 'stratus service start'), '. This page reconnects on its own.')));

const agentCard = (agent) => {
  const status = statusOf(agent);
  return el('button', { class: 'agent-card', onClick: () => navigate({ name: 'agent', agentId: agent.id }) },
    avatar(agent, 36),
    el('div', { style: 'min-width: 0;' },
      el('div', { class: 'name' }, agent.name),
      el('div', { class: `state ${status.kind}`, title: status.detail },
        el('span', { class: `dot ${status.kind}` }),
        el('span', {}, status.detail ? `${status.label} · ${firstLine(status.detail, 60)}` : status.label))));
};

const recentRow = (session) => {
  const agent = store.agents.find((candidate) => candidate.id === session.agentId);
  const source = sourceOf(session.id, { schedules: store.schedules });
  return el('button', {
    class: 'list-row',
    onClick: () => navigate({ name: 'agent', agentId: session.agentId, sessionId: session.id }),
  },
  agent ? avatar(agent, 28) : el('span', { class: 'source-icon' }, icon(source.icon, 13)),
  el('div', { class: 'text' },
    el('div', { class: 'title' }, conversationTitle(session, { schedules: store.schedules })),
    el('div', { class: 'meta' }, icon(source.icon, 13),
      el('span', {}, `${agent?.name ?? session.agentId} · ${source.label} · ${ago(session.updatedAt)}`))),
  sessionBadge(session.status));
};

const upcomingRow = (schedule) => {
  const agent = store.agents.find((candidate) => candidate.id === schedule.agentId);
  const event = typeof schedule.cadence === 'string' && schedule.cadence.startsWith('on ');
  return el('div', { class: 'list-row' },
    agent ? avatar(agent, 22) : null,
    el('div', { class: 'text' },
      el('div', { class: 'title' }, firstLine(schedule.prompt, 60)),
      el('div', { class: 'meta' }, icon(event ? 'zap' : 'calendar-clock', 12),
        el('span', {}, `${agent?.name ?? schedule.agentId} · ${event ? 'Event' : 'Schedule'}`))),
    el('span', { class: 'when' }, schedule.nextFireAt ? when(schedule.nextFireAt) : 'next event'));
};

const ANSWERED_KEEP_MS = 2 * 60_000;

/** A read that failed, said where its section is, above whatever it last showed. */
const readFailure = (what, error, cached) => el('div', { class: 'notice bad', role: 'alert', style: 'margin-bottom: 8px;' },
  `Could not read ${what}: ${error}${cached ? ' What’s below may be out of date.' : ''}`);

export const renderHome = () => {
  const state = { expanded: false, expiry: undefined };
  const node = el('div', { class: 'page-scroll' });

  const update = () => {
    const agents = store.agents;
    const offline = store.offlineSince !== undefined;
    const uptime = store.health?.uptimeMs !== undefined ? ` · up ${duration(store.health.uptimeMs)}` : '';
    const fresh = defaultAgent();
    const upcoming = [...store.schedules]
      .filter((schedule) => schedule.nextFireAt || (typeof schedule.cadence === 'string' && schedule.cadence.startsWith('on ')))
      .sort((a, b) => (a.nextFireAt ?? '9999').localeCompare(b.nextFireAt ?? '9999'))
      .slice(0, 3);
    const answered = store.answered.filter((entry) => Date.now() - entry.at < ANSWERED_KEEP_MS).slice(0, 3);
    // An answered row goes when its two minutes are up, whether or not
    // anything else happens by then.
    clearTimeout(state.expiry);
    state.expiry = answered.length > 0
      ? setTimeout(update, Math.max(0, Math.min(...answered.map((entry) => entry.at + ANSWERED_KEEP_MS - Date.now()))) + 50)
      : undefined;

    const body = el('div', { class: `page-body${offline ? '' : ''}` },
      offline ? offlineBanner() : null,
      el('div', { class: `page-head${offline ? ' stale' : ''}` },
        el('div', {},
          el('h1', {}, store.sessions.length === 0 && agents.length <= 1 ? 'Welcome to Stratus' : greeting()),
          el('div', { class: 'sub' }, `${statusLine(agents, { approvals: store.approvals, runtimes: store.health?.runtimes })}${uptime}`)),
        fresh ? el('button', { class: 'btn primary', onClick: () => navigate({ name: 'agent', agentId: fresh.id, fresh: true }) }, 'New chat') : null),
      el('div', { class: offline ? 'stale' : '', style: 'display: flex; flex-direction: column; gap: 10px;' },
        ...answered.map(answeredRow),
        approvalStack(store.approvals, { expanded: state.expanded, onToggle: () => { state.expanded = !state.expanded; update(); } })),
      agents.length > 0
        ? el('div', { class: `agent-cards${offline ? ' stale' : ''}` }, ...agents.map(agentCard))
        : null,
      // A failed read is not an empty install: only call it empty when both
      // lists were actually read.
      store.sessions.length === 0 && upcoming.length === 0 && store.sessionsError === undefined && store.schedulesError === undefined
        ? el('div', { class: `empty-state${offline ? ' stale' : ''}` },
            fresh ? avatar(fresh, 36) : el('span', { class: 'icon-box' }, icon('message-circle', 18)),
            el('h3', {}, 'No conversations yet'),
            el('p', {}, fresh ? `${fresh.name} is ready. Say hello to see how it works.` : 'Add an agent to start a conversation.'),
            fresh ? el('button', { class: 'btn primary', style: 'margin-top: 8px;', onClick: () => navigate({ name: 'agent', agentId: fresh.id, fresh: true }) }, `Chat with ${fresh.name}`) : null)
        : el('div', { class: `columns${offline ? ' stale' : ''}` },
            el('section', {},
              el('div', { class: 'section-head' }, el('h2', {}, 'Recent conversations')),
              store.sessionsError !== undefined ? readFailure('the conversations', store.sessionsError, store.sessions.length > 0) : null,
              store.sessions.length === 0
                ? (store.sessionsError !== undefined ? null : el('p', { class: 'field-note' }, 'No conversations yet.'))
                : el('div', { class: 'list' }, ...store.sessions.slice(0, 8).map(recentRow))),
            el('section', {},
              el('div', { class: 'section-head' },
                el('h2', {}, 'Schedules coming up'),
                el('button', { class: 'link', onClick: () => navigate({ name: 'schedules' }) }, 'View all')),
              store.schedulesError !== undefined ? readFailure('the schedules', store.schedulesError, upcoming.length > 0) : null,
              upcoming.length === 0
                ? (store.schedulesError !== undefined ? null : el('p', { class: 'field-note' }, 'Nothing scheduled. Agents create schedules when you ask them to do something regularly.'))
                : el('div', { class: 'list compact' }, ...upcoming.map(upcomingRow)))),
    );
    node.replaceChildren(body);
  };

  update();
  // Nothing here holds a caret or a scroll position worth keeping, so it
  // simply rebuilds — the honest default when there is no reason to be
  // cleverer.
  return { node, update, destroy: () => clearTimeout(state.expiry) };
};
