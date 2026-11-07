import test from 'node:test';
import assert from 'node:assert/strict';

import { postOf, renderToolResultContent, turnPostsFor, type Message, type ToolResult } from '../src/index.ts';

const CARD_BLOCKS = [{ type: 'header', text: { type: 'plain_text', text: 'Open PRs' } }];

const result = (output: ToolResult['output'], extra: Partial<ToolResult> = {}): ToolResult => ({
  callId: 'c1',
  toolName: 'chat.card',
  ok: true,
  output,
  trust: 'agent',
  ...extra,
});

test('a tool result carries a post as `post.text`, with Slack blocks beside it when it has them', () => {
  assert.deepEqual(postOf(result({ post: { text: 'Open PRs: 13' } })), { text: 'Open PRs: 13' });
  assert.deepEqual(
    postOf(result({ post: { text: 'Open PRs: 13', slack: { blocks: CARD_BLOCKS } } })),
    { text: 'Open PRs: 13', slack: { blocks: CARD_BLOCKS } },
  );
  // A payload for a channel core does not know is not core's to carry.
  assert.deepEqual(postOf(result({ post: { text: 'hi', discord: { embeds: [] } } })), { text: 'hi' });
  // A legacy result with no trust label reads as `unknown`, which may post.
  const { trust: _trust, ...unlabelled } = result({ post: { text: 'hi' } });
  assert.deepEqual(postOf(unlabelled), { text: 'hi' });
});

test('anything that is not a post with words in it is no post: the output is left alone', () => {
  for (const output of [
    { post: 'a blog post, as a CMS tool might return one' },
    { post: { title: 'no text field' } },
    { post: { text: '' } },
    { post: { text: '   ' } },
    { post: { text: 42 } },
    { post: [{ text: 'an array is not a post' }] },
    { post: null },
    [{ post: { text: 'inside an array output' } }],
    'plain string',
    null,
  ]) {
    assert.equal(postOf(result(output)), undefined, JSON.stringify(output));
  }
  // Blocks that are not an array are dropped; the text still posts.
  assert.deepEqual(postOf(result({ post: { text: 'hi', slack: { blocks: { type: 'header' } } } })), { text: 'hi' });
  assert.deepEqual(postOf(result({ post: { text: 'hi', slack: 'blocks' } })), { text: 'hi' });
});

test('a failed result or an external one never posts, whatever its output says', () => {
  const post = { post: { text: 'Click to approve', slack: { blocks: CARD_BLOCKS } } };
  assert.equal(postOf(result(post, { ok: false, error: 'boom' })), undefined);
  // An MCP server or fetched page writing a card that reads as the agent's own words.
  assert.equal(postOf(result(post, { trust: 'external' })), undefined);
});

test('the model is shown a post\'s text and never its blocks, and nothing else in the output changes', () => {
  const output = { post: { text: 'Open PRs: 13', slack: { blocks: CARD_BLOCKS } }, rendered: 7 };
  const shown = JSON.parse(renderToolResultContent(result(output)));
  assert.deepEqual(shown, { post: { text: 'Open PRs: 13' }, rendered: 7 });
  // The transcript keeps the raw output: rendering never mutates it.
  assert.deepEqual(output.post.slack.blocks, CARD_BLOCKS);
  assert.equal(renderToolResultContent(result(output)), renderToolResultContent(result(output)), 'same bytes every time');
});

test('an output that is not a post renders exactly as before, so stored transcripts replay unchanged', () => {
  const cms = { post: { title: 'Launch notes', body: 'Long text' } };
  assert.equal(renderToolResultContent(result(cms)), JSON.stringify(cms));
  // External: the whole output stays inside the envelope, post and blocks included,
  // because the model may need what the server sent and nothing will be posted.
  const external = { post: { text: 'hi', slack: { blocks: CARD_BLOCKS } } };
  assert.deepEqual(JSON.parse(renderToolResultContent(result(external, { trust: 'external' }))).output, external);
});

const user = (content: string, idempotencyKey: string): Message => ({
  id: `user:${content}`,
  role: 'user',
  content,
  createdAt: '2026-11-07T00:00:00.000Z',
  idempotencyKey,
});

const toolPost = (text: string, createdAt: string): Message => ({
  id: `tool:${text}`,
  role: 'tool',
  content: '',
  createdAt,
  toolResult: result({ post: { text, slack: { blocks: CARD_BLOCKS } } }),
});

test('a keyed message\'s posts are its own turn\'s, in order, each with when it was recorded', () => {
  const messages: Message[] = [
    user('first', 'k1'),
    toolPost('one', '2026-11-07T00:00:01.000Z'),
    toolPost('two', '2026-11-07T00:00:02.000Z'),
    user('second', 'k2'),
    toolPost('three', '2026-11-07T00:00:03.000Z'),
  ];
  assert.deepEqual(turnPostsFor({ messages }, 'k1'), [
    { post: { text: 'one', slack: { blocks: CARD_BLOCKS } }, producedAt: '2026-11-07T00:00:01.000Z' },
    { post: { text: 'two', slack: { blocks: CARD_BLOCKS } }, producedAt: '2026-11-07T00:00:02.000Z' },
  ]);
  assert.deepEqual(turnPostsFor({ messages }, 'k2').map((entry) => entry.post.text), ['three']);
  assert.deepEqual(turnPostsFor({ messages }, 'k9'), []);
});
