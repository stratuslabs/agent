import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_TASK_TOOL_NAME,
  DEFAULT_FRONT_TOOLS,
  DELEGATE_TOOL_NAME,
  FRONT_TASK_TOOLS,
  formatSoul,
  frontToolEntries,
  parseSoul,
  TASKS_TOOL_NAME,
} from '../src/index.ts';

const soulWith = (frontmatter: string): string => `---\nname: Ava\nmodel: claude-opus-5-5\n${frontmatter}---\n\nHi.\n`;

test('a front: block in the soul names the model, and optionally the provider and tools, of conversation turns', () => {
  const soul = parseSoul(soulWith('front:\n  model: claude-haiku-5-5\n  provider: anthropic\n  tools:\n    - fs.read\n    - "memory.recall"\ntools: ["*"]\n'));
  assert.deepEqual(soul.front, { model: 'claude-haiku-5-5', provider: 'anthropic', tools: ['fs.read', 'memory.recall'] });
  // The keys after the block are the soul's own again.
  assert.deepEqual(soul.agent.tools, ['*']);
  assert.equal(soul.model, 'claude-opus-5-5');

  const inline = parseSoul(soulWith('front:\n    model: claude-haiku-5-5  \n    tools: [fs.read, memory.recall]\n\n# a comment\nlistens: judge\n'));
  assert.deepEqual(inline.front, { model: 'claude-haiku-5-5', tools: ['fs.read', 'memory.recall'] });
  assert.equal(inline.agent.listens, 'judge');
});

test('a soul with no front: block has no front, so every turn runs as it did before the key existed', () => {
  assert.equal(parseSoul(soulWith('tools: [fs.read]\n')).front, undefined);
  assert.equal('front' in parseSoul('Just prose.'), false);
});

test('front: round-trips through the soul writer, an empty tools list included', () => {
  for (const frontmatter of [
    'front:\n  model: claude-haiku-5-5\n',
    'front:\n  model: claude-haiku-5-5\n  provider: anthropic\n  tools:\n    - fs.read\n    - message.send\n',
    'front:\n  model: claude-haiku-5-5\n  tools: []\n',
  ]) {
    const soul = parseSoul(soulWith(frontmatter));
    const reread = parseSoul(formatSoul(soul));
    assert.deepEqual(reread.front, soul.front, frontmatter);
    assert.deepEqual(reread, soul, frontmatter);
  }
  // An empty list is kept, not dropped: it is the task tools alone, and an
  // omitted one adds the quick set.
  assert.deepEqual(parseSoul(formatSoul(parseSoul(soulWith('front:\n  model: m\n  tools: []\n')))).front?.tools, []);
});

test('a field edit that leaves front: alone keeps it in the rewritten soul', () => {
  const soul = parseSoul(soulWith('front:\n  model: claude-haiku-5-5\n  tools: [fs.read]\n'));
  const edited = formatSoul({ ...soul, agent: { ...soul.agent, skills: ['code-review'] } });
  assert.deepEqual(parseSoul(edited).front, { model: 'claude-haiku-5-5', tools: ['fs.read'] });
});

test('a front: block that would load as something other than what it says is refused', () => {
  assert.throws(() => parseSoul(soulWith('front: claude-haiku-5-5\n')), /front: must be a block of indented lines/);
  assert.throws(() => parseSoul(soulWith('front:\n  provider: anthropic\n')), /front: has no model/);
  assert.throws(() => parseSoul(soulWith('front:\n')), /front: has no model/);
  // Strict like the rest of the soul: a misspelled tools list would load
  // as the default quick set.
  assert.throws(() => parseSoul(soulWith('front:\n  model: m\n  tool: [fs.write]\n')), /Unknown soul front: frontmatter key: "tool"/);
  assert.throws(
    () => parseSoul(soulWith('front:\n  model: a\nfront:\n  model: b\n')),
    /more than one front: block/,
  );
});

test('the front always holds the task tools, and the quick set unless front.tools replaces it', () => {
  // Held equal to the tools' own names, which the soul module can't import.
  assert.deepEqual(FRONT_TASK_TOOLS.slice(0, 3), [DELEGATE_TOOL_NAME, TASKS_TOOL_NAME, CANCEL_TASK_TOOL_NAME]);
  assert.deepEqual(frontToolEntries({ model: 'm' }), [...FRONT_TASK_TOOLS, ...DEFAULT_FRONT_TOOLS]);
  assert.deepEqual(frontToolEntries({ model: 'm', tools: ['fs.write'] }), [...FRONT_TASK_TOOLS, 'fs.write']);
  assert.deepEqual(frontToolEntries({ model: 'm', tools: [] }), [...FRONT_TASK_TOOLS]);
  // No writes, shell or web by default.
  assert.equal(DEFAULT_FRONT_TOOLS.some((tool) => /write|edit|shell|web|browser/.test(tool)), false);
});
