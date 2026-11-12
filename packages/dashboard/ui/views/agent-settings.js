import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { refreshCore } from '../app.js';

/**
 * The agent view's settings tab: the agent's name, persona and model pin,
 * read from its soul file and saved back.
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

  /**
   * The full soul, read once and only when the settings tab needs it.
   *
   * Guarded rather than awaited from the render, because `update()` runs on
   * every event from every agent and an unguarded fetch there would open one
   * request per event.
   */
  let soulLoading = false;
  const loadSoul = async () => {
    if (soulLoading || soul) {
      return;
    }
    soulLoading = true;
    try {
      soul = await api.agent(agentId);
    } catch (error) {
      soulError = `Could not read this agent's soul file: ${error.message}`;
    } finally {
      soulLoading = false;
    }
    update();
  };

  /**
   * The settings form, built once and kept.
   *
   * `update()` runs on every event from every agent, and rebuilding these
   * inputs from the last server values would erase whatever someone had
   * typed the moment anything anywhere emitted an event. Text people are
   * editing is state, not a projection — so the nodes outlive the render
   * that created them, exactly as the composer does.
   */
  let settingsForm;

  const buildSettingsForm = (current) => {
    const name = el('input', { value: soul.agent?.name ?? current.name });
    // The stored instructions in full, never the roster's one-line snippet.
    const instructions = el('textarea', { rows: 8, value: soul.agent?.instructions ?? '' });
    const provider = el('input', { value: soul.provider ?? '', placeholder: 'follows your setup' });
    const model = el('input', { value: soul.model ?? '', placeholder: 'follows your setup' });

    const save = async () => {
      saved = undefined;
      setError(undefined);
      try {
        await api.updateAgent(agentId, {
          name: name.value,
          instructions: instructions.value,
          // An empty string clears a pin; leaving it alone keeps it.
          provider: provider.value.trim(),
          model: model.value.trim(),
        });
        await refreshCore();
        saved = 'Saved. The next turn in every conversation uses it.';
      } catch (error) {
        setError(error.message);
      }
      settingsForm?.refreshNotice();
    };

    // The one part that does change per render: whether the last save
    // succeeded. Kept as its own node so the fields above are never touched.
    const notice = el('div', {});
    const node = el('div', {},
      el('div', { class: 'form-grid' },
        el('div', {}, el('label', {}, 'Name'), name),
        el('div', {}, el('label', {}, 'Agent id'), el('input', { value: current.id, disabled: true })),
        el('div', {}, el('label', {}, 'Provider'), provider),
        el('div', {}, el('label', {}, 'Model'), model),
      ),
      el('p', { class: 'field-note' }, 'An id keys sessions, memory, and credentials, so it cannot be changed in place.'),
      el('label', {}, 'Persona'),
      instructions,
      el('p', { class: 'field-note' }, soul.soulPath ? `Soul file: ${soul.soulPath}` : ''),
      notice,
      el('div', { class: 'actions' }, el('button', { class: 'primary', onClick: () => void save() }, 'Save')),
    );

    return {
      node,
      refreshNotice() {
        const error = getError();
        notice.replaceChildren(
          ...(saved ? [el('div', { class: 'notice ok' }, saved)] : []),
          ...(error ? [el('div', { class: 'notice bad' }, error)] : []),
        );
      },
    };
  };

  return () => {
    const current = agent();
    if (!current) {
      return el('p', { class: 'empty' }, 'This agent is no longer on the roster.');
    }
    if (current.builtIn) {
      return el('p', { class: 'empty' }, 'The built-in agent has no soul file to edit. Create your own agent to customise one.');
    }
    if (soulError) {
      return el('p', { class: 'empty' }, soulError);
    }
    if (!soul) {
      void loadSoul();
      return el('p', { class: 'empty' }, 'Reading the soul file…');
    }
    settingsForm ??= buildSettingsForm(current);
    settingsForm.refreshNotice();
    return settingsForm.node;
  };
};
