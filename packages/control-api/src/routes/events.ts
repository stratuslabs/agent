import { API_PREFIX, ApiError } from '../http.ts';
import type { Route } from '../routes.ts';

/** Most delivery rows one `GET /events/deliveries` returns; 100 when `limit` is absent. */
const MAX_EVENT_DELIVERIES_LISTED = 1_000;

export const eventRoutes: Route[] = [
  // ---- events (card 590) ---------------------------------------------------
  // Read-only views of the events port's work, for `stratus events` and a
  // dashboard. Under the operator's token like every route here: a delivery
  // row names who sent what (never the body). The delivery path itself is
  // the separate listener, which has no route here.
  {
    method: 'GET',
    pattern: `${API_PREFIX}/events/sources`,
    async handler(context) {
      return context.gateway.eventSummary();
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/events/deliveries`,
    async handler(context) {
      const source = context.url.searchParams.get('source') ?? undefined;
      const raw = context.url.searchParams.get('limit');
      if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_EVENT_DELIVERIES_LISTED)) {
        throw new ApiError(400, 'invalid_limit', `limit must be a whole number from 1 to ${MAX_EVENT_DELIVERIES_LISTED}.`);
      }
      return {
        deliveries: context.gateway.eventDeliveries({
          ...(source !== undefined ? { source } : {}),
          ...(raw !== null ? { limit: Number(raw) } : {}),
        }),
      };
    },
  },
];
