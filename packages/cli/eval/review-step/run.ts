// The review-step eval: see README.md beside this file.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  SENDER_TRUST_METADATA_KEY,
  ToolRegistry,
  type AgentDefinition,
} from '@stratusagent/core';
import { createRuntimeProvider, resolveRuntimeConfig, type RuntimeConfig } from '@stratusagent/state';

import { evalTools, formatSummary, GROUPS, loadCorpus, reviewCase, summarize, type AskModel, type CaseResult } from './eval.ts';

/** The policy's default for `approvals.review.timeoutMs`: a slower review counts as failed. */
const DEFAULT_TIMEOUT_MS = 20_000;

const argValues = (flag: string): string[] => {
  const values: string[] = [];
  for (let at = process.argv.indexOf(flag); at >= 0; at = process.argv.indexOf(flag, at + 1)) {
    const value = process.argv[at + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value.`);
    }
    values.push(value);
  }
  return values;
};

const argValue = (flag: string): string | undefined => argValues(flag).at(-1);

/**
 * Asks the configured provider the way the daemon's reviewer does: its own
 * runner with no tools, one model call, the agent's primary model or the
 * one named (`approvals.review.model`), never its fallback, and the case
 * labeled as external content.
 */
const modelAsker = (config: RuntimeConfig): AskModel => {
  const provider = createRuntimeProvider(config, () => {}, async () => {
    throw new Error('The reviewer has no tools.');
  }, 1);
  const runner = new AgentRunner({ provider, tools: new ToolRegistry(), store: new InMemorySessionStore(), bus: new EventBus(), maxTurns: 1 });
  const model = 'model' in config && typeof config.model === 'string' ? config.model : undefined;
  return async (instructions, prompt, signal) => {
    const agent: AgentDefinition = { id: 'review-eval', name: 'Reviewer', instructions, tools: [], skills: [], delegates: [] };
    const session = await runner.run({
      sessionId: `review:${randomUUID()}`,
      agent,
      userMessage: prompt,
      metadata: {
        provider: config.provider,
        ...(model !== undefined ? { model } : {}),
        [SENDER_TRUST_METADATA_KEY]: 'external',
      },
      signal,
    });
    if (session.status === 'failed') {
      throw new Error(session.lastError ?? 'the model call failed');
    }
    const reply = [...session.messages].reverse().find((message) => message.role === 'assistant' && message.content.trim().length > 0);
    // Every input token the call was billed for, cached or not.
    const usage = session.usage ?? [];
    const sum = (pick: (record: (typeof usage)[number]) => number | undefined): number | undefined =>
      usage.length === 0 ? undefined : usage.reduce((total, record) => total + (pick(record) ?? 0), 0);
    const inputTokens = sum((record) => (record.inputTokens ?? 0) + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0));
    const outputTokens = sum((record) => record.outputTokens);
    return {
      text: reply?.content ?? '',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  };
};

const main = async (): Promise<void> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpus = loadCorpus(await readFile(path.join(here, 'cases.json'), 'utf8'));
  const only = argValues('--case');
  const group = argValue('--group');
  if (group !== undefined && !(GROUPS as readonly string[]).includes(group)) {
    throw new Error(`--group must be one of ${GROUPS.join(', ')}.`);
  }
  const unknown = only.filter((id) => !corpus.cases.some((entry) => entry.id === id));
  if (unknown.length > 0) {
    throw new Error(`No case ${unknown.join(', ')} in cases.json.`);
  }
  const cases = corpus.cases.filter((entry) => (only.length === 0 || only.includes(entry.id)) && (group === undefined || entry.group === group));
  const timeoutMs = Number(argValue('--timeout-ms') ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive whole number of milliseconds.');
  }

  const soul = argValue('--soul');
  const resolved = await resolveRuntimeConfig(soul !== undefined ? { soul } : {});
  // The demo provider answers from a script, so a pass against it would be
  // a pass nobody earned. Refuse, and say what is missing.
  if (resolved.provider === 'demo') {
    console.error('Not run: no model is configured (the demo provider would answer). Run `stratus setup`, or set STRATUS_PROVIDER and a key, then run this again.');
    process.exitCode = 2;
    return;
  }
  const { fallback: _fallback, ...primary } = resolved as RuntimeConfig & { fallback?: unknown };
  const model = argValue('--model');
  const config = (model !== undefined ? { ...primary, model } : primary) as RuntimeConfig;
  const label = `${config.provider}${'model' in config && config.model ? ` ${config.model}` : ''}`;

  const tools = await evalTools();
  const ask = modelAsker(config);
  const results: CaseResult[] = [];
  for (const [index, entry] of cases.entries()) {
    const result = await reviewCase(entry, tools, ask, { timeoutMs });
    results.push(result);
    console.error(`[${index + 1}/${cases.length}] ${entry.id}: ${result.verdict}${result.failed !== undefined ? ` (review failed: ${result.failed})` : ''}`);
  }
  const summary = summarize(results);
  console.log(formatSummary(summary, label));

  const out = argValue('--json');
  if (out !== undefined) {
    await writeFile(out, `${JSON.stringify({ model: label, timeoutMs, ranAt: new Date().toISOString(), ...summary }, null, 2)}\n`);
    console.log(`\nWrote ${out}`);
  }
  if (!summary.meetsBar) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
