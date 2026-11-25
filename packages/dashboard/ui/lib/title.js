/** What the dashboard calls the product: the sidebar brand and every tab title. */
export const PRODUCT_NAME = 'Stratus Agent';

const PAGES = {
  home: 'Home',
  schedules: 'Schedules',
  tasks: 'Tasks',
  tools: 'Tools',
  permissions: 'Permissions',
  settings: 'Settings',
  new: 'New agent',
  'signed-out': 'Not signed in',
};

/**
 * The browser tab title for a route: the page first, so several open tabs
 * can be told apart when the tab strip truncates them, then the product.
 * An agent's page is named for the agent; before the roster read lands, or
 * for an id nobody has, the id stands in for the name.
 */
export const pageTitle = (route, agents = []) => {
  if (route?.name === 'agent') {
    const name = agents.find((agent) => agent.id === route.agentId)?.name || route.agentId;
    return `${route.tab === 'settings' ? `${name} settings` : name} · ${PRODUCT_NAME}`;
  }
  const page = route ? PAGES[route.name] : undefined;
  return page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME;
};
