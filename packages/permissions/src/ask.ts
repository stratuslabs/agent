/**
 * Reaching a person: the terminal prompt, the remote request, and giving up
 * on either the moment the turn is cancelled.
 */
import type {
  AlwaysMeans,
  ApprovalContext,
  ApprovalOutcome,
  JsonObject,
  JsonValue,
} from '@stratusagent/core';

import type { ApprovalRequester, PermissionPolicyOptions } from './options.ts';

const YES = new Set(['y', 'yes', 'always', 'a']);
const ALWAYS = new Set(['always', 'a']);

export const ABORTED = Symbol('aborted');

/**
 * Waits for `work`, but gives up the moment the turn is cancelled.
 *
 * Checking `signal.aborted` on either side of an await is not the same
 * thing: the await in the middle is exactly where a cancelled turn gets
 * stuck, because the human it is waiting on may answer late or never — a
 * closed terminal, a transport that dropped. Abandoning the wait leaves
 * the prompt outstanding, so its eventual settlement is swallowed rather
 * than surfacing as an unhandled rejection against a turn that is gone.
 */
export const untilAborted = async <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> => {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    work.catch(() => undefined);
    return ABORTED;
  }

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof ABORTED>((resolve) => {
        onAbort = (): void => resolve(ABORTED);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
};

/**
 * How long any single string value may be before it is elided, and the
 * overall backstop for an argument object with an unusual number of fields.
 */
const PROMPT_VALUE_LIMIT = 120;
const PROMPT_OVERALL_LIMIT = 400;

/**
 * Cap every string in a value to `PROMPT_VALUE_LIMIT`, structure preserved.
 *
 * The point is *per field*, not overall: a schedule's free-form `prompt`
 * must not be able to push its `destination` past a length cut and hide the
 * one thing the operator most needs to see — where an approved schedule may
 * post. Bounding each string instead keeps every key visible, so a long
 * prompt shortens itself and leaves the cadence and destination intact.
 */
const capStrings = (value: JsonValue): JsonValue => {
  if (typeof value === 'string') {
    return value.length > PROMPT_VALUE_LIMIT ? `${value.slice(0, PROMPT_VALUE_LIMIT)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map(capStrings);
  }
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = capStrings(nested);
    }
    return out;
  }
  return value;
};

/**
 * A one-line rendering of a gated call's arguments for a terminal prompt,
 * or undefined when there are none. Bounded — an approver reads it inline,
 * not a scrollback of JSON — and never a decision input: what this returns
 * is shown to a human, never matched against a scope. Long values are
 * capped individually (see `capStrings`) so no single field can hide the
 * rest; the overall cap is only a backstop for an object with many fields.
 *
 * When even the per-field-capped rendering overflows, the cut is **not
 * silent**: it ends with an explicit marker, so an approver is never shown
 * a partial argument set that reads as complete — a field trimmed off the
 * tail (a schedule's `destination`, say) must announce itself as hidden,
 * the same warning the Slack prompt already renders. An honest prompt is
 * the security property here; the realistic few-field call never truncates.
 */
const summarizeInput = (input: JsonObject): string | undefined => {
  if (Object.keys(input).length === 0) {
    return undefined;
  }
  const oneLine = JSON.stringify(capStrings(input));
  return oneLine.length > PROMPT_OVERALL_LIMIT
    ? `${oneLine.slice(0, PROMPT_OVERALL_LIMIT)}… [arguments truncated — inspect the call before approving]`
    : oneLine;
};

/**
 * Puts the question to someone at a terminal. A prompt's answer is free
 * text from a person mid-typing, so it is read leniently and anything that
 * is not recognisably a yes is a no.
 */
export const awaitPrompt = async (
  context: ApprovalContext,
  ask: NonNullable<PermissionPolicyOptions['ask']>,
  command: string | undefined,
  origin: string | undefined,
  /**
   * What answering "always" will actually do, decided by the caller — which
   * is the only place that knows. Offering a lifetime the engine will not
   * create is the same defect as hiding one it will.
   */
  alwaysMeans: string,
  /** Why the review posture is asking, shown above the question. */
  note?: string,
): Promise<ApprovalOutcome | typeof ABORTED> => {
  const { call, risk, session } = context;
  // The command, when there is one: for a shell call the tool name is the
  // least interesting half of the question, and an approver shown only
  // `shell.run (gated)` is being asked to trust something they cannot see.
  // The same is true of any gated call that carries arguments — approving
  // `schedule.every` sets up recurring unattended work and (with a
  // destination) a standing permission to speak, so the operator must see
  // the cadence, prompt, and destination, not just the tool name. When
  // there is no command scope to show, fall back to a compact rendering of
  // the call's input, exactly as the remote (Slack) prompt already does.
  const argumentSummary = command === undefined ? summarizeInput(call.input) : undefined;
  // The origin goes in front of the arguments rather than into them: a
  // selector says nothing about where a click lands, and this is the half
  // of the question "always" widens.
  const acting = origin === undefined ? call.toolName : `${call.toolName} on ${origin}`;
  const what = command !== undefined
    ? `${call.toolName}: ${command}`
    : argumentSummary !== undefined
      ? `${acting} (${risk}): ${argumentSummary}`
      : `${acting} (${risk})`;
  const pending = ask(
    `${note === undefined ? '' : `Review: ${note}\n`}Allow ${what} for ${session.agent.name}? [y]es / [a]lways (${alwaysMeans}) / [N]o: `,
  );
  // The answer is never read after this point if the turn ends first,
  // so a late yes cannot execute a tool for work that no longer exists.
  pending.catch(() => undefined);

  const response = await untilAborted(pending, context.signal);
  if (response === ABORTED) {
    return ABORTED;
  }

  const answer = response.trim().toLowerCase();
  if (!YES.has(answer)) {
    return { answer: 'deny' };
  }
  return { answer: ALWAYS.has(answer) ? 'always' : 'once' };
};

/**
 * Puts the question to someone reachable through a channel. Unlike the
 * prompt, the answer arrives already typed — a button carries one of three
 * values — so there is nothing to interpret; the work is entirely in not
 * outliving the turn.
 *
 * A transport that rejects (its channel is down, the request could not be
 * delivered) denies rather than failing the turn: the agent should be told
 * its call was not approved and carry on, not crash on the machinery that
 * was supposed to ask.
 */
export const awaitRemote = async (
  context: ApprovalContext,
  request: ApprovalRequester,
  origin: string | undefined,
  oneShot: boolean,
  always: AlwaysMeans | undefined,
  note?: string,
): Promise<ApprovalOutcome | typeof ABORTED> => {
  const pending = request({
    session: context.session,
    call: context.call,
    tool: context.tool,
    risk: context.risk,
    ...(origin !== undefined ? { origin } : {}),
    ...(oneShot ? { oneShot } : {}),
    ...(always !== undefined ? { always } : {}),
    ...(context.parkedAt ? { parkedAt: context.parkedAt } : {}),
    ...(note !== undefined ? { reviewNote: note } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }).then(
    (outcome): ApprovalOutcome => (typeof outcome === 'string' ? { answer: outcome } : outcome),
    (): ApprovalOutcome => ({ answer: 'deny' }),
  );

  return untilAborted(pending, context.signal);
};
