/**
 * One row of the Serving card from a `/health` runtime.
 *
 * When no agent's run can resolve a provider, `/health` lists a runtime
 * with `provider: 'none'` and a `problem` saying why and what to do. Shown
 * like any other runtime it read "none · credentials: none", which looks
 * like a setting rather than the reason every turn will fail. A runtime
 * with a problem shows the problem instead.
 */
export const servingRow = (runtime) => {
  if (typeof runtime.problem === 'string' && runtime.problem.length > 0) {
    return { title: 'No provider', detail: runtime.problem, problem: true };
  }
  return {
    title: runtime.model ? `${runtime.provider} · ${runtime.model}` : runtime.provider,
    detail: `credentials: ${runtime.credentials}`,
    problem: false,
  };
};
