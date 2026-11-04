import { describeSchedule } from '@stratusagent/agents';

import { API_PREFIX, ApiError } from '../http.ts';
import type { Route } from '../routes.ts';

export const scheduleRoutes: Route[] = [
  // ---- schedules -----------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/schedules`,
    async handler(context) {
      // The whole fleet's, not one agent's: this is the audit list — an
      // agent that scheduled something an operator cannot see is a bug —
      // and each row with a destination is also a standing permission to
      // speak, which is exactly what an operator reviews.
      return { schedules: context.gateway.schedules().map((record) => describeSchedule(record)) };
    },
  },
  {
    method: 'DELETE',
    pattern: `${API_PREFIX}/schedules/:id`,
    async handler(context) {
      const cancelled = context.gateway.cancelSchedule(context.params.id ?? '');
      if (!cancelled) {
        throw new ApiError(404, 'schedule_not_found', `No schedule with id ${context.params.id}.`);
      }
      // Cancelling also revoked the destination grant riding on the row —
      // the next send from a still-running firing is gated normally.
      return { cancelled: true };
    },
  },
];
