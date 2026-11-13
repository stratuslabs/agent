// Test-only plugin for scripts/release-smoke. Never published: it lives
// outside packages/ so pack.mjs does not see it, and the smoke run installs
// it beside the packed release from this directory.
//
// The `smoke` provider is a script, not a model: a user message holding a
// JSON object `{ "tool": "<name>", "input": { ... } }` becomes exactly that
// tool call, and the tool's result comes back as one line,
// `SMOKE_RESULT <json>`, which the runner parses. Anything else (a
// scheduled firing's prompt, say) is answered `SMOKE_TEXT <prompt>`. A
// message that starts `SMOKE_WAIT <ms>` is answered that much later (at
// most 10 seconds), so a check can see the turn still running.
//
// `smoke.credential` reports whether the named credential `smoke.token`
// reached it through the agent's allowlist, as a SHA-256 of the value so
// the value itself never lands in a transcript or a log.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const CREDENTIAL = 'smoke.token';
const WAIT = /^SMOKE_WAIT (\d+)\b/;

const lastUserText = (session) => {
  const message = [...session.messages].reverse().find((entry) => entry.role === 'user');
  return typeof message?.content === 'string' ? message.content : '';
};

// Lenient on purpose: a host may frame the message (a sender line, a
// channel note) around the JSON the runner sent.
const scriptedCall = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed?.tool === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// A failed command's output carries the whole sandbox profile in `args`,
// which would push the stdout and stderr the runner reads past any cap.
const summarize = (output) => {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return output ?? null;
  }
  const { args: _args, ...rest } = output;
  return rest;
};

export const createPlugin = () => ({
  name: 'release-smoke',
  setup(context) {
    if (!context.providers) {
      throw new Error('This host hands plugins no provider handle, so the release smoke provider cannot register.');
    }
    context.providers.register({
      name: 'smoke',
      streams: false,
      create() {
        return {
          name: 'smoke',
          async generate({ session, signal }) {
            const last = session.messages.at(-1);
            if (last?.role === 'tool') {
              const result = last.toolResult;
              // Flattened and capped, so the line stays one parseable JSON
              // object however much a command printed.
              const line = JSON.stringify({
                tool: result?.toolName,
                ok: result?.ok === true,
                text: JSON.stringify({ error: result?.error, output: summarize(result?.output) }).slice(0, 8000),
              });
              return { parts: [{ type: 'text', text: `SMOKE_RESULT ${line}` }] };
            }
            const text = lastUserText(session);
            const wait = WAIT.exec(text);
            if (wait) {
              // The turn's abort ends the wait, as a provider must.
              await sleep(Math.min(Number(wait[1]), 10_000), undefined, { signal });
            }
            const call = scriptedCall(text);
            if (!call) {
              return { parts: [{ type: 'text', text: `SMOKE_TEXT ${text.slice(0, 200)}` }] };
            }
            return {
              parts: [{ type: 'tool-call', call: { id: `${session.id}:smoke:${session.messages.length}`, toolName: call.tool, input: call.input ?? {} } }],
            };
          },
        };
      },
    });
    context.tools.register({
      name: 'smoke.credential',
      description: 'Release smoke check: whether the smoke.token credential reaches this tool, as a SHA-256 of its value.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      risk: 'safe',
      async execute(_input, session) {
        if (!context.credentials) {
          throw new Error('This host hands plugins no credential resolver.');
        }
        const value = await context.credentials.resolve(session.agent, CREDENTIAL);
        return value === undefined
          ? { present: false }
          : { present: true, sha256: createHash('sha256').update(value).digest('hex') };
      },
    });
  },
});
