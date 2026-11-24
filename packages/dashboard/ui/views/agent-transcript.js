import { el } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { decisionLabel, decisionTone } from '../lib/decisions.js';

const OUTPUT_LIMIT = 4000;

/** A tool input or output as readable text: strings as they are, anything else as indented JSON, cut short. */
const readable = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const body = String(text ?? '');
  return body.length > OUTPUT_LIMIT ? `${body.slice(0, OUTPUT_LIMIT)}…` : body;
};

const PHASES = {
  running: { text: 'Running…', icon: 'loader-circle', tone: 'run' },
  waiting: { text: 'Needs approval', icon: 'shield-check', tone: 'wait' },
  denied: { text: 'Not run', icon: 'circle-slash', tone: 'bad' },
  done: { text: 'Succeeded', icon: 'circle-check', tone: 'ok' },
  failed: { text: 'Failed', icon: 'circle-x', tone: 'bad' },
};

/**
 * One tool call: its name, where it got to, and the permission decision
 * beside it, with the input and the output or error a click away. A refused
 * call reads as "Not run" whatever its stored result says, because the
 * decision is the truth about why it did not run.
 */
const toolRow = (item) => {
  const decision = item.line?.decision;
  const shadow = item.line?.shadow;
  const phase = decision && !decision.allowed ? PHASES.denied : PHASES[item.phase] ?? PHASES.running;
  const details = [];
  if (item.input !== undefined) {
    details.push(el('span', { class: 'k' }, 'Input'), el('span', { class: 'v' }, readable(item.input)));
  }
  if (item.error !== undefined) {
    details.push(el('span', { class: 'k' }, 'Error'), el('span', { class: 'v bad' }, readable(item.error)));
  } else if (item.output !== undefined) {
    details.push(el('span', { class: 'k' }, 'Output'), el('span', { class: 'v' }, readable(item.output)));
  }
  // A refusal's reason is what the agent was told, and the actionable half
  // for whoever is watching; an allowed call's reason stays in the badge's
  // title, since every call has one.
  if (decision && !decision.allowed && decision.reason) {
    details.push(el('div', { class: 'reason' }, decision.reason));
  }

  const summary = el('summary', {},
    icon(phase.icon, 15, `status-icon ${phase.tone}`),
    el('span', { class: 'name' }, item.toolName),
    el('span', { class: `state${phase.tone === 'bad' ? ' bad' : ''}` }, phase.text),
    el('span', { class: 'grow' }),
    decision ? el('span', { class: `badge${decisionTone(decision) === 'bad' ? ' bad' : ''}`, title: decision.reason }, decisionLabel(decision)) : null,
    shadow ? el('span', { class: `badge${decisionTone(shadow) === 'warn' ? ' warn' : ''}`, title: shadow.reason, style: 'border: 1px dashed currentColor;' }, decisionLabel(shadow)) : null,
    details.length > 0 ? icon('chevron-right', 14, 'chev') : null,
  );
  // Refusals open by default: the reason is the point.
  return el('details', { class: 'tool-call', open: decision && !decision.allowed ? 'open' : undefined }, summary,
    details.length > 0 ? el('div', { class: 'details' }, ...details) : null);
};

const node = (item) => {
  if (item.kind === 'tool') {
    return toolRow(item);
  }
  if (item.kind === 'user') {
    return el('div', { class: 'msg-user' }, String(item.text));
  }
  if (item.kind === 'approval') {
    return item.node;
  }
  return el('div', { class: `msg-agent${item.streaming ? ' streaming' : ''}` }, String(item.text));
};

/**
 * Repaints the thread with these items, keeping any tool row someone opened.
 *
 * `box` is the scrolling element and `column` the list inside it. Pinned to
 * the bottom only when the reader already was: yanking someone back down
 * while they are reading earlier output is worse than a reply they have to
 * scroll to.
 */
export const paintTranscript = (box, column, items, header) => {
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const opened = new Set([...column.querySelectorAll('details.tool-call')].map((details, index) => (details.open ? index : -1)).filter((index) => index >= 0));
  column.replaceChildren(...(header ? [header] : []), ...items.map(node));
  [...column.querySelectorAll('details.tool-call')].forEach((details, index) => {
    if (opened.has(index)) {
      details.open = true;
    }
  });
  if (pinned) {
    box.scrollTop = box.scrollHeight;
  }
};
