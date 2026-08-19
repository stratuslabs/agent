import { el } from './dom.js';

/**
 * The agent's avatar, drawn from the palette the kernel computed.
 *
 * Deterministic and local: the same hue and palette that `stratus agents`
 * prints as prose, rendered as a mark. No image is fetched — the page's CSP
 * allows only its own origin, and an agent's identity should not depend on a
 * network round trip.
 */
export const avatar = (agent, size = 28) => {
  const theme = agent.avatar;
  const initial = (agent.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  const node = el('span', { class: 'avatar', 'aria-hidden': 'true' }, initial);
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.style.fontSize = `${Math.round(size * 0.44)}px`;

  if (theme) {
    const [first, second] = theme.palette ?? [];
    node.style.background = second
      ? `linear-gradient(135deg, ${first}, ${second})`
      : (first ?? `hsl(${theme.hue} 60% 55%)`);
  } else {
    node.style.background = 'var(--muted-strong)';
  }
  return node;
};
