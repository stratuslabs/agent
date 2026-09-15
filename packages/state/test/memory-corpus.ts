import type { MemoryEntryKind, TrustLevel } from '@stratusagent/core';

/**
 * A synthetic agent lifetime, with per-turn relevance labels — the ground
 * truth [29](../../../docs/roadmap/29-memory-quality.md)'s numbers are
 * measured against.
 *
 * Fixtures rather than recordings, for two reasons the spec states: real
 * transcripts would carry conversation content into the repository and
 * would be unlicensable to share, and a synthetic lifetime is the only way
 * to have labelled **negatives** — the facts that must not appear — which
 * are the half that actually catches over-injection.
 *
 * The lifetime is a year of an assistant working with one team: three
 * standing facts worth pinning, two beliefs revised recently, a change
 * freeze that has expired, a hand-over that has not started yet, an entity
 * known by an alias, and a long tail of standup notes that are noise on
 * almost every turn. That shape is the point — a store where everything is
 * relevant cannot tell two selection policies apart.
 */
export interface CorpusEntry {
  /** Stable handle the labels refer to; the store id is derived from it. */
  key: string;
  content: string;
  createdAt: string;
  kind: MemoryEntryKind;
  about?: string[];
  validFrom?: string;
  validUntil?: string;
  /** The entry this one replaces, by key. */
  supersedes?: string;
  pinned?: boolean;
  trust?: TrustLevel;
}

export interface CorpusTurn {
  /** What the person asked. Not scored — it is here so the labels can be read. */
  prompt: string;
  /** The facts a competent agent should have had in context for this turn. */
  relevant: string[];
  /** Facts that must not appear: retired beliefs, expired notices, facts not true yet. */
  negatives: string[];
  /** What the agent would search for. Scored separately — see `recall`. */
  query: string;
  /**
   * What that search should surface. Deliberately not the same set as
   * `relevant`: injection here is not query-driven, and a standing
   * preference is relevant to every turn while matching almost no query.
   */
  recall: string[];
}

/** The instant every validity and supersession question is asked at. */
export const CORPUS_NOW = new Date('2026-06-15T12:00:00.000Z');

const standup = (day: number, subject: string): CorpusEntry => ({
  key: `standup-${String(day).padStart(2, '0')}`,
  content: `Standup on ${day} ${day > 24 ? 'May' : 'June'}: ${subject}.`,
  createdAt: `2026-0${day > 24 ? '5' : '6'}-${String(day).padStart(2, '0')}T09:30:00.000Z`,
  kind: 'episodic',
  about: ['standup'],
  trust: 'agent',
});

export const CORPUS_AGENT_ID = 'ava';

export const CORPUS_ENTRIES: CorpusEntry[] = [
  // The standing facts. Old, so no recency policy will ever carry them, and
  // relevant on essentially every turn — which is what a pinned core is for.
  {
    key: 'operator',
    content: 'Dylan is the operator here and prefers short, direct answers.',
    createdAt: '2025-07-01T09:00:00.000Z',
    kind: 'preference',
    about: ['Dylan'],
    trust: 'user',
  },
  {
    key: 'escalation',
    content: 'Anything touching billing goes to the finance rota before you act on it.',
    createdAt: '2025-07-02T09:00:00.000Z',
    kind: 'procedural',
    about: ['billing', 'escalation'],
    trust: 'user',
  },
  {
    key: 'hours',
    content: 'The team works Europe/London and standup is at 09:30.',
    createdAt: '2025-07-03T09:00:00.000Z',
    kind: 'semantic',
    about: ['team', 'standup'],
    trust: 'user',
  },
  // An entity under an alias: the content says "it", and only `about` says
  // what "it" is. A store matching content alone cannot find this.
  {
    key: 'hermes-rust',
    content: 'It was rewritten in Rust last spring, which is why the build box needs the toolchain.',
    createdAt: '2026-03-01T11:00:00.000Z',
    kind: 'semantic',
    about: ['deploy pipeline', 'Hermes'],
    trust: 'agent',
  },
  // An expired notice from last winter.
  {
    key: 'ada-december',
    content: 'Ada is covering on-call through December.',
    createdAt: '2025-12-01T09:00:00.000Z',
    kind: 'episodic',
    about: ['Ada', 'on-call'],
    validUntil: '2026-01-01T00:00:00.000Z',
    trust: 'agent',
  },
  // Belief revision, recent enough that a recency policy carries both halves.
  {
    key: 'deploy-mysql',
    content: 'The deploy pipeline runs on MySQL.',
    createdAt: '2026-06-01T10:00:00.000Z',
    kind: 'semantic',
    about: ['deploy pipeline'],
    trust: 'agent',
  },
  {
    key: 'office-bankside',
    content: 'The office is at Bankside.',
    createdAt: '2026-06-02T10:00:00.000Z',
    kind: 'semantic',
    about: ['office'],
    trust: 'agent',
  },
  {
    key: 'freeze',
    content: 'There is a change freeze on production until the tenth.',
    createdAt: '2026-06-03T10:00:00.000Z',
    kind: 'episodic',
    about: ['change freeze', 'production'],
    validUntil: '2026-06-10T00:00:00.000Z',
    trust: 'agent',
  },
  standup(24, 'the flaky integration suite'),
  {
    key: 'ada-handover',
    content: 'Ada takes over the rookery survey from September.',
    createdAt: '2026-06-05T10:00:00.000Z',
    kind: 'semantic',
    about: ['Ada', 'rookery survey'],
    validFrom: '2026-09-01T00:00:00.000Z',
    trust: 'agent',
  },
  standup(25, 'the staging certificate renewal'),
  standup(26, 'the backlog grooming session'),
  standup(27, 'the incident write-up for the cache outage'),
  standup(28, 'the new starter onboarding checklist'),
  standup(29, 'the quarterly accessibility audit'),
  standup(30, 'the vendor review for the log pipeline'),
  standup(31, 'the roadmap review'),
  standup(4, 'the search relevance spike'),
  standup(7, 'the on-call handover template'),
  standup(8, 'the design review for the settings page'),
  standup(9, 'the dependency bump batch'),
  {
    key: 'deploy-postgres',
    content: 'The deploy pipeline runs on Postgres.',
    createdAt: '2026-06-10T10:00:00.000Z',
    kind: 'semantic',
    about: ['deploy pipeline'],
    supersedes: 'deploy-mysql',
    trust: 'agent',
  },
  {
    key: 'office-southwark',
    content: 'The office moved to Southwark.',
    createdAt: '2026-06-11T10:00:00.000Z',
    kind: 'semantic',
    about: ['office'],
    supersedes: 'office-bankside',
    trust: 'agent',
  },
  {
    key: 'jo-oncall',
    content: 'Jo is on call this week.',
    createdAt: '2026-06-12T10:00:00.000Z',
    kind: 'episodic',
    about: ['on-call', 'Jo'],
    trust: 'agent',
  },
  {
    key: 'refund-approver',
    content: 'Finance asked that refunds over five hundred get a second approver.',
    createdAt: '2026-06-13T10:00:00.000Z',
    kind: 'procedural',
    about: ['billing', 'refunds'],
    trust: 'user',
  },
  {
    key: 'migration-done',
    content: 'The Postgres migration finished and the pipeline is green again.',
    createdAt: '2026-06-14T09:30:00.000Z',
    kind: 'episodic',
    about: ['deploy pipeline', 'standup'],
    trust: 'agent',
  },
];

/** Which entries the lifetime pinned. Named here so the labels and the pins cannot drift apart. */
export const CORPUS_PINNED = ['operator', 'escalation', 'hours'];

export const CORPUS_TURNS: CorpusTurn[] = [
  {
    prompt: 'the deploy is failing again after the migration — what changed?',
    relevant: ['operator', 'deploy-postgres', 'hermes-rust', 'migration-done'],
    negatives: ['deploy-mysql'],
    query: 'deploy pipeline',
    recall: ['deploy-postgres', 'hermes-rust'],
  },
  {
    prompt: 'where is the office now?',
    relevant: ['operator', 'office-southwark'],
    negatives: ['office-bankside'],
    query: 'office',
    recall: ['office-southwark'],
  },
  {
    prompt: 'can you refund this invoice for me?',
    relevant: ['operator', 'escalation', 'refund-approver'],
    negatives: [],
    query: 'refunds',
    recall: ['refund-approver'],
  },
  {
    prompt: 'who is on call?',
    relevant: ['operator', 'jo-oncall'],
    negatives: ['ada-december', 'ada-handover'],
    query: 'on call',
    recall: ['jo-oncall', 'ada-december'],
  },
  {
    prompt: 'what did we cover at standup?',
    relevant: ['operator', 'hours', 'migration-done'],
    negatives: [],
    query: 'migration',
    recall: ['migration-done'],
  },
  {
    prompt: 'can we ship today?',
    relevant: ['operator', 'hours', 'migration-done'],
    negatives: ['freeze'],
    query: 'change freeze',
    recall: ['freeze'],
  },
  {
    prompt: 'brief me on the rookery survey',
    relevant: ['operator'],
    negatives: ['ada-handover'],
    query: 'rookery survey',
    recall: ['ada-handover'],
  },
  {
    prompt: 'who should I talk to about Hermes?',
    relevant: ['operator', 'hermes-rust', 'deploy-postgres'],
    negatives: ['deploy-mysql'],
    query: 'Hermes',
    recall: ['hermes-rust'],
  },
];
