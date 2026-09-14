import type { JsonObject, Session, Tool } from '@stratusagent/core';
import {
  type ScheduleDestination,
  canonicalDestination,
  parseDestinationInput,
  DESTINATION_PARAMETER,
} from '../schedules.ts';

export const MESSAGE_SEND_TOOL_NAME = 'message.send';

/**
 * Delivers one outbound message through the agent's channel. The gateway
 * implements it over the channel contract's `resolveOutbound`; rejecting is
 * the way to say a destination cannot be served.
 */
export type OutboundMessenger = (input: {
  agentId: string;
  destination: ScheduleDestination;
  text: string;
}) => Promise<void>;

/**
 * Post to a channel or DM outside the current conversation — what makes a
 * scheduled turn observable.
 *
 * `gated`, and deliberately not `safe` the way `agent.delegate` is: the
 * delegate stays inside the fleet, under every per-agent allowlist and the
 * same approval policy, while this speaks to people who did not ask. The
 * unattended path is the schedule carve-out — `destinationFor` names where
 * this call would speak, and the policy allows it exactly when the firing's
 * schedule was approved with that destination.
 */
export const createMessageSendTool = (send: OutboundMessenger): Tool => ({
  name: MESSAGE_SEND_TOOL_NAME,
  description: 'Send a message to a channel or DM you are not currently talking in. Scheduled turns may post to their schedule\'s approved destination without asking; anywhere else needs approval.',
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      destination: {
        ...DESTINATION_PARAMETER,
        description: 'Where to post: the channel kind plus the channel-native conversation id.',
      },
      text: { type: 'string', description: 'The message text.' },
    },
    required: ['destination', 'text'],
  },
  destinationFor(input: JsonObject) {
    const destination = parseDestinationInput(input.destination);
    return destination ? canonicalDestination(destination) : undefined;
  },
  async execute(input: JsonObject, session: Session) {
    const destination = parseDestinationInput(input.destination);
    if (!destination) {
      throw new Error('message.send requires "destination" as { channel, to } with non-empty strings.');
    }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) {
      throw new Error('message.send requires a non-empty "text".');
    }
    await send({ agentId: session.agent.id, destination, text });
    return { sent: true, destination: canonicalDestination(destination) };
  },
});
