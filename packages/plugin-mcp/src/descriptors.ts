/*
 * What a server's tool definition may become once it is bridged: the
 * registered name (`mcp.<server>.<segment>`), the description and the input
 * schema, each held to a bound before the model sees it. Results, which a
 * server sends on every call rather than once at connect, are bounded in
 * `result-budget.ts` and `normalize.ts`.
 */
import { BIDI_CONTROL_CHARACTERS } from '@stratusagent/core';

/**
 * One segment of a bridged tool's registered name — lowercased, everything
 * that is not `[a-z0-9_-]` folded to `_`, leading punctuation stripped.
 * `undefined` when nothing survives, which the caller must treat as a
 * refusal rather than inventing a name.
 *
 * Folding is what makes a collision possible (`createIssue` and
 * `create_issue` both become `create_issue`), which is why the caller
 * checks for one and refuses it rather than letting the second tool
 * silently answer calls meant for the first.
 */
export const sanitizeToolSegment = (raw: string): string | undefined => {
  const folded = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const trimmed = folded.replace(/^[^a-z0-9]+/, '');
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Server keys are operator-chosen and become a name segment; held to the segment shape outright. */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The longest tool description a server gets to put in front of the model.
 * The same bound a skill's description has (`SKILL_DESCRIPTION_MAX_LENGTH`
 * in `@stratusagent/agents`), for the same reason: a description is prose
 * the model reads on every turn, written by a party the operator did not
 * author, and a paragraph is a description while a page is instructions.
 */
export const BRIDGED_DESCRIPTION_MAX_LENGTH = 1024;

/** Control characters and the Unicode `Bidi_Control` set, spelled out. */
const DESCRIPTION_CONTROLS = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029${BIDI_CONTROL_CHARACTERS}]`, 'g');

const spelledOut = (raw: string): string => raw.replace(
  DESCRIPTION_CONTROLS,
  (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
);

/**
 * A server's tool description as it reaches the registry — and, through
 * it, every provider's tool block on every turn. The text is the server's,
 * re-read on every reconnect, and `tools/list` is the one channel a
 * server has that arrives looking like part of the harness rather than
 * like a result. Two bounds, neither a filter: control characters and the
 * Unicode bidi controls are spelled out the way memory entries are (a
 * right-to-left override in a description is a description that reads
 * differently to a person than to the model — escaped, it reads as what it
 * is; the set is Unicode's `Bidi_Control` property, marks and the Arabic
 * letter mark included, not only the overrides and isolates), and the
 * length is capped with the cut announced. Newlines and tabs stay: a
 * description is allowed to be several lines.
 */
export const bridgedDescription = (raw: string): string => {
  const escaped = spelledOut(raw);
  // Counted and cut in code points, not UTF-16 units: an emoji is one
  // character, and a cut inside a surrogate pair is a malformed string a
  // provider may reject.
  const characters = Array.from(escaped);
  if (characters.length <= BRIDGED_DESCRIPTION_MAX_LENGTH) {
    return escaped;
  }
  const marker = ` … [description truncated by stratus: ${characters.length} characters]`;
  return `${characters.slice(0, BRIDGED_DESCRIPTION_MAX_LENGTH - Array.from(marker).length).join('')}${marker}`;
};

/**
 * The longest input schema a server gets to put in front of the model, in
 * characters of its JSON. A schema is read by the provider as structure,
 * but every string in it lands in the tool block as text, and sixteen
 * thousand characters of parameter list is a page, not a parameter list.
 */
export const BRIDGED_SCHEMA_MAX_LENGTH = 16_384;

/**
 * How deep a schema may nest before the bridge stops walking it. Sixty-four
 * levels is far past any parameter list a person wrote; a schema nested
 * deeper is a stack-overflow attempt dressed as a tool, and a recursive
 * walk that blew the stack during discovery would take the whole server
 * down as unreachable, and again on every reconnect.
 */
export const BRIDGED_SCHEMA_MAX_DEPTH = 64;

/**
 * The schema keys whose values are prose the model reads, at any depth —
 * `$comment` included: the spec calls it a note for schema authors, but
 * the provider forwards the whole schema, so it is one more place a page
 * of instructions can ride into every tool block.
 */
const SCHEMA_ANNOTATION_KEYS = new Set(['description', 'title', '$comment']);

/**
 * The longest name segment a server's tool may bridge under. The segment
 * is the tail of `mcp.<server>.<segment>`, sent as the tool's name in
 * every model request, and a name is the one string a server writes that
 * no description bound touches — a tool called `a` three thousand times
 * over is a page in the tool block by another route. Sixty-four is the
 * longest name the strictest provider accepts whole.
 */
export const BRIDGED_SEGMENT_MAX_LENGTH = 64;

/**
 * The schema keys whose values are data, not schema: a member named
 * `description` inside an `enum` entry is a value the model will send
 * back, not prose, and rewriting it would make the schema offer a value
 * the server does not accept. These subtrees are copied through verbatim.
 */
const SCHEMA_LITERAL_KEYS = new Set(['enum', 'const', 'default', 'examples']);

class SchemaTooDeepError extends Error {
  constructor() {
    super(`Schema nests deeper than ${BRIDGED_SCHEMA_MAX_DEPTH} levels.`);
    this.name = 'SchemaTooDeepError';
  }
}

/**
 * The schema keywords whose value is a map from a *name* to a schema. The
 * names are the server's — a parameter called `default` or `enum` is an
 * ordinary parameter — so the keys of these maps are never read as
 * keywords, and every value under them is a schema again. Without this
 * distinction a description hidden under `properties.default` would pass
 * through as a literal, unbounded. Draft-07's `dependencies` is here too:
 * its values are schemas or lists of property names, and a list walked as
 * a schema comes back untouched.
 */
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

const boundedSchemaValue = (value: unknown, depth: number, position: 'schema' | 'map'): unknown => {
  if (depth > BRIDGED_SCHEMA_MAX_DEPTH) {
    throw new SchemaTooDeepError();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => boundedSchemaValue(entry, depth + 1, 'schema'));
  }
  if (typeof value === 'object' && value !== null) {
    if (position === 'map') {
      return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, boundedSchemaValue(entry, depth + 1, 'schema')]));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SCHEMA_LITERAL_KEYS.has(key)
        ? entry
        : SCHEMA_ANNOTATION_KEYS.has(key) && typeof entry === 'string'
          ? bridgedDescription(entry)
          : boundedSchemaValue(entry, depth + 1, SCHEMA_MAP_KEYS.has(key) ? 'map' : 'schema'),
    ]));
  }
  return value;
};

/**
 * A server's input schema as it reaches the registry — and, through it,
 * the tool block of every turn, the same way the description does. The
 * top-level description is not the only prose in `tools/list`: a
 * `description` or `title` on any property, at any depth, is text the
 * model reads too, and it was copied through unbounded. Each is bounded
 * like the tool's own description. Nothing else in the schema is touched:
 * a property name, an enum value, a const or a pattern is what the model
 * sends back in a call, and the bridge forwards arguments to the server
 * as the model wrote them — a value spelled out here would arrive at the
 * server as a different value, and the schema would be a lie in the
 * direction that breaks calls. An annotation key *inside* a literal (an
 * `enum` member with a `description` field) is data too, and is left
 * alone — while a *parameter* named `enum` or `default` is a schema like
 * any other, because the keys of `properties` and `$defs` are names, not
 * keywords. `undefined` when the bounded schema is still longer than
 * {@link BRIDGED_SCHEMA_MAX_LENGTH} characters, or nests deeper than
 * {@link BRIDGED_SCHEMA_MAX_DEPTH}: that tool is not bridged, and the
 * caller names it.
 */
export const bridgedSchema = (schema: Record<string, unknown>): Record<string, unknown> | undefined => {
  try {
    const bounded = boundedSchemaValue(schema, 0, 'schema') as Record<string, unknown>;
    // The literal subtrees were not walked, so the serialisation is the
    // one place a bottomless `default` can still blow the stack — a
    // RangeError there is the same answer as a schema too deep to walk.
    return Array.from(JSON.stringify(bounded)).length <= BRIDGED_SCHEMA_MAX_LENGTH ? bounded : undefined;
  } catch (error) {
    if (error instanceof SchemaTooDeepError || error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
};

/** The registered name a server's tool bridges to: `mcp.<server>.<segment>`. */
export const bridgedToolName = (server: string, segment: string): string => `mcp.${server}.${segment}`;
