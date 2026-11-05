/*
 * What a person can answer to a gated call and what an approval request
 * carries: `ApprovalAnswer`, `AlwaysMeans`, `ApprovalOutcome`, the
 * delegation origin and schedule destination a request names, and
 * `ApprovalResolutionReason`. Approval events in `events.ts` and every
 * channel's approval prompt build on these. `index.ts` re-exports every
 * name, so the package's one public entry is unchanged.
 */
import type { JsonObject } from './index.ts';

/**
 * What a human decided about one gated call.
 *
 * - `once` — run this call, ask again next time.
 * - `always` — run it, and stop asking this agent's future calls that
 *   the answer covers. What it covers is the policy's to say, in advance,
 *   through `AlwaysMeans`.
 * - `deny` — refuse it.
 */
export type ApprovalAnswer = 'once' | 'always' | 'deny';

/**
 * What answering `always` to one request would remember, said before
 * anyone is asked so every surface can word the button honestly.
 *
 * - `scope` — the command's normalized scope, durable and per agent
 *   (`Tool.commandFor`).
 * - `origin` — the site the conversation is on, durable and per agent
 *   (`Tool.originFor`).
 * - `tool` — the tool itself, durable and per agent, until an operator
 *   revokes it: the standing grant, for a gated tool that names no scope.
 * - `destination` — this tool on this one conversation (`Tool.destinationFor`),
 *   durable and per agent, until revoked. Never the tool on every
 *   conversation: that would be a standing yes to every channel the app
 *   is in.
 * - `session` — the tool, for this session and this process only. What a
 *   call judged by destination gets when its input names no destination.
 *
 * Absent when `always` remembers nothing at all — the one-shot case,
 * which `oneShot` names.
 */
export type AlwaysMeans = 'scope' | 'origin' | 'tool' | 'destination' | 'session';

/**
 * A human's answer, and who gave it when a channel can say. What a
 * transport settles a request with: the policy records the actor on a
 * standing grant, and nothing else about the decision needs a person's
 * id — which is why the plain answer is still accepted everywhere an
 * outcome is.
 */
export interface ApprovalOutcome {
  answer: ApprovalAnswer;
  /** Channel-native id (a Slack user). */
  actor?: string;
}

/**
 * Why an approval request stopped being pending. Only `decided` involved a
 * person; the rest are the request running out of patience, the turn it
 * belonged to disappearing, or nobody ever being asked at all.
 *
 * The distinction is not cosmetic. `decided` is what an audit record means
 * by "somebody refused this", and folding an undelivered request into it
 * would put a denial nobody made on the same footing as one somebody did.
 */
/**
 * The conversation a delegated call's work was asked from — see
 * `tool.approval-requested`'s `delegatedFrom`.
 */
export interface ApprovalDelegationOrigin {
  /** The agent whose session is at the root of the delegation chain. */
  agentId: string;
  sessionId: string;
  /** That session's metadata: where the person who asked is. */
  metadata?: JsonObject;
}

/** A schedule's approved destination, as an approval request carries it. */
export interface ApprovalScheduleDestination {
  /** Channel kind, e.g. 'slack': only that channel may ask there. */
  channel: string;
  /** Channel-native conversation id. */
  to: string;
  /** The thread the schedule reports under, when it was set to one. */
  thread?: string;
}

export type ApprovalResolutionReason = 'decided' | 'timeout' | 'cancelled' | 'undeliverable';
