/**
 * What **Always allow** would actually do, said beside the button.
 *
 * The lifetime is the half of the question that button widens, and it
 * differs by tool: a standing grant to the agent outlives every session and
 * every restart, while a send outside a schedule lasts only this
 * conversation. An operator cannot tell those apart from a button reading
 * "Always allow" — which is the whole defect standing grants exist to close, so
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
      return `Always allow lets ${agentName} use this tool without asking, until you revoke it in Permissions.`;
    case 'destination':
      return `Always allow lets ${agentName} use this tool on this conversation without asking, until you revoke it in Permissions.`;
    case 'session':
      return 'Always allow stops this tool asking again for the rest of this session.';
    case 'scope':
      return `Always allow lets ${agentName} run commands in this command's scope without asking, until you revoke it in Permissions.`;
    case 'origin':
      return `Always allow lets ${agentName} use this site without asking, until you revoke it in Permissions.`;
    default:
      // A request from a daemon that does not label its approvals — an older
      // one across an upgrade. Saying nothing beats guessing at a lifetime.
      return undefined;
  }
};
