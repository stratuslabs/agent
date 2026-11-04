import type { Principal } from '../auth.ts';
import { API_PREFIX, ApiError, optionalString, readJsonObject, requireString } from '../http.ts';
import type { Route } from '../routes.ts';

/**
 * The actor recorded for an approval decided through the API: how the caller
 * authenticated, with the label it offered after a colon — `api` for a bearer
 * token, `dashboard` for a browser session. Never a bare string the caller
 * chose: channel-native ids are recorded bare, and the two must not be
 * spellable as each other.
 */
const apiActorFor = (principal: Principal | undefined, label: string | undefined): string => {
  const source = principal?.kind === 'cookie' ? 'dashboard' : 'api';
  return label ? `${source}:${label}` : source;
};

export const approvalRoutes: Route[] = [
  // ---- approvals -----------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/approvals`,
    async handler(context) {
      return { approvals: context.gateway.pendingApprovals() };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/approvals`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const requestId = requireString(body, 'requestId');
      const answer = requireString(body, 'answer');
      if (answer !== 'once' && answer !== 'always' && answer !== 'deny') {
        throw new ApiError(400, 'invalid_answer', 'answer must be one of: once, always, deny.');
      }
      // Who decided is qualified by how the caller authenticated, never
      // taken from the body as-is. A Slack click records the clicker's user
      // id, the edited Slack message renders that id as a mention, and a
      // standing grant carries it as `grantedBy` — so a body-supplied
      // `actor` that reached the record unqualified could spell a Slack
      // approver's id and read, everywhere the record is shown, as a
      // decision that approver never made. The caller's own label survives
      // as a suffix, which is all it was ever good for.
      const actor = apiActorFor(context.principal, optionalString(body, 'actor'));
      const settled = context.gateway.resolveApproval({ requestId, answer, actor });
      if (!settled) {
        // The normal outcome of a button clicked a minute too late. Never a
        // "try again": the request is gone because it was already decided,
        // expired, or belonged to a cancelled turn.
        throw new ApiError(
          409,
          'approval_not_pending',
          'That request is no longer pending — it was already decided, it expired, or its turn was cancelled.',
        );
      }
      return { ok: true };
    },
  },
];
