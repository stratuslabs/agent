// The whole rendering layer. There is no framework here on purpose: the page
// has four screens and a websocket, and a build step would put a bundle
// between what ships and what a contributor edits.

/**
 * Build an element.
 *
 * Children are appended as text nodes unless they are already nodes — so
 * every string that reaches the DOM does so as text, and no data path can
 * become markup. There is deliberately no innerHTML helper in this file.
 */
export const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      node.className = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

export const clear = (node) => {
  node.replaceChildren();
  return node;
};

/** A relative time that stays honest without a timer per row. */
export const ago = (iso) => {
  if (!iso) {
    return 'never';
  }
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const duration = (ms) => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/**
 * How long is left before a deadline.
 *
 * `ago` is the wrong formatter for one and reads as nonsense: it clamps a
 * future timestamp's negative elapsed time to zero, so an approval half an
 * hour from lapsing renders as "just now". A deadline is the thing an
 * operator is deciding against, so it gets a countdown of its own.
 */
export const until = (iso) => {
  if (!iso) {
    return 'no expiry';
  }
  const ms = Date.parse(iso) - Date.now();
  return ms > 0 ? `in ${duration(ms)}` : 'now';
};
