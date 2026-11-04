/*
 * The JSON value types core's contracts are written in: a tool call's
 * input and output, session and message metadata, an ingested event. A
 * module of its own because they depend on nothing else in core.
 * `index.ts` re-exports both, so the package's one public entry is
 * unchanged.
 */

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
