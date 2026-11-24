import { api, connectEvents, ApiError } from './lib/api.js';
import { el } from './lib/dom.js';
import { avatar } from './lib/avatar.js';
import { icon } from './lib/icons.js';
import { createLatest } from './lib/latest.js';
import { agentStatus } from './lib/status.js';
import { renderHome } from './views/home.js';
import { renderAgent } from './views/agent.js';
import { renderNewAgent } from './views/new-agent.js';
import { renderSettings } from './views/settings.js';
import { renderTools } from './views/tools.js';
import { renderSchedules } from './views/schedules.js';
import { renderTasks } from './views/tasks.js';
import { renderPermissions } from './views/permissions.js';

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
  route: { name: 'home' },
  health: undefined,
  agents: [],
  sessions: [],
  schedules: [],
  approvals: [],
  /**
   * Approvals that were waiting here and got answered somewhere else —
   * Slack, another tab, the CLI — or ran out, kept briefly so the card
   * says what happened instead of vanishing. `{ request, answer, reason, at }`.
   */
  answered: [],
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

const hashFor = (route) => {
  switch (route.name) {
    case 'agent': return `#/agents/${encodeURIComponent(route.agentId)}${route.tab === 'settings' ? '/settings' : ''}`;
    case 'settings': return route.section ? `#/settings/${route.section}` : '#/settings';
    case 'home': return '#/';
    default: return `#/${route.name}`;
  }
};

export const navigate = (route) => {
  // A different session or tab on the same agent is the same view, told to
  // switch — not a new one, or opening a conversation from Home would
  // discard whatever the composer already had in it.
  if (route.name === 'agent' && store.route.name === 'agent' && route.agentId === store.route.agentId) {
    if (route.sessionId) {
      current.view?.openSession?.(route.sessionId);
    }
    if (route.fresh) {
      current.view?.showTab?.('chat');
      current.view?.startSession?.();
    } else if (route.tab) {
      current.view?.showTab?.(route.tab);
    }
  }
  store.route = route;
  const hash = hashFor(route);
  if (location.hash !== hash) {
    history.pushState(null, '', hash);
  }
  render();
  void refreshForRoute();
};

/**
 * The route a hash names. Older links keep working: `#/dashboard` was Home,
 * `#/plugins` is Tools, and `#/settings/<section>` lands on the one
 * Settings page at that section.
 */
export const routeFromHash = (hash) => {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'agents':
      if (parts[1]) {
        return { name: 'agent', agentId: decodeURIComponent(parts[1]), ...(parts[2] === 'settings' ? { tab: 'settings' } : {}) };
      }
      return { name: 'home' };
    case 'settings':
      return { name: 'settings', ...(parts[1] ? { section: parts[1] } : {}) };
    case 'plugins':
    case 'tools':
      return { name: 'tools' };
    case 'schedules':
    case 'tasks':
    case 'permissions':
      return { name: parts[0] };
    case 'new':
      return { name: 'new' };
    default:
      return { name: 'home' };
  }
};

// ---- data ----------------------------------------------------------------

/**
 * Refresh the shared data every screen leans on.
 *
 * A 401 here means the session is gone — the daemon crashed or was stopped
 * and started again (an announced `stratus restart` hands its cookie
 * sessions to the replacement; nothing else does, because they live in
 * memory) — so the page says exactly that instead of rendering an empty
 * roster that looks like a fleet that vanished.
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

/**
 * Schedules feed Home's "coming up" list and name the conversations a
 * schedule started, so they are read with the routes that show either.
 */
export const refreshSchedules = async () => {
  try {
    const listed = await api.schedules();
    store.schedules = listed.schedules ?? [];
    render();
    return { ok: true };
  } catch (error) {
    // Kept as it was: an unreadable list is not an empty one. The caller
    // that has a page to show it on says so.
    return { ok: false, error: error.message };
  }
};

const refreshForRoute = async () => {
  if (store.route.name === 'home') {
    const listed = await api.sessions(undefined, 12).catch(() => ({ sessions: [] }));
    store.sessions = listed.sessions ?? [];
    render();
  }
  if (store.route.name === 'home' || store.route.name === 'agent' || store.route.name === 'schedules') {
    await refreshSchedules();
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
    // News, unlike `session.updated`: a message entered the conversation
    // with no turn to announce it, so this line is the only sign of it.
    case 'session.observed': return 'overheard a message';
    case 'tool.called': return `ran ${event.call.toolName}`;
    case 'tool.completed': return `${event.result.toolName} ${event.result.ok ? 'succeeded' : 'failed'}`;
    case 'tool.denied': return `${event.call.toolName} was denied`;
    case 'tool.approval-requested': return `${event.call.toolName} needs approval`;
    case 'tool.approval-resolved': return `approval ${event.answer} (${event.reason})`;
    default: return null;
  }
};

/** Approvals this page answered itself, so they are not reported as answered elsewhere. */
export const answeredHere = new Set();

const ANSWERED_KEEP_MS = 2 * 60_000;

const noteAnswered = (event) => {
  const request = store.approvals.find((candidate) => candidate.requestId === event.requestId);
  if (!request || answeredHere.has(event.requestId)) {
    return;
  }
  const now = Date.now();
  store.answered = [
    { request, answer: event.answer, reason: event.reason, at: now },
    ...store.answered.filter((entry) => now - entry.at < ANSWERED_KEEP_MS),
  ];
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
  // The whole core, not the approvals list alone: the "needs you" count and
  // the agents' states are read together, and refreshing one alone left
  // them disagreeing on screen.
  const type = envelope.event.type;
  if (type === 'tool.approval-resolved') {
    noteAnswered(envelope.event);
  }
  if (type === 'tool.approval-requested' || type === 'tool.approval-resolved') {
    void refreshCore();
  }
  // An overhear belongs here too: it moves the session's own timestamp,
  // which is what the overview orders by, and emits nothing else.
  if (type === 'session.completed' || type === 'session.failed' || type === 'session.created' || type === 'session.observed') {
    void refreshCore();
    void refreshForRoute();
  }
  render();
};

// ---- shell ---------------------------------------------------------------

/** The Stratus mark, from the design file. */
export const stratusMark = (width = 24) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(Math.round((width / 1.6413) * 10) / 10));
  svg.setAttribute('viewBox', '0 0 134.39 81.88');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M98.57996 26.57001l0-26.57001-73.88996 0 0 38.07001-24.69 0 0 43.80999 28.83997 0 50.25 0 55.29998 0 0-55.33001-35.80999 0 0 0.02002z m-63.06995 19.80999l13.86999 0 0 27.22004-41.09002 0c0-15.03 12.19003-27.22003 27.22003-27.22004z m43.56995 27.22004l-21.39997 0 0-35.52002-24.70001 0 0-1.13001c0-15.82 12.83002-28.64999 28.65002-28.64999 15.82 0 28.64996 12.82999 28.64997 28.64999l0 36.65003-11.20001 0z m47.01001 0l-27.51001 0 0-38.73004 0.29004 0c15.02999 0 27.21997 12.19003 27.21997 27.22003l0 11.51001z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
};

/** An agent's state, as the four words and the dot every screen uses. */
export const statusOf = (agent) => agentStatus(agent, { approvals: store.approvals, runtimes: store.health?.runtimes ?? [] });

const sidebar = () => {
  const route = store.route;
  const item = (label, iconName, target, active) => el('button', {
    class: `nav-item${active ? ' active' : ''}`,
    'aria-current': active ? 'page' : undefined,
    onClick: () => navigate(target),
  }, icon(iconName, 16), el('span', { class: 'grow' }, label));

  const offline = store.offlineSince !== undefined;
  return el('nav', { class: 'sidebar', 'aria-label': 'Main' },
    el('div', { class: 'brand' }, stratusMark(24), 'Stratus'),
    el('div', { class: 'nav' },
      item('Home', 'house', { name: 'home' }, route.name === 'home'),
      item('Schedules', 'calendar-clock', { name: 'schedules' }, route.name === 'schedules'),
      item('Tasks', 'list-checks', { name: 'tasks' }, route.name === 'tasks'),
    ),
    el('div', { class: 'nav' },
      el('div', { class: 'nav-label' }, 'Agents'),
      ...store.agents.map((agent) => {
        const status = statusOf(agent);
        const active = route.name === 'agent' && route.agentId === agent.id;
        return el('button', {
          class: `nav-item agent${active ? ' active' : ''}`,
          'aria-current': active ? 'page' : undefined,
          onClick: () => navigate({ name: 'agent', agentId: agent.id }),
        },
        avatar(agent, 20),
        el('span', { class: 'grow' }, agent.name),
        // The dot is stale while the daemon is unreachable, so it goes grey
        // rather than keep claiming an agent is working.
        el('span', { class: `dot ${offline ? 'idle' : status.kind}`, title: offline ? 'unknown while Stratus is unreachable' : status.label }));
      }),
      el('button', { class: `nav-item${route.name === 'new' ? ' active' : ''}`, onClick: () => navigate({ name: 'new' }) },
        el('span', { class: 'plus-box' }, icon('plus', 12)),
        el('span', { class: 'grow' }, 'New agent')),
    ),
    el('div', { class: 'spacer' }),
    el('div', { class: 'nav' },
      item('Tools', 'blocks', { name: 'tools' }, route.name === 'tools'),
      item('Permissions', 'shield-check', { name: 'permissions' }, route.name === 'permissions'),
      item('Settings', 'settings-2', { name: 'settings' }, route.name === 'settings'),
    ),
    el('div', { class: `sidebar-foot${offline ? ' bad' : ''}` },
      el('span', { class: `dot ${offline ? 'bad' : 'ok'}` }),
      el('span', { class: 'grow' }, offline ? 'Can’t reach Stratus' : 'Running'),
      el('span', { class: 'mono' }, `v${store.health?.version ?? '—'}`),
    ),
  );
};

const signedOut = () => el('div', { class: 'page-wrap', style: 'grid-column: 1 / -1; padding: 10px;' },
  el('div', { class: 'page' }, el('div', { class: 'page-scroll' },
    el('div', { class: 'page-body narrow' },
      el('div', { class: 'page-head' }, el('div', {},
        el('h1', {}, 'Not signed in'),
        el('div', { class: 'sub' }, 'This browser has no session with Stratus. Sessions live in the daemon’s memory: stratus restart hands them to the new daemon, but a crash or a stop and start signs you out.'))),
      el('div', { class: 'notice ok', style: 'color: var(--text); background: var(--bg);' },
        'Run ', el('code', {}, 'stratus dashboard'), ' in a terminal to open a fresh one.'),
    ))));

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
  : route.name;

const buildView = (route) => {
  switch (route.name) {
    case 'agent': return renderAgent(route.agentId, route.sessionId, route.tab, route.fresh);
    case 'settings': return renderSettings(route.section);
    case 'tools': return renderTools();
    case 'schedules': return renderSchedules();
    case 'tasks': return renderTasks();
    case 'permissions': return renderPermissions();
    case 'new': return renderNewAgent();
    default: return renderHome();
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
  root.replaceChildren(sidebar(), el('main', { class: 'page-wrap' }, el('div', { class: 'page' }, current.view.node)));
};

// ---- boot ----------------------------------------------------------------

window.addEventListener('popstate', () => {
  store.route = routeFromHash(location.hash);
  render();
  void refreshForRoute();
});

store.route = routeFromHash(location.hash);
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
