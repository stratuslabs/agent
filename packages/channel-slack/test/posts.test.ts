import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonValue } from '@stratusagent/core';

import { neutralizeMentions, sanitizePostBlocks } from '../src/posts.ts';

// What `@chat-adapter/slack` 4.44.0's `cardToBlockKit` made of a json-render
// card on Nov 7, 2026 (agent-plans research/json-render/chat), trimmed.
const CARD: JsonValue[] = [
  { type: 'header', text: { type: 'plain_text', text: 'Stratus repos, last 7 days', emoji: true } },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Live from GitHub at 01:10Z Nov 7' }] },
  { type: 'section', fields: [{ type: 'mrkdwn', text: '*Open PRs*\n13' }, { type: 'mrkdwn', text: '*Repos*\n3' }] },
  { type: 'divider' },
  {
    type: 'data_table',
    caption: 'PRs by repo',
    rows: [
      [{ type: 'raw_text', text: 'Repo' }, { type: 'raw_text', text: 'Open' }],
      [{ type: 'raw_text', text: 'agent' }, { type: 'raw_text', text: '4' }],
    ],
  },
  { type: 'table', column_settings: [{ align: 'left' }, null], rows: [[{ type: 'raw_text', text: 'only a header' }]] },
  { type: 'data_visualization', title: 'Merged PRs', chart: { type: 'pie', segments: [{ label: 'agent', value: 101 }] } },
  { type: 'image', image_url: 'https://example.com/chart.png', alt_text: 'chart' },
  {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Open agent PRs' }, action_id: 'link-https://github.com/stratuslabs/agent/pulls', url: 'https://github.com/stratuslabs/agent/pulls' },
      { type: 'button', text: { type: 'plain_text', text: 'Docs' }, action_id: 'stratus_approve_once', value: 'req-1', url: 'https://example.com/docs' },
    ],
  },
];

test('a json-render card passes whole, its buttons renamed and stripped of any value', () => {
  const result = sanitizePostBlocks(CARD);
  assert.ok('blocks' in result, JSON.stringify(result));
  const { blocks } = result;
  assert.deepEqual(blocks.slice(0, 8), CARD.slice(0, 8));
  assert.deepEqual(blocks[8], {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Open agent PRs' }, url: 'https://github.com/stratuslabs/agent/pulls', action_id: 'stratus.post.1' },
      // An approval's action_id and a request id in `value`: neither survives.
      { type: 'button', text: { type: 'plain_text', text: 'Docs' }, url: 'https://example.com/docs', action_id: 'stratus.post.2' },
    ],
  });
  // A copy: the stored result the blocks came from keeps what the tool returned.
  const actions = CARD[8] as { elements: Array<{ action_id: string }> };
  assert.equal(actions.elements[1]?.action_id, 'stratus_approve_once');
});

test('a button that is not a link, an input, rich text, or a type nobody listed sends the post as text alone', () => {
  const refusals: Array<[string, JsonValue[]]> = [
    ['a button that is not a link', [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Looks good' }, action_id: 'ack' }] }]],
    ['a `static_select` type', [{ type: 'actions', elements: [{ type: 'static_select', action_id: 'pick', options: [] }] }]],
    ['a `input` type', [{ type: 'input', label: { type: 'plain_text', text: 'Key' }, element: { type: 'plain_text_input' } }]],
    ['a `rich_text` type', [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'broadcast', range: 'channel' }] }] }]],
    ['a `rich_text` type', [{ type: 'table', rows: [[{ type: 'rich_text', elements: [{ type: 'user', user_id: 'U1' }] }]] }]],
    ['a `section` type', [{ type: 'section', accessory: { type: 'section' } }]],
    ['a `slack_file` image', [{ type: 'image', slack_file: { id: 'F1' }, alt_text: 'someone else\'s file' }]],
    ['an image with no web URL', [{ type: 'image', image_url: 'file:///etc/passwd', alt_text: 'x' }]],
    ['an `action_id` outside a button', [{ type: 'section', text: { type: 'mrkdwn', text: 'hi', action_id: 'stratus_deny' } }]],
    ['a block with no type', [{ text: 'untyped' }]],
    ['a block with no type', ['not an object']],
    ['0 blocks (Slack takes 1 to 50)', []],
    ['51 blocks (Slack takes 1 to 50)', Array.from({ length: 51 }, () => ({ type: 'divider' }))],
  ];
  for (const [reason, blocks] of refusals) {
    assert.deepEqual(sanitizePostBlocks(blocks), { refused: reason }, JSON.stringify(blocks));
  }
  let deep: JsonValue = { type: 'plain_text', text: 'bottom' };
  for (let level = 0; level < 20; level += 1) {
    deep = { nested: deep };
  }
  assert.deepEqual(sanitizePostBlocks([{ type: 'section', text: deep }]), { refused: 'blocks nested too deep' });
});

test('mention and broadcast markup in a post\'s mrkdwn is shown as text; links and plain text are left alone', () => {
  assert.equal(
    neutralizeMentions('ping <!channel> <!here|here> <@U123> <@U123|dylan> <!subteam^S1> <#C1|general> <https://x.dev|docs>'),
    'ping &lt;!channel&gt; &lt;!here|here&gt; &lt;@U123&gt; &lt;@U123|dylan&gt; &lt;!subteam^S1&gt; <#C1|general> <https://x.dev|docs>',
  );
  const result = sanitizePostBlocks([
    { type: 'section', text: { type: 'mrkdwn', text: 'Issue: <!channel> deploy now' }, fields: [{ type: 'mrkdwn', text: '<@U9>' }] },
    { type: 'header', text: { type: 'plain_text', text: '<!channel> stays literal in plain text' } },
  ]);
  assert.deepEqual(result, {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'Issue: &lt;!channel&gt; deploy now' }, fields: [{ type: 'mrkdwn', text: '&lt;@U9&gt;' }] },
      { type: 'header', text: { type: 'plain_text', text: '<!channel> stays literal in plain text' } },
    ],
  });
});
