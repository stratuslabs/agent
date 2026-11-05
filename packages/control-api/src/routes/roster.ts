import { readFile, writeFile } from 'node:fs/promises';
import {
  formatSoul,
  isValidAgentId,
  parseSoul,
  type ParsedSoul,
  isValidDelegateEntry,
} from '@stratusagent/agents';
import { LISTENS_MODES, isLanguageTag, isListensMode } from '@stratusagent/core';
import { RestartUnsupportedError, PauseMessageError } from '@stratusagent/gateway';
import {
  claimSoulFile,
  DEFAULT_STRATUS_AGENT,
  listAgentSummaries,
  loadSoulFile,
  parseProviderName,
  withSoulFileLock,
  type AgentSummary,
} from '@stratusagent/state';

import { API_PREFIX, ApiError, optionalString, readJsonObject, requireString } from '../http.ts';
import type { Route, RouteContext } from '../routes.ts';

/** Validate a provider name, reporting a bad one as the client's error. */
const validateProvider = (value: string, field: string): void => {
  try {
    parseProviderName(value, field);
  } catch (error) {
    // The shared parser throws a plain Error, which would surface as a 500 —
    // a value the caller typed is not a server fault.
    throw new ApiError(400, 'invalid_provider', error instanceof Error ? error.message : String(error));
  }
};

/**
 * How strongly a summary claims its id, by the gateway's own rules.
 *
 * `listAgentSummaries` describes *files*, and two files can name one id: a
 * configured default soul shadowing a roster file, or a roster file claiming
 * the reserved built-in id. A last-write-wins map would enrich a live agent
 * with the persona, soul path, resolved runtime, and flags of the file it is
 * *not* running, so the pair is settled the way `loadRoster` settles it:
 *
 * - The configured default soul replaces whatever shares its id, the pathless
 *   built-in source included — `defaultAgentId` re-registers over a source
 *   with no `soulPath`, which is exactly what the built-in is. A configured
 *   soul declaring `id: stratus` is therefore the agent being served, and
 *   ranking the built-in over it reported the served soul as built-in and
 *   uneditable, hiding its own persona and settings behind the stock ones.
 * - Nothing else may take the reserved id: an ordinary roster file claiming
 *   `stratus` is skipped at load with a warning.
 */
const idClaim = (summary: AgentSummary): number => {
  if (summary.default) {
    return 2;
  }
  return summary.id === DEFAULT_STRATUS_AGENT.id && summary.builtIn ? 1 : 0;
};

/** Summaries keyed by id, keeping the one the daemon is actually serving. */
export const summariesById = (summaries: AgentSummary[]): Map<string, AgentSummary> => {
  const byId = new Map<string, AgentSummary>();
  for (const summary of summaries) {
    const existing = byId.get(summary.id);
    if (!existing || idClaim(summary) > idClaim(existing)) {
      byId.set(summary.id, summary);
    }
  }
  return byId;
};

/** The soul file backing an agent, or a 404 naming the id. */
const soulForAgent = async (
  context: RouteContext,
  agentId: string,
): Promise<{ soul: ParsedSoul; path: string }> => {
  const summaries = await listAgentSummaries(context.env, () => {}, context.configPath);
  const summary = summaries.find((entry) => entry.id === agentId);
  if (!summary) {
    throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}.`);
  }
  if (!summary.soulPath) {
    throw new ApiError(
      409,
      'agent_not_editable',
      `${agentId} is the built-in agent and has no soul file to edit. Create your own agent instead.`,
    );
  }
  return { soul: await loadSoulFile(summary.soulPath), path: summary.soulPath };
};

/**
 * An allowlist field, or a 400.
 *
 * Applied only when it happened to be an array, `{ "tools": "shell.run" }` —
 * an edit meant to *restrict* an unrestricted agent — returned 200 while
 * silently leaving every tool reachable. A permission edit that does not take
 * effect must never report success, and coercing arbitrary values with
 * `String` would write allowlist entries that match no tool at all.
 */
const allowlist = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ApiError(400, 'invalid_allowlist', `"${field}" must be an array of strings.`);
  }
  return value as string[];
};

/**
 * A `delegates` edit, checked here rather than left to the soul round-trip:
 * an entry that is not an agent id or `*` is the client's error, and the
 * round-trip's failure would answer it as the server's.
 */
const delegatesAllowlist = (value: unknown): string[] => {
  const entries = allowlist(value, 'delegates');
  const bad = entries.find((entry) => !isValidDelegateEntry(entry));
  if (bad !== undefined) {
    throw new ApiError(
      400,
      'invalid_delegates',
      `"delegates" entry ${JSON.stringify(bad)} is not an agent id or *. Each entry names an agent on the roster, or * for any of them.`,
    );
  }
  return entries;
};

export const rosterRoutes: Route[] = [
  // ---- roster --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents`,
    async handler(context) {
      // The roster the daemon is *serving*, enriched with what the files
      // say — not the other way round.
      //
      // `listAgentSummaries` reads the agents directory, so a soul dropped on
      // disk since the last reload appears in it immediately. Listing from
      // there would advertise an agent that this same API then refuses to
      // dispatch to, because the gateway has never registered the id; a
      // duplicate or unparseable file produces the same mismatch. Anything
      // this endpoint lists can be talked to.
      const summaries = await listAgentSummaries(context.env, () => {}, context.configPath);
      const byId = summariesById(summaries);
      // Activity comes from the running daemon's session store, which the
      // shared builder has no access to: the CLI's listing is about identity
      // and configuration, this one is about a daemon that is serving.
      const activity = context.gateway.store.lastActivityByAgent();

      return {
        agents: context.gateway.agents().map((agent) => {
          const summary = byId.get(agent.id);
          const seen = activity[agent.id];
          return {
            // A registered agent whose file has since moved or broken still
            // lists, from the definition the daemon is actually running.
            id: agent.id,
            name: agent.name,
            default: summary?.default ?? false,
            builtIn: summary?.builtIn ?? agent.id === DEFAULT_STRATUS_AGENT.id,
            // Omitted rather than guessed when no file backs this agent.
            // The gateway keeps dispatching from a cached soul when its file
            // is deleted or momentarily unparseable, and that soul may pin a
            // provider — so claiming `demo` here would report the wrong
            // billing for turns that are really running, at exactly the
            // moment someone is looking to find out why.
            ...(summary?.runsOn ? { runsOn: summary.runsOn } : {}),
            memories: summary?.memories ?? 0,
            ...(summary?.soulPath ? { soulPath: summary.soulPath } : {}),
            ...(summary?.provider ? { provider: summary.provider } : {}),
            ...(summary?.model ? { model: summary.model } : {}),
            ...(summary?.persona ? { persona: summary.persona } : {}),
            ...(agent.avatar ? { avatar: agent.avatar } : summary?.avatar ? { avatar: summary.avatar } : {}),
            // A timestamp and a count, never a verdict. What counts as
            // "recently active" is a rendering decision, and a daemon that
            // baked a window in would need upgrading to change it.
            ...(seen ? { lastActiveAt: seen.lastActiveAt, activeSessions: seen.activeSessions } : { activeSessions: 0 }),
          };
        }),
      };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents/:id`,
    async handler(context) {
      // One agent in full, which the roster listing deliberately is not: it
      // carries `persona`, a one-line snippet for a table row. An editor that
      // saved that snippet back would truncate the real instructions to their
      // first line — so anything editing an agent reads it here first.
      const agentId = context.params.id ?? '';
      const { soul, path: soulPath } = await soulForAgent(context, agentId);
      return {
        agent: soul.agent,
        // The raw markdown, so a client offering a source view edits the same
        // bytes `PUT /agents/:id` accepts back as `soul`.
        soul: await readFile(soulPath, 'utf8'),
        soulPath,
        ...(soul.provider ? { provider: soul.provider } : {}),
        ...(soul.model ? { model: soul.model } : {}),
        ...(soul.language ? { language: soul.language } : {}),
        ...(soul.effort ? { effort: soul.effort } : {}),
      };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/agents`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const instructions = requireString(body, 'instructions');
      const name = optionalString(body, 'name');
      const provider = optionalString(body, 'provider');
      const model = optionalString(body, 'model');
      if (provider !== undefined) {
        // Validated through the shared parser, so the API cannot write a soul
        // the resolver would later refuse.
        validateProvider(provider, 'provider');
      }

      const notes: string[] = [];
      const claimed = await claimSoulFile(
        context.env,
        { ...(name ? { name } : {}), instructions },
        (agent) => formatSoul({
          agent,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        }),
        (message) => notes.push(message),
        context.configPath,
      );

      // The new soul is dispatchable immediately: 07 creates an agent and
      // expects to talk to it without restarting the daemon.
      await context.gateway.reloadRoster();
      context.response.statusCode = 201;
      return {
        agent: claimed.agent,
        soulPath: claimed.soulPath,
        ...(notes.length > 0 ? { notes } : {}),
      };
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/agents/:id`,
    async handler(context) {
      const agentId = context.params.id ?? '';
      const body = await readJsonObject(context.request);
      // Read, edited, and written under the soul lock `grantSoulCredential`
      // shares, so a credential granted from Slack while this edit is in
      // flight is not written over by a version read before it landed.
      const written = await withSoulFileLock(async () => {
        const { soul: current, path: soulPath } = await soulForAgent(context, agentId);

        const raw = optionalString(body, 'soul');
        let next: ParsedSoul;
        if (raw !== undefined) {
          // A raw edit still round-trips through the parser: the app offers a
          // markdown view, and a soul the daemon cannot read must be refused
          // here rather than discovered on the next dispatch.
          try {
            next = parseSoul(raw, { seed: soulPath });
          } catch (error) {
            throw new ApiError(400, 'invalid_soul', `That soul does not parse: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          const provider = optionalString(body, 'provider');
          const model = optionalString(body, 'model');
          // Like a pin: an empty string clears it back to the default, an
          // absent key leaves it alone, and anything but a mode is refused.
          const listens = optionalString(body, 'listens');
          if (listens !== undefined && listens.length > 0 && !isListensMode(listens)) {
            throw new ApiError(
              400,
              'invalid_listens',
              `listens must be one of ${LISTENS_MODES.join(', ')}, not ${JSON.stringify(listens)}.`,
            );
          }
          if (provider !== undefined && provider.length > 0) {
            validateProvider(provider, 'provider');
          }
          // The same shape as a pin: absent keeps the soul's, an empty string
          // clears it back to the config's or the default, and only a tag is
          // written. Rebuilt from fields, a soul that lost this key would move
          // the agent onto another language with nobody having asked.
          const language = optionalString(body, 'language');
          if (language !== undefined && language.length > 0 && !isLanguageTag(language)) {
            throw new ApiError(
              400,
              'invalid_language',
              `language must be a language tag like en-US or en-GB, not ${JSON.stringify(language)}.`,
            );
          }
          // Cleared by an empty string, which the spread below cannot do: a
          // key the current definition carries has to be taken off it.
          const { listens: _kept, ...currentAgent } = current.agent;
          next = {
            agent: {
              ...(listens === undefined ? current.agent : currentAgent),
              ...(optionalString(body, 'name') !== undefined ? { name: optionalString(body, 'name') as string } : {}),
              ...(optionalString(body, 'instructions') !== undefined
                ? { instructions: optionalString(body, 'instructions') as string }
                : {}),
              ...(body.tools !== undefined ? { tools: allowlist(body.tools, 'tools') } : {}),
              ...(body.skills !== undefined ? { skills: allowlist(body.skills, 'skills') } : {}),
              ...(body.credentials !== undefined ? { credentials: allowlist(body.credentials, 'credentials') } : {}),
              ...(body.delegates !== undefined ? { delegates: delegatesAllowlist(body.delegates) } : {}),
              ...(isListensMode(listens) ? { listens } : {}),
            },
            // An empty string clears a pin; an absent key leaves it alone.
            ...(provider === undefined ? (current.provider ? { provider: current.provider } : {}) : (provider ? { provider } : {})),
            ...(model === undefined ? (current.model ? { model: current.model } : {}) : (model ? { model } : {})),
            ...(language === undefined
              ? (current.language ? { language: current.language } : {})
              : (language ? { language } : {})),
            // Not editable through these fields, but rebuilt with them: a
            // name change must not drop the agent's effort pin.
            ...(current.effort ? { effort: current.effort } : {}),
          };
        }

        if (next.agent.id !== agentId) {
          // An id is the key for sessions, memory, and credentials. Letting an
          // edit change it would not rename an agent — it would hand this
          // agent's history to a different identity.
          throw new ApiError(
            409,
            'agent_id_immutable',
            `That soul declares id ${next.agent.id}, not ${agentId}. Ids key sessions, memory, and credentials, so they cannot be edited in place.`,
          );
        }
        if (!isValidAgentId(next.agent.id)) {
          throw new ApiError(400, 'invalid_agent_id', `${next.agent.id} is not a usable agent id.`);
        }

        // A raw edit writes the bytes it was given.
        //
        // `formatSoul` canonicalizes — frontmatter order, quoting, list layout,
        // trailing whitespace — so reserializing a source edit hands back a
        // file the author did not write, and silently discards an edit that was
        // only formatting. It has already been through `parseSoul` above, which
        // is the check that matters; there is nothing left for a round-trip to
        // prove about text that came in as text.
        //
        // A field edit still renders, and still round-trips before it lands:
        // `formatSoul` is the inverse of `parseSoul`, and the only honest way
        // to promise that is to perform it. A soul that survives the write but
        // not the next read is an agent that vanishes on restart.
        let rendered: string;
        if (raw !== undefined) {
          rendered = raw;
        } else {
          rendered = formatSoul(next);
          try {
            parseSoul(rendered, { seed: soulPath });
          } catch (error) {
            throw new ApiError(500, 'soul_round_trip_failed', `Refusing to write a soul that will not parse back: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        await writeFile(soulPath, rendered);
        return { next, soulPath };
      });
      await context.gateway.reloadRoster();
      return { agent: written.next.agent, soulPath: written.soulPath };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/roster/reload`,
    async handler(context) {
      const { agents, channels } = await context.gateway.reloadRosterAndChannels();
      return {
        agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
        // What each channel that can reload did: a secret stored for one
        // that `reloaded` is live now, and any other kind waits for a restart.
        channels,
      };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/skills/reload`,
    async handler(context) {
      try {
        return { skills: await context.gateway.reloadSkills() };
      } catch (error) {
        // The daemon is fine and still serving the previous set; what is
        // wrong is a file on disk, which the message names. Not a 500,
        // which every client reads as the daemon being broken.
        throw new ApiError(422, 'skills_reload_refused', error instanceof Error ? error.message : String(error));
      }
    },
  },
  // ---- intake ---------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/intake`,
    async handler(context) {
      return context.gateway.intake();
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/intake`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      if (typeof body.paused !== 'boolean') {
        throw new ApiError(400, 'invalid_body', '"paused" must be true or false.');
      }
      const message = optionalString(body, 'message');
      if (!body.paused) {
        if (message !== undefined) {
          throw new ApiError(400, 'invalid_body', '"message" applies only when pausing.');
        }
        return context.gateway.resumeIntake();
      }
      try {
        return await context.gateway.pauseIntake(message !== undefined ? { message } : {});
      } catch (error) {
        // Only the message is the caller's fault. A pause that could not be
        // written down (a full disk, a read-only home) is the daemon's, and
        // stays a 500 so a caller can tell the two apart.
        if (error instanceof PauseMessageError) {
          throw new ApiError(400, 'invalid_body', error.message);
        }
        throw error;
      }
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/promote`,
    async handler(context) {
      try {
        await context.gateway.promote();
      } catch (error) {
        throw new ApiError(409, 'not_promotable', error instanceof Error ? error.message : String(error));
      }
      return { held: context.gateway.held() };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/restart`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const reason = optionalString(body, 'reason');
      const drainTimeoutMs = body.drainTimeoutMs;
      if (drainTimeoutMs !== undefined && (typeof drainTimeoutMs !== 'number' || !Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 0)) {
        throw new ApiError(400, 'invalid_body', '"drainTimeoutMs" must be a non-negative whole number of milliseconds when present.');
      }
      // Before anything is announced: a refused restart leaves the daemon
      // serving, where one refused after the drain leaves nothing serving.
      try {
        await context.gateway.checkRestart();
      } catch (error) {
        throw new ApiError(409, 'not_restartable', error instanceof Error ? error.message : String(error));
      }
      let status;
      try {
        status = context.gateway.restart({
          ...(reason !== undefined ? { reason } : {}),
          ...(typeof drainTimeoutMs === 'number' ? { drainTimeoutMs } : {}),
        });
      } catch (error) {
        if (error instanceof RestartUnsupportedError) {
          throw new ApiError(501, 'restart_unsupported', error.message);
        }
        throw new ApiError(409, 'not_restartable', error instanceof Error ? error.message : String(error));
      }
      // Accepted, not done: the drain runs after this response leaves, and
      // this connection is one of the things it closes.
      context.response.statusCode = 202;
      return { restarting: true, ...status };
    },
  },
];
