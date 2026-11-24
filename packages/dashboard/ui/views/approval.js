import { el, until } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { avatar } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { alwaysOffer } from '../lib/grants.js';
import { answeredHere, refreshCore, store } from '../app.js';

/** What a call is asking to do, in words, for the card's title. */
const asking = (request) => {
  const tool = request.call.toolName;
  if (tool === 'shell.run' || tool.endsWith('.shell')) return 'run a shell command';
  if (tool === 'fs.write' || tool === 'fs.edit') return 'write a file';
  if (tool === 'fs.delete' || tool === 'fs.remove') return 'delete files';
  if (tool === 'message.send') return 'send a message';
  if (tool.startsWith('schedule.')) return 'create a schedule';
  if (tool === 'agent.delegate') return 'hand work to another agent';
  if (tool.startsWith('browser.')) return request.origin ? `use the browser on ${request.origin}` : 'use the browser';
  return `use ${tool}`;
};

/** The part of the input a person decides on: the command itself for a shell, the input otherwise. */
const commandOf = (request) => {
  const input = request.call.input ?? {};
  if (typeof input.command === 'string') {
    return { prompt: '$', text: input.command };
  }
  return { prompt: request.call.toolName, text: JSON.stringify(input) };
};

/**
 * The line under the command: why this ask can't be remembered, or what
 * **Always allow** would remember. Never silent about a lifetime, never a
 * promise the engine won't keep — `always` and `oneShot` ride in on the
 * request, so this says what the daemon decided rather than guessing.
 */
const notes = (request, agentName) => {
  const lines = [];
  if (request.reviewNote) {
    lines.push({ icon: 'sparkles', text: `Reviewer: ${request.reviewNote}` });
  }
  if (request.delegatedFrom) {
    const from = store.agents.find((agent) => agent.id === request.delegatedFrom.agentId)?.name ?? request.delegatedFrom.agentId;
    lines.push({ icon: 'users', text: `This is work for ${from}, so it is approved one call at a time.` });
  } else if (request.oneShot) {
    lines.push({ icon: 'info', text: request.risk === 'dangerous'
      ? 'Dangerous calls always ask. Approving covers this call only.'
      : 'Approving covers this call only. Nothing about it is remembered.' });
  } else {
    const offer = alwaysOffer(request.always, agentName);
    if (offer) {
      lines.push({ icon: 'info', text: `${offer} Revoke it in Permissions.` });
    }
  }
  return lines;
};

/**
 * One waiting approval, with its three answers.
 *
 * Shared by Home and the chat, so the two never word the same question
 * differently. A request that is no longer pending was answered elsewhere
 * (Slack, another tab), expired, or lost its turn: the refresh that follows
 * shows the truth, and retrying would only fail again.
 */
export const approvalCard = (request) => {
  const agent = store.agents.find((candidate) => candidate.id === request.agentId);
  const agentName = agent?.name ?? request.agentId;
  const offline = store.offlineSince !== undefined;
  const busy = { value: false };

  const decide = async (answer, buttons) => {
    if (busy.value) {
      return;
    }
    busy.value = true;
    answeredHere.add(request.requestId);
    for (const button of buttons) button.disabled = true;
    try {
      await api.resolveApproval({ requestId: request.requestId, answer });
    } catch {
      // Already settled somewhere else; the refresh below shows how.
    }
    await refreshCore();
  };

  const command = commandOf(request);
  const canRemember = !request.oneShot && !request.delegatedFrom && request.risk !== 'dangerous';
  const deny = el('button', { class: 'btn danger-text', disabled: offline }, 'Deny');
  const always = canRemember ? el('button', { class: 'btn', disabled: offline }, 'Always allow') : null;
  const once = el('button', { class: 'btn primary', disabled: offline }, 'Allow once');
  const buttons = [deny, always, once].filter(Boolean);
  deny.addEventListener('click', () => void decide('deny', buttons));
  always?.addEventListener('click', () => void decide('always', buttons));
  once.addEventListener('click', () => void decide('once', buttons));

  return el('section', {
    class: `approval${request.risk === 'dangerous' ? ' dangerous' : ''}`,
    'aria-label': `${agentName} needs approval`,
  },
  el('div', { class: 'top' },
    agent ? avatar(agent, 28) : null,
    el('div', { class: 'text' },
      el('div', { class: 'title' }, `${agentName} wants to ${asking(request)}`,
        request.risk === 'dangerous' ? el('span', { class: 'badge bad', style: 'margin-left: 8px;' }, 'Dangerous') : null),
      el('div', { class: 'meta' }, `Needs approval · ${request.expiresAt ? `expires ${until(request.expiresAt)}` : 'no expiry'}`)),
    el('div', { class: 'actions' }, ...buttons)),
  el('div', { class: 'command' },
    el('span', { class: 'prompt' }, command.prompt),
    el('span', {}, command.text)),
  ...notes(request, agentName).map((line) => el('div', { class: 'note' }, icon(line.icon, 14), el('span', {}, line.text))),
  );
};

/** Every waiting approval: one card, or the first with a count and the rest behind "Show all". */
export const approvalStack = (requests, { expanded, onToggle }) => {
  if (requests.length === 0) {
    return null;
  }
  if (requests.length === 1) {
    return approvalCard(requests[0]);
  }
  const names = [...new Set(requests.map((request) => store.agents.find((agent) => agent.id === request.agentId)?.name ?? request.agentId))];
  return el('div', { class: 'approval-stack' },
    el('div', { class: 'stack-head' },
      el('span', { class: 'badge warn' }, `${requests.length} waiting`),
      el('span', { style: 'flex: 1;' }, names.join(', ')),
      el('button', { class: 'link', onClick: onToggle, 'aria-expanded': expanded ? 'true' : 'false' }, expanded ? 'Show fewer' : 'Show all')),
    ...(expanded ? requests : requests.slice(0, 1)).map(approvalCard),
  );
};

const ANSWERS = { once: 'Allowed once', always: 'Always allowed', deny: 'Denied' };

/** An approval that was waiting here and was settled somewhere else, said in one line. */
export const answeredRow = (entry) => {
  const agentName = store.agents.find((agent) => agent.id === entry.request.agentId)?.name ?? entry.request.agentId;
  const outcome = entry.reason === 'decided'
    ? `Answered elsewhere · ${ANSWERS[entry.answer] ?? entry.answer}`
    : entry.reason === 'expired' ? 'Expired before anyone answered'
      : 'No longer needed: its turn ended';
  return el('div', { class: 'approval answered' },
    icon(entry.answer === 'deny' && entry.reason === 'decided' ? 'circle-x' : 'circle-check', 16),
    el('span', { style: 'flex: 1; color: var(--text);' }, `${agentName} wanted to ${asking(entry.request)}`),
    el('span', {}, outcome));
};
