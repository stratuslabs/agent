/**
 * A reply as a few short messages, the way a person texts (card 951).
 *
 * The `texts` reply mode posts each paragraph of a finished reply as a
 * message of its own instead of one block of paragraphs. This file decides
 * only where those cuts go; sizing each piece to Slack's limit and
 * converting it to mrkdwn stay with the send path (`messageChunks`).
 *
 * It reads the Markdown the model wrote, before conversion, so a heading
 * and a list item still look like what they are. Code is found with the
 * same scanner the conversion uses (`codeRunsOf`), so a blank line inside
 * a fence, or inside a span Slack would pair across paragraphs, is never a
 * cut: converting each piece on its own then gives the text converting the
 * whole would have, since nothing else in the conversion crosses a line.
 */

import { codeRunsOf } from './mrkdwn.ts';

/**
 * The most messages one reply becomes. A reply longer than that is a
 * document rather than a few texts, and a dozen posts in a row would buzz
 * a phone a dozen times and run into Slack's posting rate. The paragraphs
 * past the limit stay together in the last message.
 */
export const TEXTS_MAX_MESSAGES = 5;

/**
 * One or more blank lines (whitespace-only counts), with the line break
 * before them. A `\r` is whitespace here, so a reply with Windows line
 * endings splits where its blank lines are rather than not at all.
 */
const BLANK_LINES = /\n[ \t\r]*\n(?:[ \t\r]*\n)*/g;
/** A Markdown heading line. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A list item: a bullet or a number, then air. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/;
/** A block indented under the one above it: a list item's continuation, or indented code. */
const INDENTED = /^(?: {2,}|\t)/;

const isList = (block: string): boolean => block.split('\n').some((line) => LIST_ITEM.test(line));

/**
 * Whether `block` belongs in the same message as `previous`, the block
 * just before it. Each rule keeps together what reads wrong apart.
 */
const continues = (previous: string, block: string): boolean =>
  // A heading on its own line leads the paragraph under it.
  (HEADING.test(previous) && !previous.includes('\n'))
  // "Here is what changed:" leads what it introduces; a closing `:tada:`
  // introduces nothing.
  || (/:[ \t]*$/.test(previous) && !/:[\w+-]+:[ \t]*$/.test(previous))
  // A loose list, its items apart by blank lines, is still one list.
  || (LIST_ITEM.test(block) && isList(previous))
  // An indented block hangs off the one above it.
  || INDENTED.test(block);

/**
 * `text` as the messages it is sent as in `texts` mode, in order: cut at
 * blank lines outside code, the pieces that belong together rejoined, at
 * most `TEXTS_MAX_MESSAGES` of them. Text with nothing in it comes back
 * as it is, for the caller's ordinary handling of an empty reply.
 */
export const textingParts = (text: string): string[] => {
  const code = codeRunsOf(text);
  const blocks: string[] = [];
  let start = 0;
  for (const gap of text.matchAll(BLANK_LINES)) {
    const from = gap.index;
    const to = from + gap[0].length;
    if (code.some((run) => run.start < to && from < run.end)) {
      continue;
    }
    blocks.push(text.slice(start, from));
    start = to;
  }
  blocks.push(text.slice(start));

  const groups: string[][] = [];
  for (const raw of blocks) {
    const block = raw.trimEnd();
    if (block.trim().length === 0) {
      continue;
    }
    const last = groups.at(-1);
    const previous = last?.at(-1);
    if (last !== undefined && previous !== undefined && continues(previous, block)) {
      last.push(block);
    } else {
      groups.push([block]);
    }
  }
  if (groups.length === 0) {
    return [text];
  }
  if (groups.length > TEXTS_MAX_MESSAGES) {
    groups.splice(TEXTS_MAX_MESSAGES - 1, groups.length, groups.slice(TEXTS_MAX_MESSAGES - 1).flat());
  }
  return groups.map((group) => group.join('\n\n'));
};
