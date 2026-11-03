/*
 * The system prompt: the persona line, the skills block, effort levels,
 * the reply language, the channel and runtime sections, and how they are
 * joined into the prompt every provider sends. A module of its own because
 * every provider adapter renders through it. `index.ts` re-exports every
 * name, so the package's one public entry is unchanged.
 */
import {
  type AgentDefinition,
  type AgentModelContext,
  type AgentRuntimeContext,
  CONVERSATION_METADATA_KEY,
  type ConversationContext,
  conversationContextFrom,
  type JsonObject,
  type ProviderRequest,
  renderMemorySection,
  type Session,
  SKILL_READ_TOOL_NAME,
  type SkillDescriptor,
} from './index.ts';

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

/**
 * How hard a Claude model works on a turn, lowest first: the API's
 * `output_config.effort` and the Agent SDK's `effort` option. A soul's
 * `effort:` sets it per agent; unset sends nothing, which leaves each
 * model on its own default.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const isEffortLevel = (value: unknown): value is EffortLevel =>
  typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);

/**
 * The effort levels a Claude model takes, or `undefined` for a model this
 * table does not know (a proxy's name, a model newer than this release).
 * An empty list is a model known to take no effort at all.
 *
 * Kept to families the effort docs name. A model missing here is sent the
 * configured value as written and reported as unverified, never as applied.
 */
/**
 * A Claude model id with its other established names folded away: a
 * Bedrock id (`anthropic.` behind any region or `global.` qualifier, a
 * `-v1:0` suffix) and a Vertex one (`@` and a date), lowercased. Every
 * check on a model family goes through this, so one that recognizes a
 * name and another that misses it cannot disagree about the same model.
 */
export const claudeModelBase = (model: string): string =>
  model.trim().toLowerCase().replace(/^(?:[a-z0-9-]+\.)*anthropic\./, '').split('@')[0]!.replace(/-v\d+(?::\d+)?$/, '');

/**
 * The highest effort a Claude model takes with thinking disabled, for the
 * models the effort docs name a ceiling for (Claude Opus 5 and Claude
 * Haiku 5.5: `high`; above it the API answers 400). `undefined` is no
 * known ceiling. Kept beside `effortLevelsFor` so both read one id.
 */
export const disabledThinkingEffortCeiling = (model: string): EffortLevel | undefined => {
  const id = claudeModelBase(model);
  return /^claude-opus-5(-|$)/.test(id) || /^claude-haiku-5-5(-|$)/.test(id) ? 'high' : undefined;
};

export const effortLevelsFor = (model: string): readonly EffortLevel[] | undefined => {
  // Missed, Opus 4.6 under its Bedrock name asked for xhigh would be sent
  // xhigh as unverified and refused.
  const id = claudeModelBase(model);
  if (/^claude-(opus|sonnet|fable|mythos)-5(-|$)/.test(id) || /^claude-haiku-5-5(-|$)/.test(id) || /^claude-opus-4-[78](-|$)/.test(id)) {
    return EFFORT_LEVELS;
  }
  // Mythos Preview takes max but not xhigh, like the 4.6 models.
  if (/^claude-(opus|sonnet)-4-6(-|$)/.test(id) || /^claude-mythos-preview(-|$)/.test(id)) {
    return ['low', 'medium', 'high', 'max'];
  }
  if (/^claude-opus-4-5(-|$)/.test(id)) {
    return ['low', 'medium', 'high'];
  }
  if (/^claude-(haiku-4-5|sonnet-4-5|(sonnet|opus)-4(-20\d{6})?$|opus-4-[01](-|$)|3)/.test(id)) {
    return [];
  }
  return undefined;
};

/**
 * What one model does with a configured effort.
 *
 * - `applied`: the model takes it, and `effort` is what is sent.
 * - `lowered`: the model lacks it; `effort` is the highest level it does
 *   take below the request (Opus 4.6 asked for xhigh gets high).
 * - `unsupported`: the model takes no effort; nothing is sent.
 * - `unverified`: the model is not one {@link effortLevelsFor} knows; the
 *   request is sent as written and the API decides.
 */
export interface EffortResolution {
  requested: EffortLevel;
  effort?: EffortLevel;
  status: 'applied' | 'lowered' | 'unsupported' | 'unverified';
}

export const resolveEffort = (model: string, requested: EffortLevel): EffortResolution => {
  const levels = effortLevelsFor(model);
  if (levels === undefined) {
    return { requested, effort: requested, status: 'unverified' };
  }
  if (levels.includes(requested)) {
    return { requested, effort: requested, status: 'applied' };
  }
  const below = EFFORT_LEVELS.slice(0, EFFORT_LEVELS.indexOf(requested)).filter((level) => levels.includes(level));
  const lowered = below.at(-1);
  return lowered === undefined
    ? { requested, status: 'unsupported' }
    : { requested, effort: lowered, status: 'lowered' };
};

/** One line for logs and diagnostics: `high`, `high (asked xhigh; claude-opus-4-6 has no xhigh)`. */
export const describeEffort = (model: string, resolution: EffortResolution): string => {
  switch (resolution.status) {
    case 'applied':
      return resolution.requested;
    case 'lowered':
      return `${resolution.effort} (asked ${resolution.requested}; ${model} has no ${resolution.requested})`;
    case 'unsupported':
      return `not sent (asked ${resolution.requested}; ${model} takes no effort setting)`;
    case 'unverified':
      return `${resolution.requested} (sent; ${model} is not a model Stratus knows the effort levels of)`;
  }
};

/**
 * The language agents write in when nothing says otherwise: American
 * English. A soul's `language:` and the config file's `language` override
 * it; see `resolveRuntimeConfig`, which decides between those two.
 */
export const DEFAULT_LANGUAGE = 'en-US';

/**
 * A `language` setting in canonical form (`EN-us` is `en-US`), or nothing
 * when it is not a BCP 47 tag.
 *
 * The runtime's own parser decides, rather than a pattern of ours: tags are
 * case-insensitive and may carry extensions (`en-US-u-hc-h12`), and a
 * hand-written shape refused both while the docs promised a language tag.
 * The character and length gate in front of it is ours, and is the part
 * that matters for safety: the tag is interpolated into every prompt and a
 * project-local config may set it, so it may hold letters, digits, and
 * hyphens and nothing that could make a sentence.
 */
const canonicalLanguageTag = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9-]+$/.test(value)) {
    return undefined;
  }
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
};

/** Whether a `language` setting is a BCP 47 tag; see `canonicalLanguageTag`. */
export const isLanguageTag = (value: unknown): value is string => canonicalLanguageTag(value) !== undefined;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  'en-US': 'American English',
  'en-GB': 'British English',
  'en-AU': 'Australian English',
  'en-CA': 'Canadian English',
  'en-IE': 'Irish English',
  'en-NZ': 'New Zealand English',
};

/**
 * How to reply, told to every agent before its persona.
 *
 * Models default to the long, headed, bulleted answer, and an agent is read
 * mostly in chat, often on a phone, where that is the wrong shape. Souls
 * were each growing their own copy of these rules, so they live here once.
 * Short must not turn into incomplete, so the same section says a requested
 * deliverable arrives whole and a blocker is always said.
 *
 * A task that needs tools opens with one line saying what the agent is
 * about to do (card 950). Models call tools before they write anything, so
 * the first post on a long task was a step already finished, and the person
 * learned what the agent had set out to do only from its results. A channel
 * posts the words written before a tool call as they happen, so the first
 * words are the first post. A quick answer gets no such line, and neither
 * does an overheard message: a turn nobody asked for posts on its first
 * text, and a line written on the way to deciding to stay quiet would be a
 * post that decision cannot take back. A long one goes
 * where the reader can open it: an agent on Slack that answers with a path
 * on the daemon's disk has handed over nothing, so when sharing is not
 * possible the content itself goes in the reply.
 *
 * The accuracy rules are here for the same reason, each after an incident:
 * an agent with no Slack tool insisted it had no Slack connection, and
 * agents reported work as done that had only been drafted. The
 * look-before-you-ask pair is there because a conversation's session holds
 * its own messages and a slice of memory, nothing more: when work moved to
 * a new channel, the agent's session there asked the person what its own
 * earlier thread and files already said. Pointers, not a brief at session
 * open, because the thread and the file were both in reach and nothing said
 * to look. What it finds is linked, or asked about before it is repeated,
 * unless it can tell everyone in the room could already see it. The room
 * context gives only this room's kind and size, and a read returns no
 * membership, so the agent cannot check another conversation's audience; a
 * link is checked by the channel itself, and a file cannot be linked, so it
 * asks. The language rule is here because the default persona is not: a
 * custom soul replaces it, and an agent wrote "favour" and "licence" into
 * American website copy because nothing shared said which English. A pasted
 * British paragraph is not a setting, so the rule says a task or a client's
 * style guide decides one deliverable and nothing is inferred from source
 * text.
 *
 * The last sentence lets the soul and the person override length, format,
 * and language, and deliberately nothing else: a style preference never
 * changes what an agent may do, and "be brief" must not read as "skip the
 * blocker". Written without em dashes on purpose: a model imitates the
 * prose it is prompted with, and a rule against them set in them undoes
 * itself.
 */
export const renderReplySection = (language: string | undefined): string => {
  const tag = canonicalLanguageTag(language) ?? DEFAULT_LANGUAGE;
  // Named by language and region alone, so `en-GB-u-hc-h12` is still British
  // English; the tag itself is shown whole.
  const locale = new Intl.Locale(tag);
  const name = LANGUAGE_NAMES[locale.region !== undefined ? `${locale.language}-${locale.region}` : locale.language];
  const variety = name === undefined ? `the language of the ${tag} locale` : name;
  const written = name === undefined ? `the language of the ${tag} locale` : `${name} (${tag})`;
  return [
    [
      'How to reply: like a text message, usually one to four short sentences. Lead with the answer, the result, or the decision you need, then stop.',
      'Write the way a person texts. Avoid em dashes; use a comma, a period, or a new sentence instead. Skip the tells of machine-written text: filler openers and closers like "Great question" or "I hope this helps", "it\'s not X, it\'s Y" framing, lists of three for rhythm, words like delve and seamless used for effect, and emoji the person has not used first. A technical term used for what it means is not filler.',
      'No preamble, no restating the request, no summary of what you just said, no closing offer of more help, and no headers or bullet lists unless they genuinely make the reply easier to read.',
      'Short never means incomplete. When you are asked for a draft, a plan, an explanation, a review, or a document, deliver all of it at the depth asked for the first time. Cut repetition, never what was asked for, and always say plainly what is blocking you or what you are unsure of.',
      'A long deliverable belongs somewhere the person can open it, such as a file or page you can actually share, and the reply is the takeaway plus its real link. Never invent a link, and never assume a path on your own machine is one they can open. When you cannot share it, put the deliverable itself in the reply: a file saved where they cannot reach it has not been delivered.',
      'When someone asks you to do something that will take more than one quick lookup, your first words, before your first tool call, are one line saying what you are about to do, so they know the work has started and what it is. Skip that line for a question you can answer straight away or with one quick lookup, and for a message that was not addressed to you.',
      'After that, message the person mid-task only when you need them or it is worth their time, never to narrate your steps; keep it to a line, and never split one long answer across several messages.',
      'Carry on with work you have already been asked to do instead of asking permission for each step. Ask only the questions you cannot go on without, all of them at once, and keep doing the parts that do not depend on the answers.',
      'Before sending, ask whether this would be annoying to read on a phone; if it would, cut it.',
    ].join(' '),
    [
      'Stay accurate: never invent a feature, a number, evidence, a fact about a customer, a personal experience, or work you did not do, however much better it would make the answer sound.',
      'Say which parts are proposals and which are facts, and say exactly how far something got, because drafted, saved, tested, sent, deployed, and verified are different claims.',
      'Judge what you can do from evidence. Having no Slack tool does not mean there is no Slack connection, and a lookup that came back empty does not prove an integration is disconnected. When someone corrects you, check the claim again instead of defending it.',
      'When a message refers to work, a file, or a decision you cannot see in this conversation, look before you ask about it or answer: check your memory, your own files, and the recent messages of the channel or thread where it most likely happened.',
      'Unless you can tell that everyone here could already see what you found, link to it or ask before repeating it.',
      'When you move work into a new thread, channel, or file, leave a pointer the next conversation can find: post its link where the work started, or remember where it now lives.',
      'Never promise to monitor, remind, follow up, or keep working in the background unless you have actually scheduled it or handed it to someone; say what you set up, or that you cannot.',
    ].join(' '),
    [
      `Write in ${written}: replies, documents, drafts, reviews, website copy, and interface text, with its spelling consistent throughout.`,
      `A task that asks for another variety, or a style guide you were given for that client, decides that one deliverable, and afterwards you go back to ${variety}. Never take a variety from text someone pasted or from your own habit.`,
      'Leave quotations, names, URLs, paths, code identifiers, and API literals exactly as they are, and never rename code to change its spelling.',
      'A preference about style or language changes how you write, never what you are allowed to do. An exception made for one task ends with that task, and what someone tells you now outranks an older memory that says otherwise.',
      'Something you remember from one conversation stays out of another whose people were not part of it, unless it was plainly meant to be shared.',
      'Where your own instructions below, or the person you are talking to, ask for a different length, format, or language, that wins.',
    ].join(' '),
  ].join('\n\n');
};

/**
 * Where the conversation is happening, for a session a channel started.
 *
 * A channel adapter records itself as `metadata.channel` on the sessions it
 * dispatches (`slack` today). Without this the agent could not tell: an
 * agent with no Slack tool, asked about an attachment in a Slack DM, told
 * the person it had "no Slack connection at all" and argued the point.
 * The channel is read from the session, so sessions opened before this
 * existed get it too; the room (`ConversationContext`) comes per turn from
 * the runtime, falling back to what the session's first turn recorded, so
 * an agent in a Slack DM no longer tells the person they are "talking on
 * the terminal". The name must look like a channel
 * id, since it is interpolated into the prompt.
 *
 * What it says about attachments is what the adapter writes into the
 * message, not a promise that they arrive: it used to say that what people
 * attach "reaches you", which read as though every file's contents did,
 * when most reach the turn as a name only. The Slack adapter marks each
 * file as read, shown, or unread with its reason; the section sends the
 * model to that note and nowhere else.
 */
export const renderChannelSection = (
  session: Pick<Session, 'metadata'>,
  conversation?: ConversationContext,
): string | undefined => {
  const channel = session.metadata?.channel;
  if (typeof channel !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(channel)) {
    return undefined;
  }
  const name = `${channel.charAt(0).toUpperCase()}${channel.slice(1)}`;
  // Checked again whoever handed it in: a host can build the runtime by
  // hand, and an unknown kind would otherwise render as nothing at all.
  const room = conversation !== undefined
    ? conversationContextFrom({ [CONVERSATION_METADATA_KEY]: conversation as unknown as JsonObject })
    : conversationContextFrom(session.metadata);
  const where = room ? describeRoom(room, name) : `this conversation is happening in ${name}.`;
  return `Where you are: ${where} The people in it are writing to you there and your replies are posted back to them there, `
    + `so you are talking in ${name}, not in a terminal or a local chat, whether or not you have any ${name} tools. `
    + 'Their message says what became of each file they attach: its text follows, the image itself is shown to you, or only its name reached you, with the reason it was not read. '
    + 'That is everything you have of it, and a file the message does not mention did not reach you, so never guess at a file\'s contents, location, or why it failed beyond what the message says.';
};

/**
 * One room, said plainly, with who can read it and what that asks of a
 * reply. The audience is the point: what fits a direct message does not
 * fit a channel a whole company reads, and what someone said in private
 * does not belong in either kind of channel.
 */
const describeRoom = (room: ConversationContext, channel: string): string => {
  const count = room.members !== undefined ? room.members.toLocaleString('en-US') : undefined;
  const idNote = room.id !== undefined ? ` Its ${channel} id is ${room.id}.` : '';
  const inThread = room.thread === true ? ' You are replying in a thread there, which everyone who can read the channel can open.' : '';
  const outside = room.shared === true
    ? ' It is shared with people outside this workspace, through Slack Connect or another workspace of the organization, and they read it too.'
    : '';
  const forEveryone = 'Everyone here reads what you post, so write for all of them, and keep out of it what came to you in a direct message or another conversation '
    + 'unless the people there meant it to be shared, and anything meant for one person only, such as a secret or a link only they should use.';
  switch (room.kind) {
    case 'direct':
      return `this is a direct message in ${channel}${room.with !== undefined ? ` with ${room.with}` : ''}. `
        + `Only the two of you can read it, so you are talking to one person.${room.thread === true ? ' You are replying in a thread in that direct message.' : ''}`;
    case 'group':
      return `this is a group direct message in ${channel}${count !== undefined ? ` with ${count} members, you included` : ''}. `
        + `Only they can read it.${idNote}${outside}${inThread} ${forEveryone}`;
    case 'private':
      return `this is a private ${channel} channel${count !== undefined ? ` with ${count} members, you included` : ''}. `
        + `Only its members can read it.${idNote}${outside}${inThread} ${forEveryone}`;
    case 'public':
      return `this is a public ${channel} channel${count !== undefined ? ` with ${count} members` : ''}. `
        + `Anyone in the workspace can find it and read it, now or later, not only the people talking.${idNote}${outside}${inThread} ${forEveryone}`;
  }
};

// A provider or model name as the prompt may carry it. A model name can
// come from a project-local config, so one that does not look like a model
// name is left out rather than read to the model as an instruction.
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/**
 * Which model is configured and which is answering, stated as the runtime
 * knows it. An agent asked what model it was could only guess, and the
 * default persona told it the question did not matter; with a fallback in
 * the picture the guess is wrong half the time. It stays the agent either
 * way: this reports what serves it, not who it is.
 */
const renderModelLine = (model: AgentModelContext | undefined): string | undefined => {
  if (model === undefined || !MODEL_NAME_PATTERN.test(model.provider)) {
    return undefined;
  }
  const named = (entry: { provider: string; model?: string }): string =>
    entry.model !== undefined && MODEL_NAME_PATTERN.test(entry.model) ? `${entry.model} on ${entry.provider}` : entry.provider;
  const fallback = model.fallback !== undefined
    && MODEL_NAME_PATTERN.test(model.fallback.provider)
    && MODEL_NAME_PATTERN.test(model.fallback.model)
    ? model.fallback
    : undefined;
  const parts = [`The model configured to answer as you is ${named(model)}${fallback ? `, with ${named(fallback)} as its fallback` : ''}.`];
  if (model.onFallback === true && fallback !== undefined) {
    parts.push(`This conversation has switched to the fallback, so ${named(fallback)} is the one answering now.`);
  }
  parts.push('Asked what model you are, say this, and keep the configured default and the one answering apart when they differ.');
  return parts.join(' ');
};

/**
 * How this agent is run, for a host that said (see
 * {@link AgentRuntimeContext}).
 *
 * It says the soul is already in the prompt as firmly as it says where the
 * file is. An agent told only a path treats it as something to go and read,
 * and it usually cannot: the soul sits beside its state directory, outside
 * any root an operator hands `tool-fs`, and it has to stay there, since
 * the soul is what grants the agent its tools and credentials.
 *
 * Credentials get the same treatment, and for the same reason: an agent
 * whose operator had stored a shared key went looking through its files and
 * its environment for it. A named credential only ever reaches a plugin tool
 * that declared it, so the section names what the soul grants and says there
 * is nothing to find. Names only; a value never comes near a prompt.
 * Written without em dashes for the reason the reply section is.
 */
export const renderRuntimeSection = (
  runtime: AgentRuntimeContext | undefined,
  agent: Pick<AgentDefinition, 'credentials'>,
): string | undefined => {
  if (runtime === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (runtime.soulPath) {
    lines.push(
      `Your soul, the persona and instructions you were given here, is the file ${runtime.soulPath}. `
      + 'Its contents are already part of these instructions, so there is nothing to open or reread, '
      + 'and it is not a file in your workspace.'
      + (runtime.soulReloads ? ' Stratus reads it again before every turn, so an edit to it reaches your next reply.' : ''),
    );
  }
  if (runtime.workspace) {
    lines.push(`Your workspace, the directory where Stratus keeps the files your tools make for you, is ${runtime.workspace}.`);
  }
  const model = renderModelLine(runtime.model);
  if (model !== undefined) {
    lines.push(model);
  }
  const credentials = agent.credentials ?? [];
  lines.push(
    (credentials.length > 0
      ? `Credentials you may use: ${credentials.join(', ')}. The tools that need one use it on your behalf, so you never see a value, and there is no file or environment variable to look for. `
      : 'You hold no credentials. ')
    + 'When a task needs a credential you do not hold, ask for it with the credential.request tool if you have it; otherwise ask your operator to store it with stratus credential set and grant it to you.',
  );
  return `How you run: you are an agent on Stratus Agent. ${lines.join(' ')}`;
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
 * `preamble`, `replies`, `persona`, `runtime`, `channel`, and `skills` are byte-identical across every turn of
 * an agent's life, while `memory` is rewritten whenever the agent remembers
 * anything. A provider that caches its request prefix has to place those two
 * groups differently, and it cannot tell them apart from rendered strings.
 */
export type SystemPromptSectionKind = 'preamble' | 'replies' | 'persona' | 'runtime' | 'channel' | 'memory' | 'skills';

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
  request: Pick<ProviderRequest, 'session' | 'memory' | 'skills' | 'runtime'>,
  options: SystemPromptOptions = {},
): SystemPromptSection[] => {
  const sections: Array<{ kind: SystemPromptSectionKind; text: string | undefined }> = [
    { kind: 'preamble', text: options.preamble },
    { kind: 'replies', text: renderReplySection(request.runtime?.language) },
    { kind: 'persona', text: renderPersonaSection(request.session.agent, { fallback: options.fallbackPersona ?? false }) },
    { kind: 'runtime', text: renderRuntimeSection(request.runtime, request.session.agent) },
    { kind: 'channel', text: renderChannelSection(request.session, request.runtime?.conversation) },
    { kind: 'memory', text: renderMemorySection(request.memory) },
    { kind: 'skills', text: renderSkillsSection(request.skills) },
  ];
  return sections.filter(
    (section): section is SystemPromptSection => section.text !== undefined && section.text.length > 0,
  );
};

/** The sections as plain strings, in the same order. */
export const renderSystemPromptSections = (
  request: Pick<ProviderRequest, 'session' | 'memory' | 'skills' | 'runtime'>,
  options: SystemPromptOptions = {},
): string[] => renderSystemPromptParts(request, options).map((section) => section.text);

/** The sections joined the way single-string providers send them. */
export const renderSystemPrompt = (
  request: Pick<ProviderRequest, 'session' | 'memory' | 'skills' | 'runtime'>,
  options: SystemPromptOptions = {},
): string | undefined => {
  const sections = renderSystemPromptSections(request, options);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
};
