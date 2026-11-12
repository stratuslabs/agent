// The OpenAI-compatible adapter: the `chat/completions` wire, used by the
// built-in `openai` provider and any endpoint that speaks the same format.
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
  type ProviderRequest,
  type ToolCall,
  type ToolDescriptor,
  OVERHEARD_IMAGES_NOTE,
  messagesAfterOverheard,
  promptTextOf,
} from '@stratusagent/core';
import { createProviderResponseBuilder, defineProvider } from './provider.ts';
import { describeImageAttachments, latestUserMessageOf, userMessageText } from './harness.ts';

export interface OpenAICompatibleProviderConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  name?: string;
  systemPrompt?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * Upper bound on one HTTP request, caller signal or not — an endpoint
   * that accepts a request and never completes it must not wedge the turn
   * (and its caller's shutdown) forever. 0 disables. Default 5 minutes.
   */
  requestTimeoutMs?: number;
  /**
   * Whether the model takes images. Default true. A text-only model — the
   * usual case for a local runtime — rejects a request with an `image_url`
   * part in it, and because the image is stored with the message before the
   * provider is called, every later turn of that session would replay the
   * same part and fail the same way. Off, an image reaches the model as a
   * note naming it instead, the same one a text-only harness gets.
   */
  vision?: boolean;
  /**
   * How much of the transcript's images one request may replay, newest
   * first — decoded bytes and a count; older images past either are sent
   * as a note. Each defaults to core's constant. Lower one for an endpoint
   * with a smaller limit.
   */
  imageReplayBudget?: ImageReplayBudget;
}

interface OpenAICompatibleToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * A user turn's content on the chat-completions wire: a string when it is
 * only text, and the parts form — text plus `image_url` parts carrying
 * data URLs — when the message has images. The string form is kept for
 * the common case because some compatible servers accept only that.
 */
type OpenAICompatibleUserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAICompatibleUserContent | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAICompatibleToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonObject;
  };
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: OpenAICompatibleToolCall[];
      /** A structured refusal: the model declined, with `content` null and an ordinary `finish_reason`. */
      refusal?: string | null;
    };
    /** Why the model stopped — `stop`, `length`, `content_filter`, `tool_calls` — where the endpoint says. */
    finish_reason?: string | null;
  }>;
  /**
   * Optional on purpose: `usage` is not in the subset every
   * OpenAI-compatible endpoint implements, and a local server that omits it
   * must report nothing rather than a zero.
   */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Cached prompt tokens, a SUBSET of `prompt_tokens`. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** The model that actually served the request; endpoints may rename it. */
  model?: string;
  error?: {
    message?: string;
    /**
     * The first-party API's machine-readable reason, the one part of this
     * error shape that is not prose. Most OpenAI-compatible runtimes omit
     * it, which is why the overflow check reads the message too.
     */
    code?: string;
  };
  rawText?: string;
}

/**
 * Whether a rejected request was rejected for being longer than the model's
 * context window.
 *
 * The code first, because the first-party API sets
 * `context_length_exceeded` and a code needs no pattern. Everything else
 * implementing this wire format phrases it in prose and differently —
 * llama.cpp, vLLM, Ollama and the hosted gateways each have their own — so
 * the fallback is a narrow match on the shapes those actually use. Narrow
 * on purpose: reading an unrelated 400 as an overflow would have the kernel
 * throw away conversation history to "fix" a request that was wrong in some
 * other way.
 */
export const overflowedContext = (payload: { error?: { code?: string } }, message: string): boolean =>
  payload.error?.code === 'context_length_exceeded'
  // The families that actually occur: "maximum context length is N tokens"
  // (OpenAI, vLLM), "exceeds the available context size" (llama.cpp),
  // "context window", "prompt is too long". Anchored on the word `context`
  // rather than on any one sentence, except for the two phrasings that
  // omit it.
  || /context (?:length|size|window)|maximum context|too many tokens|prompt is too long|reduce the length of the messages/i.test(message);

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * A base URL without its trailing slashes. Not `replace(/\/+$/, '')`,
 * which is quadratic on a run of slashes that is not at the end (state's
 * `withoutTrailingSlashes` says more; state depends on this package, so it
 * cannot be imported here).
 */
export const withoutTrailingSlashes = (url: string): string => {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return url.slice(0, end);
};

/**
 * A configured value both as written and as Fetch sends it: Fetch trims
 * surrounding spaces and tabs from a header value, so an endpoint echoes
 * the trimmed form.
 */
export const asSent = (value: string): string[] => {
  // Index walks, not `/^[\t ]+|[\t ]+$/g`: that regex restarts at every
  // tab of a run that is not at the end, so `a`, 40,000 tabs and `a` took
  // 2.7 s (CodeQL js/polynomial-redos).
  const isTabOrSpace = (code: number): boolean => code === 0x09 || code === 0x20;
  let start = 0;
  let end = value.length;
  while (start < end && isTabOrSpace(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isTabOrSpace(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  const sent = value.slice(start, end);
  return sent === value ? [value] : [value, sent];
};

/**
 * The credential in an authorization value: what follows the scheme, with
 * surrounding whitespace trimmed, or nothing when there is no scheme, no
 * credential, or a line break inside it. That is what
 * `/^\s*\S+\s+(\S.*?)\s*$/` captured, but its lazy `.*?` retried the
 * trailing `\s*` at every character, so `Bearer a`, 40,000 spaces and `b`
 * took 2.6 s.
 */
const authorizationCredential = (value: string): string | undefined => {
  const rest = value.trimStart();
  const schemeEnd = rest.search(/\s/);
  if (schemeEnd <= 0) {
    return undefined;
  }
  const credential = rest.slice(schemeEnd).trim();
  return credential === '' || /[\n\r\u2028\u2029]/.test(credential) ? undefined : credential;
};

/**
 * The configured header values an endpoint might repeat in its error text.
 * An `authorization` header carries a scheme and a credential, and an
 * endpoint may name the credential alone ("invalid token: ..."), so that
 * part counts on its own too.
 */
export const headerSecrets = (headers: Record<string, string>): string[] =>
  Object.entries(headers).flatMap(([name, value]) => {
    const credential = /^(?:proxy-)?authorization$/i.test(name)
      ? authorizationCredential(value)
      : undefined;
    return credential === undefined ? asSent(value) : [...asSent(value), credential];
  });

export const createOpenAICompatibleProvider = ({
  model,
  apiKey,
  baseUrl = DEFAULT_OPENAI_BASE_URL,
  name = 'openai',
  systemPrompt,
  headers = {},
  fetch: fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  vision = true,
  imageReplayBudget,
}: OpenAICompatibleProviderConfig): ModelProvider => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for the OpenAI-compatible provider.');
  }

  const normalizedBaseUrl = withoutTrailingSlashes(baseUrl);
  // Copied once: what is sent and what is redacted are the same values, so
  // a caller mutating its object later cannot send a credential the
  // redaction never heard of.
  const configuredHeaders: Record<string, string> = { ...headers };

  const provider = defineProvider({
    name,
    async generate(request) {
      const toolNames = createOpenAICompatibleToolNameMapping(request.tools);
      const tools = createOpenAICompatibleTools(request.tools, toolNames);

      // The turn's signal cancels the request; the timeout bounds it even
      // when no signal exists, so a hung endpoint cannot pin the turn (and
      // a draining daemon) open forever.
      const timeout = requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined;
      const signal = timeout && request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout ?? request.signal;

      let payload;
      let response: Response;
      // Sent at most twice: once as built, and once more with no images at
      // all if the endpoint refused them. The retry is built as though the
      // model had no vision rather than from what is left: omitting the
      // refused images frees replay budget, and a rebuild that could see
      // it would spend it on older images — sending a picture to an
      // endpoint that just said it takes none.
      let imagesRetried = false;
      for (;;) {
        const { messages, sent } = createOpenAICompatibleMessages(request, systemPrompt, toolNames, vision && !imagesRetried, imageReplayBudget);
        try {
          response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
              ...configuredHeaders,
            },
            body: JSON.stringify({
              model,
              messages,
              ...(tools.length > 0 ? { tools } : {}),
              ...(tools.length > 0 && request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
            }),
            ...(signal ? { signal } : {}),
          });
          payload = await parseOpenAICompatibleResponse(response);
        } catch (error) {
          // A timed-out request is a provider failure (fallback-eligible),
          // never mistaken for the caller's own cancellation.
          if (timeout?.aborted && !request.signal?.aborted) {
            throw new Error(`Provider request timed out after ${requestTimeoutMs}ms: ${name}`);
          }
          throw error;
        }

        if (response.ok) {
          break;
        }
        // Classified on the endpoint's own words, and redacted only in what
        // is thrown: a local runtime takes any key, and a short one can be
        // a word the checks below look for ("context", "image").
        // The body is the endpoint's own JSON, so `error.message` is only a
        // string by convention: anything else is shown as JSON rather than
        // left to throw from the checks and the redaction below.
        const reportedMessage: unknown = payload.error?.message;
        const reported = typeof reportedMessage === 'string'
          ? reportedMessage
          : reportedMessage != null
            ? JSON.stringify(reportedMessage)
            : payload.rawText ?? `Provider request failed with status ${response.status}`;
        const message = redactSecrets(reported, [...asSent(apiKey), ...headerSecrets(configuredHeaders)]);
        // The transcript did not fit. Reported as the one provider failure
        // the kernel can act on — it answers by sending less history —
        // rather than as the final error every other 400 here is. Matched
        // on wording because the OpenAI-compatible shape has no dedicated
        // status: the first-party API says `context_length_exceeded` in
        // `error.code`, and the local runtimes that implement this surface
        // each phrase it their own way.
        //
        // **Only on a 400**, which is the status that means the request
        // itself was unacceptable — the same narrowing the Anthropic
        // adapter gets for free from `BadRequestError`. Without it, every
        // non-2xx is read for the prose: a proxy answering 503 "failed to
        // determine model context length" would be taken for an overflow,
        // and the kernel would permanently raise the floor over a
        // transient failure instead of surfacing it or switching to the
        // fallback.
        //
        // **Ahead of the image recovery below**, which is the destructive
        // one: `omitImage` empties attachments on the live session, and
        // that is irreversible. An overflow message can name an image
        // ("maximum context length is 8192 tokens; your messages including
        // 1 image resulted in …"), and taken by the branch below it would
        // throw away the pictures a turn was about and retry — when what
        // the request needed was less history, which the kernel would have
        // supplied.
        if (response.status === 400 && overflowedContext(payload, reported)) {
          throw new ContextOverflowError(
            `The conversation no longer fits ${model}'s context window (${message}).`,
          );
        }
        // A 400 that blames an image, from a request that carried some. This
        // wire format has no one error shape across its vendors, so the
        // whole batch is let go of rather than one block: the images are
        // emptied on the session itself, since stored as they are they would
        // fail every later turn the same way, and the turn goes on with a
        // note in each one's place.
        if (response.status === 400 && sent.length > 0 && !imagesRetried && /image/i.test(reported)) {
          for (const image of sent) {
            omitImage(image);
          }
          imagesRetried = true;
          continue;
        }
        throw new Error(message);
      }

      // Reported through the sink BEFORE the empty-response check below.
      // A 200 with `usage` and nothing usable in it — tool arguments that
      // will not parse, content-filtered output — is a paid call that ends
      // in a throw, and a throw returns no response for the count to ride
      // on. The count also stays on the response for a host calling
      // generate with no sink attached; the kernel reads one or the other,
      // never both.
      const usage = extractOpenAICompatibleUsage(payload, name, model);
      if (usage) {
        request.onUsage?.(usage);
      }

      // Cut off at the endpoint's own output cap, so what arrived is a
      // fragment. Judged here, ahead of the parts, for the reason the
      // empty-response check below already gives in its own words — "a
      // response cut off by length … is a failure" — and could not act on:
      // it only ran when nothing usable surfaced, so a reply cut off after
      // a paragraph was returned as the turn's answer. A truncated tool
      // call is the sharper half: `arguments` stops mid-JSON, and a cut
      // that happens to land on a closing brace parses into an object
      // missing half its keys.
      //
      // No `maxTokens` to name in the remedy: this adapter sends no
      // `max_tokens`, so the ceiling is whatever the endpoint defaults to
      // and the fix is on that side.
      if (payload.choices?.[0]?.finish_reason === 'length') {
        throw new Error(
          'The provider stopped at its output cap before finishing (finish_reason: length), so the reply '
          + 'is a fragment and was not delivered. Ask for a shorter answer, or raise the output cap on the '
          + 'endpoint serving this model.',
        );
      }

      const builder = createProviderResponseBuilder();

      const text = extractOpenAICompatibleText(payload);
      if (text.length > 0) {
        builder.addText(text);
      }

      const toolCalls = extractOpenAICompatibleToolCalls(payload, toolNames);
      for (const call of toolCalls) {
        builder.addToolCall(call);
      }

      const result = builder.done();
      if (result.parts.length === 0) {
        // Nothing said is the answer a turn nobody asked for may give — see
        // `RunInput.addressed` in core — but only when the model actually
        // stopped: a content filter, or a tool call with no usable name, is
        // a failure reduced to no parts, and recording it as a decision
        // would hide it. An endpoint that reports no finish reason at all
        // is taken at its word. Being cut off by length is the other way a
        // turn does not end of its own accord, and it no longer reaches
        // here — the check above refuses it whether or not anything
        // surfaced.
        const choice = payload.choices?.[0];
        // A refusal is the model's own outcome, not silence: it arrives with
        // `content: null` and a `finish_reason` of `stop`, and only this
        // field says so.
        const refusal = choice?.message?.refusal;
        if (typeof refusal === 'string' && refusal.length > 0) {
          throw new Error(`Provider refused the request: ${refusal}`);
        }
        const finishReason = choice?.finish_reason ?? undefined;
        // A choice with a message has to exist: a 200 with an empty body,
        // `{}`, or no choices is no completion at all, and a missing
        // finish reason is tolerated only on one that is.
        const stoppedNormally = choice?.message !== undefined && (finishReason === undefined || finishReason === 'stop');
        if (!isReplyOptionalTurn(request.session) || !stoppedNormally) {
          throw new Error(
            finishReason !== undefined && finishReason !== 'stop'
              ? `Provider returned an empty response (finish_reason: ${finishReason}).`
              : 'Provider returned an empty response.',
          );
        }
      }

      return usage ? { ...result, usage } : result;
    },
  });

  // Whatever leaves `generate` failed is stored on the turn, logged, and
  // posted to the channel, and the endpoint's words reach it from more than
  // the error branch (a 200's structured refusal). Redacted once here, on
  // every error, so no path has to remember to. The classification above
  // still reads the raw text; this only changes what is thrown.
  const secrets = [...asSent(apiKey), ...headerSecrets(configuredHeaders)];
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
 * The response's token counts in the kernel's four buckets, or undefined
 * when the endpoint reported none.
 *
 * `prompt_tokens` counts cached tokens too, while `TokenUsage.inputTokens`
 * is the full-rate bucket alone — so the cached count comes out of it,
 * through the kernel's own `uncachedInputTokens` rather than a subtraction
 * spelled out again here. There is no cache-write bucket on this wire
 * format: these endpoints cache implicitly and bill nothing for the write,
 * so `cacheWriteTokens` stays absent rather than becoming a zero.
 */
const extractOpenAICompatibleUsage = (
  payload: OpenAICompatibleResponse,
  providerName: string,
  model: string,
): ProviderCallUsage | undefined => {
  const usage = payload.usage;
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const cachedTokens = typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
    ? usage.prompt_tokens_details.cached_tokens
    : undefined;
  if (promptTokens === undefined && completionTokens === undefined && cachedTokens === undefined) {
    return undefined;
  }
  return {
    provider: providerName,
    model: typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : model,
    ...(promptTokens !== undefined ? { inputTokens: uncachedInputTokens(promptTokens, cachedTokens) } : {}),
    ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}),
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
  };
};

export interface OpenAICompatibleToolNameMapping {
  toWire: Map<string, string>;
  fromWire: Map<string, string>;
}

// OpenAI only accepts function names matching ^[a-zA-Z0-9_-]{1,64}$, so
// registry names like "demo.echo" must be sanitized for the wire and
// translated back when the model calls them.
export const sanitizeOpenAICompatibleToolName = (name: string): string => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return sanitized.length > 0 ? sanitized : 'tool';
};

export const createOpenAICompatibleToolNameMapping = (
  tools: ToolDescriptor[] | undefined,
): OpenAICompatibleToolNameMapping => {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();

  for (const tool of tools ?? []) {
    if (toWire.has(tool.name)) {
      continue;
    }

    const base = sanitizeOpenAICompatibleToolName(tool.name);
    let wireName = base;
    for (let suffix = 2; fromWire.has(wireName); suffix += 1) {
      wireName = `${base.slice(0, 60)}_${suffix}`;
    }

    toWire.set(tool.name, wireName);
    fromWire.set(wireName, tool.name);
  }

  return { toWire, fromWire };
};

export const toWireToolName = (name: string, mapping: OpenAICompatibleToolNameMapping): string =>
  mapping.toWire.get(name) ?? sanitizeOpenAICompatibleToolName(name);

const createOpenAICompatibleTools = (
  tools: ToolDescriptor[] | undefined,
  toolNames: OpenAICompatibleToolNameMapping,
): OpenAICompatibleToolDefinition[] =>
  (tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: toWireToolName(tool.name, toolNames),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));

const extractOpenAICompatibleToolCalls = (
  payload: OpenAICompatibleResponse,
  toolNames: OpenAICompatibleToolNameMapping,
): ToolCall[] => {
  const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? [];
  const calls: ToolCall[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    const wireName = toolCall.function?.name;
    if (!wireName) {
      continue;
    }

    const name = toolNames.fromWire.get(wireName) ?? wireName;
    const rawArguments = toolCall.function?.arguments ?? '{}';
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

    calls.push({
      id: toolCall.id ?? `tool-call-${index + 1}`,
      toolName: name,
      input,
    });
  }

  return calls;
};

const parseOpenAICompatibleResponse = async (response: Response): Promise<OpenAICompatibleResponse> => {
  const rawText = await response.text();
  if (rawText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(rawText) as OpenAICompatibleResponse;
  } catch {
    return { rawText };
  }
};

const createOpenAICompatibleMessages = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
  toolNames: OpenAICompatibleToolNameMapping,
  vision: boolean,
  imageReplayBudget: ImageReplayBudget | undefined,
): { messages: OpenAICompatibleMessage[]; sent: ImageAttachment[] } => {
  const messages: OpenAICompatibleMessage[] = [];
  const replayed = imagesWithinReplayBudget(transcriptOf(request), imageReplayBudget);
  // The images this request actually carries, for a rejection to answer.
  const sent: ImageAttachment[] = vision
    ? transcriptOf(request).flatMap((message) => (message.images ?? []).filter((image) => replayed.has(image)))
    : [];

  // One shared reading of what an agent is told about itself — persona,
  // memory, skills — rendered by the kernel (see core's system prompt
  // renderer); this dialect sends each section as its own system message.
  for (const section of renderSystemPromptSections(request, {
    ...(systemPrompt ? { preamble: systemPrompt } : {}),
  })) {
    messages.push({ role: 'system', content: section });
  }

  const transcript = transcriptOf(request);
  const latest = latestUserMessageOf(transcript);
  // Marked as said to the agent after an overheard message (card 1034).
  const afterOverheard = messagesAfterOverheard(transcript);
  // Images tool calls returned, held until the run of tool messages ends:
  // a chat-completions tool message is text only, and every call of an
  // assistant turn has to be answered before any other message — so they
  // follow the last answer, as one user message that says whose they are.
  let toolImages: Array<{ toolName: string; image: ImageAttachment }> = [];
  const flushToolImages = (): void => {
    if (toolImages.length === 0) {
      return;
    }
    const names = [...new Set(toolImages.map((entry) => entry.toolName))].join(', ');
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `[The images returned by the tool call${toolImages.length > 1 ? 's' : ''} above (${names}), shown here because a tool result cannot carry an image. Nobody sent this message.]` },
        ...toolImages.map(({ image }) => (replayed.has(image)
          ? { type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } }
          : { type: 'text' as const, text: droppedImageNote(image) })),
      ],
    });
    toolImages = [];
  };
  for (const message of transcript) {
    if (message.role !== 'tool') {
      flushToolImages();
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const wireCalls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: toWireToolName(call.toolName, toolNames),
          arguments: JSON.stringify(call.input),
        },
      }));
      // The runner records one message per call (and the response's text
      // separately), but on the wire they are ONE assistant turn: OpenAI
      // rejects a tool_calls message that is not fully answered before the
      // next assistant message. Directly consecutive assistant messages
      // can only come from a single response, so merging is safe.
      const previous = messages.at(-1);
      if (previous && previous.role === 'assistant') {
        previous.tool_calls = [...(previous.tool_calls ?? []), ...wireCalls];
        continue;
      }
      messages.push({
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: wireCalls,
      });
      continue;
    }

    if (message.role === 'tool') {
      const result = message.toolResult;
      const images = message.images ?? [];
      messages.push({
        role: 'tool',
        content: `${result ? renderToolResultContent(result) : message.content}${vision ? '' : describeImageAttachments(images)}`,
        ...(result ? { tool_call_id: result.callId } : {}),
      });
      if (vision) {
        toolImages.push(...images.map((image) => ({ toolName: message.name ?? result?.toolName ?? 'tool', image })));
      }
      continue;
    }

    if (message.role === 'assistant' && message.content.length === 0) {
      // A turn nobody asked for that said nothing: the boundary is the
      // kernel's, and an empty assistant message is a wire-format error on
      // some endpoints and a blank line on the rest.
      continue;
    }
    // Framed by the kernel's one rule for it, so the OpenAI-compatible path
    // says "said to somebody else" the way the API and harness paths do —
    // an overheard message sent bare here would be an ordinary instruction
    // on exactly the endpoint with no other provenance signal.
    messages.push({
      role: message.role,
      content: message.role === 'user'
        ? (vision
          ? userContentParts(message, replayed, message === latest, afterOverheard.has(message))
          : userMessageText(message, message === latest, false, afterOverheard.has(message)))
        : message.content,
      ...(message.name ? { name: message.name } : {}),
    });
  }
  flushToolImages();

  return { messages, sent };
};

const userContentParts = (
  message: Pick<Message, 'content' | 'overheard' | 'images'>,
  replayed: ReadonlySet<ImageAttachment>,
  latest: boolean,
  afterOverheard = false,
): OpenAICompatibleUserContent => {
  const text = promptTextOf(message, { latest, afterOverheard });
  if (message.images === undefined || message.images.length === 0) {
    return text;
  }
  return [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    // An overheard message's images are labeled as its own (card 625).
    ...(message.overheard === true ? [{ type: 'text' as const, text: OVERHEARD_IMAGES_NOTE }] : []),
    ...message.images.map((image) => (replayed.has(image)
      ? { type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } }
      : { type: 'text' as const, text: droppedImageNote(image) })),
  ];
};

const extractOpenAICompatibleText = (payload: OpenAICompatibleResponse): string => {
  const message = payload.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }

  return '';
};
