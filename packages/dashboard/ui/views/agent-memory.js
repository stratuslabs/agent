import { el, when } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { memoryMatches, memoryMarks } from '../lib/memory.js';
import { refreshCore } from '../app.js';

/** How many facts show before "Show all". */
const FIRST_PAGE = 50;
/** Longer than this, a fact opens to its full text on request. */
const LONG_FACT = 280;

/**
 * An agent's memory on its Settings tab: what it remembers, newest first,
 * a filter, and Forget, confirmed in the row.
 *
 * Built once and kept, like the settings form: `update()` runs on every
 * event, and rebuilding the filter box there would take the caret out of
 * it. Read when first shown and after each forget, never per event.
 */
export const createMemorySection = ({ agentId, agentName, update }) => {
  const state = {
    entries: undefined,
    error: undefined,
    notice: undefined,
    confirming: undefined,
    busy: undefined,
    showAll: false,
    open: new Set(),
    loading: false,
  };

  /**
   * Latest wins: a read started before a forget must not land after the
   * one started by it and put the forgotten fact back.
   */
  let reads = 0;
  const load = async () => {
    const ticket = ++reads;
    state.loading = true;
    let entries;
    let error;
    try {
      entries = (await api.memory(agentId)).entries ?? [];
    } catch (caught) {
      error = caught;
    }
    if (ticket !== reads) {
      return;
    }
    state.loading = false;
    if (error) {
      state.error = `Couldn't read ${agentName()}'s memory: ${error.message}`;
    } else {
      state.entries = entries;
      state.error = undefined;
    }
    paint();
    update();
  };

  const forget = async (entry) => {
    state.busy = entry.id;
    paint();
    try {
      await api.forgetMemory(agentId, entry.id);
      state.notice = { kind: 'ok', text: 'Forgotten. It leaves every conversation from the next turn on, and stratus memory audit still shows it.' };
      // Re-read rather than dropping the row: a fact that superseded older
      // ones brings them back when it is forgotten, and the list has to show
      // what the agent will now read.
      state.entries = (state.entries ?? []).filter((candidate) => candidate.id !== entry.id);
      void load();
      // The roster's count, on the sidebar and agent cards.
      void refreshCore();
    } catch (error) {
      state.notice = { kind: 'bad', text: `Couldn't forget it: ${error.message}` };
      if (error.status === 404) {
        // Gone already, from another surface: the list is what's stale.
        void load();
      }
    }
    state.busy = undefined;
    state.confirming = undefined;
    paint();
  };

  const filter = el('input', {
    type: 'search',
    placeholder: 'Filter facts',
    'aria-label': `Filter what ${agentName()} remembers`,
    onInput: () => { state.showAll = false; paint(); },
  });
  const count = el('span', { class: 'field-note', style: 'margin: 0;' });
  const notice = el('div', {});
  const list = el('div', { class: 'panel memory-list' });
  const more = el('div', {});

  const row = (entry) => {
    const confirming = state.confirming === entry.id;
    const long = entry.content.length > LONG_FACT;
    const opened = state.open.has(entry.id);
    const marks = memoryMarks(entry);
    return el('div', { class: 'panel-row memory-row' },
      el('div', { class: 'text' },
        el('div', { class: `memory-content${long && !opened ? ' clamped' : ''}` }, entry.content),
        long
          ? el('button', {
              class: 'btn quiet small memory-toggle',
              'aria-expanded': opened ? 'true' : 'false',
              onClick: () => { if (opened) state.open.delete(entry.id); else state.open.add(entry.id); paint(); },
            }, opened ? 'Show less' : 'Show all of it')
          : null,
        el('div', { class: 'meta' },
          el('span', {}, when(entry.createdAt)),
          ...(entry.kind ? [el('span', {}, `· ${entry.kind}`)] : []),
          ...(entry.about?.length ? [el('span', { title: entry.about.join(', ') }, `· about ${entry.about.slice(0, 3).join(', ')}${entry.about.length > 3 ? '…' : ''}`)] : []),
          ...marks.map((mark) => el('span', { class: `badge ${mark.tone}`, title: mark.why }, mark.label)))),
      el('div', { class: 'memory-actions' },
        confirming
          ? [
              el('button', { class: 'btn small', disabled: state.busy === entry.id, onClick: () => { state.confirming = undefined; paint(); } }, 'Keep'),
              el('button', { class: 'btn small danger', disabled: state.busy === entry.id, onClick: () => void forget(entry) },
                state.busy === entry.id ? 'Forgetting…' : 'Forget'),
            ]
          : el('button', {
              class: 'btn small quiet',
              'aria-label': `Forget: ${entry.content.slice(0, 60)}`,
              onClick: () => { state.confirming = entry.id; state.notice = undefined; paint(); },
            }, 'Forget')));
  };

  const paint = () => {
    notice.replaceChildren(
      ...(state.error ? [el('div', { class: 'notice bad', role: 'alert' }, state.error)] : []),
      ...(state.notice ? [el('div', { class: `notice ${state.notice.kind}`, role: state.notice.kind === 'bad' ? 'alert' : 'status' }, state.notice.text)] : []),
    );
    if (state.entries === undefined) {
      count.textContent = '';
      list.replaceChildren(el('div', { class: 'panel-row' }, el('span', { class: 'field-note' }, state.error ? 'Not read.' : 'Reading…')));
      more.replaceChildren();
      return;
    }
    const newestFirst = [...state.entries].reverse();
    const shown = newestFirst.filter((entry) => memoryMatches(entry, filter.value));
    const page = state.showAll ? shown : shown.slice(0, FIRST_PAGE);
    count.textContent = filter.value.trim()
      ? `${shown.length} of ${state.entries.length}`
      : `${state.entries.length} fact${state.entries.length === 1 ? '' : 's'}`;
    list.replaceChildren(...(page.length === 0
      ? [el('div', { class: 'panel-row' }, el('span', { class: 'field-note' },
          state.entries.length === 0 ? `${agentName()} hasn't remembered anything yet.` : 'Nothing matches.'))]
      : page.map(row)));
    more.replaceChildren(...(page.length < shown.length
      ? [el('button', { class: 'btn small', style: 'margin-top: 10px;', onClick: () => { state.showAll = true; paint(); } }, `Show all ${shown.length}`)]
      : []));
  };

  const node = el('section', { class: 'memory-section', 'aria-labelledby': `memory-${agentId}` },
    el('div', { class: 'side-title', style: 'margin-top: 36px;' },
      el('span', { id: `memory-${agentId}` }, icon('brain', 14), ' Memory'),
      count),
    el('p', { class: 'field-note', style: 'margin: 0 0 10px;' },
      `What ${agentName()} remembers across conversations. Forgetting a fact takes it out of every conversation from the next turn on.`),
    el('div', { class: 'memory-filter' }, icon('search', 14), filter),
    notice,
    list,
    more);

  return {
    node,
    /** Reads on first show; paints from what it has otherwise. */
    refresh() {
      if (state.entries === undefined && !state.error && !state.loading) {
        void load();
      }
      paint();
    },
  };
};
