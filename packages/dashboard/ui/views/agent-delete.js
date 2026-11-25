import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { navigate, refreshCore, refreshSchedules, store } from '../app.js';

/**
 * Delete agent, at the bottom of an agent's Settings tab: one button, then
 * a confirmation in place that says exactly what goes and what stays,
 * because the API keeps the agent's history and that is the part people
 * worry about.
 *
 * Built once and kept, like the rest of the tab. Returns `{ node, refresh }`.
 */
export const createDeleteSection = ({ agentId, agentName }) => {
  const state = { confirming: false, busy: false, error: undefined };
  const body = el('div', {});

  const remove = async () => {
    state.busy = true;
    state.error = undefined;
    paint();
    let result;
    try {
      result = await api.deleteAgent(agentId);
    } catch (error) {
      state.busy = false;
      state.error = error.message;
      paint();
      return;
    }
    // Deleted, but its grant file couldn't be read, so its grants weren't
    // revoked. That outlives this page: a new agent given the same id
    // would inherit them once the file reads again. Home keeps saying so.
    if (typeof result?.grantsNote === 'string') {
      store.notices = [...store.notices, {
        id: `delete-${agentId}-${Date.now()}`,
        text: `${agentName()} was deleted, but its permissions weren't revoked. ${result.grantsNote} Once it reads again, revoke them in Permissions, or a new agent given the id ${agentId} would inherit them.`,
      }];
    }
    // Off the roster now; the page it was on goes with it.
    await Promise.allSettled([refreshCore(), refreshSchedules()]);
    navigate({ name: 'home' });
  };

  const paint = () => {
    const name = agentName();
    const schedules = store.schedules.filter((schedule) => schedule.agentId === agentId).length;
    body.replaceChildren(
      ...(state.error ? [el('div', { class: 'notice bad', role: 'alert', style: 'margin-bottom: 10px;' }, state.error)] : []),
      state.confirming
        ? el('div', { class: 'panel delete-confirm', role: 'group', 'aria-label': `Delete ${name}` },
            el('div', { class: 'panel-row', style: 'align-items: flex-start;' },
              el('span', { class: 'tool-icon danger' }, icon('triangle-alert', 15)),
              el('div', { class: 'text' },
                el('div', { class: 'title' }, `Delete ${name}?`),
                el('ul', { class: 'delete-list' },
                  el('li', {}, `${name} leaves the roster and stops answering everywhere, Slack included.`),
                  el('li', {}, schedules > 0
                    ? `Its ${schedules} schedule${schedules === 1 ? ' is' : 's are'} cancelled, and its permissions are revoked.`
                    : 'Its permissions are revoked.'),
                  el('li', {}, 'Its conversations, memory and files are kept. Its soul moves to ~/.stratus/removed-agents, and moving it back restores it.')),
                el('div', { class: 'form-actions', style: 'justify-content: flex-start; margin-top: 12px;' },
                  el('button', { class: 'btn', disabled: state.busy, onClick: () => { state.confirming = false; state.error = undefined; paint(); } }, 'Keep'),
                  el('button', { class: 'btn danger', disabled: state.busy, onClick: () => void remove() }, state.busy ? 'Deleting…' : `Delete ${name}`)))))
        : el('div', { class: 'delete-row' },
            el('p', { class: 'field-note', style: 'margin: 0;' }, `Take ${name} off the roster. Its conversations and memory are kept.`),
            el('button', { class: 'btn danger-text', onClick: () => { state.confirming = true; paint(); } }, icon('trash-2', 14), 'Delete agent')));
  };

  const node = el('section', { class: 'delete-section', 'aria-labelledby': `delete-${agentId}` },
    el('div', { class: 'side-title', style: 'margin-top: 36px;' }, el('span', { id: `delete-${agentId}` }, 'Delete agent')),
    body);

  return {
    node,
    refresh() {
      // Left alone mid-confirmation: the count it shows is the one the
      // person is deciding on.
      if (!state.busy) {
        paint();
      }
    },
  };
};
