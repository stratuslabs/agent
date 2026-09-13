/**
 * The entries of an inline list, `[a, 'b,c', "d"]`, split on the commas
 * that are outside quotes. Splitting on every comma and unquoting after
 * turned `['foo,bar']` into the two entries `'foo` and `bar'` — for a
 * `delegates` list, a grant to two agents nobody meant and none to the
 * one they did, from a soul that loaded without complaint.
 */
const splitInlineList = (inline: string): string[] | undefined => {
  const entries: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const character of inline) {
    // A quote opens an entry only at the entry's start (after any leading
    // space): an apostrophe inside an unquoted id — o'brien — is part of
    // the id, and reading it as an opening quote would swallow every comma
    // after it into one entry no agent has.
    if (quote === undefined && (character === '"' || character === "'") && current.trim().length === 0) {
      quote = character;
    } else if (character === quote) {
      quote = undefined;
    } else if (character === ',' && quote === undefined) {
      entries.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  // A quote left open would have swallowed every comma after it into one
  // entry no agent has — for a delegates list, a typo that changes who is
  // authorized while the soul loads without complaint. Refused instead.
  if (quote !== undefined) {
    return undefined;
  }
  entries.push(current);
  return entries;
};

export const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

interface FrontmatterShape {
  /** Lowercased document kind for error messages ("soul", "skill"). */
  kind: string;
  scalarKeys: readonly string[];
  listKeys: readonly string[];
  /**
   * Keys whose value is a block of `key: value` string pairs (the Agent
   * Skills spec's `metadata:`). Read only in tolerant mode, which is the
   * only dialect that writes one.
   */
  mapKeys?: readonly string[];
  /**
   * Ignore what the shape does not name instead of refusing it — unknown
   * keys, whatever indented block sits under one, and the YAML block and
   * multi-line scalars other ecosystems write.
   *
   * Skills opt in: they travel an ecosystem whose frontmatter carries
   * fields other hosts own (`license`, `metadata`, `allowed-tools`), and
   * refusing those would refuse most published skills over metadata that
   * changes nothing here. Souls stay strict, deliberately — an unknown
   * soul key can be a typo'd allowlist, and a soul that loads with
   * silently weaker access is the worse failure.
   */
  tolerant?: boolean;
}

export interface ParsedFrontmatter {
  scalars: Partial<Record<string, string>>;
  lists: Partial<Record<string, string[]>>;
  maps: Partial<Record<string, Record<string, string>>>;
  /**
   * Top-level keys the shape does not name, in file order. Tolerant mode
   * skips them; this is how a validator still gets to say which ones it
   * skipped, so a misspelled field is a warning somebody reads instead of
   * silence.
   */
  unknownKeys: string[];
}

// A deliberately tiny frontmatter dialect: `key: value` scalars and block
// lists of `- item` lines. Enough for souls and skills, no YAML dependency.
// Tolerant mode (see FrontmatterShape) additionally reads the block-scalar
// forms (`description: >-` and friends) and plain multi-line scalars, and
// skips unknown keys with their nested blocks.
export const parseFrontmatterLines = (lines: string[], shape: FrontmatterShape): ParsedFrontmatter => {
  const scalars: ParsedFrontmatter['scalars'] = {};
  const lists: ParsedFrontmatter['lists'] = {};
  const maps: ParsedFrontmatter['maps'] = {};
  const unknownKeys: string[] = [];
  const tolerant = shape.tolerant ?? false;
  let currentList: string[] | undefined;
  let currentMap: Record<string, string> | undefined;
  // Tolerant-mode line context: an unknown key whose indented block is
  // being skipped, or a known scalar whose value continues on indented
  // lines (a YAML block scalar, or a plain scalar that wraps). Inside
  // either, blank lines and lines starting with # are content or skipped
  // block — never the comments the top level treats them as — so both are
  // handled before the comment filter below.
  let skippingUnknownBlock = false;
  let continuation: { key: string; literal: boolean; pendingBreak: boolean } | undefined;

  const isIndented = (line: string): boolean => /^\s/.test(line);

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const blank = line.trim().length === 0;

    if (tolerant && skippingUnknownBlock && (blank || isIndented(line))) {
      continue;
    }
    if (tolerant && continuation) {
      if (blank) {
        // A blank line is a line break in a literal block and a paragraph
        // break in a folded or plain one — never the end of the value.
        if (continuation.literal) {
          const existing = scalars[continuation.key] ?? '';
          if (existing.length > 0) {
            scalars[continuation.key] = `${existing}\n`;
          }
        } else {
          continuation.pendingBreak = true;
        }
        continue;
      }
      if (isIndented(line)) {
        const existing = scalars[continuation.key] ?? '';
        const separator = continuation.literal || continuation.pendingBreak ? '\n' : ' ';
        continuation.pendingBreak = false;
        // The raw content, not unquote(): inside a block scalar a quote or
        // a # is text, and YAML agrees.
        const piece = line.trim();
        scalars[continuation.key] = existing.length > 0 ? `${existing}${separator}${piece}` : piece;
        continue;
      }
      // A non-indented line ends the value; fall through to read it.
    }

    if (blank || line.trim().startsWith('#')) {
      continue;
    }

    if (currentMap && isIndented(line)) {
      // One level of `key: value` pairs, every value a string — the
      // spec's shape for `metadata`. Anything deeper is not a string
      // value, and refusing it beats reading the wrong half of it.
      // Any string is a key — quoted (`"vendor/key": v`), or bare up to
      // the first colon — since the spec types the map as string to
      // string and says nothing about what a key looks like.
      const pair = /^\s+(?:"([^"]*)"|'([^']*)'|([^\s"'#][^:]*?))\s*:\s*(.*)$/.exec(line);
      const mapKey = pair?.[1] ?? pair?.[2] ?? pair?.[3]?.trim();
      if (!pair || mapKey === undefined || mapKey.length === 0 || pair[4] === undefined || unquote(pair[4]).length === 0) {
        throw new Error(
          `${capitalize(shape.kind)} frontmatter metadata entries must be "key: value" strings, one per line: "${line.trim()}"`,
        );
      }
      currentMap[mapKey] = unquote(pair[4]);
      continue;
    }

    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem) {
      if (!currentList) {
        throw new Error(`${capitalize(shape.kind)} frontmatter has a list item outside a list: "${line.trim()}"`);
      }
      const item = unquote(listItem[1] ?? '');
      if (item.length > 0) {
        currentList.push(item);
      }
      continue;
    }

    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!entry) {
      throw new Error(`${capitalize(shape.kind)} frontmatter line is not "key: value": "${line.trim()}"`);
    }

    const key = entry[1] ?? '';
    const value = entry[2] ?? '';
    currentList = undefined;
    currentMap = undefined;
    skippingUnknownBlock = false;
    continuation = undefined;

    if (tolerant && shape.mapKeys?.includes(key)) {
      const inline = value.trim();
      if (inline.length > 0 && inline !== '{}') {
        throw new Error(
          `${capitalize(shape.kind)} frontmatter "${key}" must be a block of indented "key: value" lines: "${inline}"`,
        );
      }
      const map: Record<string, string> = {};
      maps[key] = map;
      currentMap = map;
      continue;
    }

    if (shape.listKeys.includes(key)) {
      const list: string[] = [];
      lists[key] = list;
      const inline = value.trim();
      if (inline.length > 0) {
        // Inline form: tools: [a, b]
        const match = /^\[(.*)\]$/.exec(inline);
        if (!match) {
          throw new Error(`${capitalize(shape.kind)} frontmatter list "${key}" must be a block list or [a, b]: "${inline}"`);
        }
        const items = splitInlineList(match[1] ?? '');
        if (items === undefined) {
          throw new Error(`${capitalize(shape.kind)} frontmatter list "${key}" has an unterminated quote: "${inline}"`);
        }
        for (const item of items) {
          const cleaned = unquote(item);
          if (cleaned.length > 0) {
            list.push(cleaned);
          }
        }
      } else {
        currentList = list;
      }
      continue;
    }

    if (!shape.scalarKeys.includes(key)) {
      if (tolerant) {
        // The key and anything nested under it belong to some other host.
        // Remembered, not refused: a validator reports them.
        unknownKeys.push(key);
        skippingUnknownBlock = true;
        continue;
      }
      throw new Error(
        `Unknown ${shape.kind} frontmatter key: "${key}". Supported keys: ${[...shape.scalarKeys, ...shape.listKeys].join(', ')}.`,
      );
    }

    const inline = value.trim();
    // YAML block-scalar headers: `>` folds continuation lines with spaces,
    // `|` keeps their line breaks; either may carry an indentation digit
    // and a chomping sign in either order, and a trailing comment. Only
    // meaningful in tolerant mode — the strict dialect never wrote them.
    if (tolerant && /^[>|](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/.test(inline)) {
      scalars[key] = '';
      continuation = { key, literal: inline.startsWith('|'), pendingBreak: false };
      continue;
    }

    const scalar = unquote(value);
    if (scalar.length === 0) {
      if (tolerant) {
        // May be a plain scalar continuing on indented lines; empty stays
        // empty and is dropped below if nothing follows.
        scalars[key] = '';
        continuation = { key, literal: false, pendingBreak: false };
        continue;
      }
      throw new Error(`${capitalize(shape.kind)} frontmatter key "${key}" has no value.`);
    }
    scalars[key] = scalar;
    if (tolerant) {
      continuation = { key, literal: false, pendingBreak: false };
    }
  }

  // A tolerant block scalar that never got a body reads as absent, not as
  // an empty string that would satisfy a required-field check.
  for (const [key, value] of Object.entries(scalars)) {
    if (value !== undefined && value.length === 0) {
      delete scalars[key];
    }
  }

  return { scalars, lists, maps, unknownKeys };
};

const capitalize = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/**
 * Split a markdown document into its `---`-fenced frontmatter lines (if
 * any) and the body after them. Shared by souls and skills — one reading
 * of what the fences mean, wherever the dialect appears.
 */
export const extractFrontmatter = (
  source: string,
  kind: string,
): { lines: string[] | undefined; body: string } => {
  const normalized = source.replace(/\r\n/g, '\n');
  const opener = /^---[ \t]*\n/.exec(normalized);
  if (!opener) {
    return { lines: undefined, body: normalized };
  }
  const closer = /\n---[ \t]*(\n|$)/.exec(normalized.slice(opener[0].length - 1));
  if (!closer || closer.index === undefined) {
    throw new Error(`${capitalize(kind)} frontmatter opened with --- but never closed.`);
  }
  const frontmatterEnd = opener[0].length - 1 + closer.index;
  return {
    lines: normalized.slice(opener[0].length, frontmatterEnd).split('\n'),
    body: normalized.slice(frontmatterEnd + closer[0].length),
  };
};

/**
 * Render an agent definition as a soul file, ready to save and edit. The
 * inverse of parseSoul for round-tripping `stratus agent new` output.
 */
/**
 * A scalar or list entry as the soul writer emits it. The parser strips
 * one layer of matching quotes from every value, so a value that begins
 * and ends with the same quote — an agent id like `'bea'`, which
 * {@link isValidAgentId} allows — would come back as `bea`: for a
 * `delegates` entry that is a permission changed by an unrelated edit,
 * since the control API renders a soul through here on every field edit.
 * Such a value is wrapped in the other quote, which the parser strips
 * back off; so is one the parser's trim would alter.
 */
export const writeScalar = (value: string): string =>
  unquote(value) === value ? value : (value.startsWith('"') ? `'${value}'` : `"${value}"`);
