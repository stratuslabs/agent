import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { syncOptions, touchOnChange } from '../lib/forms.js';
import { navigate, refreshCore, store } from '../app.js';

/**
 * Persona examples. They only fill in the text box: an example is a
 * starting point to edit, not a template that installs tools or plugins.
 */
const EXAMPLES = [
  { label: 'Research assistant', text: 'You are a research assistant. Read what I send, find the important parts, and answer briefly.' },
  { label: 'Code reviewer', text: 'You review code changes. Point out bugs, risky changes and missing tests first, then style. Be specific and brief.' },
  { label: 'Inbox triage', text: 'You sort incoming requests. For each one, say who it is from, what they need, and how urgent it is.' },
  { label: 'Daily digest', text: 'You write short daily digests: what happened, what is blocked, and what needs a decision.' },
];

/**
 * A new agent: a name, what it should do, and its model. The same soul file
 * `POST /agents` writes for any client, so the agent can talk straight away.
 */
export const renderNewAgent = () => {
  const name = el('input', { id: 'new-name', placeholder: 'Ava', autocomplete: 'off' });
  const instructions = el('textarea', { id: 'new-persona', rows: 5, placeholder: 'You are Ava, a research assistant. Read what I send, find the important parts, and answer briefly.' });
  const model = touchOnChange(el('select', { id: 'new-model' }));
  const notice = el('div', {});
  const create = el('button', { class: 'btn primary' }, 'Create agent');

  const submit = async () => {
    notice.replaceChildren();
    if (!instructions.value.trim()) {
      notice.replaceChildren(el('div', { class: 'notice bad', role: 'alert' }, 'Say what it should do: that becomes its persona.'));
      instructions.focus();
      return;
    }
    create.disabled = true;
    try {
      const [provider, modelId] = model.value ? model.value.split(/:(.*)/s) : [undefined, undefined];
      const created = await api.createAgent({
        ...(name.value.trim() ? { name: name.value.trim() } : {}),
        instructions: instructions.value.trim(),
        ...(provider ? { provider } : {}),
        ...(modelId ? { model: modelId } : {}),
      });
      await refreshCore();
      // Created whatever the re-read says: if it failed, the roster on screen
      // is stale, and the new agent shouldn't open as "no longer on the roster".
      if (!store.agents.some((agent) => agent.id === created.agent.id)) {
        store.agents = [...store.agents, { activeSessions: 0, ...created.agent }];
      }
      navigate({ name: 'agent', agentId: created.agent.id, fresh: true });
    } catch (error) {
      notice.replaceChildren(el('div', { class: 'notice bad', role: 'alert' }, error.message));
      create.disabled = false;
    }
  };
  create.addEventListener('click', () => void submit());

  syncOptions(model, [{ value: '', label: 'Use the default model' }]);
  api.models().then((listed) => {
    syncOptions(model, [
      { value: '', label: 'Use the default model' },
      ...(listed.models ?? []).map((entry) => ({ value: `${entry.provider}:${entry.id}`, label: `${entry.id} · ${entry.provider}` })),
    ]);
  }, () => {});

  const node = el('div', { class: 'page-scroll' },
    el('div', { class: 'page-body', style: 'max-width: 720px;' },
      el('div', { class: 'page-head' }, el('div', {},
        el('h1', {}, 'New agent'),
        el('div', { class: 'sub' }, 'Give it a name and a job. You can change everything later.'))),
      el('div', {},
        el('div', { class: 'field' }, el('label', { for: 'new-name' }, 'Name'), name,
          el('p', { class: 'field-note' }, 'Leave it empty and Stratus Agent picks a name.')),
        el('div', { class: 'field' },
          el('label', { for: 'new-persona' }, 'What should it do?'),
          instructions,
          el('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px;' },
            el('span', { class: 'field-note', style: 'margin: 0 4px 0 0;' }, 'Examples'),
            ...EXAMPLES.map((example) => el('button', {
              class: 'btn small',
              onClick: () => {
                instructions.value = example.text;
                instructions.focus();
              },
            }, example.label)))),
        el('div', { class: 'field' }, el('label', { for: 'new-model' }, 'Model'), model),
        notice,
        el('div', { class: 'form-actions', style: 'justify-content: space-between;' },
          el('span', { class: 'field-note', style: 'margin: 0;' }, 'Saved as a soul file in ~/.stratus/agents.'),
          create)),
    ));

  return { node };
};
