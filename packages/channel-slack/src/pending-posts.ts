/*
 * The approval and credential prompts the adapter has posted and still
 * holds, as `approvalPosts` and `credentialPosts` keep them in memory. In a
 * module of their own so the adapter's parts outside `index.ts` can name
 * them. Nothing here is public: `index.ts` imports them, and the package's
 * one public entry is unchanged.
 */

import type { AlwaysMeans, CredentialScope } from '@stratusagent/core';
import type { AgentConnection } from './connection.ts';

export interface PendingCredentialPost {
  connection: AgentConnection;
  channel: string;
  /** The thread the request was posted in, for a late answer's notice. */
  thread?: string;
  ts: string;
  agentId: string;
  agentName: string;
  name: string;
  scope: CredentialScope;
  /** A new value for a key the agent holds, rather than an add. */
  replace?: boolean;
  /** The variable the agent's shell will read it from, which the form says. */
  env?: string;
  /** Bound at render time, as an approval request's are. */
  approvers: Set<string>;
}

export interface PendingApprovalPost {
  connection: AgentConnection;
  channel: string;
  ts: string;
  thread?: string;
  agentName: string;
  toolName: string;
  risk: string;
  /**
   * Whether `always` on this request would have remembered anything —
   * carried from the request rather than re-derived, because the outcome
   * has to describe the answer that was actually possible. `POST
   * /approvals` still accepts all three answers, so another client can
   * submit `always` for a request this channel never offered it on.
   */
  oneShot: boolean;
  /** What `always` would grant, from the request, for the same reason. */
  always?: AlwaysMeans;
  /** The background task whose worker asked, kept so the settled line names it too. */
  taskId?: string;
  agentId: string;
  /** Bound at render time, so a later config change cannot widen a live request. */
  approvers: Set<string>;
}

/**
 * Whether `actor` may decide `post`. Bound when the prompt was posted, so a
 * later config change cannot widen a live request, and checked against the
 * app's approvers now as well, so someone removed while the daemon runs
 * (a reload, AGT-337) cannot decide a prompt posted while they were one.
 */
export const mayDecide = (
  post: { connection: AgentConnection; approvers: Set<string> },
  actor: string | undefined,
): actor is string =>
  actor !== undefined && post.approvers.has(actor) && (post.connection.config.approvers ?? []).includes(actor);
