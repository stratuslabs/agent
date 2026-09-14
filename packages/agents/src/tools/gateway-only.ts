import { DELEGATE_TOOL_NAME } from './delegate.ts';
import { MESSAGE_SEND_TOOL_NAME } from './message.ts';
import {
  SCHEDULE_EVERY_TOOL_NAME,
  SCHEDULE_AT_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_CANCEL_TOOL_NAME,
} from './schedule.ts';

/**
 * The tools only a running gateway registers. Each needs the dispatcher,
 * the store, or the channels, and nothing else in the tree has them — so a
 * soul naming one is correct while a host without them cannot call it,
 * which is a different thing from a name that does not exist. `stratus
 * run` reads this to say which it is rather than reporting a daemon soul's
 * `schedule.*` as a typo.
 *
 * It lives here, with the names, rather than in `@stratusagent/gateway`
 * where the registrations are: the CLI imports the gateway only through
 * `await import`, because `bin.ts` has to load the CLI to print the Node
 * version message and the gateway pulls in `node:sqlite` at module scope.
 * A static import for a list of strings would have made the floor guard
 * fail with the exact builtin-module error it exists to replace. The
 * gateway's own test pins this set against what it actually registers,
 * which holds the two together better than proximity would.
 */
export const GATEWAY_ONLY_TOOL_NAMES: readonly string[] = [
  SCHEDULE_EVERY_TOOL_NAME,
  SCHEDULE_AT_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_CANCEL_TOOL_NAME,
  MESSAGE_SEND_TOOL_NAME,
  DELEGATE_TOOL_NAME,
];
