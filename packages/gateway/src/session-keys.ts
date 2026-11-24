/*
 * What the gateway reserves on a session: the metadata keys a caller may not
 * set, the id markers and keys of rolled-over and sub-agent sessions, and the
 * errors a turn or a delegation cut short by a stopped daemon records. Moved
 * out of `index.ts` as is; `index.ts` re-exports the public names, so the
 * package's surface is unchanged.
 */
import {
  CONTEXT_FLOOR_METADATA_KEY,
  CONTEXT_SUMMARY_METADATA_KEY,
  type JsonObject,
  PENDING_APPROVAL_METADATA_KEY,
  type Session,
  SESSION_TAINTED_BY_METADATA_KEY,
  SESSION_TRUST_METADATA_KEY,
} from '@stratusagent/core';
import {
  CREDENTIAL_REQUEST_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  DELEGATED_BY_METADATA_KEY,
  DELEGATION_DEPTH_METADATA_KEY,
  ROOT_SESSION_ID_METADATA_KEY,
  SCHEDULE_ID_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  TASK_ID_METADATA_KEY,
} from '@stratusagent/agents';
import { FALLBACK_ACTIVE_METADATA_KEY } from '@stratusagent/state';

/**
 * Recorded on a turn the previous process was still running when it died.
 *
 * Exported because "distinguishable" is the whole point: a surface, a
 * test, or an operator reading `lastError` has to be able to tell a turn
 * nobody finished apart from one a provider or a tool actually failed, and
 * matching on prose that lives in one place beats each caller inventing
 * its own guess at the wording.
 */
export const ABANDONED_TURN_ERROR =
  'stratusd stopped while this turn was still running; it was not resumed. Send the message again.';

/**
 * The longest `DispatchInput.idempotencyKey` accepted. A platform message id
 * is far shorter; the bound is so a key cannot be used to grow every row it
 * is stored on.
 */

/**
 * Recorded on a delegated sub-session that was parked on a human when the
 * previous process died.
 *
 * Its parent — the turn whose `agent.delegate` call was awaiting the reply
 * — was running, so the restart settles it as abandoned (above). Recovering
 * the child anyway would re-ask a person to approve a call whose result no
 * turn will ever read, and then run it: a command executed, tokens spent,
 * and a reply delivered to nobody. Distinguishable from the parent's error
 * because the remedy differs — there is no message to send again here;
 * the parent's is the one to repeat.
 */
/**
 * Session metadata keys the daemon writes for itself, which no external
 * dispatch may supply.
 *
 * Metadata is one bag: the keys a channel attaches to say where a turn is
 * happening sit beside the ones the kernel, the scheduler, the fallback
 * wrapper, and `agent.delegate` write to remember what a session *is* —
 * and the control API forwards a caller's `metadata` into a new session as
 * given. A caller who can write `delegatedBy` can have the restart sweep
 * fail its own parked turn as an orphan; one who can write `fallbackActive`
 * bills its conversation to the fallback model from the first turn. The
 * scheduler already refused to trust its own keys for exactly this reason
 * (see `activeFirings`); the durable ones cannot be re-derived in memory,
 * so they are refused at the door instead.
 */
/**
 * A rolled-over session: the fresh row records where its predecessor's
 * transcript went, and the archived row records which live id continues
 * the conversation. See `Gateway.rolloverSession`.
 */
export const ROLLED_OVER_FROM_METADATA_KEY = 'rolledOverFrom';
export const ROLLED_OVER_TO_METADATA_KEY = 'rolledOverTo';
/** The segment a rollover mints into the archived transcript's id. */
export const ROLLED_OVER_SESSION_ID_MARKER = ':rolledover:';

/**
 * How long after a rollover a repeated key is still looked for in the
 * archived transcript. A rollover moves every keyed message out of the
 * live row, so a redelivery arriving after one would otherwise read as a
 * new message and run again. Platforms redeliver within minutes — Slack
 * gives up after about five — and past the window the archive is not
 * loaded at all, since every new message to the fresh row would pay for a
 * read that can no longer find anything.
 */
export const ROLLOVER_REPEAT_WINDOW_MS = 60 * 60 * 1000;

/**
 * The one refusal for a dispatch naming an agent other than its session's.
 * Its own type so a repeat attached to a claimant can tell the claimant was
 * refused for who it named — the item then still has no owner — from the
 * claimant's turn failing. Internal: callers read the message.
 */
export class CrossIdentityError extends Error {
  constructor(sessionId: string, owner: string, claimed: string) {
    super(`Session ${sessionId} belongs to agent ${owner}, not ${claimed} — sessions never cross agent identities.`);
    this.name = 'CrossIdentityError';
  }
}

export const crossIdentityError = (sessionId: string, owner: string, claimed: string): Error =>
  new CrossIdentityError(sessionId, owner, claimed);

/** Where the session's tool calls ran: `local-command`, or a contributed executor's registered name. */
export const EXECUTOR_METADATA_KEY = 'executor';

/**
 * Marks a sub-agent's session (roadmap 24). Reserved: it is what makes the
 * daemon deny the session's gated calls without asking anyone, so a caller
 * that could set it could also clear it.
 */
export const SUB_AGENT_METADATA_KEY = 'subAgent';
export const SUB_AGENT_SESSION_ID_MARKER = ':subagent:';
/** How many sub-agents one parent turn runs at once unless the host says otherwise. */
export const DEFAULT_SUB_AGENTS_PER_TURN = 4;

export const isSubAgentSession = (session: Pick<Session, 'id' | 'metadata'>): boolean =>
  session.metadata?.[SUB_AGENT_METADATA_KEY] === true && session.id.includes(SUB_AGENT_SESSION_ID_MARKER);

/**
 * Tools a sub-agent never gets, whatever its parent holds. `agent.spawn`
 * would fan out inside a fan-out; `agent.delegate` runs a roster agent
 * under that agent's own allowlist, which is the way out of a narrowed
 * slice; `memory.*` would let it persist what nobody reviewed; and
 * `credential.request` asks a person, which a sub-agent never does.
 */
export const subAgentNeverGets = (name: string): boolean =>
  name === 'agent.spawn'
  || name === DELEGATE_TOOL_NAME
  || name.startsWith('memory.')
  || name === CREDENTIAL_REQUEST_TOOL_NAME;

export const RESERVED_SESSION_METADATA_KEYS: readonly string[] = [
  PENDING_APPROVAL_METADATA_KEY,
  FALLBACK_ACTIVE_METADATA_KEY,
  DELEGATED_BY_METADATA_KEY,
  ROOT_SESSION_ID_METADATA_KEY,
  DELEGATION_DEPTH_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  SCHEDULE_ID_METADATA_KEY,
  // The trust label is the runner's to write and only ever goes down; a
  // caller who could seed it would be seeding it upward.
  SESSION_TRUST_METADATA_KEY,
  SESSION_TAINTED_BY_METADATA_KEY,
  ROLLED_OVER_FROM_METADATA_KEY,
  ROLLED_OVER_TO_METADATA_KEY,
  // Which executor ran the turn's tool calls is the daemon's record of
  // where a command ran, and the one audit question a caller must not be
  // able to answer for it.
  EXECUTOR_METADATA_KEY,
  // The context floor is an index into a specific transcript, so it means
  // nothing next to a different one. Reserved for both halves of that: a
  // caller cannot seed it, and a rollover drops it with the transcript it
  // indexed — otherwise the fresh session inherits an absolute floor over
  // no messages and, once it grows past that index, silently stops sending
  // its own earliest turns, with no overflow and no trim event to say so.
  CONTEXT_FLOOR_METADATA_KEY,
  // The summary that stands in below that floor, for both of the same
  // reasons, and one more: the model reads it as something it wrote itself,
  // so a caller who could seed it could put words in the agent's mouth.
  CONTEXT_SUMMARY_METADATA_KEY,
  SUB_AGENT_METADATA_KEY,
  // Which background task a worker session runs for. Only the gateway
  // writes it: a worker can't start background tasks of its own, and the
  // restart sweep will key on it.
  TASK_ID_METADATA_KEY,
];

/**
 * The first reserved key `metadata` carries, or undefined when it carries
 * none. Exported so the control API can refuse the request where the
 * caller can see it, with the same rule the gateway applies at dispatch.
 */
export const reservedSessionMetadataKey = (metadata: JsonObject | undefined): string | undefined =>
  metadata === undefined
    ? undefined
    : RESERVED_SESSION_METADATA_KEYS.find((key) => Object.prototype.hasOwnProperty.call(metadata, key));

export const ORPHANED_DELEGATION_ERROR =
  'stratusd stopped while the turn that delegated this one was still running; the delegation was not resumed. Send the original message again.';
