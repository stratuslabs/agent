// The OpenAI Responses adapter: the `responses` wire, streamed. Stateless
// on purpose (`store: false`, the whole transcript every request, the
// system prompt as `instructions`), which is what Sign in with ChatGPT
// requires of a third-party app and what keeps the kernel's transcript the
// only record of the conversation.
import {
  ContextOverflowError,
  redactedError,
  redactSecrets,
  isReplyOptionalTurn,
  transcriptOf,
  droppedImageNote,
  imagesWithinReplayBudget,
  omitImage,
  renderSystemPromptSections,
  renderToolResultContent,
  uncachedInputTokens,
  type ImageAttachment,
  type ImageReplayBudget,
  type JsonObject,
  type Message,
  type ModelProvider,
  type ProviderCallUsage,
  type ProviderDelta,
  type ProviderRequest,
  type ToolCall,
  type ToolDescriptor,
  OVERHEARD_IMAGES_NOTE,
  messagesAfterOverheard,
  promptTextOf,
} from '@stratusagent/core';
import { createProviderResponseBuilder, defineProvider } from './provider.ts';
import { latestUserMessageOf } from './harness.ts';
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  asSent,
  createOpenAICompatibleToolNameMapping,
  headerSecrets,
  overflowedContext,
  toWireToolName,
  withoutTrailingSlashes,
  type OpenAICompatibleToolNameMapping,
} from './chat-completions.ts';

export interface OpenAIResponsesProviderConfig {
  model: string;
  /**
   * Sent as `authorization: Bearer …`: an API key, or a function that gives
   * a sign-in's current access token. The function is asked before every
   * request sent, with that request's signal, so a turn that outlives an
   * hour-long token sends the refreshed one. What it throws fails the turn
   * in its own words, before anything is sent.
   */
  apiKey: string | ((signal: AbortSignal | undefined) => string | Promise<string>);
  /** Where `/responses` lives. Default `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** The provider name usage and errors are attributed to. Default `openai`. */
  name?: string;
  systemPrompt?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * Upper bound on one request, from sending it to the end of its stream,
   * caller signal or not. 0 disables. Default 5 minutes.
   */
  requestTimeoutMs?: number;
  /** As on the chat-completions adapter: how much of the transcript's images one request may replay. */
  imageReplayBudget?: ImageReplayBudget;
  /**
   * Sends the tools inside one namespace instead of at the top level, as
   * Sign in with ChatGPT requires. Calls come back by registry name whether
   * or not the endpoint echoes the namespace.
   */
  toolNamespace?: { name: string; description: string };
}

type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' };

type InputItem =
  | { role: 'user' | 'assistant'; content: string | InputContent[] }
  | { type: 'function_call'; call_id: string; namespace?: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | InputContent[] };

interface OutputItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ResponseObject {
  status?: string;
  model?: string;
  output?: OutputItem[];
  error?: { code?: string | null; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    /** Both are a SUBSET of `input_tokens`. */
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
  } | null;
}

interface StreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  item?: OutputItem;
  response?: ResponseObject;
  code?: string | null;
  message?: string;
}

export const createOpenAIResponsesProvider = ({
  model,
  apiKey,
  baseUrl = DEFAULT_OPENAI_BASE_URL,
  name = 'openai',
  systemPrompt,
  headers = {},
  fetch: fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  imageReplayBudget,
  toolNamespace,
}: OpenAIResponsesProviderConfig): ModelProvider => {
  // The pattern the endpoint holds a namespace to.
  if (toolNamespace !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(toolNamespace.name)) {
    throw new Error(`A tool namespace is 1 to 128 letters, digits, _ or -, so ${JSON.stringify(toolNamespace.name)} cannot be one.`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for the OpenAI Responses provider.');
  }
  const url = `${withoutTrailingSlashes(baseUrl)}/responses`;
  // Copied once, so what is sent and what is redacted stay the same values.
  const configuredHeaders: Record<string, string> = { ...headers };
  const secrets = [...(typeof apiKey === 'string' ? asSent(apiKey) : []), ...headerSecrets(configuredHeaders)];

  const provider = defineProvider({
    name,
    async generate(request) {
      const toolNames = createOpenAICompatibleToolNameMapping(request.tools);
      const tools = createTools(request.tools, toolNames, toolNamespace);
      const instructions = renderSystemPromptSections(request, {
        ...(systemPrompt ? { preamble: systemPrompt } : {}),
      }).join('\n\n');

      // The timeout covers the stream as well as the headers: a body that
      // stops arriving must not pin the turn open any more than a request
      // that never answers.
      const timeout = requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined;
      const signal = timeout && request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout ?? request.signal;

      // A getter's tokens are known only once asked for, so they are
      // redacted here; the key and headers by the wrapper below.
      const tokens: string[] = [];
      try {
        // Sent at most twice, as on the chat-completions adapter: once as
        // built, and once with no images at all if the endpoint refused
        // one. The retry sends none rather than what is left, because
        // omitting the refused images frees replay budget an older image
        // would otherwise take.
        for (let imagesRetried = false; ;) {
          const { input, sent } = createInput(request, toolNames, !imagesRetried, imageReplayBudget, toolNamespace?.name);
          const token = typeof apiKey === 'string' ? apiKey : await apiKey(signal);
          tokens.push(...asSent(token));
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              authorization: `Bearer ${token}`,
              ...configuredHeaders,
            },
            body: JSON.stringify({
              model,
              ...(instructions.length > 0 ? { instructions } : {}),
              input,
              ...(tools.length > 0 ? { tools } : {}),
              ...(tools.length > 0 && request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
              store: false,
              stream: true,
            }),
            ...(signal ? { signal } : {}),
          });

          if (!response.ok) {
            const { reported, payload } = await readErrorBody(response);
            const message = redactSecrets(reported, secrets);
            // Overflow first, then images, for the chat-completions
            // adapter's reasons: only a 400 is the request itself being
            // wrong, and the image recovery is the destructive one.
            if (response.status === 400 && overflowedContext(payload, reported)) {
              throw new ContextOverflowError(`The conversation no longer fits ${model}'s context window (${message}).`);
            }
            if (response.status === 400 && sent.length > 0 && !imagesRetried && /image/i.test(`${payload.error?.code ?? ''} ${reported}`)) {
              for (const image of sent) {
                omitImage(image);
              }
              imagesRetried = true;
              continue;
            }
            throw new Error(message);
          }
          if (response.body === null) {
            throw new Error('Provider returned no response stream.');
          }
          return await readResponse(response.body, request, toolNames, name, model);
        }
      } catch (error) {
        // A timed-out request is a provider failure (fallback-eligible),
        // never mistaken for the caller's own cancellation.
        if (timeout?.aborted && !request.signal?.aborted) {
          throw new Error(`Provider request timed out after ${requestTimeoutMs}ms: ${name}`);
        }
        throw redactedError(error, tokens);
      }
    },
  });

  // Whatever leaves `generate` is stored, logged and posted, and the
  // endpoint's words reach it from the stream as well as the error branch.
  return {
    ...provider,
    async generate(request) {
      try {
        return await provider.generate(request);
      } catch (error) {
        throw redactedError(error, secrets);
      }
    },
  };
};

/**
 * Reads the stream to its end: forwards progress to `onDelta` as it
 * arrives, then builds the answer from the finished items. Usage is
 * reported before any failure is thrown, because a failed response was
 * still billed.
 */
const readResponse = async (
  body: ReadableStream<Uint8Array>,
  request: ProviderRequest,
  toolNames: OpenAICompatibleToolNameMapping,
  providerName: string,
  model: string,
) => {
  const onDelta = request.onDelta;
  const callNames = new Map<string, string>();
  // Finished items by position. A backend may also repeat them all in the
  // final event's `output`; that list is used only when none came singly.
  const done = new Map<number, OutputItem>();
  let final: { type: string; response: ResponseObject } | undefined;

  for await (const event of serverSentEvents(body)) {
    const type = event.type;
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      final = { type, response: event.response ?? {} };
      break;
    }
    if (type === 'error') {
      throw streamError('Provider stream failed', event.code, event.message, model);
    }
    if (type === 'response.output_item.done' && event.item && typeof event.output_index === 'number') {
      done.set(event.output_index, event.item);
      continue;
    }
    if (!onDelta) {
      continue;
    }
    const delta = progressOf(event, callNames, toolNames);
    if (delta) {
      await onDelta(delta);
    }
  }

  if (!final) {
    throw new Error('The provider\'s stream ended before the response finished.');
  }
  const { response } = final;
  const usage = usageOf(response, providerName, model);
  if (usage) {
    request.onUsage?.(usage);
  }

  if (final.type === 'response.failed') {
    throw streamError('Provider response failed', response.error?.code, response.error?.message, model);
  }
  if (final.type === 'response.incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    // Cut off, so what arrived is a fragment; a tool call's arguments
    // would stop mid-JSON. No `max_output_tokens` is sent, so the cap is
    // the endpoint's own.
    throw new Error(reason === 'max_output_tokens'
      ? 'The provider stopped at its output cap before finishing (max_output_tokens), so the reply is a fragment and was not delivered. Ask for a shorter answer.'
      : `The provider stopped before finishing (${reason}), so the reply was not delivered.`);
  }

  const items = done.size > 0
    ? [...done.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
    : response.output ?? [];
  // In the model's order, the order the deltas already showed: words said
  // before a call stay before it. Separate messages next to each other
  // (commentary, then the answer) stay separate paragraphs rather than
  // running into one another.
  const builder = createProviderResponseBuilder();
  const refusals: string[] = [];
  let afterText = false;
  for (const [index, item] of items.entries()) {
    if (item.type === 'message') {
      const text = (item.content ?? [])
        .map((part) => (part.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
        .join('');
      if (text.length > 0) {
        builder.addText(afterText ? `\n\n${text}` : text);
        afterText = true;
      }
      for (const part of item.content ?? []) {
        if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0) {
          refusals.push(part.refusal);
        }
      }
    } else if (item.type === 'function_call') {
      builder.addToolCall(toolCallOf(item, index, toolNames));
      afterText = false;
    }
  }

  const result = builder.done();
  if (result.parts.length === 0) {
    if (refusals.length > 0) {
      throw new Error(`Provider refused the request: ${refusals.join(' ')}`);
    }
    // Nothing said is an answer only a turn nobody asked for may give.
    if (!isReplyOptionalTurn(request.session)) {
      throw new Error('Provider returned an empty response.');
    }
  }
  return usage ? { ...result, usage } : result;
};

/**
 * A failure reported inside the stream. An overflow is recognized by its
 * code alone: the prose match is kept for a 400, where the request itself
 * was refused.
 */
const streamError = (prefix: string, code: string | null | undefined, message: string | undefined, model: string): Error => {
  const text = `${prefix} (${code ?? 'no code'}): ${message ?? 'no message'}`;
  return code === 'context_length_exceeded'
    ? new ContextOverflowError(`The conversation no longer fits ${model}'s context window (${text}).`)
    : new Error(text);
};

/** What an event says about progress, for a renderer and an activity watchdog. */
const progressOf = (
  event: StreamEvent,
  callNames: Map<string, string>,
  toolNames: OpenAICompatibleToolNameMapping,
): ProviderDelta | undefined => {
  const type = event.type ?? '';
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    return { type: 'text', text: event.delta };
  }
  if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
    const wireName = event.item.name ?? '';
    const toolName = toolNames.fromWire.get(wireName) ?? wireName;
    if (event.item.id) {
      callNames.set(event.item.id, toolName);
    }
    return { type: 'tool-call', toolName };
  }
  if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
    const toolName = event.item_id === undefined ? undefined : callNames.get(event.item_id);
    return toolName === undefined ? undefined : { type: 'tool-call', toolName, inputFragment: event.delta };
  }
  // Reasoning is never carried, only that it is happening.
  if ((type === 'response.output_item.added' && event.item?.type === 'reasoning') || type.startsWith('response.reasoning')) {
    return { type: 'thinking' };
  }
  return undefined;
};

const toolCallOf = (item: OutputItem, index: number, toolNames: OpenAICompatibleToolNameMapping): ToolCall => {
  const wireName = item.name ?? '';
  const name = toolNames.fromWire.get(wireName) ?? wireName;
  const rawArguments = item.arguments ?? '';
  let input: JsonObject;
  try {
    const parsed: unknown = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    input = parsed as JsonObject;
  } catch (error) {
    throw new Error(
      `Provider returned invalid arguments for tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { id: item.call_id ?? item.id ?? `tool-call-${index + 1}`, toolName: name, input };
};

/**
 * The response's tokens in the kernel's four buckets, or undefined when it
 * reported none. `input_tokens` counts cached reads and cache writes too,
 * while `inputTokens` is the full-rate bucket alone.
 */
const usageOf = (response: ResponseObject, providerName: string, model: string): ProviderCallUsage | undefined => {
  const usage = response.usage ?? undefined;
  const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  const input = number(usage?.input_tokens);
  const output = number(usage?.output_tokens);
  const cacheRead = number(usage?.input_tokens_details?.cached_tokens);
  const cacheWrite = number(usage?.input_tokens_details?.cache_write_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }
  return {
    provider: providerName,
    model: typeof response.model === 'string' && response.model.length > 0 ? response.model : model,
    ...(input !== undefined ? { inputTokens: uncachedInputTokens(input, cacheRead, cacheWrite) } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
};

const readErrorBody = async (response: Response): Promise<{
  reported: string;
  payload: { error?: { code?: string; message?: unknown } };
}> => {
  const rawText = await response.text();
  let payload: { error?: { code?: string; message?: unknown } } = {};
  try {
    const parsed: unknown = rawText.length > 0 ? JSON.parse(rawText) : undefined;
    // Only an object can be the error envelope; any other JSON is shown as
    // it came, like a body that is not JSON at all.
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as typeof payload;
    }
  } catch {
    // Not JSON: a proxy's page, shown as it came.
  }
  const reportedMessage = payload.error?.message;
  const reported = typeof reportedMessage === 'string'
    ? reportedMessage
    : reportedMessage != null
      ? JSON.stringify(reportedMessage)
      : rawText.length > 0 ? rawText : `Provider request failed with status ${response.status}`;
  return { reported, payload };
};

const LINE_END = /\r\n|\r|\n/;

/**
 * The JSON events of a `text/event-stream` body. Only `data` lines matter
 * here (the event's own `type` names it), and an event is dispatched on the
 * blank line that ends it. Leaving early cancels the body, so the
 * connection is not held for a response nobody is reading.
 */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A `\r` at the end of a read may be the first half of `\r\n`; held
      // back, so the `\n` that follows is not taken for a blank line.
      const held = !done && buffer.endsWith('\r') ? '\r' : '';
      const lines = (held ? buffer.slice(0, -1) : buffer).split(LINE_END);
      buffer = `${done ? '' : lines.pop() ?? ''}${held}`;
      for (const line of lines) {
        if (line.length === 0) {
          if (data.length > 0) {
            const text = data.join('\n');
            data = [];
            if (text !== '[DONE]') {
              yield parseEvent(text);
            }
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        }
      }
      if (done) {
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

const parseEvent = (text: string): StreamEvent => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as StreamEvent;
  } catch {
    throw new Error('Provider sent a stream event that is not a JSON object.');
  }
};

type FunctionTool = { type: 'function'; name: string; description?: string; parameters: JsonObject };

/** The request's tools, inside `namespace` when one is set. A namespace may not be empty, so no tools means none sent. */
const createTools = (
  tools: ToolDescriptor[] | undefined,
  toolNames: OpenAICompatibleToolNameMapping,
  namespace: { name: string; description: string } | undefined,
): Array<FunctionTool | { type: 'namespace'; name: string; description: string; tools: FunctionTool[] }> => {
  const functions = (tools ?? []).map((tool): FunctionTool => ({
    type: 'function',
    name: toWireToolName(tool.name, toolNames),
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }));
  return namespace === undefined || functions.length === 0
    ? functions
    : [{ type: 'namespace', name: namespace.name, description: namespace.description, tools: functions }];
};

const imageInput = (image: ImageAttachment, replayed: ReadonlySet<ImageAttachment>): InputContent =>
  (replayed.has(image)
    ? { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}`, detail: 'auto' }
    : { type: 'input_text', text: droppedImageNote(image) });

/**
 * The transcript as Responses input items. Each assistant tool call is its
 * own `function_call` item and each result a `function_call_output` that
 * carries the call's images itself, so nothing needs merging or moving.
 * System-role messages are skipped: what the agent is told about itself
 * travels as `instructions`, and Sign in with ChatGPT refuses system items.
 */
const createInput = (
  request: ProviderRequest,
  toolNames: OpenAICompatibleToolNameMapping,
  images: boolean,
  imageReplayBudget: ImageReplayBudget | undefined,
  /** The namespace the tools are declared in, which an earlier call is replayed under too. */
  namespace: string | undefined,
): { input: InputItem[]; sent: ImageAttachment[] } => {
  const transcript = transcriptOf(request);
  const replayed: ReadonlySet<ImageAttachment> = images
    ? imagesWithinReplayBudget(transcript, imageReplayBudget)
    : new Set();
  const sent = transcript.flatMap((message) => (message.images ?? []).filter((image) => replayed.has(image)));
  const latest = latestUserMessageOf(transcript);
  const afterOverheard = messagesAfterOverheard(transcript);
  const input: InputItem[] = [];

  for (const message of transcript) {
    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          ...(namespace !== undefined ? { namespace } : {}),
          name: toWireToolName(call.toolName, toolNames),
          arguments: JSON.stringify(call.input),
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      const result = message.toolResult;
      if (!result) {
        continue;
      }
      const text = renderToolResultContent(result);
      const toolImages = message.images ?? [];
      input.push({
        type: 'function_call_output',
        call_id: result.callId,
        output: toolImages.length === 0
          ? text
          : [{ type: 'input_text', text }, ...toolImages.map((image) => imageInput(image, replayed))],
      });
      continue;
    }
    if (message.role === 'user') {
      input.push({ role: 'user', content: userContent(message, replayed, message === latest, afterOverheard.has(message)) });
    }
  }
  return { input, sent };
};

const userContent = (
  message: Message,
  replayed: ReadonlySet<ImageAttachment>,
  latest: boolean,
  afterOverheard: boolean,
): string | InputContent[] => {
  const text = promptTextOf(message, { latest, afterOverheard });
  if (message.images === undefined || message.images.length === 0) {
    return text;
  }
  return [
    ...(text.length > 0 ? [{ type: 'input_text' as const, text }] : []),
    // An overheard message's images are labeled as its own (card 625).
    ...(message.overheard === true ? [{ type: 'input_text' as const, text: OVERHEARD_IMAGES_NOTE }] : []),
    ...message.images.map((image) => imageInput(image, replayed)),
  ];
};
