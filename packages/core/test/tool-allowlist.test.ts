import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  describeToolAllowlistFinding,
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
    inert: [],
    none: false,
  });

  // Every entry dead: the allowlist grants nothing, so none of the tools the
  // soul was written around are there — the case a host should say more
  // about. A statement about the allowlist, not about `skill.read`, which
  // rides on the skills gate instead.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['fs.*', 'web.search'] }, registered), {
    unmatched: ['fs.*', 'web.search'],
    inert: [],
    none: true,
  });

  // Nothing registered makes even a wildcard dead — the shape a daemon
  // whose plugins all failed to load would be in.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['*'] }, []), {
    unmatched: ['*'],
    inert: [],
    none: true,
  });

  // A namespace a loaded plugin may still fill is not a dead entry. An MCP
  // server unreachable at startup registers nothing and reconnects, so its
  // tools are late rather than absent — and an allowlist naming them must
  // not be reported as a typo.
  assert.equal(
    unmatchedToolAllowlist({ tools: ['mcp.linear.*'] }, registered, ['mcp.*']),
    undefined,
  );
  assert.equal(
    unmatchedToolAllowlist({ tools: ['mcp.linear.create_issue'] }, registered, ['mcp.*']),
    undefined,
  );
  // Namespaces nest, so the overlap runs the other way too: a bridge
  // declaring `mcp.linear.*` and an agent granted the broader `mcp.*` is
  // still an agent whose entry selects every tool that will arrive.
  assert.equal(
    unmatchedToolAllowlist({ tools: ['mcp.*'] }, registered, ['mcp.linear.*']),
    undefined,
  );
  assert.equal(unmatchedToolAllowlist({ tools: ['*'] }, registered, ['mcp.linear.*']), undefined);

  // The excuse reaches only as far as the namespaces claim, in either
  // direction.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['fs.*'] }, registered, ['mcp.*']), {
    unmatched: ['fs.*'],
    inert: [],
    none: true,
  });
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['mcp.github.*'] }, registered, ['mcp.linear.*']), {
    unmatched: ['mcp.github.*'],
    inert: [],
    none: true,
  });
});

test('the skill reader cannot stand in for a grant the tools allowlist never made', () => {
  // `skill.read` is registered, so an entry naming it matches — while both
  // of the runner's gates key on `skills:` and neither consults `tools:`.
  // An allowlist of it alone therefore grants nothing while looking live,
  // which is precisely the configuration this check exists to expose.
  const registered = ['demo.echo', 'skill.read'];

  assert.deepEqual(unmatchedToolAllowlist({ tools: ['skill.read'] }, registered), {
    unmatched: [],
    inert: ['skill.read'],
    none: true,
  });
  // The glob spelling reaches it the same way, so it is inert the same way.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['skill.*'] }, registered), {
    unmatched: [],
    inert: ['skill.*'],
    none: true,
  });

  // A real grant beside it is still a real grant: `none` is false, and the
  // dead entry is the reader's, not `demo.echo`'s.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['demo.echo', 'skill.read'] }, registered), {
    unmatched: [],
    inert: ['skill.read'],
    none: false,
  });

  // A wildcard reaches `demo.echo`, so it grants something and there is
  // nothing to report — the reader riding along does not make it inert.
  assert.equal(unmatchedToolAllowlist({ tools: ['*'] }, registered), undefined);

  // But a registry holding only the reader leaves `*` granting nothing.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['*'] }, ['skill.read']), {
    unmatched: [],
    inert: ['*'],
    none: true,
  });

  // With nothing registered at all the reader is not there either, so `*`
  // is an ordinary dead entry rather than one that reached the reader.
  assert.deepEqual(unmatchedToolAllowlist({ tools: ['*'] }, []), {
    unmatched: ['*'],
    inert: [],
    none: true,
  });

  // The two kinds get their own sentence, because the fixes differ: there
  // is no plugin to install for the reader and no name to correct.
  assert.deepEqual(
    describeToolAllowlistFinding('blair', { unmatched: ['fs.*'], inert: ['skill.read'], none: true }),
    [
      'agent blair lists tools nothing registered provides: fs.* — check the names,'
        + ' or install the plugin that provides them',
      'agent blair lists skill.read under tools:, which grants nothing'
        + ' — skill.read is granted by the skills: key instead',
      'agent blair has an allowlist that grants nothing, so none of the tools its persona'
        + ' talks about are there to call',
    ],
  );
  // A live entry beside a dead one says the one thing that applies.
  assert.deepEqual(
    describeToolAllowlistFinding('ava', { unmatched: ['fs.*'], inert: [], none: false }),
    [
      'agent ava lists tools nothing registered provides: fs.* — check the names,'
        + ' or install the plugin that provides them',
    ],
  );
});

test('an empty tools list is an allowlist granting nothing, not an absent one', () => {
  // Omitting the key grants every registered tool; `tools: []` grants none
  // of them. The soul parser keeps the two apart — a bare `tools:` with
  // nothing under it parses to the empty list, which is what someone gets
  // by writing the key and not filling it — so this check has to as well,
  // or the plainest spelling of the failure it exists for goes unreported.
  const registered = ['demo.echo', 'memory.remember'];

  assert.equal(unmatchedToolAllowlist({}, registered), undefined);
  assert.deepEqual(unmatchedToolAllowlist({ tools: [] }, registered), {
    unmatched: [],
    inert: [],
    none: true,
  });

  // No entry to blame, so the advisory names the two spellings instead of
  // listing names it does not have.
  assert.deepEqual(
    describeToolAllowlistFinding('blair', { unmatched: [], inert: [], none: true }),
    [
      'agent blair has an empty tools: list, which grants nothing — remove the key to allow'
        + ' every registered tool, or list the ones it should have',
    ],
  );
});
