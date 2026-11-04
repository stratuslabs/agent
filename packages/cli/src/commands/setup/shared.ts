/*
 * Setup helpers more than one menu uses: the agent roster the Channels,
 * Slack, Plugins and Approvals screens read, and the menu-row fitter. Moved
 * out of `runSetup` in setup.ts as is: the statements are unchanged, inside
 * a factory that takes the values they closed over there, and `runSetup`
 * destructures what it returns.
 */

import path from 'node:path';
import {
  DEFAULT_STRATUS_AGENT,
  loadRosterSouls,
  loadSoulFile,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  type RosterEntry,
} from '@stratusagent/state';
import { writeLine } from '../../io.ts';
import type { SetupBase } from './context.ts';

/**
 * A roster entry with an optional path: the built-in Stratus agent
 * comes from no file at all, exactly as the gateway registers it.
 */
export interface ChannelRosterEntry extends Omit<RosterEntry, 'path'> {
  path?: string;
}

export const createSharedSetup = ({
  streams,
  env,
  state,
  prompter,
}: Pick<SetupBase, 'streams' | 'env' | 'state' | 'prompter'>) => {
  /**
   * Every agent the gateway would dispatch to: the built-in Stratus
   * agent, the ~/.stratus/agents roster, and the configured default soul,
   * which `stratus setup` can point at a file anywhere. The gateway
   * registers all three, so a Channels list built from the agents
   * directory alone would hide agents Slack can perfectly well talk to.
   * Reads state.soulPath rather than the saved config so a soul chosen
   * earlier in this same setup session is already connectable.
   */
  const channelRoster = async (): Promise<{ entries: ChannelRosterEntry[]; loaded: boolean }> => {
    const warnOnce = (message: string): void => writeLine(streams.stderr, `Warning: ${message}.`);
    // Seeded before the roster loads, exactly as loadRoster does it: a
    // fresh install with no soul files still has an agent to put on
    // Slack, and a roster file that declares id "stratus" cannot take the
    // built-in's place — the gateway skips it, so offering it here would
    // name an app after an agent that never receives the messages.
    const entries: ChannelRosterEntry[] = [{ soul: { agent: { ...DEFAULT_STRATUS_AGENT } } }];
    // loadRosterSouls refuses a roster whose files collide, and drops the
    // ones claiming the reserved built-in id, so what comes back here is
    // already unambiguous.
    let rosterSouls: RosterEntry[] = [];
    let rosterLoaded = true;
    try {
      rosterSouls = await loadRosterSouls(env, warnOnce);
    } catch (error) {
      // A roster that cannot say who its agents are cannot have channels
      // configured for them — but the rest of setup (providers, models,
      // sign-ins) still works, so this reports and moves on rather than
      // taking the whole command down.
      rosterLoaded = false;
      warnOnce(error instanceof Error ? error.message : String(error));
      // Nothing is offered, not merely the colliding pair. A roster that
      // refuses to load fails `createGateway.start()` outright, so no
      // agent is servable — not the built-in seeded above, and not the
      // configured soul resolved below (which can itself BE one of the
      // colliding files). Listing any of them invites connecting a Slack
      // app to an agent the daemon cannot bring online, and connecting an
      // app is the expensive half of that mistake.
      return { entries: [], loaded: false };
    }
    entries.push(...rosterSouls);

    // The soul a run resolves to, in resolveSoulPath's own order: an env
    // override outranks the config value this setup session is editing.
    // Listing the config soul while `stratus serve` registers the env one
    // would store tokens against an id the adapter then skips.
    const processEnv = readProcessEnv(env);
    const envSoul = readNonEmptyString(processEnv.STRATUS_SOUL);
    if (typeof envSoul === 'string' && state.soulPath && envSoul !== state.soulPath) {
      warnOnce(`STRATUS_SOUL points at ${envSoul}, which outranks the configured ${state.soulPath} — Channels lists what a run would actually use`);
    }
    const effectiveSoul = typeof envSoul === 'string' ? envSoul : state.soulPath;
    if (!effectiveSoul) {
      return { entries, loaded: rosterLoaded };
    }
    const resolved = path.resolve(readWorkingDirectory(env), effectiveSoul);
    if (entries.some((entry) => entry.path === resolved)) {
      return { entries, loaded: rosterLoaded };
    }
    try {
      const soul = await loadSoulFile(resolved);
      // An explicit id can collide with a roster file, or with the
      // built-in. The gateway's defaultAgentId replaces the registered
      // source whenever it is pathless (the built-in) or resolves to a
      // different file, so the configured soul is the one Slack actually
      // dispatches to — offering the namesake here would connect an app
      // to a different agent than it names.
      const collision = entries.findIndex((entry) => entry.soul.agent.id === soul.agent.id);
      if (collision >= 0) {
        entries.splice(collision, 1);
      }
      entries.unshift({ soul, path: resolved });
    } catch (error) {
      warnOnce(`could not read the default soul ${resolved} (${error instanceof Error ? error.message : String(error)})`);
    }
    return { entries, loaded: rosterLoaded };
  };

  /**
   * Trim a menu option to one physical terminal row.
   *
   * `selectInteractive` moves the cursor up by the number of options to
   * redraw, so an option that wraps leaves the rewind short and every
   * later redraw overwrites the wrong lines. `reserved` is what the
   * caller's own prefix costs before the text starts.
   *
   * Only a TTY has a width to fit into, and piped output keeps the full
   * text — which is where nothing is redrawn, and also why none of this is
   * covered by a test: `prompter.isInteractive()` is false whenever
   * `setupInput` is set, which is every one of them.
   *
   * Every option in every menu has this constraint. Fitted here are the
   * ones this change lengthened or added; a long soul path in the Agent
   * row can still wrap, and the real fix for that is teaching
   * `selectInteractive` to count rendered rows.
   */
  const fitMenuRow = (text: string, reserved = 27): string => {
    // `process.stdout` rather than the injected stream, which is typed to
    // `write` alone — the same place `selectInteractive` reads `isTTY`
    // from, and only consulted when it is actually driving a terminal.
    const columns = prompter.isInteractive() ? process.stdout.columns : undefined;
    if (typeof columns !== 'number' || columns <= 0) {
      return text;
    }
    // The row's own prefix — `menuPrefixWidth`, plus whatever padding the
    // caller adds — subtracted from the width, so what is left is what the
    // text may occupy.
    const budget = columns - reserved;
    return text.length <= budget ? text : `${text.slice(0, Math.max(budget - 1, 0))}…`;
  };

  return { channelRoster, fitMenuRow };
};

export type SharedSetup = ReturnType<typeof createSharedSetup>;
