import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { syncOptions, touchOnChange } from '../lib/forms.js';
import { navigate, refreshCore, store } from '../app.js';

/**
 * The agent's Settings tab: its name, persona and model, read from its soul
 * file and saved back, with what else the agent is tied to beside them.
 *
 * `agent()` is the roster entry, `update()` repaints the view, and the error
 * is the view's one notice line (`getError`/`setError`), shared with the chat
 * tab. Returns the tab's render function.
 */
export const createSettingsTab = ({ agentId, agent, update, getError, setError }) => {
  /**
   * The agent's full soul, fetched for editing.
   *
   * The roster carries `persona`: the first line of the instructions,
   * trimmed to fit a table row. Seeding the editor from it and saving
   * would write that snippet back as the whole persona, so the settings
   * tab waits for the real thing.
   */
  let soul;
  let soulError;
  let saved;
  let models;
  let slack;

  /**
   * The full soul, the model catalog and the Slack bindings, read once and
   * only when the tab is shown.
   *
   * Guarded rather than awaited from the render, because `update()` runs on
   * every event from every agent and an unguarded fetch there would open one
   * request per event.
   */
  let loading = false;
  const load = async () => {
    if (loading || soul) {
      return;
    }
    loading = true;
    try {
      soul = await api.agent(agentId);
    } catch (error) {
      soulError = `Could not read this agent's soul file: ${error.message}`;
    }
    // Neither of these is worth failing the tab over: the model picker
    // keeps the soul's own pin, and the Slack row says it doesn't know.
    models = await api.models().then((listed) => listed.models ?? []).catch(() => []);
    slack = await api.credentials().then((listed) => listed.channels?.slack ?? []).catch(() => undefined);
    loading = false;
    update();
  };

  /**
   * The form, built once and kept.
   *
   * `update()` runs on every event from every agent, and rebuilding these
   * inputs from the last server values would erase whatever someone had
   * typed the moment anything anywhere emitted an event. Text people are
   * editing is state, not a projection — so the nodes outlive the render
   * that created them, exactly as the composer does.
   */
  let form;

  const buildForm = (current) => {
    const name = el('input', { value: soul.agent?.name ?? current.name, id: 'agent-name' });
    // The stored instructions in full, never the roster's one-line snippet.
    const instructions = el('textarea', { rows: 6, value: soul.agent?.instructions ?? '', id: 'agent-persona' });
    const model = touchOnChange(el('select', { id: 'agent-model' }));
    const pinned = soul.provider || soul.model ? `${soul.provider ?? ''}:${soul.model ?? ''}` : '';

    const save = async () => {
      saved = undefined;
      setError(undefined);
      try {
        const body = { name: name.value, instructions: instructions.value };
        if (model.dataset.touched === 'yes') {
          // Only a choice someone made here changes the pin. An empty
          // provider or model clears that half; "Use the default" clears both.
          const [provider, modelId] = model.value ? model.value.split(/:(.*)/s) : ['', ''];
          body.provider = provider ?? '';
          body.model = modelId ?? '';
        }
        await api.updateAgent(agentId, body);
        await refreshCore();
        saved = 'Saved. The next turn in every conversation uses it.';
      } catch (error) {
        setError(error.message);
      }
      form?.refresh();
    };

    const notice = el('div', {});
    // Refreshed with the form, so a saved model change shows here at once.
    const runsOnNote = el('p', { class: 'field-note' });
    const saveButton = el('button', { class: 'btn primary', onClick: () => void save() }, 'Save changes');
    const tools = soul.agent?.tools ?? [];

    const node = el('div', { class: 'settings-grid' },
      el('div', { class: 'form-column' },
        el('div', { class: 'field' }, el('label', { for: 'agent-name' }, 'Name'), name),
        el('div', { class: 'field' },
          el('label', { for: 'agent-persona' }, 'Persona'),
          instructions,
          el('p', { class: 'field-note' }, soul.soulPath ? `Saved to ${soul.soulPath}` : '')),
        el('div', { class: 'field' },
          el('label', { for: 'agent-model' }, 'Model'),
          model,
          runsOnNote),
        el('div', { class: 'field' },
          el('label', {}, 'Tools'),
          el('p', { class: 'field-note', style: 'margin: 0 0 8px;' }, 'What this agent may call. Gated tools follow your approval setting. To change the list, edit the tools line in its soul file.'),
          tools.length === 0
            ? el('p', { class: 'field-note' }, 'No tools listed.')
            : el('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px;' }, ...tools.map((pattern) => el('span', { class: 'badge mono' }, pattern)))),
        notice,
        el('div', { class: 'form-actions' }, saveButton),
      ),
      el('div', {},
        el('div', { class: 'side-title' }, 'Connections'),
        el('div', { class: 'panel', style: 'margin-bottom: 24px;' },
          el('div', { class: 'panel-row' },
            el('span', { class: 'tool-icon' }, icon('slack', 15)),
            el('div', { class: 'text' },
              el('div', { class: 'title' }, 'Slack'),
              el('div', { class: 'meta' }, slack === undefined ? 'Unknown' : slack.includes(agentId) ? 'Connected' : 'Not connected')),
            el('button', { class: 'btn small', onClick: () => navigate({ name: 'settings', section: 'channels' }) },
              slack?.includes(agentId) ? 'Manage' : 'Connect'))),
        el('div', { class: 'side-title' }, 'Memory'),
        el('div', { class: 'panel', style: 'margin-bottom: 24px;' },
          el('div', { class: 'panel-row' },
            el('span', { class: 'tool-icon' }, icon('brain', 15)),
            el('div', { class: 'text' },
              el('div', { class: 'title' }, `${current.memories ?? 0} fact${current.memories === 1 ? '' : 's'} remembered`),
              el('p', { class: 'field-note', style: 'margin: 2px 0 0;' }, 'List or forget them with ', el('code', {}, 'stratus memory'), '.')))),
        el('div', { class: 'side-title' }, 'Related'),
        el('div', { class: 'panel' },
          el('button', { class: 'panel-row', style: 'width: 100%; background: none; border-left: 0; border-right: 0; border-bottom: 0; cursor: pointer; text-align: left;', onClick: () => navigate({ name: 'schedules' }) },
            icon('calendar-clock', 15),
            el('span', { class: 'text' }, `${store.schedules.filter((schedule) => schedule.agentId === agentId).length} schedules`),
            icon('chevron-right', 14)),
          el('button', { class: 'panel-row', style: 'width: 100%; background: none; border-left: 0; border-right: 0; border-bottom: 0; cursor: pointer; text-align: left;', onClick: () => navigate({ name: 'permissions' }) },
            icon('shield-check', 15),
            el('span', { class: 'text' }, 'Permissions'),
            icon('chevron-right', 14)))),
    );

    return {
      node,
      refresh() {
        const listed = (models ?? []).map((entry) => ({ value: `${entry.provider}:${entry.id}`, label: `${entry.id} · ${entry.provider}` }));
        // The soul's own pin, even when the catalog does not list it right
        // now: without an option to select, the picker would claim this agent
        // follows the default, and the next save would clear a pin nobody
        // touched.
        if (pinned && !listed.some((option) => option.value === pinned)) {
          listed.unshift({ value: pinned, label: `${soul.model ?? 'its default model'} · ${soul.provider ?? 'default provider'} (not listed right now)` });
        }
        syncOptions(model, [{ value: '', label: 'Use the default model' }, ...listed], pinned);
        const runsOn = agent()?.runsOn;
        runsOnNote.textContent = runsOn ? `Runs on ${runsOn.provider}${runsOn.model ? ` · ${runsOn.model}` : ''} right now.` : '';
        const error = getError();
        notice.replaceChildren(
          ...(saved ? [el('div', { class: 'notice ok', role: 'status' }, saved)] : []),
          ...(error ? [el('div', { class: 'notice bad', role: 'alert' }, error)] : []),
        );
      },
    };
  };

  return () => {
    const current = agent();
    if (!current) {
      return el('p', { class: 'field-note' }, 'This agent is no longer on the roster.');
    }
    if (current.builtIn) {
      return el('div', { class: 'empty-state' },
        el('span', { class: 'icon-box' }, icon('bot', 18)),
        el('h3', {}, `${current.name} is the built-in agent`),
        el('p', {}, 'It has no soul file to edit. Create your own agent to give it a name, a persona and its own tools.'),
        el('button', { class: 'btn primary', style: 'margin-top: 8px;', onClick: () => navigate({ name: 'new' }) }, 'New agent'));
    }
    if (soulError) {
      return el('div', { class: 'notice bad' }, soulError);
    }
    if (!soul || models === undefined) {
      void load();
      return el('p', { class: 'field-note' }, 'Reading the soul file…');
    }
    form ??= buildForm(current);
    form.refresh();
    return form.node;
  };
};
