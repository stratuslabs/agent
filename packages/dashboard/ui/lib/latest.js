/**
 * Latest-wins for refreshes that overlap.
 *
 * Two refreshes of the same state in flight at once settle in whatever
 * order the network chooses, and the one that started earlier can land
 * last — carrying what was true before the later one was even sent. The
 * dashboard lost an approval this way: `session.created` started a full
 * refresh, `tool.approval-requested` arrived a moment later and fetched the
 * approvals list (one entry), and then the first refresh's fetch — sent
 * before the call was parked — landed with an empty list and overwrote it.
 * The card never rendered and the counter said zero until someone clicked
 * Refresh.
 *
 * `begin()` hands out a ticket; `isCurrent(ticket)` is false once a newer
 * one has been issued, and a refresh whose ticket is stale discards what it
 * fetched instead of writing it.
 */
export const createLatest = () => {
  let issued = 0;
  return {
    begin: () => {
      issued += 1;
      return issued;
    },
    isCurrent: (ticket) => ticket === issued,
  };
};
