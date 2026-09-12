// The reading-the-room eval: see README.md beside this file.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRunner, EventBus, InMemorySessionStore, latestTurnReply, type AgentDefinition } from '@stratusagent/core';
import { parseSoul } from '@stratusagent/agents';
import { createRuntimeProvider, resolveRuntimeConfig } from '@stratusagent/state';

interface LabelledMessage {
  speaker: string;
  text: string;
  /** The message named the agent: an addressed turn, no label needed. */
  addressed?: boolean;
  /** What a colleague in the agent's position would do with an untagged message. */
  expect?: 'speak' | 'silent';
}

interface Corpus {
  agent: { name: string; instructions: string };
  threads: Array<{ id: string; title: string; messages: LabelledMessage[] }>;
}

interface Tally {
  judged: number;
  falseSpeech: number;
  falseSilence: number;
}

const FALSE_SPEECH_WEIGHT = 3;

const score = (tally: Tally): number => FALSE_SPEECH_WEIGHT * tally.falseSpeech + tally.falseSilence;

const argValue = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const main = async (): Promise<void> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(await readFile(path.join(here, 'threads.json'), 'utf8')) as Corpus;

  const soulPath = argValue('--soul');
  const agent: AgentDefinition = soulPath
    ? parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath }).agent
    : { id: 'ava', name: corpus.agent.name, instructions: corpus.agent.instructions };
  const runtime = await resolveRuntimeConfig(soulPath ? { soul: soulPath } : {});
  const provider = createRuntimeProvider(runtime);
  const runner = new AgentRunner({ provider, store: new InMemorySessionStore(), bus: new EventBus() });

  const total: Tally = { judged: 0, falseSpeech: 0, falseSilence: 0 };
  for (const thread of corpus.threads) {
    const tally: Tally = { judged: 0, falseSpeech: 0, falseSilence: 0 };
    const sessionId = `eval:${thread.id}`;
    let first = true;
    const lines: string[] = [];
    for (const message of thread.messages) {
      const userMessage = `${message.speaker}: ${message.text}`;
      const addressed = message.addressed === true;
      const session = first
        ? await runner.run({ sessionId, agent, userMessage, addressed })
        : await runner.resume({ sessionId, userMessage, addressed });
      first = false;
      const reply = latestTurnReply(session);
      if (addressed || message.expect === undefined) {
        continue;
      }
      tally.judged += 1;
      const spoke = reply !== undefined;
      const wrong = spoke ? message.expect === 'silent' : message.expect === 'speak';
      if (wrong && spoke) {
        tally.falseSpeech += 1;
      }
      if (wrong && !spoke) {
        tally.falseSilence += 1;
      }
      const mark = wrong ? '✗' : '✓';
      const said = spoke ? `spoke: ${reply.replace(/\s+/g, ' ').slice(0, 80)}` : 'silent';
      lines.push(`  ${mark} [${message.expect}] ${userMessage.slice(0, 60)} → ${said}`);
    }
    total.judged += tally.judged;
    total.falseSpeech += tally.falseSpeech;
    total.falseSilence += tally.falseSilence;
    console.log(`${thread.id} — ${thread.title}`);
    console.log(lines.join('\n'));
    console.log(`  false speech ${tally.falseSpeech}, false silence ${tally.falseSilence}, score ${score(tally)} over ${tally.judged}\n`);
  }
  console.log(
    `TOTAL: false speech ${total.falseSpeech}/${total.judged}, false silence ${total.falseSilence}/${total.judged}, `
    + `score ${score(total)} (false speech ×${FALSE_SPEECH_WEIGHT})`,
  );
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
