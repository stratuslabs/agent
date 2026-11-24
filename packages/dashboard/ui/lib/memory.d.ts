// Types for the one UI module a test imports. The UI itself is plain ES
// modules with no build step; this declaration is what lets `pnpm typecheck`
// cover the test without pretending the module is TypeScript.
export interface MemoryListEntry {
  content: string;
  about?: string[];
  kind?: string;
  pinned?: boolean;
  validity?: 'current' | 'expired' | 'not-yet-valid';
  trust?: 'user' | 'agent' | 'unknown' | 'external';
}
export interface MemoryMark {
  label: string;
  tone: string;
  why: string;
}
export const memoryMatches: (entry: MemoryListEntry, query: string | undefined) => boolean;
export const memoryMarks: (entry: MemoryListEntry) => MemoryMark[];
