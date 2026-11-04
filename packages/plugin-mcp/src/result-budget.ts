/*
 * How much of one `tools/call` result reaches the transcript: the cap and
 * its floor, stratus's own markers and notes for what it cut and the room
 * reserved for them, how server text is measured as the transcript will
 * carry it, and the per-result allowance that every server-written part is
 * charged against. `normalize.ts` spends it.
 */

/**
 * The most of one `tools/call` result a server gets to put into the
 * transcript, in characters, counting the joined text and the JSON of
 * `structuredContent` separately.
 *
 * Every first-party tool caps what it returns — `fs.read` at 64 KB,
 * `shell.run` and `browser.read` at 100 KB, `web.fetch` at 400 KB — and
 * a bridged result was the one that did not. Binary blocks already land on
 * disk rather than in the result, so this is about text, and text is the
 * part that is *durable*: a tool result is saved into the session and
 * replayed to the provider on every later turn of that conversation, so a
 * server that answers `list_files` with twenty megabytes does not cost one
 * turn, it costs every turn until the session ends — and survives restarts,
 * because the transcript does. The stdio transport bounds a single message
 * at its reader's buffer (10 MB by default) and the HTTP transports bound
 * nothing, so "the transport will stop it" was never a cap.
 *
 * 100 KB matches `shell.run`, which is the closest comparison: somebody
 * else's program, writing as much as it likes. Counted in characters
 * rather than bytes, like the two bounds in `descriptors.ts` and unlike
 * the tool packs': what is scarce here is the model's context, which is
 * measured in tokens, and a token follows a character more closely than it
 * follows a byte.
 */
export const BRIDGED_RESULT_MAX_LENGTH = 100_000;

/**
 * The smallest `maxResultChars` that means anything, and the floor every
 * smaller one is raised to.
 *
 * A cap has to be able to hold an account of what it cut. The four
 * annotations a result can carry — a marker for the text, one for the
 * structured payload, and the two truncation notes — come to a little over
 * four hundred characters with the keys they arrive under, and shortening
 * them is not on the table: an announcement is the whole reason a cap is
 * safe to have, and a cut with nothing saying it happened is the failure
 * this bound exists to prevent.
 *
 * So below this a cap cannot be honoured, only approximated — `1` yielded
 * 73 characters for a truncated text and 104 for a dropped resource link —
 * and approximating it silently is worse than raising it. Raised rather
 * than refused, and raised to the floor rather than back to the default,
 * because an operator who asked for the smallest possible result should
 * get the smallest possible result. The markers name the cap that was
 * actually applied.
 */
export const BRIDGED_RESULT_MIN_LENGTH = 512;

/**
 * A configured `maxResultChars` as it actually applies: the default when
 * unset, never below the floor. One implementation because it has two
 * consumers — `normalizeCallResult` for a result, and the call path for a
 * `tools/call` that fails before there is a result to normalize. A second
 * copy would leave the floor applying to one and not the other, which is
 * how a cap of 1 came to name itself in a protocol error's marker.
 */
export const boundedResultLimit = (configured: number | undefined): number =>
  Math.max(BRIDGED_RESULT_MIN_LENGTH, configured ?? BRIDGED_RESULT_MAX_LENGTH);

/**
 * Stratus's own account of a cut, in the three shapes it takes. One home
 * each, because the reservation below has to know what they cost and a
 * second copy of the wording would drift from the one that ships.
 */
const truncationMarker = (what: string, cap: number, sent: number): string =>
  `\n… [${what} truncated by stratus at ${cap} characters; the server sent ${sent}]`;

export const resourcesTruncatedNote = (count: number, cap: number): string =>
  `${count} more resource link${count === 1 ? ' was' : 's were'} not included: the result reached its ${cap}-character cap.`;

export const filesTruncatedNote = (count: number, cap: number): string =>
  `${count} more attachment${count === 1 ? ' was' : 's were'} not saved: the result reached its ${cap}-character cap.`;

/**
 * The longest `what` a marker is built with. `spend` is reached with
 * `result`, `structured result` and — on the `isError` path — `error
 * message`, and the reservation has to hold the widest of them.
 */
const WIDEST_MARKER_SUBJECT = 'structured result';

/**
 * A worst-case count for a number one of those interpolates, so the
 * reservation is measured against the wording rather than against a guess
 * at how many digits a server can provoke.
 */
const WIDEST_COUNT = Number.MAX_SAFE_INTEGER;

/** What a value under `key` adds to the result's JSON: `"key":"",`. */
export const keyOverhead = (key: string): number => key.length + 6;

/**
 * Room set aside, before a server is charged for anything, for stratus's
 * own account of what it cut — sized to the annotations *this* result can
 * actually produce.
 *
 * Derived rather than guessed, which matters in both directions. A flat
 * 512 clamped to half the allowance was the first attempt and was wrong at
 * both ends: too small where every annotation fires at once, so a
 * 500-character cap returned 600, and too large for the ordinary result
 * that has no links and no attachments and can only ever produce one
 * marker.
 *
 * A marker is normally paid for out of what the server is spending —
 * `cutToLimit` subtracts it from the allowance before cutting — so what
 * needs reserving is the case where nothing is left to subtract from and
 * the marker arrives alone. The two truncation notes are never charged at
 * all: they are written after every spending decision has been made, so
 * there is no later point at which they could be.
 *
 * They must not be chargeable in any case. They are what tells the model a
 * listing was stopped rather than ended, and charging them to the same
 * allowance the server is spending would let a server suppress its own
 * truncation notice by filling the budget.
 */
interface NoteReserve {
  /** The marker a truncated `text` would carry. */
  text: number;
  /** The marker a `structuredContent` too large to keep would carry. */
  structured: number;
  /** The note dropped resource links would carry. */
  resources: number;
  /** The note skipped attachments would carry. */
  files: number;
  total: number;
}

const markerReserve = (key: string, limit: number): number =>
  serializedLength(truncationMarker(WIDEST_MARKER_SUBJECT, limit, WIDEST_COUNT)) + keyOverhead(key);

export const noteReserveFor = (
  content: readonly unknown[],
  hasStructured: boolean,
  hasWorkspaceRoot: boolean,
  limit: number,
): NoteReserve => {
  const kinds = content.filter(isObject).map((block) => block.type);
  // Only where the result can actually produce text. `resource_link` never
  // does, so a list of links was reserving room for a marker that had
  // nothing to mark — and at a small cap that reservation was enough to
  // drop the links it was withheld from.
  const producesText = kinds.some((kind) => kind === 'text' || kind === 'resource')
    // A binary block contributes text in exactly one case: there is
    // nowhere to write it, so it says so instead. With a workspace root
    // configured that cannot happen, and reserving for it costs the
    // attachment the room its own path needs.
    || (!hasWorkspaceRoot && kinds.some((kind) => kind === 'image' || kind === 'audio'));
  const text = producesText ? markerReserve('text', limit) : 0;
  const structured = hasStructured ? markerReserve('structuredText', limit) : 0;
  const resources = kinds.includes('resource_link')
    ? serializedLength(resourcesTruncatedNote(WIDEST_COUNT, limit)) + keyOverhead('resourcesTruncated')
    : 0;
  const files = kinds.some((kind) => kind === 'image' || kind === 'audio' || kind === 'resource')
    ? serializedLength(filesTruncatedNote(WIDEST_COUNT, limit)) + keyOverhead('filesTruncated')
    : 0;
  return { text, structured, resources, files, total: text + structured + resources + files };
};

/**
 * `raw`'s length in code points, walked rather than materialized:
 * `Array.from` is how the two bounds in `descriptors.ts` count, because
 * they measure a description against a fixed 1024, while these measure
 * whatever a server sent. Turning ten megabytes of result into ten million
 * one-character strings, to decide it is too long, would spend more memory
 * on the check than the string it guards against.
 */
const codePointLength = (raw: string): number => {
  let count = 0;
  for (const _character of raw) {
    count += 1;
  }
  return count;
};

/**
 * Whether `raw` is within `limit` code points, without counting further
 * than it has to. The cheap test first — a string's UTF-16 length is never
 * below its code-point count, so anything whose `length` fits is under the
 * limit — which is every ordinary string and costs one property read.
 */
const withinLimit = (raw: string, limit: number): boolean =>
  raw.length <= limit || codePointLength(raw) <= limit;

/**
 * What an already-serialized string costs the result, in the code points
 * the cap is counted in. The cheap `length` first, which is never below
 * the code-point count, so only a string carrying astral characters is
 * walked. One rule, because everything that adds to the total has to agree
 * with everything that tests it — measuring one in UTF-16 units and the
 * other in code points is how a result that fitted was cut anyway.
 */
export const charged = (value: string): number => Math.min(value.length, codePointLength(value));

/**
 * What one character costs the transcript, which is JSON.
 *
 * A tool result is stored and replayed as a JSON string, so the characters
 * a server writes are not the characters the transcript pays for: `"` and
 * `\` escape to two, the five shorthand controls to two, and every other
 * control character to six — `\u0000` for a NUL. Counting raw code points
 * therefore under-charged a hostile payload by up to sixfold: 100,000 NULs
 * passed a 100,000-character cap and weighed 596,546 in the session and in
 * every request that replayed it.
 *
 * Lone surrogates cost six for the same reason, and can be present in a
 * server's text even though nothing here ever produces one.
 *
 * Ordinary prose is unaffected — a log file pays for its newlines, a JSON
 * document for its quotes, both a couple of percent. The cap is still
 * counted in characters rather than bytes, as
 * {@link BRIDGED_RESULT_MAX_LENGTH} describes; these are simply the
 * characters that actually land.
 */
const serializedCostOf = (character: string): number => {
  const code = character.codePointAt(0)!;
  if (code === 0x22 || code === 0x5c) {
    return 2;
  }
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
    return 2;
  }
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
    return 6;
  }
  return 1;
};

/** `raw` measured as the transcript will carry it. */
export const serializedLength = (raw: string): number => {
  let count = 0;
  for (const character of raw) {
    count += serializedCostOf(character);
  }
  return count;
};

/**
 * Whether `raw` serializes within `limit`, without counting further than it
 * has to. A character costs at most six, so anything six times whose UTF-16
 * length fits is under the limit — one multiply for every ordinary result —
 * and the walk that settles the rest stops as soon as it has overspent,
 * rather than measuring ten megabytes to decide they are too many.
 */
const withinSerialized = (raw: string, limit: number): boolean => {
  if (raw.length * 6 <= limit) {
    return true;
  }
  let count = 0;
  for (const character of raw) {
    count += serializedCostOf(character);
    if (count > limit) {
      return false;
    }
  }
  return true;
};

/**
 * `raw`, cut so that what it costs the transcript is within `limit`, with
 * the cut announced — or `raw` when it already fits.
 *
 * The marker matters as much as the cut: the model has to be able to tell
 * a directory listing that ended from one that was stopped, or it reports
 * the truncated answer as the whole answer — which is the failure mode of
 * a silent cap, and worse than the size. It names the original size for
 * the same reason `bridgedDescription`'s does: the number is what tells an
 * operator whether to raise `maxResultChars` or fix the call, and it is
 * given in what the transcript pays so that both numbers in the sentence
 * are in the same units.
 *
 * The cut never lands inside a surrogate pair — half an astral character
 * is a malformed string a provider may refuse — and the exact size is only
 * paid for on the oversized path, `withinSerialized` having already
 * settled the ordinary one without walking the whole string.
 *
 * A `limit` smaller than the marker yields just the marker, which is
 * longer than the limit. Inside a result budget that case is what
 * {@link noteReserveFor} sets room aside for, so the marker arriving alone
 * does not push the result past its cap; the alternative would be a cut
 * with nothing saying it happened.
 */
export const cutToLimit = (raw: string, limit: number, what: string, cap: number = limit): string => {
  if (withinSerialized(raw, limit)) {
    return raw;
  }
  const characters = serializedLength(raw);
  // `cap`, not `limit`: the number an operator can act on is the one they
  // set, and `limit` is what was left of it after the reservation and
  // whatever the result already spent. Naming the remainder would tell
  // someone reading the transcript to raise a setting that does not exist.
  const marker = truncationMarker(what, cap, characters);
  return `${firstWithinCost(raw, Math.max(0, limit - serializedLength(marker)))}${marker}`;
};

/**
 * The first `count` CODE POINTS of `raw`.
 *
 * Not `raw.slice(0, allowance)`, which is the obvious thing and is wrong
 * twice over: `slice` indexes UTF-16 code units, so an emoji-heavy result
 * would keep about half of what it was allowed, and the allowance is spent
 * in what the transcript charges rather than in characters, so an escaped
 * one has to pay its escape. Walking the string settles both, and because
 * it only ever advances by whole code points it can never cut inside a
 * surrogate pair — nor leave a lone one behind for `JSON.stringify` to
 * spend six characters on.
 *
 * Bounded by `allowance`, not by the length of `raw`: the input is a
 * result that has already been found too long, and the point of stopping
 * early is not walking ten megabytes to keep a hundred thousand
 * characters.
 */
const firstWithinCost = (raw: string, allowance: number): string => {
  if (allowance <= 0) {
    return '';
  }
  let units = 0;
  let spent = 0;
  for (const character of raw) {
    // Compared before committing, never after: a character that would take
    // the total past the allowance is not taken. An equality test would
    // never be true against a fractional allowance and the loop would run
    // to the end of the string, returning the entire payload with a
    // truncation marker on it — larger than what came in. The callers are
    // guarded (see `asPositiveInteger`); this is the layer that must not
    // depend on them being right.
    const next = spent + serializedCostOf(character);
    if (next > allowance) {
      break;
    }
    spent = next;
    units += character.length;
  }
  return raw.slice(0, units);
};

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One result's character allowance, spent across everything server-written
 * that reaches the transcript.
 *
 * A budget rather than a cap per field because the transcript pays the
 * sum: text, a structured payload and a list of resource links are three
 * places a server can put bytes in one result, and three separate caps
 * would let it spend the allowance three times.
 */
export const createResultBudget = (limit: number, initialReserve: number) => {
  // One, not zero: the result is a flat object, so its JSON is `{`, its
  // fields joined by commas, and `}`. Charging every field as
  // `"key":value,` — comma included — overcounts by exactly one comma,
  // which is what pays for the closing brace; the opening one is this.
  //
  // The point of doing it this way is that the sum stops being an
  // approximation of `JSON.stringify(result).length` and becomes equal to
  // it. Every round of review so far has found another part of the
  // envelope nobody was charged for — separators between links, the
  // `"resources":[…]` around them, the keys themselves — because a budget
  // that adds up *some* of what the transcript carries will always have
  // one more piece missing. This adds up all of it.
  let spent = 1;
  let reserve = initialReserve;
  // `limit` is what the whole result may weigh; this is what a *server*
  // may spend of it. Stratus's own truncation markers and notes come out
  // of the difference, so that announcing a cut cannot itself push the
  // result past the cut. See {@link noteReserveFor}.
  const remaining = (): number => Math.max(0, limit - reserve - spent);
  /**
   * What is left if the room held for one particular annotation is not
   * held — the allowance a value gets to prove it needs no annotation at
   * all. Releasing that room is safe precisely when the value fits in it,
   * because then the annotation it was held for will never be written.
   */
  const withoutOwn = (ownReserve: number): number =>
    Math.max(0, limit - spent - (reserve - ownReserve));
  // Two ways in, because a result carries two kinds of string. `fits` and
  // `charge` take a value that is ALREADY in the form the transcript holds
  // — a `JSON.stringify`d link or path, whose escapes are characters in it
  // already — so they count it as it stands. `spend` takes a server's raw
  // text, which becomes a JSON string *value* and is escaped on the way,
  // so it is charged for what that escaping costs. Measuring either one the
  // other way is wrong in a direction that matters: plainly, and a NUL
  // costs a sixth of what it weighs; serialized, and every quote in a link
  // is paid for twice.
  return {
    limit,
    /** Whether `value`, already serialized, fits in what is left. */
    fits: (value: string): boolean => withinLimit(value, remaining()),
    /** Charge `value`, already serialized; the caller has checked it fits. */
    charge: (value: string): void => {
      spent += charged(value);
    },
    /**
     * `value`, already serialized, taken whole if it fits once the room
     * held for the note that would report *dropping* it is released. The
     * note reports what did not fit; a collection that fits entirely never
     * produces one, so it should not be charged for one — a single
     * resource link that would have fitted in a 512-character result was
     * being dropped to hold room for the sentence saying it was dropped.
     */
    takeWhole: (value: string, ownReserve: number): boolean => {
      // `value` here already carries its own key and separator — the
      // callers build `"resources":[…],` and `"structured":…,` — so there
      // is no envelope to add.

      if (!withinLimit(value, withoutOwn(ownReserve))) {
        return false;
      }
      spent += charged(value);
      reserve = Math.max(0, reserve - ownReserve);
      return true;
    },
    /**
     * Give back room held for an annotation this result will not carry.
     * Clamped at zero, because a share given back twice is room the cap
     * never had — the budget would then let the fields below it overspend
     * by exactly the size of the note nobody is writing.
     */
    release: (ownReserve: number): void => {
      reserve = Math.max(0, reserve - ownReserve);
    },
    /**
     * Whether everything still to come fits with no room held back at all
     * — the question that decides whether anything has to be cut, and so
     * whether any of it has to be announced.
     */
    fitsUntouched: (cost: number): boolean => spent + cost <= limit,
    /** Nothing will be cut, so nothing will be announced. */
    releaseAll: (): void => {
      reserve = 0;
    },
    spend: (value: string, what: string, ownReserve: number, envelope: number): string => {
      // `envelope` is what the value costs beyond its own characters — the
      // key it arrives under, its quotes and its separator. Part of what it
      // costs, so part of what it has to fit inside.
      if (withinSerialized(value, withoutOwn(ownReserve) - envelope)) {
        spent += serializedLength(value) + envelope;
        reserve = Math.max(0, reserve - ownReserve);
        return value;
      }
      // Cut against the allowance that does *not* hold this marker's room,
      // because the cut is what writes the marker: `cutToLimit` subtracts
      // it from whatever it is given, so cutting against the reduced
      // allowance charged it twice and threw away a second marker's worth
      // of the server's text for nothing. A 511-character result came back
      // as 406 of its 512.
      const allowance = Math.max(0, withoutOwn(ownReserve) - envelope);
      const bounded = cutToLimit(value, allowance, what, limit);
      const cost = serializedLength(bounded) + envelope;
      // Released only when the marker did fit inside that allowance. When
      // it did not — the bare-marker case, at a cap too small to hold one
      // — the room stays held, and it is what covers the overspend, so the
      // result still weighs no more than the cap either way.
      if (cost <= withoutOwn(ownReserve)) {
        reserve = Math.max(0, reserve - ownReserve);
      }
      spent += cost;
      return bounded;
    },
  };
};
