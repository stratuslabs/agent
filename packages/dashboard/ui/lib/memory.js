// How a remembered fact reads on the agent's Settings tab. Pure, so the
// rules are testable without a page.

/**
 * Whether a fact matches what someone typed in the filter: every word,
 * anywhere in its text, its topics or its kind, case-insensitively. An empty
 * filter matches everything.
 */
export const memoryMatches = (entry, query) => {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = [entry.content, ...(entry.about ?? []), entry.kind ?? ''].join('\n').toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/**
 * The badges beside a fact, in the order they matter to someone deciding
 * whether to keep it: pinned, not true now, and whose words it may repeat.
 * `user` and `agent` facts carry no source badge; those are the operator's
 * own words and the agent's.
 */
export const memoryMarks = (entry) => [
  ...(entry.pinned ? [{ label: 'Pinned', tone: 'accent', why: 'Always in the prompt, whatever the conversation is about.' }] : []),
  ...(entry.validity === 'expired' ? [{ label: 'Expired', tone: '', why: 'Its validUntil has passed, so it is no longer treated as true now.' }] : []),
  ...(entry.validity === 'not-yet-valid' ? [{ label: 'Not true yet', tone: '', why: 'Its validFrom is still ahead.' }] : []),
  ...(entry.trust === 'external' ? [{ label: 'From outside content', tone: 'warn', why: 'Recorded after reading something from outside (a web page, a fetched document), so it may repeat what a stranger wrote.' }] : []),
  ...(entry.trust === 'unknown' ? [{ label: 'Unknown source', tone: 'warn', why: 'Recorded after a message from someone not configured as a principal, or with no origin recorded.' }] : []),
];
