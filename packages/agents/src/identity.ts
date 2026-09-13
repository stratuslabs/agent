import type { AvatarTheme } from '@stratusagent/core';

// First names only — agents should feel like a teammate you call by name.
// Uniqueness comes from the generated id suffix, never from the name.
const AGENT_NAMES = [
  'Ada', 'Amara', 'Arlo', 'Asha', 'August', 'Beatrix', 'Caleb', 'Camila',
  'Dara', 'Devon', 'Eleni', 'Elio', 'Esme', 'Felix', 'Freya', 'Gideon',
  'Hana', 'Hugo', 'Imani', 'Ines', 'Jasper', 'Juno', 'Kai', 'Kira',
  'Leandro', 'Lucia', 'Mabel', 'Mateo', 'Nadia', 'Nico', 'Odessa', 'Otis',
  'Priya', 'Quinn', 'Rafael', 'Romy', 'Sana', 'Silas', 'Tamsin', 'Theo',
  'Uma', 'Vera', 'Wesley', 'Xiomara', 'Yusuf', 'Zadie',
  'Alba', 'Bruno', 'Celia', 'Dashiell', 'Edie', 'Ferris', 'Greta', 'Hollis',
  'Ida', 'Jules', 'Koa', 'Lior', 'Marisol', 'Nyla', 'Oren', 'Paloma',
  'Reza', 'Sunny', 'Tobias', 'Vada', 'Wren', 'Yara', 'Zeke',
] as const;

/**
 * The one house style every Stratus agent avatar is drawn in. Surfaces
 * (CLI, web, macOS) render this style; agents differ by their name-derived
 * hue and palette, so the team looks cohesive while each member is
 * recognizable.
 */
export const AVATAR_STYLE = 'stratus';

/** Deterministic 32-bit hash so the same seed always yields the same identity. */
const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const hslToHex = (hue: number, saturation: number, lightness: number): string => {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};

/**
 * Generate a human-ish first name. Deterministic when a seed is supplied;
 * random otherwise.
 */
export const generateAgentName = (seed?: string): string => {
  const value = seed !== undefined
    ? hashSeed(seed)
    : Math.floor(Math.random() * 0xffffffff);
  return AGENT_NAMES[value % AGENT_NAMES.length] ?? 'Quinn';
};

/**
 * Derive an avatar theme from a name: a stable hue and a small palette in
 * the shared Stratus house style. Consumers (CLI, web, macOS) draw the
 * actual image from this so the agent looks the same on every surface.
 */
export const generateAvatarTheme = (name: string): AvatarTheme => {
  const value = hashSeed(name);
  const hue = value % 360;
  return {
    seed: name,
    hue,
    palette: [
      hslToHex(hue, 70, 55),
      hslToHex((hue + 30) % 360, 65, 70),
      hslToHex((hue + 180) % 360, 60, 45),
    ],
    style: AVATAR_STYLE,
  };
};

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';

/**
 * The shape an id is *minted* in: lowercase alphanumerics and internal
 * hyphens, starting with an alphanumeric. Everything `slugify` produces
 * matches it, so every id this module derives does.
 *
 * Not what validation enforces. A hand-written `id:` predates any shape
 * rule and `Ava_1` was as valid as `ava` — see `isValidAgentId`.
 */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * How long an id we *build* is allowed to get. A construction bound, not a
 * validation rule — `isValidAgentId` deliberately does not check it.
 *
 * Every id derived from a long name predates this bound, and enforcing it
 * retroactively drops working agents off the roster, while trimming them
 * silently re-keys their sessions, memory, and credentials to an id nobody
 * has ever used. So the bound applies where an id is minted fresh and
 * nothing is keyed to it yet, and nowhere else. File systems still have
 * limits, and an id long enough to hit them fails at the join with a name
 * that says so.
 */
export const MAX_AGENT_ID_LENGTH = 64;

/**
 * What an id may never be, whatever else it is: anything that stops being
 * a single, addressable path segment. A separator escapes the directory,
 * a leading dot hides the file or walks up out of it (`..`), and a control
 * character is not typeable back.
 */
const PATH_UNSAFE_ID = /[/\\]|[\u0000-\u001f\u007f]/;

/**
 * The safety half of every id rule here, shared because agent ids and
 * session ids answer it identically and a second copy would drift from the
 * first the next time one of them learned something.
 *
 * Safety only: what an id may never be. Shape — the slug pattern, a length
 * bound — is per-kind and stays with the kind, because the reasons differ.
 */
const isAddressableId = (id: string): boolean =>
  id.length > 0
  // Invisible leading or trailing space cannot be typed back reliably, so
  // an id that is not its own trimmed self is a mistake, not a legacy.
  && id === id.trim()
  && !id.startsWith('.')
  && !PATH_UNSAFE_ID.test(id)
  // An id keys plain objects too — `credentials.channels.slack[id]` among
  // them — where an inherited name is not a free slot. `toString` reads as
  // already connected with nothing stored, and `__proto__` assigns through
  // to the prototype, so the write lands nowhere and `JSON.stringify` drops
  // it. `in {}` names exactly that set, and names it by the property it
  // has rather than by a list to keep in step.
  && !(id in {});

/**
 * Whether `id` is safe to key an agent's resources and paths by.
 *
 * Ids are not labels. They key sessions, memory, credentials, Slack channel
 * tokens, and every per-agent path on disk — and an explicit frontmatter
 * `id` is untrusted input: a soul file travels with a repository, and in
 * the hosted profile it comes from a tenant. `id: ../../escape` reaches
 * every one of those joins intact, so it is stopped once here rather than
 * defended at each of them.
 *
 * **Unsafe is the rule, not un-sluglike.** Nothing before this checked an
 * explicit id at all, so `Ava_1`, `team.alpha`, and `AVA` are all out there
 * keying real sessions and real credentials. Holding them to the shape ids
 * are minted in would not make anything safer — none of them can leave
 * their directory — and `loadRosterSouls` degrades a soul that will not
 * parse to a warning, so the only thing it would accomplish is dropping
 * those agents off the roster on upgrade, quietly, while their data stays
 * behind under the old id. Reserving the slug shape for ids nobody has
 * chosen yet costs nothing; imposing it on ids people are already using
 * costs them their agent.
 *
 * Rejected, never sanitized: rewriting `../../escape` into `escape` hands
 * back an agent nobody asked for, keyed to resources nobody named.
 */
// `*` is the delegate wildcard (`delegates: ['*']`), so an agent with that
// id could never be delegated to alone — reserved rather than ambiguous.
// Agent ids only: a session id is a broader address, and the wildcard means
// nothing there.
export const isValidAgentId = (id: string): boolean => isAddressableId(id) && id !== '*';

/**
 * Whether a `delegates` entry is one the soul can hold: any agent id, or
 * the wildcard — the same rule as {@link isValidAgentId}, so every agent a
 * roster can hold can be named as a target. Exported so the control API
 * refuses a bad entry as the client's error rather than discovering it in
 * the soul round-trip.
 */
export const isValidDelegateEntry = (entry: string): boolean =>
  entry === '*' || isValidAgentId(entry);

/**
 * How much of a new session id is the *client's* to spend, on top of the
 * agent id it addresses.
 *
 * Every id in circulation is a colon-joined address that embeds the agent
 * id — `web:<agentId>:<uuid>` from the dashboard, a channel key of
 * `<channel>:<agentId>:<team>:<conversation>:<thread>`, with a bare UUID
 * from the CLI the one exception. So a flat cap is the wrong shape: agent
 * ids are deliberately unbounded (see {@link isValidAgentId}), and a flat
 * 200 refused every dashboard conversation for an agent whose id ran past
 * 159 characters — an agent that stays on the roster and simply stops being
 * chattable, which is the quiet-breakage failure the unbounded rule exists
 * to avoid.
 *
 * Budgeting the composition instead keeps the bound meaningful without
 * capping the agent id through the back door. It cannot be gamed to widen
 * itself: the allowance comes from an agent id already checked against the
 * roster, not from the caller's own string.
 */
export const MAX_SESSION_ID_LENGTH = 200;

/**
 * Ids that are a client's bug rendered as text, not an address anyone chose.
 *
 * Each is what JavaScript prints when an id was never computed — an
 * unresolved variable, a null field, arithmetic that went sideways, an
 * object concatenated into a template. The dashboard shipped the first one:
 * `/sessions/undefined/messages`, accepted, and a durable conversation
 * literally named `undefined`.
 *
 * A blocklist rather than a pattern, because these are safe, well-formed
 * strings — nothing about their *shape* is wrong, which is exactly why no
 * shape rule catches them. Kept to the strings the language itself
 * produces: guessing at what else looks like a mistake would start refusing
 * ids people meant.
 */
const STRINGIFIED_NOTHING = new Set(['undefined', 'null', 'NaN', '[object Object]']);

/**
 * Whether `id` may open a *new* conversation.
 *
 * Session ids are client-minted and a `POST` to an unknown one creates it,
 * so this is the only thing standing between an HTTP caller and a durable
 * row. `undefined`, `null`, and a bare space have all reached the session
 * table through that door — the dashboard shipped the first of them.
 *
 * **Checked where an id is minted, never where one is used.** An id already
 * in the store addresses a real conversation, whatever shape it is, and
 * re-validating on read would lock someone out of their own history to
 * enforce a rule that postdates it. Same reasoning as
 * {@link MAX_AGENT_ID_LENGTH}, which is why the length bound lives here and
 * not in {@link isValidAgentId}.
 *
 * `agentId` is the agent the id addresses, when the caller knows it — every
 * client convention embeds it, so its length is part of the budget rather
 * than something the bound gets to cap. The allowance applies only to an id
 * that actually contains it, since those are the characters being paid for;
 * a bare UUID and an unrelated string are both held to
 * {@link MAX_SESSION_ID_LENGTH} alone, as they are when `agentId` is
 * omitted.
 *
 * Shape is deliberately not enforced. Every id above is a legitimate
 * address, and no pattern admitting all of them excludes `undefined` — so
 * the safety rule, a bound, and {@link STRINGIFIED_NOTHING} are what catch
 * the real mistakes. Rejected, never sanitized: trimming an id hands the
 * caller back a conversation at an address it never asked for.
 */
export const isValidSessionId = (id: string, agentId?: string): boolean =>
  isAddressableId(id)
  // The allowance is for an id that actually *spends* those characters on
  // the agent id. Granting it merely because the request names a long-id
  // agent would let that agent's existence buy an unrelated caller 300 more
  // characters of junk — the durable-garbage case the bound is here to stop.
  && id.length <= MAX_SESSION_ID_LENGTH
    + (agentId !== undefined && id.includes(agentId) ? agentId.length : 0)
  && !STRINGIFIED_NOTHING.has(id);

/**
 * A freshly minted id, bounded — `base` trimmed so that appending `suffix`
 * still fits, with any hyphen left dangling by the trim removed.
 *
 * Only for ids nothing is keyed to yet: a generated agent's
 * name-plus-suffix, and `agent new` retrying a filename collision. Both mint
 * an id in the same breath as the agent, so trimming takes nothing away.
 * Shared rather than re-derived so the two do not each own half of the bound
 * and drift. An id derived from a name someone chose does *not* come through
 * here — that name may already have an agent behind it.
 */
export const agentIdWithSuffix = (base: string, suffix?: string): string => {
  const tail = suffix ? `-${suffix}` : '';
  const room = Math.max(1, MAX_AGENT_ID_LENGTH - tail.length);
  return `${base.slice(0, room).replace(/-+$/, '') || 'agent'}${tail}`;
};

// Ids for generated names carry a short unique suffix: the name pool is
// small, and two agents that draw the same name must still be two people —
// memory and access scopes are keyed by id. Deterministic when seeded.
export const generatedIdSuffix = (seed?: string): string => {
  const value = seed !== undefined
    ? hashSeed(`${seed}:id`)
    : Math.floor(Math.random() * 0xffffffff);
  return value.toString(36).padStart(4, '0').slice(0, 4);
};
