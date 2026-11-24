// Types for the UI module a test imports. See grants.d.ts for why.
import type { CallLine } from './decisions.js';

/** A session id short enough for a row: whole up to 28 characters, both ends after that. */
export const shortId: (id: string) => string;
/** A stored tool result as "tool → output", cut at 260 characters. */
export const summariseTool: (content: unknown) => string;
export interface TranscriptMessage {
  role: string;
  content?: unknown;
  toolCalls?: ReadonlyArray<{ id: string; toolName: string; input: unknown }>;
  toolResult?: { callId: string; toolName: string; ok: boolean; output?: unknown; error?: string };
}
/** A message (`user`, `assistant`) with its text, or a `tool` call with the rest. */
export interface TranscriptItem {
  kind: string;
  text?: unknown;
  streaming?: true;
  toolName?: string;
  input?: unknown;
  /** Where a call got to: running, waiting, denied, done or failed. */
  phase?: string;
  output?: unknown;
  error?: string;
  /** The call line whose decisions show beside it, if any. */
  line?: CallLine;
}
/** The items of one conversation: stored messages, then live calls, then the streaming reply. */
export const transcriptItems: (input: {
  messages: readonly TranscriptMessage[];
  toolLines: readonly (CallLine & { phase?: string })[];
  streaming: string;
  settled: ReadonlyMap<number, CallLine>;
}) => TranscriptItem[];
