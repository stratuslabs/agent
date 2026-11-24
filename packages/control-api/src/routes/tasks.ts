import { API_PREFIX, ApiError } from '../http.ts';
import type { Route } from '../routes.ts';

/**
 * Background tasks (AGT-211): the operator's list and cancel, which
 * `stratus tasks` and the dashboard read. Status only: ids, who, where and
 * how each stands, never a prompt or a result, the way the session list
 * carries no transcript.
 */
export const taskRoutes: Route[] = [
  // ---- tasks ---------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/tasks`,
    async handler(context) {
      const agent = context.url.searchParams.get('agent') ?? undefined;
      return { tasks: await context.gateway.tasks(agent) };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/tasks/:id/cancel`,
    async handler(context) {
      const taskId = context.params.id ?? '';
      // Who the notice in the task's conversation names. Both are the
      // operator's own authority, so neither is gated; a browser session is
      // the dashboard, and a bearer token is the CLI or a script holding
      // the same token.
      const stoppedBy = context.principal?.kind === 'cookie' ? 'dashboard' : 'cli';
      const result = await context.gateway.cancelTask(taskId, stoppedBy);
      switch (result.kind) {
        case 'missing':
          throw new ApiError(404, 'task_not_found', `No task with id ${taskId}. \`stratus tasks\` lists them.`);
        case 'finished':
          // Not an error: the task isn't running, which is what was asked
          // for. Nothing was written, and its result still arrives.
          return { task: taskId, stopped: false, status: result.status };
        case 'stopping':
          return {
            task: taskId,
            stopped: true,
            ...(result.already === true ? { already: true, stoppedBy: result.task.stoppedBy } : {}),
          };
      }
    },
  },
];
