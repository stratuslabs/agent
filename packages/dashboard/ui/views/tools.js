import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { icon } from '../lib/icons.js';

/**
 * What this daemon's agents can use, and whose code it is.
 *
 * Built-in tools and plugins apart, because either alone misleads. The
 * tools say what an agent can be granted and at what risk; the plugins say
 * what the daemon was asked to load — including one that failed, which is
 * invisible in a list of tools and is often why somebody opened this page.
 */

const FAMILIES = {
  memory: { label: 'Memory', icon: 'brain', about: 'Long-term facts the agent chooses to keep' },
  skill: { label: 'Skills', icon: 'book-open', about: 'Load the full instructions for a skill' },
  schedule: { label: 'Schedules', icon: 'calendar-clock', about: 'Recurring, one-time and event-triggered runs' },
  message: { label: 'Messaging', icon: 'send', about: 'Post to and read the conversations the agent is in' },
  agent: { label: 'Delegation', icon: 'users', about: 'Hand work to another agent as a background task' },
  demo: { label: 'Demo', icon: 'sparkles', about: 'Transform text for demos' },
  web: { label: 'Web', icon: 'globe', about: 'Read web pages' },
  shell: { label: 'Shell', icon: 'terminal', about: 'Run commands on this machine' },
  fs: { label: 'Files', icon: 'folder', about: 'Read and write files' },
  browser: { label: 'Browser', icon: 'globe', about: 'Drive a browser' },
  channel: { label: 'Channels', icon: 'hash', about: 'Create, join and invite people to channels through the agent’s own app' },
  credential: { label: 'Credentials', icon: 'key-round', about: 'Ask you for a named credential the agent does not hold' },
};

const RANK = { safe: 0, gated: 1, dangerous: 2 };

/** A tool description's first sentence: they are written for the model, and run long. */
const firstSentence = (text) => {
  const sentence = String(text ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
};

/** A tool's risk as a badge: safe tools run, gated ones follow the approval setting, dangerous ones always ask. */
export const riskBadge = (risk) => el('span', {
  class: `badge${risk === 'dangerous' ? ' bad' : risk === 'gated' ? ' warn' : ''}`,
  title: risk === 'safe' ? 'Runs without asking'
    : risk === 'gated' ? 'Follows your approval setting'
      : 'Always asks, and is never remembered',
}, risk === 'safe' ? 'Safe' : risk === 'gated' ? 'Gated' : 'Dangerous');

/** Tools grouped by their namespace, each group at the highest risk among its tools. */
const families = (tools) => {
  const grouped = new Map();
  for (const tool of tools) {
    const namespace = tool.name.split('.')[0];
    const entry = grouped.get(namespace) ?? { namespace, tools: [], risk: 'safe' };
    entry.tools.push(tool);
    if ((RANK[tool.risk] ?? 0) > (RANK[entry.risk] ?? 0)) {
      entry.risk = tool.risk;
    }
    grouped.set(namespace, entry);
  }
  return [...grouped.values()];
};

const familyRow = (family, extra) => {
  const known = FAMILIES[family.namespace];
  return el('div', { class: 'panel-row' },
    el('span', { class: 'tool-icon' }, icon(known?.icon ?? 'blocks', 15)),
    el('div', { class: 'text' },
      el('div', { class: 'plugin-head' },
        el('span', { class: 'title' }, known?.label ?? family.namespace),
        el('span', { class: 'mono', style: 'color: var(--text-2); font-size: 12px;' }, family.tools.map((tool) => tool.name.split('.').slice(1).join('.') || tool.name).join(' · '))),
      el('div', { class: 'meta' }, known?.about ?? firstSentence(family.tools[0]?.description)),
      extra ?? null),
    riskBadge(family.risk));
};

const pluginRow = (plugin) => {
  if (plugin.error) {
    return el('div', { class: 'panel-row' },
      el('span', { class: 'tool-icon', style: 'color: var(--danger);' }, icon('triangle-alert', 15)),
      el('div', { class: 'text' },
        el('div', { class: 'title' }, plugin.package),
        el('div', { class: 'meta', style: 'color: var(--danger);' }, `Failed to load: ${plugin.error}`)),
      el('span', { class: 'badge bad' }, 'Failed to load'));
  }
  const tools = plugin.tools ?? [];
  if (tools.length === 0) {
    return el('div', { class: 'panel-row' },
      el('span', { class: 'tool-icon' }, icon('blocks', 15)),
      el('div', { class: 'text' },
        el('div', { class: 'title' }, plugin.package),
        el('div', { class: 'meta' }, 'Contributes no tools (a provider or channel, say).')),
      el('span', { class: 'badge' }, plugin.trusted ? 'First-party' : 'Third-party'));
  }
  return families(tools).map((family) => familyRow(family,
    el('div', { class: 'meta' },
      el('span', { class: 'mono' }, plugin.package),
      // Not decoration: a third-party plugin cannot declare a tool safe, so
      // this says why its risks read the way they do.
      plugin.trusted ? null : el('span', { class: 'badge' }, 'Third-party'))));
};

export const renderTools = () => {
  const state = { help: false, payload: undefined, error: undefined };
  const node = el('div', { class: 'page-scroll' });

  const paint = () => {
    const tools = state.payload?.tools ?? [];
    const plugins = state.payload?.plugins ?? [];
    const kernel = tools.filter((tool) => !tool.package);
    node.replaceChildren(el('div', { class: 'page-body', style: 'max-width: 960px;' },
      el('div', { class: 'page-head' },
        el('div', {},
          el('h1', {}, 'Tools'),
          el('div', { class: 'sub' }, 'What your agents can use. Each agent’s soul lists the tools it may call.')),
        el('button', { class: 'link accent', 'aria-expanded': state.help ? 'true' : 'false', onClick: () => { state.help = !state.help; paint(); } },
          'How to add plugins')),
      state.help
        ? el('div', { class: 'panel', style: 'padding: 16px;' },
            el('p', { style: 'margin: 0 0 10px;' }, 'Plugins are added on the machine running Stratus Agent. Run this in a terminal and choose Plugins:'),
            el('pre', { class: 'cmd' }, 'stratus setup'),
            el('p', { class: 'field-note' }, 'Installing a plugin grants no agent anything: each agent’s soul still lists the tools it may call.'))
        : null,
      state.error
        ? el('div', { class: 'notice bad' }, `Could not read the tool catalog: ${state.error}`)
        : state.payload === undefined
          ? el('p', { class: 'field-note' }, 'Loading…')
          : el('div', { style: 'display: flex; flex-direction: column; gap: 28px;' },
              el('section', {},
                el('div', { class: 'section-head' }, el('h2', {}, 'Built in'), el('span', { class: 'field-note', style: 'margin: 0;' }, `${kernel.length} tools`)),
                el('div', { class: 'panel' }, ...families(kernel).map((family) => familyRow(family)))),
              el('section', {},
                el('div', { class: 'section-head' }, el('h2', {}, 'Plugins')),
                plugins.length === 0
                  ? el('div', { class: 'empty-state' },
                      el('span', { class: 'icon-box' }, icon('blocks', 18)),
                      el('h3', {}, 'No plugins installed'),
                      el('p', {}, 'Plugins add a filesystem, a shell, a browser, web fetching and more. Add one with stratus setup.'))
                  : el('div', { class: 'panel' }, ...plugins.flatMap(pluginRow)))),
    ));
  };

  paint();
  api.tools().then(
    (payload) => { state.payload = payload; paint(); },
    (error) => { state.error = error.message; paint(); },
  );

  return { node };
};
