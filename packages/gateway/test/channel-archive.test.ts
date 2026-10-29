import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ExecutionContext, JsonObject, PluginContext, ProviderResponse, Session, StratusEvent } from '@stratusagent/core';
import { createPermissionPolicy } from '@stratusagent/permissions';
import type { OptionalModuleHost } from '@stratusagent/plugins';

import { createGateway, type ApprovalTransport } from '../src/index.ts';

// Card 911: `channel.archive` goes through the asking agent's own app, and
// the gateway never archives the conversation the work was asked from —
// whether a turn asks, a sub-agent of it, or a teammate it delegated to.

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-archive-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const hostFor = async (packages: Record<string, { manifest: unknown; module?: unknown }>): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-archive-pkgs-'));
  const entries = new Map<string, string>();
  for (const [name, entry] of Object.entries(packages)) {
    const directory = path.join(root, name.replace(/[@/]/g, '_'));
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, ...(entry.manifest as object) }));
    entries.set(name, pathToFileURL(path.join(directory, 'dist', 'index.js')).href);
  }
  return {
    resolve(specifier) {
      const resolved = entries.get(specifier);
      if (!resolved) {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return resolved;
    },
    async import(specifier) {
      return packages[specifier]?.module ?? {};
    },
  };
};

const manifest = (contributes: Record<string, unknown>) => ({ stratus: { pluginVersion: 1, contributes } });

const plugin = (name: string, setup: (context: PluginContext) => void | Promise<void>) => ({
  createPlugin: () => ({ name, setup }),
});

/** What a scripted turn does, read from its first user message. */
type Step =
  | { do: 'archive'; conversation: string }
  | { do: 'spawn'; conversation: string }
  | { do: 'delegate'; to: string; conversation: string };

const say = (step: Step): string => JSON.stringify(step);

/**
 * Ava and Mia on one fixture channel whose sessions are `fixture:<agent>:<C…>`,
 * the way Slack's are `slack:<agent>:<team>:<C…>`. Ava can archive, spawn a
 * sub-agent that archives, and delegate to Mia, who can archive.
 */
const archiveGateway = async (options: {
  approvals?: 'remote';
  answer?: 'once' | 'always';
  /** The fixture channel can't say which conversation a session is in, fails saying it, or answers nothing. */
  sessionConversation?: 'missing' | 'throws' | 'undefined';
} = {}) => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'id: ava', 'provider: member',
    'tools: [channel.archive, test.spawn, agent.delegate]', 'delegates: [mia]',
    '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: member\ntools: [channel.archive]\n---\n\nYou are Mia.\n');
  // A third agent carried by an adapter that cannot archive.
  await writeSoul(home, 'kai.md', '---\nname: Kai\nid: kai\nprovider: member\ntools: [channel.archive]\n---\n\nYou are Kai.\n');
  const archived: string[] = [];
  let kind = 'fixture';
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava', 'mia'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            ...(options.sessionConversation === 'missing'
              ? {}
              : {
                  sessionConversation(agentId: string, sessionId: string) {
                    if (options.sessionConversation === 'throws') {
                      throw new Error('fixture: lookup failed');
                    }
                    if (options.sessionConversation === 'undefined') {
                      return undefined;
                    }
                    const match = /^fixture:([^:]+):(C[A-Z0-9]+)$/.exec(sessionId);
                    return match && match[1] === agentId ? match[2] : undefined;
                  },
                }),
            async archiveConversation(request: { agentId: string; conversation: string }) {
              archived.push(`${request.agentId}:${request.conversation}`);
              return { conversation: request.conversation, alreadyArchived: false };
            },
          },
        });
      }),
    },
    'stratus-plugin-chan-b': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('b', (context) => {
        context.channels!.register({
          agents: ['kai'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async createConversation(request: { name: string }) {
              return { conversation: 'C0', name: request.name, invited: [], notInvited: [], notSet: [] };
            },
          },
        });
      }),
    },
    'stratus-plugin-spawn': {
      manifest: manifest({ tools: [{ name: 'test.spawn', risk: 'safe' }] }),
      module: plugin('spawn', (context) => {
        context.tools.register({
          name: 'test.spawn',
          risk: 'safe',
          async execute(input: JsonObject, session: Session, toolContext?: ExecutionContext) {
            const outcome = await context.subAgents!.run({
              parent: session,
              instruction: say({ do: 'archive', conversation: String(input.conversation) }),
              tools: ['channel.archive'],
              ...(toolContext?.signal ? { signal: toolContext.signal } : {}),
            });
            return outcome as unknown as JsonObject;
          },
        });
      }),
    },
    'stratus-plugin-member': {
      manifest: manifest({ providers: [{ name: 'member' }] }),
      module: plugin('member', (context) => {
        context.providers!.register({
          name: 'member',
          create: () => ({
            name: 'member',
            async generate({ session }): Promise<ProviderResponse> {
              // Says what its tool call came back with, so a sub-agent's or a
              // delegate's result reaches the turn that started it.
              const last = session.messages.at(-1);
              if (last?.role === 'tool') {
                return { parts: [{ type: 'text', text: `done: ${JSON.stringify(last.toolResult ?? null)}` }] };
              }
              const first = session.messages.find((message) => message.role === 'user')?.content ?? '';
              const step = JSON.parse(typeof first === 'string' ? first : JSON.stringify(first)) as Step;
              const id = `${session.id}:call`;
              if (step.do === 'spawn') {
                return { parts: [{ type: 'tool-call', call: { id, toolName: 'test.spawn', input: { conversation: step.conversation } } }] };
              }
              if (step.do === 'delegate') {
                return { parts: [{ type: 'tool-call', call: { id, toolName: 'agent.delegate', input: { agent: step.to, prompt: say({ do: 'archive', conversation: step.conversation }) } } }] };
              }
              return { parts: [{ type: 'tool-call', call: { id, toolName: 'channel.archive', input: { channel: kind, conversation: step.conversation } } }] };
            },
          }),
        });
      }),
    },
  });
  const asked: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-chan-b': {}, 'stratus-plugin-spawn': {}, 'stratus-plugin-member': {} },
    pluginHost: host,
    ...(options.approvals === 'remote'
      ? {
          approvals: (transport: ApprovalTransport) =>
            createPermissionPolicy({ mode: 'remote', request: transport.request, destinations: transport.destinations }),
        }
      : {}),
    log: () => {},
    warn: () => {},
  });
  gateway.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'tool.approval-requested') {
      if (event.call.toolName === 'channel.archive') {
        asked.push(`${event.sessionId}:${event.call.toolName}`);
      }
      gateway.resolveApproval({ requestId: event.requestId, answer: options.answer ?? 'once', actor: 'U-DYLAN' });
    }
  });
  await gateway.start();
  return { gateway, archived, asked, setKind: (next: string) => { kind = next; } };
};

/** Every tool result in a session and the sessions it started, as text. */
const transcript = (session: { messages: unknown[] }): string => JSON.stringify(session.messages);

const ASKED_FROM = /is the conversation this work was asked from/;

test('channel.archive goes through the adapter that carries the calling agent, and is refused where none can archive', async () => {
  const { gateway, archived, setKind } = await archiveGateway();
  try {
    const done = await gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C2' }) });
    assert.match(transcript(done), /\\"archived\\":true/);
    assert.match(transcript(done), /\\"alreadyArchived\\":false/);
    assert.deepEqual(archived, ['ava:C2']);

    // Kai's own adapter cannot archive, and Ava's app never serves him.
    const kai = await gateway.dispatch({ sessionId: 'fixture:kai:C1', agentId: 'kai', userMessage: say({ do: 'archive', conversation: 'C2' }) });
    assert.match(transcript(kai), /No running 'fixture' channel carries agent kai, so it has no app to archive a channel with/);
    setKind('discord');
    const elsewhere = await gateway.dispatch({ sessionId: 'fixture:ava:C3', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C2' }) });
    assert.match(transcript(elsewhere), /No running channel can archive 'discord' conversations/);
    assert.deepEqual(archived, ['ava:C2']);
  } finally {
    await gateway.stop();
  }
});

test('channel.archive refuses the conversation the work was asked from, for the turn, its sub-agent and its delegate', async () => {
  const { gateway, archived } = await archiveGateway();
  try {
    const own = await gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C1' }) });
    assert.match(transcript(own), ASKED_FROM);
    assert.match(transcript(own), /from another conversation/);
    assert.deepEqual(archived, []);

    // A sub-agent of a turn in C1 has an id no adapter recognizes; it is
    // held to its root's conversation all the same.
    const spawnedOwn = await gateway.dispatch({ sessionId: 'fixture:ava:C4', agentId: 'ava', userMessage: say({ do: 'spawn', conversation: 'C4' }) });
    assert.match(transcript(spawnedOwn), ASKED_FROM);
    assert.deepEqual(archived, []);
    const spawnedOther = await gateway.dispatch({ sessionId: 'fixture:ava:C5', agentId: 'ava', userMessage: say({ do: 'spawn', conversation: 'C6' }) });
    assert.doesNotMatch(transcript(spawnedOther), ASKED_FROM);
    assert.deepEqual(archived, ['ava:C6']);

    // A teammate the turn delegated to is held to the delegating turn's
    // conversation, though its own app would be the one archiving.
    const delegatedOwn = await gateway.dispatch({ sessionId: 'fixture:ava:C7', agentId: 'ava', userMessage: say({ do: 'delegate', to: 'mia', conversation: 'C7' }) });
    assert.match(transcript(delegatedOwn), ASKED_FROM);
    assert.deepEqual(archived, ['ava:C6']);
    const delegatedOther = await gateway.dispatch({ sessionId: 'fixture:ava:C8', agentId: 'ava', userMessage: say({ do: 'delegate', to: 'mia', conversation: 'C9' }) });
    assert.doesNotMatch(transcript(delegatedOther), ASKED_FROM);
    assert.deepEqual(archived, ['ava:C6', 'mia:C9']);
  } finally {
    await gateway.stop();
  }
});

test('channel.archive from a session whose id says it was started by another, which no longer exists, is refused', async () => {
  const { gateway, archived } = await archiveGateway();
  try {
    const orphan = await gateway.dispatch({
      sessionId: 'fixture:ava:CGONE:delegate:mia:1:abc',
      agentId: 'mia',
      userMessage: say({ do: 'archive', conversation: 'C2' }),
    });
    assert.match(transcript(orphan), /can't tell which conversation this work was asked from/);
    assert.deepEqual(archived, []);
  } finally {
    await gateway.stop();
  }
});

test('channel.archive is refused when the channel can\'t say which conversation the work was asked from', async () => {
  for (const sessionConversation of ['missing', 'throws'] as const) {
    const { gateway, archived } = await archiveGateway({ sessionConversation });
    try {
      for (const step of [say({ do: 'archive', conversation: 'C2' }), say({ do: 'spawn', conversation: 'C2' })]) {
        const refused = await gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: step });
        assert.match(transcript(refused), /can't tell which conversation this work was asked from/, `${sessionConversation}: ${step}`);
      }
      assert.deepEqual(archived, [], sessionConversation);
    } finally {
      await gateway.stop();
    }
  }
});

test('channel.archive is refused when this channel\'s session gets no conversation from it, and runs for a session that isn\'t this channel\'s', async () => {
  const { gateway, archived } = await archiveGateway({ sessionConversation: 'undefined' });
  try {
    for (const step of [say({ do: 'archive', conversation: 'C2' }), say({ do: 'delegate', to: 'mia', conversation: 'C2' })]) {
      const refused = await gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: step });
      assert.match(transcript(refused), /can't say which of its conversations this work was asked from/, step);
    }
    assert.deepEqual(archived, []);
    // An API session is no conversation on this channel.
    const api = await gateway.dispatch({ sessionId: 'api-1', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C2' }) });
    assert.match(transcript(api), /\\"archived\\":true/);
    assert.deepEqual(archived, ['ava:C2']);
  } finally {
    await gateway.stop();
  }
});

test('an archive of the conversation the work was asked from is refused before anyone is asked, so no grant comes of it', async () => {
  const { gateway, archived, asked } = await archiveGateway({ approvals: 'remote', answer: 'always' });
  try {
    const own = await gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C1' }) });
    assert.match(transcript(own), ASKED_FROM);
    assert.deepEqual(asked, [], 'nobody was asked');
    // Had Always allow been asked and answered, this would run unasked.
    await gateway.dispatch({ sessionId: 'fixture:ava:C3', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C2' }) });
    assert.deepEqual(asked, ['fixture:ava:C3:channel.archive']);
    assert.deepEqual(archived, ['ava:C2']);
  } finally {
    await gateway.stop();
  }
});

test('under remote approvals a sub-agent\'s channel.archive is denied unasked without a standing grant, and runs with one', async () => {
  const once = await archiveGateway({ approvals: 'remote', answer: 'once' });
  try {
    const denied = await once.gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: say({ do: 'spawn', conversation: 'C2' }) });
    assert.deepEqual(once.archived, []);
    assert.deepEqual(once.asked, [], 'a sub-agent asks no one');
    assert.doesNotMatch(transcript(denied), /\\"archived\\":true/);
  } finally {
    await once.gateway.stop();
  }

  const always = await archiveGateway({ approvals: 'remote', answer: 'always' });
  try {
    await always.gateway.dispatch({ sessionId: 'fixture:ava:C1', agentId: 'ava', userMessage: say({ do: 'archive', conversation: 'C2' }) });
    assert.deepEqual(always.asked, ['fixture:ava:C1:channel.archive']);
    assert.deepEqual(always.archived, ['ava:C2']);
    await always.gateway.dispatch({ sessionId: 'fixture:ava:C3', agentId: 'ava', userMessage: say({ do: 'spawn', conversation: 'C4' }) });
    assert.deepEqual(always.asked, ['fixture:ava:C1:channel.archive'], 'the standing grant answers for the sub-agent');
    assert.deepEqual(always.archived, ['ava:C2', 'ava:C4']);
  } finally {
    await always.gateway.stop();
  }
});
