import { el } from '../lib/dom.js';
import { decisionNote, decisionTone } from '../lib/decisions.js';

/** A call line's decision and shadow decision, as the notes beside it. */
const decisionParts = (line) => {
  const decision = line?.decision;
  const shadow = line?.shadow;
  return [
    decision
      ? el('span', { class: `decision ${decisionTone(decision)}`, title: decision.reason }, decisionNote(decision))
      : null,
    shadow
      ? el('span', { class: `decision shadow ${decisionTone(shadow)}`, title: shadow.reason }, decisionNote(shadow))
      : null,
    // A refusal's reason is what the agent was told, and the actionable
    // half for whoever is watching; an allowed call's reason stays in
    // the title, since every call has one.
    decision && !decision.allowed && decision.reason
      ? el('div', { class: 'decision-reason' }, decision.reason)
      : null,
  ];
};

/** One bubble per item from `transcriptItems`, a tool bubble with its decisions beside it. */
const bubble = (item) => (item.kind === 'tool'
  ? el('div', { class: 'bubble tool' }, item.text, ...decisionParts(item.line))
  : el('div', { class: `bubble ${item.kind}` }, item.text));

/** Repaints the transcript box with these items. */
export const paintTranscript = (box, items) => {
  // Pinned to the bottom only when the reader already was: yanking someone
  // back down while they are reading earlier output is worse than a reply
  // they have to scroll to.
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.replaceChildren(...items.map(bubble));
  if (pinned) {
    box.scrollTop = box.scrollHeight;
  }
};
