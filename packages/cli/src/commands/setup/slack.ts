/*
 * The Slack screens of `stratus setup`: connecting an agent's Slack app and
 * choosing who may talk to it. Moved out of `runSetup` in setup.ts as is:
 * the statements are unchanged, inside a factory that takes the values they
 * closed over there, and `runSetup` destructures what it returns.
 */

import { resolveAgentPrincipals, type PrincipalsConfig } from '@stratusagent/state';
import { writeLine } from '../../io.ts';
import { isSlackMemberId, verifySlackBotToken, verifySlackAppToken, slackAppManifest } from '../../slack.ts';
import type { SetupBase } from './context.ts';
import type { SharedSetup } from './shared.ts';

export const createSlackSetup = ({
  streams,
  prompter,
  env,
  state,
  serveCommand,
  channelRoster,
}: Pick<SetupBase, 'streams' | 'prompter' | 'env' | 'state' | 'serveCommand'> & Pick<SharedSetup, 'channelRoster'>) => {
  /**
   * Walks an agent through connecting their own Slack app: show the
   * manifest to paste, take both tokens, verify each against Slack, and
   * store them under the agent's id. Tokens are keyed by a roster agent
   * picked from a list rather than typed, so the id can never drift from
   * the roster — the mismatch that otherwise surfaces only as a startup
   * warning about an agent the gateway cannot find.
   */
  const connectSlackAgent = async (agentId: string, agentName: string): Promise<void> => {
    writeLine(streams.stdout);
    writeLine(streams.stdout, `Create a Slack app for ${agentName}:`);
    writeLine(streams.stdout, '  1. Open https://api.slack.com/apps → Create New App → From a manifest');
    writeLine(streams.stdout, '  2. Pick your workspace → Next, then paste this manifest:');
    writeLine(streams.stdout);
    for (const line of slackAppManifest(agentName).split('\n')) {
      writeLine(streams.stdout, `    ${line}`);
    }
    writeLine(streams.stdout);
    // The app-level token is the step people got lost on: it lives on
    // Basic Information rather than OAuth & Permissions, where the other
    // token is, and needs a scope added in the dialog that generates it.
    writeLine(streams.stdout, '  3. Click Next, then Create. You land on Basic Information — scroll down to');
    writeLine(streams.stdout, '     App-Level Tokens and click Generate Token and Scopes (scope: connections:write)');
    writeLine(streams.stdout, '  4. Sidebar → Install App → Install to your workspace → Allow, then copy');
    writeLine(streams.stdout, '     the Bot User OAuth Token — it starts with xoxb-');
    writeLine(streams.stdout, `  5. Basic Information → Display Information → upload ${agentName}'s avatar`);
    writeLine(streams.stdout);

    const appToken = await prompter.askSecret('Paste the app-level token from step 3 (xapp-…, Enter to cancel; input is hidden): ');
    if (!appToken) {
      writeLine(streams.stdout, 'Cancelled — nothing was saved.');
      return;
    }
    if (!appToken.startsWith('xapp-')) {
      writeLine(streams.stdout, '✗ That does not look like an app-level token (they start with xapp-, and live under Basic Information → App-Level Tokens, not OAuth & Permissions). Nothing was saved.');
      return;
    }
    const botToken = await prompter.askSecret('Paste the Bot User OAuth Token from step 4 (xoxb-…, Enter to cancel; input is hidden): ');
    if (!botToken) {
      writeLine(streams.stdout, 'Cancelled — nothing was saved.');
      return;
    }
    if (!botToken.startsWith('xoxb-')) {
      writeLine(streams.stdout, '✗ That does not look like a bot token (they start with xoxb-). Nothing was saved.');
      return;
    }

    writeLine(streams.stdout, 'Checking the tokens with Slack…');
    const fetchImpl = env.fetch ?? globalThis.fetch;
    const bot = await verifySlackBotToken(botToken, fetchImpl);
    if (bot.status === 'rejected') {
      writeLine(streams.stdout, `✗ Slack rejected the bot token (${bot.detail}). Nothing was saved — reinstall the app and copy the token again.`);
      return;
    }
    const app = await verifySlackAppToken(appToken, fetchImpl);
    if (app.status === 'rejected') {
      writeLine(streams.stdout, `✗ Slack rejected the app-level token (${app.detail}). Nothing was saved — generate a new one under Basic Information → App-Level Tokens with the connections:write scope.`);
      return;
    }

    const slack = { ...(state.channels.slack ?? {}) };
    // The bot this agent had before, if any: evidence of which workspace
    // its current list was written for.
    const previousBotToken = slack[agentId]?.botToken;
    slack[agentId] = { appToken, botToken };
    state.channels = { ...state.channels, slack };
    state.channelsDirty = true;

    if (bot.status === 'ok' && app.status === 'ok') {
      const where = bot.identity.teamName ? ` in ${bot.identity.teamName}` : '';
      const who = bot.identity.botUserId ? ` (bot ${bot.identity.botUserId})` : '';
      writeLine(streams.stdout, `✓ Verified — ${agentName} is connected to Slack${where}${who}.`);
    } else {
      // Unreachable is not a verdict on the tokens: save and let the
      // daemon report on its first connection attempt.
      const detail = bot.status === 'unreachable' ? bot.detail : (app as { detail?: string }).detail;
      writeLine(streams.stdout, `! Could not reach Slack to verify (${detail}). Saved the tokens anyway — \`${serveCommand()}\` will report on startup.`);
    }
    await askSlackPrincipals(agentId, agentName, bot.status === 'ok' ? bot.identity.teamId : undefined, fetchImpl, previousBotToken);
  };

  /**
   * Whether another agent already on Slack uses the inherited top-level
   * list in workspace `teamId`. Member IDs are workspace-scoped, so a list
   * nobody can place there may name nobody this agent will ever hear from.
   */
  const inheritingSlackTeams = async (agentId: string, fetchImpl: typeof fetch | undefined): Promise<Array<string | undefined>> => {
    const teams: Array<string | undefined> = [];
    for (const [otherId, tokens] of Object.entries(state.channels.slack ?? {})) {
      if (otherId === agentId || !tokens?.botToken || state.principals?.agents?.[otherId]?.slackUsers !== undefined) {
        continue;
      }
      const other = await verifySlackBotToken(tokens.botToken, fetchImpl);
      // Unverifiable counts as another workspace: it can't be placed.
      teams.push(other.status === 'ok' ? other.identity.teamId : undefined);
    }
    return teams;
  };

  /**
   * Whether the list this agent resolves to is confirmed for workspace
   * `teamId`: a verified bot in that team already uses it. Its users are
   * this agent's previous bot and, for an inherited list, every other
   * agent inheriting it. Nothing else says which workspace a list is for.
   */
  const listConfirmedIn = async (
    agentId: string,
    own: boolean,
    teamId: string | undefined,
    fetchImpl: typeof fetch | undefined,
    previousBotToken: string | undefined,
  ): Promise<boolean> => {
    if (teamId === undefined) {
      return false;
    }
    if (previousBotToken !== undefined) {
      const previous = await verifySlackBotToken(previousBotToken, fetchImpl);
      if (previous.status === 'ok' && previous.identity.teamId === teamId) {
        return true;
      }
    }
    return !own && (await inheritingSlackTeams(agentId, fetchImpl)).includes(teamId);
  };

  /**
   * Whether a first list can be everyone's: every other Slack agent that
   * would inherit it is verified into the same workspace (or there is none).
   */
  const allInheritorsIn = async (agentId: string, teamId: string | undefined, fetchImpl: typeof fetch | undefined): Promise<boolean> => {
    const teams = await inheritingSlackTeams(agentId, fetchImpl);
    return teams.length === 0 || (teamId !== undefined && teams.every((team) => team === teamId));
  };

  /**
   * Only listed Slack users get a turn (`principals.admit` defaults to
   * `principals`), so an agent connected with nobody listed ignores
   * everyone. Asked right after the connect, the one moment the operator
   * is in Slack's settings anyway. Skipped when it admits anyone, and when
   * the list it resolves to (its own or inherited) is confirmed for this
   * workspace (see listConfirmedIn). An unconfirmed list is offered with
   * Enter to keep it, so a re-run never overwrites one silently; member
   * IDs are workspace-scoped, so a list from another workspace names
   * nobody, or someone else.
   */
  const askSlackPrincipals = async (
    agentId: string,
    agentName: string,
    teamId?: string,
    fetchImpl?: typeof fetch,
    previousBotToken?: string,
  ): Promise<void> => {
    const resolved = resolveAgentPrincipals(state.principals, agentId);
    // `admit: "anyone"` opened the door on purpose: a list would only label
    // trust there, and the closed-door wording below would be false.
    if (resolved.admit === 'anyone') {
      return;
    }
    const listed = resolved.slackUsers ?? [];
    const own = state.principals?.agents?.[agentId]?.slackUsers !== undefined;
    if (listed.length > 0 && await listConfirmedIn(agentId, own, teamId, fetchImpl, previousBotToken)) {
      return;
    }
    const inherited = listed.length > 0 ? listed.join(', ') : undefined;
    writeLine(streams.stdout, `Only the Slack users you list can talk to ${agentName}; everyone else is ignored.`);
    if (inherited !== undefined) {
      const whose = own ? `${agentName}'s Slack list` : `The Slack list ${agentName} would inherit`;
      writeLine(streams.stdout, `${whose} (${inherited}) is not confirmed for this workspace, and member IDs only work in their own.`);
    }
    writeLine(streams.stdout, 'Find your member ID in Slack: your profile → ⋯ → Copy member ID.');
    for (;;) {
      const answer = (await prompter.ask(inherited !== undefined
        ? `Slack member IDs who may talk to it here (U…, comma-separated, Enter to keep ${inherited}): `
        : 'Slack member IDs who may talk to it (U…, comma-separated, Enter to skip): ')).trim();
      // Separators alone (`, ,`) name nobody, the same as Enter.
      const ids = answer.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
      if (ids.length === 0 && inherited !== undefined) {
        return;
      }
      if (ids.length === 0) {
        // The key that decides this agent's list: its own, where it has one.
        const key = state.principals?.agents?.[agentId]?.slackUsers !== undefined ? `principals.agents.${agentId}.slackUsers` : 'principals.slackUsers';
        writeLine(streams.stdout, `! Nobody is listed, so ${agentName} will ignore every Slack message until ${key} names someone.`);
        return;
      }
      const bad = ids.filter((id) => !isSlackMemberId(id));
      if (bad.length > 0) {
        writeLine(streams.stdout, `✗ ${bad.join(', ')} ${bad.length === 1 ? 'is not a member ID' : 'are not member IDs'} (they look like U0123ABCD). Nothing was saved.`);
        continue;
      }
      const principals: PrincipalsConfig = { ...(state.principals ?? {}) };
      const anyList = principals.slackUsers !== undefined
        || Object.values(principals.agents ?? {}).some((entry) => entry?.slackUsers !== undefined);
      if (!anyList && await allInheritorsIn(agentId, teamId, fetchImpl)) {
        // The first list on this install is everyone's: the operator who
        // connects a second agent is almost always the same person. Once
        // any agent has a list, a new one is that agent's alone, so it
        // never opens an agent left unlisted on purpose; so is a first one
        // when another Slack agent is in (or can't be placed in) a
        // different workspace, since member IDs only mean something there.
        principals.slackUsers = ids;
      } else {
        principals.agents = {
          ...(principals.agents ?? {}),
          [agentId]: { ...(principals.agents?.[agentId] ?? {}), slackUsers: ids },
        };
      }
      state.principals = principals;
      writeLine(streams.stdout, `✓ ${ids.join(', ')} can talk to ${agentName}. Saved with the rest of setup.`);
      return;
    }
  };

  const chooseSlackChannel = async (): Promise<void> => {
    while (true) {
      const { entries: roster, loaded: rosterLoaded } = await channelRoster();
      const slack = state.channels.slack ?? {};

      // The roster always holds at least the built-in agent, so there is
      // no empty state to short-circuit on — and short-circuiting would
      // strand orphaned tokens, which are only reachable from this list.
      const options = roster.map((entry) => {
        const id = entry.soul.agent.id;
        const status = slack[id] ? '✓ connected' : '— not connected';
        return `${entry.soul.agent.name} (${id})`.padEnd(34) + status;
      });
      // Orphans: tokens whose agent left the roster would otherwise be
      // invisible here while still being loaded by `stratus serve`.
      //
      // Only when the roster actually loaded. "No agent has this id" is a
      // claim about the roster, and a roster that refused to load cannot
      // support it — every stored token would look orphaned, and this list
      // offers to DELETE them. Losing a working agent's Slack credentials
      // because a different pair of files collided is a far worse outcome
      // than leaving a real orphan on screen for one run.
      const orphans = rosterLoaded
        ? Object.keys(slack).filter((id) => !roster.some((entry) => entry.soul.agent.id === id))
        : [];
      if (!rosterLoaded) {
        writeLine(
          streams.stderr,
          'Warning: no agents are offered while the roster is unreadable — the daemon cannot start either. Fix the roster first.',
        );
      }
      for (const id of orphans) {
        options.push(`${id}`.padEnd(34) + '! tokens without a matching agent');
      }
      options.push('Back');

      const choice = await prompter.select(
        'Channels — Slack (one app per agent: its own name, avatar, and presence)',
        options,
        { footnote: `Run \`${serveCommand()}\` afterwards to bring the connected agents online.` },
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }

      if (choice.index >= roster.length) {
        // An orphaned entry — offer to clear it.
        const orphanId = orphans[choice.index - roster.length];
        if (!orphanId) {
          return;
        }
        const confirm = await prompter.select(`No agent with id ${orphanId} is in the roster.`, [
          'Remove these Slack tokens',
          'Keep them',
        ]);
        if (confirm.kind === 'index' && confirm.index === 0) {
          const next = { ...slack };
          delete next[orphanId];
          state.channels = { ...state.channels, slack: next };
          state.channelsDirty = true;
          writeLine(streams.stdout, `Removed the Slack tokens for ${orphanId}.`);
        }
        continue;
      }

      const entry = roster[choice.index];
      if (!entry) {
        return;
      }
      const agentId = entry.soul.agent.id;
      const agentName = entry.soul.agent.name;

      if (!slack[agentId]) {
        await connectSlackAgent(agentId, agentName);
        continue;
      }

      const action = await prompter.select(`${agentName} is connected to Slack.`, [
        'Replace the tokens (re-run the app setup)',
        'Disconnect from Slack (forget the tokens)',
        'Back',
      ]);
      if (action.kind !== 'index' || action.index === 2) {
        continue;
      }
      if (action.index === 0) {
        await connectSlackAgent(agentId, agentName);
        continue;
      }
      const next = { ...slack };
      delete next[agentId];
      state.channels = { ...state.channels, slack: next };
      state.channelsDirty = true;
      writeLine(streams.stdout, `${agentName} is no longer connected to Slack. The Slack app itself still exists — delete it at api.slack.com/apps if you are done with it.`);
    }
  };

  return { chooseSlackChannel };
};

export type SlackSetup = ReturnType<typeof createSlackSetup>;
