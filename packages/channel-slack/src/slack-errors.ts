/*
 * Reading a failed Slack Web API call: its error code, or a sentence for
 * one that never reached Slack. In a module of its own so the adapter's
 * parts outside `index.ts` can share them. Nothing here is public:
 * `index.ts` imports them, and the package's one public entry is unchanged.
 */

/**
 * The error code of a failed Web API call (`missing_scope`, `ratelimited`),
 * which `@slack/web-api` puts on the error's `data.error`. Undefined for a
 * failure that never reached Slack.
 */
export const slackErrorCode = (error: unknown): string | undefined => {
  const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};

/** Slack's code for a failed call, or the SDK's message when Slack never answered. */
export const describeSlackError = (error: unknown): string => slackErrorCode(error) ?? (error instanceof Error ? error.message : String(error));
