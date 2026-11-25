import { el, when } from '../lib/dom.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { conversationTitle, drawerSessions, firstLine, searchableTitle, sourceOf } from '../lib/sources.js';

/**
 * The bar across the top of an agent: who it is, the Chat and Settings
 * tabs, and the history and new-chat buttons. `current` is its roster
 * entry, if it is still there.
 */
export const topBar = ({ current, agentId, tab, onTab, drawerOpen, onToggleDrawer, onNew }) => el('div', { class: 'topbar' },
  current ? avatar(current, 28) : null,
  el('div', { class: 'who' },
    el('div', { class: 'name' }, current?.name ?? agentId),
    // An absent `runsOn` means the daemon is serving a soul whose file it
    // can no longer read, so it cannot say what this runs on. A guess would
    // be a billing claim, so it says nothing rather than "demo".
    el('div', { class: 'role' }, current?.persona
      ? firstLine(current.persona, 48)
      : current?.runsOn ? `${current.runsOn.provider}${current.runsOn.model ? ` · ${current.runsOn.model}` : ''}` : '')),
  el('div', { class: 'tabs', role: 'tablist' },
    ...['chat', 'settings'].map((name) => el('button', {
      class: `tab${tab === name ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': tab === name ? 'true' : 'false',
      onClick: () => onTab(name),
    }, name === 'chat' ? 'Chat' : 'Settings'))),
  el('div', { class: 'spacer' }),
  tab === 'chat'
    ? el('button', {
        class: 'btn',
        'aria-pressed': drawerOpen ? 'true' : 'false',
        title: drawerOpen ? 'Hide conversations' : 'Show conversations',
        onClick: onToggleDrawer,
      }, icon('history', 15), 'History')
    : null,
  el('button', { class: 'btn primary', onClick: onNew }, icon('square-pen', 15), 'New chat'),
);

const GROUPS = [
  { label: 'Today', test: (age, date, now) => date.toDateString() === now.toDateString() },
  { label: 'Yesterday', test: (age, date, now) => new Date(now.getTime() - 86_400_000).toDateString() === date.toDateString() },
  { label: 'Previous 7 days', test: (age) => age < 7 * 86_400_000 },
  { label: 'Older', test: () => true },
];

/**
 * The conversation drawer: this agent's stored conversations, newest first,
 * grouped by day and filtered by the search box. Each is called by its title
 * (its first message, from the listing or from this page's own read of it),
 * or by where it came from when nothing has been said in it.
 */
export const conversationDrawer = ({ current, sessions, found, sessionId, unsent, titles, schedules, search, onOpen, onClose }) => {
  const now = new Date();
  const titleOf = (session) => titles.get(session.id) ?? conversationTitle(session, { schedules });
  // The box is the view's own node, kept across repaints like the composer,
  // so typing in it never loses the caret to an event from another agent.
  const shown = drawerSessions({
    sessions,
    found,
    query: search.value,
    titleOf: (session) => titles.get(session.id) ?? searchableTitle(session, { schedules }),
  });
  const grouped = new Map();
  for (const session of shown) {
    const date = new Date(session.updatedAt);
    const age = now.getTime() - date.getTime();
    const group = GROUPS.find((candidate) => candidate.test(age, date, now)).label;
    grouped.set(group, [...(grouped.get(group) ?? []), session]);
  }

  const item = (session) => {
    const source = sourceOf(session.id, { schedules });
    return el('button', {
      class: `conv-item${session.id === sessionId ? ' active' : ''}`,
      'aria-current': session.id === sessionId ? 'true' : undefined,
      onClick: () => onOpen(session.id),
    },
    el('span', { class: 'source-icon' }, icon(source.icon, 13)),
    el('span', { class: 'text' },
      el('div', { class: 'title' }, titleOf(session)),
      el('div', { class: 'meta' }, `${source.label} · ${when(session.updatedAt, now)}${session.status === 'pending_approval' ? ' · needs you' : session.status === 'running' ? ' · working' : session.status === 'failed' ? ' · failed' : ''}`)));
  };

  return el('aside', { class: 'drawer open', 'aria-label': `${current?.name ?? 'Agent'}’s conversations` },
      el('div', { class: 'drawer-head' },
        el('span', {}, `${current?.name ?? 'Agent'}’s conversations`),
        el('button', { class: 'btn quiet icon-only', title: 'Hide conversations', onClick: onClose }, icon('panel-right', 16))),
      el('div', { class: 'search' }, icon('search', 14), search),
      el('div', { class: 'list-scroll' },
        unsent ? el('div', {}, el('div', { class: 'conv-group' }, 'Now'),
          el('div', { class: 'conv-item active' },
            el('span', { class: 'source-icon' }, icon('globe', 13)),
            el('span', { class: 'text' }, el('div', { class: 'title' }, 'New conversation'), el('div', { class: 'meta' }, 'Web · not sent yet')))) : null,
        ...[...grouped.entries()].flatMap(([label, list]) => [el('div', { class: 'conv-group' }, label), ...list.map(item)]),
        sessions.length === 0 && !unsent ? el('p', { class: 'field-note', style: 'padding: 12px 10px;' }, 'No conversations yet.') : null,
        sessions.length > 0 && shown.length === 0 ? el('p', { class: 'field-note', style: 'padding: 12px 10px;' }, 'No conversation title matches.') : null));
};
