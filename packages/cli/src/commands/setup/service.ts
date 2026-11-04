/*
 * The Always on menu of `stratus setup`: whether stratusd is installed as a
 * service and runs at login. Moved out of `runSetup` in setup.ts as is: the
 * statements are unchanged, inside a factory that takes the values they
 * closed over there, and `runSetup` destructures what it returns.
 */

import { servicePlatform, SYSTEMD_NOT_RUNNING } from '../../service.ts';
import { serviceEnvFor } from '../../daemon.ts';
import { writeLine } from '../../io.ts';
import type { SetupBase } from './context.ts';

export const createServiceSetup = ({
  env,
  state,
  streams,
  prompter,
}: Pick<SetupBase, 'env' | 'state' | 'streams' | 'prompter'>) => {
  const serviceSummary = (): string => {
    const serviceEnv = serviceEnvFor(env);
    if (!servicePlatform(serviceEnv)) {
      return (serviceEnv.platform ?? process.platform) === 'linux'
        ? `not available (${SYSTEMD_NOT_RUNNING}) — run \`stratus serve\` yourself`
        : `not available on ${env.processEnv?.OSTYPE ?? process.platform} — run \`stratus serve\` yourself`;
    }
    if (!state.service.install) {
      return 'off — start stratusd yourself with `stratus serve`';
    }
    return state.service.runAtLogin
      ? 'stratusd runs after setup, and at every login'
      : 'stratusd runs after setup, but not at login';
  };

  /**
   * Whether the roster keeps answering once this terminal closes. On by
   * default: an agent you have to remember to start is not always-on, and
   * every Slack app configured above is silent until stratusd runs.
   */
  const chooseService = async (): Promise<void> => {
    const serviceEnv = serviceEnvFor(env);
    if (!servicePlatform(serviceEnv)) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, (serviceEnv.platform ?? process.platform) === 'linux'
        ? `Always on runs stratusd as a systemd user service, and ${SYSTEMD_NOT_RUNNING} — run \`stratus serve\` yourself, or supervise it however you prefer.`
        : `Stratus has no service integration for ${process.platform} yet — run \`stratus serve\` yourself, or supervise it however you prefer.`);
      await prompter.ask('Press Enter to return to the menu… ');
      return;
    }
    const choice = await prompter.select('Always on — keep stratusd running in the background', [
      'Run after setup, and start again at every login (recommended)',
      'Run after setup, but do not start at login',
      'Do not run it for me — I will start `stratus serve` myself',
      'Back',
    ], {
      footnote: process.platform === 'darwin'
        // Said here rather than left to be discovered after a reboot.
        ? 'A LaunchAgent starts at login, not at power-on. For a machine that should recover unattended, turn on automatic login too.'
        : 'A user service starts at login. `loginctl enable-linger` keeps it up on a machine you do not stay logged in to.',
    });
    if (choice.kind !== 'index' || choice.index === 3) {
      return;
    }
    state.service = {
      install: choice.index !== 2,
      runAtLogin: choice.index === 0,
    };
  };

  return { serviceSummary, chooseService };
};

export type ServiceSetup = ReturnType<typeof createServiceSetup>;
