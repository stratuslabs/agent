import { duration, el, when } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { sourceOf } from '../lib/sources.js';
import { createLatest } from '../lib/latest.js';
import { navigate, store } from '../app.js';

const STATES = {
  running: { label: 'Running', icon: 'loader-circle', tone: 'accent', active: true },
  waiting_approval: { label: 'Needs approval', icon: 'shield-check', tone: 'warn', active: true },
  completed: { label: 'Completed', icon: 'circle-check', tone: 'ok' },
  failed: { label: 'Failed', icon: 'circle-x', tone: 'bad' },
  cancelled: { label: 'Stopped', icon: 'circle-slash', tone: '' },
  interrupted: { label: 'Interrupted', icon: 'circle-pause', tone: '' },
};

const REFRESH_MS = 3000;

/**
 * Background tasks: work one agent handed to another with `agent.delegate`.
 *
 * Status only, as the API serves it — who asked whom, where it came from,
 * how it stands — never the prompt or the result, the way a session row
 * carries no transcript. Each row opens the conversations it joins: the
 * one that asked, and the worker's own.
 */
export const renderTasks = () => {
  const state = { tasks: undefined, error: undefined, loadedAt: 0, busy: new Set(), trailing: undefined };
  const reads = createLatest();
  const node = el('div', { class: 'page-scroll' });

  const load = async () => {
    state.loadedAt = Date.now();
    // Latest-wins: a Stop, the first read and live events can overlap, and
    // an older listing landing last would undo a newer one.
    const ticket = reads.begin();
    try {
      const tasks = (await api.tasks()).tasks ?? [];
      if (!reads.isCurrent(ticket)) return;
      state.tasks = tasks;
      state.error = undefined;
    } catch (error) {
      if (!reads.isCurrent(ticket)) return;
      state.error = `Could not read the tasks: ${error.message}`;
    }
    paint();
  };

  const stop = async (task) => {
    state.busy.add(task.id);
    paint();
    let failed;
    try {
      await api.stopTask(task.id);
    } catch (error) {
      failed = `Could not stop it: ${error.message}`;
    }
    state.busy.delete(task.id);
    await load();
    // After the reload, which clears a stale read error: a failed Stop must
    // still say why the task is still running.
    if (failed) {
      state.error = failed;
      paint();
    }
  };

  const name = (agentId) => store.agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  const row = (task) => {
    const asker = store.agents.find((agent) => agent.id === task.agentId);
    const worker = store.agents.find((agent) => agent.id === task.workerAgentId);
    const status = STATES[task.status] ?? { label: task.status, icon: 'info', tone: '' };
    const source = sourceOf(task.originSessionId, { schedules: store.schedules });
    const took = (task.endedAt ? Date.parse(task.endedAt) : Date.now()) - Date.parse(task.createdAt);
    return el('div', { class: 'list-row', style: 'align-items: flex-start; padding: 14px 0;' },
      el('span', { style: 'display: flex; gap: 2px; margin-top: 2px;' },
        asker ? avatar(asker, 20) : null,
        worker ? avatar(worker, 20) : null),
      el('div', { class: 'text' },
        el('div', { class: 'title' }, `${name(task.agentId)} asked ${name(task.workerAgentId)}`),
        el('div', { class: 'meta' },
          el('span', { class: `badge ${status.tone}` }, icon(status.icon, 12), status.label),
          el('span', {}, `${task.steps} step${task.steps === 1 ? '' : 's'} · started ${when(task.createdAt)}`)),
        task.status === 'interrupted'
          ? el('div', { class: 'field-note' }, 'Stopped when Stratus Agent restarted.')
          : task.status === 'cancelled' && task.stoppedBy
            ? el('div', { class: 'field-note' }, `Stopped from the ${task.stoppedBy === 'dashboard' ? 'dashboard' : task.stoppedBy}.`)
            : null,
        el('div', { style: 'display: flex; gap: 14px; margin-top: 6px;' },
          el('button', { class: 'link accent', onClick: () => navigate({ name: 'agent', agentId: task.agentId, sessionId: task.originSessionId }) },
            `From ${name(task.agentId)}’s conversation · ${source.label} ↗`),
          el('button', { class: 'link accent', onClick: () => navigate({ name: 'agent', agentId: task.workerAgentId, sessionId: task.workerSessionId }) },
            task.status === 'waiting_approval' ? 'Review the approval ↗' : `${name(task.workerAgentId)}’s work ↗`))),
      el('span', { class: 'when mono', style: 'margin-top: 2px;' }, duration(Math.max(0, took))),
      status.active
        ? el('button', { class: 'btn small', disabled: state.busy.has(task.id), onClick: () => void stop(task) }, state.busy.has(task.id) ? 'Stopping…' : 'Stop')
        : el('span', { style: 'width: 52px;' }));
  };

  const paint = () => {
    const tasks = state.tasks ?? [];
    const active = tasks.filter((task) => STATES[task.status]?.active);
    const recent = tasks.filter((task) => !STATES[task.status]?.active);
    node.replaceChildren(el('div', { class: 'page-body', style: 'max-width: 1040px;' },
      el('div', { class: 'page-head' }, el('div', {},
        el('h1', {}, 'Tasks'),
        el('div', { class: 'sub' }, 'Work one agent handed to another, running in the background.'))),
      state.error ? el('div', { class: 'notice bad', role: 'alert' }, state.error) : null,
      state.tasks === undefined
        ? el('p', { class: 'field-note' }, 'Loading…')
        : tasks.length === 0
          ? el('div', { class: 'empty-state' },
              el('span', { class: 'icon-box' }, icon('list-checks', 18)),
              el('h3', {}, 'No tasks yet'),
              el('p', {}, 'Tasks appear when one agent hands work to another, like Ava asking Ben to run the tests.'))
          : el('div', { style: 'display: flex; flex-direction: column; gap: 28px;' },
              el('section', {},
                el('div', { class: 'section-head' }, el('h2', {}, `Active · ${active.length}`)),
                active.length === 0 ? el('p', { class: 'field-note' }, 'Nothing running.') : el('div', { class: 'list' }, ...active.map(row))),
              recent.length > 0
                ? el('section', {},
                    el('div', { class: 'section-head' }, el('h2', {}, `Recent · ${recent.length}`)),
                    el('div', { class: 'list' }, ...recent.map(row)))
                : null),
    ));
  };

  paint();
  void load();

  return {
    node,
    // The page has no stream of its own, so the shell's repaint on any
    // event is the cue to re-read — at most every few seconds.
    update: () => {
      const wait = REFRESH_MS - (Date.now() - state.loadedAt);
      if (wait <= 0) {
        void load();
      } else if (state.trailing === undefined) {
        // An event inside the window still gets read, at its end: it may be
        // the last one, like the completion of the task on screen.
        state.trailing = setTimeout(() => {
          state.trailing = undefined;
          void load();
        }, wait);
      }
    },
    destroy: () => {
      clearTimeout(state.trailing);
    },
  };
};
