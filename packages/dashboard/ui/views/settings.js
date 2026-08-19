import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { refreshCore, store } from '../app.js';

const PROVIDERS = ['anthropic', 'openai'];

/**
 * Bring a `<select>`'s options up to date without disturbing a choice.
 *
 * The option lists here are data — models a sign-in can reach, agents on the
 * roster — and they arrive after the form is already on screen. Rebuilding
 * the whole pane to show them would throw away everything typed into it, so
 * the select is kept and only its options are replaced, restoring the current
 * value when it survived the refresh.
 */
const syncOptions = (select, options, fallback) => {
  const signature = options.map((option) => option.value).join(' ');
  if (select.dataset.signature === signature) {
    return;
  }
  const chosen = select.dataset.signature === undefined ? fallback : select.value;
  select.dataset.signature = signature;
  select.replaceChildren(...options.map((option) => el('option', { value: option.value }, option.label)));
  const wanted = options.some((option) => option.value === chosen) ? chosen : fallback;
  if (wanted !== undefined) {
    select.value = wanted;
  }
};

export const renderSettings = (section) => {
  const state = { credentials: undefined, models: undefined, config: undefined, notice: undefined, busy: false };
  const node = el('div', { class: 'main solo' });

  const say = (text, kind = 'ok') => {
    state.notice = { text, kind };
    update();
  };

  const load = async () => {
    try {
      if (section === 'providers' || section === 'channels') {
        state.credentials = await api.credentials();
      }
      if (section === 'models') {
        const [models, config] = await Promise.all([api.models(), api.config()]);
        state.models = models.models ?? [];
        state.config = config.config ?? {};
      }
    } catch (error) {
      say(error.message, 'bad');
      return;
    }
    update();
  };

  /**
   * The pane, built once and kept.
   *
   * `update()` runs on every notice and on both edges of every request — the
   * busy flag alone fires it twice per click. Rebuilding the pane there put a
   * fresh, empty form on screen the moment someone pressed Verify, so a key
   * that had just been checked was gone before it could be saved, and Save
   * would then store an empty credential. Only the data-driven regions
   * refresh; what someone typed is state, not a projection of the server.
   */
  let pane;

  // ---- providers ---------------------------------------------------------

  const buildProviders = () => {
    const provider = el('select', {}, ...PROVIDERS.map((name) => el('option', { value: name }, name)));
    const type = el('select', {},
      el('option', { value: 'api_key' }, 'API key'),
      el('option', { value: 'oauth_token' }, 'Claude subscription token'));
    const value = el('input', { type: 'password', placeholder: 'paste the key' });
    const baseUrl = el('input', { placeholder: 'optional — a proxy or local endpoint' });

    const verify = async () => {
      state.busy = true; update();
      try {
        const verdict = await api.verifyKey({
          provider: provider.value,
          key: value.value,
          ...(baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
        });
        // Only an explicit auth failure condemns a key: plenty of compatible
        // endpoints have no models route at all, and "unreachable" there says
        // nothing about whether the key works.
        say(
          verdict.status === 'ok' ? 'That key works.'
            : verdict.status === 'rejected' ? `Rejected: ${verdict.detail ?? 'the provider refused it'}`
              : `Could not check it: ${verdict.detail ?? 'unreachable'} — it may still be fine.`,
          verdict.status === 'rejected' ? 'bad' : 'ok',
        );
      } catch (error) {
        say(error.message, 'bad');
      }
      state.busy = false; update();
    };

    const save = async () => {
      state.busy = true; update();
      try {
        await api.storeKey(provider.value, {
          type: type.value,
          value: value.value,
          ...(baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
        });
        value.value = '';
        state.credentials = await api.credentials();
        say('Stored in ~/.stratus/credentials.json (0600).');
      } catch (error) {
        say(error.message, 'bad');
      }
      state.busy = false; update();
    };

    const signIns = el('div', { class: 'rows' });
    const verifyButton = el('button', { onClick: () => void verify() }, 'Verify');
    const saveButton = el('button', { class: 'primary', onClick: () => void save() }, 'Save');

    return {
      node: el('section', { class: 'card' },
        el('h2', {}, 'Providers'),
        signIns,
        el('p', { class: 'field-note' }, 'Keys are never sent back out — this page can tell you a sign-in exists, not what it is.'),
        el('h3', {}, 'Add or replace a sign-in'),
        el('div', { class: 'form-grid' },
          el('div', {}, el('label', {}, 'Provider'), provider),
          el('div', {}, el('label', {}, 'Type'), type),
        ),
        el('label', {}, 'Key'), value,
        el('label', {}, 'Endpoint'), baseUrl,
        el('p', { class: 'field-note' }, 'A key is bound to the endpoint you save it with, and is never sent anywhere else.'),
        el('div', { class: 'actions' }, verifyButton, saveButton),
      ),
      refresh() {
        signIns.replaceChildren(...(state.credentials?.providers ?? []).map((entry) => el('div', { class: 'row' },
          el('div', { class: 'grow' },
            el('div', { class: 'title' }, entry.provider),
            el('div', { class: 'sub' }, entry.stored
              ? `${entry.type === 'oauth_token' ? 'Claude subscription' : 'API key'}${entry.baseUrl ? ` · ${entry.baseUrl}` : ''}`
              : 'not signed in')),
          el('span', { class: `pill${entry.stored ? ' running' : ''}` }, entry.stored ? 'signed in' : 'none'),
        )));
        verifyButton.disabled = state.busy;
        saveButton.disabled = state.busy;
      },
    };
  };

  // ---- models ------------------------------------------------------------

  const buildModels = () => {
    const picker = el('select', {});

    const save = async () => {
      state.busy = true; update();
      try {
        const config = state.config ?? {};
        const [provider, model] = picker.value ? picker.value.split(/:(.*)/s) : [undefined, undefined];
        // A whole document, because PUT replaces rather than merges — sending
        // only the two changed keys would silently drop everything else in
        // the file, approvals and soul included. Which makes the *removals*
        // below load-bearing rather than tidying.
        const next = { ...config };
        if (provider) {
          next.provider = provider;
          next.model = model;
          if (provider !== config.provider) {
            // An endpoint and a key-selector are chosen for one provider.
            // Carried across, they point the new provider at the old one's
            // service, or hand it the wrong credential — the same
            // normalization the CLI setup flow performs on a switch.
            delete next.baseUrl;
            delete next.apiKeyEnv;
          }
        } else {
          // "Follow the default" has to actually clear the pin. Leaving the
          // old provider and model in place would report success and change
          // nothing, with the previous model still there on reload.
          delete next.provider;
          delete next.model;
        }
        await api.saveConfig(next);
        state.config = (await api.config()).config ?? {};
        await refreshCore();
        say('Saved. Every agent that does not pin its own follows this.');
      } catch (error) {
        say(error.message, 'bad');
      }
      state.busy = false; update();
    };

    const empty = el('p', { class: 'empty' }, 'No models reachable yet — add a provider sign-in first.');
    const saveButton = el('button', { class: 'primary', onClick: () => void save() }, 'Save');

    return {
      node: el('section', { class: 'card' },
        el('h2', {}, 'Models'),
        empty,
        el('label', {}, 'Default model'), picker,
        el('p', { class: 'field-note' }, 'Listed live from the sign-ins you have. An agent whose soul pins a provider or model keeps it, whatever this says.'),
        el('div', { class: 'actions' }, saveButton),
      ),
      refresh() {
        const config = state.config ?? {};
        syncOptions(
          picker,
          [
            { value: '', label: 'follow the default' },
            ...(state.models ?? []).map((model) => ({
              value: `${model.provider}:${model.id}`,
              label: `${model.id} — ${model.provider}`,
            })),
          ],
          config.provider && config.model ? `${config.provider}:${config.model}` : '',
        );
        empty.hidden = (state.models ?? []).length > 0;
        saveButton.disabled = state.busy;
      },
    };
  };

  // ---- channels ----------------------------------------------------------

  const buildChannels = () => {
    const agentPicker = el('select', {});
    const appToken = el('input', { type: 'password', placeholder: 'xapp-…' });
    const botToken = el('input', { type: 'password', placeholder: 'xoxb-…' });

    const save = async () => {
      state.busy = true; update();
      try {
        await api.storeChannel('slack', {
          agentId: agentPicker.value,
          appToken: appToken.value,
          botToken: botToken.value,
        });
        appToken.value = '';
        botToken.value = '';
        state.credentials = await api.credentials();
        say('Stored. Restart stratusd to bring that agent online in Slack.');
      } catch (error) {
        say(error.message, 'bad');
      }
      state.busy = false; update();
    };

    const bound = el('div', {});
    const saveButton = el('button', { class: 'primary', onClick: () => void save() }, 'Save');

    return {
      node: el('section', { class: 'card' },
        el('h2', {}, 'Channels'),
        bound,
        el('h3', {}, 'Connect an agent'),
        el('label', {}, 'Agent'), agentPicker,
        el('label', {}, 'App token'), appToken,
        el('label', {}, 'Bot token'), botToken,
        el('p', { class: 'field-note' }, 'Channel tokens are gateway secrets in their own namespace — an agent can never read the tokens of the transport carrying it.'),
        el('div', { class: 'actions' }, saveButton),
      ),
      refresh() {
        syncOptions(
          agentPicker,
          store.agents.filter((agent) => !agent.builtIn).map((agent) => ({ value: agent.id, label: agent.name })),
        );
        const connected = state.credentials?.channels?.slack ?? [];
        bound.replaceChildren(connected.length === 0
          ? el('p', { class: 'empty' }, 'No agent is connected to Slack yet.')
          : el('div', { class: 'rows' }, ...connected.map((agentId) => {
              const agent = store.agents.find((candidate) => candidate.id === agentId);
              return el('div', { class: 'row' },
                el('div', { class: 'grow' },
                  el('div', { class: 'title' }, agent?.name ?? agentId),
                  el('div', { class: 'sub' }, 'Slack app connected')),
                el('span', { class: 'pill running' }, 'slack'),
              );
            })));
        saveButton.disabled = state.busy;
      },
    };
  };

  const notice = el('div', {});

  const update = () => {
    pane ??= section === 'models' ? buildModels()
      : section === 'channels' ? buildChannels()
        : buildProviders();
    pane.refresh();
    notice.replaceChildren(
      ...(state.notice ? [el('div', { class: `notice ${state.notice.kind}` }, state.notice.text)] : []),
    );
    if (!node.firstChild) {
      node.replaceChildren(el('div', { class: 'column' }, pane.node, notice));
    }
  };

  update();
  void load();

  // Nothing here re-renders from the event stream: these are forms, and a
  // repaint driven by another agent's activity would take the caret out of
  // whatever someone was typing.
  return { node };
};
