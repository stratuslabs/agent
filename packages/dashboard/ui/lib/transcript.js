// What the agent view's transcript shows, worked out without the DOM: which
// stored messages get a bubble, what a tool result reads as, and where the
// live lines and the streaming reply go. `views/agent-transcript.js` turns
// these items into nodes.

/**
 * Session ids are addresses, not names — a Slack thread key or a UUID. Show
 * enough to tell two apart without letting one eat the row it sits in.
 */
export const shortId = (id) => (id.length <= 28 ? id : `${id.slice(0, 12)}…${id.slice(-8)}`);

const TOOL_OUTPUT_LIMIT = 260;

/**
 * A tool result, as a person would want to read it.
 *
 * The stored message is the raw result envelope — call id, tool name, ok
 * flag, output — because that is what the model consumed. Rendering it
 * verbatim puts a wall of JSON with an internal id in the middle of a
 * conversation, so this pulls out the part a reader is actually asking about
 * and leaves the rest to the transcript in the store.
 */
export const summariseTool = (content) => {
  const text = String(content ?? '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text;
  }
  if (typeof parsed !== 'object' || parsed === null || !parsed.toolName) {
    return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text;
  }
  const outcome = parsed.ok === false
    ? `failed — ${parsed.error ?? 'no reason given'}`
    : typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output);
  const body = String(outcome ?? '');
  return `${parsed.toolName} → ${body.length > TOOL_OUTPUT_LIMIT ? `${body.slice(0, TOOL_OUTPUT_LIMIT)}…` : body}`;
};

/** A stored tool result, from its structured field or, for an older record, its JSON text. */
const resultOf = (message) => {
  if (message.toolResult && typeof message.toolResult === 'object') {
    return message.toolResult;
  }
  try {
    const parsed = JSON.parse(String(message.content ?? ''));
    if (parsed && typeof parsed === 'object' && parsed.toolName) {
      return parsed;
    }
  } catch {
    // Not JSON: plain text output from a tool with no envelope.
  }
  return { toolName: 'tool', ok: true, output: String(message.content ?? '') };
};

/**
 * The input a result's call was made with: the latest call with its id and
 * tool before it, looking no further back than the user message that began
 * its turn, since an endpoint that numbers calls per response reuses ids.
 */
const inputFor = (messages, index, result) => {
  for (let at = index - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message.role === 'user') {
      return undefined;
    }
    const call = (message.toolCalls ?? []).find((candidate) => candidate.id === result.callId && candidate.toolName === result.toolName);
    if (call) {
      return call.input;
    }
  }
  return undefined;
};

/** Phases a call ends in. Older lines carry no phase and read as running. */
const ENDED = new Set(['denied', 'done', 'failed']);

/**
 * The items of one conversation, oldest first: the stored messages, then the
 * running turn's calls, then the reply still arriving.
 *
 * A tool item is one call: its tool, its input when the stored call is
 * found in the same turn, how it ended (`phase`: running, waiting, denied,
 * done or failed) with the output or error, and `line`, the call line whose
 * permission decisions show beside it — for a stored result, the finished
 * turn's line (`settled`, from `settledLines`) matched to it. A live call's
 * several lines (started, waiting, finished) fold into one item.
 */
export const transcriptItems = ({ messages, toolLines, streaming, settled }) => {
  const items = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      const result = resultOf(message);
      const input = inputFor(messages, index, result);
      items.push({
        kind: 'tool',
        toolName: result.toolName,
        ...(input !== undefined ? { input } : {}),
        phase: result.ok === false ? 'failed' : 'done',
        ...(result.ok === false
          ? { error: result.error ?? 'no reason given' }
          : { output: result.output }),
        line: settled.get(index),
      });
      continue;
    }
    if (!message.content) {
      // An assistant turn that only carried tool calls has no text to show;
      // the tool rows after it are the story.
      continue;
    }
    items.push({ kind: message.role, text: message.content });
  }
  const live = new Map();
  for (const line of toolLines) {
    const key = `${line.callId}\u0000${line.toolName}`;
    const phase = line.phase ?? 'running';
    const existing = live.get(key);
    // A call that already ended is not this one: an endpoint that numbers
    // its calls per response reuses ids within a turn, so a line after the
    // end is the next call with that id, and gets its own row.
    if (!existing || ENDED.has(existing.phase)) {
      const item = { kind: 'tool', toolName: line.toolName, phase, line };
      live.set(key, item);
      items.push(item);
      continue;
    }
    // A call's events arrive in order (waiting, then running once
    // approved, then its end), so its row shows the latest one.
    existing.phase = phase;
    if (line.decides) {
      existing.line = line;
    }
  }
  if (streaming) {
    items.push({ kind: 'assistant', text: streaming, streaming: true });
  }
  return items;
};
