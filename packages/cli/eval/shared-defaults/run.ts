// The shared-defaults eval: see README.md beside this file.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRunner, EventBus, InMemorySessionStore, latestTurnReply, type AgentDefinition, type JsonObject } from '@stratusagent/core';
import { parseSoul } from '@stratusagent/agents';
import { createRuntimeProvider, describeServingModel, resolveRuntimeConfig } from '@stratusagent/state';

type Check =
  | { kind: 'noBritish' }
  | { kind: 'contains'; text: string }
  | { kind: 'matches'; pattern: string }
  | { kind: 'notMatches'; pattern: string }
  | { kind: 'maxChars'; value: number }
  | { kind: 'minChars'; value: number }
  | { kind: 'minListItems'; value: number };

interface Corpus {
  agent: { name: string; instructions: string };
  britishSpellings: string;
  cases: Array<{
    id: string;
    title: string;
    turns: Array<{ user: string; checks: Check[] }>;
    metadata?: JsonObject;
  }>;
}

// JSON cannot carry regex flags, so a pattern may open with `(?i)`.
const regex = (pattern: string): RegExp =>
  pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);

const failureOf = (check: Check, reply: string, british: RegExp): string | undefined => {
  switch (check.kind) {
    case 'noBritish': {
      const found = reply.match(new RegExp(british.source, 'gi'));
      return found ? `British spelling: ${[...new Set(found)].join(', ')}` : undefined;
    }
    case 'contains':
      return reply.includes(check.text) ? undefined : `missing ${JSON.stringify(check.text)}`;
    case 'matches':
      return regex(check.pattern).test(reply) ? undefined : `does not match ${check.pattern}`;
    case 'notMatches':
      return regex(check.pattern).test(reply) ? `matches ${check.pattern}` : undefined;
    case 'maxChars':
      return reply.length <= check.value ? undefined : `${reply.length} characters, over ${check.value}`;
    case 'minChars':
      return reply.length >= check.value ? undefined : `${reply.length} characters, under ${check.value}`;
    case 'minListItems': {
      const items = reply.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)]|\[ \])\s+\S/.test(line)).length;
      return items >= check.value ? undefined : `${items} list items, under ${check.value}`;
    }
  }
};

const argValue = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const main = async (): Promise<void> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8')) as Corpus;
  const british = new RegExp(corpus.britishSpellings, 'i');

  const soulPath = argValue('--soul');
  const agent: AgentDefinition = soulPath
    ? parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath }).agent
    : { id: 'ava', name: corpus.agent.name, instructions: corpus.agent.instructions };
  const config = await resolveRuntimeConfig(soulPath ? { soul: soulPath } : {});
  // The demo provider answers from a script, so a pass against it would be
  // a pass nobody earned. Refuse, and say what is missing.
  if (config.provider === 'demo') {
    console.error('Not run: no model is configured (the demo provider would answer). Run `stratus setup`, or set STRATUS_PROVIDER and a key, then run this again.');
    process.exitCode = 2;
    return;
  }
  const provider = createRuntimeProvider(config);
  const runner = new AgentRunner({ provider, store: new InMemorySessionStore(), bus: new EventBus() });
  // The same runtime facts the daemon hands a turn, so the prompt under
  // test is the one production sends.
  const runtime = {
    ...(config.language !== undefined ? { language: config.language } : {}),
    model: describeServingModel(config, false),
  };

  let passed = 0;
  let failed = 0;
  for (const scenario of corpus.cases) {
    const sessionId = `eval:${scenario.id}`;
    const lines: string[] = [];
    let ok = true;
    for (const [index, turn] of scenario.turns.entries()) {
      const session = index === 0
        ? await runner.run({ sessionId, agent, userMessage: turn.user, runtime, ...(scenario.metadata ? { metadata: scenario.metadata } : {}) })
        : await runner.resume({ sessionId, userMessage: turn.user, runtime });
      const reply = latestTurnReply(session) ?? '';
      const failures = turn.checks.map((check) => failureOf(check, reply, british)).filter((failure) => failure !== undefined);
      ok &&= failures.length === 0;
      lines.push(`  turn ${index + 1}: ${failures.length === 0 ? 'ok' : failures.join('; ')}`);
      lines.push(`    → ${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    if (ok) {
      passed += 1;
    } else {
      failed += 1;
    }
    console.log(`${ok ? '✓' : '✗'} ${scenario.id} — ${scenario.title}`);
    console.log(lines.join('\n'));
  }
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed, on ${config.provider}${'model' in config && config.model ? ` ${config.model}` : ''}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
