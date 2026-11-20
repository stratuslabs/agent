// Types for the UI module a test imports. See grants.d.ts for why.
import type { CallLine } from './decisions.js';

/** A session id short enough for a row: whole up to 28 characters, both ends after that. */
export const shortId: (id: string) => string;
/** A stored tool result as "tool → output", cut at 260 characters. */
export const summariseTool: (content: unknown) => string;
export interface TranscriptMessage {
  role: string;
  content?: unknown;
}
export interface TranscriptItem {
  /** The bubble's class after `bubble`: a message role, `tool`, or `assistant streaming`. */
  kind: string;
  text: unknown;
  /** On a tool bubble: the call line whose decisions show beside it, if any. */
  line?: CallLine;
}
/** The bubbles of one conversation: stored messages, then live tool lines, then the streaming reply. */
export const transcriptItems: (input: {
  messages: readonly TranscriptMessage[];
  toolLines: readonly CallLine[];
  streaming: string;
  settled: ReadonlyMap<number, CallLine>;
}) => TranscriptItem[];
