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

/**
 * The bubbles of one conversation, oldest first: the stored messages, then
 * the running turn's tool lines, then the reply still arriving.
 *
 * `kind` is the bubble's class after `bubble`. A tool bubble carries `line`,
 * the call line whose decisions show beside it: for a stored result, the
 * finished turn's line `settled` (from `settledLines`) matched to it, if any.
 */
export const transcriptItems = ({ messages, toolLines, streaming, settled }) => {
  const items = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      items.push({ kind: 'tool', text: summariseTool(message.content), line: settled.get(index) });
      continue;
    }
    if (!message.content) {
      // An assistant turn that only carried tool calls has no text to show;
      // the tool bubbles beside it are the story.
      continue;
    }
    items.push({ kind: message.role, text: message.content });
  }
  for (const line of toolLines) {
    items.push({ kind: 'tool', text: line.text, line });
  }
  if (streaming) {
    items.push({ kind: 'assistant streaming', text: streaming });
  }
  return items;
};
