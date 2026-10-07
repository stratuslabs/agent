import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  ToolRegistry,
  createImageCollector,
  type ImageAttachment,
  type Message,
  type ModelProvider,
  type ProviderResponse,
  type StratusEvent,
  type Tool,
  type ToolResult,
} from '../src/index.ts';

// A complete 1×1 PNG: header, IHDR, IDAT, IEND.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const AGENT = { id: 'ava', name: 'Ava' };

/** Calls `tool` once, then answers; records the tool message it was shown. */
const callingProvider = (toolName: string, seen: Message[]): ModelProvider => ({
  name: 'calling',
  async generate({ session }): Promise<ProviderResponse> {
    const last = session.messages.at(-1);
    if (last?.role === 'tool') {
      seen.push(last);
      return { parts: [{ type: 'text', text: 'looked' }] };
    }
    return { parts: [{ type: 'tool-call', call: { id: 'c1', toolName, input: {} } }] };
  },
});

const runWith = async (tool: Tool) => {
  const tools = new ToolRegistry();
  tools.register(tool);
  const bus = new EventBus();
  const events: StratusEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  const seen: Message[] = [];
  const runner = new AgentRunner({ provider: callingProvider(tool.name, seen), tools, bus });
  const session = await runner.run({ sessionId: 's1', agent: AGENT, userMessage: 'look' });
  return { session, seen, events };
};

test('an image a tool attaches reaches the provider on the tool message, and nowhere as text', async () => {
  const { session, seen, events } = await runWith({
    name: 'shot',
    async execute(_input, _session, context) {
      context?.attachImage?.({ mediaType: 'image/png', data: PNG, name: 'shot.png' });
      return { file: 'shot.png' };
    },
  });

  assert.deepEqual(seen[0]?.images, [{ mediaType: 'image/png', data: PNG, name: 'shot.png' }]);
  const stored = session.messages.find((message) => message.role === 'tool');
  assert.deepEqual(stored?.images, [{ mediaType: 'image/png', data: PNG, name: 'shot.png' }]);
  // The bytes live on the message only: not in the stored result, not in
  // the content every renderer reads, not on the bus.
  assert.equal(stored?.toolResult?.images, undefined);
  assert.equal(stored?.content.includes(PNG), false);
  const completed = events.find((event): event is Extract<StratusEvent, { type: 'tool.completed' }> => event.type === 'tool.completed');
  assert.equal((completed?.result as ToolResult).images, undefined);
  assert.equal(JSON.stringify(events).includes(PNG), false);
});

test('a call that fails shows nothing it attached', async () => {
  const { session } = await runWith({
    name: 'shot',
    async execute(_input, _session, context) {
      context?.attachImage?.({ mediaType: 'image/png', data: PNG });
      throw new Error('the page crashed');
    },
  });
  const stored = session.messages.find((message) => message.role === 'tool');
  assert.equal(stored?.toolResult?.ok, false);
  assert.equal(stored?.images, undefined);
});

test('the collector refuses what a model API would', () => {
  const collector = createImageCollector();
  const refuses = (image: ImageAttachment, pattern: RegExp) => assert.throws(() => collector.attach(image), pattern);
  refuses({ mediaType: 'image/bmp' as never, data: PNG }, /cannot be shown/);
  refuses({ mediaType: 'image/png', data: '' }, /empty/);
  refuses({ mediaType: 'image/jpeg', data: PNG }, /not a complete image\/jpeg/);
  // Cut short: the IEND trailer is gone.
  refuses({ mediaType: 'image/png', data: Buffer.from(PNG, 'base64').subarray(0, 40).toString('base64') }, /not a complete/);
  collector.attach({ mediaType: 'image/png', data: PNG });
  assert.equal(collector.images().length, 1);
});
