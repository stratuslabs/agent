import { el } from '../lib/dom.js';

/**
 * Honest placeholder rather than a fabricated list.
 *
 * Tool packs are step 06 of the roadmap, and the control API deliberately has
 * no `/catalog/tools` yet: today it could only report the three kernel tools,
 * which would read as "these are your installed packs" and be wrong.
 */
export const renderPlugins = () => ({ node: el('div', { class: 'main solo' },
  el('section', { class: 'card' },
    el('h2', {}, 'Plugins'),
    el('p', {}, 'Tool packs — filesystem, shell, browser — are the next step of the roadmap. Once they exist, this is where you will see what each agent can reach and at what risk level.'),
    el('p', { class: 'field-note' }, 'Until then an agent’s tools are the allowlist in its soul file, editable from that agent’s Settings tab.'),
  ),
) });
