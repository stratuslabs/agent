import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';

/**
 * What this daemon can actually do, and whose code it is.
 *
 * Two lists rather than one, because either alone misleads. The tools say
 * what an agent can be granted and at what risk; the plugins say what the
 * daemon was *asked* to load — including one that failed, which is
 * invisible in a list of tools and is often the reason somebody opened this
 * screen.
 */

const riskPill = (risk) => el('span', { class: `pill risk-${risk}` }, risk);

const toolRow = (tool) => el('div', { class: 'row' },
  el('div', { class: 'grow' },
    el('div', { class: 'title' }, tool.name),
    tool.description ? el('div', { class: 'sub' }, tool.description) : null,
  ),
  riskPill(tool.risk),
);

const pluginCard = (plugin) => {
  if (plugin.error) {
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', {}, plugin.package),
        el('span', { class: 'pill failed' }, 'did not load'),
      ),
      el('p', { class: 'field-note' }, plugin.error),
    );
  }

  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, plugin.package),
      // Not decoration: a third-party plugin cannot declare a tool `safe`,
      // so this says why the risks below read the way they do.
      el('span', { class: plugin.trusted ? 'pill' : 'pill risk-gated' },
        plugin.trusted ? 'first-party' : 'third-party'),
    ),
    (plugin.tools ?? []).length === 0
      ? el('p', { class: 'field-note' }, 'Contributes no tools.')
      : el('div', {}, ...(plugin.tools ?? []).map(toolRow)),
  );
};

const kernelCard = (tools) => el('section', { class: 'card' },
  el('div', { class: 'card-head' },
    el('h2', {}, 'Built in'),
    el('span', { class: 'pill' }, `${tools.length} tool${tools.length === 1 ? '' : 's'}`),
  ),
  el('div', {}, ...tools.map(toolRow)),
);

const emptyCard = () => el('section', { class: 'card' },
  el('h2', {}, 'No plugins installed'),
  el('p', {}, 'Capability arrives as plugins: a filesystem, a shell, a browser, a web fetcher. Install one and list it in ~/.stratus/config.json.'),
  el('pre', { class: 'cmd' }, 'npm install @stratusagent/tool-fs\n\n"plugins": {\n  "@stratusagent/tool-fs": { "enabled": true, "roots": ["~/notes"] }\n}'),
  el('p', { class: 'field-note' }, 'Installing a plugin grants no agent anything — each agent’s soul still lists the tools it may call, on its Settings tab.'),
);

export const renderPlugins = () => {
  const node = el('div', { class: 'main solo' }, el('section', { class: 'card' }, el('p', {}, 'Loading…')));

  const paint = (tools, plugins) => {
    const kernel = tools.filter((tool) => !tool.package);
    node.replaceChildren(
      ...(plugins.length === 0 ? [emptyCard()] : plugins.map(pluginCard)),
      ...(kernel.length > 0 ? [kernelCard(kernel)] : []),
    );
  };

  api.tools().then(
    (payload) => paint(payload.tools ?? [], payload.plugins ?? []),
    (error) => {
      node.replaceChildren(el('section', { class: 'card' },
        el('h2', {}, 'Plugins'),
        el('p', { class: 'field-note' }, `Could not read the tool catalog: ${error.message}`),
      ));
    },
  );

  return { node };
};
