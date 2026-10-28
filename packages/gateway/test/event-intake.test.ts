import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseEventFilter, type InboundEvent } from '@stratusagent/agents';
import {
  SqliteEventStore,
  createEventIntake,
  mapGithubDelivery,
  parseStandardWebhookEvent,
  verifyGithubSignature,
  verifyStandardWebhookSignature,
  type EventIntakeOptions,
  type EventIntakeRequest,
  type EventTrigger,
} from '../src/index.ts';

// ---- known answers from each standard's own reference ------------------------

test('Standard Webhooks: the reference vector verifies, and a changed byte, id or secret does not', () => {
  // standard-webhooks libraries/python/tests/test_webhooks.py, test_sign_function.
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const input = {
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    body: Buffer.from('{"test": 2432232314}'),
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };
  assert.equal(verifyStandardWebhookSignature(input, [secret]), true);
  assert.equal(verifyStandardWebhookSignature(input, ['MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw']), true, 'the whsec_ prefix is optional');
  assert.equal(verifyStandardWebhookSignature({ ...input, body: Buffer.from('{"test": 2432232315}') }, [secret]), false);
  assert.equal(verifyStandardWebhookSignature({ ...input, id: 'msg_other' }, [secret]), false);
  assert.equal(verifyStandardWebhookSignature({ ...input, timestamp: '1614265331' }, [secret]), false);
  assert.equal(verifyStandardWebhookSignature(input, ['whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']), false);
  // Rotation: any one valid v1 signature among several, with any one of the secrets.
  assert.equal(
    verifyStandardWebhookSignature(
      { ...input, signature: `v1a,AAAA v1,bm9wZQ== ${input.signature}` },
      ['whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', secret],
    ),
    true,
  );
  assert.equal(verifyStandardWebhookSignature({ ...input, signature: 'v1a,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' }, [secret]), false, 'v1a is phase 2');
  assert.equal(verifyStandardWebhookSignature({ ...input, signature: '' }, [secret]), false);
});

test("GitHub: the docs' vector verifies, and anything else does not", () => {
  // docs.github.com, "Validating webhook deliveries", testing the webhook payload validation.
  const body = Buffer.from('Hello, World!');
  const secret = "It's a Secret to Everybody";
  const good = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(verifyGithubSignature({ body, signature: good }, [secret]), true);
  assert.equal(verifyGithubSignature({ body, signature: good }, ['wrong', secret]), true, 'any configured secret');
  assert.equal(verifyGithubSignature({ body: Buffer.from('Hello, World?'), signature: good }, [secret]), false);
  assert.equal(verifyGithubSignature({ body, signature: good.replace('sha256=', '') }, [secret]), false);
  assert.equal(verifyGithubSignature({ body, signature: 'sha1=0123' }, [secret]), false);
  assert.equal(verifyGithubSignature({ body, signature: undefined }, [secret]), false);
});

// ---- the intake ---------------------------------------------------------------

const SW_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const GH_SECRET = 'gh-test-secret';
const NOW = new Date('2026-10-28T00:30:00Z');
const nowSeconds = String(Math.floor(NOW.getTime() / 1_000));

const swSign = (id: string, timestamp: string, body: string, secret = SW_SECRET): string => {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
};

const ghSign = (body: string, secret = GH_SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const swRequest = (body: string, id: string, overrides: Record<string, string> = {}): EventIntakeRequest => ({
  sourceId: 'board',
  headers: {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': nowSeconds,
    'webhook-signature': swSign(id, overrides['webhook-timestamp'] ?? nowSeconds, body),
    ...overrides,
  },
  body: Buffer.from(body),
});

const ghRequest = (event: string, payload: unknown, delivery: string, overrides: Record<string, string> = {}): EventIntakeRequest => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    sourceId: 'github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': ghSign(body),
      ...overrides,
    },
    body: Buffer.from(body),
  };
};

interface Harness {
  intake: ReturnType<typeof createEventIntake>;
  store: SqliteEventStore;
  warnings: string[];
  clock: { now: Date };
}

const harness = async (overrides: Partial<EventIntakeOptions> = {}, triggers: EventTrigger[] = []): Promise<Harness> => {
  const store = new SqliteEventStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-intake-')), 'fleet.db'));
  const warnings: string[] = [];
  const clock = { now: NOW };
  const intake = createEventIntake({
    store,
    sources: () => ({
      board: { verify: 'standard-webhooks', secrets: ['events.board'] },
      github: { verify: 'github', secrets: ['events.github'] },
    }),
    secret: async (name) => ({ 'events.board': SW_SECRET, 'events.github': GH_SECRET } as Record<string, string>)[name],
    triggers: (sourceId) => triggers.filter((trigger) => trigger.source === sourceId),
    now: () => clock.now,
    warn: (line) => warnings.push(line),
    ...overrides,
  });
  return { intake, store, warnings, clock };
};

const cloudEvent = (id: string, extra: Record<string, unknown> = {}): string => JSON.stringify({
  specversion: '1.0',
  id,
  source: 'https://app.agentboard.to/stratus-labs/agent',
  type: 'to.agentboard.card.moved',
  subject: 'card/590',
  time: '2026-10-28T00:29:59Z',
  data: { column: 'Todo' },
  ...extra,
});

test('an unknown source is 404 with no row, and every unknown path shares one counter', async () => {
  const { intake, store } = await harness();
  for (const sourceId of ['nope', 'other', 'nope', 'constructor', '__proto__']) {
    const response = await intake.receive({ sourceId, headers: {}, body: Buffer.from('{}') });
    assert.equal(response.status, 404);
  }
  assert.equal(store.deliveries().length, 0);
  assert.equal(intake.counters().unknownSource, 5, 'inherited names are not sources');
  assert.deepEqual(Object.keys(intake.counters().sources).sort(), ['board', 'github'], 'no counter per unknown path');
});

test('a refusal quoting what the sender sent is warned with its control characters escaped, so it cannot forge a log line', async () => {
  const { intake, warnings } = await harness();
  // A header value may carry C1 controls (obs-text); \u009b is CSI on some terminals.
  const sneaky = swRequest(cloudEvent('ce-9'), 'ce-9', { 'content-type': 'text/x\u009b31m' });
  assert.equal((await intake.receive(sneaky)).status, 415);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0]!, /\u009b/);
  assert.match(warnings[0]!, /text\/x\\u009b31m/);
});

test('a body over the limit is 413 with no row', async () => {
  const { intake, store } = await harness({ maxBodyBytes: 64 });
  const response = await intake.receive(swRequest(cloudEvent('ce-1'), 'ce-1'));
  assert.equal(response.status, 413);
  assert.equal(store.deliveries().length, 0);
  assert.equal(intake.counters().sources.board!.tooLarge, 1);
});

test('a missing or wrong signature is 401 with no row; the reason is kept as the last refusal and warned once', async () => {
  const { intake, store, warnings } = await harness();
  const unsigned = swRequest(cloudEvent('ce-1'), 'ce-1');
  delete (unsigned.headers as Record<string, string>)['webhook-signature'];
  assert.equal((await intake.receive(unsigned)).status, 401);
  const forged = swRequest(cloudEvent('ce-1'), 'ce-1', { 'webhook-signature': swSign('ce-1', nowSeconds, cloudEvent('ce-1'), 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') });
  assert.equal((await intake.receive(forged)).status, 401);
  const gh = ghRequest('ping', { zen: 'hi' }, 'd-1', { 'x-hub-signature-256': ghSign('{"zen":"hi"}', 'wrong') });
  assert.equal((await intake.receive(gh)).status, 401);
  assert.equal(store.deliveries().length, 0, 'unsigned traffic leaves no row');
  const counters = intake.counters();
  assert.equal(counters.sources.board!.badSignature, 2);
  assert.match(counters.sources.board!.lastRefusal!.reason, /signature/);
  assert.equal(warnings.filter((line) => line.includes('board')).length, 1, 'once per source per 10 minutes');
  assert.equal(warnings.filter((line) => line.includes('github')).length, 1);
});

test('a Standard Webhooks timestamp more than 5 minutes off is refused, even with a good signature', async () => {
  const { intake } = await harness();
  const stale = String(Math.floor(NOW.getTime() / 1_000) - 301);
  const response = await intake.receive(swRequest(cloudEvent('ce-1'), 'ce-1', { 'webhook-timestamp': stale }));
  assert.equal(response.status, 401);
  assert.match(intake.counters().sources.board!.lastRefusal!.reason, /5 minutes/);
  const ahead = String(Math.floor(NOW.getTime() / 1_000) + 299);
  assert.equal((await intake.receive(swRequest(cloudEvent('ce-2'), 'ce-2', { 'webhook-timestamp': ahead }))).status, 200);
});

test('a source whose secret is not set answers 503 and says how to set it', async () => {
  const { intake, store } = await harness({ secret: async () => undefined });
  const response = await intake.receive(ghRequest('ping', { zen: 'hi' }, 'd-1'));
  assert.equal(response.status, 503);
  assert.match(String(response.body.message), /stratus credential set events\.github/);
  assert.equal(store.deliveries().length, 0);
});

test('only signed requests count toward the 120-a-minute quota, so unsigned floods cannot get real deliveries refused', async () => {
  const { intake, clock } = await harness();
  for (let i = 0; i < 500; i += 1) {
    const unsigned = swRequest(cloudEvent(`junk-${i}`), `junk-${i}`, { 'webhook-signature': 'v1,AAAA' });
    assert.equal((await intake.receive(unsigned)).status, 401);
  }
  for (let i = 0; i < 120; i += 1) {
    assert.equal((await intake.receive(swRequest(cloudEvent(`ce-${i}`), `ce-${i}`))).status, 200, `signed request ${i}`);
  }
  assert.equal((await intake.receive(swRequest(cloudEvent('ce-120'), 'ce-120'))).status, 429);
  assert.equal(intake.counters().sources.board!.rateLimited, 1);
  // GitHub has its own quota.
  assert.equal((await intake.receive(ghRequest('ping', { zen: 'hi' }, 'd-1'))).status, 200);
  clock.now = new Date(NOW.getTime() + 61_000);
  const later = String(Math.floor(clock.now.getTime() / 1_000));
  assert.equal((await intake.receive(swRequest(cloudEvent('ce-121'), 'ce-121', { 'webhook-timestamp': later }))).status, 200);
});

test("a GitHub delivery left on the form content type is refused 415 naming the setting, and the fixed redelivery gets through", async () => {
  const { intake, store } = await harness();
  const payload = 'payload=%7B%22zen%22%3A%22hi%22%7D';
  const form = ghRequest('ping', payload, 'd-1', { 'content-type': 'application/x-www-form-urlencoded' });
  const refused = await intake.receive(form);
  assert.equal(refused.status, 415);
  assert.match(String(refused.body.message), /application\/json/);
  const [row] = store.deliveries();
  assert.equal(row!.status, 'refused');
  assert.match(row!.reason ?? '', /Content type.*application\/json/);
  assert.equal((await intake.receive(ghRequest('ping', { zen: 'hi', hook: { type: 'Organization' }, organization: { login: 'stratuslabs' } }, 'd-1'))).status, 200);
  assert.equal(store.deliveries()[0]!.status, 'unmatched');
});

test('a signed body that is not a valid event is refused 400 with a row, and the corrected post with the same id is accepted', async () => {
  const { intake, store } = await harness();
  assert.equal((await intake.receive(swRequest('{not json', 'ce-1'))).status, 400);
  assert.equal((await intake.receive(swRequest(JSON.stringify({ specversion: '1.0', id: 'ce-1', source: 's' }), 'ce-1'))).status, 400, 'no type');
  assert.equal((await intake.receive(swRequest(JSON.stringify({ data: {} }), 'ce-1'))).status, 400, 'a plain payload needs a type');
  const [latest] = store.deliveries();
  assert.equal(latest!.status, 'refused');
  assert.equal(latest!.eventId, 'ce-1');
  assert.equal((await intake.receive(swRequest(cloudEvent('ce-1'), 'ce-1'))).status, 200);
});

test('an empty webhook-id is refused 400, so it can never become a shared dedup key', async () => {
  const { intake, store } = await harness();
  const body = JSON.stringify({ type: 'invoice.paid', data: {} });
  const response = await intake.receive(swRequest(body, ''));
  assert.equal(response.status, 400);
  assert.match(String(response.body.message), /webhook-id/);
  assert.equal(store.deliveries()[0]!.status, 'refused');
});

test('a CloudEvent with base64 data is refused 400 rather than accepted with its payload dropped', async () => {
  const { intake } = await harness();
  const body = JSON.stringify({ specversion: '1.0', id: 'ce-1', source: 's', type: 't', data_base64: 'aGk=' });
  const response = await intake.receive(swRequest(body, 'ce-1'));
  assert.equal(response.status, 400);
  assert.match(String(response.body.message), /data_base64/);
});

test("a CloudEvent's id must be the webhook-id it was signed under", async () => {
  const { intake } = await harness();
  const response = await intake.receive(swRequest(cloudEvent('ce-other'), 'ce-1'));
  assert.equal(response.status, 400);
  assert.match(String(response.body.message), /webhook-id/);
});

test('the CloudEvents content type is accepted', async () => {
  const { intake } = await harness();
  const response = await intake.receive(swRequest(cloudEvent('ce-1'), 'ce-1', {
    'content-type': 'application/cloudevents+json; charset=utf-8',
  }));
  assert.equal(response.status, 200);
  assert.equal((await intake.receive(swRequest(cloudEvent('ce-2'), 'ce-2', { 'content-type': 'text/plain' }))).status, 415);
});

test('a structured CloudEvent keeps its attributes, scalar extensions as strings, and its data', () => {
  const event = parseStandardWebhookEvent({
    sourceId: 'board',
    webhookId: 'ce-1',
    body: cloudEvent('ce-1', { actor: 'dylan', priority: 2, nested: { no: 1 }, BadName: 'x' }),
  });
  assert.deepEqual(event, {
    attributes: {
      specversion: '1.0',
      id: 'ce-1',
      source: 'https://app.agentboard.to/stratus-labs/agent',
      type: 'to.agentboard.card.moved',
      subject: 'card/590',
      time: '2026-10-28T00:29:59Z',
      actor: 'dylan',
      priority: '2',
    },
    data: { column: 'Todo' },
  });
});

test('a plain Standard Webhooks payload is an event too: the id is webhook-id and the source names the configured source', () => {
  const body = JSON.stringify({ type: 'invoice.paid', timestamp: '2026-10-28T00:29:00Z', data: { amount: 5 } });
  assert.deepEqual(parseStandardWebhookEvent({ sourceId: 'board', webhookId: 'msg_1', body }), {
    attributes: { specversion: '1.0', id: 'msg_1', source: 'stratus:source/board', type: 'invoice.paid', time: '2026-10-28T00:29:00Z' },
    data: { amount: 5 },
  });
});

const codexReviewPayload = {
  action: 'submitted',
  review: { body: '<!-- codex-review-receipt:v1 -->\n### Codex Review', user: { login: 'chatgpt-codex-connector[bot]' } },
  pull_request: { number: 470, user: { login: 'atlasatstratuslabs[bot]' } },
  repository: { full_name: 'stratuslabs/agent' },
  organization: { login: 'stratuslabs' },
  sender: { login: 'chatgpt-codex-connector[bot]' },
};

test('GitHub deliveries map to CloudEvents: type with action, PR or issue subject, actor and author', () => {
  const map = (event: string, payload: unknown, delivery: string): InboundEvent =>
    mapGithubDelivery({ event, delivery, payload, receivedAt: NOW.toISOString() });
  const review = map('pull_request_review', codexReviewPayload, 'd-review');
  assert.deepEqual(review.attributes, {
    specversion: '1.0',
    id: 'd-review',
    source: 'https://github.com/stratuslabs/agent',
    type: 'com.github.pull_request_review.submitted',
    subject: 'pull/470',
    time: NOW.toISOString(),
    actor: 'chatgpt-codex-connector[bot]',
    author: 'atlasatstratuslabs[bot]',
  });
  assert.deepEqual(review.data, codexReviewPayload);

  const onPr = {
    action: 'created',
    comment: { body: '<!-- codex-review-receipt:v1 -->' },
    issue: { number: 470, pull_request: { url: 'x' }, user: { login: 'atlasatstratuslabs[bot]' } },
    repository: { full_name: 'stratuslabs/agent' },
    sender: { login: 'chatgpt-codex-connector[bot]' },
  };
  const comment = map('issue_comment', onPr, 'd-comment');
  assert.equal(comment.attributes.type, 'com.github.issue_comment.created');
  assert.equal(comment.attributes.subject, 'pull/470', 'a comment on a PR shares the PR subject');
  assert.equal(comment.attributes.author, 'atlasatstratuslabs[bot]');

  const onIssue = { ...onPr, issue: { number: 12, user: { login: 'dylan' } } };
  assert.equal(map('issue_comment', onIssue, 'd-issue').attributes.subject, 'issues/12');

  const ping = map('ping', { zen: 'hi', organization: { login: 'stratuslabs' }, sender: { login: 'dylan' } }, 'd-ping');
  assert.equal(ping.attributes.type, 'com.github.ping');
  assert.equal(ping.attributes.source, 'https://github.com/stratuslabs');
  assert.equal(ping.attributes.subject, undefined);
  assert.equal(ping.attributes.author, undefined);

  // Values GitHub controls only loosely are taken only when they are what they claim.
  const odd = map('issue_comment', { action: 7, issue: { number: '12' }, repository: { full_name: 42 } }, 'd-odd');
  assert.equal(odd.attributes.type, 'com.github.issue_comment');
  assert.equal(odd.attributes.subject, undefined);
  assert.equal(odd.attributes.source, 'https://github.com');
});

test('a GitHub delivery without its event or delivery header is refused 400', async () => {
  const { intake } = await harness();
  const noEvent = ghRequest('ping', { zen: 'hi' }, 'd-1');
  delete (noEvent.headers as Record<string, string>)['x-github-event'];
  assert.equal((await intake.receive(noEvent)).status, 400);
  const noDelivery = ghRequest('ping', { zen: 'hi' }, 'd-1');
  delete (noDelivery.headers as Record<string, string>)['x-github-delivery'];
  assert.equal((await intake.receive(noDelivery)).status, 400);
});

test('a matching trigger gets a pending firing with its keys and block, and a repeat delivery fires nothing', async () => {
  const trigger: EventTrigger = {
    triggerId: 'sched-codex',
    agentId: 'atlas',
    source: 'github',
    filter: parseEventFilter({ all: [
      { exact: { actor: 'chatgpt-codex-connector[bot]', author: 'atlasatstratuslabs[bot]' } },
      { prefix: { type: 'com.github.pull_request_review.submitted', 'data.review.body': '<!-- codex-review-receipt:v1 -->' } },
    ] }),
  };
  const other: EventTrigger = { ...trigger, triggerId: 'sched-other', filter: parseEventFilter({ exact: { actor: 'dylan' } }) };
  const { intake, store } = await harness({}, [trigger, other]);
  const first = await intake.receive(ghRequest('pull_request_review', codexReviewPayload, 'd-review'));
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'matched');
  const open = store.open();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.triggerId, 'sched-codex');
  assert.equal(open[0]!.agentId, 'atlas');
  assert.equal(open[0]!.dispatchKey, 'event:sched-codex:github:d-review');
  assert.match(open[0]!.sessionId, /^schedule:sched-codex:event-/);
  assert.match(open[0]!.block ?? '', /^Event from source "github":/);

  const repeat = await intake.receive(ghRequest('pull_request_review', codexReviewPayload, 'd-review'));
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.status, 'duplicate');
  assert.equal(store.open().length, 1);
});

test('a trigger on another source never matches', async () => {
  const trigger: EventTrigger = { triggerId: 't', agentId: 'atlas', source: 'board', filter: parseEventFilter({ prefix: { type: 'com.github.' } }) };
  const { intake, store } = await harness({}, [trigger]);
  assert.equal((await intake.receive(ghRequest('ping', { zen: 'hi' }, 'd-1'))).body.status, 'unmatched');
  assert.equal(store.open().length, 0);
});
