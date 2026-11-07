/*
 * What of a tool's post (`postOf` in core, AGT-324) may reach a Slack
 * thread: the blocks a post carries, checked and rewritten before they are
 * sent, and the mention markup taken out of its words. In a module of its
 * own because it is the one place that decides it, and so its tests can
 * name it. Nothing here is public: `reply.ts` and `index.ts` import it, and
 * the package's one public entry is unchanged.
 */
import type { JsonObject, JsonValue } from '@stratusagent/core';

import type { SlackBlock } from './index.ts';

/** The prefix every button in a post is renamed to; a click on one is acked and nothing else. */
export const POST_ACTION_PREFIX = 'stratus.post.';

/** Slack's own limit on blocks in one message. */
const MAX_POST_BLOCKS = 50;

/** Deeper than any card Slack renders; past it the blocks are refused rather than walked. */
const MAX_POST_DEPTH = 12;

/**
 * The block types a post may carry: what a card shows, and nothing a person
 * fills in. These are what `@chat-adapter/slack`'s `cardToBlockKit` makes
 * of a json-render card (header, context, section fields, divider, image,
 * Slack's `table` and `data_table`, `data_visualization`, and actions).
 * `rich_text` is left out on purpose: its elements carry structured user,
 * group and broadcast mentions that no text rewrite reaches.
 */
const POST_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'header', 'section', 'context', 'divider', 'image', 'table', 'data_table', 'data_visualization', 'actions',
]);

/**
 * Every other `type` a post's blocks may hold at any depth: text objects,
 * table cells, an image element, a link button, and a chart's kind.
 * Anything else — an input, a select, a date picker, a type Slack adds
 * next year — and the post goes out as its text alone.
 */
const POST_INNER_TYPES: ReadonlySet<string> = new Set([
  'plain_text', 'mrkdwn', 'raw_text', 'image', 'button', 'pie', 'bar', 'line', 'area',
]);

/**
 * Slack's markup for a mention (`<@U…>`, `<@U…|name>`) or a broadcast or
 * group ping (`<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^S…>`),
 * shown as the text it is. A post can repeat what a tool read, and a card
 * of issue titles is not a reason to page a channel or a person. The
 * reply is where an agent mentions someone. Channel links (`<#C…>`) and
 * URLs (`<https://…|label>`) notify nobody and are left alone.
 */
export const neutralizeMentions = (text: string): string => text.replace(/<([@!][^<>]*)>/g, '&lt;$1&gt;');

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isWebUrl = (value: JsonValue | undefined): boolean => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);

/**
 * A post's blocks as they may be sent, or what made them unsendable. A
 * copy: the result they came from is the session's, stored and replayed,
 * and is never touched.
 *
 * Buttons must be links. Each one's `action_id` becomes
 * `stratus.post.<n>` and its `value` is dropped, so nothing in a post can
 * wear an approval's or a credential form's id: a click on it is a link
 * opening, which Slack also reports to the app, and the adapter acks it and
 * does nothing else. Every `mrkdwn` text has its mention markup shown as
 * text (`neutralizeMentions`). An image must be a web URL, not a
 * `slack_file`, which could show a file from somewhere else in the
 * workspace to everyone in this thread.
 *
 * The reason given names a type, never content, since it is logged.
 */
export const sanitizePostBlocks = (blocks: readonly JsonValue[]): { blocks: SlackBlock[] } | { refused: string } => {
  if (blocks.length === 0 || blocks.length > MAX_POST_BLOCKS) {
    return { refused: `${blocks.length} blocks (Slack takes 1 to ${MAX_POST_BLOCKS})` };
  }
  let buttons = 0;
  let refused: string | undefined;
  const clean = (value: JsonValue, depth: number, allowed: ReadonlySet<string>): JsonValue => {
    if (refused !== undefined) {
      return null;
    }
    if (depth > MAX_POST_DEPTH) {
      refused = 'blocks nested too deep';
      return null;
    }
    if (Array.isArray(value)) {
      return value.map((item) => clean(item, depth + 1, POST_INNER_TYPES));
    }
    if (!isObject(value)) {
      return value;
    }
    const type = value.type;
    if (type !== undefined && (typeof type !== 'string' || !allowed.has(type))) {
      refused = `a ${typeof type === 'string' ? `\`${type.slice(0, 40)}\`` : 'non-text'} type`;
      return null;
    }
    if ('slack_file' in value) {
      refused = 'a `slack_file` image';
      return null;
    }
    if (type === 'image' && !isWebUrl(value.image_url)) {
      refused = 'an image with no web URL';
      return null;
    }
    if (type === 'button' && !isWebUrl(value.url)) {
      refused = 'a button that is not a link';
      return null;
    }
    if (type !== 'button' && 'action_id' in value) {
      refused = 'an `action_id` outside a button';
      return null;
    }
    const copy: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (type === 'button' && (key === 'action_id' || key === 'value')) {
        continue;
      }
      copy[key] = type === 'mrkdwn' && key === 'text' && typeof item === 'string'
        ? neutralizeMentions(item)
        : clean(item, depth + 1, POST_INNER_TYPES);
    }
    if (type === 'button') {
      buttons += 1;
      copy.action_id = `${POST_ACTION_PREFIX}${buttons}`;
    }
    return copy;
  };
  const cleaned = blocks.map((block) => {
    if (!isObject(block) || typeof block.type !== 'string') {
      refused ??= 'a block with no type';
      return null;
    }
    return clean(block, 0, POST_BLOCK_TYPES);
  });
  return refused !== undefined ? { refused } : { blocks: cleaned as SlackBlock[] };
};
