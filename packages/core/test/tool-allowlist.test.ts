import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  matchesToolAllowlist,
  unmatchedToolAllowlist,
  originOf,
  ToolRegistry,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Tool,
  type ToolDescriptor,
} from '../src/index.ts';

const tool = (name: string): Tool => ({
  name,
  risk: 'safe',
  async execute() {
    return { ran: name };
  },
});

test('a toolset glob selects its namespace and nothing that merely starts like it', () => {
  assert.equal(matchesToolAllowlist('fs.read', ['fs.read']), true);
  assert.equal(matchesToolAllowlist('fs.write', ['fs.read']), false);

  // The whole toolset, nested names included — the form the MCP bridge's
  // runtime-discovered names can be granted under at all.
  assert.equal(matchesToolAllowlist('fs.read', ['fs.*']), true);
  assert.equal(matchesToolAllowlist('mcp.linear.create_issue', ['mcp.*']), true);

  // The dot belongs to the prefix: a package cannot widen its way into
  // another's namespace by naming itself to look like one.
  assert.equal(matchesToolAllowlist('fsx.read', ['fs.*']), false);
  assert.equal(matchesToolAllowlist('fs', ['fs.*']), false);

  assert.equal(matchesToolAllowlist('anything.at.all', ['*']), true);
  assert.equal(matchesToolAllowlist('fs.read', []), false);
});

test('an agent allowed a toolset can call every tool in it, and nothing outside it', async () => {
  const tools = new ToolRegistry();
  tools.register(tool('fs.read'));
  tools.register(tool('fs.search'));
  tools.register(tool('shell.run'));

  const advertised: ToolDescriptor[][] = [];
  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      advertised.push(request.tools ?? []);
      turn += 1;
      if (turn === 1) {
        return { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'fs.search', input: {} } }] };
      }
      if (turn === 2) {
        return { parts: [{ type: 'tool-call', call: { id: 'c2', toolName: 'shell.run', input: {} } }] };
      }
      return { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  const runner = new AgentRunner({ provider, tools, store: new InMemorySessionStore() });
  await runner.initialize();

  const session = await runner.run({
    sessionId: 'glob-1',
    agent: { id: 'ava', name: 'Ava', tools: ['fs.*'] },
    userMessage: 'go',
  });

  // The provider is shown the toolset, not the tool the glob was written to
  // avoid: an agent that cannot call `shell.run` should not be told it can.
  assert.deepEqual(advertised[0]?.map((entry) => entry.name), ['fs.read', 'fs.search']);

  const results = session.messages.filter((message) => message.role === 'tool');
  assert.equal(results[0]?.toolResult?.ok, true);
  assert.deepEqual(results[0]?.toolResult?.output, { ran: 'fs.search' });

  // The gate is the allowlist's, not the provider's: a call the model
  // invented for a tool outside the glob is still refused.
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(results[1]?.toolResult?.error ?? '', /not permitted for agent ava: shell\.run/);
});

test('an origin is scheme, host, and port — and nothing without one is named', () => {
  // What makes a browser action's blast radius nameable at all: no path, no
  // query, no fragment, no credentials. A grant an operator reads as "this
  // agent may act on app.example.com" has to mean exactly that, whichever
  // page of the site the conversation is on.
  assert.equal(originOf('https://app.example.com/reports/17?token=abc#top'), 'https://app.example.com');
  assert.equal(originOf('https://user:pw@app.example.com/'), 'https://app.example.com');
  assert.equal(originOf('https://APP.example.com'), 'https://app.example.com');
  // The default port is not part of the origin; any other port is, because
  // a service on another port of the same host is another service.
  assert.equal(originOf('https://app.example.com:443/'), 'https://app.example.com');
  assert.equal(originOf('https://app.example.com:8443/'), 'https://app.example.com:8443');
  // One spelling per host: a homograph cannot be a second way to write an
  // approved grant.
  assert.equal(originOf('https://exämple.com/'), 'https://xn--exmple-cua.com');

  // The URL parser answers the string "null" for all of these, and a grant
  // that could be spelled `null` would cover every one of them at once.
  for (const raw of ['about:blank', 'file:///etc/passwd', 'data:text/html,x', 'not a url', '']) {
    assert.equal(originOf(raw), undefined, raw);
  }
});

test('a call is not dispatched once the page it was judged on has moved', async () => {
  // The approval is not the last thing between the judgement and the act:
  // clearing the checkpoint is a store write, and `tool.called` is awaited
  // through every subscriber. A page that navigates in there would be
  // clicked on having been judged somewhere else, and no re-read inside the
  // policy can see past its own return.
  let page = 'https://app.example.com/reports';
  let executed = 0;
  const act: Tool = {
    name: 'browser.act',
    risk: 'gated',
    originFor: () => page,
    async execute() {
      executed += 1;
      return { clicked: true };
    },
  };
  const tools = new ToolRegistry();
  tools.register(act);

  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'browser.act', input: { selector: '#submit' } } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  const bus = new EventBus();
  // The subscriber *is* the window: `emit` awaits each one, so a handler
  // that yields is exactly the gap a redirect fits into.
  bus.subscribe(async (event) => {
    if (event.type === 'tool.called') {
      await Promise.resolve();
      page = 'https://checkout.example.com/confirm';
    }
  });

  const runner = new AgentRunner({ provider, tools, bus, store: new InMemorySessionStore() });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 'moved-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  });

  assert.equal(executed, 0, 'the click ran on a page nobody judged');
  const result = session.messages.filter((message) => message.role === 'tool')[0]?.toolResult;
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /judged on https:\/\/app\.example\.com/);
  assert.match(result?.error ?? '', /now on https:\/\/checkout\.example\.com/);
});

test('a tool that names no origin is dispatched exactly as before', async () => {
  let executed = 0;
  const echo: Tool = {
    name: 'demo.echo',
    risk: 'gated',
    async execute() {
      executed += 1;
      return { ran: 'demo.echo' };
    },
  };
  const tools = new ToolRegistry();
  tools.register(echo);

  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'demo.echo', input: {} } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  const runner = new AgentRunner({ provider, tools, store: new InMemorySessionStore() });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 'plain-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  });

  assert.equal(executed, 1);
  assert.equal(session.messages.filter((message) => message.role === 'tool')[0]?.toolResult?.ok, true);
});

test('the dispatch check uses the origin the policy judged, not one from before it', async () => {
  // A policy reads the page as it stands when it decides, which is after it
  // has loaded whatever grants it consults. A snapshot taken before the
  // call would disagree for every page that moved during that load — and
  // would refuse an action the policy had just correctly allowed.
  let page = 'https://app.example.com/reports';
  let executed = 0;
  const act: Tool = {
    name: 'browser.act',
    risk: 'gated',
    originFor: () => page,
    async execute() {
      executed += 1;
      return { clicked: true };
    },
  };
  const tools = new ToolRegistry();
  tools.register(act);

  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'browser.act', input: {} } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  const runner = new AgentRunner({
    provider,
    tools,
    store: new InMemorySessionStore(),
    approvals: {
      // Stands in for the grant load: the policy yields, the page moves,
      // and the policy then judges — and allows — where it ended up.
      async approve() {
        await Promise.resolve();
        page = 'https://other.example.com/';
        return true;
      },
    },
  });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 'judged-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'go',
  });

  assert.equal(executed, 1, 'an action the policy allowed was refused at dispatch');
  assert.equal(session.messages.filter((message) => message.role === 'tool')[0]?.toolResult?.ok, true);
});

test('an allowlist entry naming no registered tool is reported, and a whole allowlist of them says so', () => {
  const registered = ['demo.echo', 'memory.remember', 'memory.recall'];

  // No `tools:` key means every tool, so nothing can be named that is not
  // there; a live glob is likewise nothing to report.
  assert.equal(unmatchedToolAllowlist({}, registered), undefined);
  assert.equal(unmatchedToolAllowlist({ tools: ['memory.*'] }, registered), undefined);

  // One dead entry among live ones is named on its own, and is not fatal.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['demo.echo', 'fs.*'] }, registered), {
    unmatched: ['fs.*'],
    none: false,
  });

  // Every entry dead: the allowlist grants nothing, so none of the tools the
  // soul was written around are there — the case a host should say more
  // about. A statement about the allowlist, not about `skill.read`, which
  // rides on the skills gate instead.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['fs.*', 'web.search'] }, registered), {
    unmatched: ['fs.*', 'web.search'],
    none: true,
  });

  // Nothing registered makes even a wildcard dead — the shape a daemon
  // whose plugins all failed to load would be in.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['*'] }, []), { unmatched: ['*'], none: true });
});
