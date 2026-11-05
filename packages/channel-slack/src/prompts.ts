/*
 * The approval and credential prompts the adapter posts: Block Kit for an
 * approval request and how it reads once settled, and for a credential
 * request. Nothing here is public: `index.ts` imports what the adapter
 * needs, and the package's one public entry is unchanged.
 */
import type { AlwaysMeans, ApprovalAnswer, CredentialScope, JsonObject } from '@stratusagent/core';

import type { SlackBlock } from './index.ts';

export const APPROVAL_ACTIONS: Record<string, ApprovalAnswer> = {
  stratus_approve_once: 'once',
  stratus_approve_always: 'always',
  stratus_deny: 'deny',
};

/**
 * How an approval request reads once it is settled. `always` says out loud
 * how long it lasts: the button is the shortest path to widening what an
 * agent does unattended, and an approver should see the scope they granted
 * in the record of granting it.
 *
 * What it lasts rode in on the request as `always` (see `AlwaysMeans`),
 * so the line names the grant that was made rather than hedging between
 * lifetimes — which this message once had to, when nothing on the bus said
 * whether an "always" was the session's or the file's. One thing the
 * request still cannot promise is the disk write: the daemon does not
 * write over a whitelist it could not read, and by then this message has
 * been sent. The daemon's log has that line; `stratus grants <agent>` has
 * the list.
 */
export const OUTCOME_TEXT: Record<string, string> = {
  'decided:once': 'Allowed once',
  'decided:deny': 'Denied',
  'timeout:deny': 'Expired without an answer — denied',
  // Covers both endings that reach here: the turn was aborted, and the
  // daemon shut down with the request still outstanding.
  'cancelled:deny': 'Cancelled before anyone answered — denied',
  'undeliverable:deny': 'Could not be put to an approver — denied',
};

/**
 * What **Always allow** did, by the grant the request said it would make.
 * A tool grant names the agent because that is its scope — not this
 * thread, not the session — and says how to take it back, since a grant
 * an approver cannot find later is a ratchet.
 */
export const alwaysOutcome = (always: AlwaysMeans | undefined, agentName: string, agentId: string): string => {
  switch (always) {
    case 'scope':
      return 'Allowed, and this command\'s scope now runs without asking — until revoked';
    case 'origin':
      return 'Allowed, and this site is now acted on without asking — until revoked';
    case 'tool':
      return `Allowed, and granted to ${escapeSlackText(agentName)} until revoked (stratus grants ${escapeSlackText(agentId)})`;
    case 'destination':
      return `Allowed, and granted to ${escapeSlackText(agentName)} for this conversation until revoked (stratus grants ${escapeSlackText(agentId)})`;
    case 'session':
      return 'Allowed for the rest of this session';
    default:
      // An `always` submitted through `POST /approvals` against a request
      // this daemon did not label — an older daemon's event, say. The
      // request did not say, so neither does this.
      return 'Allowed and remembered — for this session at least';
  }
};

/**
 * What **Always allow** would do, said beside the button. The lifetime is
 * the half of the question the button widens, and it differs by tool: a
 * standing grant to the agent is a larger thing to hand out than a session,
 * and an approver should know which they are clicking.
 */
const alwaysOffer = (always: AlwaysMeans | undefined, agentName: string): string | undefined => {
  switch (always) {
    case 'tool':
      return `*Always allow* grants this tool to ${escapeSlackText(agentName)} until an operator revokes it.`;
    case 'destination':
      return `*Always allow* lets ${escapeSlackText(agentName)} use this tool on this conversation without asking, until revoked.`;
    case 'session':
      return '*Always allow* stops this tool asking again for the rest of this session.';
    case 'scope':
      return '*Always allow* remembers this command\'s scope for this agent, until revoked.';
    case 'origin':
      return '*Always allow* remembers this site for this agent, until revoked.';
    default:
      return undefined;
  }
};

/** Comfortably inside Slack's 3000-character section limit. */
const APPROVAL_INPUT_LIMIT = 1400;
/** One line in a notification; the blocks carry the readable version. */
const APPROVAL_SUMMARY_LIMIT = 160;

/**
 * Slack's three markup characters. Tool input is written by a model, so it
 * reaches this message as untrusted text: unescaped, `<@U123>` becomes a
 * real mention and `<!channel>` a real broadcast, letting an agent ping a
 * workspace through the very prompt asking whether to trust it. Escaping is
 * applied even inside a code block, where clients disagree about whether
 * that markup still resolves.
 */
export const escapeSlackText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * What the approver is actually being asked to allow.
 *
 * Without this the prompt names only the tool, and for anything whose
 * danger lives in its arguments — the shell tool this engine exists for —
 * `ls` and a destructive command produce an identical message. Approving
 * something you cannot see is not approval.
 *
 * Truncation is announced rather than silent for the same reason: a
 * decision made on a partial view should at least know it is partial.
 */
export const renderInvocation = (input: JsonObject): { detail?: string; summary: string; truncated: boolean } => {
  if (Object.keys(input).length === 0) {
    return { summary: '', truncated: false };
  }
  const rendered = JSON.stringify(input, null, 2);
  const truncated = rendered.length > APPROVAL_INPUT_LIMIT;
  const oneLine = JSON.stringify(input);
  return {
    detail: truncated ? rendered.slice(0, APPROVAL_INPUT_LIMIT) : rendered,
    summary: oneLine.length > APPROVAL_SUMMARY_LIMIT
      ? `${oneLine.slice(0, APPROVAL_SUMMARY_LIMIT)}…`
      : oneLine,
    truncated,
  };
};

export const approvalBlocks = (
  agentName: string,
  toolName: string,
  risk: string,
  requestId: string,
  input: JsonObject,
  origin: string | undefined,
  oneShot: boolean,
  always: AlwaysMeans | undefined,
  /** Why the review posture is asking: shown as plain text, so it can't mention or format. */
  reviewNote?: string,
): SlackBlock[] => {
  const invocation = renderInvocation(input);
  const offer = oneShot ? undefined : alwaysOffer(always, agentName);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // The site, when the call is judged by one. It is not in the
        // arguments and cannot be: a `browser.act` request shows a CSS
        // selector, which says nothing about where the click lands — and
        // **Always allow** widens exactly that site, so an approver who was
        // not shown it is being asked to grant something they cannot see.
        text: `*${escapeSlackText(agentName)}* wants to run \`${escapeSlackText(toolName)}\` (${risk})`
          + `${origin ? ` on \`${escapeSlackText(origin)}\`` : ''}.`,
      },
    },
    ...(invocation.detail
      ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `\`\`\`\n${escapeSlackText(invocation.detail)}\n\`\`\`` },
        }]
      : []),
    ...(invocation.truncated
      ? [{
          type: 'context',
          elements: [{ type: 'mrkdwn', text: ':warning: Arguments shown are truncated — the full call is longer than this.' }],
        }]
      : []),
    ...(reviewNote !== undefined && reviewNote.trim().length > 0
      ? [{
          type: 'context',
          elements: [{ type: 'plain_text', text: `Review: ${reviewNote.trim().slice(0, 300)}`, emoji: false }],
        }]
      : []),
    // Why there is no second button, when there is no second button — and
    // what the second button does, when there is one.
    ...(oneShot
      ? [{
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: ':lock: An approval covers this call only — nothing about it is remembered.',
          }],
        }]
      : offer !== undefined
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: offer }] }]
        : []),
    {
      type: 'actions',
      // The request id rides on every button rather than in the message
      // reference: Slack gives the value back verbatim, so the gateway is
      // asked about the request that was actually rendered, never one
      // re-derived from a channel and timestamp.
      //
      // **Always allow** is absent when the engine would not remember the
      // answer — a `dangerous` tool, or a browser action with no page to
      // grant. Offering it there is worse than useless: it does exactly
      // what **Allow once** does, under a label promising a standing grant
      // nobody gets.
      elements: [
        { type: 'button', action_id: 'stratus_approve_once', text: { type: 'plain_text', text: 'Allow once' }, value: requestId, ...(oneShot ? { style: 'primary' } : {}) },
        ...(oneShot
          ? []
          : [{ type: 'button', action_id: 'stratus_approve_always', text: { type: 'plain_text', text: 'Always allow' }, value: requestId, style: 'primary' }]),
        { type: 'button', action_id: 'stratus_deny', text: { type: 'plain_text', text: 'Deny' }, value: requestId, style: 'danger' },
      ],
    },
  ];
};

export const CREDENTIAL_ADD_ACTION = 'stratus_credential_add';
export const CREDENTIAL_VIEW = 'stratus_credential';
export const CREDENTIAL_BLOCK = 'credential_value';
export const CREDENTIAL_INPUT = 'value';
// Under Slack's three-second acknowledgement window, with room for the ack
// itself to travel.
export const CREDENTIAL_ACK_MS = 2500;
// A reason is the agent's own text, shown to a person deciding whether to
// hand over a key; long enough to explain, short enough to read.
const CREDENTIAL_REASON_LIMIT = 300;

export const credentialWhose = (agentName: string, scope: CredentialScope): string =>
  scope === 'agent'
    ? `for ${agentName} only`
    : `stored for the whole fleet, granted to ${agentName} (other agents need it in their own soul)`;

/**
 * What answering means when the agent asked for the key in a variable,
 * said before anything is typed: the approval covers the binding too.
 * `agentName` arrives escaped; the variable passed the gateway's rule, so
 * it is letters, digits and underscores.
 */
export const credentialShellLine = (agentName: string, env: string): string =>
  `${agentName}'s shell commands will be able to read this as \`${env}\`, so ${agentName} can see the value.`;

/**
 * The request as it appears in the conversation. What it says about the
 * value is the promise the form keeps: straight to the credential store,
 * never into the thread, and never over a key already there.
 */
export const credentialRequestBlocks = (
  agentName: string,
  name: string,
  scope: CredentialScope,
  reason: string | undefined,
  requestId: string,
  replace = false,
  env?: string,
): SlackBlock[] => {
  const shortReason = reason !== undefined && reason.length > CREDENTIAL_REASON_LIMIT
    ? `${reason.slice(0, CREDENTIAL_REASON_LIMIT)}…`
    : reason;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: replace
          ? `*${escapeSlackText(agentName)}* is asking for a new value for a credential it holds: \`${escapeSlackText(name)}\`, ${credentialWhose(escapeSlackText(agentName), scope)}.`
          : `*${escapeSlackText(agentName)}* is asking for a credential: \`${escapeSlackText(name)}\`, ${credentialWhose(escapeSlackText(agentName), scope)}.`,
      },
    },
    ...(shortReason !== undefined
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `_${escapeSlackText(agentName)} says:_ ${escapeSlackText(shortReason)}` } }]
      : []),
    ...(env !== undefined
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `*${credentialShellLine(escapeSlackText(agentName), escapeSlackText(env))}*` } }]
      : []),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: replace
          ? 'Only an approver can replace it. The new value goes straight to the credential store, never into this conversation, and the stored one is kept until it saves.'
          : 'Only an approver can add it. The value goes straight to the credential store, never into this conversation, and a key already stored is never replaced by an add.',
      }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: CREDENTIAL_ADD_ACTION,
        style: 'primary',
        value: requestId,
        text: { type: 'plain_text', text: replace ? 'Replace credential' : 'Add credential' },
      }],
    },
  ];
};
