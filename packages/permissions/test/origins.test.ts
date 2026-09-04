import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalContext, Session, Tool } from '@stratusagent/core';

import {
  createFileCommandWhitelist,
  createPermissionPolicy,
  parseOriginScope,
  whitelistPathFor,
  type CommandScope,
  type OriginScope,
  type PermissionDecision,
} from '../src/index.ts';

const sessionFor = (agentId: string): Session => ({
  id: `session-${agentId}`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/**
 * The browser pack's half of this engine: the origin of the page the
 * conversation is on, and never anything the call said. `page` is what a
 * test moves; the call's input stays a selector throughout, which is the
 * point — no scope is ever written over it.
 */
const browserTool = (page: () => string | undefined): Tool => ({
  name: 'browser.act',
  risk: 'gated',
  originFor: () => page(),
  async execute() {
    return null;
  },
});

const actOn = (page: () => string | undefined, agentId = 'ava'): ApprovalContext => {
  const tool = browserTool(page);
  return {
    session: sessionFor(agentId),
    call: { id: 'call-1', toolName: 'browser.act', input: { action: 'click', selector: '#submit' } },
    tool,
    risk: 'gated',
  };
};

test('an origin grant runs unattended and covers that site only', async () => {
  const decisions: PermissionDecision[] = [];
  let page = 'https://app.example.com/reports/17?token=abc';
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    origins: {
      whitelist: {
        originsFor: async () => [{ origin: 'https://app.example.com' }],
        rememberOrigin: async () => {},
      },
    },
  });

  assert.equal(await policy.approve(actOn(() => page)), true);

  // The path and the query are not part of the grant and are not part of
  // what the log records: an origin is a classification, which is exactly
  // why the scope is drawn there and not at a URL.
  assert.equal(decisions[0]?.origin, 'https://app.example.com');
  assert.doesNotMatch(decisions[0]?.reason ?? '', /token|reports/);

  // A different site on the same page pool is a different grant. Same host,
  // different port and different scheme included.
  page = 'https://other.example.com/';
  assert.equal(await policy.approve(actOn(() => page)), false);
  page = 'http://app.example.com/';
  assert.equal(await policy.approve(actOn(() => page)), false);
  page = 'https://app.example.com:8443/';
  assert.equal(await policy.approve(actOn(() => page)), false);

  // And the refusal names the site, because that is the actionable half for
  // whoever is reading the log at 3am.
  assert.match(decisions.at(-1)?.reason ?? '', /https:\/\/app\.example\.com:8443/);
});

test('always allow on a page widens that site and nothing else', async () => {
  const remembered: OriginScope[] = [];
  const asked: string[] = [];
  let page = 'https://app.example.com/reports';
  const granted: OriginScope[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asked.push(question);
      return 'always';
    },
    origins: {
      whitelist: {
        originsFor: async () => [...granted],
        rememberOrigin: async (_agentId, scope) => {
          granted.push(scope);
        },
      },
      onScopeRemembered: (event) => remembered.push(event.scope),
    },
  });

  assert.equal(await policy.approve(actOn(() => page)), true);
  assert.deepEqual(remembered, [{ origin: 'https://app.example.com' }]);

  // The approver was shown where the click lands. A selector says nothing
  // about that, and "always" is widening exactly this.
  assert.match(asked[0] ?? '', /browser\.act on https:\/\/app\.example\.com/);
  assert.match(asked[0] ?? '', /always this site/);

  // The second call on the same site does not ask.
  page = 'https://app.example.com/settings';
  assert.equal(await policy.approve(actOn(() => page)), true);
  assert.equal(asked.length, 1);

  // A different site does. This is the whole difference from the tool-wide
  // grant it replaced: one yes to a page is never a yes to every page.
  page = 'https://admin.example.com/';
  assert.equal(await policy.approve(actOn(() => page)), true);
  assert.equal(asked.length, 2);
});

test('a tool judged by origin never receives a tool-wide grant, even with no origin to name', async () => {
  const asked: string[] = [];
  // A conversation whose page never loaded: `about:blank` has no origin,
  // and neither does a context the idle sweep has closed.
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asked.push(question);
      return 'always';
    },
  });

  const decisions: PermissionDecision[] = [];
  const reporting = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => 'always',
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(await reporting.approve(actOn(() => undefined)), true);
  assert.match(decisions[0]?.reason ?? '', /no page origin to remember, so it will ask again/);

  // Twice, and asked both times. Falling back to the tool-wide "always"
  // here would turn "yes on this page" into "yes on every page" — the grant
  // per-origin scopes exist to replace.
  assert.equal(await policy.approve(actOn(() => undefined)), true);
  assert.equal(await policy.approve(actOn(() => undefined)), true);
  assert.equal(asked.length, 2);

  // Nor does a grant on one page leak to a call whose origin cannot be named.
  assert.equal(await policy.approve(actOn(() => 'https://app.example.com/')), true);
  assert.equal(await policy.approve(actOn(() => undefined)), true);
  assert.equal(asked.length, 4);
});

test('a page with no origin is refused unattended, and says why', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    origins: {
      whitelist: {
        originsFor: async () => [{ origin: 'https://app.example.com' }],
        rememberOrigin: async () => {},
      },
    },
  });

  // `file:` and `about:` have no origin the URL parser will name — it
  // answers the string "null" for both — so a grant that matched one would
  // match every one of them at once.
  assert.equal(await policy.approve(actOn(() => undefined)), false);
  assert.match(decisions[0]?.reason ?? '', /no origin a grant could name/);
  assert.equal(decisions[0]?.origin, undefined);
});

test('origin grants persist beside command scopes in one whitelist file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stratus-origins-'));
  const whitelist = createFileCommandWhitelist({ directory });

  const shell: Tool = {
    name: 'shell.run',
    risk: 'gated',
    commandFor: (input) => (typeof input.command === 'string' ? input.command : undefined),
    async execute() {
      return null;
    },
  };
  const runGitPush: ApprovalContext = {
    session: sessionFor('ava'),
    call: { id: 'call-2', toolName: 'shell.run', input: { command: 'git push origin main' } },
    tool: shell,
    risk: 'gated',
  };

  const first = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => 'always',
    commands: { whitelist },
    origins: { whitelist },
  });
  assert.equal(await first.approve(actOn(() => 'https://app.example.com/reports')), true);
  assert.equal(await first.approve(runGitPush), true);

  const file = whitelistPathFor(directory, 'ava');
  const stored = JSON.parse(await readFile(file, 'utf8')) as {
    version: number;
    scopes: CommandScope[];
    origins: OriginScope[];
  };
  // One file, both kinds of grant — and writing the second must not drop
  // the first, which is the failure a separate write path would have.
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.origins, [{ origin: 'https://app.example.com' }]);
  assert.deepEqual(stored.scopes[0]?.args, ['push']);
  // It decides what happens with nobody watching, so nobody else on the
  // machine may append a line to it.
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // A restarted daemon, headless, with no session memory at all.
  const second = createPermissionPolicy({
    mode: 'headless',
    commands: { whitelist: createFileCommandWhitelist({ directory }) },
    origins: { whitelist: createFileCommandWhitelist({ directory }) },
  });
  assert.equal(await second.approve(actOn(() => 'https://app.example.com/other')), true);
  assert.equal(await second.approve(actOn(() => 'https://app.example.com/other', 'juno')), false);
  assert.equal(await second.approve(runGitPush), true);
});

test('a hand-written origin is normalized or dropped, never half-matched', async () => {
  // The file is hand-editable, and a grant is only as good as the
  // comparison it will win or lose. Everything here would silently never
  // match if it were trusted as written.
  assert.deepEqual(parseOriginScope({ origin: 'https://APP.example.com/reports?a=1' }), {
    origin: 'https://app.example.com',
  });
  assert.deepEqual(parseOriginScope({ origin: 'https://user:pw@app.example.com' }), {
    origin: 'https://app.example.com',
  });
  assert.deepEqual(parseOriginScope({ origin: 'https://app.example.com:443/' }), {
    origin: 'https://app.example.com',
  });
  // A homograph spelling is stored as the one form the URL parser produces,
  // so an approved host has exactly one way to be written.
  assert.deepEqual(parseOriginScope({ origin: 'https://exämple.com' }), {
    origin: 'https://xn--exmple-cua.com',
  });
  for (const raw of ['file:///etc/passwd', 'about:blank', 'data:text/html,x', 'app.example.com', '']) {
    assert.equal(parseOriginScope({ origin: raw }), undefined, raw);
  }
  assert.equal(parseOriginScope('https://app.example.com'), undefined);
  assert.equal(parseOriginScope(null), undefined);
});

test('an unreadable whitelist holds an origin for the process and says it was not saved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stratus-origins-bad-'));
  const file = whitelistPathFor(directory, 'ava');
  // One trailing comma, the hand edit that already cost a grant list once.
  await writeFile(file, '{\n  "version": 1,\n  "scopes": [],\n}\n');

  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => 'always',
    onDecision: (decision) => decisions.push(decision),
    origins: { whitelist: createFileCommandWhitelist({ directory }) },
  });

  assert.equal(await policy.approve(actOn(() => 'https://app.example.com/')), true);
  assert.match(decisions[0]?.reason ?? '', /until the daemon restarts — not saved/);
  // The grant still holds for this process, which is what "always" means
  // with no file behind it.
  assert.equal(await policy.approve(actOn(() => 'https://app.example.com/next')), true);
  // And the broken file is left exactly as it was.
  assert.equal(await readFile(file, 'utf8'), '{\n  "version": 1,\n  "scopes": [],\n}\n');
});

test('a tool offering both hooks is judged by the command, not laundered by a site', async () => {
  // Nothing offers both today. The rule exists so that adding one later
  // cannot turn an origin grant into a way past the command engine: two
  // engines over one call need a rule for which wins, and the narrower one
  // is the only honest answer.
  const both: Tool = {
    name: 'odd.tool',
    risk: 'gated',
    commandFor: (input) => (typeof input.command === 'string' ? input.command : undefined),
    originFor: () => 'https://app.example.com',
    async execute() {
      return null;
    },
  };
  const policy = createPermissionPolicy({
    mode: 'headless',
    origins: {
      whitelist: {
        originsFor: async () => [{ origin: 'https://app.example.com' }],
        rememberOrigin: async () => {},
      },
    },
  });

  assert.equal(
    await policy.approve({
      session: sessionFor('ava'),
      call: { id: 'call-3', toolName: 'odd.tool', input: { command: 'rm -rf /srv/data' } },
      tool: both,
      risk: 'gated',
    }),
    false,
  );
});

test('two grants for one agent settling together both survive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stratus-grants-race-'));
  const whitelist = createFileCommandWhitelist({ directory });

  // Every grant is read-add-write, and the read yields — so two answers
  // resolved in the same moment both saw the file before either changed
  // it. One file holding both kinds is what makes the loss cross-cutting:
  // a shell "always" landing second would delete a site grant nobody
  // revoked, and on the next restart it is simply gone.
  await Promise.all([
    whitelist.remember('ava', { command: 'git', args: ['push'] }),
    whitelist.rememberOrigin('ava', { origin: 'https://app.example.com' }),
    whitelist.rememberOrigin('ava', { origin: 'https://admin.example.com' }),
  ]);

  const stored = JSON.parse(await readFile(whitelistPathFor(directory, 'ava'), 'utf8')) as {
    scopes: CommandScope[];
    origins: OriginScope[];
  };
  assert.deepEqual(stored.scopes.map((scope) => scope.args), [['push']]);
  assert.deepEqual(
    stored.origins.map((scope) => scope.origin).sort(),
    ['https://admin.example.com', 'https://app.example.com'],
  );

  // And a fresh store — a restarted daemon — reads back everything that
  // was granted, rather than whichever write happened to land last.
  const reread = createFileCommandWhitelist({ directory });
  assert.equal((await reread.scopesFor('ava')).length, 1);
  assert.equal((await reread.originsFor('ava')).length, 2);
});

test('a page that moves while the approval is outstanding runs nothing and grants nothing', async () => {
  const remembered: OriginScope[] = [];
  const granted: OriginScope[] = [];
  const decisions: PermissionDecision[] = [];
  let page: string | undefined = 'https://app.example.com/reports';
  const asked: string[] = [];

  const policy = createPermissionPolicy({
    mode: 'interactive',
    // A human takes minutes; the remote wait is fifteen by default and
    // unbounded when the timeout is zero. The page is live for all of it,
    // so a redirect inside the wait is what this stands in for.
    ask: async (question) => {
      asked.push(question);
      page = 'https://checkout.example.com/confirm';
      return 'always';
    },
    onDecision: (decision) => decisions.push(decision),
    origins: {
      whitelist: {
        originsFor: async () => [...granted],
        rememberOrigin: async (_agentId, scope) => {
          granted.push(scope);
        },
      },
      onScopeRemembered: (event) => remembered.push(event.scope),
    },
  });

  // The prompt named the site the approver was answering about.
  assert.equal(await policy.approve(actOn(() => page)), false);
  assert.match(asked[0] ?? '', /browser\.act on https:\/\/app\.example\.com/);

  // The yes was for that page. It is not that page any more, so the click
  // does not land on the site nobody was shown — and the "always" widens
  // nothing, rather than persisting the approved site while acting on
  // another one.
  assert.match(decisions[0]?.reason ?? '', /approved on https:\/\/app\.example\.com/);
  assert.match(decisions[0]?.reason ?? '', /on https:\/\/checkout\.example\.com now/);
  assert.match(decisions[0]?.reason ?? '', /nothing was granted/);
  assert.deepEqual(remembered, []);
  assert.deepEqual(granted, []);
});

test('a page closed while the approval is outstanding says so rather than clicking a fresh one', async () => {
  const decisions: PermissionDecision[] = [];
  let page: string | undefined = 'https://app.example.com/reports';
  const policy = createPermissionPolicy({
    mode: 'interactive',
    // The idle sweep closes a quiet context after five minutes by default,
    // which is inside a fifteen-minute approval window: executing anyway
    // would click a fresh `about:blank`, and the selector timeout that
    // follows explains nothing.
    ask: async () => {
      page = undefined;
      return 'y';
    },
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(await policy.approve(actOn(() => page)), false);
  assert.match(decisions[0]?.reason ?? '', /that page is no longer open/);
});

test('a page that moves while the grants are being read is judged on where it ended up', async () => {
  const decisions: PermissionDecision[] = [];
  let page = 'https://app.example.com/reports';
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    origins: {
      whitelist: {
        // The grant list comes off disk, and a custom store can be slower
        // still — a network call, with no bound on it at all. Reading where
        // the page is before that await and matching after it would let a
        // redirect inside the gap have the grant for one site allow a click
        // on another, with nobody asked.
        originsFor: async () => {
          page = 'https://checkout.example.com/confirm';
          return [{ origin: 'https://app.example.com' }];
        },
        rememberOrigin: async () => {},
      },
    },
  });

  assert.equal(await policy.approve(actOn(() => page)), false);
  assert.match(decisions[0]?.reason ?? '', /called on https:\/\/checkout\.example\.com/);
  assert.equal(decisions[0]?.origin, 'https://checkout.example.com');
});
