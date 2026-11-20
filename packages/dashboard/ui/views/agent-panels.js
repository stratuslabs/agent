import { ago, el } from '../lib/dom.js';
import { avatar } from '../lib/avatar.js';
import { shortId } from '../lib/transcript.js';

const TABS = ['chat', 'activity', 'settings'];

/** The agent's name, what it runs on, and the tab buttons. `current` is its roster entry, if it is still there. */
export const agentHeader = ({ current, agentId, tab, onTab }) => el('div', { class: 'card-head' },
  el('div', { class: 'row' },
    current ? avatar(current, 34) : null,
    el('div', { class: 'grow' },
      el('div', { class: 'title' }, current?.name ?? agentId),
      el('div', { class: 'sub' }, current
        // An absent `runsOn` means the daemon is serving a soul whose
        // file it can no longer read, so it cannot say what this runs on.
        // "demo" would be a guess, and a billing claim is not a good
        // place to guess.
        ? `${current.runsOn?.provider ?? 'unknown'}${current.runsOn?.model ? ` · ${current.runsOn.model}` : ''} · ${current.memories ?? 0} remembered`
        : agentId),
    ),
  ),
  el('div', { class: 'actions' },
    ...TABS.map((name) => el('button', {
      class: `small${tab === name ? ' primary' : ''}`,
      onClick: () => onTab(name),
    }, name.charAt(0).toUpperCase() + name.slice(1))),
  ),
);

/** The chat tab's conversation selector. */
export const sessionPicker = ({ sessions, sessionId, onOpen }) => {
  const picker = el('select', {
    onChange: (event) => onOpen(event.target.value),
  }, ...sessions.map((session) => el('option', {
    value: session.id,
    selected: session.id === sessionId,
  }, `${session.status.replace('_', ' ')} · ${ago(session.updatedAt)} · ${shortId(session.id)}`)));

  if (!sessions.some((session) => session.id === sessionId)) {
    // A conversation this page just started is not in the store yet, so it
    // would otherwise be missing from the very picker that is selecting it.
    picker.prepend(el('option', { value: sessionId, selected: true }, 'new conversation'));
  }
  return picker;
};

/** The side card: the newest stored conversations, each with an Open button, and New. */
export const conversationList = ({ sessions, sessionId, onOpen, onNew }) => el('section', { class: 'card' },
  el('div', { class: 'card-head' },
    el('h2', {}, 'Conversations'),
    el('button', { class: 'small', onClick: onNew }, 'New'),
  ),
  sessions.length === 0
    ? el('p', { class: 'empty' }, 'No stored conversations yet.')
    : el('div', { class: 'rows' }, ...sessions.slice(0, 12).map((session) => el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { class: 'title', title: session.id },
            session.id === sessionId ? `▸ ${shortId(session.id)}` : shortId(session.id)),
          el('div', { class: 'sub' }, ago(session.updatedAt))),
        el('span', { class: `pill ${session.status}` }, session.status.replace('_', ' ')),
        el('button', { class: 'small', onClick: () => onOpen(session.id) }, 'Open'),
      ))),
);

/** The activity tab: the dashboard's recent activity lines for this agent's conversations. */
export const activityPanel = ({ activity, sessions, sessionId }) => {
  const ours = new Set(sessions.map((session) => session.id));
  ours.add(sessionId);
  const lines = activity.filter((line) => ours.has(line.sessionId)).slice(0, 80);
  return lines.length === 0
    ? el('p', { class: 'empty' }, 'Nothing yet for this agent.')
    : el('div', { class: 'activity' }, ...lines.map((line) => el('div', { class: 'line' },
        el('span', { class: 'when' }, ago(new Date(line.at).toISOString())),
        el('span', { class: 'what', title: line.sessionId },
          line.agent ? `${line.agent} ${line.text}` : line.text),
      )));
};
