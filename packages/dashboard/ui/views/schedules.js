import { el, when } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { cadenceKind, humanCadence } from '../lib/cadence.js';
import { firstLine } from '../lib/sources.js';
import { refreshSchedules, store } from '../app.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'once', label: 'One-time' },
  { id: 'event', label: 'Event' },
];

/** Where a schedule's runs report, said for a person: the channel kind, not its id. */
const reportsTo = (destination) => {
  if (!destination) {
    return '—';
  }
  const [channel, conversation] = String(destination).split(':');
  if (channel === 'slack') {
    return conversation?.startsWith('D') ? 'Slack DM' : 'Slack channel';
  }
  return channel || String(destination);
};

/**
 * Every schedule on this daemon, soonest first.
 *
 * The only change offered is Remove, because it is the only one the daemon
 * has: a schedule can be cancelled but not paused on its own (pausing the
 * daemon's intake pauses all of them). Removing asks once, inline, and
 * stops future runs; the conversations past runs started stay.
 */
export const renderSchedules = () => {
  const state = { filter: 'all', confirming: undefined, busy: undefined, error: undefined, loaded: false };
  const node = el('div', { class: 'page-scroll' });

  const remove = async (schedule) => {
    state.busy = schedule.id;
    state.error = undefined;
    paint();
    try {
      await api.removeSchedule(schedule.id);
    } catch (error) {
      state.error = `Could not remove it: ${error.message}`;
    }
    state.busy = undefined;
    state.confirming = undefined;
    await refreshSchedules();
    paint();
  };

  const row = (schedule) => {
    const agent = store.agents.find((candidate) => candidate.id === schedule.agentId);
    const kind = cadenceKind(schedule.cadence);
    const confirming = state.confirming === schedule.id;
    return el('div', { class: 'list-row', style: 'padding: 14px 0;' },
      agent ? avatar(agent, 28) : null,
      el('div', { class: 'text' },
        el('div', { class: 'title', title: schedule.prompt }, firstLine(schedule.prompt, 90)),
        el('div', { class: 'meta' },
          icon(kind === 'event' ? 'zap' : 'calendar-clock', 13),
          el('span', {}, `${agent?.name ?? schedule.agentId} · ${humanCadence(schedule.cadence)}`))),
      el('div', { style: 'width: 150px; flex: none; font-size: 13px;' },
        el('div', {}, schedule.nextFireAt ? `Next ${when(schedule.nextFireAt)}` : kind === 'event' ? 'Next matching event' : 'Not scheduled'),
        el('div', { class: 'field-note', style: 'margin: 2px 0 0;' }, schedule.lastFiredAt ? `Last ran ${when(schedule.lastFiredAt)}` : 'Not run yet')),
      el('div', { style: 'width: 110px; flex: none; font-size: 13px; color: var(--text-2);' }, reportsTo(schedule.destination)),
      el('div', { style: 'width: 150px; flex: none; display: flex; justify-content: flex-end; gap: 6px;' },
        confirming
          ? [
              el('button', { class: 'btn small', onClick: () => { state.confirming = undefined; paint(); } }, 'Keep'),
              el('button', { class: 'btn small danger', disabled: state.busy === schedule.id, onClick: () => void remove(schedule) },
                state.busy === schedule.id ? 'Removing…' : 'Remove'),
            ]
          : el('button', {
              class: 'btn small quiet',
              'aria-label': `Remove the schedule “${firstLine(schedule.prompt, 40)}”`,
              onClick: () => { state.confirming = schedule.id; paint(); },
            }, icon('trash-2', 14), 'Remove')));
  };

  const paint = () => {
    const all = [...store.schedules].sort((a, b) => (a.nextFireAt ?? '9999').localeCompare(b.nextFireAt ?? '9999'));
    const shown = state.filter === 'all' ? all : all.filter((schedule) => cadenceKind(schedule.cadence) === state.filter);
    node.replaceChildren(el('div', { class: 'page-body' },
      el('div', { class: 'page-head' },
        el('div', {},
          el('h1', {}, 'Schedules'),
          el('div', { class: 'sub' }, 'Prompts your agents run on their own. Agents create these; you can remove any of them.')),
        el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter schedules' },
          ...FILTERS.map((filter) => el('button', {
            class: `tab${state.filter === filter.id ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': state.filter === filter.id ? 'true' : 'false',
            onClick: () => { state.filter = filter.id; paint(); },
          }, filter.label)))),
      state.error ? el('div', { class: 'notice bad', role: 'alert' }, state.error) : null,
      // Shown with whatever rows are still on screen: after a failed read
      // they are the last good one, and may already be out of date.
      state.loaded && store.schedulesError !== undefined
        ? el('div', { class: 'notice bad', role: 'alert' }, `Could not read the schedules: ${store.schedulesError}${all.length > 0 ? ' The list below may be out of date.' : ''}`)
        : null,
      !state.loaded
        ? el('p', { class: 'field-note' }, 'Loading…')
        : store.schedulesError !== undefined && all.length === 0
          ? null
        : all.length === 0
          ? el('div', { class: 'empty-state' },
              el('span', { class: 'icon-box' }, icon('calendar-clock', 18)),
              el('h3', {}, 'No schedules yet'),
              el('p', {}, 'Agents create schedules when you ask them to do something regularly, like “every Monday, summarize the open items.”'))
          : el('div', {},
              el('div', { class: 'list-row', style: 'padding: 0 0 8px; color: var(--text-2); font-size: 12px; font-weight: 500;', 'aria-hidden': 'true' },
                el('span', { style: 'width: 28px;' }),
                el('span', { class: 'text' }, 'Schedule'),
                el('span', { style: 'width: 150px; flex: none;' }, 'Runs'),
                el('span', { style: 'width: 110px; flex: none;' }, 'Reports to'),
                el('span', { style: 'width: 150px; flex: none;' })),
              el('div', { class: 'list', style: 'border-top: 1px solid var(--border);' }, ...shown.map(row)),
              shown.length === 0 ? el('p', { class: 'field-note' }, 'None of this kind.') : null,
              el('p', { class: 'field-note', style: 'margin-top: 20px;' }, 'Creating a schedule asks for approval unless your approval setting lets gated tools run. Removing one stops future runs; past conversations stay.')),
    ));
  };

  paint();
  refreshSchedules().then(() => {
    state.loaded = true;
    paint();
  });

  return { node, update: () => { if (state.loaded && !state.confirming) paint(); } };
};
