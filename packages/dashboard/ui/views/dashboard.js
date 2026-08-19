import { ago, duration, el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { isActive, navigate, refreshCore, store } from '../app.js';

export const activityPanel = (filter) => {
  const lines = (filter ? store.activity.filter(filter) : store.activity).slice(0, 60);
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Activity'),
      el('span', { class: 'stream-status' },
        el('span', { class: `dot${store.stream === 'live' ? '' : ' offline'}` }),
        store.stream === 'live' ? 'live' : 'reconnecting',
      ),
    ),
    lines.length === 0
      ? el('p', { class: 'empty' }, 'Nothing yet. Events appear here as agents work.')
      : el('div', { class: 'activity' }, ...lines.map((line) => el('div', { class: 'line' },
          el('span', { class: 'when' }, ago(new Date(line.at).toISOString())),
          el('span', { class: 'what', title: line.sessionId },
            line.agent ? `${line.agent} ${line.text}` : line.text),
        ))),
  );
};

const approvalCard = () => {
  if (store.approvals.length === 0) {
    return null;
  }

  const decide = async (requestId, answer) => {
    try {
      await api.resolveApproval({ requestId, answer, actor: 'dashboard' });
    } catch {
      // A request that is no longer pending was already decided, expired, or
      // its turn was cancelled. Refreshing shows the truth; retrying would
      // just fail again.
    }
    await refreshCore();
  };

  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Approvals'),
      el('span', { class: 'pill risk-gated' }, `${store.approvals.length} waiting`),
    ),
    el('div', { class: 'approvals-list' }, ...store.approvals.map((request) => {
      const agent = store.agents.find((candidate) => candidate.id === request.agentId);
      return el('div', { class: 'approval' },
        el('div', { class: 'row' },
          agent ? avatar(agent, 24) : null,
          el('div', { class: 'grow' },
            el('div', { class: 'title' }, `${agent?.name ?? request.agentId} wants to run ${request.call.toolName}`),
            el('div', { class: 'sub' },
              request.expiresAt ? `expires ${ago(request.expiresAt)} from now` : 'no expiry',
              ` · parked ${ago(request.parkedAt)}`),
          ),
          el('span', { class: `pill risk-${request.risk}` }, request.risk),
        ),
        el('div', { class: 'cmd' }, JSON.stringify(request.call.input)),
        el('div', { class: 'actions' },
          el('button', { class: 'primary small', onClick: () => decide(request.requestId, 'once') }, 'Allow once'),
          el('button', { class: 'small', onClick: () => decide(request.requestId, 'always') }, 'Always allow'),
          el('button', { class: 'small danger', onClick: () => decide(request.requestId, 'deny') }, 'Deny'),
        ),
      );
    })),
  );
};

const quickStats = () => {
  const health = store.health;
  const sessions = health?.sessions ?? { total: 0, byStatus: {} };
  const running = sessions.byStatus?.running ?? 0;
  const active = store.agents.filter(isActive).length;

  return el('section', { class: 'card' },
    el('h2', {}, 'Quick Stats'),
    store.offlineSince
      ? el('div', { class: 'banner bad' }, `stratusd stopped answering ${ago(new Date(store.offlineSince).toISOString())} — these numbers are from before that.`)
      : null,
    el('div', { class: 'stats' },
      el('div', { class: 'stat' },
        el('div', { class: 'value' }, String(store.agents.length)),
        el('div', { class: 'label' }, `agents · ${active} active`)),
      el('div', { class: 'stat' },
        el('div', { class: 'value' }, String(running)),
        el('div', { class: 'label' }, 'turns running')),
      el('div', { class: 'stat' },
        el('div', { class: 'value' }, String(sessions.total)),
        el('div', { class: 'label' }, 'sessions stored')),
      el('div', { class: `stat${store.approvals.length > 0 ? ' bad' : ''}` },
        el('div', { class: 'value' }, String(store.approvals.length)),
        el('div', { class: 'label' }, 'awaiting approval')),
      el('div', { class: 'stat' },
        el('div', { class: 'value' }, health ? duration(health.uptimeMs) : '—'),
        el('div', { class: 'label' }, 'uptime')),
    ),
    health?.runtimes?.length
      ? el('div', {},
          el('h3', {}, 'Serving'),
          el('div', { class: 'rows' }, ...health.runtimes.map((runtime) => el('div', { class: 'row' },
            el('div', { class: 'grow' },
              el('div', { class: 'title' }, runtime.model ? `${runtime.provider} · ${runtime.model}` : runtime.provider),
              el('div', { class: 'sub' }, `credentials: ${runtime.credentials}`)),
          ))))
      : null,
  );
};

const recentSessions = () => el('section', { class: 'card' },
  el('div', { class: 'card-head' },
    el('h2', {}, 'Recent Sessions'),
    el('button', { class: 'small', onClick: () => void refreshCore() }, 'Refresh'),
  ),
  store.sessions.length === 0
    ? el('p', { class: 'empty' }, 'No conversations yet. Open an agent to start one.')
    : el('div', { class: 'rows' }, ...store.sessions.map((session) => {
        const agent = store.agents.find((candidate) => candidate.id === session.agentId);
        return el('div', { class: 'row' },
          agent ? avatar(agent, 24) : null,
          el('div', { class: 'grow' },
            el('div', { class: 'title', title: session.id },
              session.id.length <= 34 ? session.id : `${session.id.slice(0, 16)}…${session.id.slice(-10)}`),
            el('div', { class: 'sub' }, `${agent?.name ?? session.agentId} · ${ago(session.updatedAt)}`)),
          el('span', { class: `pill ${session.status}` }, session.status.replace('_', ' ')),
          agent
            ? el('button', {
                class: 'small',
                onClick: () => navigate({ name: 'agent', agentId: agent.id, sessionId: session.id }),
              }, 'Open')
            : null,
        );
      })),
);

export const renderDashboard = () => {
  const node = el('div', { class: 'main' });
  const update = () => node.replaceChildren(
    el('div', { class: 'column' }, quickStats(), approvalCard(), recentSessions()),
    el('div', { class: 'column' }, activityPanel()),
  );
  update();
  // Nothing on this screen holds a caret or a scroll position worth keeping,
  // so it simply rebuilds — the honest default when there is no reason to be
  // cleverer.
  return { node, update };
};
