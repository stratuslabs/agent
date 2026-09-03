import { api, connectEvents, ApiError } from './lib/api.js';
import { clear, el } from './lib/dom.js';
import { avatar } from './lib/avatar.js';
import { createLatest } from './lib/latest.js';
import { renderDashboard } from './views/dashboard.js';
import { renderAgent } from './views/agent.js';
import { renderSettings } from './views/settings.js';
import { renderPlugins } from './views/plugins.js';

/**
 * Everything the page knows, in one object.
 *
 * A store and a full re-render rather than fine-grained bindings: the whole
 * document is a few hundred nodes, and correctness-by-rerender beats a
 * diffing scheme nobody will maintain. The chat transcript is the one
 * exception — it appends, because re-rendering a streaming reply per token
 * would fight the scroll position.
 */
export const store = {
  route: { name: 'dashboard' },
  health: undefined,
  agents: [],
  sessions: [],
  approvals: [],
  activity: [],
  stream: 'connecting',
  /** Set when the daemon stops answering, so the page says so instead of going stale. */
  offlineSince: undefined,
};

const listeners = new Set();
export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

let renderQueued = false;
export const render = () => {
  // Coalesced: a burst of events during a streaming turn would otherwise
  // re-render the shell per token.
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    paint();
  });
};

export const navigate = (route) => {
  // A different session on the same agent is the same view, told to switch —
  // not a new one, or opening a conversation from the dashboard would
  // discard whatever the composer already had in it.
  if (route.name === 'agent' && store.route.name === 'agent'
      && route.agentId === store.route.agentId && route.sessionId) {
    current.view?.openSession?.(route.sessionId);
  }
  store.route = route;
  const hash = route.name === 'agent'
    ? `#/agents/${encodeURIComponent(route.agentId)}`
    : route.name === 'settings'
      ? `#/settings/${route.section}`
      : `#/${route.name}`;
  if (location.hash !== hash) {
    history.pushState(null, '', hash);
  }
  render();
  void refreshForRoute();
};

const routeFromHash = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'agents' && parts[1]) {
    return { name: 'agent', agentId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'settings') {
    return { name: 'settings', section: parts[1] ?? 'providers' };
  }
  if (parts[0] === 'plugins') {
    return { name: 'plugins' };
  }
  return { name: 'dashboard' };
};

// ---- data ----------------------------------------------------------------

/**
 * Refresh the shared data every screen leans on.
 *
 * A 401 here means the daemon restarted — its cookie sessions live in memory —
 * so the page says exactly that instead of rendering an empty roster that
 * looks like a fleet that vanished.
 */
// Overlapping refreshes settle latest-wins — see lib/latest.js for the
// approval this lost.
const coreRefresh = createLatest();

export const refreshCore = async () => {
  const ticket = coreRefresh.begin();
  try {
    const [health, agents, approvals] = await Promise.all([
      api.health(),
      api.agents(),
      api.approvals(),
    ]);
    if (!coreRefresh.isCurrent(ticket)) {
      return;
    }
    store.health = health;
    store.agents = agents.agents ?? [];
    store.approvals = approvals.approvals ?? [];
    store.offlineSince = undefined;
  } catch (error) {
    if (!coreRefresh.isCurrent(ticket)) {
      return;
    }
    if (error instanceof ApiError && error.status === 401) {
      store.route = { name: 'signed-out' };
    } else {
      store.offlineSince = store.offlineSince ?? Date.now();
    }
  }
  render();
};

const refreshForRoute = async () => {
  if (store.route.name === 'dashboard') {
    const listed = await api.sessions(undefined, 12).catch(() => ({ sessions: [] }));
    store.sessions = listed.sessions ?? [];
    render();
  }
};

// ---- live stream ---------------------------------------------------------

const ACTIVITY_LIMIT = 200;

/**
 * Which session belongs to which agent.
 *
 * Only `session.created` carries the agent, so it seeds this and everything
 * later in that conversation reads from it — the same trick the daemon's own
 * log writer uses, and for the same reason.
 */
const agentBySession = new Map();

/**
 * One line of the activity feed, or null for events that are not news.
 *
 * `session.updated` and `provider.response` are the loop talking to itself:
 * a status of "running" the instant after "started a conversation", and a
 * response that the tool lines below already describe. Rendering them fills
 * the feed with restatements and pushes the things a person actually wants
 * to see off the top of it.
 */
const describe = (envelope) => {
  const event = envelope.event;
  switch (event.type) {
    case 'session.created': return 'started a conversation';
    case 'session.completed': return 'finished a turn';
    case 'session.failed': return `turn failed — ${event.error}`;
    case 'tool.called': return `ran ${event.call.toolName}`;
    case 'tool.completed': return `${event.result.toolName} ${event.result.ok ? 'succeeded' : 'failed'}`;
    case 'tool.denied': return `${event.call.toolName} was denied`;
    case 'tool.approval-requested': return `${event.call.toolName} needs approval`;
    case 'tool.approval-resolved': return `approval ${event.answer} (${event.reason})`;
    default: return null;
  }
};

/** Handlers a screen installs to watch its own conversation live. */
const envelopeHandlers = new Set();
export const onEnvelope = (fn) => {
  envelopeHandlers.add(fn);
  return () => envelopeHandlers.delete(fn);
};

/**
 * How many screens are listening. Exposed so a leak is observable: a view
 * that is replaced without being torn down keeps updating detached DOM and
 * re-fetching on every completed turn, and the only symptom is a page that
 * gets slower the more of it you have used.
 */
export const envelopeHandlerCount = () => envelopeHandlers.size;

const handleEnvelope = (envelope) => {
  for (const handler of envelopeHandlers) {
    handler(envelope);
  }

  if (envelope.event.type === 'session.created') {
    agentBySession.set(envelope.sessionId, envelope.event.agentId);
  }

  // Deltas are a per-token firehose. They drive the transcript through the
  // handlers above; putting each one in an activity feed would render nothing
  // but noise and pin the CPU.
  const text = describe(envelope);
  if (text) {
    const agentId = agentBySession.get(envelope.sessionId)
      ?? store.sessions.find((session) => session.id === envelope.sessionId)?.agentId;
    store.activity.unshift({
      at: Date.now(),
      sessionId: envelope.sessionId,
      agent: store.agents.find((candidate) => candidate.id === agentId)?.name ?? agentId,
      text,
    });
    store.activity.length = Math.min(store.activity.length, ACTIVITY_LIMIT);
  }

  // Approvals and roster activity are shared state, so they refresh for
  // everyone rather than only for whoever is looking at the right screen.
  // The whole core, not the approvals list alone: the "awaiting approval"
  // count comes from /health, and a list refreshed on its own left the
  // counter at zero next to a card that said one was waiting.
  const type = envelope.event.type;
  if (type === 'tool.approval-requested' || type === 'tool.approval-resolved') {
    void refreshCore();
  }
  if (type === 'session.completed' || type === 'session.failed' || type === 'session.created') {
    void refreshCore();
    void refreshForRoute();
  }
  render();
};

// ---- shell ---------------------------------------------------------------

const logo = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 15a4 4 0 0 1 3.2-3.9A5.5 5.5 0 0 1 17 10.3 3.6 3.6 0 0 1 20.5 15 3.5 3.5 0 0 1 17 18H6.5A3.5 3.5 0 0 1 3 15Z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
};

/**
 * Whether an agent counts as active right now.
 *
 * The API reports a timestamp and a count, deliberately not a verdict — the
 * window is a rendering decision, and it lives here so changing it does not
 * mean upgrading a daemon. Both inputs matter: a turn parked on a human has
 * not saved since it parked, so the timestamp alone would call it idle at
 * exactly the moment it most needs attention.
 */
const ACTIVE_WINDOW_MS = 10 * 60_000;
export const isActive = (agent) =>
  (agent.activeSessions ?? 0) > 0
  || (agent.lastActiveAt !== undefined && Date.now() - Date.parse(agent.lastActiveAt) < ACTIVE_WINDOW_MS);

const sidebar = () => {
  const route = store.route;
  const item = (label, target, extra = {}) => el('button', {
    class: `nav-item${extra.sub ? ' sub' : ''}${extra.active ? ' active' : ''}`,
    onClick: () => navigate(target),
  }, extra.children ?? label);

  return el('nav', { class: 'sidebar' },
    el('div', { class: 'brand' }, logo(), 'Stratus Agent'),
    item('Dashboard', { name: 'dashboard' }, { active: route.name === 'dashboard' }),
    item('Plugins', { name: 'plugins' }, { active: route.name === 'plugins' }),
    el('div', { class: 'nav-section' }, 'Settings'),
    ...['providers', 'models', 'channels'].map((section) => item(
      section.charAt(0).toUpperCase() + section.slice(1),
      { name: 'settings', section },
      { sub: true, active: route.name === 'settings' && route.section === section },
    )),
    el('div', { class: 'nav-section' }, 'Agents'),
    ...store.agents.map((agent) => item(agent.name, { name: 'agent', agentId: agent.id }, {
      active: route.name === 'agent' && route.agentId === agent.id,
      children: el('span', { class: 'agent-row' },
        avatar(agent),
        el('span', { class: 'grow' }, agent.name),
        el('span', { class: `dot${isActive(agent) ? '' : ' idle'}`, title: isActive(agent) ? 'active recently' : 'idle' }),
      ),
    })),
    el('div', { class: 'sidebar-foot' },
      el('span', {}, 'Stratus Agent'),
      el('span', {}, `v${store.health?.version ?? '—'}`),
    ),
  );
};

const signedOut = () => el('div', { class: 'main solo' },
  el('div', { class: 'card' },
    el('h2', {}, 'Not signed in'),
    el('p', {}, 'This browser has no session with stratusd. Sessions live in the daemon’s memory, so restarting it signs you out.'),
    el('p', { class: 'field-note' }, 'Run stratus dashboard in a terminal to open a fresh one.'),
  ),
);

/**
 * A view is `{ node, update? }`, and the difference matters.
 *
 * Rebuilding the whole document on every store change is fine for the shell,
 * which holds no state a person can lose. It is wrong for a screen with a
 * text box and a streaming transcript: a repaint per token would take the
 * caret out of the composer mid-sentence and rebuild a reply as it arrives.
 * So a view is constructed once per route and told to update itself, and it
 * decides what is safe to touch.
 */
let current = { key: undefined, view: undefined };

const routeKey = (route) => route.name === 'agent'
  ? `agent:${route.agentId}`
  : route.name === 'settings'
    ? `settings:${route.section}`
    : route.name;

const buildView = (route) => {
  switch (route.name) {
    case 'agent': return renderAgent(route.agentId, route.sessionId);
    case 'settings': return renderSettings(route.section);
    case 'plugins': return renderPlugins();
    default: return renderDashboard();
  }
};

const paint = () => {
  const root = document.getElementById('app');

  if (store.route.name === 'signed-out') {
    current.view?.destroy?.();
    current = { key: undefined, view: undefined };
    root.replaceChildren(signedOut());
    return;
  }

  const key = routeKey(store.route);
  if (key !== current.key || !current.view) {
    // Torn down before it is dropped. The agent view subscribes to the event
    // stream; without this, every agent ever visited keeps a live handler
    // updating detached DOM and re-fetching transcripts on every completed
    // turn — work that multiplies with each screen someone opens.
    current.view?.destroy?.();
    current = { key, view: buildView(store.route) };
  } else {
    current.view.update?.();
  }
  root.replaceChildren(sidebar(), current.view.node);
};

// ---- boot ----------------------------------------------------------------

window.addEventListener('popstate', () => {
  store.route = routeFromHash();
  render();
  void refreshForRoute();
});

store.route = routeFromHash();
await refreshCore();
await refreshForRoute();

connectEvents({
  onEnvelope: handleEnvelope,
  onStatus: (status) => {
    store.stream = status;
    if (status === 'offline') {
      // Ask now rather than wait for an event that will not come: with the
      // daemon gone there are no events, so nothing else would notice, and
      // the page kept its last numbers under a "reconnecting" dot through a
      // whole outage. A failed refresh raises the offline banner; a 401
      // after a restart signs the page out.
      void refreshCore();
    }
    if (status === 'live') {
      // Reconnected: whatever happened while the socket was down is only in
      // the store, so re-read rather than leaving a stale page behind.
      void refreshCore();
      void refreshForRoute();
      // Shared data is not enough for a view holding a turn of its own. A
      // completion that arrived during the outage is never replayed, so a
      // chat view would sit disabled on "Working…" for a turn that finished
      // minutes ago.
      void current.view?.reconcile?.();
    }
    render();
  },
});

render();
