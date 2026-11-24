import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { newHome, openSocket, settles, startApi } from './harness.ts';

// A synthetic stored credential. If it shows up on any surface below, the
// masking a failed turn gets has a hole.
const CANARY = 'synthetic-canary-credential-7d3f9a';

test('a stored secret a failing provider quotes stays out of the log, the events, the stream and the dashboard', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A primary with a fallback, so the turn takes every path a provider's
  // error text travels: the switch warning, then the failed turn.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'model-p',
    fallbackModel: 'model-f',
  }));
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({
    named: { shared: { 'canary.apiKey': CANARY } },
  }), { mode: 0o600 });

  // Both models reject the call and quote the stored secret back, the way a
  // proxy or a plugin's upstream that was handed it might.
  const called: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    called.push(body.model ?? '');
    return new Response(
      JSON.stringify({ error: { message: `upstream rejected the key ${CANARY}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  // What `stratus serve` writes to the daemon log: the gateway's own lines,
  // and a line for every event on the bus.
  const logLines: string[] = [];
  const busEvents: string[] = [];
  const harness = await startApi({
    home,
    env: { processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl },
    gateway: { warn: (line: string) => { logLines.push(line); }, log: (line: string) => { logLines.push(line); } },
  });
  harness.gateway.bus.subscribe((event) => { busEvents.push(JSON.stringify(event)); });
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  try {
    await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');
    const accepted = await harness.call('/api/v1/sessions/canary-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    assert.equal(accepted.status, 202);

    const failed = await settles(
      client.waitFor<{ event: { type: string; error?: string } }>(
        (frame) => (frame.event as { type?: string } | undefined)?.type === 'session.failed',
        'the failure frame',
      ),
      'the failed turn',
    );

    // The test proves nothing unless the secret really was quoted on both
    // paths: both models answered, the switch was logged, and the failure
    // says something was masked.
    assert.deepEqual(called, ['model-p', 'model-f']);
    assert.ok(logLines.some((line) => /default model failed .*using the fallback model/.test(line)), logLines.join('\n'));
    assert.match(failed.event.error ?? '', /\[redacted\]/);

    const sessionRead = await (await harness.call('/api/v1/sessions/canary-1')).text();
    const sessionList = await (await harness.call('/api/v1/sessions')).text();
    const surfaces: Record<string, string> = {
      'the daemon log': logLines.join('\n'),
      'the bus events': busEvents.join('\n'),
      'the /api/v1/events stream': client.frames.map((frame) => JSON.stringify(frame)).join('\n'),
      "the dashboard's session read": sessionRead,
      "the dashboard's session list": sessionList,
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(CANARY), `${surface} shows the stored secret:\n${text}`);
    }
  } finally {
    client.close();
    await harness.stop();
  }
});
