export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/**
 * `pending_approval` is a turn parked on a human, and it is durable on
 * purpose: it is the index a restarting daemon uses to find the turns it
 * owes an answer. Everything else about the turn is already in the
 * session; this is what makes it findable without reading every row.
 */
export type SessionStatus = 'idle' | 'running' | 'pending_approval' | 'completed' | 'failed';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  name?: string;
  createdAt: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  instructions?: string;
}

export interface AvatarTheme {
  seed: string;
  hue: number;
  palette: string[];
  style: string;
}

/**
 * A full agent identity. An agent is one "person": the same definition —
 * memory, tool access, credentials — applies no matter which channel,
 * thread, or session the agent is talking through.
 */
export interface AgentDefinition extends AgentDescriptor {
  avatar?: AvatarTheme;
  /**
   * What this agent may call: exact tool names (`fs.read`), toolset globs
   * (`fs.*`), or `*`. Omitted = every registered tool. See
   * `matchesToolAllowlist`, which is the only reading of these entries.
   */
  tools?: string[];
  /**
   * Skills this agent may load: exact ids (`code-review`), a package's
   * qualified ids (`stratus-plugin-github:*`), or `*`. Omitted = none,
   * matching `credentials` rather than `tools` — a skill silently changing
   * how an agent behaves is worse than an agent that has to be told. See
   * `matchesSkillAllowlist`, which is the only reading of these entries.
   */
  skills?: string[];
  /** Credential names this agent may resolve. Omitted = none. */
  credentials?: string[];
}

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): AgentDefinition {
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  /**
   * Look up an agent by display name. Names are not required to be unique
   * (ids are), so an ambiguous name throws rather than silently picking one
   * — routing work to the wrong identity would cross memory and access
   * scopes.
   */
  getByName(name: string): AgentDefinition | undefined {
    const matches = this.list().filter((agent) => agent.name === name);
    if (matches.length > 1) {
      throw new Error(
        `Agent name is ambiguous: ${name} (ids: ${matches.map((agent) => agent.id).join(', ')}). Use the id instead.`,
      );
    }
    return matches[0];
  }

  /**
   * Forget an agent, reporting whether one was registered under that id.
   *
   * A roster reload has to be able to *remove*. Re-registering the survivors
   * over a map nothing ever deletes from leaves an agent whose soul file was
   * deleted addressable — by id, and from every channel — for the rest of the
   * daemon's life.
   */
  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  require(id: string): AgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }
    return agent;
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

export interface Session {
  id: string;
  /**
   * The full definition, not just the descriptor: an agent's tool allowlist
   * travels with its session, so a runner can enforce it for an agent that
   * was never registered. Typed as a descriptor, this was read through a
   * cast — the type said the allowlist could not be here while the runner
   * depended on it being here.
   */
  agent: AgentDefinition;
  status: SessionStatus;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
  lastError?: string;
  /**
   * What this conversation has consumed, one record per provider call, in the
   * order the calls completed. Absent until something reports.
   *
   * Durable state like the messages: it round-trips through the session
   * store, so a past session's usage survives a restart and a resumed session
   * *adds* to what it already had rather than starting over. The stored form
   * is the records — a total is derived by whoever wants one
   * (`totalTokenUsage`), never written here.
   */
  usage?: UsageRecord[];
}

export interface ToolCall {
  id: string;
  toolName: string;
  input: JsonObject;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  ok: boolean;
  output: JsonValue;
  error?: string;
}

export type ProviderPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall };

/**
 * A streamed fragment of an in-progress provider response. Text deltas carry
 * output as it is generated; tool-call deltas announce that the model has
 * started emitting a call (input may still be incomplete). A reset delta
 * tells consumers to DISCARD every fragment streamed so far for this
 * response — emitted when a provider abandons a partial attempt (e.g. a
 * fallback wrapper retrying after the primary failed mid-stream), so
 * renderers never fuse two attempts into one message.
 */
export type ProviderDelta =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; inputFragment?: string }
  /**
   * The model is reasoning: a content-free progress signal so activity
   * watchdogs see a healthy turn during long thinking stretches. The
   * reasoning itself is deliberately never carried here.
   */
  | { type: 'thinking' }
  | {
      type: 'reset';
      /**
       * Why the partial was abandoned.
       *
       * `fallback` means a *different provider* is now serving this turn,
       * and is the only case in which anything about the active provider
       * changed. Everything else is the same provider starting over — a
       * retried attempt after a failed resume, say — and a consumer that
       * tracks which provider is running must not treat it as a switch.
       *
       * Absent reads as `retry`, deliberately: the conservative answer for
       * an emitter that has not thought about it is "nothing changed", not
       * "the provider swapped underneath you".
       */
      reason?: 'fallback' | 'retry';
    };

/**
 * How much damage an invocation of this tool could do, coarse on purpose:
 * a policy needs to separate "let it run unattended" from "a human decides"
 * without understanding what any particular tool does.
 *
 * - `safe` — contained: reads, work inside the fleet, and writes the agent
 *   already owns (its own memory).
 * - `gated` — a human should decide when nobody is watching: anything that
 *   acts on the world outside Stratus — the filesystem, the network,
 *   another service — or writes where other people read.
 * - `dangerous` — destructive or hard to undo, and **outside the scope
 *   engine entirely**: no `commandFor`, `destinationFor`, or `originFor`
 *   narrows it, and no answer is remembered, so a human decides every time
 *   or it is refused.
 *
 * No first-party tool declares `dangerous` any more. `browser.act` was its
 * only member, and it was there because no scope model existed for a click
 * rather than because a click is worse than a shell — per-origin scopes
 * gave it one, and it is `gated` now. The tier stays because its real
 * constituency was never the tools in this repository: a plugin manifest
 * may declare it, and an operator's `toolRisks` may raise a bridged MCP
 * tool to it, which is the only way to say "never unattended, whatever
 * scopes exist" about somebody else's code.
 *
 * Provider spend is deliberately not the line. Every turn spends: a message
 * arriving in Slack causes a provider call nobody approved, so a policy
 * that gated on cost would have to gate the conversation itself. What is
 * worth a human's attention is effects that outlive the turn and reach
 * past Stratus — which is also what containment (later) would isolate.
 *
 * Undeclared is not `safe`. `resolveToolRisk` treats a missing risk as
 * `gated`, so a tool added without thinking about this is held back rather
 * than waved through — the failure mode of forgetting should be a prompt,
 * not an unattended shell command.
 */
export type ToolRisk = 'safe' | 'gated' | 'dangerous';

export const DEFAULT_TOOL_RISK: ToolRisk = 'gated';

/** The declared risk, or the fail-closed default for a tool that omits it. */
export const resolveToolRisk = (tool: Pick<Tool, 'risk'> | undefined): ToolRisk =>
  tool?.risk ?? DEFAULT_TOOL_RISK;

const RISK_ORDER: Record<ToolRisk, number> = { safe: 0, gated: 1, dangerous: 2 };

/**
 * Whether `risk` is at least as risky as `floor`. The ordering lives here,
 * with the type, because two things compare against it — the permission
 * engine deciding what needs a human, and the plugin loader holding a
 * third-party tool to a floor — and a second ordering is a second answer
 * to "is `safe` above or below `gated`".
 */
export const atLeastAsRisky = (risk: ToolRisk, floor: ToolRisk): boolean =>
  RISK_ORDER[risk] >= RISK_ORDER[floor];

/** `risk`, raised to `floor` when it sits below it. Never lowers anything. */
export const raiseRiskTo = (risk: ToolRisk, floor: ToolRisk): ToolRisk =>
  atLeastAsRisky(risk, floor) ? risk : floor;

/**
 * The origin of a URL — scheme, host, and port, and nothing else — or
 * nothing when it does not have one this codebase is willing to name.
 *
 * The canonical form of what `Tool.originFor` returns, and therefore the
 * canonical form of what an origin scope is compared against: the browser
 * pack derives one from the page a conversation is on, the permission
 * engine parses one out of a hand-edited grant file, and a second reading
 * of "same site" between those two would be a grant that matches on one
 * side and not the other. It lives here for the same reason
 * `matchesToolAllowlist` does — with the seam whose contract it defines.
 *
 * Only `http:` and `https:` produce one. `about:blank`, `file:`, and
 * `data:` have no meaningful origin (the URL parser answers the string
 * `"null"` for them), and a grant that could be spelled `null` would cover
 * every one of them at once.
 *
 * Note what is dropped, because it is what makes an origin nameable: no
 * path, no query, no fragment, no credentials. A host is normalized the
 * way the URL parser normalizes it — lowercased, and IDN hosts in their
 * punycode form — so a homograph spelling of an approved host cannot be a
 * second way to write the same grant.
 */
export const originOf = (rawUrl: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
};

/**
 * Where a tool's call would act for this session, in `originOf` form, or
 * nothing when the tool does not answer that. Normalized rather than taken
 * as written, so every comparison of an origin in this codebase is of the
 * same thing.
 */
const originForSession = (tool: Pick<Tool, 'originFor'>, session: Session): string | undefined => {
  const reported = tool.originFor?.(session);
  return reported === undefined ? undefined : originOf(reported);
};

/**
 * Whether an agent's `tools:` allowlist permits a tool name.
 *
 * Two entry forms, and the glob is why this is a function rather than a
 * `Set.has`: a toolset is the unit an operator thinks in — an agent is
 * given "the filesystem", not four names that must be edited whenever the
 * pack gains a fifth — so `fs.*` selects the whole namespace.
 *
 * - `fs.read` — that tool, exactly.
 * - `fs.*` — every tool in the `fs` toolset, nested names included, so
 *   `mcp.*` covers `mcp.linear.create_issue` (which is the only form the
 *   MCP bridge can be granted, since its names exist only at runtime).
 *
 * The prefix carries its dot deliberately: `fs.*` matches `fs.read` and
 * does **not** match `fsx.read`, so a namespace cannot be widened by a
 * package that named itself to look like a prefix of another. A bare `*`
 * is every registered tool, which is the same thing as omitting the
 * allowlist and is accepted because a soul saying so explicitly is
 * clearer than one saying nothing.
 *
 * Exported because both gates use it — the descriptors a provider is shown
 * and the check before execution — and because a second reading of `fs.*`
 * is a second answer to "what may this agent do".
 */
export const matchesToolAllowlist = (toolName: string, allowlist: readonly string[]): boolean =>
  matchesGlobbedAllowlist(toolName, allowlist, '.*');

/**
 * Whether an agent's `skills:` allowlist permits a skill id.
 *
 * The same machinery as `matchesToolAllowlist` — one implementation of
 * "does this glob select this name", not a second — with the separator the
 * qualified skill form uses: `stratus-plugin-github:*` selects every skill
 * that package contributes, `stratus-plugin-github:pr-review` exactly one,
 * `code-review` an unqualified operator-installed skill, and `*` all of
 * them. The glob keeps its colon for the same reason the tool glob keeps
 * its dot: `pkg:*` must not be widened by a package that named itself to
 * look like a prefix of another.
 */
export const matchesSkillAllowlist = (skillId: string, allowlist: readonly string[]): boolean =>
  matchesGlobbedAllowlist(skillId, allowlist, ':*');

/**
 * Whether a tools allowlist plausibly covers a requirement — an exact tool
 * name (`fs.read`) or a toolset glob (`browser.*`), the forms a skill's
 * `requires:` is written in.
 *
 * Advisory by design: it feeds the load-time warning for an agent enabling
 * a skill without the tools the skill expects, never an enforcement
 * decision. An omitted allowlist is every registered tool, so it covers
 * anything; a glob requirement is covered by the glob itself, by `*`, or
 * by any entry naming something inside the namespace.
 */
export const toolAllowlistCovers = (
  requirement: string,
  allowlist: readonly string[] | undefined,
): boolean => {
  if (allowlist === undefined) {
    return true;
  }
  if (requirement.endsWith('.*')) {
    return allowlist.some(
      (entry) => entry === '*' || entry === requirement || matchesToolAllowlist(entry, [requirement]),
    );
  }
  return matchesToolAllowlist(requirement, allowlist);
};

/** One skill an agent enabled without the tools it expects. Advisory — see `missingSkillRequirements`. */
export interface SkillRequirementFinding {
  skill: Skill;
  /** The `requires:` entries the agent's tools allowlist does not cover. */
  missing: string[];
}

/**
 * The `requires:` entries of this agent's enabled skills that its `tools:`
 * allowlist does not cover — what the load-time warning reports.
 *
 * One implementation, exported, because two hosts warn about the same
 * configuration: the gateway at roster load and the CLI before a local
 * run. A copy in each would drift, and `stratus run` staying silent about
 * a soul `stratus serve` warns for is exactly the disagreement the local
 * test exists to prevent. Advisory by design — a skill is prose and can
 * degrade, so callers warn and continue, never refuse.
 */
export const missingSkillRequirements = (
  agent: Pick<AgentDefinition, 'skills' | 'tools'>,
  skills: SkillRegistry,
): SkillRequirementFinding[] => {
  const allowlist = agent.skills;
  if (!allowlist || allowlist.length === 0) {
    return [];
  }
  const findings: SkillRequirementFinding[] = [];
  for (const skill of skills.list()) {
    if (!skill.requires || skill.requires.length === 0) {
      continue;
    }
    const enabled = skills
      .idsFor(skill.id)
      .some((id) => matchesSkillAllowlist(id, allowlist));
    if (!enabled) {
      continue;
    }
    const missing = skill.requires.filter(
      (requirement) => !toolAllowlistCovers(requirement, agent.tools),
    );
    if (missing.length > 0) {
      findings.push({ skill, missing });
    }
  }
  return findings;
};

const matchesGlobbedAllowlist = (
  name: string,
  allowlist: readonly string[],
  globSuffix: string,
): boolean =>
  allowlist.some((entry) => {
    if (entry === '*' || entry === name) {
      return true;
    }
    return entry.endsWith(globSuffix) && name.startsWith(entry.slice(0, -1));
  });

export interface ToolDescriptor {
  name: string;
  description?: string;
  parameters?: JsonObject;
  /** Carried so providers hosting their own loop can see it too. */
  risk?: ToolRisk;
}

/**
 * One remembered fact. Memory is keyed by agent, never by session or
 * channel, so an agent carries the same knowledge everywhere it appears.
 */
export interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  createdAt: string;
  metadata?: JsonObject;
}

/**
 * A memory entry as the operator's audit read returns it: tombstoned entries
 * stay visible there, marked with when the agent dropped them. The paths that
 * build a prompt (`list`, `search`) never return a tombstoned entry.
 */
export interface MemoryAuditEntry extends MemoryEntry {
  forgottenAt?: string;
}

/** Per-entry write cap, in UTF-8 bytes. `append` refuses larger, never truncates. */
export const MEMORY_ENTRY_MAX_BYTES = 4096;
/**
 * Aggregate content budget for a bounded read, in UTF-8 bytes. Applied by the
 * store — a caller-chosen `limit` cannot be a safety property — and sized so
 * several cap-size entries still fit (see `MEMORY_ENTRY_MAX_BYTES`).
 */
export const MEMORY_READ_MAX_BYTES = 16384;
/** Results a `search` returns when the caller names no limit. */
export const MEMORY_RECALL_DEFAULT_LIMIT = 10;
/** Ceiling a `search` limit is clamped to, whatever the caller asked for. */
export const MEMORY_RECALL_MAX_LIMIT = 50;
/** How many recent entries the runner injects into the system prompt. */
export const MEMORY_INJECTION_LIMIT = 20;

const utf8Encoder = new TextEncoder();

/** UTF-8 size of an entry's content — the unit both memory caps are stated in. */
export const memoryContentByteLength = (content: string): number => utf8Encoder.encode(content).length;

/** Refuses (never truncates) content over the per-entry cap: a half-stored fact is worse than a refused one. */
export const assertMemoryContentWithinCap = (content: string): void => {
  const bytes = memoryContentByteLength(content);
  if (bytes > MEMORY_ENTRY_MAX_BYTES) {
    throw new Error(
      `Memory entries are capped at ${MEMORY_ENTRY_MAX_BYTES} UTF-8 bytes and this fact is ${bytes}. Nothing was stored — remember a shorter fact instead.`,
    );
  }
};

/**
 * The tokenizer both store implementations share: NFC-normalized,
 * case-folded, split on anything that is not a Unicode letter or digit.
 * Search matching is defined on these tokens — `Postgres` finds `postgres`,
 * `postgres` does not find `postgresql` — so an implementation that
 * tokenizes differently is wrong, not different.
 */
export const tokenizeMemoryText = (text: string): string[] =>
  text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Whether content matches a tokenized query: every query token must be
 * present as a whole token. A query that tokenized to nothing matches
 * nothing — recall with no searchable terms is a question that was not
 * asked, not a request for everything.
 */
export const memoryQueryMatches = (content: string, queryTokens: readonly string[]): boolean => {
  if (queryTokens.length === 0) {
    return false;
  }
  const tokens = new Set(tokenizeMemoryText(content));
  return queryTokens.every((token) => tokens.has(token));
};

/**
 * Recall order — newest first, ties on `createdAt` broken by entry id
 * ascending. The tie-break is not about frequency: without one, two
 * implementations ordering equal keys differently are both conforming.
 * `createdAt` values are ISO-8601 UTC strings, so plain string comparison
 * is chronological comparison.
 */
export const compareMemoryRecallOrder = (a: MemoryEntry, b: MemoryEntry): number => {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Chronological order (oldest first), same tie-break — how a bounded `list` presents its slice. */
export const compareMemoryChronology = (a: MemoryEntry, b: MemoryEntry): number => {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export interface MemoryReadResult {
  entries: MemoryEntry[];
  /** True when live entries beyond these existed — the entry limit or the byte budget bound, whichever bit first. */
  truncated: boolean;
}

export interface MemoryListOptions {
  /**
   * Bound the read to the most recent live entries. A bounded read also
   * stops at `MEMORY_READ_MAX_BYTES` of content, whichever binds first,
   * and marks the result `truncated`. Omitted, the read is the host's
   * unbounded one (counting, audit-adjacent display) — the paths that
   * feed a model always pass a bound.
   */
  limit?: number;
}

/** Clamp a caller-chosen search limit into the store's own bounds. */
export const clampMemoryRecallLimit = (limit?: number): number => {
  if (limit === undefined || Number.isNaN(limit)) {
    return MEMORY_RECALL_DEFAULT_LIMIT;
  }
  // Infinity means "as many as allowed" and clamps to the ceiling like any
  // other over-large number, rather than falling back to the default.
  return Math.min(MEMORY_RECALL_MAX_LIMIT, Math.max(1, Math.floor(limit)));
};

/**
 * Apply the bounded-read rule both implementations share: sort candidates
 * into recall order (newest first, ties by id), then keep entries until the
 * entry limit or the byte budget binds. The winners when more match than
 * `limit` are decided here, once — an implementation choosing differently
 * would be a divergence, not a preference.
 */
export const boundMemoryRead = (
  candidates: readonly MemoryEntry[],
  limit: number,
  maxBytes: number = MEMORY_READ_MAX_BYTES,
): MemoryReadResult => {
  const ordered = [...candidates].sort(compareMemoryRecallOrder);
  const entries: MemoryEntry[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of ordered) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    const size = memoryContentByteLength(entry.content);
    // An entry no budget could ever admit — hand-written, or stored before
    // the per-entry cap existed — is skipped rather than allowed to starve
    // everything ranked behind it: breaking here would return an empty
    // read while dozens of small live facts exist.
    if (size > maxBytes) {
      truncated = true;
      continue;
    }
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    entries.push(entry);
    bytes += size;
  }
  return { entries, truncated };
};

/**
 * The bounded `list` both implementations share: select the winners by
 * `boundMemoryRead`, present them oldest first. Selection order and
 * presentation order are different things; conflating them is the bug this
 * helper exists so nobody writes three times.
 */
export const boundMemoryList = (candidates: readonly MemoryEntry[], limit: number): MemoryReadResult => {
  const bounded = boundMemoryRead(candidates, Math.max(1, Math.floor(limit)));
  bounded.entries.sort(compareMemoryChronology);
  return bounded;
};

/**
 * Durable, searchable memory an agent writes and reads deliberately. The
 * per-agent key is the access boundary — every method takes the agent id the
 * caller resolved from the session, never one captured at startup.
 *
 * The contract is deliberately over-specified because two implementations
 * exist (in-memory here, FTS5-backed in `@stratusagent/state`) and anything
 * left to the implementation is a guaranteed divergence:
 *
 * - `search` matches when every query token is present (case-insensitive,
 *   NFC-normalized, on `tokenizeMemoryText`'s boundaries). The query is
 *   literal text, never search syntax: no input is a syntax error.
 * - `search` returns newest first; a bounded `list` selects the most recent
 *   live entries and presents them oldest first. Ties on `createdAt` break
 *   by entry id, ascending, everywhere.
 * - `list` and `search` return live entries only, bounded by
 *   `MEMORY_READ_MAX_BYTES` when a limit is in play; `forget` tombstones
 *   rather than deletes, and `audit` is where tombstoned entries remain
 *   visible to an operator.
 */
export interface AgentMemoryStore {
  /** Refuses content over `MEMORY_ENTRY_MAX_BYTES` rather than truncating it. */
  append(agentId: string, content: string, metadata?: JsonObject): Promise<MemoryEntry>;
  /** Live entries, oldest first. See `MemoryListOptions` for the bounded form. */
  list(agentId: string, options?: MemoryListOptions): Promise<MemoryReadResult>;
  /** Live entries matching the literal query, newest first, bounded. */
  search(agentId: string, query: string, limit?: number): Promise<MemoryReadResult>;
  /** Tombstones a live entry. False when no live entry of this agent has that id. */
  forget(agentId: string, entryId: string): Promise<boolean>;
  /** The operator's audit read: every entry, tombstoned included, oldest first. */
  audit(agentId: string): Promise<MemoryAuditEntry[]>;
}

export class InMemoryAgentMemoryStore implements AgentMemoryStore {
  private entries = new Map<string, MemoryAuditEntry[]>();
  private counter = 0;
  private readonly now: () => Date;

  // `now` is a test seam: the ordering tie-break only shows itself when two
  // entries share a createdAt, which a real clock makes non-deterministic.
  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async append(agentId: string, content: string, metadata?: JsonObject): Promise<MemoryEntry> {
    assertMemoryContentWithinCap(content);
    this.counter += 1;
    const entry: MemoryAuditEntry = {
      id: `${agentId}:memory:${this.counter}`,
      agentId,
      content,
      createdAt: this.now().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
    const existing = this.entries.get(agentId) ?? [];
    existing.push(entry);
    this.entries.set(agentId, existing);
    return { ...entry };
  }

  private live(agentId: string): MemoryEntry[] {
    return (this.entries.get(agentId) ?? [])
      .filter((entry) => entry.forgottenAt === undefined)
      .map(({ forgottenAt: _unused, ...entry }) => entry);
  }

  async list(agentId: string, options: MemoryListOptions = {}): Promise<MemoryReadResult> {
    const live = this.live(agentId);
    if (options.limit === undefined) {
      return { entries: live.sort(compareMemoryChronology), truncated: false };
    }
    return boundMemoryList(live, options.limit);
  }

  async search(agentId: string, query: string, limit?: number): Promise<MemoryReadResult> {
    const tokens = tokenizeMemoryText(query);
    if (tokens.length === 0) {
      return { entries: [], truncated: false };
    }
    const matches = this.live(agentId).filter((entry) => memoryQueryMatches(entry.content, tokens));
    return boundMemoryRead(matches, clampMemoryRecallLimit(limit));
  }

  async forget(agentId: string, entryId: string): Promise<boolean> {
    const entry = (this.entries.get(agentId) ?? []).find(
      (candidate) => candidate.id === entryId && candidate.forgottenAt === undefined,
    );
    if (!entry) {
      return false;
    }
    entry.forgottenAt = this.now().toISOString();
    return true;
  }

  async audit(agentId: string): Promise<MemoryAuditEntry[]> {
    return (this.entries.get(agentId) ?? []).map((entry) => ({ ...entry })).sort(compareMemoryChronology);
  }
}

/**
 * Resolves named credentials for an agent. Implementations must enforce the
 * agent's `credentials` allowlist so secrets stay scoped per agent.
 */
export interface CredentialResolver {
  resolve(agent: AgentDefinition, name: string): Promise<string | undefined>;
}

export interface ScopedCredentials {
  get(name: string): Promise<string>;
}

/**
 * The allowlist half of every `CredentialResolver`, so a second
 * implementation cannot quietly become a second policy.
 *
 * This is the check that makes an agent's `credentials:` list mean
 * something, and it belongs to the contract rather than to whichever
 * resolver a host happens to install — a file-backed resolver that forgot
 * it would hand every agent every key while still satisfying the interface.
 */
export const assertCredentialAllowed = (agent: AgentDefinition, name: string): void => {
  if (!agent.credentials?.includes(name)) {
    throw new Error(`Agent ${agent.id} is not allowed to access credential: ${name}`);
  }
};

export class EnvCredentialResolver implements CredentialResolver {
  private readonly env: Record<string, string | undefined>;

  // Pass process.env (or any map) explicitly — core stays platform-agnostic.
  constructor(env: Record<string, string | undefined>) {
    this.env = env;
  }

  async resolve(agent: AgentDefinition, name: string): Promise<string | undefined> {
    assertCredentialAllowed(agent, name);
    return this.env[name];
  }
}

export const scopeCredentials = (
  agent: AgentDefinition,
  resolver: CredentialResolver,
): ScopedCredentials => ({
  async get(name) {
    const value = await resolver.resolve(agent, name);
    if (value === undefined) {
      throw new Error(`Credential not found: ${name}`);
    }
    return value;
  },
});

/**
 * What one provider call consumed, in the four buckets every vendor
 * distinguishes and a price table charges separately for.
 *
 * Every count is optional and **absent means "not reported"**, never zero:
 * zero is a measurement, and a fabricated one would let a consumer state a
 * cost for a provider that said nothing about it.
 *
 * The buckets are **disjoint**. `inputTokens` is prompt input billed at the
 * full rate — cache reads and cache writes are counted in their own fields
 * and never again here. That is Anthropic's own shape; vendors that report
 * an all-inclusive prompt count (the OpenAI family's `prompt_tokens`, which
 * includes its cached tokens) are normalized to it by their adapter, with
 * `uncachedInputTokens` doing the subtraction so the rule has one
 * implementation. Records from two providers are directly comparable
 * because of it, which is the whole point of preserving attribution.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * One provider call's usage as the adapter reports it — the counts plus the
 * attribution only the adapter knows.
 *
 * `provider` defaults to the name of the provider the runner asked, which is
 * right for a plain adapter and **wrong under the fallback wrapper**: that
 * wrapper answers to the primary's name for the life of the session, so a
 * call the fallback actually served would be attributed to the primary. Every
 * adapter in this repository sets it explicitly, and the wrapper fills it in
 * for adapters that do not.
 *
 * `model` is absent rather than guessed when a harness switched models
 * internally and did not say which one ran.
 */
export interface ProviderCallUsage extends TokenUsage {
  provider?: string;
  model?: string;
}

/**
 * One provider call's usage, attributed. This is the *stored* form: a
 * session keeps the records, never a summed scalar.
 *
 * A thousand tokens of one model is not a thousand of another, input and
 * output are priced differently, cache reads and writes differ again, and
 * the fallback wrapper can cross providers inside one session. Collapsing
 * any of those at write time throws away what no downstream consumer can
 * reconstruct — so nothing is collapsed. `totalTokenUsage` derives a
 * convenience total, and that total is a view.
 */
export interface UsageRecord extends TokenUsage {
  /**
   * The Stratus turn these tokens belong to — one pass through the runner,
   * which is one provider call for the kernel-loop adapters and several for
   * a harness provider running its own inner loop.
   *
   * Part of the record rather than something to reconstruct: ordering does
   * not recover the boundaries once a harness turn contributes several
   * records of its own, and a durable session resumed across many turns
   * accumulates records that are otherwise indistinguishable the moment two
   * share a provider and model.
   */
  turnId: string;
  provider: string;
  model?: string;
}

/**
 * `TokenUsage.inputTokens` for a vendor that reports its prompt count
 * *inclusive* of the cache buckets, normalized to the exclusive form the
 * field promises.
 *
 * Floored at zero: the subtraction rests on a reading of each vendor's
 * accounting, and a negative token count would be a worse answer than a
 * slightly low one.
 */
export const uncachedInputTokens = (total: number, ...cached: Array<number | undefined>): number =>
  Math.max(0, total - cached.reduce<number>((sum, value) => sum + (value ?? 0), 0));

const TOKEN_USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/**
 * The counts a provider actually reported, with nothing else carried over.
 *
 * A key present but `undefined` says exactly what an absent key says, and
 * only one of the two survives a round trip through JSON — so the written
 * record keeps the absent form. Absence is load-bearing here.
 */
const definedTokenCounts = (usage: TokenUsage): TokenUsage => {
  const counts: TokenUsage = {};
  for (const key of TOKEN_USAGE_KEYS) {
    const value = usage[key];
    if (value !== undefined) {
      counts[key] = value;
    }
  }
  return counts;
};

/**
 * The sum of a record set, as the convenience view a session may expose.
 *
 * Absence propagates: a bucket no record reported stays absent, so a total
 * never claims a zero nobody measured. Undefined when the records report
 * nothing at all.
 */
export const totalTokenUsage = (records: readonly TokenUsage[]): TokenUsage | undefined => {
  const total: TokenUsage = {};
  let reported = false;
  for (const key of TOKEN_USAGE_KEYS) {
    let sum: number | undefined;
    for (const record of records) {
      const value = record[key];
      if (value !== undefined) {
        sum = (sum ?? 0) + value;
      }
    }
    if (sum !== undefined) {
      total[key] = sum;
      reported = true;
    }
  }
  return reported ? total : undefined;
};

export interface ProviderRequest {
  session: Session;
  tools?: ToolDescriptor[];
  /** Agent-scoped long-term memory, newest last. */
  memory?: MemoryEntry[];
  /**
   * The skills enabled for this agent — descriptors only, one prompt line
   * each. Bodies never travel here; they arrive through `skill.read` when
   * the model decides a description is relevant.
   */
  skills?: SkillDescriptor[];
  /**
   * Streaming sink. Adapters that stream call this per fragment and MUST
   * await the returned promise before the next call (backpressure); the
   * runner drains every pending delta before emitting the final
   * provider.response, so a delta can never arrive after the response.
   * A single-promise generate() cannot stream on its own — this is the
   * provider-to-runner streaming contract. Optional on both sides:
   * non-streaming adapters ignore it.
   */
  onDelta?: (delta: ProviderDelta) => void | Promise<void>;
  /**
   * Usage sink. An adapter calls this once per *provider call* — one request
   * to one model — as each completes, including calls made inside a harness
   * provider's own loop and calls that went on to fail.
   *
   * `ProviderResponse.usage` cannot carry those two cases, which is why this
   * exists: a harness makes several model calls that never cross this
   * interface, so only the last could be reported on the response; and a call
   * that throws returns no response at all, while its tokens were still
   * spent.
   *
   * **Synchronous and non-blocking**, unlike `onDelta`: there is no
   * backpressure to apply to a token count, and an adapter reporting one from
   * a `finally` on its way out with an error must not be made to await. A host
   * that wants to do real work with a count queues it.
   *
   * Reporting through this sink is exclusive **for the whole `generate`**,
   * not per inner call: once anything has reported through it, the
   * response's `usage` is ignored, so an adapter that uses both does not
   * have its final call counted twice. The runner cannot scope that more
   * finely, because it cannot see where one provider call ends and the next
   * begins.
   *
   * The consequence binds anything that composes providers behind one
   * `generate` — the fallback wrapper is the live example. If its primary
   * reported a failed attempt through the sink and its fallback then answers
   * with `usage` on the response, that response field is already excluded:
   * the composing wrapper MUST forward it through the sink itself, or the
   * turn that actually succeeded goes uncounted.
   */
  onUsage?: (usage: ProviderCallUsage) => void;
  /**
   * Abort signal for the turn. Adapters MUST cancel their underlying
   * operation (HTTP request, SDK query) when it fires — racing the promise
   * is not cancellation; the underlying work has to stop.
   */
  signal?: AbortSignal;
}

export interface ProviderResponse {
  parts: ProviderPart[];
  /**
   * What this call consumed, for an adapter where one request is one model
   * call. Absent when the provider reports nothing — never a zero.
   *
   * The simple half of the usage contract; `ProviderRequest.onUsage` is the
   * other, and an adapter that reported through the sink leaves this alone.
   */
  usage?: ProviderCallUsage;
}

export interface ModelProvider {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * What a scrubbed subprocess inherits by name when its operator granted
 * nothing else — the replacement-environment treatment `tool-shell`
 * introduced, shared here because a second copy of the list is a second
 * answer to "what does a child see by default". Two spawners use it: the
 * shell tool's commands and the MCP bridge's stdio servers.
 *
 * Short, and every entry is here because subprocesses break without it
 * rather than because it seemed harmless. Nothing on this list is a
 * secret, and that is the test for adding one: an operator who needs
 * `GITHUB_TOKEN` in a child's environment is making a deliberate decision,
 * in config, that an auditor can see.
 */
export const DEFAULT_SUBPROCESS_PASS_ENV: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'];

/**
 * Ambient context for one tool execution. The abort signal is the turn's:
 * executors kill in-flight subprocesses on abort, and long-running tools
 * should observe it too.
 */
export interface ExecutionContext {
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema describing the tool's input, advertised to model providers. */
  parameters?: JsonObject;
  /** See ToolRisk. Omitted means `gated`, never `safe`. */
  risk?: ToolRisk;
  /**
   * The shell command this invocation would run, for a tool whose danger
   * lives in its arguments rather than in its identity.
   *
   * `risk` classifies a tool; this classifies a *call*. `shell.run` is one
   * tool whose invocations range from `git status` to `curl … | sh`, and a
   * single risk level for all of them is either too coarse to be safe or
   * too coarse to be usable. A policy that wanted to judge the difference
   * would have to know which input field a particular shell tool keeps its
   * command in — so the tool says, and the policy stays free of any
   * knowledge of which pack it is talking to.
   *
   * Returning a string is a request to be judged by the command, not a
   * claim about it: the scope engine in `@stratusagent/permissions` decides
   * what the string means, and a tool that returns nothing (or is not
   * asked) is judged by `risk` alone.
   */
  commandFor?(input: JsonObject): string | undefined;
  /**
   * The outbound destination this invocation would speak to, for a tool
   * whose calls name one (`message.send`), in the channel-qualified form
   * `<channel>:<native id>` (`slack:C0123456`).
   *
   * `commandFor`'s twin, for the same reason it exists: a policy that
   * wanted to judge a send by where it goes would otherwise have to know
   * which input field a particular messaging tool keeps its destination
   * in. Returning a string is a request to be judged by the destination —
   * the scope that can pre-authorize one is the schedule's, decided in
   * `@stratusagent/permissions` — and a tool that returns nothing (or is
   * not asked) is judged by `risk` alone.
   */
  destinationFor?(input: JsonObject): string | undefined;
  /**
   * The origin this invocation would act on, for a tool whose blast radius
   * is a site rather than a command or a recipient — `browser.act`, whose
   * effect lives in the page it is pointed at. In the form `originOf`
   * returns: `https://app.example.com`, scheme and host and port only.
   *
   * **Deliberately not given the call's input**, which is the difference
   * between this and its two siblings. A CSS selector describes nothing —
   * `click("#submit")` is equally "load more results" and "confirm
   * purchase" — so the only thing about a browser action that an operator
   * can read and mean is *where* it happens, and that has to come from the
   * page the conversation is already on. An input parameter would be the
   * agent's claim about where it is, which is exactly the thing a scope
   * must not take on trust.
   *
   * Exposing this is a request to be judged by the origin, and it is also
   * a statement that the tool must never receive a tool-wide grant: the
   * permission engine refuses one for any tool that offers this hook, even
   * on a call where it answers nothing, so one yes to a page can never
   * become a standing yes to every page.
   *
   * Offer **one** scope hook or none. A tool exposing two — this and
   * `commandFor`, say — is judged by neither and asks every time: each
   * grant answers only its own question, and how two of them compose on
   * one call is a decision nobody has made.
   */
  originFor?(session: Session): string | undefined;
  execute(input: JsonObject, session: Session, context?: ExecutionContext): Promise<JsonValue>;
}

export interface Executor {
  execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult>;
}

export interface ApprovalContext {
  session: Session;
  call: ToolCall;
  /**
   * The resolved tool, and the risk the policy should judge by. A call name
   * alone cannot classify an invocation — the policy would have to guess
   * from a string — so the runner resolves the tool before asking, and a
   * call naming no registered tool never reaches a policy at all.
   */
  tool: Tool;
  risk: ToolRisk;
  /**
   * When this call first parked, if it is being re-asked after a restart.
   * A transport that imposes a deadline should measure from here, or a
   * request would win a fresh full window on every restart — and a
   * crash-looping daemon could keep one alive indefinitely.
   */
  parkedAt?: string;
  /**
   * The turn's abort signal. A policy that waits on a human MUST observe it:
   * an aborted turn rejects the in-flight wait and invalidates its pending
   * request, so a later approval can never execute a tool for a cancelled
   * turn.
   */
  signal?: AbortSignal;
}

export interface ApprovalPolicy {
  approve(context: ApprovalContext): Promise<boolean>;
}

/** Where a parked turn's checkpoint lives in `session.metadata`. */
export const PENDING_APPROVAL_METADATA_KEY = 'pendingApproval';

/**
 * The checkpoint a turn leaves behind while it waits for a human.
 *
 * Its whole job is to record something the transcript cannot: that this
 * call **has not started**. A tool result is saved only after execution, so
 * a call with no result looks identical whether the daemon died waiting for
 * an approver or died halfway through the tool's side effects — and
 * `resume()` rightly treats that ambiguity as "may not have run to
 * completion". Approval happens strictly *before* execution, so a call
 * carrying this record is unambiguous, and the only kind that can safely be
 * re-entered rather than closed as interrupted.
 *
 * Written before the policy is asked and cleared before the tool runs, so
 * the window it covers is exactly the window in which nothing has happened.
 */
export interface PendingApprovalRecord {
  /**
   * The parked call itself, not a reference to it.
   *
   * Ids are not unique across a transcript — the OpenAI-compatible adapter
   * synthesizes `tool-call-1`, `tool-call-2` per response whenever an
   * endpoint omits them, so the same id recurs every turn, and
   * `reconcileInterruptedToolCalls` already matches by occurrence for that
   * reason. Looking the call up by id would find an earlier turn's and
   * execute it with *its* input — replaying a side effect under the guise
   * of recovering a different one. Carrying the call removes the lookup,
   * and adds nothing to the store the transcript did not already hold.
   */
  call: ToolCall;
  /**
   * The calls after it in the same provider response, in order and none of
   * them started. Recovery drains these once the parked one settles, so
   * every `tool_use` in the response still gets its `tool_result`.
   */
  remaining: ToolCall[];
  /**
   * Which provider turn this call belongs to, 1-based.
   *
   * Recovery resumes the loop counter here rather than restarting it, or a
   * call parked on the last permitted turn would come back with the whole
   * budget again — and every crash-and-recover cycle would extend it
   * further. `maxTurns` is a runaway and cost guard; a turn that survives a
   * restart must not be worth more than one that did not.
   */
  turn: number;
  /**
   * When the wait began, ISO-8601.
   *
   * The deadline itself is deliberately NOT stored: it is chosen by
   * whatever transport publishes the request, strictly after this record is
   * written, so a field for it here could only ever be empty. A recovering
   * daemon has its own configured timeout and can measure the elapsed wait
   * from this — which is what honouring the original window means, rather
   * than restarting the clock because the process died.
   */
  parkedAt: string;
}

/**
 * The text a session's latest turn produced, or undefined when the turn
 * produced none.
 *
 * Walks back from the end and stops at the latest user message: an earlier
 * turn's answer must never be replayed as this turn's reply when the
 * provider returned no text (or only whitespace). Every surface that posts
 * a reply from a stored session — a channel finishing a turn it did not
 * start, a channel finalizing its own — reads it through this, so the two
 * cannot disagree on which message is "the reply".
 */
export const latestTurnReply = (session: Pick<Session, 'messages'>): string | undefined => {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!message) {
      continue;
    }
    if (message.role === 'user') {
      return undefined;
    }
    if (message.role === 'assistant' && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return undefined;
};

/** Reads the checkpoint off a session, if it is parked. */
export const readPendingApproval = (session: Session): PendingApprovalRecord | undefined => {
  const raw = session.metadata?.[PENDING_APPROVAL_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as unknown as PendingApprovalRecord;
  const isCall = (value: unknown): value is ToolCall =>
    typeof value === 'object' && value !== null
    && typeof (value as ToolCall).id === 'string'
    && typeof (value as ToolCall).toolName === 'string';

  if (!isCall(record.call)) {
    return undefined;
  }
  return {
    call: record.call,
    remaining: Array.isArray(record.remaining) ? record.remaining.filter(isCall) : [],
    // A record written before this field existed resumes at 1, which is
    // the old behaviour and never *more* permissive than a fresh turn.
    turn: typeof record.turn === 'number' && Number.isFinite(record.turn) ? record.turn : 1,
    parkedAt: typeof record.parkedAt === 'string' ? record.parkedAt : '',
  };
};

/**
 * What a human decided about one gated call.
 *
 * - `once` — run this call, ask again next time.
 * - `always` — run it and stop asking for this tool in this session.
 * - `deny` — refuse it.
 *
 * `always` is deliberately not "forever": a persistent whitelist is a
 * different, narrower promise (a normalized command scope) and belongs
 * with the shell tool that needs one.
 */
export type ApprovalAnswer = 'once' | 'always' | 'deny';

/**
 * Why an approval request stopped being pending. Only `decided` involved a
 * person; the rest are the request running out of patience, the turn it
 * belonged to disappearing, or nobody ever being asked at all.
 *
 * The distinction is not cosmetic. `decided` is what an audit record means
 * by "somebody refused this", and folding an undelivered request into it
 * would put a denial nobody made on the same footing as one somebody did.
 */
export type ApprovalResolutionReason = 'decided' | 'timeout' | 'cancelled' | 'undeliverable';

export type StratusEvent =
  | { type: 'session.created'; sessionId: string; agentId: string }
  | { type: 'session.updated'; sessionId: string; status: SessionStatus }
  | { type: 'provider.delta'; sessionId: string; delta: ProviderDelta }
  | { type: 'provider.response'; sessionId: string; parts: ProviderPart[] }
  | { type: 'tool.called'; sessionId: string; call: ToolCall }
  | { type: 'tool.completed'; sessionId: string; result: ToolResult }
  | { type: 'tool.denied'; sessionId: string; call: ToolCall }
  /**
   * A gated call is parked, waiting for a human somewhere else. Channels
   * render it (Slack buttons) and resolve it through the gateway; nothing
   * about the request is channel-specific, so the dashboard consumes the
   * same event.
   *
   * `metadata` is the session's, carried because it says where the turn is
   * happening — a channel that renders the request into the conversation it
   * came from needs that without reaching into the store.
   */
  | {
      type: 'tool.approval-requested';
      sessionId: string;
      agentId: string;
      /** Opaque id the decision is quoted back with. */
      requestId: string;
      call: ToolCall;
      risk: ToolRisk;
      /**
       * The origin this call would act on, for a tool judged by one
       * (`Tool.originFor`). Carried because the call's own arguments do not
       * say: a renderer showing `browser.act` with `{"selector":"#submit"}`
       * and an **Always allow** button would be asking somebody to widen a
       * site they were never shown.
       */
      origin?: string;
      /**
       * True when answering `always` runs this call once and remembers
       * nothing. A renderer must not offer an unconditional "always" for
       * one of these — the button would promise a standing grant the engine
       * will not create. See `Tool.originFor` and `ToolRisk`.
       */
      oneShot?: boolean;
      metadata?: JsonObject;
      /**
       * When the request gives up and denies itself, ISO-8601. Absent when
       * it never will — a deadline of "now" would be a worse lie than
       * saying nothing.
       */
      expiresAt?: string;
    }
  | {
      type: 'tool.approval-resolved';
      sessionId: string;
      requestId: string;
      answer: ApprovalAnswer;
      reason: ApprovalResolutionReason;
      /** Who decided, when a person did. Channel-native id (a Slack user). */
      actor?: string;
    }
  | {
      type: 'session.completed';
      sessionId: string;
      /**
       * The session's usage records — every provider call it has ever made,
       * not only this run's, because that is the stored form and a resumed
       * session's earlier turns are just as real. Absent when nothing
       * reported; a consumer must not read that as zero.
       *
       * A failed run's records are not lost by being missing here: they are
       * saved onto the session before `session.failed` goes out, and
       * `GET /sessions/:id` carries them.
       */
      usage?: UsageRecord[];
    }
  | { type: 'session.failed'; sessionId: string; error: string };

export type EventHandler = (event: StratusEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Called when a subscriber throws. Handler errors never interrupt the run. */
  onError?: (error: unknown, event: StratusEvent) => void;
}

export interface SubscribeOptions {
  /**
   * Run this handler before previously registered ones. Emission awaits
   * handlers in order, so a slow consumer delays everyone after it — a
   * liveness observer (an activity watchdog) must sit in front, or the
   * activity it exists to notice reaches it only after the delay it is
   * timing against.
   */
  prepend?: boolean;
}

export class EventBus {
  private handlers: EventHandler[] = [];
  private readonly onError: EventBusOptions['onError'];

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError;
  }

  subscribe(handler: EventHandler, options: SubscribeOptions = {}): () => void {
    if (options.prepend) {
      this.handlers.unshift(handler);
    } else {
      this.handlers.push(handler);
    }
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  async emit(event: StratusEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      try {
        await handler(event);
      } catch (error) {
        this.onError?.(error, event);
      }
    }
  }
}

export interface SessionStore {
  create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  /**
   * Session ids in a given state, oldest first. Optional: a store that
   * cannot enumerate simply cannot recover parked turns, and a caller that
   * needs to sweep says so by checking for the method.
   *
   * Ids rather than sessions, deliberately — a sweep over a large store
   * should not deserialize every conversation body to find the few it wants.
   */
  listIdsByStatus?(status: SessionStatus): Promise<string[]>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session> {
    const now = new Date().toISOString();
    const session = { ...input, createdAt: now, updatedAt: now };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session, updatedAt: new Date().toISOString() });
  }

  async listIdsByStatus(status: SessionStatus): Promise<string[]> {
    return [...this.sessions.values()]
      .filter((session) => session.status === status)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((session) => session.id);
  }
}

export interface PluginContext {
  bus: EventBus;
  tools: ToolRegistry;
  /**
   * How a plugin resolves a credential for the agent whose call it is
   * serving, so it never needs `process.env`. It declares what it needs by
   * name in its manifest and receives exactly that, per call — which is
   * what a search backend needs to reach the *calling* agent's key rather
   * than one captured at setup.
   *
   * A host that omits it leaves every plugin that wants a credential with
   * no way to get one: such a plugin must fail the call naming what is
   * missing, never fall back to ambient environment. Read
   * `docs/architecture/plugins.md` on what this does and does not buy — a
   * plugin is code, so scoping it is an interface rather than a boundary.
   */
  credentials?: CredentialResolver;
  /**
   * The host's log, for what a plugin has to say after `setup` returns —
   * a server that dropped, a reconnect that failed. The daemon's is the
   * structured log `stratus logs` reads. A host that omits these leaves
   * the plugin to its own stderr, which under a service manager is a line
   * nobody sees: plugin-mcp's disconnect warnings went there for as long
   * as this seam did not exist.
   */
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface Plugin {
  name: string;
  setup(context: PluginContext): Promise<void> | void;
  /**
   * Release whatever `setup` acquired. Optional, and most plugins have
   * nothing to release — a plugin that registers pure functions is done
   * when the process is.
   *
   * It exists because some do: a browser plugin holds a Chromium and a
   * listening socket, and a daemon that stopped without telling it would
   * leak both. The host calls this on shutdown, after channels have
   * stopped, and a plugin that throws here is logged rather than allowed to
   * hold up the drain.
   */
  dispose?(): Promise<void> | void;
}

export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async loadAll(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup(context);
    }
  }

  /**
   * Dispose every plugin that has something to dispose, in reverse load
   * order. Settled rather than awaited in sequence-with-throw: one
   * plugin's failed cleanup must not strand the next plugin's.
   */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.plugins].reverse().map(async (plugin) => plugin.dispose?.()),
    );
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Forget a tool, reporting whether one was registered under that name.
   *
   * Exists for the one registrar whose contribution can shrink while the
   * daemon runs: a bridge whose tools are discovered from somebody else's
   * server picks up a removal on reconnect, and a registry nothing ever
   * deletes from would keep advertising a tool every call to which must
   * fail. Hosts do not reach for this directly — a plugin's removals go
   * through its manifest-bound view, which refuses names it does not own.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  describe(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
      risk: resolveToolRisk(tool),
    }));
  }
}

/**
 * What a skill costs every turn: one line. `name` and `description` are the
 * whole system-prompt footprint of an enabled skill — the body arrives only
 * through `skill.read`, when the model decides the description is relevant.
 */
export interface SkillDescriptor {
  id: string;
  name: string;
  /**
   * What routing runs on, so it says *when to reach for this*, not what
   * the body contains. "Use when reviewing a diff or a pull request", not
   * "A rubric with twelve sections".
   */
  description: string;
}

/**
 * A procedure an agent loads when it needs it. The body is behind `load()`
 * rather than on the object because progressive disclosure is the whole
 * point: an enabled-but-unused skill costs its description line and nothing
 * else, per turn and in memory.
 */
export interface Skill extends SkillDescriptor {
  /**
   * Toolset globs this skill expects (`browser.*`, `fs.read`). Advisory: a
   * skill is prose and degrades, so an agent enabling one without the tools
   * gets a load-time warning, never a hard failure.
   */
  requires?: string[];
  /** Load the full body. Callers go through `SkillRegistry.read`, which caches. */
  load(): Promise<string>;
}

/**
 * Two skills claiming one id, refused rather than resolved to whichever
 * loaded last — the same reason a duplicate agent id or tool name is a
 * load-time error: an allowlist naming the id would silently select the
 * wrong procedure.
 */
export class DuplicateSkillIdError extends Error {
  constructor(id: string) {
    super(`Duplicate skill id: ${id}. Skill ids are unique per install; rename one, or address a plugin's skill by its qualified <package>:<skill> form.`);
    this.name = 'DuplicateSkillIdError';
  }
}

/**
 * The kernel's skill catalog, alongside `ToolRegistry` and shaped like it.
 *
 * Ids come in two forms and the registry knows both: the canonical id a
 * skill was registered under (`code-review`, or a plugin's qualified
 * `stratus-plugin-github:pr-review`), and optional aliases — the bare id a
 * plugin's skill also answers to while no other package claims it. Reads
 * are cached per skill, not per read: a body read three times in one turn
 * hits the disk once, whichever of its ids it was asked for by.
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private aliases = new Map<string, string>();
  /**
   * Bare ids two plugins both wanted. Once contested, the bare form stays
   * dead for everyone — re-granting it to whichever package loads first
   * next time would flip which procedure `skills: [pr-review]` selects
   * between restarts.
   */
  private contestedAliases = new Set<string>();
  private bodies = new Map<string, Promise<string>>();

  register(skill: Skill): void {
    if (this.skills.has(skill.id) || this.aliases.has(skill.id)) {
      throw new DuplicateSkillIdError(skill.id);
    }
    this.skills.set(skill.id, skill);
  }

  /**
   * Give a registered skill a second addressable id — the bare form of a
   * plugin's qualified id. Quietly yields instead of throwing, because an
   * alias is a convenience and the skill stays reachable canonical: a bare
   * id already registered as a skill of its own belongs to that skill, and
   * one two plugins both want goes to neither (see `contestedAliases`).
   */
  registerAlias(alias: string, canonicalId: string): void {
    const skill = this.skills.get(canonicalId);
    if (!skill) {
      throw new Error(`Cannot alias ${alias}: no skill is registered as ${canonicalId}.`);
    }
    if (alias === canonicalId || this.skills.has(alias) || this.contestedAliases.has(alias)) {
      return;
    }
    const existing = this.aliases.get(alias);
    if (existing !== undefined) {
      if (existing !== canonicalId) {
        this.aliases.delete(alias);
        this.contestedAliases.add(alias);
      }
      return;
    }
    this.aliases.set(alias, canonicalId);
  }

  /** The skill behind an id, canonical or alias. */
  resolve(id: string): Skill | undefined {
    return this.skills.get(id) ?? this.skills.get(this.aliases.get(id) ?? '');
  }

  /**
   * Whether `register(skill)` with this id would be refused — the check a
   * loader runs *before* committing anything else a package contributes,
   * so a duplicate skill refuses the plugin whole instead of leaving its
   * tools registered and its skills not.
   */
  has(id: string): boolean {
    return this.skills.has(id) || this.aliases.has(id);
  }

  /**
   * Every id that reaches a skill, canonical first. This is what an
   * allowlist is checked against: `skills: [pr-review]` and
   * `skills: [stratus-plugin-github:*]` both select the same skill, and
   * permission is about the skill, not about which of its names was used.
   */
  idsFor(canonicalId: string): string[] {
    const ids = [canonicalId];
    for (const [alias, target] of this.aliases) {
      if (target === canonicalId) {
        ids.push(alias);
      }
    }
    return ids;
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Become `next`, in one synchronous step — the swap behind a live reload.
   *
   * A reload cannot re-register into a serving registry: `register` throws
   * on every id already loaded, and unregistering one at a time would have
   * to re-derive which aliases a departed skill was blocking. So the loader
   * builds the whole next set into a fresh registry, and this adopts it —
   * skills, aliases, and the contested set together, so the alias rules
   * the build applied are exactly the ones that serve. Synchronous, so a
   * `read` in flight sees either the old set or the new one, never a
   * half-swapped map. A cached body survives only for a `Skill` object the
   * next set registers unchanged — a plugin's, re-registered by a host that
   * did not reload the plugin — and is dropped for one built afresh, since
   * that is a file that may have been replaced. Dropping a plugin's too
   * would serve a package's edited prose under a name and description
   * staged before the edit, without the restart a plugin change requires.
   * A read already underway keeps the promise it holds either way. `next`
   * is consumed — emptied, not shared — so nothing can go on mutating this
   * registry through it.
   */
  replaceWith(next: SkillRegistry): void {
    const kept = new Map<string, Promise<string>>();
    for (const [id, body] of this.bodies) {
      if (next.skills.get(id) === this.skills.get(id)) {
        kept.set(id, body);
      }
    }
    this.skills = next.skills;
    this.aliases = next.aliases;
    this.contestedAliases = next.contestedAliases;
    this.bodies = kept;
    next.skills = new Map();
    next.aliases = new Map();
    next.contestedAliases = new Set();
    next.bodies = new Map();
  }

  describe(): SkillDescriptor[] {
    return this.list().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }));
  }

  /**
   * The body behind an id, loaded lazily and cached per skill — keyed by
   * the canonical id, so an alias read and a qualified read share one
   * cache entry.
   */
  async read(id: string): Promise<string> {
    const skill = this.resolve(id);
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }
    const cached = this.bodies.get(skill.id);
    if (cached) {
      return cached;
    }
    const loading = Promise.resolve(skill.load());
    this.bodies.set(skill.id, loading);
    try {
      return await loading;
    } catch (error) {
      // A failed read must not poison the cache: the file may exist on the
      // next attempt, and a cached rejection would refuse it forever.
      this.bodies.delete(skill.id);
      throw error;
    }
  }
}

export const SKILL_READ_TOOL_NAME = 'skill.read';

export interface SkillReadToolOptions {
  /**
   * Which `skills:` entries the session's agent is held to. Defaults to the
   * definition travelling with the session; a host whose roster can hold
   * skills the session copy predates (the gateway) passes its own resolver
   * so both gates and this tool answer from the same list.
   */
  allowlistFor?: (session: Session) => readonly string[] | undefined;
}

/**
 * The reader behind progressive disclosure: descriptions reach the system
 * prompt, and this is how a body follows when one turns out to be relevant.
 *
 * `risk: 'safe'` is deliberate — reading a file the operator installed and
 * the soul opted into is not an act on the world. Which skill may be read
 * is the soul's `skills:` allowlist, enforced here with the same matcher
 * the runner's gates use, so there is one gate, not a second
 * implementation of one.
 *
 * The tool itself is part of the skills mechanism, not a capability a soul
 * lists under `tools:` — see the runner, which advertises and permits it
 * exactly when the agent has any skill enabled.
 */
export const createSkillReadTool = (
  skills: SkillRegistry,
  options: SkillReadToolOptions = {},
): Tool => ({
  name: SKILL_READ_TOOL_NAME,
  description:
    'Load the full instructions of one of your skills by id. Call this before relying on a skill — the one-line list in your instructions is only a pointer, not the procedure.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The skill id, exactly as it appears in your skills list.' },
    },
    required: ['id'],
  },
  async execute(input: JsonObject, session: Session) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      throw new Error('skill.read requires a non-empty "id" string.');
    }
    const allowlist = options.allowlistFor ? options.allowlistFor(session) : session.agent.skills;
    const skill = skills.resolve(id);
    // Permission is about the skill, so every id that reaches it counts —
    // a soul granting `stratus-plugin-github:*` covers a read by the bare
    // alias. An id reaching no skill is judged as written, and permission
    // is settled before existence so an agent with no grant learns
    // nothing about what is installed.
    const addressable = skill ? skills.idsFor(skill.id) : [id];
    const permitted = allowlist !== undefined
      && addressable.some((candidate) => matchesSkillAllowlist(candidate, allowlist));
    if (!permitted) {
      throw new Error(`Skill not permitted for agent ${session.agent.id}: ${id}`);
    }
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }
    return { id: skill.id, name: skill.name, body: await skills.read(id) };
  },
});

// ---- system prompt rendering ----------------------------------------------
//
// How an agent's identity reaches a model is a kernel contract, rendered
// once here rather than per provider package — three packages carrying
// their own copy of "You are ${name}" is three answers to what an agent is
// told about itself, and the skills block would have made it a fourth copy
// of a rule that matters (descriptions only, never bodies).

/**
 * The persona line. `fallback` supplies one for an agent with no
 * instructions — runtimes that always need a system prompt (Claude Code)
 * ask for it; API adapters that can omit the section do not.
 */
export const renderPersonaSection = (
  agent: Pick<AgentDefinition, 'name' | 'instructions'>,
  options: { fallback?: boolean } = {},
): string | undefined => {
  if (agent.instructions && agent.instructions.length > 0) {
    return `You are ${agent.name}. ${agent.instructions}`;
  }
  return options.fallback ? `You are ${agent.name}, a helpful assistant.` : undefined;
};

export const renderMemorySection = (memory: readonly MemoryEntry[] | undefined): string | undefined => {
  if (!memory || memory.length === 0) {
    return undefined;
  }
  const facts = memory.map((entry) => `- ${entry.content}`).join('\n');
  return `Things you remember from previous conversations (your own long-term memory):\n${facts}`;
};

/**
 * The skills block: one line per enabled skill — id, name, and the
 * description routing runs on. This is the whole point of the step: the
 * marginal cost of an enabled-but-unused skill is this line, so nothing
 * here may ever include a body.
 */
export const renderSkillsSection = (skills: readonly SkillDescriptor[] | undefined): string | undefined => {
  if (!skills || skills.length === 0) {
    return undefined;
  }
  const lines = skills.map((skill) => {
    const label = skill.name && skill.name !== skill.id ? `${skill.id} (${skill.name})` : skill.id;
    return `- ${label}: ${skill.description}`;
  });
  return `You have skills — procedures for doing particular tasks well. When one is relevant to the task at hand, load its full instructions with the ${SKILL_READ_TOOL_NAME} tool (pass the id) and follow them; the one-line descriptions here are pointers, not the procedures themselves:\n${lines.join('\n')}`;
};

export interface SystemPromptOptions {
  /** Host-level preamble, rendered before the agent's own persona. */
  preamble?: string;
  /** Render a default persona line for an agent with no instructions. */
  fallbackPersona?: boolean;
}

/**
 * Which part of what an agent is told a section is.
 *
 * The distinction a caller actually needs is stable versus volatile:
 * `preamble`, `persona`, and `skills` are byte-identical across every turn of
 * an agent's life, while `memory` is rewritten whenever the agent remembers
 * anything. A provider that caches its request prefix has to place those two
 * groups differently, and it cannot tell them apart from rendered strings.
 */
export type SystemPromptSectionKind = 'preamble' | 'persona' | 'memory' | 'skills';

export interface SystemPromptSection {
  kind: SystemPromptSectionKind;
  text: string;
}

/**
 * Every section that belongs in an agent's system prompt, in order, empty
 * ones omitted, each labelled with what it is.
 *
 * Sections rather than one string because wire formats differ — Anthropic
 * takes one system string, the OpenAI dialect a message per section — and the
 * contract is the content, not the joining. Labelled because *placement*
 * differs too: an adapter that caches its prefix sends the volatile section
 * somewhere else entirely, and reordering here to suit it would change the
 * prompt for every other provider to no purpose.
 *
 * The order is the order. This is the one rule about what an agent is told;
 * `renderSystemPromptSections` is the same rule with the labels dropped.
 */
export const renderSystemPromptParts = (
  request: Pick<ProviderRequest, 'session' | 'memory' | 'skills'>,
  options: SystemPromptOptions = {},
): SystemPromptSection[] => {
  const sections: Array<{ kind: SystemPromptSectionKind; text: string | undefined }> = [
    { kind: 'preamble', text: options.preamble },
    { kind: 'persona', text: renderPersonaSection(request.session.agent, { fallback: options.fallbackPersona ?? false }) },
    { kind: 'memory', text: renderMemorySection(request.memory) },
    { kind: 'skills', text: renderSkillsSection(request.skills) },
  ];
  return sections.filter(
    (section): section is SystemPromptSection => section.text !== undefined && section.text.length > 0,
  );
};

/** The sections as plain strings, in the same order. */
export const renderSystemPromptSections = (
  request: Pick<ProviderRequest, 'session' | 'memory' | 'skills'>,
  options: SystemPromptOptions = {},
): string[] => renderSystemPromptParts(request, options).map((section) => section.text);

/** The sections joined the way single-string providers send them. */
export const renderSystemPrompt = (
  request: Pick<ProviderRequest, 'session' | 'memory' | 'skills'>,
  options: SystemPromptOptions = {},
): string | undefined => {
  const sections = renderSystemPromptSections(request, options);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
};

export class DefaultExecutor implements Executor {
  async execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult> {
    try {
      const output = await tool.execute(call.input, session, context);
      return { callId: call.id, toolName: call.toolName, ok: true, output };
    } catch (error) {
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class AllowAllApprovalPolicy implements ApprovalPolicy {
  async approve(): Promise<boolean> {
    return true;
  }
}

export interface RunInput {
  sessionId: string;
  /** See Session.agent: the allowlist travels with the run. */
  agent: AgentDefinition;
  userMessage: string;
  metadata?: JsonObject;
  /** Aborting fails the turn cleanly; see RunAbortedError. */
  signal?: AbortSignal;
}

export interface ResumeInput {
  sessionId: string;
  userMessage: string;
  /** Aborting fails the turn cleanly; see RunAbortedError. */
  signal?: AbortSignal;
}

/**
 * Thrown when a run is stopped by its abort signal. The session ends up
 * `failed` with this error's message as `lastError`, so an aborted turn is
 * distinguishable from a genuine failure.
 */
export class RunAbortedError extends Error {
  constructor(message = 'Run aborted') {
    super(message);
    this.name = 'RunAbortedError';
  }
}

/**
 * The abort that stopped a run, as the runner records it.
 *
 * A signal carries whatever its controller aborted with. When that reason
 * is a `RunAbortedError`, the aborter said why — the gateway's watchdog
 * names the silence it timed out on — and that is the error the turn fails
 * with, so `lastError` and `session.failed` read "no activity for 120000ms"
 * rather than the bare "Run aborted" that a person cancelling also
 * produces. The distinction used to exist only on the dispatch's rejection,
 * which is the one place nothing durable or observable reads it from.
 * Anything else on the signal — undefined, a DOMException, a string — is a
 * caller that did not say, and the default stands.
 *
 * Exported for hosts that check a signal before the runner ever sees it —
 * the gateway refuses a dispatch whose signal fired while it was queued —
 * so those refusals carry the same reason the runner would have recorded.
 */
export const abortErrorFor = (signal: AbortSignal | undefined): RunAbortedError =>
  signal?.reason instanceof RunAbortedError ? signal.reason : new RunAbortedError();

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw abortErrorFor(signal);
  }
};

export interface AgentRunnerOptions {
  provider: ModelProvider;
  tools?: ToolRegistry;
  executor?: Executor;
  approvals?: ApprovalPolicy;
  store?: SessionStore;
  bus?: EventBus;
  plugins?: PluginRegistry;
  /** Known agent definitions; enables per-agent tool allowlists. */
  agents?: AgentRegistry;
  /**
   * The skill catalog. Passing one makes `skill.read` available — the
   * runner registers it if the host has not — to exactly the agents whose
   * soul enables any skill; see the two gates in `executeTurns` and
   * `executeToolCall`.
   */
  skills?: SkillRegistry;
  /** Agent-scoped long-term memory, injected into every provider request. */
  memory?: AgentMemoryStore;
  /** Maximum provider turns per run before the session fails. */
  maxTurns?: number;
  /**
   * When true, the runner hands providers a delta sink and re-emits their
   * fragments as provider.delta events. Off by default: streaming is
   * additive, and consumers that render only final responses (one-shot CLI
   * runs, tests) keep the simpler non-streaming provider path.
   */
  streaming?: boolean;
}

const DEFAULT_MAX_TURNS = 8;

export class AgentRunner {
  readonly bus: EventBus;
  readonly store: SessionStore;
  readonly tools: ToolRegistry;
  readonly executor: Executor;
  readonly approvals: ApprovalPolicy;
  readonly plugins: PluginRegistry;
  readonly agents: AgentRegistry;
  readonly skills: SkillRegistry | undefined;
  readonly memory: AgentMemoryStore | undefined;
  readonly maxTurns: number;
  readonly streaming: boolean;
  private readonly options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new InMemorySessionStore();
    this.tools = options.tools ?? new ToolRegistry();
    this.executor = options.executor ?? new DefaultExecutor();
    this.approvals = options.approvals ?? new AllowAllApprovalPolicy();
    this.plugins = options.plugins ?? new PluginRegistry();
    this.agents = options.agents ?? new AgentRegistry();
    this.skills = options.skills;
    this.memory = options.memory;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.streaming = options.streaming ?? false;
    // The reader is part of the skills mechanism, so a runner given a
    // catalog makes sure it exists — with this runner's own allowlist
    // resolution, so the tool refuses exactly what the gates refuse. A host
    // that registered its own (the gateway, so its tool listing is complete
    // before the first dispatch) is left alone.
    if (this.skills && !this.tools.get(SKILL_READ_TOOL_NAME)) {
      this.tools.register(
        createSkillReadTool(this.skills, { allowlistFor: (session) => this.skillAllowlistFor(session) }),
      );
    }
  }

  async initialize(): Promise<void> {
    await this.plugins.loadAll({ bus: this.bus, tools: this.tools });
  }

  async run(input: RunInput): Promise<Session> {
    const sessionInput: Omit<Session, 'createdAt' | 'updatedAt'> = {
      id: input.sessionId,
      agent: input.agent,
      status: 'running',
      messages: [
        {
          id: `${input.sessionId}:user:1`,
          role: 'user',
          content: input.userMessage,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    if (input.metadata) {
      sessionInput.metadata = input.metadata;
    }

    const session = await this.store.create(sessionInput);

    await this.bus.emit({ type: 'session.created', sessionId: session.id, agentId: session.agent.id });
    await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });

    return this.executeTurns(session, input.signal);
  }

  async resume(input: ResumeInput): Promise<Session> {
    const session = await this.store.get(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    // Mid-turn saves make tool calls durable before their results; a
    // daemon killed in between leaves a call with no result, and provider
    // wire formats reject a tool call that is never answered. Close each
    // dangling call with an explicit interrupted result so the durable
    // conversation stays resumable.
    this.reconcileInterruptedToolCalls(session);

    // Every dangling call is now closed, the parked one included, so a
    // checkpoint here describes a call the transcript has just answered.
    // It has to go: `recoverPendingApproval` trusts the record over the
    // transcript, and a daemon's parked sweep starts after its channels
    // come up — so a message that resumes the session first would leave a
    // record for the restart to re-enter, executing the call on a session
    // that has since completed.
    if (session.metadata?.[PENDING_APPROVAL_METADATA_KEY] !== undefined) {
      const metadata = { ...session.metadata };
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
      session.metadata = metadata;
    }

    session.status = 'running';
    delete session.lastError;
    session.messages.push({
      id: `${session.id}:user:${session.messages.length + 1}`,
      role: 'user',
      content: input.userMessage,
      createdAt: new Date().toISOString(),
    });

    // The accepted input is durable BEFORE any provider work: a crash
    // mid-turn must not silently lose a message the caller believes was
    // received — restarting with the same session id recovers it.
    await this.store.save(session);
    const stored = await this.store.get(session.id);
    const working = stored ?? session;

    await this.bus.emit({ type: 'session.updated', sessionId: working.id, status: working.status });

    return this.executeTurns(working, input.signal);
  }

  /**
   * Appends a synthetic failed result directly after every tool call that
   * has none — the durable trace of a turn interrupted between the call's
   * save and its result's. The model sees an honest record ("interrupted,
   * never ran to completion") instead of a wire-format violation, and a
   * resume can decide to retry rather than assume the side effect landed.
   */
  private reconcileInterruptedToolCalls(session: Session): void {
    // Matched by OCCURRENCE, not by id alone: providers can reuse ids
    // (the OpenAI-compatible adapter synthesizes tool-call-1 whenever an
    // endpoint omits them), and an earlier answered occurrence must not
    // make a later dangling one look answered. The nth call with an id
    // needs the nth result with that id, in transcript order.
    const resultsAvailable = new Map<string, number>();
    for (const message of session.messages) {
      if (message.role === 'tool' && message.toolResult) {
        const id = message.toolResult.callId;
        resultsAvailable.set(id, (resultsAvailable.get(id) ?? 0) + 1);
      }
    }

    const callsSeen = new Map<string, number>();
    for (let index = 0; index < session.messages.length; index += 1) {
      const message = session.messages[index];
      if (message?.role !== 'assistant' || !message.toolCalls) {
        continue;
      }
      for (const call of message.toolCalls) {
        const occurrence = (callsSeen.get(call.id) ?? 0) + 1;
        callsSeen.set(call.id, occurrence);
        if (occurrence <= (resultsAvailable.get(call.id) ?? 0)) {
          continue;
        }
        resultsAvailable.set(call.id, occurrence);
        const result: ToolResult = {
          callId: call.id,
          toolName: call.toolName,
          ok: false,
          output: null,
          error: 'Tool execution was interrupted before a result was recorded; it may not have run to completion.',
        };
        index += 1;
        session.messages.splice(index, 0, {
          id: `${session.id}:tool:${call.id}`,
          role: 'tool',
          name: call.toolName,
          content: JSON.stringify(result),
          createdAt: new Date().toISOString(),
          toolResult: result,
        });
      }
    }
  }

  /**
   * The id for the next Stratus turn that spends tokens.
   *
   * Ordinals count the turns that *recorded* usage rather than loop
   * iterations, which is what makes deriving them safe: a turn that reported
   * nothing leaves no record behind, so its ordinal was never taken and the
   * next turn cannot collide with it. Derived from the stored records rather
   * than held in a counter so a session resumed in another process continues
   * the numbering instead of restarting it and merging two turns under one
   * id.
   */
  private nextTurnId(session: Session): string {
    const turns = new Set((session.usage ?? []).map((record) => record.turnId));
    return `${session.id}:turn:${turns.size + 1}`;
  }

  /**
   * Record one provider call against the session, attributed.
   *
   * Accumulation lives here rather than in each adapter for the usual
   * reason: four copies of a summing rule is four places for a fallback or a
   * retried call to be counted once, twice, or not at all.
   */
  private recordUsage(session: Session, turnId: string, usage: ProviderCallUsage): void {
    const record: UsageRecord = {
      turnId,
      // The adapter's own name wins. `provider.name` is the fallback
      // wrapper's under a configured fallback, and that name is the
      // primary's for the life of the session — so trusting it would file
      // the fallback model's tokens under the provider that failed.
      provider: usage.provider ?? this.options.provider.name,
      ...(usage.model !== undefined ? { model: usage.model } : {}),
      ...definedTokenCounts(usage),
    };
    (session.usage ??= []).push(record);
  }

  /**
   * The allowlist entries this session's agent is held to, or undefined for
   * no limit. Entries, not a name set: `fs.*` is an entry, and matching is
   * `matchesToolAllowlist`'s job rather than each caller's.
   */
  private allowedToolsFor(session: Session): readonly string[] | undefined {
    // The definition handed to run()/resume() travels with the session, so an
    // agent's own allowlist applies even when it was never registered.
    return session.agent.tools ?? this.agents.get(session.agent.id)?.tools;
  }

  /** The `skills:` entries this session's agent is held to — same sourcing as `allowedToolsFor`. */
  private skillAllowlistFor(session: Session): readonly string[] | undefined {
    return session.agent.skills ?? this.agents.get(session.agent.id)?.skills;
  }

  /**
   * The skills this session's agent has enabled, as the one-line
   * descriptors the prompt carries. Each skill appears once, under the id
   * the allowlist actually granted (canonical before alias) — the id the
   * model is told is the id `skill.read` will accept.
   *
   * Empty for an agent whose soul has no `skills:` key, which is what keys
   * both `skill.read` gates: no skills, no reader.
   */
  private enabledSkillsFor(session: Session): SkillDescriptor[] {
    if (!this.skills) {
      return [];
    }
    const allowlist = this.skillAllowlistFor(session);
    if (!allowlist || allowlist.length === 0) {
      return [];
    }
    const enabled: SkillDescriptor[] = [];
    for (const skill of this.skills.list()) {
      const grantedId = this.skills
        .idsFor(skill.id)
        .find((candidate) => matchesSkillAllowlist(candidate, allowlist));
      if (grantedId !== undefined) {
        enabled.push({ id: grantedId, name: skill.name, description: skill.description });
      }
    }
    return enabled;
  }

  private async executeTurns(
    initialSession: Session,
    signal?: AbortSignal,
    /**
     * Re-enter an interrupted turn at its parked call instead of starting
     * with the provider. The response these calls came from is already in
     * the session — replaying it would duplicate the assistant messages and
     * re-ask the model — so recovery picks up exactly where the wait was.
     */
    resumeFrom?: { pending: ToolCall | undefined; remaining: ToolCall[]; parkedAt?: string; turn?: number },
  ): Promise<Session> {
    let session = initialSession;
    let pendingEntry = resumeFrom;

    try {
      const allowedTools = this.allowedToolsFor(session);
      // Gate 1 of two for skill.read (gate 2 is executeToolCall): the
      // reader rides on the agent having any skill enabled, not on the
      // `tools:` allowlist — it is an implementation detail of the
      // `skills:` key, and souls are not asked to list it. The exemption
      // cuts both ways: an agent with no skills never sees the reader,
      // however permissive its tools list.
      const enabledSkills = this.enabledSkillsFor(session);
      const tools = this.tools
        .describe()
        .filter((tool) => (tool.name === SKILL_READ_TOOL_NAME
          ? enabledSkills.length > 0
          : allowedTools === undefined || matchesToolAllowlist(tool.name, allowedTools)));

      // Resumed, not restarted: a recovered turn spends the budget it was
      // already on. Starting at 1 would let a call parked on the last
      // permitted turn buy the whole allowance again.
      for (let turn = resumeFrom?.turn ?? 1; ; turn += 1) {
        throwIfAborted(signal);
        if (turn > this.maxTurns) {
          throw new Error(`Session exceeded the maximum of ${this.maxTurns} provider turns.`);
        }

        if (pendingEntry) {
          // The whole recovered queue — the parked call first, then the
          // ones behind it — so the response's every `tool_use` ends up
          // with a `tool_result` before the loop goes back to the provider.
          const recovered = [
            ...(pendingEntry.pending ? [pendingEntry.pending] : []),
            ...pendingEntry.remaining,
          ];
          // The original park time rides along, so a wait is measured from
          // when it began rather than restarted by the recovery. Only
          // meaningful when the parked call itself is being re-asked;
          // a denied one is already answered.
          const carriedParkedAt = pendingEntry.pending ? pendingEntry.parkedAt : undefined;
          pendingEntry = undefined;
          await this.runToolCalls(session, recovered, signal, carriedParkedAt, turn);
          continue;
        }

        // A bounded slice — the most recent entries, chronological — not the
        // whole store. Everything older reaches the model through
        // `memory.recall`; injecting it all is what gave the store a horizon
        // measured in weeks.
        const memory = this.memory
          ? (await this.memory.list(session.agent.id, { limit: MEMORY_INJECTION_LIMIT })).entries
          : [];

        // Deltas re-emit on the bus through a serial chain that is drained
        // before the final provider.response goes out — a delta arriving
        // after the response would let a late edit overwrite final output.
        let deltaChain: Promise<void> = Promise.resolve();
        const onDelta = (delta: ProviderDelta): Promise<void> => {
          const emission = deltaChain.then(() =>
            this.bus.emit({ type: 'provider.delta', sessionId: session.id, delta }),
          );
          deltaChain = emission;
          return emission;
        };

        // One Stratus turn: one id, however many provider calls the adapter
        // makes underneath it. Allocated before the call because the sink
        // fires during it.
        const turnId = this.nextTurnId(session);
        // Sink-reported usage is exclusive for the call. An adapter that
        // reports its internal attempts through the sink has already counted
        // the last one, and reading the response's field as well would bill
        // that attempt twice.
        let sinkReported = false;
        const onUsage = (usage: ProviderCallUsage): void => {
          sinkReported = true;
          this.recordUsage(session, turnId, usage);
        };

        const response = await this.options.provider.generate({
          session,
          ...(tools.length > 0 ? { tools } : {}),
          ...(memory.length > 0 ? { memory } : {}),
          ...(enabledSkills.length > 0 ? { skills: enabledSkills } : {}),
          ...(this.streaming ? { onDelta } : {}),
          onUsage,
          ...(signal ? { signal } : {}),
        });
        // Recorded before the abort check, deliberately: a turn cancelled
        // between the response arriving and this loop noticing still spent
        // those tokens, and the catch below saves the session.
        if (!sinkReported && response.usage) {
          this.recordUsage(session, turnId, response.usage);
        }
        throwIfAborted(signal);
        await deltaChain;

        // Record and SAVE the entire response — text and every tool call —
        // before anything else happens with it. Two consumers depend on
        // that order: provider replay state (the Anthropic raw-turn cache)
        // carries the complete response, so a partially persisted call set
        // would replay tool_use blocks that resume-time reconciliation
        // cannot answer; and provider.response subscribers may publish the
        // answer externally (a channel edit) the moment the event fires —
        // an answer a user has seen must already be durable, or a crash
        // resumes with history that contradicts what was delivered.
        const calls: ToolCall[] = [];
        for (const part of response.parts) {
          if (part.type === 'text') {
            session.messages.push({
              id: `${session.id}:assistant:${session.messages.length + 1}`,
              role: 'assistant',
              content: part.text,
              createdAt: new Date().toISOString(),
            });
            continue;
          }
          calls.push(part.call);
          session.messages.push({
            id: `${session.id}:assistant:${session.messages.length + 1}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            toolCalls: [part.call],
          });
        }
        const sawToolCall = calls.length > 0;
        await this.store.save(session);
        await this.bus.emit({ type: 'provider.response', sessionId: session.id, parts: response.parts });

        await this.runToolCalls(session, calls, signal, undefined, turn);

        if (!sawToolCall) {
          break;
        }
      }

      session.status = 'completed';
      await this.store.save(session);
      const stored = await this.store.get(session.id);
      session = stored ?? session;
      await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });
      await this.bus.emit({
        type: 'session.completed',
        sessionId: session.id,
        // Copies all the way down — a fresh array of fresh records, not the
        // session's own. This is durable accounting state rather than a
        // per-event payload, so a subscriber that sorts the list, appends to
        // it, or normalizes a count in place must not be reaching the stored
        // record. A shallow array copy is not enough: the record objects
        // behind it are the ones the session holds, and
        // `InMemorySessionStore` hands the very same objects back on the
        // next read.
        //
        // What this does NOT buy is isolation between subscribers. `emit`
        // hands one event object to every handler in turn, so an earlier
        // handler's edits are visible to later ones — true of `parts` on
        // provider.response and of every other payload on this bus, and not
        // a promise the bus has ever made. Copy before mutating.
        ...(session.usage && session.usage.length > 0
          ? { usage: session.usage.map((record) => ({ ...record })) }
          : {}),
      });
      return session;
    } catch (caught) {
      // An abort can surface first from any layer (the provider's cancelled
      // request, an executor, this loop's own checks) — normalize so an
      // aborted turn is always distinguishable from a genuine failure, and
      // so the aborter's own reason wins over whichever layer noticed first.
      const error = signal?.aborted
        ? (signal.reason instanceof RunAbortedError || !(caught instanceof RunAbortedError)
            ? abortErrorFor(signal)
            : caught)
        : caught;
      const lastError = error instanceof Error ? error.message : String(error);
      session.status = 'failed';
      session.lastError = lastError;
      await this.store.save(session);
      const stored = await this.store.get(session.id);
      session = stored ?? session;
      await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });
      await this.bus.emit({ type: 'session.failed', sessionId: session.id, error: lastError });
      throw error;
    }
  }

  /**
   * Finishes a turn that was parked on a human when the process died.
   *
   * This is the one path allowed to re-enter a tool call rather than close
   * it as interrupted, and the checkpoint is what earns that: approval
   * happens strictly before execution, so a call carrying the record
   * provably never started. `resume()`'s reconciliation must not run first
   * — it would answer the parked call with "may not have run to
   * completion" and strand the queue behind it.
   *
   * Returns undefined when the session is not parked, so a caller sweeping
   * the store does not have to pre-filter.
   */
  async recoverPendingApproval(
    sessionId: string,
    options: {
      /**
       * Refuse the parked call without asking — its deadline passed while
       * the process was down. The calls queued behind it were never asked
       * about at all, so they still face the policy normally.
       */
      denyPending?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Session | undefined> {
    const session = await this.store.get(sessionId);
    if (!session) {
      return undefined;
    }
    const record = readPendingApproval(session);
    if (!record) {
      return undefined;
    }

    const pending = record.call;
    const remaining = record.remaining;

    // The checkpoint deliberately stays put here. Clearing it before the
    // recovered wait is durably re-established leaves a window in which the
    // session reads as `running` with the approval still unanswered — a
    // daemon that dies inside it is skipped by the next sweep, and the call
    // is later closed as interrupted rather than recovered. Re-parking
    // overwrites it; answering retires it, in the same save as the result.
    if (options.denyPending) {
      // Written exactly as executeToolCall would have written a refusal,
      // so a turn denied by an expired deadline is indistinguishable
      // downstream from one denied by a person — and the queue behind it
      // still drains, leaving no `tool_use` without a `tool_result`.
      const result: ToolResult = {
        callId: pending.id,
        toolName: pending.toolName,
        ok: false,
        output: null,
        error: `Tool call denied by approval policy: ${pending.toolName}`,
      };
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call: pending });
      // Result and retirement in one write: a crash between them would
      // either re-deny an answered call or lose the denial.
      await this.recordToolResult(session, result);
        return this.executeTurns(session, options.signal, { pending: undefined, remaining, turn: record.turn });
    }

    return this.executeTurns(session, options.signal, {
      pending,
      remaining,
      parkedAt: record.parkedAt,
      turn: record.turn,
    });
  }

  /**
   * Records one tool result — and, in the *same* save, retires the
   * checkpoint if it was for this call.
   *
   * Two writes would leave a window where the result is durable and the
   * record is not (a later sweep re-executes an answered call) or the other
   * way round. Since a call with a recorded result is by definition no
   * longer re-enterable, the two facts belong in one write.
   */
  private async recordToolResult(session: Session, result: ToolResult): Promise<void> {
    session.messages.push({
      id: `${session.id}:tool:${result.callId}`,
      role: 'tool',
      name: result.toolName,
      content: JSON.stringify(result),
      createdAt: new Date().toISOString(),
      toolResult: result,
    });

    if (readPendingApproval(session)?.call.id === result.callId) {
      const metadata = { ...(session.metadata ?? {}) };
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
      session.metadata = metadata;
      session.status = 'running';
    }

    await this.store.save(session);
  }

  /**
   * Runs a response's tool calls in order, recording each result as it
   * lands. Shared by the normal path and by recovery, so a resumed turn
   * writes exactly what an uninterrupted one would.
   */
  private async runToolCalls(
    session: Session,
    calls: ToolCall[],
    signal?: AbortSignal,
    /**
     * The original park time, when these calls come from a recovered turn.
     * Applies to the first call only — it is the one that was already
     * waiting; anything behind it has not been asked about yet.
     */
    parkedAt?: string,
    turn = 1,
  ): Promise<void> {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      throwIfAborted(signal);
      const result = await this.executeToolCall(session, call, {
        ...(signal ? { signal } : {}),
        remaining: calls.slice(index + 1),
        turn,
        ...(index === 0 && parkedAt ? { parkedAt } : {}),
      });

      // The result lands immediately after execution, so side effects
      // are never durable without their record.
      await this.recordToolResult(session, result);
    }
  }

  /**
   * Executes one tool call with this runner's allowlist, approval policy,
   * events, and executor — for providers that drive their own inner loop
   * (e.g. the Claude Code runtime) but must run Stratus tools exactly as
   * if the kernel loop had called them.
   */
  async executeHostedToolCall(session: Session, call: ToolCall, context?: ExecutionContext): Promise<ToolResult> {
    // Persistence is part of this seam's contract, not a courtesy: a
    // provider-driven loop consumes tool results internally and returns
    // only final text, so without recording here the durable session would
    // omit every hosted tool action — including its side effects. The
    // paired messages match what the kernel loop writes, in the same
    // order: the call is saved before it runs and the result immediately
    // after, so a daemon killed mid-tool never holds a session whose side
    // effects happened without a recorded attempt.
    session.messages.push({
      id: `${session.id}:assistant:${session.messages.length + 1}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [call],
    });
    await this.store.save(session);

    // Not recoverable: this result is consumed by the hosting provider's
    // own loop, which a restart cannot rebuild. See the option's docs.
    const result = await this.executeToolCall(session, call, {
      ...(context?.signal ? { signal: context.signal } : {}),
      recoverable: false,
    });

    session.messages.push({
      id: `${session.id}:tool:${result.callId}`,
      role: 'tool',
      name: result.toolName,
      content: JSON.stringify(result),
      createdAt: new Date().toISOString(),
      toolResult: result,
    });
    await this.store.save(session);

    return result;
  }

  /**
   * Marks the turn parked, durably, for the window in which nothing has
   * happened yet — and unmarks it the instant a decision arrives, before
   * the tool runs. A crash inside that window is recoverable exactly; a
   * crash outside it is not, and must stay indistinguishable from any other
   * interrupted call.
   */
  private async checkpointPendingApproval(
    session: Session,
    record: PendingApprovalRecord | undefined,
  ): Promise<void> {
    const metadata = { ...(session.metadata ?? {}) };
    if (record) {
      metadata[PENDING_APPROVAL_METADATA_KEY] = record as unknown as JsonObject;
    } else {
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
    }
    session.metadata = metadata;
    session.status = record ? 'pending_approval' : 'running';
    // Saved, not announced. The durable status exists so a restarting
    // daemon can find this turn; live consumers already get
    // tool.approval-requested and tool.approval-resolved, which say the
    // same thing with the call and the risk attached. Emitting here would
    // add two session.updated events to every gated call and tell nobody
    // anything they were not told better.
    await this.store.save(session);
  }

  private async executeToolCall(
    session: Session,
    call: ToolCall,
    options: {
      signal?: AbortSignal;
      /**
       * The calls queued behind this one in the same response. Recorded on
       * the checkpoint so a recovering daemon can finish the response
       * rather than leaving its later `tool_use` blocks unanswered.
       */
      remaining?: ToolCall[];
      /**
       * Whether a parked wait here is a checkpoint a restart may re-enter.
       *
       * False for a provider that drives its own inner loop. Recovery
       * re-enters the *kernel* loop, which can only continue a turn whose
       * next step is a kernel provider call — it cannot reconstruct an SDK
       * inner loop or the handler that was waiting to consume this result.
       * Checkpointing such a call would have a restart execute it and then
       * continue from a state the hosting provider never produced. 04 makes
       * that explicit: the SDK path is excluded from the resume-the-exact-
       * call guarantee and must fail cleanly instead, with the pending call
       * never executed. No checkpoint is exactly that failure — the call is
       * closed as interrupted like any other dangling one.
       */
      recoverable?: boolean;
      /**
       * When this wait began, if it began before a restart. Preserved so a
       * window is measured from the original park rather than restarted on
       * every recovery.
       */
      parkedAt?: string;
      /** The provider turn these calls came from, for the checkpoint. */
      turn?: number;
    } = {},
  ): Promise<ToolResult> {
    const { signal, remaining = [] } = options;
    // Every tool call settles with exactly one event — tool.completed
    // (executed or rejected, the result says which) or tool.denied. Event
    // consumers tracking a response's outstanding calls (the gateway's
    // phase-aware watchdog) count on rejected calls settling too.
    const rejected = async (error: string): Promise<ToolResult> => {
      const result: ToolResult = {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error,
      };
      await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
      return result;
    };

    // Gate 2 of two for skill.read, independent of gate 1 on purpose: this
    // path also serves providers hosting their own loop, and a model can
    // call the reader by name without it having been advertised. The
    // exemption keys on the same fact — the agent has a skill enabled — so
    // the reader is never a tool the agent can see, is told to use, and is
    // refused when it uses. Which skill may then be read is the `skills:`
    // allowlist, enforced inside the tool itself.
    const allowedTools = this.allowedToolsFor(session);
    if (call.toolName === SKILL_READ_TOOL_NAME) {
      if (this.enabledSkillsFor(session).length === 0) {
        return rejected(`Tool not permitted for agent ${session.agent.id}: ${call.toolName} (no skills enabled)`);
      }
    } else if (allowedTools !== undefined && !matchesToolAllowlist(call.toolName, allowedTools)) {
      return rejected(`Tool not permitted for agent ${session.agent.id}: ${call.toolName}`);
    }

    // Resolved before the policy is asked, not after: a policy classifies
    // an invocation by the tool's declared risk, and a call name is not
    // enough to look that up on the policy's side. It also stops an unknown
    // tool from reaching a human — a call naming nothing registered is a
    // model mistake, and prompting someone to approve it is noise.
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return rejected(`Tool not found: ${call.toolName}`);
    }

    // Only a call that can actually be held for a human is checkpointed:
    // a `safe` one is never asked about, and writing a record for it would
    // add a save to every unattended call to describe a wait that does not
    // happen.
    const risk = resolveToolRisk(tool);
    // Asked about either way — only whether the wait leaves a re-enterable
    // checkpoint differs.
    const checkpointed = risk !== 'safe' && options.recoverable !== false;
    if (checkpointed) {
      await this.checkpointPendingApproval(session, {
        call,
        remaining,
        turn: options.turn ?? 1,
        parkedAt: options.parkedAt ?? new Date().toISOString(),
      });
    }

    /**
     * Where this call was judged, captured the instant the policy answered.
     *
     * `Tool.originFor` says a call is judged by the page its conversation
     * is on, and the approval is not the last thing between that judgement
     * and the act: clearing the checkpoint is a store write, and
     * `tool.called` is delivered to every subscriber, awaited, before the
     * executor is reached. A page that navigates inside all that would be
     * clicked on having been judged somewhere else, and the policy's own
     * re-read cannot see past its own return. So the seam's contract is
     * enforced where the dispatch happens, which is the only place that
     * can — read again below, immediately before the executor.
     *
     * Read *after* the policy rather than before it, and that is not a
     * detail: a policy judges the page as it stands when it decides, which
     * is deliberately after it has loaded whatever grants it consults. A
     * snapshot taken before the call would disagree with the answer for
     * every page that moved during that load, and would refuse an action
     * the policy had just correctly allowed. Nothing awaits between the
     * policy's return and this line, so the two agree by construction.
     *
     * A tool that does not answer this reads `undefined` both times and is
     * unaffected.
     */
    let originWhenJudged: string | undefined;

    let approved: boolean;
    try {
      approved = await this.approvals.approve({
        session,
        call,
        tool,
        risk,
        ...(signal ? { signal } : {}),
        ...(options.parkedAt ? { parkedAt: options.parkedAt } : {}),
      });
      originWhenJudged = originForSession(tool, session);
    } finally {
      // Cleared before anything executes and on every exit — an abort that
      // throws out of the policy must not leave the session looking parked
      // on a question nobody is waiting for.
      if (checkpointed) {
        await this.checkpointPendingApproval(session, undefined);
      }
    }

    if (!approved) {
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call });
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `Tool call denied by approval policy: ${call.toolName}`,
      };
    }

    throwIfAborted(signal);
    await this.bus.emit({ type: 'tool.called', sessionId: session.id, call });

    // The last thing before the executor, and after the emission above
    // rather than before it, because that emission is itself a wait on
    // whatever the host subscribed. A refusal here is a failed result, not
    // a denial: `tool.called` has been announced, and settling it with
    // `tool.completed` keeps the pairing every consumer reads — the
    // watchdog's phase, the channel's live line. The agent is told plainly,
    // because this is a page that moved rather than a permission it lacks.
    const originNow = originForSession(tool, session);
    if (originNow !== originWhenJudged) {
      const result: ToolResult = {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `${call.toolName} was judged on ${originWhenJudged ?? 'a page with no origin'} and this `
          + `conversation is now on ${originNow ?? 'no page'}, so it did not run. `
          + 'Check where the page is and call again.',
      };
      await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
      return result;
    }

    const result = await this.executor.execute(call, tool, session, signal ? { signal } : undefined);
    await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
    return result;
  }
}
