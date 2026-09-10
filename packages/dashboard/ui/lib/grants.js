/**
 * What **Always allow** would actually do, said beside the button.
 *
 * The lifetime is the half of the question that button widens, and it
 * differs by tool: a standing grant to the agent outlives every session and
 * every restart, while a send outside a schedule lasts only this
 * conversation. An operator cannot tell those apart from a button reading
 * "Always allow" — which is the whole defect step 28 exists to close, so
 * leaving this surface silent would reintroduce it here.
 *
 * `always` rides in on the request (`GET /approvals` and
 * `tool.approval-requested`), so this never guesses: it is absent exactly
 * when the answer is remembered nowhere, and `oneShot` already covers that
 * case with its own line.
 */
export const alwaysOffer = (always, agentName) => {
  switch (always) {
    case 'tool':
      return `Always allow grants this tool to ${agentName} until an operator revokes it.`;
    case 'session':
      return 'Always allow stops this tool asking again for the rest of this session.';
    case 'scope':
      return "Always allow remembers this command's scope for this agent, until revoked.";
    case 'origin':
      return 'Always allow remembers this site for this agent, until revoked.';
    default:
      // A request from a daemon that does not label its approvals — an older
      // one across an upgrade. Saying nothing beats guessing at a lifetime.
      return undefined;
  }
};
