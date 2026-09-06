import { createInterface } from 'node:readline';
import {
  AllowAllApprovalPolicy,
  originOf,
  type ApprovalContext,
  type ApprovalPolicy,
} from '@stratusagent/core';
import type { CliStreams, CliEnvironment } from './environment.ts';
import { writeLine } from './io.ts';
import type { CliApprovalMode } from './parse.ts';

/**
 * Where a call would act, for a tool that answers that — read through
 * `originOf` so this and the daemon's engine compare the same thing.
 */
const approvalOrigin = (context: ApprovalContext): string | undefined => {
  const reported = context.tool.originFor?.(context.session);
  return reported === undefined ? undefined : originOf(reported);
};

/**
 * What a local prompt asks about: the tool, where it would act when that is
 * a question at all, and the arguments.
 *
 * The origin is not in the arguments and cannot be — a `browser.act` call
 * carries a CSS selector, and `#submit` is equally "load more results" and
 * "confirm purchase". A prompt that showed only the selector would be
 * asking someone to authorize an effect whose location it withheld, which
 * is the same reason the daemon's prompt and the Slack request name it.
 */
export const describeApprovalCall = (context: ApprovalContext): string => {
  const origin = approvalOrigin(context);
  return `${context.call.toolName}${origin ? ` on ${origin}` : ''}`
    + ` with input ${JSON.stringify(context.call.input)}`;
};

/**
 * Whether the conversation is still on the page the prompt named.
 *
 * A y/N at a terminal takes as long as it takes, and the page is live for
 * all of it: a redirect between the question and the answer would have a
 * yes given for one site click on another, with the prompt still showing
 * the first. So the origin is read again and a page that moved refuses —
 * the same check the daemon's engine makes after its own approval wait.
 * This local policy needs its own because it is a separate policy sharing
 * none of that code: `--approvals ask` judges the call, not a scope.
 *
 * Said out loud rather than failing quietly: somebody typed `y` and is owed
 * an explanation for why nothing happened.
 */
const stillOnApprovedPage = (
  context: ApprovalContext,
  approved: string | undefined,
  streams: CliStreams,
): boolean => {
  if (context.tool.originFor === undefined) {
    return true;
  }
  const now = approvalOrigin(context);
  if (now === approved) {
    return true;
  }
  writeLine(
    streams.stderr,
    `Not running ${context.call.toolName}: it was approved on ${approved ?? 'a page with no origin'}, `
    + `and the conversation ${now === undefined ? 'no longer has that page open' : `is on ${now} now`}.`,
  );
  return false;
};

export const createApprovalPolicy = (
  mode: CliApprovalMode,
  streams: CliStreams,
  env: CliEnvironment,
  ask?: (prompt: string) => Promise<string>,
): ApprovalPolicy => {
  if (mode === 'always') {
    return new AllowAllApprovalPolicy();
  }

  if (mode === 'never') {
    return {
      async approve() {
        return false;
      },
    };
  }

  // A caller that already owns stdin (chat's readline) supplies its own
  // asker — two readers on one stream would race for the same bytes.
  if (ask) {
    return {
      async approve(context) {
        const approved = approvalOrigin(context);
        const answer = await ask(`Approve tool call ${describeApprovalCall(context)}? [y/N] `);
        return /^y(es)?$/i.test(answer.trim()) && stillOnApprovedPage(context, approved, streams);
      },
    };
  }

  return {
    async approve(context) {
      const input = env.approvalInput ?? process.stdin;
      const readline = createInterface({ input, terminal: false });
      const approved = approvalOrigin(context);

      // Prompt on stderr so stdout stays parseable (e.g. --format json).
      streams.stderr.write(`Approve tool call ${describeApprovalCall(context)}? [y/N] `);

      try {
        const answer = await new Promise<string>((resolve) => {
          readline.once('line', resolve);
          readline.once('close', () => resolve(''));
        });
        writeLine(streams.stderr);
        return /^y(es)?$/i.test(answer.trim()) && stillOnApprovedPage(context, approved, streams);
      } finally {
        readline.close();
      }
    },
  };
};
