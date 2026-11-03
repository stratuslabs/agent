/*
 * The skill contract: what a skill is and what it costs a turn, the
 * registry an agent's skills are enabled through, and the skill.read tool
 * that hands a model a skill's body. A module of its own because skill
 * plugins and every surface that lists skills build against it. `index.ts`
 * re-exports every name, so the package's one public entry is unchanged.
 */
import {
  type JsonObject,
  matchesSkillAllowlist,
  type Session,
  type Tool,
} from './index.ts';

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
   * Ships with Stratus and is enabled for every agent, whatever its soul's
   * `skills:` says. Reserved for the system's own documentation (the
   * `stratus` skill; `SkillRegistry.register` refuses it on any other id): a skill from anywhere else changing how an agent
   * behaves is opted into, but an agent that cannot read how the system it
   * runs in works guesses instead, the way one suggested `passEnv` for a
   * secret after reading the install around it.
   */
  builtin?: boolean;
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
    // Refused here rather than trusted at the gates: `builtin` skips every
    // soul's `skills:`, so a host that set it on anything else (by mistake,
    // or from data) would hand that skill to every agent.
    if (skill.builtin === true && skill.id !== STRATUS_SKILL_ID) {
      throw new Error(`Skill ${skill.id} is marked builtin, which only the ${STRATUS_SKILL_ID} skill may be. Drop the flag and enable it through skills: in the souls that should have it.`);
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
   *
   * A built-in skill serving now is never dropped by the swap: a `next`
   * without one (its file unreadable mid-reload) keeps the one serving,
   * and a bare alias `next` gave its id yields to it. A reload is
   * all-or-nothing for what it read; it must not take away from every
   * agent the one skill no soul can opt back into.
   */
  replaceWith(next: SkillRegistry): void {
    for (const skill of this.skills.values()) {
      if (skill.builtin === true && !next.skills.has(skill.id)) {
        next.aliases.delete(skill.id);
        next.skills.set(skill.id, skill);
      }
    }
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

/**
 * The built-in skill's id: how Stratus works, enabled for every agent.
 * Reserved, so an operator directory or a plugin cannot put a different
 * procedure under the name every agent is pointed at.
 */
export const STRATUS_SKILL_ID = 'stratus';

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
  readOnly: true,
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
    const permitted = skill?.builtin === true
      || (allowlist !== undefined && addressable.some((candidate) => matchesSkillAllowlist(candidate, allowlist)));
    if (!permitted) {
      throw new Error(`Skill not permitted for agent ${session.agent.id}: ${id}`);
    }
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }
    return { id: skill.id, name: skill.name, body: await skills.read(id) };
  },
});
