import { duration, el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { syncOptions, touchOnChange } from '../lib/forms.js';
import { refreshCore, store } from '../app.js';

const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', codex: 'Codex' };
const providerName = (provider) => PROVIDER_NAMES[provider] ?? provider;

/** What a stored sign-in is, in words. */
const signInKind = (entry) => (entry.type === 'oauth_token'
  ? entry.provider === 'codex' ? 'ChatGPT sign-in (codex login)' : 'Claude subscription'
  : 'API key');

/**
 * Every setting on one page: provider sign-ins, the default model, Slack per
 * agent, how approvals work, and what this daemon is.
 *
 * Each section's form is built once and kept. `update()` runs on every
 * notice and on both edges of every request; rebuilding a form there would
 * put a fresh, empty one on screen the moment someone pressed Verify, so a
 * key that had just been checked was gone before it could be saved. Only
 * the data-driven parts refresh; what someone typed is state, not a
 * projection of the server.
 */
export const renderSettings = (section) => {
  const state = { credentials: undefined, models: undefined, config: undefined, notices: {}, busy: false };
  const node = el('div', { class: 'page-scroll' });

  const say = (where, text, kind = 'ok') => {
    state.notices[where] = { text, kind };
    update();
  };
  const noticeFor = (where) => {
    const notice = state.notices[where];
    return notice ? el('div', { class: `notice ${notice.kind}`, role: notice.kind === 'bad' ? 'alert' : 'status', style: 'margin-top: 12px;' }, notice.text) : null;
  };

  /**
   * The three reads behind the page, settled on their own: a config file
   * someone broke by hand should not stop the sign-ins from showing. Each
   * failure is said in the sections that needed it.
   */
  /**
   * Re-reads after a write that already succeeded. Best effort, and never
   * the write's verdict: a catalog that can't be listed right now must not
   * make a stored key look unsaved, or the retry it invites stores an empty
   * one. Returns a sentence to add when a re-read failed.
   */
  const reread = async (parts) => {
    const failed = [];
    // A read that works again clears the failure notice it left on load:
    // current data under "could not read" is a contradiction.
    if (parts.includes('credentials')) {
      await api.credentials().then((value) => {
        state.credentials = value;
        delete state.notices.providers;
        delete state.notices.channels;
      }, () => failed.push('sign-ins'));
    }
    if (parts.includes('models')) {
      await api.models().then((value) => {
        state.models = value.models ?? state.models;
        if (state.config !== undefined) delete state.notices.models;
      }, () => failed.push('models'));
    }
    if (parts.includes('config')) {
      await api.config().then((value) => {
        state.config = value.config ?? {};
        delete state.notices.approvals;
        if (state.models !== undefined) delete state.notices.models;
      }, () => failed.push('config file'));
    }
    return failed.length > 0 ? ` Couldn't refresh the ${failed.join(' and ')} afterwards; what's shown may be out of date.` : '';
  };

  const load = async () => {
    const [credentials, models, config] = await Promise.allSettled([api.credentials(), api.models(), api.config()]);
    if (credentials.status === 'fulfilled') {
      state.credentials = credentials.value;
    } else {
      const text = `Could not read the sign-ins: ${credentials.reason.message}`;
      state.notices.providers = { text, kind: 'bad' };
      state.notices.channels = { text, kind: 'bad' };
    }
    if (models.status === 'fulfilled') {
      state.models = models.value.models ?? [];
    } else {
      state.notices.models = { text: `Could not list the models: ${models.reason.message}`, kind: 'bad' };
    }
    if (config.status === 'fulfilled') {
      state.config = config.value.config ?? {};
    } else {
      const text = `Could not read the config file: ${config.reason.message}`;
      state.notices.models = { text, kind: 'bad' };
      state.notices.approvals = { text, kind: 'bad' };
    }
    update();
  };

  // ---- providers ---------------------------------------------------------

  const buildProviders = () => {
    const provider = el('select', { id: 'sign-in-provider' });
    const type = el('select', { id: 'sign-in-type' },
      el('option', { value: 'api_key' }, 'API key'),
      el('option', { value: 'oauth_token' }, 'Subscription sign-in'));
    const value = el('input', { type: 'password', id: 'sign-in-key', placeholder: 'Paste the key', autocomplete: 'off' });
    const baseUrl = el('input', { id: 'sign-in-endpoint', placeholder: 'Optional: a proxy or local endpoint' });
    const hint = el('p', { class: 'field-note' });
    const form = el('div', { class: 'panel', style: 'padding: 16px; margin-top: 12px;', hidden: true });

    const describeType = () => {
      hint.replaceChildren(type.value === 'api_key'
        ? 'A key is bound to the endpoint you save it with, and is never sent anywhere else.'
        : provider.value === 'codex'
          ? 'This records that this machine uses codex login. Type anything (say, “chatgpt”) as the value; it is never sent anywhere.'
          : el('span', {}, 'In a terminal, run ', el('code', {}, 'claude setup-token'), ', then paste the token here.'));
    };
    type.addEventListener('change', describeType);
    provider.addEventListener('change', describeType);

    /**
     * Opens the form for one provider, set from that provider's own stored
     * sign-in, never from whatever the form last held: a subscription kept
     * as a subscription, and an endpoint typed for another provider never
     * carried over to send this one's key somewhere else.
     */
    const fillFor = (name) => {
      const stored = (state.credentials?.providers ?? []).find((entry) => entry.provider === name);
      provider.value = name;
      type.value = stored?.type === 'oauth_token' ? 'oauth_token' : 'api_key';
      baseUrl.value = stored?.baseUrl ?? '';
      value.value = '';
      describeType();
    };
    // Switching provider inside the form resets it the same way.
    provider.addEventListener('change', () => fillFor(provider.value));

    const open = (name) => {
      form.hidden = false;
      fillFor(name);
      value.focus();
    };

    const verify = async () => {
      state.busy = true; update();
      try {
        const verdict = await api.verifyKey({
          provider: provider.value,
          // The type decides how the value is checked at all: a subscription
          // token cannot reach the models endpoint, and checked as an API
          // key it comes back rejected — condemning a credential that works
          // once saved.
          type: type.value,
          key: value.value,
          ...(baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
        });
        // Only an explicit auth failure condemns a key: plenty of compatible
        // endpoints have no models route at all, and "unreachable" there says
        // nothing about whether the key works.
        say(
          'providers',
          verdict.status === 'ok' ? 'That key works.'
            : verdict.status === 'rejected' ? `${providerName(provider.value)} rejected it: ${verdict.detail ?? 'the provider refused it'}`
              : `Could not check it: ${verdict.detail ?? 'unreachable'}. It may still be fine.`,
          verdict.status === 'rejected' ? 'bad' : 'ok',
        );
      } catch (error) {
        say('providers', error.message, 'bad');
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
      } catch (error) {
        say('providers', error.message, 'bad');
        state.busy = false; update();
        return;
      }
      // Stored. From here nothing can make it look unsaved.
      value.value = '';
      form.hidden = true;
      const note = await reread(['credentials', 'models']);
      say('providers', `Saved in ~/.stratus/credentials.json, readable only by you.${note}`, note ? 'bad' : 'ok');
      state.busy = false; update();
    };

    const list = el('div', { class: 'panel' });
    const verifyButton = el('button', { class: 'btn', onClick: () => void verify() }, 'Verify');
    const saveButton = el('button', { class: 'btn primary', onClick: () => void save() }, 'Save');
    const cancelButton = el('button', { class: 'btn quiet', onClick: () => { form.hidden = true; value.value = ''; } }, 'Cancel');
    form.append(
      el('div', { class: 'field' }, el('label', { for: 'sign-in-provider' }, 'Provider'), provider),
      el('div', { class: 'field' }, el('label', { for: 'sign-in-type' }, 'Type'), type),
      el('div', { class: 'field' }, el('label', { for: 'sign-in-key' }, 'Key or token'), value, hint),
      el('div', { class: 'field' }, el('label', { for: 'sign-in-endpoint' }, 'Endpoint'), baseUrl),
      el('div', { class: 'form-actions' }, cancelButton, verifyButton, saveButton));

    return {
      node: el('div', {}, list, form),
      refresh() {
        const entries = state.credentials?.providers ?? [];
        syncOptions(provider, entries.map((entry) => ({ value: entry.provider, label: providerName(entry.provider) })));
        list.replaceChildren(...(entries.length === 0
          ? [el('div', { class: 'panel-row' }, el('span', { class: 'field-note' }, state.credentials ? 'No providers.' : 'Loading…'))]
          : entries.map((entry) => el('div', { class: 'panel-row' },
              el('span', { class: 'tool-icon' }, icon('key-round', 15)),
              el('div', { class: 'text' },
                el('div', { class: 'title' }, providerName(entry.provider)),
                el('div', { class: 'meta' },
                  el('span', { class: `dot ${entry.stored ? 'working' : 'idle'}` }),
                  entry.stored ? `Connected · ${signInKind(entry)}${entry.baseUrl ? ` · ${entry.baseUrl}` : ''}` : 'Not connected')),
              el('button', { class: 'btn small', onClick: () => open(entry.provider) }, entry.stored ? 'Replace' : 'Connect')))));
        verifyButton.disabled = state.busy;
        saveButton.disabled = state.busy;
      },
    };
  };

  // ---- default model ----------------------------------------------------

  const buildModels = () => {
    const picker = touchOnChange(el('select', { id: 'default-model', 'aria-label': 'Default model' }));

    const save = async () => {
      state.busy = true; update();
      try {
        // Re-read rather than spreading the snapshot this page loaded with.
        // PUT replaces the whole document, so a save built on a stale copy
        // silently reverts anything another surface changed in the meantime
        // — the CLI editing `approvals`, another tab picking a soul. This
        // narrows that window to the round trip below; it does not close it,
        // which would need a precondition the API does not offer yet.
        const config = (await api.config()).config ?? {};
        state.config = config;
        const [provider, model] = picker.value ? picker.value.split(/:(.*)/s) : [undefined, undefined];
        // A whole document, because PUT replaces rather than merges — sending
        // only the two changed keys would silently drop everything else in
        // the file, approvals and soul included. Which makes the *removals*
        // below load-bearing rather than tidying.
        const next = { ...config };
        if (picker.dataset.touched !== 'yes') {
          // Nobody chose anything here, so this save has no opinion about the
          // model. Deriving one from the picker's displayed value would let
          // opening the page and pressing Save rewrite a pin — which is how a
          // configuration the catalog could not express got deleted.
        } else if (provider || model) {
          if (provider) {
            next.provider = provider;
          } else {
            delete next.provider;
          }
          if (model) {
            next.model = model;
          } else {
            delete next.model;
          }
          if (provider && provider !== config.provider) {
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
      } catch (error) {
        say('models', error.message, 'bad');
        state.busy = false; update();
        return;
      }
      picker.dataset.touched = '';
      const note = await reread(['config']);
      await refreshCore();
      say('models', `Saved. Every agent that does not pin its own model follows this.${note}`, note ? 'bad' : 'ok');
      state.busy = false; update();
    };

    const empty = el('p', { class: 'field-note' }, 'No models reachable yet. Connect a provider first.');
    const saveButton = el('button', { class: 'btn primary', onClick: () => void save() }, 'Save');

    return {
      node: el('div', {},
        el('div', { style: 'display: flex; gap: 10px;' }, picker, saveButton),
        empty),
      refresh() {
        const config = state.config ?? {};
        // Either half counts as a pin. A config naming only a provider takes
        // that provider's default model, and one naming only a model keeps
        // the provider from elsewhere — both are configurations someone
        // chose, and reading only the pair called them unpinned.
        const pinned = config.provider || config.model
          ? `${config.provider ?? ''}:${config.model ?? ''}`
          : '';
        const listed = (state.models ?? []).map((model) => ({
          value: `${model.provider}:${model.id}`,
          label: `${model.id} · ${providerName(model.provider)}`,
        }));
        // The configured pin, even when the live catalog does not list it —
        // an endpoint that omits the model, a sign-in the provider is
        // currently refusing, or a partial pin the catalog cannot express.
        // Without an option to select, the browser leaves the picker on
        // "follow the default", which is a claim about the config that is not
        // true. Labelled for what it is rather than shown as a normal choice.
        if (pinned && !listed.some((option) => option.value === pinned)) {
          const label = config.provider && config.model
            ? `${config.model} · ${providerName(config.provider)} (not listed right now)`
            : config.provider
              ? `${providerName(config.provider)} · its default model`
              : `${config.model} · whichever provider is default`;
          listed.unshift({ value: pinned, label });
        }
        syncOptions(picker, [{ value: '', label: 'Follow the setup default' }, ...listed], pinned);
        empty.hidden = (state.models ?? []).length > 0;
        saveButton.disabled = state.busy;
      },
    };
  };

  // ---- channels ----------------------------------------------------------

  const buildChannels = () => {
    const appToken = el('input', { type: 'password', id: 'slack-app', placeholder: 'xapp-…', autocomplete: 'off' });
    const botToken = el('input', { type: 'password', id: 'slack-bot', placeholder: 'xoxb-…', autocomplete: 'off' });
    const form = el('div', { class: 'panel', style: 'padding: 16px; margin-top: 12px;', hidden: true });
    const formTitle = el('div', { style: 'font-weight: 600; margin-bottom: 12px;' });
    let target;

    const open = (agent) => {
      target = agent.id;
      formTitle.textContent = `Connect ${agent.name} to Slack`;
      form.hidden = false;
      appToken.focus();
    };

    const save = async () => {
      state.busy = true; update();
      let stored;
      try {
        stored = await api.storeChannel('slack', { agentId: target, appToken: appToken.value, botToken: botToken.value });
      } catch (error) {
        say('channels', error.message, 'bad');
        state.busy = false; update();
        return;
      }
      appToken.value = '';
      botToken.value = '';
      form.hidden = true;
      const note = await reread(['credentials']);
      // A daemon that reloads Slack connects the app now; one that
      // started without Slack, or could not reload, needs the restart.
      if (stored.reloaded) {
        say('channels', `Saved. Slack reloaded, so that agent comes online without a restart. If it doesn't, the daemon log says why.${note}`, note ? 'bad' : 'ok');
      } else if (stored.reason) {
        say('channels', `Saved. ${stored.reason}${note}`, 'bad');
      } else {
        say('channels', `Saved. Restart Stratus to bring that agent online in Slack.${note}`, note ? 'bad' : 'ok');
      }
      state.busy = false; update();
    };

    const list = el('div', { class: 'panel' });
    const saveButton = el('button', { class: 'btn primary', onClick: () => void save() }, 'Connect');
    form.append(
      formTitle,
      el('p', { class: 'field-note', style: 'margin: 0 0 12px;' }, 'Each agent has its own Slack app. Create it from the manifest that ', el('code', {}, 'stratus setup'), ' prints, then paste the two tokens Slack gives you.'),
      el('div', { class: 'field' }, el('label', { for: 'slack-app' }, 'App token'), appToken),
      el('div', { class: 'field' }, el('label', { for: 'slack-bot' }, 'Bot token'), botToken,
        el('p', { class: 'field-note' }, 'Tokens are stored in ~/.stratus. No agent can read the tokens of the app that carries it.')),
      el('div', { class: 'form-actions' }, el('button', { class: 'btn quiet', onClick: () => { form.hidden = true; } }, 'Cancel'), saveButton));

    return {
      node: el('div', {}, list, form),
      refresh() {
        // The built-in agent included, deliberately. It is the only agent a
        // fresh install has, the gateway dispatches Slack turns to it, and
        // the CLI's own Channels list starts with it.
        const connected = state.credentials?.channels?.slack ?? [];
        list.replaceChildren(...store.agents.map((agent) => el('div', { class: 'panel-row' },
          el('span', { class: 'tool-icon' }, icon('hash', 15)),
          el('div', { class: 'text' },
            el('div', { class: 'title' }, agent.name),
            el('div', { class: 'meta' },
              el('span', { class: `dot ${connected.includes(agent.id) ? 'working' : 'idle'}` }),
              connected.includes(agent.id) ? 'Slack app connected' : 'Not connected')),
          el('button', { class: 'btn small', onClick: () => open(agent) }, connected.includes(agent.id) ? 'Replace tokens' : 'Connect'))));
        saveButton.disabled = state.busy;
      },
    };
  };

  // ---- approvals ---------------------------------------------------------

  const POSTURES = [
    { id: 'open', label: 'Open', about: 'Gated tools run without asking. Dangerous tools always ask.' },
    { id: 'guarded', label: 'Guarded', about: 'Gated tools ask you first, unless a grant covers the call.' },
    { id: 'review', label: 'Review', about: 'A reviewer model decides, and asks you when it is unsure.' },
  ];

  const buildApprovals = () => {
    const name = 'posture';
    const radios = POSTURES.map((posture) => el('input', { type: 'radio', name, value: posture.id, id: `posture-${posture.id}`, style: 'width: auto; margin: 3px 0 0;' }));
    const saveButton = el('button', { class: 'btn primary', onClick: () => void save() }, 'Save');
    let chosen;
    for (const radio of radios) {
      radio.addEventListener('change', () => { chosen = radio.value; });
    }

    const save = async () => {
      if (!chosen) {
        return;
      }
      state.busy = true; update();
      try {
        // Re-read and replace the whole document, for the same reason the
        // model picker does.
        const config = (await api.config()).config ?? {};
        await api.saveConfig({ ...config, approvals: { ...(config.approvals ?? {}), posture: chosen } });
      } catch (error) {
        say('approvals', error.message, 'bad');
        state.busy = false; update();
        return;
      }
      chosen = undefined;
      const note = await reread(['config']);
      say('approvals', `Saved to config.json. Restart Stratus (stratus restart) so every agent picks it up.${note}`, note ? 'bad' : 'ok');
      state.busy = false; update();
    };

    return {
      node: el('div', {},
        el('div', { class: 'panel' }, ...POSTURES.map((posture, index) => el('label', { class: 'panel-row', for: `posture-${posture.id}`, style: 'cursor: pointer; margin: 0; align-items: flex-start; font-weight: 400;' },
          radios[index],
          el('div', { class: 'text' },
            el('div', { class: 'title' }, posture.label, posture.id === 'open' ? el('span', { class: 'badge', style: 'margin-left: 8px;' }, 'Default') : null),
            el('div', { class: 'meta' }, posture.about))))),
        el('div', { class: 'form-actions', style: 'margin-top: 12px;' }, saveButton)),
      refresh() {
        // Open when the file says nothing: the default the daemon resolves.
        // Nothing checked when the file couldn't be read: a guess here would
        // be a claim about a setting nobody could see.
        const current = state.config === undefined ? undefined : (state.config.approvals?.posture ?? 'open');
        for (const radio of radios) {
          if (!chosen) {
            radio.checked = radio.value === current;
          }
        }
        saveButton.disabled = state.busy || !chosen;
      },
    };
  };

  const sections = {
    providers: { title: 'Providers', about: 'Sign-ins your agents think with. Keys stay on this machine in ~/.stratus and are only sent to the provider they’re for.', build: buildProviders },
    models: { title: 'Default model', about: 'Agents use this unless their own settings pin another.', build: buildModels },
    channels: { title: 'Channels', about: 'Let agents answer in Slack. Each agent gets its own Slack app.', build: buildChannels },
    approvals: { title: 'Approvals', about: 'What happens when an agent calls a gated tool. Agents with their own setting in config.json keep it.', build: buildApprovals },
  };
  const panes = Object.fromEntries(Object.entries(sections).map(([id, spec]) => [id, spec.build()]));
  const noticeSlots = Object.fromEntries(Object.keys(sections).map((id) => [id, el('div', {})]));
  const pageNotice = el('div', {});
  const about = el('div', { class: 'panel' });

  node.append(el('div', { class: 'page-body' },
    el('div', { class: 'page-head' }, el('div', {},
      el('h1', {}, 'Settings'),
      el('div', { class: 'sub' }, 'Sign-ins, default model, Slack and approvals.'))),
    pageNotice,
    ...Object.entries(sections).map(([id, spec]) => el('section', { class: 'settings-section', id: `settings-${id}` },
      el('div', {}, el('h2', {}, spec.title), el('p', { class: 'about' }, spec.about)),
      el('div', {}, panes[id].node, noticeSlots[id]))),
    el('section', { class: 'settings-section', id: 'settings-about' },
      el('div', {}, el('h2', {}, 'About'), el('p', { class: 'about' }, 'Everything else lives in the CLI.')),
      about)));

  const update = () => {
    for (const [id, pane] of Object.entries(panes)) {
      pane.refresh();
      noticeSlots[id].replaceChildren(...[noticeFor(id)].filter(Boolean));
    }
    pageNotice.replaceChildren(...[noticeFor('page')].filter(Boolean));
    const row = (label, value) => el('div', { class: 'panel-row' }, el('span', { class: 'text', style: 'color: var(--text-2);' }, label), el('span', { class: 'mono' }, value));
    about.replaceChildren(
      row('Version', store.health?.version ?? '—'),
      row('Data', '~/.stratus'),
      row('Uptime', store.health?.uptimeMs !== undefined ? duration(store.health.uptimeMs) : '—'));
  };

  update();
  void load().then(() => {
    // An old link to a section, or a click from an agent's settings, lands on it.
    if (section && sections[section]) {
      node.querySelector(`#settings-${section}`)?.scrollIntoView({ block: 'start' });
    }
  });

  // Nothing here re-renders from the event stream: these are forms, and a
  // repaint driven by another agent's activity would take the caret out of
  // whatever someone was typing.
  return { node };
};
